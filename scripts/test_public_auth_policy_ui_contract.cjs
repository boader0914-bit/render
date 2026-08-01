"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const PUBLIC_CSS_PATH = path.join(ROOT, "web", "public-ui.css");

const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/account-delete",
  "/terms",
  "/privacy",
  "/refund",
  "/refund-cancellation-policy",
  "/data-collection-notice",
  "/data-quality-notice",
  "/external-platform-data-limit",
  "/collection-failure-notice",
  "/api-key-retention-policy",
  "/report-disclaimer",
  "/business-info",
  "/google-play-data-safety",
];

const POLICY_ROUTES = PUBLIC_ROUTES.filter((route) => !["/login", "/signup", "/account-delete"].includes(route));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function isolatedEnvironment(port, runtimeRoot) {
  const environment = {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    RENDER: "",
    RENDER_EXTERNAL_URL: "",
    V2_PREVIEW_DATA_ROOT: runtimeRoot,
    SEED_OUTPUTS_FROM_REPO: "0",
    GLAMPING_ADMIN_USER: "public-ui-test-admin",
    GLAMPING_ADMIN_PASSWORD: "PublicUiTestOnly!123",
    GLAMPING_B2B_ENABLED: "0",
  };
  for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function spawnServer(port, runtimeRoot) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: isolatedEnvironment(port, runtimeRoot),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-5000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-5000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited before health check (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { redirect: "manual" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("isolated public UI server health check timed out");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("isolated server did not stop")), 5000)),
  ]);
}

async function requestLocal(baseUrl, pathname, options = {}) {
  const url = new URL(pathname, baseUrl);
  const base = new URL(baseUrl);
  assert.equal(url.origin, base.origin, `external request blocked: ${url.href}`);
  assert.equal(url.hostname, "127.0.0.1", `non-local request blocked: ${url.href}`);
  const response = await fetch(url, { redirect: "manual", ...options });
  const body = options.method === "HEAD" ? "" : await response.text();
  return { response, body };
}

function assertSecurityHeaders(response, route) {
  assert.match(String(response.headers.get("content-security-policy") || ""), /default-src 'self'/, `${route} CSP`);
  assert.match(String(response.headers.get("content-security-policy") || ""), /form-action 'self'/, `${route} form CSP`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${route} nosniff`);
  assert.equal(response.headers.get("x-frame-options"), "DENY", `${route} frame policy`);
  assert.equal(response.headers.get("cache-control"), "no-store", `${route} cache policy`);
}

function htmlIds(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

function assertNoDuplicateIds(html, route) {
  const ids = htmlIds(html);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `${route} duplicate ids: ${duplicates.join(", ")}`);
}

function assertDescribedByTargets(html, route) {
  const ids = new Set(htmlIds(html));
  for (const match of html.matchAll(/\saria-describedby="([^"]+)"/g)) {
    for (const id of match[1].trim().split(/\s+/)) {
      assert.ok(ids.has(id), `${route} aria-describedby target missing: ${id}`);
    }
  }
}

function assertSameOriginMarkup(html, route) {
  for (const match of html.matchAll(/\s(?:src|href|action)="([^"]+)"/g)) {
    const target = match[1];
    assert.ok(
      target.startsWith("/") || target.startsWith("#") || target.startsWith("mailto:"),
      `${route} contains a non-local asset or action: ${target}`,
    );
  }
}

function assertPublicShell(html, route) {
  assert.match(html, /<html lang="ko">/, `${route} language`);
  assert.match(html, /viewport-fit=cover/, `${route} viewport fit`);
  assert.match(html, /<body class="public-page\s/, `${route} public page class`);
  assert.match(html, /class="skip-link"[^>]+href="#mainContent"/, `${route} skip link`);
  assert.match(html, /<header\b[^>]*class="public-topbar"/, `${route} header landmark`);
  assert.match(html, /<main\b[^>]*id="mainContent"[^>]*tabindex="-1"/, `${route} main landmark`);
  assert.match(html, /<footer\b[^>]*class="public-footer"/, `${route} footer landmark`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${route} must have one h1`);
  assert.equal((html.match(/id="themeToggle"/g) || []).length, 1, `${route} theme toggle count`);
  assert.match(html, /id="themeToggle"[^>]+aria-label=/, `${route} theme toggle name`);
  assert.match(html, /id="themeToggle"[^>]+aria-pressed="false"/, `${route} theme state`);
  const scriptIndex = html.indexOf('<script src="/login-theme.js"></script>');
  const cssIndex = html.indexOf('<link rel="stylesheet" href="/public-ui.css">');
  assert.ok(scriptIndex >= 0 && cssIndex > scriptIndex, `${route} theme must initialize before shared CSS`);
  assert.doesNotMatch(html, /<style\b/i, `${route} must not duplicate inline theme CSS`);
  assert.doesNotMatch(html, /\s(?:onclick|onsubmit|onkeydown)=/i, `${route} must not use inline event handlers`);
  assertNoDuplicateIds(html, route);
  assertDescribedByTargets(html, route);
  assertSameOriginMarkup(html, route);
}

function formBlock(html, action) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  const found = forms.find((match) => new RegExp(`\\baction="${action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(match[1]));
  assert.ok(found, `form action ${action} missing`);
  return { attributes: found[1], body: found[2], html: found[0] };
}

function formNames(form) {
  return [...form.html.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]).sort();
}

function assertFormContract(html, action, expectedNames) {
  const form = formBlock(html, action);
  assert.match(form.attributes, /\bmethod="post"/i, `${action} method`);
  assert.deepEqual(formNames(form), [...expectedNames].sort(), `${action} field names`);
  return form;
}

function parseThemeTokens(css, theme) {
  const marker = theme === "light" ? ':root[data-theme="light"] {' : ':root[data-theme="dark"] {';
  const markerIndex = css.indexOf(marker);
  assert.ok(markerIndex >= 0, `${theme} theme token block missing`);
  const start = css.indexOf("{", markerIndex) + 1;
  const end = css.indexOf("}", start);
  const tokens = {};
  for (const match of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(left, right) {
  const first = relativeLuminance(left);
  const second = relativeLuminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertContrast(results, label, foreground, background, minimum) {
  assert.match(foreground || "", /^#[0-9a-f]{6}$/i, `${label} foreground token`);
  assert.match(background || "", /^#[0-9a-f]{6}$/i, `${label} background token`);
  const ratio = contrastRatio(foreground, background);
  results.push({ label, ratio });
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(3)} is below ${minimum}`);
}

function createThemeHarness(themeScript, options = {}) {
  const stored = new Map();
  if (options.storedTheme) stored.set("lodging-theme", options.storedTheme);
  const root = { dataset: {} };
  const domListeners = new Map();
  const themeListeners = new Map();
  const formListeners = new Map();
  const buttonAttributes = new Map();
  const submitAttributes = new Map();
  const themeButton = {
    innerHTML: "",
    addEventListener(type, listener) { themeListeners.set(type, listener); },
    setAttribute(name, value) { buttonAttributes.set(name, String(value)); },
    getAttribute(name) { return buttonAttributes.get(name) || null; },
  };
  const themeMeta = {
    value: "",
    setAttribute(name, value) { if (name === "content") themeMeta.value = String(value); },
  };
  const submitButton = {
    disabled: false,
    textContent: "로그인",
    dataset: { submittingLabel: "로그인 중" },
    setAttribute(name, value) { submitAttributes.set(name, String(value)); },
    getAttribute(name) { return submitAttributes.get(name) || null; },
  };
  const form = {
    addEventListener(type, listener) { formListeners.set(type, listener); },
    checkValidity() { return true; },
    querySelector() { return submitButton; },
  };
  const media = {
    matches: Boolean(options.systemDark),
    addEventListener() {},
  };
  const document = {
    documentElement: root,
    addEventListener(type, listener) { domListeners.set(type, listener); },
    getElementById(id) {
      if (id === "themeToggle") return themeButton;
      if (id === "themeColor") return themeMeta;
      return null;
    },
    querySelectorAll(selector) { return selector === "form[data-public-submit]" ? [form] : []; },
  };
  const context = {
    document,
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    matchMedia: () => media,
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(themeScript, context, { filename: "login-theme.js" });
  return {
    root,
    stored,
    themeButton,
    themeMeta,
    submitButton,
    buttonAttributes,
    submitAttributes,
    ready() { domListeners.get("DOMContentLoaded")?.(); },
    toggle() { themeListeners.get("click")?.(); },
    submit(event = {}) { formListeners.get("submit")?.({ defaultPrevented: false, submitter: submitButton, ...event }); },
  };
}

async function snapshotTree(root) {
  const result = {};
  async function walk(directory, prefix = "") {
    let entries = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(prefix, entry.name).replace(/\\/g, "/");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        await walk(absolute, relative);
      } else {
        const data = await fsp.readFile(absolute);
        result[relative] = `${data.length}:${crypto.createHash("sha256").update(data).digest("hex")}`;
      }
    }
  }
  await walk(root);
  return result;
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-public-ui-"));
  const runtimeRoot = path.join(tempRoot, "runtime");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, runtimeRoot);
  try {
    await waitForHealth(baseUrl, server.child);

    const rendered = {};
    for (const route of PUBLIC_ROUTES) {
      const { response, body } = await requestLocal(baseUrl, route);
      assert.equal(response.status, 200, `${route} status`);
      assert.match(String(response.headers.get("content-type") || ""), /^text\/html\b/i, `${route} content type`);
      assertSecurityHeaders(response, route);
      assertPublicShell(body, route);
      rendered[route] = body;
    }
    assert.match(rendered["/login"], /<body class="public-page public-login-page">/, "login route identity");
    assert.match(rendered["/signup"], /<body class="public-page public-signup-page">/, "signup route identity");
    assert.match(rendered["/account-delete"], /<body class="public-page public-account-delete-page">/, "delete route identity");

    for (const route of ["/terms", "/privacy", "/refund", "/account-delete"]) {
      const { response, body } = await requestLocal(baseUrl, route, { method: "HEAD" });
      assert.equal(response.status, 200, `${route} HEAD status`);
      assert.equal(body, "", `${route} HEAD body`);
      assertSecurityHeaders(response, `${route} HEAD`);
    }

    for (const [asset, contentType] of [
      ["/public-ui.css", "text/css"],
      ["/login-theme.js", "application/javascript"],
      ["/signup.js", "application/javascript"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/icons/icon-192.png", "image/png"],
    ]) {
      const { response, body } = await requestLocal(baseUrl, asset);
      assert.equal(response.status, 200, `${asset} anonymous asset status`);
      const escapedContentType = contentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(String(response.headers.get("content-type") || ""), new RegExp(`^${escapedContentType}`), `${asset} content type`);
      assert.ok(body.length > 100, `${asset} body`);
      assertSecurityHeaders(response, asset);
    }

    for (const route of POLICY_ROUTES) {
      assert.match(rendered[route], /class="public-policy-section"/, `${route} policy sections`);
      assert.match(rendered[route], /href="\/terms"/, `${route} terms navigation`);
      assert.match(rendered[route], /href="\/privacy"/, `${route} privacy navigation`);
      assert.match(rendered[route], /href="\/refund"/, `${route} refund navigation`);
    }
    for (const [route, currentHref] of Object.entries({
      "/terms": "/terms",
      "/privacy": "/privacy",
      "/refund": "/refund",
      "/data-collection-notice": "/data-collection-notice",
      "/data-quality-notice": "/data-quality-notice",
      "/collection-failure-notice": "/collection-failure-notice",
      "/business-info": "/business-info",
    })) {
      assert.match(rendered[route], new RegExp(`href="${currentHref}" aria-current="page"`), `${route} current policy navigation`);
    }

    const loginForm = assertFormContract(rendered["/login"], "/login", ["username", "password"]);
    assert.match(loginForm.html, /autocomplete="username"/);
    assert.match(loginForm.html, /autocomplete="current-password"/);
    assert.doesNotMatch(loginForm.html, /name="password"[^>]*\bvalue=/i, "login password must not be reflected");

    const signupForm = assertFormContract(rendered["/signup"], "/signup", [
      "username", "password", "passwordConfirm", "phone", "email", "companyName", "ownershipStatus",
      "agreeTerms", "agreePrivacy", "agreeMarketing", "confirmAge",
    ]);
    assert.match(signupForm.attributes, /\bdata-signup-form\b/);
    for (const hook of ["data-username", "data-check-username", "data-password", "data-password-confirm", "data-email", "data-signup-submit"]) {
      assert.match(signupForm.html, new RegExp(`\\b${hook}\\b`), `signup hook ${hook}`);
    }
    assert.doesNotMatch(signupForm.html, /name="password(?:Confirm)?"[^>]*\bvalue=/i, "signup passwords must not be reflected");
    for (const label of signupForm.html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)) {
      assert.doesNotMatch(label[0], /<button\b/i, "signup label must not contain a second labelable control");
    }
    for (const agreement of ["agreeTerms", "agreePrivacy", "agreeMarketing", "confirmAge"]) {
      assert.match(signupForm.html, new RegExp(`id="${agreement}"`), `${agreement} id`);
      assert.match(signupForm.html, new RegExp(`for="${agreement}"`), `${agreement} label`);
    }
    for (const requiredAgreement of ["agreeTerms", "agreePrivacy", "confirmAge"]) {
      assert.match(signupForm.html, new RegExp(`<input[^>]+name="${requiredAgreement}"[^>]+required`), `${requiredAgreement} remains required`);
    }
    const marketingInput = signupForm.html.match(/<input[^>]+name="agreeMarketing"[^>]*>/i)?.[0] || "";
    assert.ok(marketingInput, "marketing agreement input");
    assert.doesNotMatch(marketingInput, /\brequired\b/, "marketing agreement remains optional");
    assert.match(signupForm.html, /href="\/terms" target="_blank" rel="noopener"/, "terms opens safely");
    assert.match(signupForm.html, /href="\/privacy" target="_blank" rel="noopener"/, "privacy opens safely");
    assert.match(signupForm.html, /data-hold-password[^>]+aria-pressed="false"/, "password reveal state");

    const deleteForm = assertFormContract(rendered["/account-delete"], "/account-delete", [
      "username", "contact", "companyName", "requestType", "detail", "confirmRequest",
    ]);
    for (const requestType of ["account_delete", "search_history_delete", "interest_lodge_delete", "all_data_delete"]) {
      assert.match(deleteForm.html, new RegExp(`value="${requestType}"`), `delete type ${requestType}`);
    }

    const css = await fsp.readFile(PUBLIC_CSS_PATH, "utf8");
    const themeScript = await fsp.readFile(path.join(ROOT, "web", "login-theme.js"), "utf8");
    assert.doesNotMatch(css, /filter\s*:\s*(?:invert|hue-rotate)/i, "public UI must not invert its root surface");
    assert.match(css, /min-height:\s*var\(--touch-target-min\)/, "public touch target contract");
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, "reduced motion contract");
    assert.match(css, /@media\s+print/, "policy print contract");
    assert.match(css, /input:-webkit-autofill/, "autofill theme contract");
    assert.match(css, /:focus-visible/, "focus visible contract");

    const contrastResults = [];
    for (const theme of ["light", "dark"]) {
      const tokens = parseThemeTokens(css, theme);
      assertContrast(contrastResults, `${theme} primary CTA`, tokens["color-text-inverse"], tokens["color-action-primary"], 4.5);
      assertContrast(contrastResults, `${theme} primary CTA hover`, tokens["color-text-inverse"], tokens["color-action-primary-hover"], 4.5);
      assertContrast(contrastResults, `${theme} primary CTA pressed`, tokens["color-text-inverse"], tokens["color-action-primary-pressed"], 4.5);
      assertContrast(contrastResults, `${theme} body text`, tokens["color-text-primary"], tokens["color-surface-default"], 4.5);
      assertContrast(contrastResults, `${theme} secondary text`, tokens["color-text-secondary"], tokens["color-surface-default"], 4.5);
      assertContrast(contrastResults, `${theme} placeholder`, tokens["color-text-tertiary"], tokens["color-surface-subtle"], 4.5);
      assertContrast(contrastResults, `${theme} field border`, tokens["color-border-default"], tokens["color-surface-default"], 3);
      assertContrast(contrastResults, `${theme} focus ring`, tokens["color-border-focus"], tokens["color-surface-default"], 3);
      assertContrast(contrastResults, `${theme} danger action`, tokens["color-text-inverse"], tokens["color-status-danger"], 4.5);
      assertContrast(contrastResults, `${theme} disabled`, tokens["color-disabled-text"], tokens["color-disabled-surface"], 4.5);
      assertContrast(contrastResults, `${theme} disabled border`, tokens["color-disabled-border"], tokens["color-disabled-surface"], 3);
      for (const status of ["info", "success", "warning", "danger"]) {
        assertContrast(contrastResults, `${theme} ${status} status`, tokens[`color-status-${status}`], tokens["color-surface-default"], 4.5);
      }
    }

    const storedThemeHarness = createThemeHarness(themeScript, { storedTheme: "dark", systemDark: false });
    assert.equal(storedThemeHarness.root.dataset.theme, "dark", "stored theme applies before DOM ready");
    storedThemeHarness.ready();
    assert.equal(storedThemeHarness.buttonAttributes.get("aria-pressed"), "true", "stored dark state announced");
    assert.equal(storedThemeHarness.themeMeta.value, "#070b12", "dark browser chrome color");
    storedThemeHarness.toggle();
    assert.equal(storedThemeHarness.root.dataset.theme, "light", "theme toggle changes root state");
    assert.equal(storedThemeHarness.stored.get("lodging-theme"), "light", "theme toggle preserves shared storage key");
    assert.equal(storedThemeHarness.themeMeta.value, "#f3f6fa", "light browser chrome color");
    storedThemeHarness.submit();
    assert.equal(storedThemeHarness.submitButton.disabled, true, "valid public form submit is locked");
    assert.equal(storedThemeHarness.submitAttributes.get("aria-busy"), "true", "public submit busy state");
    assert.equal(storedThemeHarness.submitButton.textContent, "로그인 중", "public submit pending label");

    const systemThemeHarness = createThemeHarness(themeScript, { systemDark: true });
    assert.equal(systemThemeHarness.root.dataset.theme, "dark", "system theme applies without stored preference");

    const health = await requestLocal(baseUrl, "/api/health");
    assert.deepEqual(JSON.parse(health.body), { ok: true, loginRequired: true }, "health must expose only liveness metadata");
    const anonymousSession = await requestLocal(baseUrl, "/api/session");
    assert.equal(anonymousSession.response.status, 401, "anonymous session API remains protected");
    assert.match(String(anonymousSession.response.headers.get("content-type") || ""), /^application\/json\b/i, "anonymous session response type");

    const beforeInvalidSubmissions = await snapshotTree(runtimeRoot);
    const secretSentinel = "DoNotReflect-Password-Sentinel!9";
    const invalidLogin = await requestLocal(baseUrl, "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "missing-public-ui-user", password: secretSentinel }),
    });
    assert.equal(invalidLogin.response.status, 401, "invalid login status");
    assert.doesNotMatch(invalidLogin.body, new RegExp(secretSentinel), "login response leaked password");
    assertPublicShell(invalidLogin.body, "/login invalid response");

    const invalidSignup = await requestLocal(baseUrl, "/signup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "x",
        password: secretSentinel,
        passwordConfirm: secretSentinel,
        phone: "",
        email: "invalid",
        companyName: "fixture-only",
        ownershipStatus: "none",
        agreeTerms: "1",
        agreePrivacy: "1",
        confirmAge: "1",
      }),
    });
    assert.ok(invalidSignup.response.status >= 400 && invalidSignup.response.status < 500, "invalid signup status");
    assert.doesNotMatch(invalidSignup.body, new RegExp(secretSentinel), "signup response leaked password");
    assertPublicShell(invalidSignup.body, "/signup invalid response");

    const invalidDelete = await requestLocal(baseUrl, "/account-delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ requestType: "account_delete" }),
    });
    assert.ok(invalidDelete.response.status >= 400 && invalidDelete.response.status < 500, "invalid delete request status");
    assert.match(invalidDelete.body, /role="alert"/, "delete validation error semantics");
    assertPublicShell(invalidDelete.body, "/account-delete invalid response");

    const afterInvalidSubmissions = await snapshotTree(runtimeRoot);
    assert.deepEqual(afterInvalidSubmissions, beforeInvalidSubmissions, "invalid public requests must not mutate isolated data files");

    const ratios = contrastResults.map((item) => `${item.label}=${item.ratio.toFixed(2)}:1`).join(", ");
    console.log(`Public auth/policy routes, contracts, themes, contrast, and no-write checks passed (${ratios})`);
  } catch (error) {
    const output = server.output();
    error.message += `\nIsolated server exit=${server.child.exitCode}; stdout=${output.stdout.slice(-1000)}; stderr=${output.stderr.slice(-1000)}`;
    throw error;
  } finally {
    await stopChild(server.child).catch(() => {});
    const resolvedTempRoot = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    const relative = path.relative(resolvedSystemTemp, resolvedTempRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected temp path: ${resolvedTempRoot}`);
    }
    await fsp.rm(resolvedTempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
