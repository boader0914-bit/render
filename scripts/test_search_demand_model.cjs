"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const M = require("./lib/search_demand_model.cjs");
const row = (keyword, pc = 10, mobile = 20) => ({ relKeyword: keyword, monthlyPcQcCnt: pc, monthlyMobileQcCnt: mobile });
const ad = (keywordList, extra = {}) => M.normalizeSearchAdSnapshot({ keyword: "경남글램핑", observedAt: "2026-11-01T07:20:00.000Z", scopeId: "scope-a", keywordList, ...extra });
function trend(extra = {}) {
  const data = Array.from({ length: 12 }, (_, index) => ({ period: new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 10), ratio: index === 0 ? 0 : index * 7 }));
  return M.normalizeTrendSnapshot({ keyword: "경남글램핑", observedAt: "2026-11-01T07:20:00.000Z", startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month", scopeId: "scope-a", connectionProvider: "ncp_apihub", results: [{ title: "경남글램핑", keywords: ["경남글램핑"], data }], ...extra });
}
function reseal(value) { const { snapshotId, contentSha256, ...body } = value; const sha = M.hash(body); return { ...body, snapshotId: "sd_" + sha, contentSha256: sha }; }

test("keyword identity is stable for whitespace, Unicode-width and case without merging different meanings", () => {
  assert.equal(M.normalizeKeyword(" 경남  글램핑 ").keywordId, M.normalizeKeyword("경남글램핑").keywordId);
  assert.equal(M.normalizeKeyword("ＡＢＣ 글램핑").keywordId, M.normalizeKeyword("abc글램핑").keywordId);
  assert.notEqual(M.normalizeKeyword("경남글램핑").keywordId, M.normalizeKeyword("경남글램핑장").keywordId);
  assert.throws(() => M.normalizeKeyword("")); assert.throws(() => M.normalizeKeyword(null));
});
test("counts preserve numeric zero, less-than-ten and missing as distinct states", () => {
  assert.deepEqual(M.parseCount(0), { state: "number", value: 0, raw: 0, lowerBound: 0, upperBoundExclusive: null });
  assert.equal(M.parseCount("1,790").value, 1790);
  assert.deepEqual(M.parseCount("< 10"), { state: "range", value: null, raw: "< 10", lowerBound: 0, upperBoundExclusive: 10 });
  for (const value of ["", " ", null, undefined, false, {}, [], "NaN", "1,23", -1, Infinity, 1.5]) assert.equal(M.parseCount(value).state, "unknown");
  assert.equal(M.parseCount("secret-not-a-counter").raw, null);
});
test("totals retain bounded counts and never add an unknown as zero", () => {
  assert.equal(M.sumCounts(M.parseCount(1790), M.parseCount(7870)).value, 9660);
  assert.deepEqual(M.sumCounts(M.parseCount(1790), M.parseCount("<10")), { state: "range", value: null, raw: null, lowerBound: 1790, upperBoundExclusive: 1800 });
  assert.equal(M.sumCounts(M.parseCount(1790), M.parseCount(null)).state, "unknown");
});
test("all returned valid keyword rows are retained without a twenty-row storage cap", () => {
  const rows = [row("경남글램핑", 1790, 7870), ...Array.from({ length: 1200 }, (_, index) => row("연관글램핑" + index, index, 100))];
  const snapshot = ad(rows);
  assert.equal(snapshot.rows.length, 1201); assert.equal(snapshot.observations.length, 1201);
  assert.equal(snapshot.counts.returnedRows, 1201); assert.equal(snapshot.counts.reconciled, true);
  assert.equal(snapshot.anchor.total.value, 9660); assert.equal(snapshot.anchor.isAnchor, true);
  assert.equal(M.validateSnapshot(snapshot), snapshot);
});
test("absence of an exact anchor never adopts the first related keyword", () => {
  const snapshot = ad([row("가평글램핑", 100, 200)]);
  assert.equal(snapshot.anchor, null); assert.equal(snapshot.status, "missing"); assert.equal(snapshot.observations.length, 1);
});
test("same-value repeats and conflicting repeats are counted separately without double addition", () => {
  const snapshot = ad([row("경남글램핑", 10, 20), row("경남 글램핑", 10, 20), row("연관어", 1, 2), row("연관어", 9, 2), {}, null]);
  assert.deepEqual(snapshot.counts, { returnedRows: 6, validRows: 4, invalidRows: 2, duplicateRows: 2, conflictingKeys: 1, uniqueRows: 2, partialKeys: 1, reconciled: true });
  assert.equal(snapshot.anchor.total.value, 30); assert.equal(snapshot.anchor.sourceIndices.length, 2);
  assert.equal(snapshot.observations[1].total.state, "unknown"); assert.equal(snapshot.observations[1].conflicting, true);
  assert.equal(M.validateSnapshot(snapshot), snapshot);
});
test("a conflicting anchor becomes partial instead of choosing the bigger or latest value", () => {
  const snapshot = ad([row("경남글램핑", 10, 20), row("경남 글램핑", 20, 20)]);
  assert.equal(snapshot.status, "partial"); assert.equal(snapshot.anchor.total.state, "unknown");
});
test("range inputs are valid observations while an unknown component remains partial", () => {
  const range = ad([row("경남글램핑", "<10", 20)]), partial = ad([row("경남글램핑", null, 20)]);
  assert.equal(range.status, "ready"); assert.equal(range.anchor.status, "range"); assert.equal(range.anchor.total.value, null);
  assert.equal(partial.status, "partial"); assert.equal(partial.anchor.total.state, "unknown");
});
test("snapshot IDs are deterministic and observation date is aligned to Korea", () => {
  const first = ad([row("경남글램핑")], { observedAt: "2026-10-31T16:00:00.000Z" });
  assert.equal(first.day, "2026-11-01"); assert.equal(first.snapshotId, ad([row("경남글램핑")], { observedAt: "2026-10-31T16:00:00.000Z" }).snapshotId);
  assert.notEqual(first.snapshotId, ad([row("경남글램핑")], { observedAt: "2026-10-31T16:01:00.000Z" }).snapshotId);
});
test("invalid scopes, times, bodies and mutated content fail closed", () => {
  assert.throws(() => ad([], { scopeId: "../../escape" })); assert.throws(() => ad([], { observedAt: "2026-02-30T10:00:00.000Z" }));
  assert.throws(() => ad({}, {}));
  const changed = ad([row("경남글램핑")]); changed.anchor.total.value = 999;
  assert.throws(() => M.validateSnapshot(changed), { code: "SEARCH_DEMAND_SNAPSHOT_HASH_MISMATCH" });
});
test("even self-rehashed extra credential fields and inconsistent normalized data are rejected", () => {
  const snapshot = ad([row("경남글램핑")]);
  assert.throws(() => M.validateSnapshot(reseal({ ...snapshot, secretKey: "must-not-persist" })), { code: "SEARCH_DEMAND_SNAPSHOT_INVALID" });
  const bad = structuredClone(snapshot); bad.rows[0].monthlyPc.value = 200;
  assert.throws(() => M.validateSnapshot(reseal(bad)), { code: "SEARCH_DEMAND_SNAPSHOT_INVALID" });
});
test("complete twelve-month windows preserve real zero and the whole-window identity", () => {
  const value = trend(); assert.equal(value.status, "ready"); assert.equal(value.series.length, 12); assert.equal(value.series[0].ratio, 0);
  assert.equal(value.coverage.observedMonths, 12); assert.equal(value.connectionProvider, "ncp_apihub");
  assert.equal(M.validateSnapshot(value), value);
  const another = trend({ startDate: "2025-12-01" }); assert.notEqual(another.windowId, value.windowId);
});
test("missing, duplicate-conflicting and invalid trend points do not become zeros", () => {
  const original = trend(), data = original.series.map(row => ({ period: row.period, ratio: row.ratio }));
  data[1].ratio = null; data.push({ period: data[2].period, ratio: 99 }); data.push({ period: "2020-01-01", ratio: 10 });
  const value = trend({ results: [{ title: "경남글램핑", data }] });
  assert.equal(value.status, "partial"); assert.equal(value.series[1].ratio, null); assert.equal(value.series[2].ratio, null);
  assert.equal(value.counts.conflictingKeys, 1); assert.equal(value.counts.invalidRows, 2); assert.equal(value.coverage.observedMonths, 10);
  assert.equal(M.validateSnapshot(value), value);
});
test("wrong trend keyword, unsupported window and non-month units are rejected", () => {
  assert.throws(() => trend({ results: [{ title: "가평글램핑", data: [] }] }));
  assert.throws(() => trend({ startDate: "2020-01-01" })); assert.throws(() => trend({ timeUnit: "date" }));
  const empty = trend({ results: [] }); assert.equal(empty.status, "missing"); assert.equal(empty.series.every(row => row.ratio === null), true);
});
test("analysis paginates the whole list, retains missing dates and does not expose private scope IDs", () => {
  const value = ad([row("경남글램핑", 0, 0), ...Array.from({ length: 28 }, (_, index) => row("연관어" + index, index, index))]);
  const model = M.buildSearchDemandAnalysis({ selection: { keyword: "경남글램핑", month: "2026-11", day: "2026-11-01", page: 2, pageSize: 20 }, searchSnapshot: value, trendSnapshot: trend(), history: [value] });
  assert.equal(model.related.total, 29); assert.equal(model.related.rows.length, 9); assert.equal(model.related.totalPages, 2);
  assert.equal(model.daily.rows.length, 30); assert.equal(model.daily.rows[0].total.state, "unknown");
  assert.equal(model.searchVolume.anchor.total.value, 0); assert.equal(JSON.stringify(model).includes("scope-a"), false);
});
test("related selections are echoed while their daily identity remains distinct from the anchor", () => {
  const model = M.buildSearchDemandAnalysis({ selection: { keyword: "경남글램핑", relatedKeyword: "부산 글램핑", month: "2026-11", day: "2026-11-01", sort: "keywordAsc" } });
  assert.equal(model.selection.relatedKeyword, "부산 글램핑"); assert.equal(model.daily.keywordId, M.normalizeKeyword("부산글램핑").keywordId);
  assert.equal(model.selection.keywordId, M.normalizeKeyword("경남글램핑").keywordId);
});
