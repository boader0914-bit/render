"use strict";

const assert = require("node:assert/strict");
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
} = require("./test_support/stage230_test_helpers.cjs");

const SURFACES = Object.freeze([
  { id: "business-map", path: "/app/map", role: "business", navCount: 9, kind: "map" },
  { id: "business-ranking", path: "/app/ranking", role: "business", navCount: 9, kind: "ranking" },
  { id: "admin-map", path: "/admin/map", role: "admin", navCount: 13, kind: "map" },
  { id: "admin-ranking", path: "/admin/ranking", role: "admin", navCount: 13, kind: "ranking" }
]);
const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 }
]);
const THEMES = Object.freeze(["light", "dark"]);
const PUBLIC_REFS = new Set(["sel_visual_owner_001", "sel_visual_peer_002", "sel_visual_peer_003"]);

function findBrowserExecutable() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.FRESH_EXPLORATION_BROWSER_EXECUTABLE,
    process.env.STAGE231_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Fresh exploration visual QA requires Chrome or Edge");
  return executable;
}

function cookies(jar, baseUrl) {
  return Object.entries(jar).map(([name, value]) => ({ name, value, url: baseUrl }));
}

function timelinePoints() {
  return Array.from({ length: 30 }, (_unused, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    state: index === 8 ? "partial" : "ready",
    averagePrice: index === 15 ? null : 148000 + index * 1300,
    totalStock: 10,
    availableStock: Math.max(0, 8 - (index % 8)),
    otaExposed: index % 4 !== 0,
    dataMode: "live"
  }));
}

function explorationFixture(role, selectedRef = "") {
  const selectedNames = {
    sel_visual_owner_001: "해변 스테이",
    sel_visual_peer_002: "숲길 스테이",
    sel_visual_peer_003: "산들 스테이"
  };
  return {
    ok: true,
    metadata: {
      stage: 231,
      source: "v2-live-fresh-collection",
      providerMode: "disabled",
      collection: { enabled: false, configured: false, mode: "disabled" },
      exploration: { synthetic: false, dataMode: "live", windowDays: 30, axisEveryDays: 7 }
    },
    exploration: {
      state: "ready",
      scope: { role: role === "admin" ? "admin" : "b2b", dataMode: "live", synthetic: false, tenantCompanyId: "tenant_private_visual" },
      map: {
        state: "ready",
        markers: [
          { companyRef: "sel_visual_owner_001", companyId: "cmp_private_owner", companyName: "해변 스테이", regionLabel: "강원 홍천", latitude: 37.690, longitude: 127.880, coordinateConfidence: "high", freshness: { state: "fresh" }, dataMode: "live" },
          { companyRef: "sel_visual_peer_002", companyId: "cmp_private_peer_002", companyName: "숲길 스테이", regionLabel: "강원 홍천", latitude: 37.695, longitude: 127.885, coordinateConfidence: "medium", freshness: { state: "current" }, dataMode: "live" },
          { companyRef: "sel_visual_peer_003", companyId: "cmp_private_peer_003", companyName: "산들 스테이", regionLabel: "경남 통영", latitude: 34.850, longitude: 128.430, coordinateConfidence: "low", freshness: { state: "stale" }, dataMode: "live" }
        ],
        bounds: { north: 39.5, south: 33.0, east: 132.0, west: 124.0 },
        sourceAsset: { label: "승인 행정경계", version: "2026-01", license: "공공누리", sourceUrl: "https://forbidden.example/map.geojson" },
        rawPath: "C:\\private\\forbidden-map.geojson"
      },
      ranking: {
        state: "ready",
        condition: { label: "V2 네이버 노출 순위", targetDate: "2026-07-30", channel: "naver" },
        rows: [
          { companyRef: "sel_visual_peer_002", companyId: "cmp_private_peer_002", position: 2, observedRank: 4, companyName: "숲길 스테이", regionLabel: "강원 홍천", targetDate: "2026-07-30", channel: "naver", freshness: { state: "current" }, dataMode: "live" },
          { companyRef: "sel_visual_owner_001", companyId: "cmp_private_owner", position: 1, observedRank: 7, companyName: "해변 스테이", regionLabel: "강원 홍천", targetDate: "2026-07-30", channel: "naver", freshness: { state: "fresh" }, dataMode: "live" },
          { companyRef: "sel_visual_peer_003", companyId: "cmp_private_peer_003", position: 3, observedRank: 11, companyName: "산들 스테이", regionLabel: "경남 통영", targetDate: "2026-07-30", channel: "naver", freshness: { state: "stale" }, dataMode: "live" }
        ]
      },
      timeline: {
        state: "ready",
        from: "2026-07-01",
        to: "2026-07-30",
        axisEveryDays: 7,
        subjectLabel: selectedRef ? selectedNames[selectedRef] : "내 숙소",
        points: timelinePoints()
      }
    }
  };
}

async function contextFor(browser, server, account, surface, viewport, theme, externalRequests, mockRequests, boundaryFailure = false) {
  const context = await browser.newContext({
    userAgent: "node",
    viewport,
    serviceWorkers: "block",
    reducedMotion: "reduce"
  });
  await context.addInitScript((selectedTheme) => localStorage.setItem("lodging-v2-theme", selectedTheme), theme);
  await context.addCookies(cookies(account.jar, server.baseUrl));
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== server.baseUrl) {
      externalRequests.push({ method: route.request().method(), origin: requestUrl.origin, pathname: requestUrl.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (boundaryFailure && requestUrl.pathname === "/api/integration/fresh/map-boundary/kostat-2013-v1") {
      await route.fulfill({
        status: 503,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: "test-only boundary failure" })
      });
      return;
    }
    if (requestUrl.pathname === "/api/integration/fresh/exploration") {
      assert.equal(route.request().method(), "GET", "exploration mock accepts GET only");
      const keys = [...requestUrl.searchParams.keys()];
      assert.ok(keys.every((key) => key === "companyRef"), `unexpected exploration query keys: ${keys.join(",")}`);
      assert.equal(requestUrl.searchParams.has("companyId"), false, "internal companyId query is forbidden");
      const companyRef = requestUrl.searchParams.get("companyRef") || "";
      if (companyRef) assert.ok(PUBLIC_REFS.has(companyRef), `unexpected public companyRef ${companyRef}`);
      mockRequests.push({ surface: surface.id, role: surface.role, companyRef, pathname: `${requestUrl.pathname}${requestUrl.search}` });
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(explorationFixture(surface.role, companyRef))
      });
      return;
    }
    await route.continue();
  });
  return context;
}

async function inspectPage(page, surface, theme) {
  return page.evaluate(({ routeId, kind, selectedTheme, navCount }) => {
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
        if (value && value !== "transparent" && !/rgba?\(0[, ]+0[, ]+0(?:[, ]+0)?\)/.test(value)) return rgb(value);
        current = current.parentElement;
      }
      return selectedTheme === "dark" ? [25, 32, 27] : [255, 255, 255];
    }
    function contrast(element) {
      const foreground = rgb(getComputedStyle(element).color);
      const backdrop = background(element);
      if (!foreground || !backdrop) return null;
      const first = luminance(foreground);
      const second = luminance(backdrop);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
    const routeRoot = document.querySelector('[data-testid="stage227-page"]');
    const pageRoot = document.querySelector(`[data-testid="exploration-${kind}-page"]`);
    const toolbar = document.querySelector(".v2-exploration-toolbar");
    const status = toolbar?.querySelector('[role="status"]');
    const text = pageRoot?.textContent || "";
    const html = pageRoot?.innerHTML || "";
    const controls = [...document.querySelectorAll("a[href],button,input,select,textarea")].filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    });
    const critical = pageRoot ? [...pageRoot.querySelectorAll("h2,strong,button,label,select,summary")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    }) : [];
    const contrastRows = critical.map((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      return { ratio: contrast(element), required: large ? 3 : 4.5, tag: element.tagName, label: String(element.textContent || "").trim().slice(0, 60) };
    }).filter((row) => Number.isFinite(row.ratio));
    return {
      language: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      appRoute: routeRoot?.getAttribute("data-route-id") || "",
      workspaceState: routeRoot?.getAttribute("data-workspace-state") || "",
      live: pageRoot?.getAttribute("data-live") || "",
      navCount: document.querySelectorAll(".v2-nav-item").length,
      activeNavCount: document.querySelectorAll('.v2-nav-item[aria-current="page"]').length,
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main").length,
      navLandmarks: document.querySelectorAll("nav").length,
      providerViewOnly: Boolean(toolbar && /live history 보기 전용/.test(toolbar.textContent || "") && /view-only/.test(toolbar.textContent || "")),
      statusInteractiveCount: status?.querySelectorAll("a,button,input,select,textarea").length || 0,
      toolbarButtonCount: toolbar?.querySelectorAll("button").length || 0,
      timelinePresent: Boolean(document.querySelector('[data-testid="exploration-timeline"]')),
      priceSegmentCount: document.querySelectorAll('[data-series-segment="price"]').length,
      mapPresent: Boolean(document.querySelector('[data-testid="exploration-map"]')),
      mapLayer: document.querySelector(".v2-schematic-map__canvas")?.getAttribute("data-map-layer") || "",
      mapBoundaryState: document.querySelector(".v2-schematic-map__canvas")?.getAttribute("data-map-boundary-state") || "",
      mapBoundaryPresent: Boolean(document.querySelector('[data-testid="exploration-map-boundary"]')),
      mapBoundaryPathCount: document.querySelectorAll('[data-testid="exploration-map-boundary"] path').length,
      mapControlCount: document.querySelectorAll(".v2-exploration-map-controls button,.v2-exploration-map-controls select").length,
      clusterSizes: [...document.querySelectorAll(".v2-schematic-map__marker")].map((element) => Number(element.getAttribute("data-cluster-size") || 0)).sort((a, b) => a - b),
      mapListCount: document.querySelectorAll(".v2-exploration-map-list ol > li").length,
      rankingPresent: Boolean(document.querySelector('[data-testid="exploration-ranking"]')),
      rankingRowCount: document.querySelectorAll(".v2-exploration-ranking-list > li").length,
      rankingActionCount: [...document.querySelectorAll(".v2-exploration-ranking-list button")].filter((element) => /30일 보기/.test(element.textContent || "")).length,
      observedRankSeparated: /관측 순위/.test(text) && /7위/.test(text) && /4위/.test(text),
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      focusableCount: controls.length,
      contrastSamples: contrastRows.length,
      contrastViolations: contrastRows.filter((row) => row.ratio + 0.01 < row.required),
      forbidden: [
        /cmp_private|tenant_private|sel_visual|companyRef|companyId/i,
        /sourceUrl|rawPath|forbidden\.example/i,
        /[A-Za-z]:\\(?:Users|Program Files|Windows|private)\\/,
        /(?:^|\s)\/(?:tmp|var|home)\//
      ].filter((pattern) => pattern.test(`${text}\n${html}`)).map((pattern) => pattern.source),
      expected: { routeId, kind, selectedTheme, navCount }
    };
  }, { routeId: surface.id, kind: surface.kind, selectedTheme: theme, navCount: surface.navCount });
}

function assertInspection(row, surface, label) {
  assert.equal(row.language, "ko", `${label}: html language`);
  assert.equal(row.theme, row.expected.selectedTheme, `${label}: active theme`);
  assert.equal(row.savedTheme, row.expected.selectedTheme, `${label}: persisted theme`);
  assert.equal(row.appRoute, surface.id, `${label}: route`);
  assert.equal(row.workspaceState, "exploration", `${label}: exploration workspace`);
  assert.equal(row.live, "true", `${label}: live fresh projection`);
  assert.equal(row.navCount, surface.navCount, `${label}: role navigation`);
  assert.equal(row.activeNavCount, 1, `${label}: active navigation`);
  assert.equal(row.h1Count, 1, `${label}: one h1`);
  assert.equal(row.mainCount, 1, `${label}: one main`);
  assert.ok(row.navLandmarks >= 1, `${label}: navigation landmark`);
  assert.equal(row.providerViewOnly, true, `${label}: disabled provider must be labelled view-only`);
  assert.equal(row.statusInteractiveCount, 0, `${label}: status announcement contains an interactive control`);
  assert.equal(row.toolbarButtonCount, 1, `${label}: refresh action outside status`);
  assert.equal(row.timelinePresent, true, `${label}: timeline`);
  assert.equal(row.priceSegmentCount, 3, `${label}: chart gaps must create three price segments`);
  if (surface.kind === "map") {
    assert.equal(row.mapPresent, true, `${label}: map`);
    assert.equal(row.mapLayer, "companies", `${label}: default company layer`);
    assert.equal(row.mapBoundaryState, "ready", `${label}: verified boundary state`);
    assert.equal(row.mapBoundaryPresent, true, `${label}: administrative boundary SVG`);
    assert.ok(row.mapBoundaryPathCount > 250, `${label}: Polygon/MultiPolygon boundary paths`);
    assert.equal(row.mapControlCount, 4, `${label}: layer and filter controls`);
    assert.deepEqual(row.clusterSizes, [1, 2], `${label}: proximity cluster`);
    assert.equal(row.mapListCount, 3, `${label}: public map rows`);
  } else {
    assert.equal(row.rankingPresent, true, `${label}: ranking`);
    assert.equal(row.rankingRowCount, 3, `${label}: ranking rows`);
    assert.equal(row.rankingActionCount, 3, `${label}: company selection actions`);
    assert.equal(row.observedRankSeparated, true, `${label}: position and observed rank`);
  }
  assert.ok(row.overflowX <= 1, `${label}: horizontal overflow ${row.overflowX}px`);
  assert.ok(row.focusableCount >= 5, `${label}: focusable controls`);
  assert.ok(row.contrastSamples >= 8, `${label}: contrast sample count`);
  assert.deepEqual(row.contrastViolations, [], `${label}: WCAG AA ${JSON.stringify(row.contrastViolations.slice(0, 6))}`);
  assert.deepEqual(row.forbidden, [], `${label}: internal identifiers or raw paths visible`);
}

async function keyboardFocus(page) {
  const focused = new Set();
  let visibleIndicators = 0;
  let explorationControlsReached = 0;
  for (let index = 0; index < 32; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return {
        key: element ? `${element.tagName}:${element.getAttribute("href") || element.textContent || ""}`.slice(0, 120) : "",
        visible: Boolean(style && ((Number.parseFloat(style.outlineWidth) || 0) >= 1 || (style.boxShadow && style.boxShadow !== "none"))),
        exploration: Boolean(element?.closest(".v2-exploration-page,.v2-exploration-toolbar"))
      };
    });
    if (state.key) focused.add(state.key);
    if (state.visible) visibleIndicators += 1;
    if (state.exploration) explorationControlsReached += 1;
  }
  return { distinct: focused.size, visibleIndicators, explorationControlsReached };
}

async function capture(browser, server, account, surface, viewport, theme, outputDirectory, externalRequests, mockRequests) {
  const context = await contextFor(browser, server, account, surface, viewport, theme, externalRequests, mockRequests);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid="exploration-${surface.kind}-page"][data-live="true"]`).waitFor({ timeout: 30_000 });
    if (surface.kind === "map") await page.locator('[data-testid="exploration-map-boundary"]').waitFor({ timeout: 30_000 });
    const inspection = await inspectPage(page, surface, theme);
    const filename = `${surface.id}-${viewport.id}-${theme}.png`;
    await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true });
    const keyboard = await keyboardFocus(page);
    assertInspection(inspection, surface, filename);
    assert.ok(keyboard.distinct >= 5, `${filename}: keyboard reach`);
    assert.ok(keyboard.visibleIndicators >= 2, `${filename}: visible focus`);
    assert.ok(keyboard.explorationControlsReached >= 1, `${filename}: exploration controls unreachable by keyboard`);
    assert.deepEqual(errors, [], `${filename}: browser errors`);
    return { surface: surface.id, viewport: viewport.id, theme, screenshot: filename, inspection, keyboard, browserErrors: errors, passed: true };
  } finally {
    await context.close();
  }
}

async function specialCheck(browser, server, account, surface, id, viewport, externalRequests, mockRequests) {
  const context = await contextFor(browser, server, account, surface, viewport, "light", externalRequests, mockRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-testid="exploration-${surface.kind}-page"][data-live="true"]`).waitFor({ timeout: 30_000 });
    if (surface.kind === "map") await page.locator('[data-testid="exploration-map-boundary"]').waitFor({ timeout: 30_000 });
    if (id === "zoom-200") {
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await page.waitForTimeout(50);
    }
    const inspection = await inspectPage(page, surface, "light");
    assertInspection(inspection, surface, `${surface.id}:${id}`);
    const computedZoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
    if (id === "zoom-200") assert.equal(Number(computedZoom), 2, `${surface.id}: 200% zoom`);
    return { id, surface: surface.id, viewport, zoomPercent: id === "zoom-200" ? 200 : 100, computedZoom, overflowX: inspection.overflowX, passed: true };
  } finally {
    await context.close();
  }
}

async function mapInteractionFlow(browser, server, account, externalRequests, mockRequests) {
  const surface = SURFACES.find((row) => row.id === "business-map");
  const context = await contextFor(browser, server, account, surface, { width: 1440, height: 900 }, "light", externalRequests, mockRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="exploration-map"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="exploration-map-boundary"]').waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "좌표 신뢰도", exact: true }).click();
    assert.equal(await page.locator(".v2-schematic-map__canvas").getAttribute("data-map-layer"), "confidence", "confidence layer selection");
    assert.equal(await page.locator(".v2-schematic-map__marker[data-coordinate-confidence]").count(), 2, "confidence layer marker styling");
    assert.equal(await page.locator('.v2-schematic-map__marker[data-coordinate-confidence="mixed"]').count(), 1, "clustered confidence must be mixed");
    const filters = page.locator(".v2-exploration-map-controls select");
    await filters.nth(0).selectOption({ label: "강원 홍천" });
    assert.equal(await page.locator(".v2-exploration-map-list ol > li").count(), 2, "region filter");
    assert.equal(await page.locator('.v2-schematic-map__marker[data-cluster-size="2"]').count(), 1, "filtered cluster");
    await filters.nth(1).selectOption("high");
    assert.equal(await page.locator(".v2-exploration-map-list ol > li").count(), 1, "confidence filter");
    assert.equal(await page.locator('.v2-schematic-map__marker[data-coordinate-confidence="high"]').count(), 1, "high-confidence filtered marker");
    await filters.nth(1).selectOption("all");
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === "/api/integration/fresh/exploration" && new URL(candidate.url()).searchParams.has("companyRef"));
    await page.locator(".v2-exploration-map-list ol > li button").nth(1).click();
    const selectedRequest = await request;
    const selectedUrl = new URL(selectedRequest.url());
    assert.equal(selectedUrl.searchParams.get("companyRef"), "sel_visual_peer_002", "map companyRef selection");
    assert.equal(selectedUrl.searchParams.has("companyId"), false, "map must not query companyId");
    await page.getByRole("heading", { name: /숲길 스테이 · 30일 가격·재고·OTA 관측/ }).waitFor();
    assert.equal(page.url(), `${server.baseUrl}/app/map`, "map selection keeps route");
    assert.doesNotMatch(await page.locator("main").innerHTML(), /sel_visual|cmp_private|companyRef|companyId/i, "selection ref must not enter DOM");
    return { layer: "confidence", region: "강원 홍천", confidence: "high", selectedCompanyRef: "opaque-and-not-rendered", selectedRequestUsesCompanyId: false, passed: true };
  } finally {
    await context.close();
  }
}

async function rankingInteractionFlow(browser, server, account, externalRequests, mockRequests) {
  const surface = SURFACES.find((row) => row.id === "admin-ranking");
  const context = await contextFor(browser, server, account, surface, { width: 1440, height: 900 }, "dark", externalRequests, mockRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="exploration-ranking"]').waitFor({ timeout: 30_000 });
    const row = page.locator(".v2-exploration-ranking-list > li").filter({ hasText: "숲길 스테이" });
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === "/api/integration/fresh/exploration" && new URL(candidate.url()).searchParams.has("companyRef"));
    await row.getByRole("button", { name: "30일 보기" }).click();
    const selectedUrl = new URL((await request).url());
    assert.equal(selectedUrl.searchParams.get("companyRef"), "sel_visual_peer_002", "ranking companyRef selection");
    assert.equal(selectedUrl.searchParams.has("companyId"), false, "ranking must not query companyId");
    await page.getByRole("heading", { name: /숲길 스테이 · 30일 가격·재고·OTA 관측/ }).waitFor();
    assert.equal(page.url(), `${server.baseUrl}/admin/ranking`, "ranking selection keeps route");
    assert.doesNotMatch(await page.locator("main").innerHTML(), /sel_visual|cmp_private|companyRef|companyId/i, "selection ref must not enter DOM");
    return { position: 2, observedRank: 4, selectedCompanyRef: "opaque-and-not-rendered", selectedRequestUsesCompanyId: false, passed: true };
  } finally {
    await context.close();
  }
}

async function boundaryFailureFlow(browser, server, account, externalRequests, mockRequests) {
  const surface = SURFACES.find((row) => row.id === "business-map");
  const context = await contextFor(
    browser,
    server,
    account,
    surface,
    { width: 1440, height: 900 },
    "light",
    externalRequests,
    mockRequests,
    true
  );
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    const failure = page.locator('.v2-schematic-map__boundary-state[data-boundary-state="error"]');
    await failure.waitFor({ timeout: 30_000 });
    assert.match(await failure.textContent(), /행정경계를 불러오지 못해.*부분 보기/);
    assert.equal(await page.locator('[data-testid="exploration-map-boundary"]').count(), 0, "failed boundary must not render a fallback SVG");
    assert.ok(await page.locator(".v2-schematic-map__marker").count() > 0, "live markers remain visible in the explicit partial view");
    assert.equal(await page.locator(".v2-schematic-map__canvas").getAttribute("data-map-boundary-state"), "error");
    return { state: "error", fallbackBoundaryRendered: false, liveMarkersPreserved: true, passed: true };
  } finally {
    await context.close();
  }
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui before fresh exploration visual QA");
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-exploration-visual-qa-"));
  const reportPath = path.join(outputDirectory, "fresh_exploration_visual_qa.json");
  const dataDir = temporaryDirectory("fresh-exploration-visual-auth-");
  const integrationDataDir = temporaryDirectory("fresh-exploration-visual-store-");
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
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_MAP_RANKING_ENABLED: "true"
      })
    });
    const admin = await bootstrapAdmin(server, {
      username: "fresh-exploration-visual-admin",
      email: "fresh-exploration-visual-admin@example.test",
      password: "FreshExplorationVisualAdmin!1"
    });
    const business = await signupBusiness(server, "fresh-exploration-visual");
    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader"] });
    const accounts = { admin, business };
    const externalRequests = [];
    const mockRequests = [];
    const results = [];
    for (const surface of SURFACES) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          results.push(await capture(browser, server, accounts[surface.role], surface, viewport, theme, outputDirectory, externalRequests, mockRequests));
        }
      }
    }
    const special = [];
    for (const surface of SURFACES) {
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "minimum-320", { width: 320, height: 844 }, externalRequests, mockRequests));
      special.push(await specialCheck(browser, server, accounts[surface.role], surface, "zoom-200", { width: 640, height: 900 }, externalRequests, mockRequests));
    }
    const mapInteraction = await mapInteractionFlow(browser, server, business, externalRequests, mockRequests);
    const rankingInteraction = await rankingInteractionFlow(browser, server, admin, externalRequests, mockRequests);
    const boundaryFailure = await boundaryFailureFlow(browser, server, business, externalRequests, mockRequests);
    const screenshots = fs.readdirSync(outputDirectory).filter((filename) => filename.endsWith(".png"));
    assert.equal(results.length, 16, "four surfaces x two viewports x two themes");
    assert.equal(screenshots.length, 16, "sixteen screenshots");
    assert.deepEqual(externalRequests, [], "browser attempted an external network request");
    assertZeroNetworkAttempts(guardLog);
    assert.ok(mockRequests.length >= 26, "all visual and interaction exploration requests must use the test-only mock");
    assert.ok(mockRequests.every((request) => !request.pathname.includes("companyId=")), "mock request contained internal companyId");
    const selectedRequests = mockRequests.filter((request) => request.companyRef);
    assert.equal(selectedRequests.length, 2, "map and ranking selected-company requery count");

    const report = {
      stage: 231,
      generatedAt: new Date().toISOString(),
      browser: path.basename(executablePath),
      artifactPolicy: "screenshots-and-report-in-os-temp-only",
      surfaces: SURFACES.map(({ id, path: pathname, role }) => ({ id, path: pathname, role })),
      surfaceCount: 4,
      conditionCombinationsPerSurface: 4,
      screenshotCount: 16,
      responsive: { minimumCssWidth: 320, zoomPercent: 200, overflowTolerancePixels: 1 },
      accessibility: { language: "ko", oneH1PerSurface: true, mainAndNavigationLandmarks: true, keyboardFocusVisible: true, contrastViolations: 0 },
      providerMode: "disabled-provider-live-history-view-only",
      testOnlyMockResponses: mockRequests.length,
      selectedCompanyRequeries: selectedRequests.length,
      externalBrowserRequests: 0,
      actualProviderCalls: 0,
      serverNetworkAttempts: 0,
      rawOrInternalValuesVisible: false,
      mapInteraction,
      rankingInteraction,
      boundaryFailure,
      results,
      special,
      passed: true
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Fresh exploration visual QA passed: 16 screenshots, verified Polygon/MultiPolygon boundary, 320px, 200% zoom, cluster/filter/companyRef selection, external network 0, report=${reportPath}`);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
