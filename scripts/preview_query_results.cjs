"use strict";

// Local synthetic presentation only. No application server, accounts, data
// directories, collectors, queues or provider adapters are imported or called.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const { STATIC_FILES } = require("./preview_keyword_monthly_realcopy.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const ROOT = path.resolve(__dirname, ".."), NOW = "2026-11-15T03:00:00.000Z";
const KEYWORDS = ["가상 검수글램핑", "가상 검수캠핑"], MONTHS = ["2026-10", "2026-11"];
const modes = new Set(["ok", "html502", "json503", "broken", "unauthorized"]);
const sessions = new Set(["a", "b", "renewed", "expired"]);
let mode = "ok", apiReads = 0;
const source = {
  companies: [
    { companyId: "qa_sun", primaryName: "가상 솔빛글램핑", capacity: 5, capacitySource: "db_correction" },
    { companyId: "qa_moon", primaryName: "가상 달빛카라반", capacity: 8, capacitySource: "db_correction" }
  ], runs: [], observations: [], rankObservations: [], warnings: [], sourceDiagnostics: {}
};
for (const [keywordIndex, keyword] of KEYWORDS.entries()) for (const month of MONTHS) {
  const runId = `qa_${keywordIndex}_${month}`, collectedAt = `${month}-12T00:00:00.000Z`;
  source.runs.push({ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } });
  for (const day of [12, 19, 26]) for (const [index, company] of source.companies.entries()) for (const productType of ["lodging", "dayuse"]) {
    const supply = productType === "lodging" ? company.capacity : 2;
    const sold = productType === "dayuse" ? 1 : Math.min(supply, (month === "2026-10" ? 2 : 4) + index + keywordIndex);
    const phoneBookings = productType === "lodging" ? 1 : 0, publicBookings = sold - phoneBookings;
    const price = productType === "lodging" ? index ? 180000 : 150000 : 70000;
    source.observations.push({
      observationId: `${runId}_${company.companyId}_${day}_${productType}`, companyId: company.companyId,
      runId, keyword, productType, stayDate: `${month}-${day}`, collectedAt, inventoryEvidenceVersion: 4,
      supply, sold, publicBookings, phoneBookings, publicRevenue: publicBookings * price,
      phoneRevenue: phoneBookings * price, estimatedRevenue: sold * price, sharedDayUseExcluded: 0,
      explicitBlockedBookings: 0, phoneMissingPriceBookings: 0, partial: false, missing: false,
      unknownUnavailable: 0, dayUsePresence: "present", dayUseScheduleStatus: "requested",
      dayUseSharingStatus: "not_shared", capacityBasis: { count: supply, source: "db_correction" }
    });
  }
}
const catalog = { schemaVersion: 1, status: "available", currentDay: "2026-11-15", currentMonth: "2026-11", diagnostics: [],
  keywords: KEYWORDS.map(keyword => ({ keyword, stayMonths: MONTHS, collectionMonths: MONTHS })) };
function payload(query) {
  const selection = { keyword: query.get("keyword"), month: query.get("month"), cutoffDate: query.get("cutoffDate") };
  if (!KEYWORDS.includes(selection.keyword) || !MONTHS.includes(selection.month)
    || !/^2026-\d\d-\d\d$/.test(selection.cutoffDate || "") || selection.cutoffDate > "2026-11-15") throw Error("INVALID_SYNTHETIC_SELECTION");
  const request = { type: "keyword", targetId: selection.keyword, month: selection.month, cutoffDate: selection.cutoffDate };
  const snapshot = buildMonthlyReportSnapshot(request, source, NOW);
  const previous = buildMonthlyReportSnapshot(previousMonthlyReportRequest(request), source, NOW);
  snapshot.comparison = buildMonthlyComparison(snapshot, previous);
  snapshot.comparisonByProduct = { lodging: snapshot.comparison, dayuse: buildMonthlyComparison(snapshot, previous, { productType: "dayuse" }) };
  return { schemaVersion: 1, status: "available", request: selection, snapshot, diagnostics: [],
    provenance: { materializedAt: NOW, dataThrough: NOW, inputSha256: "a".repeat(64), originalFreshnessVerified: false,
      observationScope: "normalized_multirun", intermediateObservationsComplete: false },
    activity: { basis: "collection_month", rows: [], runInventoryComplete: false }, latestAttempt: null, lastSuccessfulAttempt: null };
}
const assets = new Map(Object.entries({ ...STATIC_FILES, "/admin-view-state.js": "web/admin-view-state.js" }).map(([url, relative]) => [url, {
  bytes: fs.readFileSync(path.join(ROOT, relative)), type: url.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"
}]));
const html = `<!doctype html><html lang="ko" data-theme-resolved="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>조회 조건 복원 · 가상 검수용</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/admin-theme.css">
<link rel="stylesheet" href="/monthly-reports.css"><link rel="stylesheet" href="/keyword-monthly-analysis.css"><link rel="stylesheet" href="/qa.css">
<script defer src="/admin-view-state.js"></script><script defer src="/keyword-monthly-benchmark.js"></script>
<script defer src="/keyword-monthly-dashboard-model.js"></script><script defer src="/keyword-monthly-charts.js"></script>
<script defer src="/keyword-monthly-analysis.js"></script><script defer src="/qa.js"></script>
</head><body class="role-admin"><main class="qa-shell">
<header class="qa-banner"><p>가상 검수용 · localhost 전용 · 실제 계정·운영 자료·수집기 연결 없음</p>
<h1>새로고침 후 조회 조건 복원</h1><p>키워드·숙박월·상품·업체를 고른 뒤 F5로 새로고침하세요. 저장되는 것은 마지막 적용 조건뿐이며 결과는 다시 조회합니다.</p>
<div class="qa-toolbar"><label>가상 세션 <select id="qa-session"><option value="a">가상 관리자 A · 같은 로그인</option>
<option value="b">가상 관리자 B · 다른 계정</option><option value="renewed">가상 관리자 A · 새 로그인</option>
<option value="expired">가상 관리자 A · 만료</option></select></label>
<label>검수 응답 <select id="qa-mode"><option value="ok">정상</option><option value="html502">HTML 502</option>
<option value="json503">JSON 503</option><option value="broken">깨진 JSON</option><option value="unauthorized">로그인 만료 401</option></select></label>
<button id="qa-refresh">동일 조건 재조회</button><button id="qa-reenter">화면 재진입</button>
<button id="qa-restore">가상 세션 복원</button><button id="qa-light">라이트</button><button id="qa-dark">다크</button></div>
<p id="qa-theme-status" role="status">검수 테마 · 라이트</p><p id="qa-status" role="status">가상 로그인 조건 확인 중</p><p id="qa-storage">결과 자료·인증값은 브라우저에 저장하지 않습니다.</p></header>
<div id="keywordMonthlyDashboard"></div></main></body></html>`;
const css = `body.role-admin{display:block;min-width:0;margin:0;background:var(--app-bg,#f7f8f5)}.qa-shell{max-width:1440px;margin:auto;padding:24px;min-width:0}.qa-banner{border:1px solid var(--border-subtle,#ccd9cf);border-radius:12px;padding:16px;margin-bottom:16px;background:var(--surface-card,#fff);color:var(--text-primary,#172235)}.qa-banner p{font-size:12px}.qa-banner h1{font-size:20px}.qa-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.qa-banner button,.qa-banner select{margin:4px;padding:8px;max-width:100%;border:1px solid var(--border-subtle,#ccd9cf);border-radius:6px;background:var(--surface-card,#fff);color:var(--text-primary,#172235)}@media(max-width:640px){.qa-shell{padding:12px}.qa-toolbar{display:grid;grid-template-columns:minmax(0,1fr)}.qa-banner label{display:grid;gap:3px}.qa-banner select{width:100%;margin:0}}`;
const js = `"use strict";(async()=>{
const params=new URLSearchParams(location.search),sessionChoice=['a','b','renewed','expired'].includes(params.get('session'))?params.get('session'):'a';
const applyTheme=theme=>{const resolved=theme==='dark'?'dark':'light';document.documentElement.setAttribute('data-theme-resolved',resolved);document.documentElement.style.colorScheme=resolved;for(const value of ['light','dark'])document.getElementById('qa-'+value).setAttribute('aria-pressed',String(value===resolved));document.getElementById('qa-theme-status').textContent='검수 테마 · '+(resolved==='dark'?'다크':'라이트');const url=new URL(location.href);url.searchParams.set('theme',resolved);history.replaceState(null,'',url);};
for(const theme of ['light','dark'])document.getElementById('qa-'+theme).addEventListener('click',()=>applyTheme(theme));
applyTheme(params.get('theme'));
const session={authenticated:sessionChoice!=='expired',role:'admin',username:sessionChoice==='b'?'synthetic-admin-b':'synthetic-admin-a',memberId:sessionChoice==='b'?'qa_member_b':'qa_member_a',sessionCreatedAt:sessionChoice==='renewed'?'2026-11-02T00:00:00.000Z':'2026-11-01T00:00:00.000Z',expiresAt:sessionChoice==='expired'?'2000-01-01T00:00:00.000Z':'2099-01-01T00:00:00.000Z'};
const authorized=()=>session.authenticated&&Date.parse(session.expiresAt)>Date.now(),status=document.getElementById('qa-status');
document.getElementById('qa-session').value=sessionChoice;
document.getElementById('qa-session').addEventListener('change',e=>{const url=new URL(location.href);url.searchParams.set('session',e.target.value);location.assign(url);});
const ready=await window.KeywordMonthlyAnalysis.configure(session);
const controller=window.KeywordMonthlyAnalysis.mount(document.getElementById('keywordMonthlyDashboard'),{autoStart:false,isAdmin:authorized,now:()=>Date.parse('${NOW}')});
window.qaController=controller;
const health=await(await fetch('/qa/status')).json();document.getElementById('qa-mode').value=health.mode;
status.textContent=authorized()?'가상 세션 '+sessionChoice+' · 조회 조건 복원 '+(ready?'사용 가능':'사용 불가 · 일반 조회 유지'):'만료된 가상 세션 · 조회 조건 삭제 · 자료 조회 중지';
document.getElementById('qa-mode').addEventListener('change',async e=>{await fetch('/qa/mode?value='+encodeURIComponent(e.target.value));status.textContent='가상 검수 응답: '+e.target.selectedOptions[0].textContent;});
document.getElementById('qa-refresh').addEventListener('click',()=>controller.refresh());
document.getElementById('qa-reenter').addEventListener('click',()=>{controller.pause();void controller.open();});
document.getElementById('qa-restore').addEventListener('click',async()=>{const valid=await window.KeywordMonthlyAnalysis.configure(session);status.textContent=valid?'같은 가상 세션 재확인 완료':'만료 또는 저장소 사용 불가';if(authorized())await controller.open();});
if(authorized())await controller.open();
})().catch(()=>{document.getElementById('qa-status').textContent='가상 검수 화면을 준비하지 못했습니다.';});`;
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
    if (mode === "html502") return send(502, "<!doctype html><h1>Local synthetic gateway failure</h1>", "text/html; charset=utf-8");
    if (mode === "json503") return send(503, { status: "needs_verification", snapshot: null, diagnostics: ["KEYWORD_MONTHLY_UNAVAILABLE"] });
    if (mode === "unauthorized") return send(401, { error: "Synthetic session expired" });
    if (mode === "broken") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{broken-json"); }
    try { return send(200, url.pathname.endsWith("/options") ? catalog : payload(url.searchParams)); }
    catch { return send(503, { code: "LOCAL_QA_INVALID_SELECTION" }); }
  }
  const rootQuery = url.pathname === "/" && [...url.searchParams.keys()].every(key => ["session", "theme"].includes(key)) && (!url.searchParams.has("session") || sessions.has(url.searchParams.get("session"))) && (!url.searchParams.has("theme") || ["light", "dark"].includes(url.searchParams.get("theme")));
  const asset = assets.get(url.pathname); if (!asset || url.search && !rootQuery) return send(404, { code: "NOT_FOUND" });
  res.writeHead(200, { "Content-Type": asset.type }); res.end(url.pathname === "/" && url.searchParams.get("theme") === "dark" ? html.replace('data-theme-resolved="light"', 'data-theme-resolved="dark"').replace('검수 테마 · 라이트', '검수 테마 · 다크') : asset.bytes);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, synthetic: true, providerCalls: 0, dataWrites: 0 })));
process.stdin.setEncoding("utf8"); process.stdin.on("data", text => { if (text.trim() === "quit") { server.close(); server.closeIdleConnections(); } });
