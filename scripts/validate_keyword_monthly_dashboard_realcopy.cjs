"use strict";
// Explicit local QA over an existing complete normalized copy and its prepared
// projections. Never starts a server, collector, application, KOSIS or child.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict"), vm = require("node:vm");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), preview = require("./preview_keyword_monthly_realcopy.cjs");
const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
const REPO = path.resolve(__dirname, ".."), hash = value => crypto.createHash("sha256").update(value).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
const known = value => typeof value === "number" && Number.isFinite(value), ratio = (a, b) => known(a) && known(b) && b > 0 ? a / b : null;
const sum = (rows, key) => rows.length && rows.every(row => known(row[key])) ? rows.reduce((a, b) => a + b[key], 0) : null;
function args(values) {
  const out = {}, keys = new Set(["source", "projection-dir", "output", "now"]);
  for (let i = 0; i < values.length; i += 2) { const key = values[i]?.slice(2); H.need(values[i]?.startsWith("--") && keys.has(key) && !Object.hasOwn(out, key) && values[i + 1], "KEYWORD_DASHBOARD_QA_ARGUMENTS"); out[key] = values[i + 1]; }
  for (const key of ["source", "projection-dir", "output"]) { H.need(typeof out[key] === "string" && path.isAbsolute(out[key]), "KEYWORD_DASHBOARD_QA_ARGUMENTS"); out[key] = path.resolve(out[key]); H.absolute(out[key]); }
  H.need(H.validIso(out.now) && path.extname(out.output) === ".json" && !H.inside(out["projection-dir"], out.output) && !H.inside(path.join(REPO, "web"), out.output) && !H.inside(path.join(REPO, "scripts"), out.output), "KEYWORD_DASHBOARD_QA_ARGUMENTS");
  return out;
}
function quantityEligible(row) {
  if (!["complete", "reused"].includes(row?.runQuality) || ["partial", "missing", "error", "failed", "sharedDayUseIncomplete", "recalculationUnavailable", "inventoryConflict", "capacityConflict"].some(key => row[key] === true) || known(row.unknownUnavailable) && row.unknownUnavailable > 0) return false;
  return ["supply", "sold", "publicBookings", "phoneBookings"].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0) && row.sold <= row.supply && row.sold === row.publicBookings + row.phoneBookings;
}
function expectedMetrics(rows) {
  const supply = sum(rows, "supply"), sold = sum(rows, "sold"), publicBookings = sum(rows, "publicBookings"), phoneBookings = sum(rows, "phoneBookings");
  return { supply, sold, publicBookings, phoneBookings, publicRate: ratio(publicBookings, supply), phoneRate: ratio(phoneBookings, supply), totalRate: ratio(sold, supply), observedCompanyDays: rows.length };
}
function compareMetrics(actual, expected, label) { for (const [key, value] of Object.entries(expected)) assert.equal(actual[key] ?? null, value, `${label}.${key}`); }
function guardNetwork() {
  let attempts = 0; const restores = [], patch = (object, key) => { const old = object[key]; if (typeof old !== "function") return; object[key] = () => { attempts++; throw Object.assign(Error("KEYWORD_DASHBOARD_QA_NETWORK_DENIED"), { code: "KEYWORD_DASHBOARD_QA_NETWORK_DENIED" }); }; restores.push(() => { object[key] = old; }); };
  patch(globalThis, "fetch"); patch(globalThis, "WebSocket"); for (const name of ["node:http", "node:https"]) for (const key of ["request", "get"]) patch(require(name), key);
  for (const key of ["connect", "createConnection"]) patch(require("node:net"), key); patch(require("node:net").Socket.prototype, "connect"); patch(require("node:tls"), "connect");
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(require("node:child_process"), key);
  return { attempts: () => attempts, restore: () => { for (const next of restores.reverse()) next(); } };
}
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ""; this._text = ""; this.value = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this.style = {}; this.classList = { contains: key => this.className.split(/\s+/).includes(key), add: (...keys) => { this.className = [...new Set([...this.className.split(/\s+/), ...keys])].join(" "); }, remove: (...keys) => { this.className = this.className.split(/\s+/).filter(k => !keys.includes(k)).join(" "); } }; }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; } get textContent() { return this._text; }
  append(...values) { for (const node of values) { node.parentNode = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...values) { this._text = ""; this.children = []; this.append(...values); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, callback) { (this.listeners[key] ||= []).push(callback); }
  removeEventListener(key, callback) { this.listeners[key] = (this.listeners[key] || []).filter(fn => fn !== callback); }
  getClientRects() { let node = this; while (node) { if (node.hidden || node.screenHidden) return []; node = node.parentNode; } return [{}]; }
  getBoundingClientRect() { return { width: 1200, height: 600, top: 0, left: 0, right: 1200, bottom: 600 }; }
  async fire(type) { if (type === "click" && this.disabled) return; for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {} }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)], flattenText = node => descendants(node).map(row => row.textContent).join(" ");
async function vmInteraction({ catalog, payload, now, scripts }) {
  const calls = [], listeners = {}, doc = { hidden: false, readyState: "complete", addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } }; let chartLoaderAttempts = 0;
  doc.createElement = tag => new Element(tag, doc); doc.createElementNS = (ns, tag) => new Element(tag, doc); doc.body = doc.createElement("body"); doc.body.className = "role-admin"; doc.head = doc.createElement("head");
  doc.getElementById = id => descendants(doc.body).find(row => row.id === id) || descendants(doc.head).find(row => row.id === id) || null;
  doc.querySelector = selector => selector.startsWith("#") ? doc.getElementById(selector.slice(1)) : null;
  const parent = doc.createElement("div"); doc.body.append(parent);
  const request = async (url, settings) => { calls.push({ url, settings }); const u = new URL(url, "http://127.0.0.1"); const value = u.pathname.endsWith("/options") ? catalog : payload; if (!u.pathname.endsWith("/options")) assert.deepEqual(Object.fromEntries(u.searchParams), payload.request); return { ok: true, status: 200, json: async () => clone(value) }; };
  // A rejected chart loader proves only graceful fallback logic, never visual
  // rendering or browser chart availability. Root performs actual browser QA.
  const window = { fetch: request, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, requestAnimationFrame: fn => { setImmediate(fn); return 1; }, cancelAnimationFrame() {}, KeywordMonthlyCharts: { mount: async () => { chartLoaderAttempts++; throw Error("QA_CHART_LIBRARY_UNAVAILABLE"); } } };
  class MutationObserver { observe() {} disconnect() {} } class ResizeObserver { observe() {} disconnect() {} }
  const context = { window, document: doc, MutationObserver, ResizeObserver, Date, Intl, URLSearchParams, URL, console, setTimeout, clearTimeout, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame() {}, AbortController };
  for (const text of scripts) vm.runInNewContext(text, context);
  const api = window.KeywordMonthlyAnalysis, controller = api.mount(parent, { autoStart: false, fetch: request, now: () => Date.parse(now) });
  await controller.open(); for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  const field = () => descendants(parent).find(row => row.name === "benchmarkCompany"), initialCalls = calls.length;
  assert.equal(initialCalls, 2); assert.ok(field(), "top company selector exists");
  const selectable = field().children.filter(row => row.tagName === "OPTION" && row.value); assert.equal(selectable.length, payload.snapshot.companies.length, "selector contains every snapshot company, no top20 limit");
  assert.ok(selectable.length > 20); const ids = [selectable[0].value, selectable[Math.floor(selectable.length / 2)].value, selectable.at(-1).value];
  const choices = [];
  for (const companyId of ids) { field().value = companyId; await field().fire("change"); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(controller.state().benchmarkCompanyId, companyId); assert.equal(calls.length, initialCalls); choices.push(companyId); }
  assert.ok(flattenText(parent).length > 100, "failed/absent chart library does not erase saved figures and selection");
  assert.match(flattenText(parent), /\d+(?:[.,]\d+)?%/, "readable saved rate figures remain present independently of chart rendering"); api.pause(parent);
  return { status: "passed_vm_interaction", scope: "Node DOM fixture interaction using real prepared payload; not actual browser or visual chart proof", initialSavedGetCalls: initialCalls, extraRequestsOnCompanyChanges: calls.length - initialCalls, selectorCompanies: selectable.length, checkedCompanyIds: choices, chartLoaderAttempts, gracefulChartFailureExercised: chartLoaderAttempts > 0, chartLibrary: chartLoaderAttempts ? "explicit unavailable-loader fixture; root browser validation remains required" : "this script did not invoke the injected loader; chart fallback remains unverified" };
}
async function run(input) {
  const config = args(input); await H.checked(path.dirname(config.output), true); try { await fs.lstat(config.output); throw Object.assign(Error("KEYWORD_DASHBOARD_QA_OUTPUT_EXISTS"), { code: "KEYWORD_DASHBOARD_QA_OUTPUT_EXISTS" }); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let read = await H.read(config.source, 64 * 1024 * 1024); const source = { file: config.source, bytes: read.bytes.length, sha256: read.sha256, companyCount: read.value.companies.length, runCount: read.value.runs.length, observationCount: read.value.observations.length }; read = null; global.gc?.();
  const before = await preview.projectionManifest(config["projection-dir"]), scripts = await Promise.all(["web/keyword-monthly-benchmark.js", "web/keyword-monthly-dashboard-model.js", "web/keyword-monthly-analysis.js"].map(async name => ({ file: path.join(REPO, name), text: await fs.readFile(path.join(REPO, name), "utf8") })));
  const { buildKeywordMonthlyDashboardModel: build } = require("../web/keyword-monthly-dashboard-model.js"), guard = guardNetwork();
  try {
    const service = createKeywordMonthlyAnalysis({ projectionDir: config["projection-dir"], now: () => new Date(config.now) }), catalog = await service.options(), cases = []; assert.ok(["available", "stale"].includes(catalog.status));
    for (const keywordRow of catalog.keywords) for (const month of keywordRow.stayMonths) {
      const query = { keyword: keywordRow.keyword, month, cutoffDate: keywordRow.defaultCutoffs[month] }, payload = await service.analyze(query); assert.ok(["available", "stale"].includes(payload.status) && payload.snapshot); assert.equal(payload.provenance.inputSha256, source.sha256);
      const snapshot = payload.snapshot, unchanged = hash(JSON.stringify(snapshot)), roster = snapshot.companies.map(c => c.companyId), productCases = [];
      for (const productType of ["lodging", "dayuse"]) {
        const eligible = snapshot.sources.observations.filter(r => r.productType === productType && quantityEligible(r)), unique = eligible.map(r => JSON.stringify([r.companyId, r.date, r.productType])); assert.equal(new Set(unique).size, unique.length);
        const baseline = build(snapshot, { productType, companyId: roster[0] }); assert.ok(["available", "missing"].includes(baseline.status));
        assert.deepEqual(baseline.companies.map(c => c.companyId), roster); assert.equal(baseline.companies.length, roster.length); compareMetrics(baseline.monthly.whole, expectedMetrics(eligible), "monthly.whole");
        const whole = hash(JSON.stringify(baseline.monthly.whole)), equal = hash(JSON.stringify(baseline.monthly.equalCompany?.all)); let gaps = 0, observedZero = 0, checked = 0;
        for (const companyId of roster) {
          const model = build(snapshot, { productType, companyId }), mine = eligible.filter(row => row.companyId === companyId); assert.equal(model.selectedCompanyId, companyId); compareMetrics(model.monthly.selected, expectedMetrics(mine), `selected.${companyId}`);
          assert.equal(hash(JSON.stringify(model.monthly.whole)), whole); assert.equal(hash(JSON.stringify(model.monthly.equalCompany?.all)), equal); assert.equal(model.monthly.includesSelected, true);
          const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate(); assert.equal(model.daily.length, days); assert.equal(new Set(model.daily.map(d => d.date)).size, days);
          for (const day of model.daily) {
            const rows = eligible.filter(row => row.date === day.date), selectedRows = mine.filter(row => row.date === day.date), peers = rows.filter(row => row.companyId !== companyId), selected = expectedMetrics(selectedRows), all = expectedMetrics(rows), other = expectedMetrics(peers);
            assert.equal(day.selectedRate, selected.totalRate); assert.equal(day.selectedPublicRate, selected.publicRate); assert.equal(day.selectedPhoneRate, selected.phoneRate);
            assert.equal(day.wholeRate, all.totalRate); assert.equal(day.wholePublicRate, all.publicRate); assert.equal(day.wholePhoneRate, all.phoneRate);
            assert.equal(day.peerRate, other.totalRate); assert.equal(day.peerPublicRate, other.publicRate); assert.equal(day.peerPhoneRate, other.phoneRate);
            assert.equal(day.wholeCompanyCount, new Set(rows.map(r => r.companyId)).size); assert.equal(day.peerCompanyCount, new Set(peers.map(r => r.companyId)).size); assert.equal(day.rosterCompanyCount, roster.length);
            assert.equal(day.wholeCoverageRate, ratio(day.wholeCompanyCount, roster.length)); assert.equal(day.peerCoverageRate, ratio(day.peerCompanyCount, roster.length - 1));
            assert.equal(day.selectedObserved, selectedRows.length > 0); assert.equal(day.wholeObserved, rows.length > 0); assert.equal(day.peerObserved, peers.length > 0);
            assert.equal(day.difference, known(selected.totalRate) && known(all.totalRate) ? selected.totalRate - all.totalRate : null);
            assert.equal(day.peerDifference, known(selected.totalRate) && known(other.totalRate) ? selected.totalRate - other.totalRate : null);
            if (!selectedRows.length) { assert.equal(day.selectedRate, null); assert.equal(day.selectedObserved, false); assert.equal(day.difference, null); gaps++; }
            else if (selected.supply > 0 && selected.sold === 0) { assert.equal(day.selectedRate, 0); observedZero++; } checked++;
          }
        }
        assert.equal(hash(JSON.stringify(snapshot)), unchanged, "dashboard never mutates financial/source snapshot");
        productCases.push({ productType, rosterCompanies: roster.length, allCompaniesPreserved: true, companySelectionCases: roster.length, ratioDefinition: "sum eligible bookings / sum eligible supply; not daily-rate arithmetic mean", wholeSelectionInvariant: true, dailyCompanyPointsChecked: checked, absentCompanyDatesPreservedNull: gaps, genuinelyObservedZeroDates: observedZero, whole: baseline.monthly.whole });
      }
      const onlyCatalog = { ...catalog, keywords: [keywordRow], currentDay: config.now.slice(0, 10) }, selectedCatalog = { ...onlyCatalog, keywords: [{ ...keywordRow, stayMonths: [month] }] };
      const interaction = snapshot.companies.length > 20 ? await vmInteraction({ catalog: selectedCatalog, payload, now: config.now, scripts: scripts.map(r => r.text) }) : { status: "not_applicable_under21_roster", rosterCompanies: snapshot.companies.length };
      cases.push({ query, resultId: payload.resultId, dataThrough: payload.provenance.dataThrough, snapshotFingerprint: unchanged, snapshotUnchanged: hash(JSON.stringify(snapshot)) === unchanged, productCases, interaction });
    }
    const after = await preview.projectionManifest(config["projection-dir"]), sourceAfter = await H.read(config.source, 64 * 1024 * 1024); assert.equal(sourceAfter.sha256, source.sha256); assert.equal(after.manifestSha256, before.manifestSha256); assert.equal(guard.attempts(), 0);
    for (const script of scripts) assert.equal(hash(await fs.readFile(script.file, "utf8")), hash(script.text), "QA code/assets changed while the observation ran");
    const result = { schemaVersion: 1, status: "verified_historical_complete_realcopy_dashboard_logic", observedAt: new Date().toISOString(), fixedNow: config.now, source: { ...source, afterSha256: sourceAfter.sha256, unchanged: true }, projectionDir: config["projection-dir"], projectionBeforeSha256: before.manifestSha256, projectionAfterSha256: after.manifestSha256, projectionUnchanged: true, cases, sourceCode: scripts.map(r => ({ file: r.file, sha256: hash(r.text), bytes: Buffer.byteLength(r.text) })), providerCalls: 0, kosisCalls: 0, outboundAttempts: 0, applicationStarted: false, serverStarted: false, operatingChanged: false, actualBrowserVerified: false, limitations: ["Historical complete normalized copy and matching prepared projections, not current production state.", "Node VM DOM verifies company changes without requests and readable fallback only; chart rendering, responsive layout, toolbar ergonomics and screenshots require actual local-browser QA.", "Existing adopted-source eligibility is independently checked for ratio sums, not an independent original-data normalization or full-market audit."] };
    const handle = await fs.open(config.output, "wx", 0o600); try { await handle.writeFile(JSON.stringify(result, null, 2)); await handle.sync(); } finally { await handle.close(); }
    return result;
  } finally { guard.restore(); }
}
module.exports = { args, run, quantityEligible, expectedMetrics, compareMetrics, vmInteraction };
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify({ status: result.status, cases: result.cases.length, outboundAttempts: 0, actualBrowserVerified: false }))).catch(error => { console.error(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : error.name, message: String(error.message).slice(0, 500) })); process.exitCode = 1; });
