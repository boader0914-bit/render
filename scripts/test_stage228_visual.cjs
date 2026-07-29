"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  ROOT,
  availablePort,
  bootstrapAdmin,
  requestJson,
  signupBusiness,
  startServer,
  stopServer
} = require("./test_stage227_helpers.cjs");

const ARTIFACT_DIR = path.join(ROOT, "artifacts", "stage228", "company-detail-visual-qa");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage228_visual_qa.json");
const SURFACES = Object.freeze([
  { id: "admin-company-detail", path: "/admin/companies", role: "admin", nav: 13 },
  { id: "business-company-detail", path: "/app/activity", role: "business", nav: 9 }
]);
const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 }
]);
const THEMES = Object.freeze(["light", "dark"]);

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE228_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 228 visual QA requires Chrome or Edge");
  return executable;
}

function cookies(jar, baseUrl) {
  return Object.entries(jar).map(([name, value]) => ({ name, value, url: baseUrl }));
}

async function contextFor(browser, server, jar, viewport, theme, deviceScaleFactor = 1) {
  const context = await browser.newContext({
    userAgent: "undici",
    viewport,
    deviceScaleFactor
  });
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem("lodging-v2-theme", selectedTheme);
  }, theme);
  await context.addCookies(cookies(jar, server.baseUrl));
  return context;
}

async function inspect(page, expected) {
  return page.evaluate(({ theme, nav, role }) => {
    const detail = document.querySelector('[data-testid="company-fresh-detail"]');
    const text = detail?.textContent || "";
    const controls = [...document.querySelectorAll("a, button, input, select, textarea")].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    return {
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      navCount: document.querySelectorAll(".v2-nav-item").length,
      h1Count: document.querySelectorAll("h1").length,
      role: detail?.getAttribute("data-detail-role") || "",
      state: detail?.getAttribute("data-detail-state") || "",
      metricCount: detail?.querySelectorAll('[data-testid="company-detail-metrics"] .v2-metric-card').length || 0,
      provenance: Boolean(detail?.querySelector('[data-testid="company-provenance-summary"]')),
      observations: Boolean(detail?.querySelector('[data-testid="company-observation-summary"]')),
      changes: Boolean(detail?.querySelector('[data-testid="company-change-history"]')),
      enrichment: Boolean(detail?.querySelector('[data-testid="company-enrichment-cta"]')),
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      forbidden: [
        /sourceUrl|rawEvidenceId|evidenceId/i,
        /[A-Za-z]:\\(?:Users|Program Files|Windows)\\/,
        /(?:^|\s)\/(?:tmp|var|home)\//,
        /customer_db|company_master|\/outputs\//i
      ].filter((pattern) => pattern.test(text)).map((pattern) => pattern.source),
      focusableCount: controls.length,
      expected: { theme, nav, role }
    };
  }, expected);
}

async function keyboardFocus(page) {
  let outlined = 0;
  const focused = new Set();
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return {
        key: active ? `${active.tagName}:${active.getAttribute("href") || active.textContent || ""}`.slice(0, 120) : "",
        outline: style ? Number.parseFloat(style.outlineWidth) || 0 : 0
      };
    });
    if (state.key) focused.add(state.key);
    outlined = Math.max(outlined, state.outline);
  }
  return { distinct: focused.size, maxOutline: outlined };
}

function assertInspection(row, label) {
  assert.equal(row.theme, row.expected.theme, `${label}: theme`);
  assert.equal(row.savedTheme, row.expected.theme, `${label}: saved theme`);
  assert.equal(row.navCount, row.expected.nav, `${label}: role navigation`);
  assert.equal(row.h1Count, 1, `${label}: one h1`);
  assert.equal(row.role, row.expected.role, `${label}: detail role`);
  assert.equal(row.state, "ready", `${label}: ready fresh detail`);
  assert.equal(row.metricCount, 3, `${label}: completeness/freshness/confidence metrics`);
  assert.equal(row.provenance, true, `${label}: provenance summary`);
  assert.equal(row.observations, true, `${label}: repeated observation summary`);
  assert.equal(row.changes, true, `${label}: change history`);
  assert.equal(row.enrichment, true, `${label}: enrichment CTA`);
  assert.ok(row.overflowX <= 1, `${label}: horizontal overflow ${row.overflowX}px`);
  assert.deepEqual(row.forbidden, [], `${label}: raw/internal data visible`);
  assert.ok(row.focusableCount >= 4, `${label}: focusable controls`);
}

async function capture(browser, server, account, surface, viewport, theme) {
  const context = await contextFor(browser, server, account.jar, viewport, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="company-fresh-detail"][data-detail-state="ready"]').waitFor({ timeout: 15_000 });
    const inspection = await inspect(page, { theme, nav: surface.nav, role: surface.role });
    const filename = `${surface.id}-${viewport.id}-${theme}.png`;
    await page.screenshot({ path: path.join(ARTIFACT_DIR, filename), fullPage: true });
    const keyboard = await keyboardFocus(page);
    assertInspection(inspection, filename);
    assert.ok(keyboard.distinct >= 4, `${filename}: keyboard sequence`);
    assert.ok(keyboard.maxOutline >= 2, `${filename}: visible focus`);
    assert.deepEqual(errors, [], `${filename}: browser errors`);
    return { surface: surface.id, viewport: viewport.id, theme, screenshot: filename, inspection, keyboard, passed: true };
  } finally {
    await context.close();
  }
}

async function specialCheck(browser, server, account, surface, id, viewport, scale) {
  const context = await contextFor(browser, server, account.jar, viewport, "light", scale);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="company-fresh-detail"][data-detail-state="ready"]').waitFor({ timeout: 15_000 });
    const result = await inspect(page, { theme: "light", nav: surface.nav, role: surface.role });
    assertInspection(result, `${id}:${surface.id}`);
    return { id, surface: surface.id, viewport, scale, overflowX: result.overflowX, passed: true };
  } finally {
    await context.close();
  }
}

async function waitForCompletedJob(server, jar, clientRequestId) {
  const deadline = Date.now() + 20_000;
  const statuses = new Set();
  while (Date.now() < deadline) {
    const response = await requestJson(
      server,
      `/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}`,
      { jar }
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    statuses.add(response.body.job?.status || "");
    if (response.body.job?.status === "completed") return { response, statuses: [...statuses] };
    if (["failed", "cancelled"].includes(response.body.job?.status)) {
      throw new Error(`visual collection terminated as ${response.body.job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`visual collection did not complete; observed ${[...statuses].join(", ")}`);
}

async function main() {
  const nativeFetch = global.fetch;
  global.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", "undici");
    return nativeFetch(input, { ...init, headers });
  };
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui first");
  fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-visual-auth-"));
  const integrationDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-visual-fresh-"));
  let server;
  let browser;
  try {
    server = await startServer({
      port: await availablePort(), dataDir, integrationDataDir,
      uiFlag: true, authFlag: true, coreFlag: true,
      freshCompanyFlag: true, freshObservationFlag: true
    });
    const admin = await bootstrapAdmin(server, {
      username: "stage228-visual-admin",
      email: "stage228-visual-admin@example.test",
      password: "Stage228VisualAdmin!1"
    });
    const business = await signupBusiness(server, "visual");
    const collected = await requestJson(server, "/api/integration/core/jobs", {
      method: "POST",
      jar: business.jar,
      body: {
        kind: "business-search",
        clientRequestId: "stage228-visual-vertical-0001",
        keyword: "Stage 228 시각 QA 글램핑",
        regionLabel: "경남"
      }
    });
    assert.equal(collected.status, 202, JSON.stringify(collected.body));
    assert.ok(["queued", "running"].includes(collected.body.job.status), "POST must expose a cancellable non-terminal job");
    const terminal = await waitForCompletedJob(server, business.jar, "stage228-visual-vertical-0001");
    assert.equal(terminal.response.body.job.status, "completed");

    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader"] });
    const accounts = { admin: { jar: admin.jar }, business: { jar: business.jar } };
    const results = [];
    for (const surface of SURFACES) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          results.push(await capture(browser, server, accounts[surface.role], surface, viewport, theme));
        }
      }
    }
    const special = [];
    for (const surface of SURFACES) {
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "minimum-320", { width: 320, height: 844 }, 1));
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "zoom-200", { width: 720, height: 450 }, 2));
    }
    const screenshots = fs.readdirSync(ARTIFACT_DIR).filter((name) => name.endsWith(".png"));
    assert.equal(results.length, 8);
    assert.equal(screenshots.length, 8);
    const report = {
      stage: 228,
      generatedAt: new Date().toISOString(),
      browser: path.basename(executablePath),
      surfaces: 2,
      fourConditionCombinationsPerSurface: 4,
      screenshotCount: 8,
      minimumWidth: 320,
      zoomPercent: 200,
      externalProviderCalls: 0,
      rawPathVisible: false,
      results,
      special,
      passed: true
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Stage 228 company detail visual QA passed: ${screenshots.length} screenshots, 320px and 200% zoom`);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
    global.fetch = nativeFetch;
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
