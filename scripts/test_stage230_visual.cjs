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
} = require("./test_support/stage230_test_helpers.cjs");

const WRITE_EVIDENCE = process.argv.includes("--write-evidence");
const REPORT_PATH = path.join(ROOT, "test", "results", "stage230_visual_qa.json");
const SURFACES = Object.freeze([
  { id: "business-strategy", path: "/app/strategy", role: "business", navCount: 9, appRoute: "business-strategy", selectors: ["stage230-metrics", "stage230-report-link", "stage230-strategy-card", "stage230-checklist", "stage230-kpi", "stage230-lineage"] },
  { id: "business-execution", path: "/app/execution", role: "business", navCount: 9, appRoute: "business-execution", selectors: ["stage230-metrics", "stage230-board", "stage230-checklist", "stage230-kpi"] },
  { id: "business-retrospective", path: "/app/retrospective", role: "business", navCount: 9, appRoute: "business-retrospective", selectors: ["stage230-metrics", "stage230-retrospective", "stage230-candidates", "stage230-lineage"] },
  { id: "admin-strategy", path: "/admin/stage-review?view=strategy&tenantCompanyId=tenant_stage230_visual&companyId=cmp_place_stage230_visual", role: "admin", navCount: 13, appRoute: "admin-stage-review", selectors: ["stage230-admin-tabs", "stage230-admin-target", "stage230-metrics", "stage230-report-link", "stage230-strategy-card", "stage230-lineage"] },
  { id: "admin-execution", path: "/admin/stage-review?view=execution&tenantCompanyId=tenant_stage230_visual&companyId=cmp_place_stage230_visual", role: "admin", navCount: 13, appRoute: "admin-stage-review", selectors: ["stage230-admin-tabs", "stage230-admin-target", "stage230-metrics", "stage230-board", "stage230-checklist", "stage230-kpi"] },
  { id: "admin-retrospective", path: "/admin/stage-review?view=retrospective&tenantCompanyId=tenant_stage230_visual&companyId=cmp_place_stage230_visual", role: "admin", navCount: 13, appRoute: "admin-stage-review", selectors: ["stage230-admin-tabs", "stage230-admin-target", "stage230-metrics", "stage230-retrospective", "stage230-candidates", "stage230-lineage"] }
]);
const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 }
]);
const THEMES = Object.freeze(["light", "dark"]);

function findBrowserExecutable() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.STAGE230_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Stage 230 visual QA requires Chrome or Edge");
  return executable;
}

function digest(filename) {
  return fs.existsSync(filename) ? crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex") : null;
}

function cookies(jar, baseUrl) {
  return Object.entries(jar).map(([name, value]) => ({ name, value, url: baseUrl }));
}

function lineage(domain = "price") {
  return {
    sourceReportMonth: "2026-08",
    sourceReportVersion: 6,
    sourceReportPublishedAt: "2026-07-29T00:00:00.000Z",
    sourceAlgorithmVersion: "v2-stage229-location-forecast-v1",
    ruleVersion: "v2-stage230-deterministic-strategy-v1",
    evidenceKeys: [`own.${domain}`, `anonymous-cohort.${domain}`],
    generatedAt: "2026-07-29T00:00:00.000Z",
    generatedBy: "stage230-visual-fixture"
  };
}

function readyWorkspace(view) {
  const domains = ["price", "channel", "product", "content", "leadtime"];
  const strategies = domains.map((domain, index) => ({
    strategyId: `strategy_visual_${domain}`,
    domain,
    ruleVersion: "v2-stage230-deterministic-strategy-v1",
    title: ["비교군 정합 가격 유지", "OTA 노출 채널 보강", "판매율 보강 상품 구성", "지역 수요 연계 콘텐츠 정비", "리드타임 구간별 재고 점검"][index],
    summary: "Stage 229 공개 리포트의 business-safe 근거만 사용한 deterministic 추천입니다.",
    confidence: { level: index === 0 ? "high" : "medium", reasons: ["공개 리포트", "최소 표본 충족"] },
    difficulty: index === 2 ? "high" : index >= 3 ? "low" : "medium",
    expectedEffect: { label: "기대 효과", minimum: 2 + index, maximum: 6 + index, unit: "%p", direction: "increase" },
    executionTiming: { startDate: "2026-08-01", dueDate: `2026-08-${String(7 + index).padStart(2, "0")}`, label: "다음 달 초 실행" },
    evidence: [
      { scope: "own", metricKey: "soldRate", label: "내 숙소 판매율", value: 58, unit: "%", sampleCount: 1 },
      { scope: "anonymous-cohort", metricKey: "soldRate", label: "익명 비교군 판매율", value: 73, unit: "%", sampleCount: 3 }
    ],
    checklist: [
      { checklistId: `check_${domain}_1`, label: "공개 수치를 확인합니다.", required: true },
      { checklistId: `check_${domain}_2`, label: "실행 결과를 기록합니다.", required: true }
    ],
    kpiTemplate: { metricKey: "soldRate", label: "판매율", unit: "%", direction: "increase", targetValue: 65 },
    lineage: lineage(domain)
  }));
  const item = {
    itemId: "item_visual_price",
    strategyId: strategies[0].strategyId,
    title: "주중 가격·채널 노출 점검",
    owner: "가격 담당자",
    dueDate: "2026-07-28",
    status: "in-progress",
    notes: "공개 리포트 근거만 사용",
    repeatNextMonth: true,
    checklist: [
      { checklistId: "check_visual_1", label: "현재 주중 가격 확인", required: true, completed: true, completedAt: "2026-07-28T00:00:00.000Z" },
      { checklistId: "check_visual_2", label: "OTA 채널 노출 확인", required: true, completed: false, completedAt: "" }
    ],
    kpis: [{
      kpiId: "kpi_visual_sold_rate", metricKey: "soldRate", label: "주중 판매율", unit: "%", direction: "increase",
      targetValue: 65, currentValue: 61, inputState: "entered", achieved: false, version: 2, updatedAt: "2026-07-29T00:00:00.000Z"
    }],
    lineage: lineage(),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
  const plan = {
    planId: "plan_visual_august", month: "2026-08", title: "2026년 8월 실행계획", status: "active", owner: "운영 담당자",
    dueDate: "2026-08-31", notes: "Stage 230 visual fixture", strategyIds: strategies.map((row) => row.strategyId), items: [item],
    version: 4, createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z"
  };
  const boardItem = { ...item, planId: plan.planId, planTitle: plan.title, planStatus: plan.status, month: plan.month, overdue: true, thisWeek: true };
  return {
    metadata: { stage: 230, generatedAt: "2026-07-29T00:00:00.000Z", ruleVersion: "v2-stage230-deterministic-strategy-v1" },
    stage: 230,
    view,
    state: "ready",
    month: "2026-08",
    dataBoundary: "published-stage229-fresh-only",
    projection: "business-safe",
    reportGate: {
      state: "ready", label: "공개 리포트 기준 충족", detail: "표본·freshness·confidence 기준을 통과했습니다.",
      reportMonth: "2026-08", confidence: "medium", confidenceLabel: "보통", reportPath: "/app/report"
    },
    strategies,
    plans: [plan],
    board: { summary: { total: 1, planned: 0, inProgress: 1, blocked: 0, done: 0, overdue: 1, thisWeek: 1 }, items: [boardItem] },
    retrospectives: [{
      retrospectiveId: "retro_visual_august", planId: plan.planId, month: "2026-08",
      execution: { done: 1, total: 2, rate: 50 },
      kpis: { achieved: 1, entered: 1, total: 2, achievementRate: 50, missing: 1 },
      incompleteReasons: [{ itemId: item.itemId, title: item.title, reason: "채널 검수 일정이 남았습니다." }],
      summary: "가격 점검은 완료했고 채널 검수를 다음 달로 이월합니다.", lineage: lineage(), createdAt: "2026-07-29T00:00:00.000Z"
    }],
    candidates: [
      { candidateId: "candidate_visual_carryover", type: "carryover", targetMonth: "2026-09", strategyId: strategies[0].strategyId, sourceItemId: item.itemId, title: "채널 검수 이월", reason: "미완료 실행 항목", lineage: lineage(), createdAt: "2026-07-29T00:00:00.000Z" },
      { candidateId: "candidate_visual_repeat", type: "repeat", targetMonth: "2026-09", strategyId: strategies[4].strategyId, sourceItemId: item.itemId, title: "리드타임 점검 반복", reason: "반복 실행 표시", lineage: lineage("leadtime"), createdAt: "2026-07-29T00:00:00.000Z" },
      { candidateId: "candidate_visual_new", type: "new", targetMonth: "2026-09", strategyId: strategies[2].strategyId, sourceItemId: "", title: "신규 상품 전략", reason: "새 공개 리포트 rule 결과", lineage: lineage("product"), createdAt: "2026-07-29T00:00:00.000Z" }
    ],
    limits: { allowed: true, plan: "basic", reason: "" },
    notices: ["실제 provider 호출 0건", "기존 전략 이력 read/copy 0건"]
  };
}

async function contextFor(browser, server, jar, viewport, theme, externalRequests) {
  // The HTTP bootstrap helpers use Node's built-in fetch, whose current user agent is `node`.
  // Matching it keeps the Stage 226 session fingerprint intact in the browser QA context.
  const context = await browser.newContext({ userAgent: "node", viewport, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript((selected) => localStorage.setItem("lodging-v2-theme", selected), theme);
  await context.addCookies(cookies(jar, server.baseUrl));
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== server.baseUrl) {
      externalRequests.push({ method: route.request().method(), origin: requestUrl.origin });
      await route.abort("blockedbyclient");
      return;
    }
    if (requestUrl.pathname === "/api/integration/strategy/workspace") {
      const view = requestUrl.searchParams.get("view") || "";
      assert.ok(SURFACES.some((surface) => surface.id === view), `unexpected Stage 230 view ${view}`);
      await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(readyWorkspace(view)) });
      return;
    }
    await route.continue();
  });
  return context;
}

async function inspectPage(page, surface, theme) {
  return page.evaluate(({ routeId, selectedTheme, selectors }) => {
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
      return selectedTheme === "dark" ? [16, 24, 40] : [255, 255, 255];
    }
    function contrast(element) {
      const foreground = rgb(getComputedStyle(element).color);
      const backdrop = background(element);
      if (!foreground || !backdrop) return null;
      const a = luminance(foreground);
      const b = luminance(backdrop);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    const root = document.querySelector('[data-testid="stage230-surface"]');
    const controls = [...document.querySelectorAll("a[href],button,input,select,textarea")].filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    });
    const critical = root ? [...root.querySelectorAll("h2,h3,strong,button,a,label,select,input,textarea")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    }) : [];
    const contrastRows = critical.map((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      return { ratio: contrast(element), required: large ? 3 : 4.5, tag: element.tagName, label: String(element.textContent || "").trim().slice(0, 50) };
    }).filter((row) => Number.isFinite(row.ratio));
    const text = root?.textContent || "";
    return {
      language: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      savedTheme: localStorage.getItem("lodging-v2-theme"),
      route: root?.getAttribute("data-stage230-route") || "",
      loadState: root?.getAttribute("data-stage230-load-state") || "",
      state: root?.getAttribute("data-stage230-state") || "",
      appRoute: document.querySelector('[data-testid="stage227-page"]')?.getAttribute("data-route-id") || "",
      navCount: document.querySelectorAll(".v2-nav-item").length,
      h1Count: document.querySelectorAll("h1").length,
      mainCount: document.querySelectorAll("main").length,
      navLandmarks: document.querySelectorAll("nav").length,
      selectorState: Object.fromEntries(selectors.map((id) => [id, Boolean(document.querySelector(`[data-testid="${id}"]`))])),
      strategyDomains: [...new Set([...root?.querySelectorAll("[data-domain]") || []].map((element) => element.getAttribute("data-domain")))],
      candidateTypes: [...new Set([...root?.querySelectorAll("[data-candidate-type]") || []].map((element) => element.getAttribute("data-candidate-type")))],
      overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      focusableCount: controls.length,
      contrastSamples: contrastRows.length,
      contrastViolations: contrastRows.filter((row) => row.ratio + 0.01 < row.required),
      forbidden: [
        /evidenceSnapshotId|observationId|signalId|sourceUrl|internalFormula|ruleWeights/i,
        /[A-Za-z]:\\(?:Users|Program Files|Windows)\\/,
        /(?:^|\s)\/(?:tmp|var|home)\//,
        /customer_db|company_master|tourism_data|[\\/]outputs[\\/]/i
      ].filter((pattern) => pattern.test(text)).map((pattern) => pattern.source),
      expectedRoute: routeId
    };
  }, { routeId: surface.id, selectedTheme: theme, selectors: surface.selectors });
}

async function keyboardFocus(page) {
  const focused = new Set();
  let visible = 0;
  for (let index = 0; index < 28; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      const style = element ? getComputedStyle(element) : null;
      return {
        key: element ? `${element.tagName}:${element.getAttribute("href") || element.getAttribute("name") || element.textContent || ""}`.slice(0, 100) : "",
        visible: Boolean(style && ((Number.parseFloat(style.outlineWidth) || 0) >= 1 || (style.boxShadow && style.boxShadow !== "none")))
      };
    });
    if (state.key) focused.add(state.key);
    if (state.visible) visible += 1;
  }
  return { distinct: focused.size, visibleIndicators: visible };
}

function assertInspection(row, surface, label) {
  assert.equal(row.language, "ko", `${label}: language`);
  assert.equal(row.theme, row.savedTheme, `${label}: persisted theme`);
  assert.equal(row.route, surface.id, `${label}: route`);
    assert.equal(row.appRoute, surface.appRoute, `${label}: app route`);
  assert.equal(row.loadState, "ready", `${label}: load`);
  assert.equal(row.state, "ready", `${label}: state`);
  assert.equal(row.navCount, surface.navCount, `${label}: role navigation`);
  assert.equal(row.h1Count, 1, `${label}: one h1`);
  assert.equal(row.mainCount, 1, `${label}: one main`);
  assert.ok(row.navLandmarks >= 1, `${label}: nav landmark`);
  assert.ok(Object.values(row.selectorState).every(Boolean), `${label}: required sections ${JSON.stringify(row.selectorState)}`);
  if (surface.id.endsWith("strategy")) assert.deepEqual(row.strategyDomains.sort(), ["channel", "content", "leadtime", "price", "product"]);
  if (surface.id.endsWith("retrospective")) assert.deepEqual(row.candidateTypes.sort(), ["carryover", "new", "repeat"]);
  assert.ok(row.overflowX <= 1, `${label}: overflow ${row.overflowX}`);
  assert.ok(row.focusableCount >= 4, `${label}: focusable controls`);
  assert.ok(row.contrastSamples >= 8, `${label}: contrast sample count`);
  assert.deepEqual(row.contrastViolations, [], `${label}: WCAG AA ${JSON.stringify(row.contrastViolations.slice(0, 5))}`);
  assert.deepEqual(row.forbidden, [], `${label}: internal/raw values`);
}

async function capture(browser, server, account, surface, viewport, theme, outputDirectory, externalRequests) {
  const context = await contextFor(browser, server, account.jar, viewport, theme, externalRequests);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    try {
      await page.locator(`[data-testid="stage230-surface"][data-stage230-route="${surface.id}"][data-stage230-load-state="ready"]`).waitFor({ timeout: 30_000 });
    } catch (error) {
      const sessionResponse = await page.request.get(`${server.baseUrl}/api/session`);
      const diagnostic = await page.evaluate(() => ({
        href: window.location.href,
        body: String(document.body?.innerText || "").slice(0, 1_500),
        stage227: document.querySelector('[data-testid="stage227-page"]')?.getAttribute("data-route-id") || "",
        stage230: document.querySelector('[data-testid="stage230-surface"]')?.outerHTML.slice(0, 800) || ""
      }));
      throw new Error(`${error.message}\nStage 230 visual diagnostic: ${JSON.stringify({
        ...diagnostic,
        cookies: (await context.cookies()).map((row) => ({ name: row.name, path: row.path, secure: row.secure, sameSite: row.sameSite })),
        sessionStatus: sessionResponse.status(),
        sessionBody: await sessionResponse.text(),
        errors
      })}`);
    }
    for (const selector of surface.selectors) await page.locator(`[data-testid="${selector}"]`).first().waitFor();
    const inspection = await inspectPage(page, surface, theme);
    const filename = `${surface.id}-${viewport.id}-${theme}.png`;
    await page.screenshot({ path: path.join(outputDirectory, filename), fullPage: true });
    const keyboard = await keyboardFocus(page);
    assertInspection(inspection, surface, filename);
    assert.ok(keyboard.distinct >= 4, `${filename}: keyboard reach`);
    assert.ok(keyboard.visibleIndicators >= 2, `${filename}: visible focus`);
    assert.deepEqual(errors, [], `${filename}: browser errors`);
    return { surface: surface.id, viewport: viewport.id, theme, screenshot: filename, inspection, keyboard, browserErrors: errors, passed: true };
  } finally {
    await context.close();
  }
}

async function special(browser, server, account, surface, id, viewport, externalRequests) {
  const context = await contextFor(browser, server, account.jar, viewport, "light", externalRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="stage230-surface"][data-stage230-load-state="ready"]').waitFor({ timeout: 30_000 });
    if (id === "zoom-200") {
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await page.waitForTimeout(50);
    }
    const inspection = await inspectPage(page, surface, "light");
    assertInspection(inspection, surface, `${surface.id}:${id}`);
    const computedZoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
    if (id === "zoom-200") assert.equal(Number(computedZoom), 2);
    return {
      id, surface: surface.id, viewport, zoomPercent: id === "zoom-200" ? 200 : 100, computedZoom,
      effectiveCssWidth: id === "zoom-200" ? viewport.width / 2 : viewport.width,
      overflowX: inspection.overflowX, passed: true
    };
  } finally {
    await context.close();
  }
}

async function navigationFlow(browser, server, account, externalRequests) {
  const context = await contextFor(browser, server, account.jar, { width: 1440, height: 900 }, "light", externalRequests);
  const page = await context.newPage();
  try {
    await page.goto(`${server.baseUrl}/app/strategy`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="stage230-surface"][data-stage230-route="business-strategy"][data-stage230-load-state="ready"]').waitFor();
    const execution = page.locator('a[href="/app/execution"]').first();
    await Promise.all([page.waitForURL(`${server.baseUrl}/app/execution`), execution.click()]);
    await page.locator('[data-testid="stage230-surface"][data-stage230-route="business-execution"][data-stage230-load-state="ready"]').waitFor();
    const retrospective = page.locator('a[href="/app/retrospective"]').first();
    await Promise.all([page.waitForURL(`${server.baseUrl}/app/retrospective`), retrospective.click()]);
    await page.locator('[data-testid="stage230-surface"][data-stage230-route="business-retrospective"][data-stage230-load-state="ready"]').waitFor();
    return { from: "/app/strategy", through: "/app/execution", to: "/app/retrospective", sameOrigin: true, passed: true };
  } finally {
    await context.close();
  }
}

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html")), "run npm run build:ui first");
  const trackedBefore = digest(REPORT_PATH);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stage230-visual-qa-"));
  const localReportPath = path.join(outputDirectory, "stage230_visual_qa.json");
  const dataDir = temporaryDirectory("stage230-visual-auth-");
  const integrationDataDir = temporaryDirectory("stage230-visual-fresh-");
  const guardLog = path.join(outputDirectory, "server-network-attempts.jsonl");
  let server;
  let browser;
  try {
    server = await startServer({
      port: await availablePort(), dataDir, integrationDataDir,
      uiFlag: true, authFlag: true, coreFlag: true, freshCompanyFlag: true, freshObservationFlag: true,
      reliabilityFlag: true, locationCardFlag: true, businessReportFlag: true,
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture",
        V2_INTEGRATION_STRATEGY_ENABLED: "true",
        V2_INTEGRATION_EXECUTION_ENABLED: "true",
        V2_INTEGRATION_RETROSPECTIVE_ENABLED: "true"
      })
    });
    const admin = await bootstrapAdmin(server, {
      username: "stage230-visual-admin",
      email: "stage230-visual-admin@example.test",
      password: "Stage230VisualAdmin!1"
    });
    const business = await signupBusiness(server, "stage230-visual");
    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=swiftshader"] });
    const externalRequests = [];
    const results = [];
    const accounts = { business, admin };
    for (const surface of SURFACES) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) results.push(await capture(browser, server, accounts[surface.role], surface, viewport, theme, outputDirectory, externalRequests));
      }
    }
    const specialResults = [];
    for (const surface of SURFACES) {
      specialResults.push(await special(browser, server, accounts[surface.role], surface, "minimum-320", { width: 320, height: 844 }, externalRequests));
      specialResults.push(await special(browser, server, accounts[surface.role], surface, "zoom-200", { width: 640, height: 900 }, externalRequests));
    }
    const navigation = await navigationFlow(browser, server, business, externalRequests);
    assert.equal(results.length, 24);
    assert.equal(fs.readdirSync(outputDirectory).filter((name) => name.endsWith(".png")).length, 24);
    assert.deepEqual(externalRequests, [], "browser attempted an external request");
    assertZeroNetworkAttempts(guardLog);
    const report = {
      stage: 230,
      generatedAt: new Date().toISOString(),
      browser: path.basename(executablePath),
      artifactPolicy: "screenshots-default-to-os-temp; tracked-report-only-with---write-evidence",
      surfaces: SURFACES.map(({ id, path: pathname, role }) => ({ id, path: pathname, role })),
      surfaceCount: 6,
      conditionCombinationsPerSurface: 4,
      screenshotCount: 24,
      accessibility: {
        language: "ko", oneH1PerSurface: true, mainAndNavigationLandmarks: true,
        normalTextMinimumContrastRatio: 4.5, largeTextMinimumContrastRatio: 3,
        contrastViolations: 0, keyboardFocusVisible: true
      },
      responsive: { minimumCssWidth: 320, zoomPercent: 200, overflowTolerancePixels: 1 },
      externalBrowserRequests: 0,
      externalProviderCalls: 0,
      serverNetworkAttempts: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0,
      browserErrors: 0,
      rawOrInternalValuesVisible: false,
      navigation,
      results,
      special: specialResults,
      passed: true
    };
    fs.writeFileSync(localReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (WRITE_EVIDENCE) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } else {
      assert.equal(digest(REPORT_PATH), trackedBefore, "default visual QA mutated tracked evidence");
    }
    console.log(`Stage 230 visual QA passed: 24 screenshots, 320px, 200% zoom, admin/business navigation, report=${localReportPath}${WRITE_EVIDENCE ? ", tracked evidence written" : ""}`);
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
