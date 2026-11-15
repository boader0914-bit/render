"use strict";

// Synthetic loopback-only presentation QA. Never imports the application,
// touches a data directory, or connects to a collector/provider/account.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const { STATIC_FILES } = require("./preview_keyword_monthly_realcopy.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const ROOT = path.resolve(__dirname, ".."), NOW = "2026-11-15T03:00:00.000Z", KEYWORD = "검수글램핑";
const modes = new Set(["ok", "html502", "json503", "broken", "unauthorized"]);
let mode = "ok", apiReads = 0;
const source = { companies: [{ companyId: "qa_company", primaryName: "가상 검수업체", capacity: 5, capacitySource: "db_correction" }],
  runs: [], observations: [], rankObservations: [], warnings: [], sourceDiagnostics: {} };
for (const [month, date, sold] of [["2026-10", "2026-10-12", 2], ["2026-11", "2026-11-12", 4]]) {
  const runId = `qa_${month}`, collectedAt = `${date}T00:00:00Z`;
  source.runs.push({ id: runId, keyword: KEYWORD, collectedAt, collectionQuality: { status: "complete" } });
  source.observations.push({ observationId: runId, companyId: "qa_company", runId, keyword: KEYWORD, productType: "lodging", stayDate: date, collectedAt,
    inventoryEvidenceVersion: 4, supply: 5, sold, publicBookings: sold, phoneBookings: 0, publicRevenue: sold * 150000, phoneRevenue: 0,
    estimatedRevenue: sold * 150000, sharedDayUseExcluded: 0, explicitBlockedBookings: 0, phoneMissingPriceBookings: 0,
    partial: false, missing: false, unknownUnavailable: 0, dayUsePresence: "absent", dayUseScheduleStatus: "not_requested", dayUseSharingStatus: "not_shared",
    capacityBasis: { count: 5, source: "db_correction" } });
}
const catalog = { schemaVersion: 1, status: "available", currentDay: "2026-11-15", currentMonth: "2026-11", diagnostics: [],
  keywords: [{ keyword: KEYWORD, stayMonths: ["2026-10", "2026-11"], collectionMonths: ["2026-10", "2026-11"] }] };
function payload(query) {
  const selection = { keyword: query.get("keyword"), month: query.get("month"), cutoffDate: query.get("cutoffDate") };
  const request = { type: "keyword", targetId: KEYWORD, month: selection.month, cutoffDate: selection.cutoffDate };
  const snapshot = buildMonthlyReportSnapshot(request, source, NOW), previous = buildMonthlyReportSnapshot(previousMonthlyReportRequest(request), source, NOW);
  snapshot.comparison = buildMonthlyComparison(snapshot, previous);
  snapshot.comparisonByProduct = { lodging: snapshot.comparison, dayuse: buildMonthlyComparison(snapshot, previous, { productType: "dayuse" }) };
  return { schemaVersion: 1, status: "available", request: selection, snapshot, diagnostics: [],
    provenance: { materializedAt: NOW, dataThrough: NOW, inputSha256: "a".repeat(64), originalFreshnessVerified: false, observationScope: "selected_only", intermediateObservationsComplete: false },
    activity: { rows: [], runInventoryComplete: false }, latestAttempt: null, lastSuccessfulAttempt: null };
}
const assets = new Map(Object.entries({ ...STATIC_FILES, "/admin-view-state.js": "web/admin-view-state.js" }).map(([url, relative]) => [url, {
  bytes: fs.readFileSync(path.join(ROOT, relative)), type: url.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"
}]));
const html = `<!doctype html><html lang="ko" data-theme-resolved="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>조회 안정화 검수 · 가상 자료</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/admin-theme.css"><link rel="stylesheet" href="/monthly-reports.css"><link rel="stylesheet" href="/keyword-monthly-analysis.css"><link rel="stylesheet" href="/qa.css"><script defer src="/admin-view-state.js"></script><script defer src="/keyword-monthly-benchmark.js"></script><script defer src="/keyword-monthly-dashboard-model.js"></script><script defer src="/keyword-monthly-charts.js"></script><script defer src="/keyword-monthly-analysis.js"></script><script defer src="/qa.js"></script></head><body class="role-admin"><main class="qa-shell"><header class="qa-banner"><p>로컬 기능 검수 · 가상 자료 · 운영 연결 없음</p><h1>조회 실패와 저장 자료 유지</h1><label>검수 응답 <select id="qa-mode"><option value="ok">정상</option><option value="html502">HTML 502</option><option value="json503">JSON 503</option><option value="broken">깨진 JSON</option><option value="unauthorized">로그인 만료 401</option></select></label><button id="qa-refresh">동일 조건 재조회</button><button id="qa-reenter">화면 재진입</button><button id="qa-light">라이트</button><button id="qa-dark">다크</button><p id="qa-status">정상 응답</p></header><div id="keywordMonthlyDashboard"></div></main></body></html>`;
const css = `body.role-admin{display:block;min-width:0;margin:0;background:var(--app-bg,#f7f8f5)}.qa-shell{max-width:1440px;margin:auto;padding:24px;min-width:0}.qa-banner{border:1px solid var(--border-subtle,#ccd9cf);border-radius:12px;padding:16px;margin-bottom:16px;background:var(--surface-card,#fff);color:var(--text-primary,#172235)}.qa-banner p{font-size:12px}.qa-banner h1{font-size:20px}.qa-banner button,.qa-banner select{margin:4px;padding:8px;border:1px solid var(--border-subtle,#ccd9cf);border-radius:6px;background:var(--surface-card,#fff);color:var(--text-primary,#172235)}@media(max-width:640px){.qa-shell{padding:12px}}`;
const js = `"use strict";(()=>{const controller=window.KeywordMonthlyAnalysis.mount(document.getElementById('keywordMonthlyDashboard'),{autoStart:false,isAdmin:()=>true,now:()=>Date.parse('${NOW}'),accountKey:'local_qa'});window.qaController=controller;document.getElementById('qa-mode').addEventListener('change',async e=>{await fetch('/qa/mode?value='+encodeURIComponent(e.target.value));document.getElementById('qa-status').textContent='검수 응답: '+e.target.selectedOptions[0].textContent;});document.getElementById('qa-refresh').addEventListener('click',()=>controller.refresh());document.getElementById('qa-reenter').addEventListener('click',()=>{controller.pause();void controller.open();});for(const theme of ['light','dark'])document.getElementById('qa-'+theme).addEventListener('click',()=>document.documentElement.setAttribute('data-theme-resolved',theme));void controller.open();})();`;
for (const [url, bytes, type] of [["/", html, "text/html; charset=utf-8"], ["/qa.css", css, "text/css; charset=utf-8"], ["/qa.js", js, "text/javascript; charset=utf-8"]]) assets.set(url, { bytes: Buffer.from(bytes), type });
const server = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'");
  const send = (status, value, type = "application/json; charset=utf-8") => { res.writeHead(status, { "Content-Type": type }); res.end(type.startsWith("application/json") ? JSON.stringify(value) : value); };
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) return send(403, { code: "LOCAL_ONLY" });
  if (req.method !== "GET") return send(405, { code: "GET_ONLY" });
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/qa/mode") { const value = url.searchParams.get("value"); if (!modes.has(value)) return send(400, { code: "INVALID_QA_MODE" }); mode = value; return send(200, { mode }); }
  if (url.pathname === "/qa/status") return send(200, { mode, apiReads, synthetic: true, providerCalls: 0, dataWrites: 0 });
  if (["/api/keyword-monthly/options", "/api/keyword-monthly"].includes(url.pathname)) {
    apiReads++;
    if (mode === "html502") return send(502, "<!doctype html><h1>Local QA gateway failure</h1>", "text/html; charset=utf-8");
    if (mode === "json503") return send(503, { status: "needs_verification", snapshot: null, diagnostics: ["KEYWORD_MONTHLY_UNAVAILABLE"] });
    if (mode === "unauthorized") return send(401, { error: "Local QA session expired" });
    if (mode === "broken") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{broken-json"); }
    try { return send(200, url.pathname.endsWith("/options") ? catalog : payload(url.searchParams)); }
    catch { return send(503, { code: "LOCAL_QA_INVALID_SELECTION" }); }
  }
  const asset = assets.get(url.pathname); if (!asset || url.search) return send(404, { code: "NOT_FOUND" });
  res.writeHead(200, { "Content-Type": asset.type }); res.end(asset.bytes);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, synthetic: true, providerCalls: 0, dataWrites: 0 })));
process.stdin.setEncoding("utf8"); process.stdin.on("data", text => { if (text.trim() === "quit") { server.close(); server.closeIdleConnections(); } });
