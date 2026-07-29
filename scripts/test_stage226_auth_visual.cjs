"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { totp } = require("./integration/services/auth_crypto.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "stage226", "auth-visual-qa");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage226_auth_visual_qa.json");
const ADMIN = Object.freeze({ username: "stage226-visual-admin", email: "stage226-visual-admin@example.test", password: "Stage226Visual!" });
const KEYS = Object.freeze({
  bootstrap: "stage226-visual-bootstrap-secret-32-characters-minimum",
  session: "stage226-visual-session-secret-32-characters-minimum",
  mfa: "stage226-visual-mfa-secret-32-characters-minimum"
});
let anonymousCsrf = "";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE226_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 226 auth visual QA requires an installed Chrome or Edge executable");
  return executable;
}

function startServer(port, dataDir) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return childProcess.spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      CONFIG_DIR: path.join(dataDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      V2_UI_V3_ENABLED: "true",
      V2_INTEGRATION_AUTH_ENABLED: "true",
      V2_INTEGRATION_AUTH_STORE_PATH: path.join(dataDir, "fresh-integration", "auth-store-v1.json"),
      V2_AUTH_BOOTSTRAP_SECRET: KEYS.bootstrap,
      V2_AUTH_SESSION_KEY_VERSION: "visual-v1",
      V2_AUTH_SESSION_HASH_KEY_CURRENT: KEYS.session,
      V2_AUTH_MFA_ENCRYPTION_KEY: KEYS.mfa,
      V2_AUTH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      V2_AUTH_ALLOWED_ORIGINS: baseUrl,
      V2_AUTH_EMAIL_PROVIDER: "mock",
      V2_INTEGRATION_COMPANY_ENABLED: "",
      V2_INTEGRATION_OBSERVATION_ENABLED: "",
      V2_INTEGRATION_BUSINESS_REPORT_ENABLED: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`visual server exited (${child.exitCode})\n${output()}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for Stage 226 visual server\n${output()}`);
}

async function api(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: baseUrl }),
      ...(body === undefined || !anonymousCsrf ? {} : { "X-CSRF-Token": anonymousCsrf }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function provisionMfaAdmin(baseUrl) {
  anonymousCsrf = (await api(baseUrl, "/api/auth/csrf")).csrfToken;
  const bootstrap = await api(baseUrl, "/api/auth/bootstrap", {
    username: ADMIN.username,
    email: ADMIN.email,
    displayName: "시각 QA 관리자",
    password: ADMIN.password
  }, { "X-Bootstrap-Secret": KEYS.bootstrap });
  const setup = await api(baseUrl, "/api/auth/mfa/enroll", { enrollmentToken: bootstrap.enrollmentToken });
  const confirmed = await api(baseUrl, "/api/auth/mfa/confirm", {
    enrollmentToken: bootstrap.enrollmentToken,
    code: totp(setup.secret)
  });
  assert.equal(confirmed.recoveryCodes.length, 8);
}

async function enterMfaChallenge(page, baseUrl) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.locator('input[name="username"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator(".v2-login-submit").click();
  await page.getByRole("heading", { name: "인증 앱 코드를 입력하세요" }).waitFor();
}

async function inspectPage(page) {
  return page.evaluate(() => {
    function parseColor(value) {
      const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
      const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/i);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
      return null;
    }
    function backgroundFor(element) {
      let current = element;
      while (current) {
        const parsed = parseColor(getComputedStyle(current).backgroundColor);
        if (parsed && parsed[3] > .95) return parsed;
        current = current.parentElement;
      }
      return parseColor(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
    }
    function luminance(color) {
      const values = color.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
    }
    function contrast(foreground, background) {
      const a = luminance(foreground); const b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    }
    const contrastFailures = [];
    for (const selector of [".v2-auth-copy h1", ".v2-auth-copy p", ".v2-field > span:first-child", ".v2-field-message", ".v2-button:not(:disabled)", ".v2-auth-footer", ".v2-check-list", ".v2-auth-note"]) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const foreground = parseColor(style.color); const background = backgroundFor(element);
        if (!foreground) continue;
        const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        const ratio = contrast(foreground, background);
        if (ratio + .01 < (large ? 3 : 4.5)) contrastFailures.push({ selector, ratio: Number(ratio.toFixed(2)) });
      }
    }
    const panel = document.querySelector(".v2-auth-panel")?.getBoundingClientRect();
    const textControls = [...document.querySelectorAll('input:not([type="checkbox"]), select')];
    const submits = [...document.querySelectorAll(".v2-auth-submit")];
    const inputs = [...document.querySelectorAll("input, select")];
    return {
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      h1Count: document.querySelectorAll("h1").length,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      panelWidth: panel?.width || 0,
      inputMinHeight: textControls.length ? Math.min(...textControls.map((element) => element.getBoundingClientRect().height)) : 0,
      submitMinHeight: submits.length ? Math.min(...submits.map((element) => element.getBoundingClientRect().height)) : 0,
      inputsLabeled: inputs.every((element) => Boolean(element.closest("label") || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby"))),
      contrastFailures,
      secretTextVisible: document.body.innerText.includes("stage226-visual-bootstrap-secret")
    };
  });
}

async function keyboardInspection(page) {
  const focused = new Set();
  let maxOutline = 0;
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return {
        key: element ? `${element.tagName}:${element.getAttribute("name") || element.textContent || element.id}`.slice(0, 80) : "",
        outline: style ? Number.parseFloat(style.outlineWidth) || 0 : 0
      };
    });
    if (state.key) focused.add(state.key);
    maxOutline = Math.max(maxOutline, state.outline);
  }
  return { distinctFocusable: focused.size, maxOutline };
}

async function navigateSurface(page, baseUrl, surface) {
  if (surface.id === "mfa") return enterMfaChallenge(page, baseUrl);
  await page.goto(`${baseUrl}${surface.path}`, { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  if (surface.id === "activate") await page.getByRole("heading", { name: "계정을 활성화하세요" }).waitFor();
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui before Stage 226 visual QA");
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage226-auth-visual-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port, dataDir);
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
  server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
  let browser;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    await provisionMfaAdmin(baseUrl);
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true, args: ["--use-angle=swiftshader"] });
    const surfaces = [
      { id: "login", path: "/login" },
      { id: "signup", path: "/signup" },
      { id: "activate", path: "/activate?token=visual-redacted-token" },
      { id: "reset", path: "/reset-password" },
      { id: "mfa", path: "/login" }
    ];
    const viewports = [{ id: "desktop", width: 1440, height: 900 }, { id: "mobile", width: 390, height: 844 }];
    const themes = ["light", "dark"];
    const results = [];
    for (const surface of surfaces) {
      for (const viewport of viewports) {
        for (const theme of themes) {
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
          await context.addInitScript((selected) => localStorage.setItem("lodging-v2-theme", selected), theme);
          const page = await context.newPage();
          const errors = [];
          page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
          page.on("pageerror", (error) => errors.push(`page:${error.message}`));
          page.on("requestfailed", (request) => errors.push(`request:${request.url()}:${request.failure()?.errorText || "failed"}`));
          await navigateSurface(page, baseUrl, surface);
          const inspection = await inspectPage(page);
          const keyboard = await keyboardInspection(page);
          const screenshot = path.join(ARTIFACT_DIR, `${surface.id}-${viewport.id}-${theme}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          assert.equal(errors.length, 0, `${surface.id}/${viewport.id}/${theme}: ${errors.join(" | ")}`);
          assert.equal(inspection.theme, theme);
          assert.equal(inspection.savedTheme, theme);
          assert.equal(inspection.h1Count, 1);
          assert.ok(inspection.overflowX <= 1, `${surface.id}/${viewport.id}/${theme} overflow ${inspection.overflowX}`);
          assert.equal(inspection.inputsLabeled, true);
          assert.equal(inspection.contrastFailures.length, 0, JSON.stringify(inspection.contrastFailures));
          assert.equal(inspection.secretTextVisible, false);
          const expectedWidth = viewport.id === "desktop" ? 440 : viewport.width - 32;
          assert.ok(Math.abs(inspection.panelWidth - expectedWidth) <= 1, `${surface.id} panel ${inspection.panelWidth}`);
          assert.ok(inspection.inputMinHeight >= 42, `${surface.id} input ${inspection.inputMinHeight}`);
          assert.ok(inspection.submitMinHeight >= 44, `${surface.id} submit ${inspection.submitMinHeight}`);
          assert.ok(keyboard.distinctFocusable >= 4, `${surface.id} keyboard count ${keyboard.distinctFocusable}`);
          assert.ok(keyboard.maxOutline >= 2, `${surface.id} outline ${keyboard.maxOutline}`);
          results.push({
            surface: surface.id,
            viewport,
            theme,
            screenshot: path.relative(ROOT, screenshot).replace(/\\/g, "/"),
            inspection,
            keyboard,
            browserErrors: [],
            passed: true
          });
          await context.close();
        }
      }
    }

    for (const special of [{ id: "minimum-320", width: 320, height: 844, scale: 1 }, { id: "zoom-200", width: 720, height: 450, scale: 2 }]) {
      for (const surface of surfaces) {
        const context = await browser.newContext({ viewport: { width: special.width, height: special.height }, deviceScaleFactor: special.scale });
        await context.addInitScript(() => localStorage.setItem("lodging-v2-theme", "light"));
        const page = await context.newPage();
        await navigateSurface(page, baseUrl, surface);
        const inspection = await inspectPage(page);
        assert.ok(inspection.overflowX <= 1, `${surface.id}/${special.id} overflow ${inspection.overflowX}`);
        assert.equal(inspection.inputsLabeled, true);
        results.push({ surface: surface.id, viewport: special, theme: "light", inspection, passed: true });
        await context.close();
      }
    }

    const report = {
      stage: 226,
      generatedAt: new Date().toISOString(),
      browser: path.basename(findBrowserExecutable()),
      requiredScreenshots: 20,
      screenshotCount: results.filter((row) => row.screenshot).length,
      secretMaterialRecorded: false,
      minimumWidthChecked: 320,
      zoomCheckedPercent: 200,
      results,
      passed: true
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Stage 226 auth visual QA passed: 20 screenshots, 320px and 200% zoom (${REPORT_PATH})`);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${serverOutput}`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
