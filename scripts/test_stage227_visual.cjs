"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  ROOT,
  availablePort,
  requestJson,
  startServer,
  stopServer,
  bootstrapAdmin,
  signupBusiness
} = require("./test_stage227_helpers.cjs");

const ARTIFACT_DIR = path.join(ROOT, "artifacts", "stage227", "core-visual-qa");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage227_visual_qa.json");
const EXPECTED_SCREENSHOTS = 48;
const TARGETS = Object.freeze([
  { id: "business-onboarding", path: "/app/onboarding", role: "business", nav: 9 },
  { id: "business-activity", path: "/app/activity", role: "business", nav: 9 },
  { id: "business-location", path: "/app/location", role: "business", nav: 9 },
  { id: "admin-overview", path: "/admin/overview", role: "admin", nav: 13 },
  { id: "admin-companies", path: "/admin/companies", role: "admin", nav: 13 },
  { id: "admin-collection", path: "/admin/collection", role: "admin", nav: 13 },
  { id: "admin-settings", path: "/admin/settings", role: "admin", nav: 13 }
]);
const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 }
]);
const THEMES = Object.freeze(["light", "dark"]);
const STATE_CASES = Object.freeze([
  { id: "empty", expected: "empty", source: "empty" },
  { id: "loading", expected: "loading", source: "fixture", intercept: "loading" },
  { id: "error", expected: "error", source: "fixture", intercept: "error" },
  { id: "permission", expected: "permission", source: "fixture", intercept: "permission" },
  { id: "partial-data", expected: "partial", source: "fixture" }
]);

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE227_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 227 visual QA requires an installed Chrome or Edge executable");
  return executable;
}

function publicCookieRows(jar, baseUrl) {
  return Object.entries(jar).map(([name, value]) => ({ name, value, url: baseUrl }));
}

async function createAuthenticatedContext(browser, options) {
  // The Stage 226 session is bound to a hashed User-Agent. Node's fetch uses
  // `undici`, so the browser must use the same value when consuming its cookie.
  const context = await browser.newContext({
    userAgent: "undici",
    viewport: { width: options.width, height: options.height },
    ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {})
  });
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem("lodging-v2-theme", selectedTheme);
  }, options.theme);
  await context.addCookies(publicCookieRows(options.jar, options.baseUrl));
  return context;
}

function attachBrowserErrorCapture(page, expectedCoreFailure = false) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location()?.url || "";
    const expectedResourceFailure = expectedCoreFailure
      && sourceUrl.includes("/api/integration/core/workspace")
      && /Failed to load resource/i.test(message.text());
    if (!expectedResourceFailure) errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/integration/core/workspace") && request.failure()?.errorText === "net::ERR_ABORTED") return;
    errors.push(`request:${request.url()}:${request.failure()?.errorText || "failed"}`);
  });
  return errors;
}

async function installStateInterception(page, intercept) {
  if (!intercept) return;
  await page.route("**/api/integration/core/workspace?*", async (route) => {
    if (intercept === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          metadata: { stage: 227, provisional: true, dataBoundary: "fresh-only", source: "empty" },
          state: { kind: "empty" },
          metrics: { companyCount: 0, freshCompanyCount: 0, activeJobCount: 0 },
          companies: [], jobs: [], history: [], interests: [], locationCardRequests: [], tourismRequests: [], connectors: {}
        })
      }).catch(() => undefined);
      return;
    }
    const status = intercept === "permission" ? 403 : 500;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        error: intercept === "permission" ? "Synthetic role-safe denial" : "Synthetic visual error",
        code: intercept === "permission" ? "CORE_ROLE_FORBIDDEN" : "CORE_VISUAL_ERROR"
      })
    });
  });
}

async function waitForWorkspaceState(page, expected) {
  try {
    await page.locator('[data-testid="stage227-page"]').waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const response = await fetch("/api/session", { cache: "no-store" }).catch(() => null);
      return {
        pathname: window.location.pathname,
        sessionStatus: response?.status || 0,
        h1Count: document.querySelectorAll("h1").length,
        authPanelCount: document.querySelectorAll(".v2-auth-panel").length,
        stagePageCount: document.querySelectorAll('[data-testid="stage227-page"]').length
      };
    });
    throw new Error(`${error.message}; structural diagnostics ${JSON.stringify(diagnostics)}`);
  }
  await page.locator(`[data-testid="stage227-page"][data-workspace-state="${expected}"]`).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await page.locator(".v2-page-header h1").waitFor({ state: "visible" });
}

async function inspectPage(page, expected) {
  return page.evaluate(({ expectedTheme, expectedNav }) => {
    function parseColor(value) {
      const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
      const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
      return null;
    }
    function opaqueBackground(element) {
      let current = element;
      while (current) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color[3] > .95) return color;
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
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    }

    const contrastFailures = [];
    const selectors = [
      ".v2-page-header h1", ".v2-page-header p", ".v2-nav-item",
      ".v2-metric-card > span", ".v2-metric-card > strong", ".v2-metric-card > small",
      ".v2-data-section h2", ".v2-data-section h3", ".v2-data-section p",
      ".v2-data-section label > span:first-child", ".v2-record-list strong",
      ".v2-record-list span", ".v2-status-badge", ".v2-button:not(:disabled)"
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const foreground = parseColor(style.color);
        if (!foreground) continue;
        const ratio = contrast(foreground, opaqueBackground(element));
        const large = Number.parseFloat(style.fontSize) >= 24
          || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        const required = large ? 3 : 4.5;
        if (ratio + .01 < required) contrastFailures.push({ selector, ratio: Number(ratio.toFixed(2)), required });
      }
    }

    const header = document.querySelector(".v2-page-header");
    const metrics = document.querySelector('[data-testid="core-metrics"]');
    const data = document.querySelector(".v2-core-content");
    const position = (left, right) => Boolean(left && right && (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING));
    const controls = [...document.querySelectorAll("input, select, textarea")].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const labeledControls = controls.filter((element) => Boolean(
      element.closest("label") || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby")
    ));
    const bodyText = document.body.innerText;
    const forbiddenVisible = [
      /[A-Za-z]:\\(?:Users|Program Files|Windows)\\/,
      /(?:^|\s)\/(?:tmp|var|home)\//,
      /(?:OUTPUTS_DIR|CONFIG_DIR|glamping_datalab_session|lodging_v2_csrf)/i,
      /stage227-(?:bootstrap|session|fingerprint|mfa)-secret/i,
      /(?:raw[_ -]?output)[^\n]*(?:[A-Za-z]:\\|\/(?:tmp|var|home)\/)/i
    ].filter((pattern) => pattern.test(bodyText)).map((pattern) => pattern.source);

    return {
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      expectedTheme,
      h1Count: document.querySelectorAll("h1").length,
      navCount: document.querySelectorAll(".v2-nav-item").length,
      activeNavCount: document.querySelectorAll('.v2-nav-item[aria-current="page"]').length,
      expectedNav,
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      orderValid: position(header, metrics) && position(metrics, data),
      verticalOrderValid: Boolean(header && metrics && data
        && header.getBoundingClientRect().top <= metrics.getBoundingClientRect().top
        && metrics.getBoundingClientRect().top <= data.getBoundingClientRect().top),
      formControls: controls.length,
      labeledFormControls: labeledControls.length,
      contrastFailures,
      forbiddenVisible,
      workspaceState: document.querySelector('[data-testid="stage227-page"]')?.getAttribute("data-workspace-state") || ""
    };
  }, expected);
}

async function keyboardInspection(page) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    window.scrollTo(0, 0);
  });
  const focused = new Set();
  let maxOutline = 0;
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return {
        key: element ? `${element.tagName}:${element.getAttribute("href") || element.getAttribute("name") || element.id || element.textContent || ""}`.slice(0, 100) : "",
        outline: style ? Number.parseFloat(style.outlineWidth) || 0 : 0
      };
    });
    if (state.key) focused.add(state.key);
    maxOutline = Math.max(maxOutline, state.outline);
  }
  return { distinctFocusable: focused.size, maxOutline };
}

function assertInspection(inspection, expected, label) {
  assert.equal(inspection.theme, expected.theme, `${label}: theme`);
  assert.equal(inspection.savedTheme, expected.theme, `${label}: saved theme`);
  assert.equal(inspection.h1Count, 1, `${label}: exactly one h1`);
  assert.equal(inspection.navCount, expected.nav, `${label}: role navigation count`);
  assert.equal(inspection.activeNavCount, 1, `${label}: one active navigation item`);
  assert.ok(inspection.overflowX <= 1, `${label}: horizontal overflow ${inspection.overflowX}px`);
  assert.equal(inspection.orderValid, true, `${label}: PageHeader -> metrics -> data DOM order`);
  assert.equal(inspection.verticalOrderValid, true, `${label}: PageHeader -> metrics -> data visual order`);
  assert.equal(inspection.formControls, inspection.labeledFormControls, `${label}: every form control must be labeled`);
  assert.deepEqual(inspection.contrastFailures, [], `${label}: WCAG AA contrast ${JSON.stringify(inspection.contrastFailures)}`);
  assert.deepEqual(inspection.forbiddenVisible, [], `${label}: raw path or secret material is visible`);
  assert.equal(inspection.workspaceState, expected.state, `${label}: workspace state`);
}

async function capture(options) {
  const context = await createAuthenticatedContext(options.browser, {
    baseUrl: options.server.baseUrl,
    jar: options.jar,
    width: options.viewport.width,
    height: options.viewport.height,
    theme: options.theme
  });
  const page = await context.newPage();
  const errors = attachBrowserErrorCapture(page, options.intercept === "error" || options.intercept === "permission");
  try {
    await installStateInterception(page, options.intercept);
    await page.goto(`${options.server.baseUrl}${options.target.path}`, { waitUntil: "domcontentloaded" });
    await waitForWorkspaceState(page, options.expectedState);
    const inspection = await inspectPage(page, { expectedTheme: options.theme, expectedNav: options.target.nav });
    const filename = `${options.prefix}-${options.target.id}-${options.viewport.id}-${options.theme}.png`;
    await page.screenshot({ path: path.join(ARTIFACT_DIR, filename), fullPage: true });
    const keyboard = await keyboardInspection(page);
    assertInspection(inspection, {
      theme: options.theme,
      nav: options.target.nav,
      state: options.expectedState
    }, filename);
    assert.ok(keyboard.distinctFocusable >= 4, `${filename}: keyboard focus count ${keyboard.distinctFocusable}`);
    assert.ok(keyboard.maxOutline >= 2, `${filename}: focus outline ${keyboard.maxOutline}px`);
    assert.equal(errors.length, 0, `${filename}: browser errors ${errors.join(" | ")}`);
    return {
      matrix: options.prefix,
      surface: options.target.id,
      viewport: options.viewport.id,
      theme: options.theme,
      state: options.expectedState,
      screenshot: filename,
      inspection,
      keyboard,
      browserErrorCount: 0,
      passed: true
    };
  } finally {
    await context.close();
  }
}

async function specialInspection(options) {
  const context = await createAuthenticatedContext(options.browser, {
    baseUrl: options.server.baseUrl,
    jar: options.jar,
    width: options.width,
    height: options.height,
    theme: "light",
    deviceScaleFactor: options.deviceScaleFactor
  });
  const page = await context.newPage();
  const errors = attachBrowserErrorCapture(page);
  try {
    await page.goto(`${options.server.baseUrl}${options.target.path}`, { waitUntil: "domcontentloaded" });
    await waitForWorkspaceState(page, "partial");
    const inspection = await inspectPage(page, { expectedTheme: "light", expectedNav: options.target.nav });
    const keyboard = await keyboardInspection(page);
    assertInspection(inspection, { theme: "light", nav: options.target.nav, state: "partial" }, `${options.id}/${options.target.id}`);
    assert.ok(keyboard.distinctFocusable >= 4, `${options.id}/${options.target.id}: keyboard focus count`);
    assert.ok(keyboard.maxOutline >= 2, `${options.id}/${options.target.id}: focus outline`);
    assert.equal(errors.length, 0, `${options.id}/${options.target.id}: browser errors ${errors.join(" | ")}`);
    return {
      check: options.id,
      surface: options.target.id,
      width: options.width,
      effectiveScale: options.deviceScaleFactor || 1,
      overflowX: inspection.overflowX,
      formControls: inspection.formControls,
      labeledFormControls: inspection.labeledFormControls,
      keyboard,
      passed: true
    };
  } finally {
    await context.close();
  }
}

async function assertSessionPreserved(instance, account) {
  const response = await requestJson(instance, "/api/session", { jar: account.jar });
  assert.equal(response.status, 200, `${account.role} session must survive fixture restart`);
  assert.equal(response.body.authenticated, true, `${account.role} session authenticated after fixture restart`);
  assert.equal(response.body.role, account.sessionRole || account.role, `${account.role} session role after fixture restart`);
}

async function main() {
  const startedAt = Date.now();
  const nativeFetch = global.fetch;
  // Node releases disagree on their default fetch User-Agent (for example,
  // `node` versus `undici`). Pin provisioning requests and Playwright to the
  // same non-secret fingerprint input so a fresh session can be transferred.
  global.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", "undici");
    return nativeFetch(input, { ...init, headers });
  };
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui before Stage 227 visual QA");
  fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage227-core-visual-"));
  let server;
  let browser;
  let phase = "empty-server-start";
  const outputChunks = [];
  const observeOutput = (instance) => {
    instance.child.stdout.on("data", (chunk) => outputChunks.push(String(chunk)));
    instance.child.stderr.on("data", (chunk) => outputChunks.push(String(chunk)));
  };

  try {
    server = await startServer({ port, dataDir, uiFlag: true, authFlag: true, coreFlag: true, fixtureMode: false });
    observeOutput(server);
    phase = "account-bootstrap";
    const adminProvision = await bootstrapAdmin(server, {
      username: "stage227-visual-admin",
      email: "stage227-visual-admin@example.test",
      password: "Stage227VisualAdmin!1"
    });
    const businessProvision = await signupBusiness(server, "visual");
    const accounts = {
      admin: { role: "admin", jar: adminProvision.jar },
      business: { role: "business", sessionRole: "b2b", jar: businessProvision.jar }
    };

    const emptyAdmin = await requestJson(server, "/api/integration/core/workspace?view=admin-overview", { jar: accounts.admin.jar });
    const emptyBusiness = await requestJson(server, "/api/integration/core/workspace?view=business-onboarding", { jar: accounts.business.jar });
    assert.equal(emptyAdmin.status, 200, "empty admin workspace status");
    assert.equal(emptyBusiness.status, 200, "empty business workspace status");
    assert.equal(emptyAdmin.body.state.kind, "empty", "admin uses actual empty provisional store");
    assert.equal(emptyBusiness.body.state.kind, "empty", "business uses actual empty provisional store");
    assert.equal(emptyAdmin.body.metadata.source, "empty", "admin empty source");
    assert.equal(emptyBusiness.body.metadata.source, "empty", "business empty source");

    phase = "browser-launch";
    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader"] });
    const results = [];

    phase = "actual-empty-state-matrix";
    const emptyTarget = TARGETS.find((target) => target.id === "business-onboarding");
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        results.push(await capture({
          browser, server, jar: accounts.business.jar, target: emptyTarget,
          viewport, theme, expectedState: "empty", prefix: "state-empty"
        }));
      }
    }

    phase = "fixture-restart";
    await stopServer(server, false);
    server = await startServer({ port, dataDir, uiFlag: true, authFlag: true, coreFlag: true, fixtureMode: true });
    observeOutput(server);
    await assertSessionPreserved(server, accounts.admin);
    await assertSessionPreserved(server, accounts.business);
    const fixtureWorkspace = await requestJson(server, "/api/integration/core/workspace?view=admin-companies", { jar: accounts.admin.jar });
    assert.equal(fixtureWorkspace.status, 200, "fixture workspace status");
    assert.equal(fixtureWorkspace.body.metadata.source, "synthetic-fresh-collection", "fixture provenance");
    assert.equal(fixtureWorkspace.body.state.kind, "partial", "fixture exposes partial-data state");

    phase = "target-route-matrix";
    for (const target of TARGETS) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          results.push(await capture({
            browser, server, jar: accounts[target.role].jar, target,
            viewport, theme, expectedState: "partial", prefix: "target"
          }));
        }
      }
    }

    phase = "state-matrix";
    for (const stateCase of STATE_CASES.filter((item) => item.id !== "empty")) {
      const target = TARGETS.find((item) => item.id === (stateCase.id === "partial-data" ? "admin-companies" : "business-onboarding"));
      const account = accounts[target.role];
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          results.push(await capture({
            browser, server, jar: account.jar, target,
            viewport, theme, expectedState: stateCase.expected,
            prefix: `state-${stateCase.id}`, intercept: stateCase.intercept
          }));
        }
      }
    }

    phase = "minimum-width-and-zoom";
    const specialResults = [];
    for (const target of TARGETS) {
      specialResults.push(await specialInspection({
        id: "minimum-320", browser, server, jar: accounts[target.role].jar, target,
        width: 320, height: 844, deviceScaleFactor: 1
      }));
      specialResults.push(await specialInspection({
        id: "zoom-200", browser, server, jar: accounts[target.role].jar, target,
        width: 720, height: 450, deviceScaleFactor: 2
      }));
    }

    const screenshotFiles = fs.readdirSync(ARTIFACT_DIR).filter((name) => name.toLowerCase().endsWith(".png"));
    assert.equal(results.length, EXPECTED_SCREENSHOTS, "visual result count");
    assert.equal(screenshotFiles.length, EXPECTED_SCREENSHOTS, "visual screenshot file count");
    assert.equal(new Set(screenshotFiles).size, EXPECTED_SCREENSHOTS, "visual screenshot names must be unique");
    for (const stateCase of STATE_CASES) {
      assert.equal(results.filter((result) => result.matrix === `state-${stateCase.id}`).length, 4, `${stateCase.id} state screenshot count`);
    }
    assert.equal(results.filter((result) => result.matrix === "target").length, 28, "target route screenshot count");
    assert.equal(specialResults.filter((result) => result.check === "minimum-320").length, 7, "320px target count");
    assert.equal(specialResults.filter((result) => result.check === "zoom-200").length, 7, "200% zoom target count");

    const report = {
      stage: 227,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      browser: path.basename(executablePath),
      buildAsserted: true,
      actualEmptyStoreVerified: true,
      sessionPreservedAcrossFixtureRestart: true,
      syntheticFixtureProvenanceVerified: true,
      targetSurfaceCount: TARGETS.length,
      targetMatrixScreenshotCount: 28,
      stateMatrixScreenshotCount: 20,
      expectedScreenshotCount: EXPECTED_SCREENSHOTS,
      screenshotCount: screenshotFiles.length,
      stateScreenshotCounts: Object.fromEntries(STATE_CASES.map((stateCase) => [
        stateCase.id,
        results.filter((result) => result.matrix === `state-${stateCase.id}`).length
      ])),
      minimumWidth: { cssPixels: 320, surfaceCount: 7, passed: true },
      zoom: { percent: 200, surfaceCount: 7, passed: true },
      browserErrorCount: 0,
      secretMaterialRecorded: false,
      rawFilesystemPathRecorded: false,
      results,
      specialResults,
      passed: true
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Stage 227 visual QA passed: ${EXPECTED_SCREENSHOTS} screenshots, 7 routes at 320px and 200% zoom (${Date.now() - startedAt}ms)`);
  } catch (error) {
    const serverTail = outputChunks.join("").slice(-4_000);
    throw new Error(`Stage 227 visual QA failed during ${phase}: ${error.message}\nServer output tail:\n${serverTail}`);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    global.fetch = nativeFetch;
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
