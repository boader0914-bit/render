const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const PORT = 3427;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "stage225", "visual-qa");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage225_visual_qa.json");
const ADMIN = { username: "stage225-visual-admin", password: "stage225-visual-admin-password" };
const BUSINESS = { username: "stage225-visual-business", password: "stage225-visual-business-password" };

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE225_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 225 visual QA requires an installed Chrome or Edge executable.");
  return executable;
}

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`visual QA server exited with ${child.exitCode}`);
    try { if ((await fetch(`${BASE_URL}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Stage 225 visual QA server.");
}

function startServer(dataDir) {
  return childProcess.spawn(process.execPath, [path.join(ROOT, "scripts", "glamping_app_server.cjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      CONFIG_DIR: path.join(dataDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      V2_UI_V3_ENABLED: "true",
      V2_INTEGRATION_AUTH_ENABLED: "",
      GLAMPING_ADMIN_USER: ADMIN.username,
      GLAMPING_ADMIN_PASSWORD: ADMIN.password,
      GLAMPING_B2B_USER: BUSINESS.username,
      GLAMPING_B2B_PASSWORD: BUSINESS.password,
      GLAMPING_B2B_ENABLED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function authenticate(page, credentials) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async (body) => {
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await response.text();
    return { ok: response.ok, status: response.status };
  }, credentials);
  assert.equal(result.ok, true, `visual QA login failed with ${result.status}`);
}

async function inspectPage(page, expected) {
  return page.evaluate(({ expectedNav, theme, isLogin }) => {
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
    const selectors = isLogin
      ? [".v2-auth-copy h1", ".v2-auth-copy p", ".v2-field > span", ".v2-button", ".v2-auth-footer"]
      : [".v2-page-header h1", ".v2-page-header p", ".v2-nav-item", ".v2-metric-card > span", ".v2-metric-card > strong", ".v2-metric-card > small", ".v2-empty-state strong", ".v2-empty-state p", ".v2-status-badge"];
    for (const selector of selectors) {
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
    const inputs = [...document.querySelectorAll("input")];
    const submit = document.querySelector(".v2-login-submit")?.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      h1Count: document.querySelectorAll("h1").length,
      navCount: document.querySelectorAll(".v2-nav-item").length,
      activeNavCount: document.querySelectorAll('.v2-nav-item[aria-current="page"]').length,
      expectedNav,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      panelWidth: panel?.width || 0,
      inputMinHeight: inputs.length ? Math.min(...inputs.map((input) => input.getBoundingClientRect().height)) : 0,
      inputsLabeled: inputs.every((input) => Boolean(input.closest("label") || input.getAttribute("aria-label") || input.getAttribute("aria-labelledby"))),
      submitHeight: submit?.height || 0,
      contrastFailures
    };
  }, expected);
}

async function keyboardInspection(page) {
  const focused = new Set();
  let maxOutline = 0;
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return { key: element ? `${element.tagName}:${element.textContent || element.getAttribute("name") || element.id}`.slice(0, 80) : "", outline: style ? Number.parseFloat(style.outlineWidth) || 0 : 0 };
    });
    if (state.key) focused.add(state.key);
    maxOutline = Math.max(maxOutline, state.outline);
  }
  return { distinctFocusable: focused.size, maxOutline };
}

(async () => {
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui before visual QA");
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage225-visual-"));
  const server = startServer(dataDir);
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  let browser;
  try {
    await waitForServer(server);
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true, args: ["--use-angle=swiftshader"] });
    const surfaces = [
      { id: "login", path: "/login", nav: 0, credentials: null },
      { id: "admin", path: "/admin/overview", nav: 13, credentials: ADMIN },
      { id: "business", path: "/app/onboarding", nav: 9, credentials: BUSINESS }
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
          if (surface.credentials) await authenticate(page, surface.credentials);
          await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "networkidle" });
          await page.locator("h1").waitFor();
          const inspection = await inspectPage(page, { expectedNav: surface.nav, theme, isLogin: surface.id === "login" });
          const keyboard = await keyboardInspection(page);
          const screenshot = path.join(ARTIFACT_DIR, `${surface.id}-${viewport.id}-${theme}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          assert.equal(errors.length, 0, `${surface.id}/${viewport.id}/${theme} browser errors: ${errors.join(" | ")}`);
          assert.equal(inspection.theme, theme);
          assert.equal(inspection.savedTheme, theme);
          assert.equal(inspection.h1Count, 1);
          assert.equal(inspection.navCount, surface.nav);
          assert.equal(inspection.activeNavCount, surface.nav ? 1 : 0);
          assert.ok(inspection.overflowX <= 1, `${surface.id}/${viewport.id}/${theme} horizontal overflow ${inspection.overflowX}px`);
          assert.equal(inspection.contrastFailures.length, 0, JSON.stringify(inspection.contrastFailures));
          assert.ok(keyboard.distinctFocusable >= 4, `${surface.id} keyboard focus count ${keyboard.distinctFocusable}`);
          assert.ok(keyboard.maxOutline >= 2, `${surface.id} focus outline ${keyboard.maxOutline}px`);
          if (surface.id === "login") {
            const expectedWidth = viewport.id === "desktop" ? 440 : viewport.width - 32;
            assert.ok(Math.abs(inspection.panelWidth - expectedWidth) <= 1, `login panel width ${inspection.panelWidth}`);
            assert.ok(inspection.inputMinHeight >= 42);
            assert.ok(inspection.submitHeight >= 44);
            assert.equal(inspection.inputsLabeled, true);
          }
          results.push({ surface: surface.id, viewport, theme, screenshot: path.relative(ROOT, screenshot).replace(/\\/g, "/"), errors, inspection, keyboard, passed: true });
          await context.close();
        }
      }
    }

    for (const special of [{ id: "minimum-320", width: 320, height: 844, scale: 1 }, { id: "zoom-200", width: 720, height: 450, scale: 2 }]) {
      for (const surface of surfaces) {
        const context = await browser.newContext({ viewport: { width: special.width, height: special.height }, deviceScaleFactor: special.scale });
        await context.addInitScript(() => localStorage.setItem("lodging-v2-theme", "light"));
        const page = await context.newPage();
        if (surface.credentials) await authenticate(page, surface.credentials);
        await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: "networkidle" });
        await page.locator("h1").waitFor();
        const inspection = await inspectPage(page, { expectedNav: surface.nav, theme: "light", isLogin: surface.id === "login" });
        assert.ok(inspection.overflowX <= 1, `${surface.id}/${special.id} horizontal overflow ${inspection.overflowX}px`);
        results.push({ surface: surface.id, viewport: special, theme: "light", inspection, passed: true });
        await context.close();
      }
    }

    const report = { stage: 225, generatedAt: new Date().toISOString(), browser: findBrowserExecutable(), requiredScreenshots: 12, results, passed: true };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Stage 225 visual QA passed: 12 screenshots, 320px and 200% zoom (${REPORT_PATH})`);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${serverOutput}`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
