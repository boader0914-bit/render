"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { SPECS, buildRegionalMarketSnapshot, validateRegionalMarketSnapshot } = require("./lib/regional_market.cjs");
const { createRegionalMarketService, keyFor, completedMonth, MAX_POINTER_BYTES, MAX_RESULT_BYTES } = require("./lib/regional_market_store.cjs");
const { createRegionalMarketHttpHandler } = require("./lib/regional_market_http.cjs");
const NOW = "2026-10-26T01:00:00.000Z", THEN = "2026-10-17T12:00:00.000Z";
const region = { regionKey: "synthetic_county", label: "모의도 모의군", officialCode: "1111100000", level: "local", unitType: "county", active: true, selectable: true };
const scope = { regionKey: region.regionKey, label: region.label, month: "2026-09", months: 13 };
const sha = x => crypto.createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const checks = ["safe_original_path", "original_sha256", "source_table_and_period", "metadata_region_ancestry", "raw_region_code", "metric_unit_and_period", "stored_metric_values"];
function fixture() {
  return { schemaVersion: 1, calculationVersion: "regional-analysis-v1", contractVersion: "regional-data-contract-v1", resultId: "12345678-1234-4234-8234-123456789abc", sourceFingerprint: "a".repeat(64),
    generatedAt: THEN, builtAt: THEN, status: "partial", networkAttempted: false, scope: { ...scope }, regionIdentity: { regionKey: region.regionKey, officialCode: region.officialCode, level: "local", unitType: "county" },
    groups: [{ key: "kosis", provider: "KOSIS", datasets: SPECS.map((spec, index) => ({ key: spec.datasetKey, periodType: spec.periodType,
      period: spec.periodType === "M" ? "2026-09" : "2024", retrievedAt: THEN, storedEvidenceVerification: { status: "restored", reasonCode: "" },
      spatialContract: { version: "regional-data-contract-v1", requestedRegionKey: region.regionKey, officialCode: region.officialCode, requestedLevel: "sigungu", requestedUnitType: "county", provider: "KOSIS", providerRegionCode: "11111", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none",
        storedProvenance: { version: "stored-kosis-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "synthetic-proof", sha256: "b".repeat(64), period: spec.periodType === "M" ? "2026-09" : "2024", periodType: spec.periodType, verifiedAt: THEN, checks } },
      rows: [{ key: spec.metricKey, unit: spec.unit, status: "observed", value: index }] })) }] };
}
function project(savedSnapshot = fixture()) { return buildRegionalMarketSnapshot({ region, scope, savedSnapshot, source: { resultSha256: sha(savedSnapshot) }, now: () => NOW }); }
test("saved administrative totals retain source periods, proof, true zero and explicit unknown boundary and origins", () => {
  const source = fixture(), bytes = JSON.stringify(source), value = project(source);
  assert.equal(JSON.stringify(source), bytes); assert.equal(value.mode, "administrative_region"); assert.equal(value.originKind, "administrative_region");
  assert.equal(value.scope.boundaryYear, null); assert.equal(value.scope.boundaryYearStatus, "unrecorded"); assert.equal(value.status, "partial");
  assert.equal(value.metrics[0].value, 0); assert.equal(value.metrics[0].status, "observed"); assert.equal(value.metrics[2].periodType, "Y"); assert.equal(value.metrics[2].period, "2024");
  assert.equal(value.generatedAt, THEN); assert.equal(value.source.generatedAt, THEN); assert.equal(value.observedAt, NOW);
  assert.deepEqual(value.visitorOrigins, { status: "not_acquired", value: null, reasonCode: "VISITOR_ORIGINS_NOT_AVAILABLE" });
  assert.equal(value.networkAttempted, false); assert.equal(value.readOnly, true); assert.equal(value.rings, undefined); assert.equal(value.scope.center, undefined);
  assert.equal(validateRegionalMarketSnapshot(value), value);
});
test("missing saved results expose six missing values and never require a detailed address or coordinate", () => {
  const value = project(null); assert.equal(value.status, "missing"); assert.equal(value.source.resultId, null);
  assert.ok(value.metrics.every(m => m.status === "missing" && m.value === null)); validateRegionalMarketSnapshot(value);
});
test("unverified request echoes, wrong geography, proof period, frequency and rejected original all fail closed", () => {
  const mutations = [d => { d.spatialContract.status = "scope_unverified"; }, d => { d.spatialContract.requestedRegionKey = "another"; },
    d => { d.spatialContract.officialCode = "2222200000"; }, d => { d.spatialContract.aggregation = "sum_children"; },
    d => { d.spatialContract.storedProvenance.period = "2026-08"; }, d => { d.spatialContract.storedProvenance.periodType = "Y"; },
    d => { d.spatialContract.storedProvenance.checks = ["hash"]; }, d => { d.storedEvidenceVerification.status = "rejected"; },
    d => { d.rows[0].value = -1; }, d => { d.period = "2026-10"; }, d => { d.retrievedAt = "unknown"; }];
  for (const change of mutations) { const saved = fixture(); change(saved.groups[0].datasets[0]); const value = project(saved); assert.equal(value.status, "needs_verification"); assert.equal(value.metrics[0].status, "unverified"); assert.equal(value.metrics[0].value, null); validateRegionalMarketSnapshot(value); }
});
test("missing, partial, suppressed, pending and actual errors remain distinct and cannot become zero", () => {
  const saved = fixture(), states = ["missing", "partial", "suppressed", "publication_pending", "error", "failed"];
  saved.groups[0].datasets.forEach((d, index) => { d.rows[0].status = states[index]; d.rows[0].value = 0; });
  const value = project(saved); assert.deepEqual(value.metrics.map(m => m.status), ["missing", "partial", "suppressed", "publication_pending", "error", "error"]);
  assert.ok(value.metrics.every(m => m.value === null)); validateRegionalMarketSnapshot(value);
});
test("optional table identity, mapping and row period must match existing definitions and original proof", () => {
  for (const mutate of [d => { d.tableId = "DT_wrong"; }, d => { d.orgId = "999"; }, d => { d.sourceUrl = "https://another.invalid/"; },
    d => { d.definition = { tableId: "wrong" }; }, d => { d.source = { orgId: "wrong" }; }, d => { d.mapping = { code: "another" }; },
    d => { d.rows[0].period = "202608"; }, d => { d.rows[0].periodType = "Y"; }]) {
    const saved = fixture(); mutate(saved.groups[0].datasets[0]); const result = project(saved); assert.equal(result.metrics[0].status, "unverified"); assert.equal(result.metrics[0].value, null);
  }
  const saved = fixture(), d = saved.groups[0].datasets[0]; Object.assign(d, { tableId: "DT_1B040A3", orgId: "101", sourceUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_1B040A3", mapping: { code: "11111" } });
  d.rows[0].period = "202609"; assert.equal(project(saved).metrics[0].status, "observed");
});
test("duplicate datasets and metric rows are errors, never summed or arbitrarily selected", () => {
  let saved = fixture(); saved.groups[0].datasets.push(saved.groups[0].datasets[0]); assert.equal(project(saved).metrics[0].status, "error");
  saved = fixture(); saved.groups[0].datasets[0].rows.push(saved.groups[0].datasets[0].rows[0]); assert.equal(project(saved).metrics[0].status, "error");
});
test("unsupported scope, changed canonical identity and networked source are rejected", () => {
  for (const changed of [{ ...region, level: "broad" }, { ...region, unitType: "general_district" }, { ...region, officialCode: "" }]) assert.throws(() => buildRegionalMarketSnapshot({ region: changed, scope }), { code: "REGIONAL_MARKET_INVALID_SCOPE" });
  for (const change of [s => { s.scope.months = 24; }, s => { s.regionIdentity.officialCode = "2222200000"; }, s => { s.networkAttempted = true; }]) { const saved = fixture(); change(saved); assert.throws(() => project(saved), { code: "REGIONAL_MARKET_SOURCE_SCOPE_MISMATCH" }); }
});
test("validator rejects altered numbers, extra radius interpretation, foreign table and future evidence", () => {
  const value = project(); assert.throws(() => validateRegionalMarketSnapshot(value, { asOfAt: "2026-10-16T00:00:00Z" }), { code: "REGIONAL_MARKET_RESULT_INVALID" });
  validateRegionalMarketSnapshot(value, { regionKey: region.regionKey, month: scope.month, asOfAt: THEN });
  for (const alter of [x => { x.metrics[0].value = 9; }, x => { x.scope.center = { latitude: 0, longitude: 0 }; }, x => { x.rings = []; }, x => { x.metrics[0].source.tableId = "foreign"; }, x => { x.status = "ready"; }]) {
    const copy = structuredClone(value); alter(copy); assert.throws(() => validateRegionalMarketSnapshot(copy), { code: "REGIONAL_MARKET_RESULT_INVALID" });
  }
});
async function storeFixture(t, saved = fixture()) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-market-")); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const key = keyFor(scope), pointer = path.join(dataDir, "regional_analysis", "latest", key + ".json"), result = path.join(dataDir, "regional_analysis", "results", key, saved.resultId + ".json");
  await fs.mkdir(path.dirname(pointer), { recursive: true }); await fs.mkdir(path.dirname(result), { recursive: true });
  await fs.writeFile(pointer, JSON.stringify({ schemaVersion: 1, scopeKey: key, resultId: saved.resultId, revisions: [] })); await fs.writeFile(result, JSON.stringify(saved));
  const service = createRegionalMarketService({ dataDir, resolveRegion: async key => key === region.regionKey ? region : null, now: () => NOW });
  return { dataDir, pointer, result, service };
}
test("reader resolves one saved scope without initializing queues, writes, source scans or provider calls", async t => {
  const f = await storeFixture(t), before = await fs.readFile(f.result), pointerBefore = await fs.readFile(f.pointer);
  const a = await f.service.get({ regionKey: region.regionKey }), b = await f.service.get({ regionKey: region.regionKey, month: scope.month, months: 13 });
  assert.deepEqual(a, b); assert.equal(a.source.resultSha256, sha(before.toString())); assert.deepEqual(await fs.readFile(f.result), before); assert.deepEqual(await fs.readFile(f.pointer), pointerBefore);
  await assert.rejects(fs.access(path.join(f.dataDir, "regional_analysis", "queue.json")), { code: "ENOENT" });
  assert.equal((await f.service.get({ regionKey: region.regionKey, months: 24 })).status, "missing");
});
test("reader never creates missing directories or silently falls back when a pointed result is absent", async t => {
  const f = await storeFixture(t); await fs.unlink(f.result); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_MISSING" });
  await fs.unlink(f.pointer); assert.equal((await f.service.get({ regionKey: region.regionKey })).status, "missing");
  const absent = path.join(f.dataDir, "does-not-exist"), service = createRegionalMarketService({ dataDir: absent, resolveRegion: async () => region, now: () => NOW });
  assert.equal((await service.get({ regionKey: region.regionKey })).status, "missing"); await assert.rejects(fs.access(absent), { code: "ENOENT" });
});
test("reader rejects future saved generation, retrieval and original verification timestamps", async t => {
  for (const mutate of [s => { s.generatedAt = "2026-10-27T00:00:00Z"; }, s => { s.groups[0].datasets[0].retrievedAt = "2026-10-27T00:00:00Z"; },
    s => { s.groups[0].datasets[0].spatialContract.storedProvenance.verifiedAt = "2026-10-27T00:00:00Z"; }]) {
    const saved = fixture(); mutate(saved); const f = await storeFixture(t, saved); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_RESULT_INVALID" });
  }
});
test("reader rejects a leaf replaced after path validation and before opening the descriptor", async t => {
  const f = await storeFixture(t), originalOpen = fs.open; let replaced = false;
  fs.open = async function(filename, ...args) {
    if (filename === f.result && !replaced) { replaced = true; await fs.rename(f.result, f.result + ".old"); await fs.writeFile(f.result, JSON.stringify(fixture())); }
    return originalOpen.call(this, filename, ...args);
  };
  try { await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_EVIDENCE_CHANGED" }); }
  finally { fs.open = originalOpen; }
  assert.equal(replaced, true);
});
test("reader rejects oversized files, invalid UTF8, invalid pointer and a wrong result identity", async t => {
  const f = await storeFixture(t), pointer = await fs.readFile(f.pointer), saved = await fs.readFile(f.result);
  await fs.writeFile(f.pointer, Buffer.alloc(MAX_POINTER_BYTES + 1)); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_TOO_LARGE" });
  await fs.writeFile(f.pointer, pointer); await fs.writeFile(f.result, Buffer.alloc(MAX_RESULT_BYTES + 1)); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_TOO_LARGE" });
  await fs.writeFile(f.result, Buffer.from([0xff, 0xfe])); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_INVALID" });
  const wrong = JSON.parse(saved); wrong.scope.month = "2026-08"; await fs.writeFile(f.result, JSON.stringify(wrong)); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_INVALID" });
  await fs.writeFile(f.pointer, JSON.stringify({ schemaVersion: 1, scopeKey: keyFor(scope), resultId: "../escape", revisions: [] })); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_SOURCE_INVALID" });
});
test("reader rejects hardlinks and symlinks instead of following another source", async t => {
  const f = await storeFixture(t), extra = f.result + ".extra"; await fs.link(f.result, extra); await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_UNSAFE_PATH" }); await fs.unlink(extra);
  const original = f.result + ".original"; await fs.rename(f.result, original);
  try { await fs.symlink(original, f.result); } catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.diagnostic("Windows file symlink creation unavailable; hardlink refusal was verified"); return; } throw error; }
  await assert.rejects(f.service.get({ regionKey: region.regionKey }), { code: "REGIONAL_MARKET_UNSAFE_PATH" });
});
test("strict scope validation and KST completed-month default preserve existing month semantics", async t => {
  assert.equal(completedMonth("2026-10-31T16:00:00Z"), "2026-10"); assert.equal(completedMonth("2026-10-31T14:59:00Z"), "2026-09");
  const f = await storeFixture(t);
  for (const input of [{ regionKey: "../escape" }, { regionKey: region.regionKey, month: "2026-11" }, { regionKey: region.regionKey, months: 12 }, { regionKey: region.regionKey, refresh: true }, { regionKey: region.regionKey, month: "" }, { regionKey: region.regionKey, month: null }]) await assert.rejects(f.service.get(input), { code: "REGIONAL_MARKET_INVALID_SCOPE" });
});
test("HTTP is authenticated GET only and cannot trigger the existing address or collection services", async () => {
  const calls = [], replies = [], handler = createRegionalMarketHttpHandler({ service: { get: async x => { calls.push(x); return { mode: "administrative_region" }; } },
    requireAdmin: session => session?.admin === true, send: (_, status, body) => replies.push({ status, body }) });
  const invoke = async (query, method = "GET", admin = true) => { const handled = await handler({ method }, {}, new URL(query, "http://fixture.invalid"), { admin }); return { handled, reply: replies.at(-1) }; };
  assert.equal((await invoke("/api/other")).handled, false); await invoke("/api/regional-market?regionKey=x", "GET", false); assert.equal(calls.length, 0);
  assert.equal((await invoke("/api/regional-market?regionKey=x&month=2026-09&months=13")).reply.status, 200); assert.deepEqual(calls, [{ regionKey: "x", month: "2026-09", months: 13 }]);
  assert.equal((await invoke("/api/regional-market?regionKey=x", "POST")).reply.status, 405);
  for (const query of ["", "regionKey=x&regionKey=y", "regionKey=x&refresh=true", "regionKey=x&months=12", "regionKey=x&month=", "regionKey=x&companyId=c1"]) assert.equal((await invoke("/api/regional-market?" + query)).reply.status, 400);
  assert.equal(calls.length, 1);
});
