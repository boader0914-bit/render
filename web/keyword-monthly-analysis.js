(function (root) {
  "use strict";
  const instances = new WeakMap();
  const controllers = new Set();
  const benchmarkModule = typeof module !== "undefined" && module.exports ? require("./keyword-monthly-benchmark.js") : null;
  const dashboardModule = typeof module !== "undefined" && module.exports ? require("./keyword-monthly-dashboard-model.js") : null;
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const PRODUCTS = { lodging: { label: "숙박", unit: "실·박", dailyUnit: "실" }, dayuse: { label: "데이유즈", unit: "회", dailyUnit: "회" } };
  const known = value => typeof value === "number" && Number.isFinite(value);
  const number = value => known(value) ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value) : "—";
  const rate = value => known(value) ? `${number(value * 100)}%` : "—";
  const money = value => known(value) ? `${number(value)}원` : "—";
  const dateValid = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const kstDay = now => new Date(Number(now) + 9 * 3600000).toISOString().slice(0, 10);
  const monthEnd = month => { const [year, part] = month.split("-").map(Number); return new Date(Date.UTC(year, part, 0)).toISOString().slice(0, 10); };
  const SELECTION_KEY = "staydatalab:keyword-monthly-selection:v1", SELECTION_LIMIT = 12 * 1024;
  const safeText = (value, maximum, empty = true) => typeof value === "string" && (empty || value.length > 0)
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  function storedSelection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !safeText(value.keyword, 300, false) || !MONTH.test(value.month || "") || !dateValid(value.cutoffDate)
      || !["auto", "explicit"].includes(value.cutoffMode) || !Object.hasOwn(PRODUCTS, value.product)
      || typeof value.companyId !== "string" || value.companyId !== "" && !/^[A-Za-z0-9_:-]{1,180}$/.test(value.companyId)
      || !safeText(value.listQuery, 200) || !Number.isSafeInteger(value.listPage) || value.listPage < 1 || value.listPage > 10000
      || !["list", "detail"].includes(value.mobileView)) return null;
    const expanded = {};
    if (!value.expanded || typeof value.expanded !== "object" || Array.isArray(value.expanded) || Object.keys(value.expanded).length > 32) return null;
    for (const [key, item] of Object.entries(value.expanded)) {
      if (!safeText(key, 200, false) || !/^(chart|support):/.test(key) || typeof item !== "boolean") return null;
      expanded[key] = item;
    }
    return { keyword: value.keyword, month: value.month, cutoffDate: value.cutoffDate, cutoffMode: value.cutoffMode,
      product: value.product, companyId: value.companyId, listQuery: value.listQuery, listPage: value.listPage,
      mobileView: value.mobileView, expanded };
  }
  // Only the last applied view inputs survive a reload. Results, customer facts,
  // response bodies, credentials and the raw account identity never enter storage.
  function createSelectionStorage({ storage, now = Date.now, digestTimeoutMs = 250, digest = async value => {
    const hash = await root.crypto.subtle.digest("SHA-256", new root.TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  } } = {}) {
    if (!Number.isSafeInteger(digestTimeoutMs) || digestTimeoutMs < 1 || digestTimeoutMs > 1000) throw new TypeError("Invalid selection scope timeout");
    let identity = null, scope = null, expiresAt = 0, revision = 0, lastWritten = null;
    const clear = () => { lastWritten = null; try { storage?.removeItem(SELECTION_KEY); } catch {} };
    function sessionIdentity(session, { customerView = false } = {}) {
      const owner = session?.memberId || session?.username;
      if (!safeText(session?.sessionCreatedAt, 64, false) || !safeText(session?.expiresAt, 64, false)) return null;
      const created = Date.parse(session?.sessionCreatedAt || ""), expires = Date.parse(session?.expiresAt || ""), at = Number(now());
      return session?.authenticated === true && session.role === "admin" && !customerView && safeText(owner, 180, false)
        && Number.isFinite(at) && Number.isFinite(created) && created <= at + 60000 && Number.isFinite(expires) && expires > at && expires > created
        ? JSON.stringify([session.role, owner, session.sessionCreatedAt]) : null;
    }
    const matches = (session, flags) => identity !== null && identity === sessionIdentity(session, flags) && scope !== null && expiresAt > Number(now());
    function revoke() { revision++; identity = scope = null; expiresAt = 0; clear(); }
    async function configure(session, flags) {
      const next = sessionIdentity(session, flags), ticket = ++revision;
      if (!next) { revoke(); return false; }
      if (identity && identity !== next) clear();
      if (identity === next && scope) { expiresAt = Date.parse(session.expiresAt); return true; }
      identity = next; scope = null; expiresAt = Date.parse(session.expiresAt); lastWritten = null;
      let encoded, timer = null;
      try {
        // Session scoping must not turn a disabled/stalled browser facility
        // into a login/bootstrap wait. A miss only disables remembered inputs.
        if (typeof root.setTimeout !== "function" || typeof root.clearTimeout !== "function") throw Error();
        encoded = await Promise.race([Promise.resolve().then(() => digest(next)), new Promise(resolve => { timer = root.setTimeout(() => resolve(null), digestTimeoutMs); })]);
      } catch { encoded = null; }
      finally { if (timer !== null) { try { root.clearTimeout(timer); } catch {} } }
      if (ticket !== revision || identity !== next) return false;
      if (typeof encoded !== "string" || !/^[a-f0-9]{64}$/.test(encoded) || expiresAt <= Number(now())) { revoke(); return false; }
      scope = encoded;
      // A new account/session cannot reuse the previous session's view inputs.
      read(); return true;
    }
    function authorized() { if (scope && expiresAt <= Number(now())) revoke(); return Boolean(scope); }
    function read() {
      if (!authorized()) return null;
      try {
        const raw = storage?.getItem(SELECTION_KEY);
        if (!raw) return null;
        if (raw.length > SELECTION_LIMIT || new root.TextEncoder().encode(raw).byteLength > SELECTION_LIMIT) { clear(); return null; }
        const entry = JSON.parse(raw), age = Number(now()) - entry?.storedAt;
        const value = storedSelection(entry?.selection);
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some(key => !["schema", "scope", "storedAt", "selection"].includes(key))
          || Object.keys(entry.selection || {}).some(key => !["keyword", "month", "cutoffDate", "cutoffMode", "product", "companyId", "listQuery", "listPage", "mobileView", "expanded"].includes(key))
          || entry.schema !== 1 || entry.scope !== scope || !Number.isFinite(age) || age < 0 || age > 12 * 3600000 || !value) { clear(); return null; }
        lastWritten = JSON.stringify(value); return value;
      } catch { clear(); return null; }
    }
    function write(value) {
      if (!authorized()) return false;
      try {
        const checked = storedSelection(value); if (!checked) return false;
        const next = JSON.stringify(checked);
        if (next === lastWritten) return true;
        const raw = JSON.stringify({ schema: 1, scope, storedAt: Number(now()), selection: checked });
        if (raw.length > SELECTION_LIMIT || new root.TextEncoder().encode(raw).byteLength > SELECTION_LIMIT || typeof storage?.setItem !== "function") return false;
        storage.setItem(SELECTION_KEY, raw); lastWritten = next; return true;
      } catch { return false; }
    }
    return { configure, matches, read, write, clear, revoke };
  }
  let sessionStorage; try { sessionStorage = root.sessionStorage; } catch {}
  const selectionStorage = createSelectionStorage({ storage: sessionStorage });
  const defaultCutoff = (month, today) => MONTH.test(month || "") && monthEnd(month) < today ? monthEnd(month) : today;
  const dataThroughDay = (catalog, keyword, month) => { const provenance = catalog?.keywords?.find(row => row.keyword === keyword)?.provenanceByMonth?.[month] || catalog?.provenance; return dateValid(provenance?.dataThrough) ? provenance.dataThrough : Number.isFinite(Date.parse(provenance?.dataThrough || "")) ? kstDay(Date.parse(provenance.dataThrough)) : catalog?.currentDay || kstDay(Date.now()); };
  const cutoffFor = (catalog, keyword, month) => { const recorded = catalog?.keywords.find(row => row.keyword === keyword)?.defaultCutoffs?.[month]; return dateValid(recorded) ? recorded : [defaultCutoff(month, catalog.currentDay), dataThroughDay(catalog, keyword, month)].sort()[0]; };
  const phaseLabel = (month, currentMonth) => !MONTH.test(month || "") ? "자료 선택 전" : month > currentMonth ? "사전 관측" : month === currentMonth ? "누적 중" : "마감된 월";
  function message(value) {
    const code = typeof value === "string" ? value : value?.code;
    if (code === "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT") {
      return "일부 키워드·숙박월의 저장 자료는 갱신 확인이 필요합니다.";
    }
    return typeof value === "string" ? value : value?.message || value?.reason || code || "확인 필요";
  }
  const hasDiagnostic = (rows, code) => rows.some(value => value === code || value?.code === code);
  const timeLabel = value => dateValid(value) ? value : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "미확인";
  const REFRESH_STATES = ["queued", "deferred", "running", "complete", "needs_verification"];
  const refreshCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const refreshCounts = counts => counts && typeof counts === "object" && !Array.isArray(counts)
    && Object.values(counts).every(value => refreshCount(value) !== null)
    ? Object.fromEntries(REFRESH_STATES.map(key => [key, refreshCount(counts[key])])) : null;
  const refreshVersion = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
  const refreshReason = value => value === null || typeof value === "string" && /^[A-Z][A-Z0-9_]{1,119}$/.test(value);
  function refreshHistory(value) {
    if (!value || value.schemaVersion !== 1 || value.readOnly !== true || value.currentScopeFreshnessVerified !== false
      || value.originalJournalRowsChanged !== false || value.retryAuthorized !== false || value.invalidRows !== 0
      || typeof value.allRowsCoverage !== "boolean" || !Array.isArray(value.groups) || value.groups.length > 128) return null;
    const fields = ["rowsExamined", "historicalRows", "reviewedRows", "sameEventLaterCompleted", "priorExactComplete", "notCovered", "unknown"];
    if (fields.some(key => refreshCount(value[key]) === null)) return null;
    const groups = [];
    for (const row of value.groups) {
      if (!row || !refreshVersion(row.version) || !REFRESH_STATES.includes(row.status) || row.status === "complete" || !refreshReason(row.reasonCode)
        || ["count", "sameEventLaterCompleted", "priorExactComplete", "notCovered", "unknown"].some(key => refreshCount(row[key]) === null)
        || row.count !== row.sameEventLaterCompleted + row.priorExactComplete + row.notCovered + row.unknown) return null;
      groups.push(Object.fromEntries(["version", "status", "reasonCode", "count", "sameEventLaterCompleted", "priorExactComplete", "notCovered", "unknown"].map(key => [key, row[key]])));
    }
    if (groups.reduce((sum, row) => sum + row.count, 0) !== value.reviewedRows
      || value.reviewedRows !== value.sameEventLaterCompleted + value.priorExactComplete + value.notCovered + value.unknown) return null;
    const dense = refreshCounts(value.currentVersionCounts), versions = value.historicalCountsByVersion;
    if (!dense || REFRESH_STATES.some(key => dense[key] === null) || !versions || typeof versions !== "object" || Array.isArray(versions)
      || Object.keys(versions).length > 32) return null;
    const historicalCountsByVersion = {};
    for (const [version, counts] of Object.entries(versions)) {
      const checked = refreshCounts(counts);
      if (!refreshVersion(version) || !checked || REFRESH_STATES.some(key => checked[key] === null)) return null;
      historicalCountsByVersion[version] = checked;
    }
    if (["sameEventLaterCompleted", "priorExactComplete", "notCovered", "unknown"].some(key => groups.reduce((sum, row) => sum + row[key], 0) !== value[key])) return null;
    const historicalTotal = Object.values(historicalCountsByVersion).reduce((sum, counts) => sum + REFRESH_STATES.reduce((n, key) => n + counts[key], 0), 0);
    const historicalComplete = Object.values(historicalCountsByVersion).reduce((sum, counts) => sum + counts.complete, 0);
    if (historicalTotal !== value.historicalRows || historicalTotal - historicalComplete !== value.reviewedRows
      || historicalTotal + REFRESH_STATES.reduce((sum, key) => sum + dense[key], 0) !== value.rowsExamined) return null;
    return { ...Object.fromEntries(fields.map(key => [key, value[key]])), allRowsCoverage: value.allRowsCoverage, groups,
      currentVersionCounts: dense, historicalCountsByVersion };
  }
  const sumRefreshCounts = (versions, key) => versions && Object.values(versions).every(counts => refreshCount(counts?.[key]) !== null)
    ? Object.values(versions).reduce((sum, counts) => sum + counts[key], 0) : null;
  function refreshReasonLabel(code) {
    if (code?.endsWith("OTHER_PREPARATION_PRESENT")) return "다른 준비 작업이 있어 보류";
    if (code?.endsWith("SOURCE_COPY_BOUND")) return "당시 자료 복사 용량 한도";
    if (code === "ISOLATION_SOCKET_OR_UNSAFE_STDIO") return "격리 실행의 입출력 검증 미통과";
    if (code?.endsWith("WORKER_LOCKED")) return "작업 잠금 보호로 보류";
    if (code?.endsWith("COLLECTION_BUSY")) return "수집 보호·예약 간격 때문에 대기";
    if (code?.endsWith("POSTPROCESS_NOT_COMPLETE")) return "수집 자료의 DB 반영 대기";
    return "사유 확인 필요";
  }
  function normalizeOptions(value = {}, today = kstDay(Date.now())) {
    const currentDay = dateValid(value.currentDay) ? value.currentDay : today;
    const keywords = [], seen = new Set();
    for (const row of Array.isArray(value.keywords) ? value.keywords : []) {
      const keyword = typeof row?.keyword === "string" ? row.keyword : "";
      if (!keyword || keyword.length > 300 || seen.has(keyword)) continue;
      seen.add(keyword);
      const cutoffs = values => Object.fromEntries(Object.entries(values && typeof values === "object" ? values : {}).filter(([month, day]) => MONTH.test(month) && dateValid(day) && day <= currentDay));
      keywords.push({ keyword, stayMonths: [...new Set((Array.isArray(row.stayMonths) ? row.stayMonths : []).filter(month => typeof month === "string" && MONTH.test(month)))].sort().reverse(),
        collectionMonths: [...new Set((Array.isArray(row.collectionMonths) ? row.collectionMonths : []).filter(month => typeof month === "string" && MONTH.test(month)))].sort().reverse(),
        defaultCutoffs: cutoffs(row.defaultCutoffs), supportedCutoffs: row.supportedCutoffs && typeof row.supportedCutoffs === "object" ? cutoffs(row.supportedCutoffs) : null,
        provenanceByMonth: Object.fromEntries(Object.entries(row.provenanceByMonth || {}).filter(([month, item]) => MONTH.test(month) && item && typeof item === "object" && Number.isFinite(Date.parse(item.dataThrough || ""))).map(([month, item]) => [month, { dataThrough: item.dataThrough }])) });
    }
    const fresh = value.refreshStatus;
    const historicalReview = refreshHistory(fresh?.historicalReview);
    const reviewedCounts = historicalReview?.allRowsCoverage === true ? historicalReview : null;
    const historicalCountsByVersion = reviewedCounts?.historicalCountsByVersion || (fresh?.historicalCountsByVersion
      && typeof fresh.historicalCountsByVersion === "object" && !Array.isArray(fresh.historicalCountsByVersion)
      && Object.keys(fresh.historicalCountsByVersion).length <= 32
      && Object.entries(fresh.historicalCountsByVersion).every(([version, counts]) => refreshVersion(version) && refreshCounts(counts))
      ? Object.fromEntries(Object.entries(fresh.historicalCountsByVersion).map(([version, counts]) => [version, refreshCounts(counts)])) : null);
    const refreshStatus = fresh && typeof fresh === "object" ? { status: fresh.status === "needs_verification" ? "needs_verification" : fresh.status === "available" ? "available" : "unknown",
      started: typeof fresh.started === "boolean" ? fresh.started : null, initialized: typeof fresh.initialized === "boolean" ? fresh.initialized : null,
      closed: typeof fresh.closed === "boolean" ? fresh.closed : null, counts: refreshCounts(fresh.counts),
      currentVersionCounts: reviewedCounts?.currentVersionCounts || refreshCounts(fresh.currentVersionCounts), historicalCountsByVersion, historicalReview,
      historicalNeedsVerification: refreshCount(fresh.historicalNeedsVerification),
      currentVersionReasonCounts: Array.isArray(fresh.currentVersionReasonCounts) && fresh.currentVersionReasonCounts.length <= 128
        && fresh.currentVersionReasonCounts.every(row => row && REFRESH_STATES.includes(row.status) && refreshReason(row.reasonCode) && refreshCount(row.count) !== null)
        ? fresh.currentVersionReasonCounts.map(row => ({ status: row.status, reasonCode: row.reasonCode, count: row.count })) : null,
      hasRuntimeError: fresh.errorCode !== null,
      cleanupNeedsVerification: fresh.cleanup != null && fresh.cleanup.status !== "complete" } : null;
    return { status: value.status || "needs_verification", currentDay, currentMonth: MONTH.test(value.currentMonth || "") ? value.currentMonth : currentDay.slice(0, 7), keywords, provenance: value.provenance || null, diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [], refreshStatus };
  }
  function metricView(value = {}) {
    value = value && typeof value === "object" ? value : {};
    const observed = known(value.coveredCompanyDays) && value.coveredCompanyDays > 0;
    return { ...value, supply: observed && known(value.supply) ? value.supply : null, sold: observed && known(value.sold) ? value.sold : null,
      publicBookings: observed && known(value.publicBookings) ? value.publicBookings : null, phoneBookings: observed && known(value.phoneBookings) ? value.phoneBookings : null,
      reservationRate: observed && known(value.reservationRate) ? value.reservationRate : null,
      estimatedRevenue: observed && known(value.estimatedRevenue) ? value.estimatedRevenue : null,
      publicRevenue: observed && known(value.publicRevenue) ? value.publicRevenue : null, phoneRevenue: observed && known(value.phoneRevenue) ? value.phoneRevenue : null,
      coverageRate: known(value.coverageRate) ? value.coverageRate : null, observed };
  }
  function calendarCells(month, daily, product) {
    if (!MONTH.test(month || "") || !PRODUCTS[product]) return [];
    const [year, part] = month.split("-").map(Number), firstWeekday = new Date(Date.UTC(year, part - 1, 1)).getUTCDay();
    const days = Number(monthEnd(month).slice(8)), byDate = new Map((Array.isArray(daily) ? daily : []).map(row => [row.date, row]));
    return Array.from({ length: Math.ceil((firstWeekday + days) / 7) * 7 }, (_, index) => {
      const day = index - firstWeekday + 1;
      if (day < 1 || day > days) return null;
      const date = `${month}-${String(day).padStart(2, "0")}`, value = metricView(byDate.get(date)?.[product]);
      return { date, day, observed: value.observed, reservationRate: value.observed ? value.reservationRate : null, coverageRate: value.observed ? value.coverageRate : null };
    });
  }
  function buildViewModel(payload = {}, selection = {}, currentMonth = "") {
    const request = payload.request || {}, snapshot = payload.snapshot;
    const scopeMatches = request.keyword === selection.keyword && request.month === selection.month && request.cutoffDate === selection.cutoffDate;
    const snapshotMatches = snapshot?.request?.type === "keyword" && snapshot.request.targetId === selection.keyword && snapshot.request.month === selection.month && snapshot.request.cutoffDate === selection.cutoffDate;
    const rows = Array.isArray(snapshot?.daily) ? snapshot.daily : [];
    const dates = rows.map(row => row.date);
    const dailyValid = dates.every(day => dateValid(day) && day.startsWith(`${selection.month}-`)) && new Set(dates).size === dates.length;
    const diagnostics = [...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
    // An expired preparation remains inspectable as historical evidence. It is
    // never relabelled fresh, and a cutoff beyond that evidence stays blocked.
    const historicalSnapshot = payload.status === "stale" && hasDiagnostic(diagnostics, "PROJECTION_EXPIRED")
      && !hasDiagnostic(diagnostics, "CUTOFF_AFTER_DATA_THROUGH") && Number.isFinite(Date.parse(payload.provenance?.dataThrough || ""))
      && selection.cutoffDate <= dataThroughDay({ provenance: payload.provenance });
    const eligible = payload.status === "available" || historicalSnapshot;
    const usable = eligible && scopeMatches && snapshotMatches && dailyValid;
    const status = eligible && !usable ? "needs_verification" : payload.status || "needs_verification";
    if (eligible && !usable) diagnostics.push({ code: "KEYWORD_MONTHLY_RESPONSE_MISMATCH", message: "응답의 검색어·숙박월·관측 마감일 또는 일별 자료를 확인해야 합니다." });
    return { usable, status, historicalSnapshot: usable && historicalSnapshot, phase: phaseLabel(selection.month, currentMonth), diagnostics,
      snapshot: usable ? snapshot : null, summary: usable ? { lodging: metricView(snapshot.summary?.lodging), dayuse: metricView(snapshot.summary?.dayuse) } : null,
      daily: usable ? rows.map(row => ({ date: row.date, lodging: metricView(row.lodging), dayuse: metricView(row.dayuse) })) : [],
      companies: usable && Array.isArray(snapshot.companies) ? snapshot.companies : [],
      comparison: usable ? snapshot.comparison || null : null,
      comparisons: usable ? { lodging: Object.hasOwn(snapshot.comparisonByProduct || {}, "lodging") ? snapshot.comparisonByProduct.lodging : snapshot.comparison || null,
        dayuse: snapshot.comparisonByProduct?.dayuse?.productType === "dayuse" ? snapshot.comparisonByProduct.dayuse : null } : { lodging: null, dayuse: null },
      activity: usable && payload.activity?.basis === "collection_month" && Array.isArray(payload.activity.rows) ? payload.activity.rows : [],
      activityScope: typeof payload.activity?.scope === "string" ? payload.activity.scope : "제공 run 집합에서 확인한 고유 회차", runInventoryComplete: payload.activity?.runInventoryComplete === true,
      latestAttempt: payload.latestAttempt || null, lastSuccessfulAttempt: payload.lastSuccessfulAttempt || null, provenance: payload.provenance || null, supportedCutoffDate: dateValid(payload.supportedCutoffDate) ? payload.supportedCutoffDate : null };
  }
  function mount(parent, options = {}) {
    if (!parent || typeof document === "undefined") return null;
    if (instances.has(parent)) return instances.get(parent);
    const doc = parent.ownerDocument || document, win = options.window || root, request = options.fetch || win.fetch.bind(win), now = options.now || Date.now;
    const stateHelper = win.AdminViewState || root.AdminViewState;
    if (typeof stateHelper?.create !== "function") { const note = doc.createElement("p"); note.textContent = "조회 조건 보존 모듈을 확인하지 못했습니다. 화면을 다시 열어 주세요."; note.setAttribute("role", "alert"); parent.append(note); return null; }
    const initialView = { selection: { keyword: "", month: "", cutoffDate: "" }, draft: { keyword: "", month: "", cutoffDate: "" }, applied: null,
      cutoffMode: "auto", draftCutoffMode: "auto", product: "lodging", companyId: "", listQuery: "", listPage: 1, mobileView: "list", expanded: {}, scopes: [] };
    const viewState = stateHelper.create(initialView);
    let sequence = 0, active = null, pendingLoad = null, resumeRequest = null, destroyed = false, paused = false, loading = false, resumeNeeded = false, restoreAttempted = false, restoreNotice = "", phase = "", error = "", errorCode = "", catalog = null, payload = null, lastGoodPayload = null, keyword = "", month = "", cutoffDate = "", product = "lodging", benchmarkCompanyId = "", pendingContext = null, pendingRestore = false, companyChoices = [], chartRevision = 0;
    const timeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : 20000;
    const schedule = options.setTimeout || win.setTimeout?.bind(win) || (typeof setTimeout === "function" ? setTimeout : null);
    const unschedule = options.clearTimeout || win.clearTimeout?.bind(win) || (typeof clearTimeout === "function" ? clearTimeout : null);
    const Abort = options.AbortController || win.AbortController || (typeof AbortController === "function" ? AbortController : null);
    let draft = { ...initialView.draft }, appliedSelection = null, draftRevision = 0, cutoffMode = "auto", draftCutoffMode = "auto", listQuery = "", listPage = 1, mobileView = "list", expanded = {}, scopes = [], resultTarget = null, workspace = null, listPanel = null, detailPanel = null;
    const PAGE_SIZE = 20;
    const chartRoots = new Set();
    const el = (tag, cls = "", text = "") => { const node = doc.createElement(tag); node.className = cls; node.textContent = text; return node; };
    const button = (label, handler, cls = "secondary-button") => { const node = el("button", cls, label); node.type = "button"; node.addEventListener("click", handler); return node; };
    const panel = el("section", "keyword-monthly-analysis monthly-reports"); panel.setAttribute("aria-label", "키워드 월별 누적 분석");
    const header = el("header", "mr-intro"), title = el("div"), badge = el("span", "mr-private-label", "관리자 전용 · 저장 자료 조회");
    const dashboardTitle = el("h2", "kma-dashboard-title", "키워드 월별 누적 분석");
    title.append(el("p", "mr-eyebrow", "KEYWORD MONTHLY"), dashboardTitle, el("p", "", "반복 수집한 관측에서 같은 업체·숙박일의 최신 유효 자료를 한 번만 반영합니다.")); header.append(title, badge); panel.append(header);
    const filters = el("form", "mr-card kma-filters"); filters.setAttribute("aria-label", "키워드 월별 조회 조건");
    function field(label, tag, name) { const wrap = el("label"), input = el(tag); input.name = name; wrap.append(el("span", "", label), input); filters.append(wrap); return input; }
    const keywordInput = field("검색어 · 정확한 키워드", "select", "keyword"), companyInput = field("비교할 업체", "select", "benchmarkCompany"), monthInput = field("숙박월 · 관측 자료가 있는 월", "select", "month"), cutoffInput = field("관측 마감일 · 한국시간", "input", "cutoffDate"); cutoffInput.type = "date";
    companyInput.setAttribute("aria-label", "비교할 업체");
    const cutoffNote = el("small", "kma-cutoff-note"); cutoffInput.parentNode.append(cutoffNote);
    const readButton = button("저장 자료 조회", () => { void (catalog ? applyDraft(true) : open(pendingContext)); }, "primary-button"); filters.append(readButton); panel.append(filters);
    const conditionSummary = el("p", "kma-condition-summary"); conditionSummary.setAttribute("role", "status"); panel.append(conditionSummary);
    const productTabs = el("div", "kma-product-tabs"); productTabs.setAttribute("role", "group"); productTabs.setAttribute("aria-label", "상품 유형");
    const productButtons = {};
    for (const [key, info] of Object.entries(PRODUCTS)) { const node = button(info.label, () => { product = key; rememberScope(); render(); }, "kma-product-button"); productButtons[key] = node; productTabs.append(node); }
    panel.append(productTabs);
    const notice = el("p", "mr-notice kma-notice"); notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); panel.append(notice);
    const refreshNotice = el("div", "kma-note kma-refresh-status"), refreshDetails = el("details", "kma-refresh-history");
    refreshNotice.hidden = true; panel.append(refreshNotice);
    const errors = el("div", "mr-error kma-error"); errors.hidden = true; errors.setAttribute("role", "alert"); panel.append(errors);
    const results = el("div", "kma-results"); panel.append(results); parent.append(panel);
    const allowed = () => typeof options.isAdmin === "function" ? options.isAdmin() : Boolean(doc.body?.classList.contains("role-admin") && !doc.body?.classList.contains("admin-user-view"));
    const visible = () => !paused && allowed() && !doc.hidden && panel.getClientRects().length > 0;
    const current = token => !destroyed && token === sequence && allowed() && visible();
    const selected = () => ({ keyword, month, cutoffDate });
    const scopeKey = (word = keyword, stayMonth = month) => JSON.stringify([word, stayMonth]);
    const draftHasChanges = () => Object.keys(draft).some(key => draft[key] !== selected()[key]) || draftCutoffMode !== cutoffMode;
    function persistView() {
      viewState.update({ selection: selected(), draft: { ...draft }, applied: appliedSelection ? { ...appliedSelection } : null, cutoffMode, draftCutoffMode, product, companyId: benchmarkCompanyId, listQuery, listPage, mobileView, expanded: { ...expanded }, scopes });
      if (allowed() && !paused) selectionStorage.write(externalSelection());
    }
    function rememberScope() {
      if (keyword && month) { const key = scopeKey(); scopes = [...scopes.filter(row => row.key !== key), { key, cutoffDate, cutoffMode, product, companyId: benchmarkCompanyId, listQuery, listPage, mobileView, expanded: { ...expanded } }].slice(-24); }
      persistView();
    }
    function changeScope(word, stayMonth) {
      if (keyword === word && month === stayMonth) return;
      const carriedCompanyId = word === keyword ? benchmarkCompanyId : "";
      rememberScope(); const saved = scopes.find(row => row.key === scopeKey(word, stayMonth));
      keyword = word; month = stayMonth; cutoffDate = saved?.cutoffDate || ""; cutoffMode = saved?.cutoffMode || "auto";
      product = saved?.product || product; benchmarkCompanyId = saved ? saved.companyId : carriedCompanyId; listQuery = saved?.listQuery || ""; listPage = saved?.listPage || 1; mobileView = saved?.mobileView || "list"; expanded = { ...(saved?.expanded || {}) }; companyChoices = [];
    }
    function disclose(details, key) {
      details.open = expanded[key] === true;
      details.addEventListener("toggle", () => { if (!allowed() || destroyed || paused) return; expanded = { ...expanded, [key]: details.open === true }; rememberScope(); });
      return details;
    }
    function externalSelection() { return { ...selected(), cutoffMode, product, benchmarkCompanyId, companyId: benchmarkCompanyId, listQuery, listPage, mobileView, expanded: { ...expanded } }; }
    function choices(input, rows, value, blank) { input.replaceChildren(); if (!rows.length) { const option = el("option", "", blank); option.value = ""; input.append(option); } else for (const row of rows) { const option = el("option", "", row.label); option.value = row.value; input.append(option); } input.value = value; }
    function renderControls(dashboard) {
      choices(keywordInput, (catalog?.keywords || []).map(row => ({ value: row.keyword, label: row.keyword })), draft.keyword, "선택 가능한 저장 검색어 없음");
      const months = catalog?.keywords.find(row => row.keyword === draft.keyword)?.stayMonths || [];
      choices(monthInput, months.map(value => ({ value, label: `${value}${value > catalog.currentMonth ? " · 사전 관측" : value === catalog.currentMonth ? " · 누적 중" : ""}` })), draft.month, "관측된 숙박월 없음");
      const companyOptions = companyChoices.map(company => ({ value: company.companyId, label: `${company.name}${company.quantityKnown ? "" : " · 수량 미관측"}` }));
      if (benchmarkCompanyId && !companyChoices.some(company => company.companyId === benchmarkCompanyId)) companyOptions.unshift({ value: benchmarkCompanyId, label: `선택 업체 미확보 · ${benchmarkCompanyId}` });
      choices(companyInput, companyOptions, benchmarkCompanyId, "선택 가능한 업체 없음");
      const supported = catalog?.keywords.find(row => row.keyword === draft.keyword)?.supportedCutoffs?.[draft.month];
      cutoffInput.value = draft.cutoffDate; cutoffInput.min = supported || ""; cutoffInput.max = supported || [catalog?.currentDay || kstDay(now()), catalog ? dataThroughDay(catalog, draft.keyword, draft.month) : kstDay(now())].sort()[0]; cutoffInput.readOnly = Boolean(supported);
      cutoffNote.textContent = supported ? `선택 관측 사본 · ${supported} 마감만 지원` : catalog?.provenance?.dataThrough ? `저장 근거 마감 ${dataThroughDay(catalog)}` : "저장된 관측 근거 범위에서 조회";
      keywordInput.disabled = paused || !catalog?.keywords.length || !allowed() || phase === "options";
      monthInput.disabled = paused || !months.length || !allowed() || phase === "options"; cutoffInput.disabled = paused || !month || !allowed() || phase === "options";
      readButton.disabled = paused || !allowed() || phase === "options" || (catalog ? !draft.keyword || !draft.month : !error);
      companyInput.disabled = paused || !allowed() || loading || !dashboard || dashboard.status === "needs_verification" || !companyChoices.length;
      for (const key of Object.keys(PRODUCTS)) productButtons[key].setAttribute("aria-pressed", String(product === key));
    }
    function card(label, value, detail = "", cls = "") { const node = el("div", `kma-metric ${cls}`); node.append(el("span", "", label), el("strong", "", value)); if (detail) node.append(el("small", "", detail)); return node; }
    function section(label, note = "", collapsible = false) { const node = el("section", "mr-card kma-panel"), head = el("div", "mr-section-title"); head.append(el("h3", "", label)); node.append(head); if (note) node.append(el("p", "kma-note", note));
      if (collapsible) { const details = disclose(el("details", "kma-chart-data kma-supporting-details"), `support:${label}`); details.append(el("summary", "", label), node); (resultTarget || results).append(details); } else (resultTarget || results).append(node); return node; }
    function table(parentNode, headers, rows, caption) { const wrap = el("div", "kma-table-wrap"), node = el("table", "kma-table"), head = el("thead"), line = el("tr"), body = el("tbody"); node.append(el("caption", "", caption)); for (const name of headers) { const cell = el("th", "", name); cell.scope = "col"; line.append(cell); } head.append(line); for (const row of rows) { const tr = el("tr"); row.forEach((value, index) => { const cell = el(index ? "td" : "th", "", value); if (!index) cell.scope = "row"; tr.append(cell); }); body.append(tr); } node.append(head, body); wrap.append(node); parentNode.append(wrap); return node; }
    function calendar(parentNode, rows, info) {
      const node = el("table", "kma-calendar"), head = el("thead"), headerRow = el("tr"), body = el("tbody");
      node.append(el("caption", "", `${month} ${info.label} · 숙박일별 달력 · 한국시간 날짜 기준`));
      for (const weekday of ["일", "월", "화", "수", "목", "금", "토"]) { const cell = el("th", "", weekday); cell.scope = "col"; headerRow.append(cell); }
      head.append(headerRow); node.append(head);
      const cells = calendarCells(month, rows, product);
      for (let offset = 0; offset < cells.length; offset += 7) {
        const line = el("tr");
        for (const value of cells.slice(offset, offset + 7)) {
          if (!value) { const blank = el("td", "kma-calendar-outside"); blank.setAttribute("aria-hidden", "true"); line.append(blank); continue; }
          const cell = el("td", `kma-calendar-cell${value.observed ? "" : " kma-calendar-missing"}`), date = el("time", "kma-calendar-day", String(value.day)); date.setAttribute("datetime", value.date);
          cell.setAttribute("data-date", value.date); cell.setAttribute("aria-label", `${value.date} · 예약 추정률 ${rate(value.reservationRate)} · 자료 충족률 ${rate(value.coverageRate)}${value.observed ? "" : " · 미관측"}`);
          cell.append(date, el("strong", "kma-calendar-rate", rate(value.reservationRate)), el("small", "kma-calendar-coverage", `충족 ${rate(value.coverageRate)}`));
          if (!value.observed) cell.append(el("small", "kma-calendar-state", "미관측"));
          line.append(cell);
        }
        body.append(line);
      }
      node.append(body); parentNode.append(el("p", "kma-note", "달력의 큰 값은 예약 추정률, 충족은 해당일 자료 충족률입니다. 회색 미관측 칸은 —이며, 실제 관측된 0%와 구분합니다."), node);
    }
    function warnings(parentNode, values) { if (!values?.length) return; const list = el("ul", "kma-warnings"); for (const value of values) list.append(el("li", "", message(value))); parentNode.append(list); }
    function clearCharts() {
      chartRevision++;
      for (const node of chartRoots) { try { win.KeywordMonthlyCharts?.unmount?.(node); } catch {} node.replaceChildren(); }
      chartRoots.clear();
    }
    function mountChart(parentNode, config, cls) {
      const node = el("div", `kma-chart ${cls}`), revision = chartRevision;
      node.dataset.chartId = config.id; node.setAttribute("data-chart-id", config.id);
      const mark = value => { node.dataset.chartStatus = value; node.setAttribute("data-chart-status", value); };
      mark("loading"); parentNode.append(node); chartRoots.add(node);
      const valid = () => !destroyed && revision === chartRevision && allowed() && !paused;
      const failed = () => { if (!valid()) { node.replaceChildren(); return; } mark("failed"); node.replaceChildren(el("p", "kma-note", "차트를 표시하지 못했습니다. 아래 저장 수치 표에서 같은 자료를 확인할 수 있습니다.")); };
      try {
        if (typeof win.KeywordMonthlyCharts?.mount !== "function") { failed(); return; }
        Promise.resolve(win.KeywordMonthlyCharts.mount(node, config)).then(handle => {
          if (!valid()) { try { handle?.destroy?.(); } catch {} node.replaceChildren(); return; }
          mark("mounted");
        }).catch(failed);
      } catch { failed(); }
    }
    function chooseCompany(companyId) {
      if (!allowed() || paused || loading || !companyChoices.some(company => company.companyId === companyId)) return;
      benchmarkCompanyId = companyId; mobileView = "detail"; rememberScope(); render(); detailPanel?.focus?.({ preventScroll: true });
      if (win.matchMedia?.("(max-width: 767px)")?.matches) detailPanel?.scrollIntoView?.({ block: "start", behavior: "instant" });
    }
    function displayedDashboard(model) {
      if (!model || model.status === "needs_verification") return model;
      if (!benchmarkCompanyId) benchmarkCompanyId = model.selectedCompanyId || "";
      companyChoices = model.companies;
      // The pure model intentionally chooses a default for an unknown ID. A
      // remembered UI selection must not silently turn into another company.
      if (!benchmarkCompanyId || model.selectedCompanyId === benchmarkCompanyId) return model;
      return { ...model, selectedCompanyId: benchmarkCompanyId, selectionUnavailable: true,
        companies: model.companies.map(company => ({ ...company, selected: false })), monthly: { ...model.monthly, selected: null },
        daily: model.daily.map(day => ({ ...day, selectedRate: null, selectedPublicRate: null, selectedPhoneRate: null, selectedObserved: false,
          selectedSupply: null, selectedSold: null, selectedPublicBookings: null, selectedPhoneBookings: null, difference: null, peerDifference: null, canCompare: false, canComparePeers: false })) };
    }
    function renderCompanyWorkspace(model) {
      workspace = el("div", "kma-workspace"); workspace.dataset.kmaMobileView = mobileView; panel.dataset.kmaMobileView = mobileView;
      listPanel = el("aside", "mr-card kma-company-list-panel"); listPanel.setAttribute("aria-label", "비교 업체 목록");
      detailPanel = el("div", "kma-detail-panel"); detailPanel.tabIndex = -1; detailPanel.setAttribute("aria-label", "선택 업체와 전체 표본 상세");
      const back = button("업체 목록으로", () => {
        mobileView = "list"; workspace.dataset.kmaMobileView = mobileView; panel.dataset.kmaMobileView = mobileView; rememberScope();
        const target = rowNodes.get(benchmarkCompanyId) || search; target.focus?.({ preventScroll: true });
        if (win.matchMedia?.("(max-width: 767px)")?.matches) target.scrollIntoView?.({ block: "center", behavior: "instant" });
      }, "secondary-button kma-back-to-list");
      back.setAttribute("data-kma-action", "back-to-list"); detailPanel.append(back); workspace.append(listPanel, detailPanel); results.append(workspace);
      listPanel.append(el("h3", "", "비교할 업체"));
      const searchLabel = el("label", "kma-company-search"), search = el("input"); search.type = "search"; search.name = "companySearch"; search.value = listQuery; search.maxLength = 200;
      search.placeholder = "현재 키워드의 업체 찾기"; searchLabel.append(el("span", "", "업체명 · 고유번호 검색"), search); listPanel.append(searchLabel);
      const scopeNote = el("p", "kma-note", "목록 검색·페이지는 업체 선택만 돕습니다. 전체 평균·전체선·전체 업체 막대의 모집단은 바뀌지 않습니다."); listPanel.append(scopeNote);
      const countLabel = el("p", "kma-company-list-count"), rowsRoot = el("div", "kma-company-list"), pages = el("div", "kma-company-pagination"); listPanel.append(countLabel, rowsRoot, pages);
      const rowNodes = new Map(), all = model?.status !== "needs_verification" && Array.isArray(model?.companies) ? model.companies : [];
      const normalized = value => String(value).normalize("NFKC").toLocaleLowerCase("ko-KR");
      function listRows() {
        rowNodes.clear(); rowsRoot.replaceChildren(); pages.replaceChildren();
        const query = normalized(listQuery.trim()), matches = all.filter(company => !query || normalized(`${company.name} ${company.companyId}`).includes(query));
        const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE)); listPage = Math.min(Math.max(1, listPage), pageCount);
        const offset = (listPage - 1) * PAGE_SIZE;
        countLabel.textContent = `목록 전체 ${number(all.length)}곳 · 검색 ${number(matches.length)}곳 · ${listPage}/${pageCount}페이지`;
        for (const company of matches.slice(offset, offset + PAGE_SIZE)) {
          const row = button("", () => chooseCompany(company.companyId), "kma-company-row"); row.dataset.companyId = company.companyId;
          row.setAttribute("aria-pressed", String(company.companyId === benchmarkCompanyId)); row.setAttribute("aria-label", `${company.name} · 예약 추정률 ${rate(company.totalRate)} · ${company.quantityKnown ? "수량 관측" : "수량 미관측"}`);
          row.append(el("strong", "", company.name), el("span", "kma-company-rate", rate(company.totalRate)), el("small", "kma-company-state", company.quantityKnown ? known(company.totalRate) ? "수량 관측" : "공급 근거 확인 필요" : "수량 미관측"));
          rowsRoot.append(row); rowNodes.set(company.companyId, row);
        }
        if (!matches.length) rowsRoot.append(el("p", "kma-note", all.length ? "검색 조건에 맞는 업체가 없습니다. 선택 업체와 전체 평균은 유지합니다." : "비교할 업체의 저장 근거를 확인하지 못했습니다."));
        if (benchmarkCompanyId && !matches.some(company => company.companyId === benchmarkCompanyId)) rowsRoot.append(el("p", "kma-note", all.some(company => company.companyId === benchmarkCompanyId) ? "현재 선택 업체는 목록 검색 범위 밖입니다. 상세 비교는 같은 업체를 유지합니다." : "현재 선택 업체는 이 조회 범위에서 미확보입니다. 다른 업체로 바꾸지 않습니다."));
        const previous = button("이전 업체", () => { listPage--; listRows(); rememberScope(); }, "secondary-button"), next = button("다음 업체", () => { listPage++; listRows(); rememberScope(); }, "secondary-button");
        previous.disabled = listPage <= 1; next.disabled = listPage >= pageCount; pages.append(previous, el("span", "", `${offset + (matches.length ? 1 : 0)}–${Math.min(offset + PAGE_SIZE, matches.length)} / ${matches.length}곳`), next);
        persistView();
      }
      search.addEventListener("input", () => { listQuery = search.value.slice(0, 200); listPage = 1; listRows(); rememberScope(); });
      listRows(); resultTarget = detailPanel;
    }
    function renderDashboard(model, info) {
      if (!model || model.status === "needs_verification") { section("비교 대시보드 확인 필요", "유효 관측의 업체·수량 근거를 확인하지 못했습니다. 기존 상세 표에서 저장 근거를 확인할 수 있습니다."); return; }
      const chosen = model.monthly.selected, whole = model.monthly.whole;
      const gap = known(chosen?.totalRate) && known(whole.totalRate) ? chosen.totalRate - whole.totalRate : null;
      const summary = section("선택 업체와 전체 비교", `${keyword} · ${month} · ${info.label} · 전체 평균은 선택 업체를 포함한 공급 가중 값입니다.`); summary.className += " kma-dashboard-summary";
      const metrics = el("div", "kma-dashboard-metrics"); metrics.append(card(`${chosen?.name || "선택 업체"} 예약 추정률`, rate(chosen?.totalRate), "유효 관측 공급 기준", "kma-accent-selected"), card("전체 표본 예약 추정률", rate(whole.totalRate), `유효 ${number(whole.companyCount)} / 목록 ${number(model.companies.length)}곳`), card("선택 업체 − 전체", known(gap) ? `${gap > 0 ? "+" : ""}${number(gap * 100)}%p` : "—", "반올림 전 원값의 차이"), card("선택 업체 자료 충족률", rate(chosen?.coverageRate), `유효 관측 ${number(chosen?.observedCompanyDays)} 업체·일`)); summary.append(metrics);
      const grid = el("div", "kma-dashboard-grid"), companyPanel = el("section", "mr-card kma-panel kma-company-chart-panel"), flowPanel = el("section", "mr-card kma-panel kma-flow-chart-panel");
      grid.append(companyPanel, flowPanel); (resultTarget || results).append(grid);
      companyPanel.append(el("h3", "", "업체별 예약 추정률"), el("p", "kma-note", "공개 예약과 방막기·타채널 추정을 같은 유효 공급으로 나눕니다. 선택 업체와 관계없이 전체 업체를 표시합니다."));
      const nameCounts = new Map(); for (const company of model.companies) nameCounts.set(company.name, (nameCounts.get(company.name) || 0) + 1);
      const sameNames = new Map(), validCompanies = model.companies.filter(company => known(company.publicRate) && known(company.phoneRate));
      const barRows = validCompanies.map(company => { const index = (sameNames.get(company.name) || 0) + 1; sameNames.set(company.name, index); const name = nameCounts.get(company.name) > 1 ? `${company.name} · 동명 ${index}` : company.name; return { company: `${company.selected ? "● " : ""}${name}`, companyId: company.companyId, "공개 예약": company.publicRate, "방막기·타채널 추정": company.phoneRate, selected: company.selected }; });
      for (let offset = 0; offset < barRows.length; offset += 30) {
        const rows = barRows.slice(offset, offset + 30), page = offset / 30 + 1;
        mountChart(companyPanel, { id: `keyword-monthly-companies-${page}`, title: `업체별 예약 추정률${barRows.length > 30 ? ` · ${offset + 1}–${offset + rows.length} / ${barRows.length}곳` : ""}`, height: Math.min(800, Math.max(120, 40 + rows.length * 20)),
          spec: { type: "horizontalStackedBar", x: ["공개 예약", "방막기·타채널 추정"], y: "company", xDomain: [0, 1], colors: { "공개 예약": "#70bd9a", "방막기·타채널 추정": "#b68ade" }, valueFormat: { style: "percent", maximumFractionDigits: 1 }, showValues: true }, rows }, "kma-company-chart");
      }
      const unknown = model.companies.filter(company => !known(company.publicRate) || !known(company.phoneRate));
      if (unknown.length) companyPanel.append(el("p", "kma-unknown-companies", `비율 미확인 ${number(unknown.length)}곳 · ${unknown.map(company => company.name).join(", ")}. 미관측 또는 공급 근거 부족을 0% 막대로 표시하지 않습니다.`));
      if (!barRows.length) companyPanel.append(el("p", "kma-note", "표시할 유효 비율이 없습니다. 미관측은 0%가 아닙니다."));
      const companyData = disclose(el("details", "kma-chart-data"), "chart:companies"); companyData.append(el("summary", "", `전체 ${number(model.companies.length)}개 업체의 저장 수치 보기`));
      table(companyData, ["업체", "공개 예약", "방막기·타채널 추정", "전체 예약 추정률", "공급", "예약 추정", "자료 충족률"], model.companies.map(company => [`${company.name}${company.selected ? " · 선택" : ""}`, rate(company.publicRate), rate(company.phoneRate), rate(company.totalRate), number(company.supply), number(company.sold), rate(company.coverageRate)]), "상위 업체 수로 자르지 않은 전체 목록 · 비율 미확인 업체 포함"); companyPanel.append(companyData);
      flowPanel.append(el("h3", "", "선택 업체와 전체의 일별 흐름"), el("p", "kma-note", "숙박일별 유효 표본의 공급 가중 비율입니다. 전체에는 선택 업체를 포함하며 관측 날짜·선행일수가 다른 표본일 수 있습니다."));
      const wholeLabel = "전체 표본 · 선택 업체 포함", selectedLabel = chosen?.name === wholeLabel ? `${chosen.name} · 선택` : chosen?.name || "선택 업체";
      mountChart(flowPanel, { id: "keyword-monthly-daily-flow", title: "숙박일별 예약 추정률", height: 340,
        spec: { type: "line", x: "date", y: [selectedLabel, wholeLabel], yDomain: [0, 1], colors: { [selectedLabel]: "#70bd9a", [wholeLabel]: "#b68ade" }, valueFormat: { style: "percent", maximumFractionDigits: 1 } },
        rows: model.daily.map(day => ({ date: day.date, [selectedLabel]: day.selectedRate, [wholeLabel]: day.wholeRate })) }, "kma-flow-chart");
      flowPanel.append(el("p", "kma-note kma-flow-coverage", `전체 목록 ${number(model.companies.length)}곳 중 날짜별 유효 업체 수가 달라집니다. 미관측일은 선을 연결하거나 0으로 채우지 않습니다. 같은 선행일수·재고 기준 비교는 아래 상세 비교에서 확인하세요.`));
      const flowData = disclose(el("details", "kma-chart-data"), "chart:daily"); flowData.append(el("summary", "", "일별 수치와 관측 업체 수 보기"));
      table(flowData, ["숙박일", selectedLabel, wholeLabel, "선택 업체 − 전체", "전체 유효 / 목록 업체"], model.daily.map(day => [day.date, rate(day.selectedRate), rate(day.wholeRate), known(day.difference) ? `${day.difference > 0 ? "+" : ""}${number(day.difference * 100)}%p` : "—", `${number(day.wholeCompanyCount)} / ${number(day.rosterCompanyCount)}`]), "월 전체 날짜 표시 · 미관측은 — · 수치가 없는 날짜를 연결하지 않음"); flowPanel.append(flowData);
    }
    function renderBenchmark(snapshot, info) {
      const block = section("업체 선택 · 전체 평균 비교", "같은 키워드·숙박월·상품의 유효 관측만 비교합니다. 전체 평균에는 선택 업체를 포함하고, 선택 업체를 제외한 값도 따로 보여줍니다.", true);
      block.className += " kma-benchmark";
      const calculate = (root.KeywordMonthlyBenchmark || benchmarkModule)?.buildKeywordMonthlyBenchmark;
      if (typeof calculate !== "function") { block.append(el("p", "kma-note", "업체 평균 계산 모듈을 확인하지 못했습니다. 미확인 평균을 0으로 표시하지 않습니다.")); return; }
      const value = calculate(snapshot, { productType: product, companyId: benchmarkCompanyId });
      if (value.status === "needs_verification") { block.append(el("p", "kma-note", "비교할 저장 관측의 업체 고유번호·수량·중복 근거를 확인해야 합니다. 정상 평균이나 0으로 대신 계산하지 않습니다.")); return; }
      if (benchmarkCompanyId && value.selectedCompanyId !== benchmarkCompanyId) { block.append(el("p", "kma-selection-unavailable", "선택 업체를 이 범위에서 확보하지 못해 선택 제외·동일 관측일 비교는 표시하지 않습니다. 전체 표본 비교선과 막대는 기존 전체 범위를 유지합니다.")); return; }
      const selectedCompany = value.selected, all = value.monthly.all, peers = value.monthly.peers, fair = value.sameDates;
      const bars = el("div", "kma-benchmark-bars");
      for (const [name, item, cls] of [[selectedCompany?.name || "선택 업체", selectedCompany, "kma-benchmark-selected"], ["전체 표본 · 선택 업체 포함", all, "kma-benchmark-all"], ["다른 표본 · 선택 업체 제외", peers, "kma-benchmark-peers"]]) {
        const row = el("div", `kma-benchmark-bar ${cls}`), valueLabel = rate(item?.reservationRate);
        row.append(el("span", "", name), el("strong", "", valueLabel));
        if (known(item?.reservationRate)) { const meter = el("meter"); meter.min = 0; meter.max = 1; meter.value = item.reservationRate; meter.setAttribute("aria-label", `${name} 월 예약 추정률 ${valueLabel}`); row.append(meter); }
        else row.append(el("small", "", "미확인")); bars.append(row);
      }
      block.append(bars, el("p", "kma-note", `월 예약 추정률 = 예약 추정 수량 합계 ÷ 공급 합계(공급 가중). 전체 유효 관측 ${number(all.companyCount)}곳 / 목록 ${number(value.monthly.rosterCompanyCount)}곳 · 다른 업체 ${number(peers.companyCount)}곳. 업체마다 관측 날짜가 달라 월 전체 비교는 참고치입니다.`));
      const gap = (a, b) => known(a) && known(b) ? `${a - b > 0 ? "+" : ""}${number((a - b) * 100)}%p` : "미확인";
      block.append(el("p", "kma-note kma-benchmark-difference", `선택 업체 − 전체 평균: ${gap(selectedCompany?.reservationRate, all.reservationRate)} · 선택 업체 − 다른 업체 평균: ${gap(selectedCompany?.reservationRate, peers.reservationRate)}`));
      table(block, ["월 전체 유효 관측 기준", "선택 업체", "전체 · 선택 포함", "다른 업체 · 선택 제외"], [
        ["예약 추정률 · 공급 가중", rate(selectedCompany?.reservationRate), rate(all.reservationRate), rate(peers.reservationRate)],
        [`관측 업체·일당 예약 추정 (${info.dailyUnit})`, number(selectedCompany?.soldPerObservedCompanyDay), number(all.soldPerObservedCompanyDay), number(peers.soldPerObservedCompanyDay)],
        ["완전 가격 관측 업체·일당 금액", money(selectedCompany?.amountPerCompletePriceCompanyDay), money(all.amountPerCompletePriceCompanyDay), money(peers.amountPerCompletePriceCompanyDay)],
        ["수량 관측 업체·일", number(selectedCompany?.observedCompanyDays), number(all.observedCompanyDays), number(peers.observedCompanyDays)],
        ["수량 관측 충족률 · 유효 관측 업체 기준", rate(selectedCompany?.coverageRate), rate(all.coverageRate), rate(peers.coverageRate)],
        ["완전 가격 관측 업체", number(selectedCompany?.completePriceCompanyCount), number(all.completePriceCompanyCount), number(peers.completePriceCompanyCount)],
        ["완전 가격 관측 업체·일", number(selectedCompany?.completePriceCompanyDays), number(all.completePriceCompanyDays), number(peers.completePriceCompanyDays)]
      ], "날짜가 없는 값을 월 전체 일수로 나누거나 0으로 채우지 않습니다. 금액은 완전 가격 관측일만의 추정 소계이며 실제 결제 매출이 아닙니다.");
      const equal = value.monthly.equalCompany;
      block.append(el("p", "kma-note", `업체 동일가중 참고 평균: 전체 ${rate(equal.all.reservationRate)} (${number(equal.all.reservationRateCompanyCount)}곳), 선택 제외 ${rate(equal.peers.reservationRate)} (${number(equal.peers.reservationRateCompanyCount)}곳). 각 업체의 월 예약 추정률을 한 번씩 평균한 값으로 위 공급 가중 값과 다릅니다.`));
      block.append(el("h4", "", "동일 관측일 · 선행일수 비교"), el("p", "kma-note", `선택 업체의 유효 관측 ${number(fair.expectedSelectedDates)}일 중 비교 가능한 ${number(fair.dateCount)}일 · 다른 업체 ${number(fair.peerCompanyCount)}곳 · 날짜별 다른 업체 ${number(fair.peerCountMin)}~${number(fair.peerCountMax)}곳. 같은 숙박일·관측 선행일수·재고 기준이 맞는 자료만 다시 합산합니다.`));
      block.append(el("p", "kma-note", `동일 조건의 선택 업체 − 전체 평균: ${gap(fair.selected.reservationRate, fair.all.reservationRate)} · 선택 업체 − 다른 업체 평균: ${gap(fair.selected.reservationRate, fair.peers.reservationRate)}`));
      table(block, ["동일 관측일 기준", "선택 업체", "전체 · 선택 포함", "다른 업체 · 선택 제외"], [
        ["예약 추정률 · 공급 가중", rate(fair.selected.reservationRate), rate(fair.all.reservationRate), rate(fair.peers.reservationRate)],
        [`관측 업체·일당 예약 추정 (${info.dailyUnit})`, number(fair.selected.soldPerObservedCompanyDay), number(fair.all.soldPerObservedCompanyDay), number(fair.peers.soldPerObservedCompanyDay)],
        ["완전 가격 관측 업체·일당 금액", money(fair.completePrice.selected.amountPerCompletePriceCompanyDay), money(fair.completePrice.all.amountPerCompletePriceCompanyDay), money(fair.completePrice.peers.amountPerCompletePriceCompanyDay)]
      ], `가격 비교는 별도 완전 가격 관측 ${number(fair.completePrice.dateCount)}일 · 다른 업체 ${number(fair.completePrice.peerCompanyCount)}곳의 같은 가격 산정 기준만 사용합니다. 수량과 금액의 표본 수를 혼용하지 않습니다.`);
      if (!fair.dateCount) block.append(el("p", "kma-note", "동일 관측 조건을 맞춘 다른 업체가 없어 직접 비교할 수 없습니다. 차이를 0으로 만들지 않습니다."));
      const reasons = { partial_run: "부분 완료 회차", run_quality_unknown_or_ineligible: "회차 품질 미확인·비대상", partial_or_invalid_quantity: "불완전 수량", quantity_unknown: "수량 미확인", quantity_conflict: "수량 불일치", company_outside_snapshot: "선택 표본 밖 업체", date_outside_month: "선택월 밖 날짜", no_peer_on_selected_date: "같은 날짜의 다른 업체 없음", observation_timing_unknown: "관측 선행일수 미확인", observation_timing_changed: "관측 선행일수 다름", inventory_basis_unknown: "재고 기준 미확인", inventory_basis_changed: "재고 기준 다름", sharing_basis_unknown: "공유 기준 미확인", sharing_basis_changed: "공유 기준 다름", price_policy_unknown: "가격 산정 기준 미확인", price_policy_changed: "가격 산정 기준 다름" };
      const excluded = [...Object.entries(value.exclusions).map(([key, n]) => [`월 비교 제외 · ${reasons[key] || "근거 미확인"}`, number(n)]), ...Object.entries(fair.exclusions).map(([key, n]) => [`동일일 비교 제외 · ${reasons[key] || "근거 미확인"}`, number(n)])];
      if (excluded.length) table(block, ["제외 근거", "관측 / 업체·일"], excluded, "제외 건수를 예약이나 매출의 0으로 대신하지 않습니다.");
      block.append(el("p", "kma-note", "완전 가격 관측 평균에는 별도 부분 응답 금액을 넣지 않습니다. 업체 규모와 자료 충족률이 다르므로 평균 차이를 성과 우열이나 가격 조정의 근거로 단정하지 않습니다."));
    }
    function render() {
      clearCharts(); resultTarget = results; workspace = listPanel = detailPanel = null;
      const candidate = allowed() && !paused && payload ? buildViewModel(payload, selected(), catalog?.currentMonth || kstDay(now()).slice(0, 7)) : null;
      const retained = candidate?.usable && (loading || Boolean(error) || resumeNeeded);
      const calculateDashboard = (root.KeywordMonthlyDashboardModel || dashboardModule)?.buildKeywordMonthlyDashboardModel;
      const dashboard = displayedDashboard(candidate?.usable && typeof calculateDashboard === "function" ? calculateDashboard(candidate.snapshot, { productType: product, companyId: benchmarkCompanyId }) : null);
      const chosenName = dashboard?.monthly?.selected?.name || companyChoices.find(company => company.companyId === benchmarkCompanyId)?.name;
      dashboardTitle.textContent = keyword ? `${keyword} · ${month || "숙박월 선택"}${dashboard?.selectionUnavailable ? " · 선택 업체 미확보" : chosenName ? ` · ${chosenName} 비교` : " · 월별 누적 분석"}` : "키워드 월별 누적 분석";
      conditionSummary.textContent = keyword ? `현재 조회 기준 · ${keyword} / 숙박월 ${month} / 관측 마감 ${cutoffDate} (${cutoffMode === "explicit" ? "사용자 선택" : "최신 근거 자동"}) / ${PRODUCTS[product].label}${draftHasChanges() ? " · 입력 초안이 다릅니다. 현재 자료는 위 조회 기준입니다." : ""}` : "저장된 키워드와 실제 숙박월을 선택하세요.";
      renderControls(dashboard); panel.setAttribute("aria-busy", String(loading)); results.replaceChildren();
      persistView();
      notice.textContent = retained ? loading ? "같은 조회 조건의 마지막 정상 저장 자료를 표시하며 최신 상태를 확인하고 있습니다." : resumeNeeded ? "같은 조회 조건의 마지막 정상 저장 자료입니다. 화면 복귀 시 중단된 최신 상태 확인을 다시 진행합니다." : "최신 조회를 완료하지 못했습니다. 아래는 같은 조회 조건의 마지막 정상 저장 자료이며 최신 반영 완료를 뜻하지 않습니다."
        : loading ? phase === "options" ? "저장된 검색어와 숙박월을 확인하고 있습니다." : "선택한 조건의 저장 집계를 확인하고 있습니다." : "숙박월 성과와 수집월 실행 횟수는 별도 기준입니다. 조회는 수집이나 재집계를 시작하지 않습니다.";
      if (restoreNotice && !loading) notice.textContent = `${restoreNotice} ${notice.textContent}`;
      const automatic = catalog?.refreshStatus;
      refreshNotice.hidden = !allowed() || !automatic;
      refreshNotice.replaceChildren();
      if (automatic) {
        const count = value => refreshCount(value) === null ? "미확인" : number(value), currentCounts = automatic.currentVersionCounts;
        const historicalDeferred = sumRefreshCounts(automatic.historicalCountsByVersion, "deferred");
        const historicalNeeds = sumRefreshCounts(automatic.historicalCountsByVersion, "needs_verification") ?? automatic.historicalNeedsVerification;
        const currentKnown = currentCounts && ["running", "queued", "deferred", "needs_verification"].every(key => currentCounts[key] !== null);
        const protectedWarning = automatic.hasRuntimeError || automatic.cleanupNeedsVerification || automatic.started !== true
          || automatic.initialized !== true || automatic.closed !== false || !currentKnown || currentCounts.needs_verification > 0
          || automatic.status === "unknown" || automatic.status === "needs_verification" && !(historicalNeeds > 0 && currentCounts?.needs_verification === 0);
        if (protectedWarning) refreshNotice.append(el("p", "kma-refresh-warning", "자동 반영 확인 필요 · 기존 검증 자료를 유지합니다. 실행 상태·현재 미처리·보호 근거를 확인하며 수집 재실행이나 보호 해제를 시작하지 않습니다."));
        refreshNotice.append(el("p", "kma-refresh-current", `현재 갱신 작업 · 처리 ${count(currentCounts?.running)} / 대기 ${count(currentCounts?.queued)} / 이월 ${count(currentCounts?.deferred)} / 검수 필요 ${count(currentCounts?.needs_verification)}.`));
        refreshNotice.append(el("p", "kma-refresh-historical", `이전 버전 기록 · 이월 ${count(historicalDeferred)} / 검수 필요 ${count(historicalNeeds)}. 원기록을 보존하며 재실행하지 않습니다.`));
        refreshDetails.replaceChildren(el("summary", "", "이전 기록 분류와 완료 근거"));
        const review = automatic.historicalReview;
        if (review?.allRowsCoverage) refreshDetails.append(el("p", "", `이전 실행·보류·검수 기록 ${count(review.reviewedRows)}건을 확인했습니다. 같은 입력의 후속 완료 기록 ${count(review.sameEventLaterCompleted)} / 기존 완료 기록 ${count(review.priorExactComplete)} / 대응 완료 없음 ${count(review.notCovered)} / 근거 미확인 ${count(review.unknown)}.`));
        else refreshDetails.append(el("p", "", "이전 기록의 사유별 분류 근거가 전체 원장을 포함하는지 미확인입니다. 확인하지 못한 건수를 0으로 표시하지 않습니다."));
        const stateLabel = state => ({ queued: "대기", deferred: "이월", running: "실행 기록", needs_verification: "검수 필요" })[state] || "완료";
        const list = el("ul");
        for (const row of automatic.currentVersionReasonCounts || []) if (row.status !== "complete") list.append(el("li", "", `현재 ${stateLabel(row.status)} ${count(row.count)}건 · ${refreshReasonLabel(row.reasonCode)}${row.reasonCode ? ` (${row.reasonCode})` : ""}`));
        for (const row of review?.groups || []) {
          const version = row.version.match(/-v(\d+)$/)?.[1];
          list.append(el("li", "", `이전${version ? ` v${version}` : " 버전"} ${stateLabel(row.status)} ${count(row.count)}건 · ${refreshReasonLabel(row.reasonCode)}${row.reasonCode ? ` (${row.reasonCode})` : ""}. 같은 입력 후속 완료 ${count(row.sameEventLaterCompleted)} / 기존 완료 ${count(row.priorExactComplete)} / 대응 없음 ${count(row.notCovered)} / 미확인 ${count(row.unknown)}.`));
        }
        if (list.children.length) refreshDetails.append(list);
        refreshDetails.append(el("p", "", "같은 입력의 완료 기록과 현재 선택 자료의 최신 반영 여부는 별개입니다. 선택 자료의 실제 반영 범위는 아래 자료 마감과 출처 근거로 확인하세요. 이전 이력은 삭제하거나 정상 완료로 바꾸지 않습니다."));
        refreshNotice.append(refreshDetails);
      }
      errors.hidden = !error; errors.textContent = error; errors.dataset.errorCode = errorCode;
      if (!allowed() || paused || !payload || (loading || error) && !candidate?.usable) { if (!loading && !error && catalog && !catalog.keywords.length) section("조회할 저장 자료가 없습니다.", "검색어와 숙박월을 확인할 수 있는 근거가 없습니다. 누락을 정상 0건으로 표시하지 않습니다."); return; }
      const view = candidate || buildViewModel(payload, selected(), catalog?.currentMonth || kstDay(now()).slice(0, 7));
      if (catalog?.diagnostics.length) { const evidence = section("저장 자료 목록 확인사항", "일부 키워드·월의 준비 상태와 현재 선택한 집계 상태는 따로 확인합니다."); warnings(evidence, catalog.diagnostics); }
      if (!view.usable) { const labels = { missing: "조회용 저장 집계가 준비되지 않았습니다.", stale: "저장 집계의 갱신 확인이 필요합니다.", needs_verification: "자료 검수가 필요합니다." }; const label = hasDiagnostic(view.diagnostics, "CUTOFF_NOT_RECONSTRUCTIBLE") ? "선택한 마감일의 과거 상태를 재구성할 수 없습니다." : hasDiagnostic(view.diagnostics, "CUTOFF_AFTER_DATA_THROUGH") ? "관측 마감일이 사본의 자료 마감보다 늦습니다." : labels[view.status] || "집계 상태를 확인해야 합니다."; const block = section(label, "이전 저장값을 현재 정상 수치나 0으로 대신 표시하지 않습니다."); warnings(block, view.diagnostics); if (view.supportedCutoffDate) { block.append(el("p", "kma-note", `이 선택 관측 사본은 ${view.supportedCutoffDate} 마감만 확인할 수 있습니다.`)); if (view.supportedCutoffDate !== cutoffDate) block.append(button(`${view.supportedCutoffDate} 근거로 조회`, () => { cutoffDate = view.supportedCutoffDate; cutoffMode = draftCutoffMode = "explicit"; draft = selected(); draftRevision++; rememberScope(); void load(); })); } if (view.provenance) block.append(el("p", "kma-note", `집계 생성 ${timeLabel(view.provenance.materializedAt)} · 자료 마감 ${timeLabel(view.provenance.dataThrough)}`)); return; }
      const snapshot = view.snapshot, info = PRODUCTS[product], metric = view.summary[product];
      if (view.historicalSnapshot) section("과거 저장근거 · 갱신 확인 필요", `집계 생성 ${timeLabel(view.provenance?.materializedAt)} · 자료 마감 ${timeLabel(view.provenance?.dataThrough)}. 아래 값은 이 저장 범위의 과거 집계이며 이후 수집 반영이나 현재 최신 상태를 확인한 값이 아닙니다.`);
      renderCompanyWorkspace(dashboard);
      if (dashboard?.selectionUnavailable) { const unavailable = section("선택 업체 미확보", `기억한 업체 ${benchmarkCompanyId}는 이 키워드·숙박월의 현재 목록에 없습니다. 다른 업체의 수치로 대체하지 않습니다. 전체 평균·전체선은 전체 저장 표본을 유지합니다.`); unavailable.className += " kma-selection-unavailable"; }
      renderDashboard(dashboard, info);
      const heading = section(`${keyword} · ${month} · ${view.phase}`, `숙박일 기준 · 관측 마감 ${cutoffDate} (KST) · ${info.label}. ${view.phase === "사전 관측" ? "미래 숙박일을 미리 관측한 자료이며 최종 예약·매출이 아닙니다." : "월의 종료와 자료 충족도는 별도입니다."}`);
      const metrics = el("div", "kma-metrics"); metrics.append(card("월 표본 업체", `${number(snapshot.companies?.length)}곳`), card(`예약 추정 / 공급 (${info.unit})`, `${number(metric.sold)} / ${number(metric.supply)}`), card("관측 예약 추정률", rate(metric.reservationRate)), card(metric.revenuePartial ? "가격 확인 부분 소계" : "추정 매출", money(metric.estimatedRevenue), "실제 결제 매출과 다름"), card("자료 충족률", rate(metric.coverageRate), `유효 관측 ${number(metric.coveredCompanyDays)} / 기대 ${number(metric.expectedCompanyDays)} 업체·일`)); heading.append(metrics);
      const split = el("div", "kma-split"); split.append(card("공개 예약", `${number(metric.publicBookings)} ${info.unit}`, money(metric.publicRevenue), "mr-public"), card("방막기·타채널 추정", `${number(metric.phoneBookings)} ${info.unit}`, money(metric.phoneRevenue), "mr-phone")); heading.append(split);
      if (known(metric.knownPartialRevenue) && metric.knownPartialRevenue > 0) heading.append(el("p", "kma-note", `수량이 불완전한 자료에서 확인한 별도 금액 ${money(metric.knownPartialRevenue)} · 위 소계에 다시 더하지 않습니다.`));
      renderBenchmark(snapshot, info);
      const daily = section("일별 관측 추이", `날짜는 숙박일입니다. 누락은 —로 남기며, ${info.label} 수량은 일별 ${info.dailyUnit}입니다.`, true);
      calendar(daily, view.daily, info);
      table(daily, ["숙박일", `공급 (${info.dailyUnit})`, `예약 추정 (${info.dailyUnit})`, "관측 예약 추정률", "자료 충족률", "가격 확인 소계"], view.daily.map(row => { const value = row[product]; return [row.date, number(value.supply), number(value.sold), rate(value.reservationRate), rate(value.coverageRate), money(value.estimatedRevenue)]; }), "숙박일별 최신 유효 관측 · 미관측 값을 연결하거나 0으로 채우지 않음");
      const companies = section("업체별 월간 소계", "같은 업체·숙박일의 반복 수집을 다시 더하지 않습니다. 순위만 관측된 업체의 수량과 가격은 미확인으로 남깁니다.", true);
      table(companies, ["업체", `공급 (${info.unit})`, `예약 추정 (${info.unit})`, "관측 예약 추정률", "자료 충족률", "가격 확인 소계"], view.companies.map(company => { const value = metricView(company.summary?.[product]); return [company.primaryName || company.name || company.companyName || company.companyId || "업체명 미확인", number(value.supply), number(value.sold), rate(value.reservationRate), rate(value.coverageRate), money(value.estimatedRevenue)]; }), "저장된 업체 고유번호 기준 · 표본 소계이며 지역 전체 시장 규모와 다름");
      const comparison = section("전월 공통 표본 비교", "동일 업체·대응 숙박일 중 공급·공유 기준과 관측 선행일수가 같은 표본만 비교합니다."); comparison.className += " kma-comparison";
      const prior = view.comparisons[product], matched = prior?.common?.matched;
      const previousObserved = prior?.all?.previous?.coveredCompanyDays > 0 || prior?.common?.companyCount > 0
        || Array.isArray(prior?.previousSources?.observations) && prior.previousSources.observations.some(row => row.productType === product);
      const directlyComparable = prior && prior.status !== "unavailable" && known(matched?.companyDays) && matched.companyDays > 0;
      comparison.append(el("p", "kma-note kma-comparison-status", `공통 관측 업체 ${number(prior?.common?.companyCount)}곳 · 조건 맞는 업체·일 ${number(matched?.companyDays)}`));
      table(comparison, ["비교 표본과 제외 사유", "업체·일 / 업체 수"], [
        ["전월 유효 관측 업체·일", number(prior?.all?.previous?.coveredCompanyDays)],
        ["선택월 유효 관측 업체·일", number(prior?.all?.current?.coveredCompanyDays)],
        ["공통 관측 업체", number(prior?.common?.companyCount)],
        ["조건 맞는 업체·일", number(matched?.companyDays)],
        [`대응 ${product === "dayuse" ? "이용일" : "숙박일"} 없음`, number(matched?.exclusions?.missingCorrespondingDay)],
        ["공급·공유·산정 기준 변경", number(matched?.exclusions?.capacityOrSharingChanged)],
        ["관측 선행일수 변경", number(matched?.exclusions?.observationTimingChanged)]
      ], "제외 사유는 공통 업체의 선택월 관측 기준 · 저장 근거가 없는 값은 —").className += " kma-comparison-evidence";
      if (!directlyComparable) comparison.append(el("p", "kma-note", previousObserved
        ? `전월 ${info.label} 관측 자료는 있지만 ${matched?.companyDays === 0 ? "조건이 맞는 표본이 없어" : "조건이 맞는 비교 표본을 확인하지 못해"} 직접 비교할 수 없습니다. 예약·매출 증감을 0으로 계산하지 않습니다.`
        : `확인 가능한 ${info.label} 전월 관측 근거가 없습니다. 전월 값과 증감을 0으로 대신 계산하지 않습니다.`));
      else { table(comparison, ["공통 조건 표본", prior.previousMonth || "전월", prior.currentMonth || "선택월", "증감"], [
        [`예약 추정 (${info.unit})`, number(matched.previous?.sold), number(matched.current?.sold), known(matched.deltas?.sold) ? `${matched.deltas.sold > 0 ? "+" : ""}${number(matched.deltas.sold)}` : "비교 불가"],
        ["가격 확인 소계", money(matched.previous?.estimatedRevenue), money(matched.current?.estimatedRevenue), known(matched.deltas?.estimatedRevenue) ? `${matched.deltas.estimatedRevenue > 0 ? "+" : ""}${money(matched.deltas.estimatedRevenue)}` : "비교 불가"]
      ], `조건 일치 ${number(matched.companyDays)} 업체·일에서만 증감 계산`); }
      if (prior) {
        const names = new Map(view.companies.map(company => [company.companyId, company.primaryName || company.name || company.companyName || company.companyId]));
        if (prior.all?.previous?.coveredCompanyDays > 0 && prior.all?.current?.coveredCompanyDays > 0) for (const [label, ids] of [["이번 달 신규 관측", prior.newlyObservedCompanyIds], ["전월에만 관측", prior.noLongerObservedCompanyIds]]) { const values = Array.isArray(ids) ? ids : null; comparison.append(el("p", "kma-note", `${label}: ${values ? `${number(values.length)}곳${values.length ? ` · ${values.slice(0, 20).map(id => names.get(id) || id).join(", ")}${values.length > 20 ? " 외" : ""}` : ""}` : "미확인"}`)); }
        else comparison.append(el("p", "kma-note", "양월의 업체 관측 표본이 부족해 신규·미관측 변화를 판단하지 않습니다."));
        comparison.append(el("p", "kma-note", "신규 관측·전월에만 관측된 업체는 개업·폐업·검색 순위 이탈을 뜻하지 않습니다.")); warnings(comparison, prior.warnings);
      }
      const quality = section("자료 충족도와 최근 수집 상태", "자료 충족률은 유효 관측 범위이며 최종 예약·실제 결제 매출의 확정 여부와 다릅니다.");
      const qualityStatus = { complete: "자료 충족", partial: "일부 자료", insufficient: "자료 부족" }[snapshot.quality?.status] || "상태 미확인";
      const attemptLabel = { complete: "완료", completed: "완료", reused: "재사용", partial: "일부 자료", failed: "실패", blocked: "차단", interrupted: "중단", running: "진행 중", unknown: "미확인", uncertain: "확인 필요" }[view.latestAttempt?.status] || "미확인";
      if (["failed", "blocked", "interrupted"].includes(view.latestAttempt?.status)) notice.textContent = `${retained ? `${notice.textContent} ` : restoreNotice && !loading ? `${restoreNotice} ` : ""}${view.historicalSnapshot ? "과거 저장근거 · 갱신 확인 필요. " : ""}사본에서 확인한 최근 회차 ${attemptLabel} · ${timeLabel(view.latestAttempt.observedAt)}. 선택월 수치는 마지막 유효 관측 근거를 표시합니다.`;
      table(quality, ["항목", "저장 근거"], [["집계 품질", qualityStatus], ["같은 날 관측 업체·일", number(metric.sameDayObservedCompanyDays)], ["사전 관측 업체·일", number(metric.staleDays)], ["가격 근거 충족률", rate(metric.revenueCoverageRate)], ["사본에서 확인한 최근 회차", view.latestAttempt ? `${attemptLabel} · ${timeLabel(view.latestAttempt.observedAt)}${view.latestAttempt.errorCode ? ` · ${view.latestAttempt.errorCode}` : ""}` : "미확인"], ["마지막 유효 관측", timeLabel(view.lastSuccessfulAttempt?.observedAt)]], "포함된 최근 회차와 선택월의 마지막 유효 관측을 구분");
      warnings(quality, [...(snapshot.quality?.warnings || []), ...view.diagnostics]);
      const activity = section("사본에 포함된 고유 관측 회차", "수집월 기준의 제공 run 집합입니다. 숙박월 예약·매출에 합산하지 않으며, 재사용은 새 수집과 구분합니다.", true);
      activity.append(el("p", "kma-note", `${view.activityScope}${view.runInventoryComplete ? "" : " · 전체 시도·실패 목록은 미확인입니다. 실패 0도 이 사본 범위의 기록만 뜻합니다."}`));
      if (view.activity.length) table(activity, ["수집월", "포함 회차", "신규 근거", "재사용 근거", "실패 기록", "일부 자료", "미확인"], view.activity.map(row => [row.month, number(row.runCount), number(row.freshRunCount), number(row.reusedRunCount), number(row.failedRunCount), number(row.partialRunCount), number(row.unknownRunCount)]), "한국시간 수집월 기준 · 포함 회차가 많다는 이유만으로 신뢰도를 높이지 않음");
      else activity.append(el("p", "kma-note", "사본에 포함된 수집월별 관측 회차 근거가 없습니다."));
      const sources = section("출처와 채택·제외 근거", "같은 업체·숙박일·상품유형의 최신 유효 관측만 채택합니다. 회차별 스냅샷을 더하지 않습니다.", true);
      table(sources, ["근거", "값"], [["사본 내 채택 관측", number(snapshot.sources?.selectedObservationCount)], ["사본 내 제외 관측", number(snapshot.sources?.discardedObservationCount)], ["관측 정책", snapshot.sources?.observationPolicy || "미확인"]], "제공된 관측 범위에서 확인한 채택·제외 근거");
      const runs = Array.isArray(snapshot.sources?.runs) ? snapshot.sources.runs : [];
      if (runs.length) table(sources, ["수집 기록", "관측 시각 · KST", "채택 / 관측", "품질"], runs.slice(0, 40).map(run => [run.id || run.runId || "미확인", timeLabel(run.collectedAt), `${number(run.selectedObservationCount)} / ${number(run.observationCount)}`, run.collectionQuality?.status || "미확인"]), `출처 ${number(runs.length)}개${runs.length > 40 ? " 중 40개 표시" : ""}`);
      const provenance = view.provenance || {};
      sources.append(el("p", "kma-note", `집계 생성 ${timeLabel(provenance.materializedAt)} · 자료 마감 ${timeLabel(provenance.dataThrough)} · 저장 집계 기준이며 원본의 최신 변경을 실시간으로 재검수한 값은 아닙니다.`));
      if (provenance.inputSha256) sources.append(el("p", "kma-note kma-source-fingerprint", `입력 근거 지문 ${provenance.inputSha256}`));
      const scopeLabels = { selected_only: "선택 관측 사본", normalized_multirun: "여러 회차 정규 관측 사본", verified_history_subset: "검증된 이력 부분 사본", unspecified: "확인 필요" };
      sources.append(el("p", "kma-note", `관측 범위 ${scopeLabels[provenance.observationScope] || "확인 필요"}${provenance.intermediateObservationsComplete === true ? "" : " · 중간 관측 전체 확보 여부는 미확인"}`));
      const reasonLabels = { duplicate_observation: "중복 관측", superseded_observation: "더 최신 유효 관측으로 대체", legacy_inventory_evidence: "구형 재고 근거", post_stay_observation: "숙박일 이후 관측", after_cutoff: "관측 마감 이후", missing_quantity: "수량 미확보", quantity_conflict: "수량 불일치", unknown_legacy_run_quality: "회차 품질 미확인", run_failed: "실패 회차", run_blocked: "차단 회차" };
      const reasons = Object.entries(snapshot.quality?.discardedByReason || {}).filter(([, count]) => known(count) && count > 0);
      if (reasons.length) table(sources, ["제외 사유", "관측 수"], reasons.map(([reason, count]) => [reasonLabels[reason] || reason, number(count)]), "제외 관측을 정상 0건으로 바꾸지 않음");
      warnings(sources, (snapshot.sources?.excludedRuns || []).map(row => ({ message: `${row.id || "수집 기록"} · ${row.reason || row.status || "제외 사유 미확인"}` })));
    }
    function cancel() { sequence++; active?.abort(); active = null; pendingLoad = null; loading = false; phase = ""; }
    function clearPrivate(reason = "관리자 로그인이 필요합니다.", erasePersistence = true) {
      if (erasePersistence) selectionStorage.revoke();
      cancel(); paused = true; resumeNeeded = false; resumeRequest = null; catalog = null; payload = lastGoodPayload = null; keyword = month = cutoffDate = benchmarkCompanyId = ""; companyChoices = []; pendingContext = null; pendingRestore = false;
      product = "lodging"; cutoffMode = draftCutoffMode = "auto"; draft = { ...initialView.draft }; appliedSelection = null; draftRevision++; listQuery = ""; listPage = 1; mobileView = "list"; expanded = {}; scopes = []; restoreAttempted = false; restoreNotice = ""; viewState.clear(); error = reason; errorCode = reason ? "KEYWORD_MONTHLY_AUTH_REQUIRED" : ""; render();
    }
    const failure = (code, status = 0, details = []) => Object.assign(new Error(code), { code, status, details });
    const safeCodes = value => {
      // JSON error bodies use both top-level codes and diagnostics. Only the
      // bounded code vocabulary is displayable; raw errors/messages are not.
      const candidates = [value?.code, value?.errorCode, ...(Array.isArray(value?.diagnostics) ? value.diagnostics.slice(0, 32) : [])
        .map(row => typeof row === "string" ? row : row?.code)], codes = [];
      for (const code of candidates) {
        if (typeof code === "string" && code.length <= 100 && /^(?:KEYWORD_|ANALYTICAL_|MONTHLY_|COMPANY_)[A-Z0-9_]+$/.test(code) && !codes.includes(code)) codes.push(code);
        if (codes.length === 4) break;
      }
      return codes;
    };
    const failureReasons = {
      KEYWORD_MONTHLY_MEMORY_DEFERRED: "메모리 보호로 저장 자료 조회를 잠시 보류했습니다. 잠시 후 다시 조회해 주세요.",
      ANALYTICAL_MEMORY_BUSY: "메모리 보호로 저장 자료 조회를 잠시 보류했습니다. 잠시 후 다시 조회해 주세요.",
      KEYWORD_MONTHLY_MEMORY_UNAVAILABLE: "서버 메모리 상태를 확인하지 못해 저장 자료 조회를 보류했습니다. 잠시 후 다시 조회해 주세요.",
      ANALYTICAL_MEMORY_UNAVAILABLE: "서버 메모리 상태를 확인하지 못해 저장 자료 조회를 보류했습니다. 잠시 후 다시 조회해 주세요.",
      KEYWORD_MONTHLY_QUERY_TIMEOUT: "저장 자료 조회 대기 시간이 초과됐습니다. 잠시 후 다시 조회해 주세요.",
      KEYWORD_MONTHLY_QUERY_BUSY: "진행 중인 조회·응답이 많아 저장 자료 조회를 잠시 보류했습니다. 잠시 후 다시 조회해 주세요.",
      KEYWORD_MONTHLY_RESPONSE_BUSY: "진행 중인 조회·응답이 많아 저장 자료 조회를 잠시 보류했습니다. 잠시 후 다시 조회해 주세요.",
      KEYWORD_MONTHLY_RESPONSE_TOO_LARGE: "저장 자료 응답 크기가 한도를 넘어 조회를 완료하지 못했습니다.",
      COMPANY_RESPONSE_TOO_LARGE: "저장 자료 응답 크기가 한도를 넘어 조회를 완료하지 못했습니다."
    };
    function failureLabel(value) {
      const details = safeCodes({ diagnostics: value?.details }), codes = [...new Set([value?.code, ...details].filter(Boolean))];
      const suffix = [value?.status ? `HTTP ${value.status}` : "", ...codes].filter(Boolean).join(" · ");
      const reason = codes.find(code => Object.hasOwn(failureReasons, code));
      const label = value?.code === "KEYWORD_MONTHLY_TIMEOUT" ? "저장 자료 조회 시간이 초과됐습니다. 잠시 후 저장 자료 조회를 다시 눌러 주세요."
        : value?.code === "KEYWORD_MONTHLY_INVALID_JSON" || value?.code === "KEYWORD_MONTHLY_RESPONSE_NOT_JSON" ? "서버가 올바른 저장 자료 응답을 보내지 못했습니다. 잠시 후 다시 조회해 주세요."
        : value?.code === "KEYWORD_MONTHLY_NETWORK_ERROR" ? "서버 연결을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요."
        : reason ? failureReasons[reason]
        : details.length ? "저장 자료의 최신 상태를 확인하지 못해 자료 검수가 필요합니다."
        : "저장 자료를 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.";
      return `${label}${suffix ? ` (${suffix})` : ""}`;
    }
    async function get(url, token) {
      const controller = active;
      let timer = null, timedOut = false;
      const read = (async () => {
        let response;
        try { response = await request(url, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, ...(controller ? { signal: controller.signal } : {}) }); }
        catch { if (!current(token) || timedOut) return null; throw failure("KEYWORD_MONTHLY_NETWORK_ERROR"); }
        if (!current(token) || timedOut) return null;
        const status = Number.isInteger(response?.status) ? response.status : 0;
        if ([401, 403].includes(status) || response?.redirected === true && /\/login(?:[?#]|$)/.test(String(response.url || ""))) { clearPrivate(); return null; }
        const contentType = typeof response?.headers?.get === "function" ? response.headers.get("content-type") || "" : null;
        // Real fetch responses always have Headers. Omitted headers remain
        // compatible with an injected, already-validated request adapter.
        const jsonType = contentType === null || /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType);
        if (!response?.ok && !jsonType) throw failure(`KEYWORD_MONTHLY_HTTP_${status || "ERROR"}`, status);
        if (!jsonType) throw failure("KEYWORD_MONTHLY_RESPONSE_NOT_JSON", status);
        let value;
        try { value = await response.json(); }
        catch { if (!current(token) || timedOut) return null; throw failure(response?.ok ? "KEYWORD_MONTHLY_INVALID_JSON" : `KEYWORD_MONTHLY_HTTP_${status || "ERROR"}`, status); }
        if (!current(token) || timedOut) return null;
        if (!response?.ok) throw failure(`KEYWORD_MONTHLY_HTTP_${status || "ERROR"}`, status, safeCodes(value));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("KEYWORD_MONTHLY_INVALID_JSON", status);
        return value;
      })();
      try {
        if (!schedule || !unschedule) return await read;
        return await Promise.race([read, new Promise((resolve, reject) => { timer = schedule(() => { timedOut = true; controller?.abort(); reject(failure("KEYWORD_MONTHLY_TIMEOUT")); }, timeoutMs); })]);
      } finally { if (timer !== null) unschedule?.(timer); }
    }
    function applyViewContext(requested) {
      if (Object.hasOwn(PRODUCTS, requested.product)) product = requested.product;
      const companyId = typeof requested.benchmarkCompanyId === "string" ? requested.benchmarkCompanyId : requested.companyId;
      if (typeof companyId === "string" && companyId.length <= 300 && !/[\u0000-\u001f\u007f]/.test(companyId)) benchmarkCompanyId = companyId;
      if (typeof requested.listQuery === "string") listQuery = requested.listQuery.slice(0, 200);
      if (Number.isSafeInteger(requested.listPage) && requested.listPage > 0) listPage = Math.min(requested.listPage, 10000);
      if (["list", "detail"].includes(requested.mobileView)) mobileView = requested.mobileView;
      if (requested.expanded && typeof requested.expanded === "object" && !Array.isArray(requested.expanded)) {
        const values = {};
        for (const key of Object.keys(requested.expanded).slice(0, 32)) { const prop = Object.getOwnPropertyDescriptor(requested.expanded, key); if (key.length <= 200 && /^(chart|support):/.test(key) && typeof prop?.value === "boolean") values[key] = prop.value; }
        expanded = values;
      }
    }
    function requestedCutoffMode(requested = {}, fallback = cutoffMode) {
      if (typeof requested.cutoffDate === "string" && requested.cutoffMode !== "auto") return "explicit";
      return ["auto", "explicit"].includes(requested.cutoffMode) ? requested.cutoffMode : fallback;
    }
    function applyCatalog(value, context, editRevision, overwriteDraft, restored = false) {
      const next = normalizeOptions(value, kstDay(now()));
      if (next.status !== "available" && !(next.status === "stale" && (hasDiagnostic(next.diagnostics, "PROJECTION_EXPIRED") || hasDiagnostic(next.diagnostics, "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT")))) throw failure("KEYWORD_MONTHLY_OPTIONS_UNAVAILABLE", 0, safeCodes(value));
      catalog = next;
      let requested = context || {};
      if (restored) {
        const recorded = catalog.keywords.find(item => item.keyword === requested.keyword);
        if (!recorded?.stayMonths.includes(requested.month)) {
          requested = {}; selectionStorage.clear();
          restoreNotice = "이전에 선택한 검색어·숙박월이 현재 저장 목록에 없어 기본 조건을 표시합니다.";
        } else {
          const supported = recorded.supportedCutoffs?.[requested.month], latest = cutoffFor(catalog, requested.keyword, requested.month);
          if (!dateValid(requested.cutoffDate) || requested.cutoffDate > catalog.currentDay
            || requested.cutoffDate > dataThroughDay(catalog, requested.keyword, requested.month)
            || supported && requested.cutoffDate !== supported) {
            requested = { ...requested, cutoffMode: "auto", cutoffDate: latest };
            restoreNotice = "이전 관측 마감일을 현재 저장 근거에 맞춰 조정했습니다.";
          }
        }
      }
      if (typeof requested.keyword === "string" && requested.keyword.length > 300 || typeof requested.month === "string" && requested.month.length > 7 || typeof requested.cutoffDate === "string" && requested.cutoffDate.length > 10) { error = "전달된 검색어·숙박월·관측 마감 조건을 확인해 주세요."; return false; }
      const word = typeof requested.keyword === "string" ? requested.keyword : keyword || catalog.keywords[0]?.keyword || "";
      const row = catalog.keywords.find(item => item.keyword === word);
      if (!row) { if (catalog.keywords.length) error = "저장 목록에 있는 정확한 검색어를 선택하세요."; return false; }
      const stayMonth = typeof requested.month === "string" ? requested.month : word === keyword && month ? month : row.stayMonths.includes(catalog.currentMonth) ? catalog.currentMonth : row.stayMonths[0] || "";
      changeScope(word, stayMonth);
      applyViewContext(requested);
      cutoffMode = requestedCutoffMode(requested);
      if (typeof requested.cutoffDate === "string" && cutoffMode !== "auto") cutoffDate = requested.cutoffDate;
      if (!row.stayMonths.includes(month)) { error = "선택한 검색어에 실제 숙박 관측이 있는 월을 선택하세요."; return false; }
      if (cutoffMode === "auto" || !cutoffDate) cutoffDate = cutoffFor(catalog, keyword, month);
      if (editRevision === draftRevision && overwriteDraft) { draft = selected(); draftCutoffMode = cutoffMode; }
      persistView(); return true;
    }
    const sameScope = (value, selection) => value?.request?.keyword === selection.keyword && value?.request?.month === selection.month && value?.request?.cutoffDate === selection.cutoffDate;
    function loadKey(context) {
      const mode = requestedCutoffMode(context || {});
      return JSON.stringify([context?.keyword ?? keyword, context?.month ?? month, mode === "auto" ? "auto" : context?.cutoffDate ?? cutoffDate]);
    }
    function load(context, { applyInput = false, renewCatalog = false, restored = false } = {}) {
      if (destroyed || !visible()) return Promise.resolve();
      const key = loadKey(context);
      if (pendingLoad?.key === key) {
        // Product/company/list controls are local to this shared data scope.
        // Apply the latest context now and keep it for an options response
        // that has not resolved yet; sharing a GET must not discard UI intent.
        if (context) { pendingLoad.context = { ...(pendingLoad.context || {}), ...context }; pendingLoad.restored = restored; applyViewContext(context); pendingContext = restored ? pendingLoad.context : null; pendingRestore = restored; rememberScope(); render(); }
        return pendingLoad.promise;
      }
      const editRevision = draftRevision, changesSelection = context && ["keyword", "month", "cutoffDate"].some(key => Object.hasOwn(context, key) && context[key] !== selected()[key]);
      const overwriteDraft = applyInput || !draftHasChanges() || changesSelection;
      cancel(); resumeNeeded = false; resumeRequest = null; payload = !changesSelection && sameScope(lastGoodPayload, selected()) ? lastGoodPayload : null; error = errorCode = ""; loading = true; phase = "data"; active = Abort ? new Abort() : null; const token = sequence;
      const task = { key, context, applyInput, restored, promise: null }; pendingLoad = task;
      task.promise = (async () => {
        try {
          if (!catalog || renewCatalog) { phase = "options"; render(); const value = await get("/api/keyword-monthly/options", token); if (!value || !current(token)) return; if (!applyCatalog(value, task.context || pendingContext, editRevision, overwriteDraft, task.restored)) return; }
          else if (!applyCatalog(catalog, task.context, editRevision, overwriteDraft, task.restored)) return;
          pendingContext = null; pendingRestore = false;
          if (!keyword || !month) return;
          if (!catalog.keywords.some(row => row.keyword === keyword && row.stayMonths.includes(month))) { error = "저장 목록에 있는 정확한 검색어와 실제 관측 숙박월을 선택하세요."; errorCode = "KEYWORD_MONTHLY_SELECTION_INVALID"; return; }
          if (!dateValid(cutoffDate) || cutoffDate > catalog.currentDay) { error = "관측 마감일은 오늘 이하의 유효한 날짜로 선택하세요."; errorCode = "KEYWORD_MONTHLY_SELECTION_INVALID"; return; }
          payload = sameScope(lastGoodPayload, selected()) ? lastGoodPayload : null;
          appliedSelection = selected(); task.key = loadKey(); phase = "data"; rememberScope(); render();
          const params = new URLSearchParams(appliedSelection); const value = await get(`/api/keyword-monthly?${params}`, token);
          if (value && current(token)) {
            payload = value;
            if (buildViewModel(value, selected(), catalog.currentMonth).usable) lastGoodPayload = value;
            else if (sameScope(lastGoodPayload, selected())) lastGoodPayload = null;
          }
        } catch (cause) { if (current(token)) { errorCode = /^KEYWORD_MONTHLY_[A-Z0-9_]{1,75}$/.test(cause?.code || "") ? cause.code : "KEYWORD_MONTHLY_NETWORK_ERROR"; error = failureLabel(errorCode === cause?.code ? cause : failure(errorCode)); } }
        finally { if (pendingLoad === task) pendingLoad = null; if (token === sequence && !destroyed) { loading = false; phase = ""; active = null; render(); } }
      })();
      return task.promise;
    }
    async function open(context = null) {
      paused = false; let restored = pendingRestore && !keyword && (!context || context === pendingContext);
      if (restored) context = pendingContext;
      // Explicit navigation context wins over a remembered selection. A full
      // reload must still read current options and data; only inputs are saved.
      if (!restoreAttempted && !keyword) {
        restoreAttempted = true;
        if (!context) { const saved = selectionStorage.read(); if (saved) { context = saved; restored = true; } }
      }
      if (!restored) restoreNotice = "";
      pendingContext = context; pendingRestore = restored; return load(context, { renewCatalog: true, restored });
    }
    function editDraft(name, value) { draft = { ...draft, [name]: String(value).slice(0, name === "keyword" ? 300 : name === "month" ? 7 : 10) }; if (name === "cutoffDate") draftCutoffMode = "explicit"; draftRevision++; persistView(); }
    async function applyDraft(renewCatalog = false) {
      restoreNotice = "";
      if (catalog && !catalog.keywords.some(row => row.keyword === draft.keyword && row.stayMonths.includes(draft.month))) { cancel(); payload = null; error = "저장 목록에 있는 정확한 검색어와 실제 관측 숙박월을 선택하세요."; render(); return; }
      if (!dateValid(draft.cutoffDate) || draft.cutoffDate > (catalog?.currentDay || kstDay(now()))) { cancel(); payload = null; error = "관측 마감일은 오늘 이하의 유효한 날짜로 선택하세요."; render(); return; }
      const context = { ...draft, cutoffMode: draftCutoffMode }; pendingContext = null;
      return load(context, { applyInput: true, renewCatalog });
    }
    for (const [name, input] of [["keyword", keywordInput], ["month", monthInput], ["cutoffDate", cutoffInput]]) input.addEventListener("input", () => editDraft(name, input.value));
    keywordInput.addEventListener("change", () => {
      const word = keywordInput.value, row = catalog?.keywords.find(item => item.keyword === word), stayMonth = row?.stayMonths.includes(catalog.currentMonth) ? catalog.currentMonth : row?.stayMonths[0] || "";
      const saved = scopes.find(item => item.key === scopeKey(word, stayMonth)); draftCutoffMode = saved?.cutoffMode || "auto";
      draft = { keyword: word, month: stayMonth, cutoffDate: draftCutoffMode === "explicit" ? saved.cutoffDate : stayMonth ? cutoffFor(catalog, word, stayMonth) : "" }; draftRevision++; persistView(); render();
    });
    monthInput.addEventListener("change", () => {
      const stayMonth = monthInput.value, word = draft.keyword, saved = scopes.find(item => item.key === scopeKey(word, stayMonth)); draftCutoffMode = saved?.cutoffMode || "auto";
      draft = { keyword: word, month: stayMonth, cutoffDate: draftCutoffMode === "explicit" ? saved.cutoffDate : MONTH.test(stayMonth) && catalog ? cutoffFor(catalog, word, stayMonth) : "" }; draftRevision++; persistView(); render();
    });
    companyInput.addEventListener("change", () => chooseCompany(companyInput.value));
    cutoffInput.addEventListener("change", () => { editDraft("cutoffDate", cutoffInput.value); render(); });
    filters.addEventListener("submit", event => { event.preventDefault(); void applyDraft(true); });
    const onVisibility = () => {
      if (!visible()) {
        if (loading) {
          resumeRequest = { context: phase === "options" ? pendingLoad?.context || pendingContext : externalSelection(), renewCatalog: phase === "options", applyInput: pendingLoad?.applyInput === true, restored: pendingLoad?.restored === true };
          resumeNeeded = true; cancel(); render();
        }
      } else if (!loading && !error && (resumeNeeded || !catalog || !payload)) {
        const resume = resumeRequest; resumeNeeded = false; resumeRequest = null;
        if (resume) void load(resume.context, { renewCatalog: resume.renewCatalog, applyInput: resume.applyInput, restored: resume.restored });
        else if (catalog) void load(); else void open(pendingContext);
      }
    };
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => { if (!allowed()) clearPrivate(); else if (visible() && !catalog && !loading && !error) void open(pendingContext); }) : null;
    observer?.observe(doc.body, { attributes: true, attributeFilter: ["class"] }); doc.addEventListener("visibilitychange", onVisibility);
    const controller = { open, refresh: () => load(), pause() { rememberScope(); cancel(); paused = true; resumeNeeded = false; resumeRequest = null; payload = null; render(); }, clear: clearPrivate,
      state: () => ({ selection: externalSelection(), draft: { ...draft }, applied: appliedSelection ? { ...appliedSelection } : null, cutoffMode, product, benchmarkCompanyId, listQuery, listPage, mobileView, expanded: { ...expanded }, viewState: viewState.snapshot(), loading, paused, status: payload?.status || null, errorCode, showingStored: Boolean(!paused && payload === lastGoodPayload && sameScope(payload, selected()) && (loading || error || resumeNeeded)) }),
      destroy() { if (destroyed) return; clearPrivate("", false); destroyed = true; observer?.disconnect(); doc.removeEventListener("visibilitychange", onVisibility); panel.replaceChildren(); controllers.delete(controller); instances.delete(parent); } };
    controllers.add(controller); instances.set(parent, controller);
    render(); if (options.autoStart !== false && visible()) void open(options.context || null); return controller;
  }
  const api = { mount, normalizeOptions, metricView, calendarCells, buildViewModel, number, rate, money, dateValid, defaultCutoff, dataThroughDay, cutoffFor, phaseLabel, createSelectionStorage,
    async configure(session, flags) {
      if (!selectionStorage.matches(session, flags)) for (const controller of controllers) controller.clear();
      return selectionStorage.configure(session, flags);
    },
    getSelection(parent) { return instances.get(parent)?.state().selection || null; },
    show(parent, context) { if (!parent) return null; const controller = instances.get(parent) || mount(parent, { autoStart: false }); return controller?.open(context) || null; },
    pause(parent) { if (parent) instances.get(parent)?.pause(); else for (const controller of controllers) controller.pause(); },
    clear() { selectionStorage.revoke(); for (const controller of controllers) controller.clear(); } };
  root.KeywordMonthlyAnalysis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
