"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  ROOT,
  assertZeroNetworkAttempts,
  availablePort,
  bootstrapAdmin,
  networkGuardEnvironment,
  signupBusiness,
  startServer,
  stopServer,
  temporaryDirectory
} = require("./test_support/stage229_test_helpers.cjs");

const WRITE_EVIDENCE = process.argv.includes("--write-evidence");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage229_visual_qa.json");
const SURFACES = Object.freeze([
  {
    id: "admin-location",
    path: "/admin/location",
    role: "admin",
    navCount: 13,
    selectors: [
      "stage229-company-select",
      "stage229-lifecycle",
      "stage229-location-card",
      "stage229-admin-actions",
      "stage229-audit"
    ]
  },
  {
    id: "business-location",
    path: "/app/location",
    role: "business",
    navCount: 9,
    selectors: [
      "stage229-readiness",
      "stage229-location-card",
      "stage229-location-scores",
      "stage229-evidence-summary",
      "stage229-forecast"
    ]
  },
  {
    id: "business-report",
    path: "/app/report",
    role: "business",
    navCount: 9,
    selectors: [
      "stage229-readiness",
      "stage229-monthly-report",
      "stage229-report-scopes",
      "stage229-anonymous-cohort",
      "stage229-forecast",
      "stage229-report-location-link"
    ]
  }
]);
const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 }
]);
const THEMES = Object.freeze(["light", "dark"]);

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE229_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 229 visual QA requires Chrome or Edge");
  return executable;
}

function digestFile(filename) {
  return fs.existsSync(filename)
    ? crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
    : null;
}

function cookies(jar, baseUrl) {
  return Object.entries(jar).map(([name, value]) => ({ name, value, url: baseUrl }));
}

function readyForecast() {
  return {
    state: "ready",
    label: "Next-month demand forecast",
    summary: "Forecast calculated only from repeated fresh observations.",
    asOfDate: "2026-07-29",
    inputRange: { from: "2026-07-01", to: "2026-07-28" },
    sampleCount: 3,
    minimumSampleCount: 3,
    confidence: { label: "Medium", causes: ["Three complete D14 D7 D1 series"] },
    interval: { displayValue: "58.2 - 74.8 points", low: 58.2, high: 74.8, unit: "points" },
    bookingPace: { displayValue: "2.4 per day", detail: "Fresh repeated observations only" }
  };
}

function readyWorkspace(view) {
  const forecast = readyForecast();
  const admin = view === "admin-location";
  const lifecycle = admin ? "reviewed" : "published";
  return {
    metadata: {
      stage: 229,
      generatedAt: "2026-07-29T00:00:00.000Z",
      algorithmVersion: "v2-stage229-location-forecast-v1",
      sourceBoundary: "fresh-integration-stage229-only"
    },
    view,
    state: "ready",
    companyId: "cmp_visual_owner_001",
    subjects: [
      { companyId: "cmp_visual_owner_001", companyName: "Stage 229 Sample Lodging", regionLabel: "Sample Region" },
      { companyId: "cmp_visual_subject_002", companyName: "Second Sample Lodging", regionLabel: "Review Region" }
    ],
    readiness: {
      state: "ready",
      label: "Publication criteria met",
      detail: "Freshness and minimum repeated-observation gates are satisfied.",
      sampleCount: 3,
      minimumSampleCount: 3,
      inputRange: { from: "2026-07-01", to: "2026-07-28" },
      freshnessLabel: "Fresh observations and signals",
      confidence: { label: "Medium", causes: ["Three complete lead-time series"] },
      missingReasons: []
    },
    locationCard: {
      cardId: "card_visual_001",
      version: 6,
      lifecycle,
      title: "Stage 229 Location Card",
      companyName: "Stage 229 Sample Lodging",
      regionLabel: "Sample Region",
      summary: "A business-safe summary of the newly observed regional structure.",
      algorithmVersion: "v2-stage229-location-forecast-v1",
      evidence: {
        summary: "14 observations, 4 required signals, 2026-07-01 through 2026-07-28",
        observationCount: 14,
        signalCount: 4,
        inputRange: { from: "2026-07-01", to: "2026-07-28" },
        algorithmVersion: "v2-stage229-location-forecast-v1"
      },
      updatedAt: "2026-07-29",
      publishedAt: admin ? "" : "2026-07-29",
      freshness: { label: "Fresh" },
      confidence: { label: "Medium", causes: ["Complete repeat series", "Fresh required signals"] },
      scores: [
        { id: "tourism", state: "ready", displayValue: "81 / 100", detail: "Fresh tourism signal" },
        { id: "industry", state: "ready", displayValue: "72 / 100", detail: "Fresh industry signal" },
        { id: "living-area", state: "ready", displayValue: "74 / 100", detail: "Fresh living-area structure" },
        { id: "accessibility", state: "ready", displayValue: "69 / 100", detail: "Fresh accessibility structure" },
        { id: "interest", state: "ready", displayValue: "77 / 100", detail: "Fresh interest signal" },
        { id: "ota", state: "ready", displayValue: "68 / 100", detail: "Fresh OTA exposure" },
        { id: "leadtime", state: "ready", displayValue: "71 / 100", detail: "Complete D14 D7 D1 series" }
      ],
      forecast,
      allowedActions: admin ? ["publish"] : []
    },
    monthlyReport: {
      state: "ready",
      month: "2026-08",
      title: "August Monthly Report",
      summary: "National, regional, own-property and anonymous cohort summary.",
      publishedAt: "2026-07-29",
      algorithmVersion: "v2-stage229-location-forecast-v1",
      locationCardPath: "/app/location",
      scopes: [
        { id: "national", state: "ready", label: "National", displayValue: "68 points", detail: "De-identified fresh aggregate" },
        { id: "regional", state: "ready", label: "Regional", displayValue: "71 points", detail: "Fresh regional aggregate" },
        { id: "own", state: "ready", label: "Own lodging", displayValue: "73 points", detail: "Own newly observed data" },
        { id: "anonymous-cohort", state: "ready", label: "Anonymous cohort", displayValue: "70 points", detail: "k=3 de-identified cohort" }
      ],
      cohort: {
        label: "Anonymous cohort",
        summary: "The subject is excluded from the k=3 comparison cohort.",
        sampleCount: 3,
        minimumSampleCount: 3
      },
      forecast
    },
    allowedActions: admin ? ["publish"] : [],
    audit: admin ? {
      count: 2,
      latest: [
        { auditId: "audit_visual_002", event: "location-card.reviewed", at: "2026-07-29T00:00:00.000Z", actorRole: "admin" },
        { auditId: "audit_visual_001", event: "location-card.drafted", at: "2026-07-28T23:00:00.000Z", actorRole: "admin" }
      ]
    } : []
  };
}

async function createContext(browser, server, jar, viewport, theme, externalRequests, deviceScaleFactor = 1) {
  const context = await browser.newContext({
    userAgent: "undici",
    viewport,
    deviceScaleFactor,
    serviceWorkers: "block",
    reducedMotion: "reduce"
  });
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem("lodging-v2-theme", selectedTheme);
  }, theme);
  await context.addCookies(cookies(jar, server.baseUrl));
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== server.baseUrl) {
      externalRequests.push({ method: route.request().method(), url: requestUrl.origin });
      await route.abort("blockedbyclient");
      return;
    }
    if (requestUrl.pathname === "/api/integration/insights/workspace") {
      const view = requestUrl.searchParams.get("view") || "";
      assert.ok(SURFACES.some((surface) => surface.id === view), `unexpected Stage 229 view ${view}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(readyWorkspace(view))
      });
      return;
    }
    await route.continue();
  });
  return context;
}

async function inspectPage(page, surface, theme) {
  return page.evaluate(({ expectedRoute, expectedTheme, expectedNav, selectors }) => {
    function rgb(value) {
      const match = String(value).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
      return match ? match.slice(1, 4).map(Number) : null;
    }
    function luminance(color) {
      const linear = color.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    }
    function background(element) {
      let current = element;
      while (current) {
        const value = getComputedStyle(current).backgroundColor;
        if (value && !/rgba?\(0[, ]+0[, ]+0(?:[, ]+0)?\)/.test(value) && value !== "transparent") return rgb(value);
        current = current.parentElement;
      }
      return expectedTheme === "dark" ? [16, 24, 40] : [255, 255, 255];
    }
    function contrast(element) {
      const foreground = rgb(getComputedStyle(element).color);
      const backdrop = background(element);
      if (!foreground || !backdrop) return null;
      const first = luminance(foreground);
      const second = luminance(backdrop);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }

    const root = document.querySelector('[data-testid="stage229-surface"]');
    const routeRoot = document.querySelector('[data-testid="stage227-page"]');
    const critical = root
      ? [...root.querySelectorAll("h2, strong, button, a, select, textarea")].filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      : [];
    const contrastRows = critical.map((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === "bold" ? 700 : 400);
      const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      return {
        tag: element.tagName,
        label: String(element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 60),
        ratio: contrast(element),
        fontSize,
        fontWeight,
        largeText,
        requiredRatio: largeText ? 3 : 4.5
      };
    }).filter((row) => Number.isFinite(row.ratio));
    const text = root?.textContent || "";
    const controls = [...document.querySelectorAll("a[href], button, input, select, textarea")].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && !element.disabled;
    });
    return {
      htmlLanguage: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      route: root?.getAttribute("data-stage229-route") || "",
      loadState: root?.getAttribute("data-stage229-load-state") || "",
      state: root?.getAttribute("data-stage229-state") || "",
      appRoute: routeRoot?.getAttribute("data-route-id") || "",
      navCount: document.querySelectorAll(".v2-nav-item").length,
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main").length,
      landmarkNavCount: document.querySelectorAll("nav").length,
      selectors: Object.fromEntries(selectors.map((id) => [id, Boolean(document.querySelector(`[data-testid="${id}"]`))])),
      scoreCount: root?.querySelectorAll("[data-score]").length || 0,
      reportScopeCount: root?.querySelectorAll("[data-scope]").length || 0,
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      focusableCount: controls.length,
      minimumCriticalContrast: contrastRows.length ? Math.min(...contrastRows.map((row) => row.ratio)) : 0,
      contrastSampleCount: contrastRows.length,
      contrastViolationCount: contrastRows.filter((row) => row.ratio + 0.01 < row.requiredRatio).length,
      contrastViolations: contrastRows.filter((row) => row.ratio + 0.01 < row.requiredRatio).slice(0, 10),
      forbidden: [
        /sourceUrl|sourceKey|rawEvidenceId|evidenceSnapshotId|internalFormula/i,
        /[A-Za-z]:\\(?:Users|Program Files|Windows)\\/,
        /(?:^|\s)\/(?:tmp|var|home)\//,
        /customer_db|company_master|tourism_data|[\\/]outputs[\\/]/i
      ].filter((pattern) => pattern.test(text)).map((pattern) => pattern.source),
      expected: { route: expectedRoute, theme: expectedTheme, nav: expectedNav }
    };
  }, {
    expectedRoute: surface.id,
    expectedTheme: theme,
    expectedNav: surface.navCount,
    selectors: surface.selectors
  });
}

async function keyboardFocus(page) {
  const focused = new Set();
  let visibleIndicators = 0;
  let maximumOutline = 0;
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    const row = await page.evaluate(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      const outline = style ? Number.parseFloat(style.outlineWidth) || 0 : 0;
      const boxShadow = style ? style.boxShadow : "none";
      return {
        key: active ? `${active.tagName}:${active.getAttribute("href") || active.getAttribute("data-testid") || active.textContent || ""}`.slice(0, 140) : "",
        outline,
        boxShadow,
        visible: outline >= 1 || (boxShadow !== "none" && boxShadow !== "")
      };
    });
    if (row.key) focused.add(row.key);
    if (row.visible) visibleIndicators += 1;
    maximumOutline = Math.max(maximumOutline, row.outline);
  }
  return { distinct: focused.size, visibleIndicators, maximumOutline };
}

function assertInspection(row, surface, label) {
  assert.equal(row.htmlLanguage, "ko", `${label}: html language`);
  assert.equal(row.theme, row.expected.theme, `${label}: active theme`);
  assert.equal(row.savedTheme, row.expected.theme, `${label}: persisted theme`);
  assert.equal(row.route, surface.id, `${label}: Stage 229 route`);
  assert.equal(row.appRoute, surface.id, `${label}: app route`);
  assert.equal(row.loadState, "ready", `${label}: workspace load state`);
  assert.equal(row.state, "ready", `${label}: workspace state`);
  assert.equal(row.navCount, surface.navCount, `${label}: role navigation`);
  assert.equal(row.h1Count, 1, `${label}: one h1`);
  assert.equal(row.mainCount, 1, `${label}: one main landmark`);
  assert.ok(row.landmarkNavCount >= 1, `${label}: navigation landmark`);
  assert.deepEqual(Object.values(row.selectors), Array(surface.selectors.length).fill(true), `${label}: required sections`);
  if (surface.id.includes("location")) assert.equal(row.scoreCount, 7, `${label}: seven location dimensions`);
  if (surface.id === "business-report") assert.equal(row.reportScopeCount, 4, `${label}: four report scopes`);
  assert.ok(row.overflowX <= 1, `${label}: horizontal overflow ${row.overflowX}px`);
  assert.ok(row.focusableCount >= 3, `${label}: focusable controls`);
  assert.ok(row.contrastSampleCount >= 8, `${label}: critical contrast samples`);
  assert.equal(row.contrastViolationCount, 0, `${label}: WCAG AA contrast ${JSON.stringify(row.contrastViolations)}`);
  assert.deepEqual(row.contrastViolations, [], `${label}: low-contrast critical content`);
  assert.deepEqual(row.forbidden, [], `${label}: internal/raw values visible`);
}

async function capture(browser, server, account, surface, viewport, theme, outputDirectory, externalRequests) {
  const context = await createContext(browser, server, account.jar, viewport, theme, externalRequests);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`console:${message.text()}`); });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === server.baseUrl) browserErrors.push(`requestfailed:${request.method()}:${new URL(request.url()).pathname}`);
  });
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid="stage229-surface"][data-stage229-route="${surface.id}"][data-stage229-load-state="ready"]`).waitFor({ timeout: 30_000 });
    for (const selector of surface.selectors) await page.locator(`[data-testid="${selector}"]`).first().waitFor();
    const inspection = await inspectPage(page, surface, theme);
    const filename = `${surface.id}-${viewport.id}-${theme}.png`;
    await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true });
    const keyboard = await keyboardFocus(page);
    assertInspection(inspection, surface, filename);
    assert.ok(keyboard.distinct >= 3, `${filename}: keyboard reach`);
    assert.ok(keyboard.visibleIndicators >= 2, `${filename}: visible focus indicator`);
    assert.deepEqual(browserErrors, [], `${filename}: browser errors`);
    return { surface: surface.id, viewport: viewport.id, theme, screenshot: filename, inspection, keyboard, browserErrors, passed: true };
  } finally {
    await context.close();
  }
}

async function specialCheck(browser, server, account, surface, id, viewport, deviceScaleFactor, externalRequests) {
  const context = await createContext(browser, server, account.jar, viewport, "light", externalRequests, deviceScaleFactor);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid="stage229-surface"][data-stage229-load-state="ready"]`).waitFor({ timeout: 30_000 });
    if (id === "zoom-200") {
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await page.waitForTimeout(50);
    }
    const inspection = await inspectPage(page, surface, "light");
    assertInspection(inspection, surface, `${id}:${surface.id}`);
    assert.deepEqual(browserErrors, [], `${id}:${surface.id}: browser errors`);
    const computedZoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
    if (id === "zoom-200") assert.equal(Number(computedZoom), 2, `${surface.id}: 200% CSS layout zoom`);
    return {
      id,
      surface: surface.id,
      viewport,
      deviceScaleFactor,
      zoomPercent: id === "zoom-200" ? 200 : 100,
      computedZoom,
      effectiveCssWidth: id === "zoom-200" ? viewport.width / 2 : viewport.width,
      overflowX: inspection.overflowX,
      minimumCriticalContrast: inspection.minimumCriticalContrast,
      passed: true
    };
  } finally {
    await context.close();
  }
}

async function assertReportToLocationNavigation(browser, server, account, externalRequests) {
  const context = await createContext(browser, server, account.jar, { width: 1440, height: 900 }, "light", externalRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}/app/report`, { waitUntil: "domcontentloaded" });
    const link = page.locator('[data-testid="stage229-report-location-link"]');
    await link.waitFor({ timeout: 30_000 });
    assert.equal(await link.getAttribute("href"), "/app/location", "report link must be same-origin and fixed");
    await Promise.all([
      page.waitForURL(`${server.baseUrl}/app/location`),
      link.click()
    ]);
    await page.locator('[data-testid="stage229-surface"][data-stage229-route="business-location"][data-stage229-load-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).origin, server.baseUrl);
    return { from: "/app/report", to: "/app/location", sameOrigin: true, passed: true };
  } finally {
    await context.close();
  }
}

async function main() {
  const nativeFetch = global.fetch;
  global.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", "undici");
    return nativeFetch(input, { ...init, headers });
  };
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui first");
  const trackedBefore = digestFile(REPORT_PATH);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stage229-visual-qa-"));
  const localReportPath = path.join(outputDirectory, "stage229_visual_qa.json");
  const dataDir = temporaryDirectory("stage229-visual-auth-");
  const integrationDataDir = temporaryDirectory("stage229-visual-fresh-");
  const guardLog = path.join(outputDirectory, "server-network-attempts.jsonl");
  let server;
  let browser;
  try {
    server = await startServer({
      port: await availablePort(),
      dataDir,
      integrationDataDir,
      uiFlag: true,
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      reliabilityFlag: true,
      locationCardFlag: true,
      businessReportFlag: true,
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture"
      })
    });
    const admin = await bootstrapAdmin(server, {
      username: "stage229-visual-admin",
      email: "stage229-visual-admin@example.test",
      password: "Stage229VisualAdmin!1"
    });
    const business = await signupBusiness(server, "stage229-visual");
    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader"] });
    const accounts = { admin, business };
    const externalRequests = [];
    const results = [];
    for (const surface of SURFACES) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          results.push(await capture(browser, server, accounts[surface.role], surface, viewport, theme, outputDirectory, externalRequests));
        }
      }
    }
    const special = [];
    for (const surface of SURFACES) {
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "minimum-320", { width: 320, height: 844 }, 1, externalRequests));
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "zoom-200", { width: 640, height: 900 }, 1, externalRequests));
    }
    const navigation = await assertReportToLocationNavigation(browser, server, business, externalRequests);
    const screenshots = fs.readdirSync(outputDirectory).filter((name) => name.endsWith(".png"));
    assert.equal(results.length, 12, "three surfaces x two viewports x two themes");
    assert.equal(screenshots.length, 12, "twelve screenshots");
    assert.deepEqual(externalRequests, [], "browser attempted an external request");
    assertZeroNetworkAttempts(guardLog);

    const report = {
      stage: 229,
      generatedAt: new Date().toISOString(),
      browser: path.basename(executablePath),
      artifactPolicy: "screenshots-default-to-os-temp; tracked-report-only-with---write-evidence",
      surfaces: SURFACES.map(({ id, path: pathname, role }) => ({ id, path: pathname, role })),
      surfaceCount: 3,
      conditionCombinationsPerSurface: 4,
      screenshotCount: 12,
      accessibility: {
        language: "ko",
        oneH1PerSurface: true,
        mainAndNavigationLandmarks: true,
        normalTextMinimumContrastRatio: 4.5,
        largeTextMinimumContrastRatio: 3,
        largeTextDefinition: "at-least-24px-or-at-least-18.66px-and-bold",
        contrastViolations: 0,
        keyboardFocusVisible: true
      },
      responsive: { minimumCssWidth: 320, zoomPercent: 200, overflowTolerancePixels: 1 },
      externalBrowserRequests: externalRequests.length,
      externalProviderCalls: 0,
      serverNetworkAttempts: 0,
      browserErrors: 0,
      rawOrInternalValuesVisible: false,
      reportToLocationNavigation: navigation,
      results,
      special,
      passed: true
    };
    fs.writeFileSync(localReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (WRITE_EVIDENCE) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      assert.ok(digestFile(REPORT_PATH), "tracked evidence report was not written");
    } else {
      assert.equal(digestFile(REPORT_PATH), trackedBefore, "default visual QA mutated tracked evidence");
    }
    console.log(`Stage 229 visual QA passed: 12 screenshots, 320px, 200% scale, report=${localReportPath}${WRITE_EVIDENCE ? ", tracked evidence written" : ""}`);
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
