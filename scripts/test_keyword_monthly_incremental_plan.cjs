"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), os = require("node:os");
const { planScopes, MAX_SCOPES } = require("./lib/keyword_monthly_incremental_plan.cjs");
const { mergeInputs, scopeId } = require("./lib/keyword_monthly_refresh_preparation.cjs");
const A = "모의 A", B = "모의 B", C = "모의 C", fingerprint = "a".repeat(64);
const scope = (keyword, month, partition = "b".repeat(64)) => ({ keyword, month, partition });
const keys = rows => rows.map(scopeId).sort();
function fixture(extra = {}) { return { state: { dirtyKeywords: [], globalDiagnosticsDirty: false, staticInputsFingerprint: fingerprint, runs: [] },
  catalog: { scopes: [scope(A, "2026-10"), scope(A, "2026-11"), scope(A, "2026-12"), scope(A, "2027-01"), scope(B, "2026-09"), scope(B, "2026-10"), scope(C, "2026-08")] },
  evidence: { runId: "run_A", keyword: A }, range: { stayMonths: ["2026-11", "2026-12"], collectionMonth: "2026-11" },
  capturedAt: "2026-11-15T01:00:00Z", inputsFingerprint: fingerprint, ...extra }; }

test("normal run rebuilds recorded stay/collection months and exposed successor comparisons only", () => {
  const input = fixture(), plan = planScopes(input);
  assert.equal(plan.globalDependencyChange, false); assert.equal(plan.rawHistoryRescanRequired, false);
  assert.deepEqual(keys(plan.scopes), keys([scope(A, "2026-11"), scope(A, "2026-12"), scope(A, "2027-01")]));
  assert.ok(plan.scopes.find(s => s.month === "2027-01").reasons.includes("previous_month_comparison_dependency"));
  assert.equal(new Set(keys(plan.scopes)).size, plan.scopeCount);
});

test("changed company/observation keywords rebuild every exposed historical month across keywords", () => {
  const input = fixture(); input.state.dirtyKeywords = [B, B]; const plan = planScopes(input);
  assert.deepEqual(keys(plan.scopes), keys([scope(A, "2026-11"), scope(A, "2026-12"), scope(A, "2027-01"), scope(B, "2026-09"), scope(B, "2026-10")]));
  assert.equal(plan.scopes.some(s => s.keyword === C), false);
  for (const row of plan.scopes.filter(s => s.keyword === B)) assert.ok(row.reasons.includes("changed_company_or_observation_dependency"));
  for (const row of plan.scopes) assert.equal(new Set(row.reasons).size, row.reasons.length);
});

test("global dependency or global diagnostics change includes every old scope without dropping direct new months", () => {
  for (const change of ["static", "diagnostics"]) {
    const input = fixture(); if (change === "static") input.inputsFingerprint = "c".repeat(64); else input.state.globalDiagnosticsDirty = true;
    const plan = planScopes(input); assert.equal(plan.globalDependencyChange, true);
    assert.deepEqual(keys(plan.scopes), keys(input.catalog.scopes));
    for (const row of plan.scopes) assert.ok(row.reasons.includes("verified_global_dependency_change"));
  }
});

test("actual changed-keyword run adds previously unpublished recorded stay months across a year boundary", () => {
  const input = fixture(); input.state.dirtyKeywords = [B]; input.state.runs = [{ id: "run_B", keyword: B, collectedAt: "2026-11-03T01:00:00Z", collectedAtSource: "manifest",
    checkIn: "2026-12-31", bookingRangeDays: 3 }];
  const plan = planScopes(input), selected = plan.scopes.filter(s => s.keyword === B);
  assert.deepEqual(selected.map(s => s.month).sort(), ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
  assert.ok(selected.find(s => s.month === "2027-01").reasons.includes("actual_run_recorded_stay_month"));
});

test("rank-only actual collection month remains publishable with no inventory range", () => {
  const input = fixture(); input.catalog.scopes = []; input.range = { stayMonths: ["2026-11"], collectionMonth: "2026-11" }; input.state.dirtyKeywords = [B];
  input.state.runs = [{ id: "rank_only", keyword: B, collectedAt: "2026-10-31T15:00:00Z", collectedAtSource: "manifest" }];
  const plan = planScopes(input); assert.deepEqual(keys(plan.scopes), keys([scope(A, "2026-11"), scope(B, "2026-11")]));
  assert.deepEqual(plan.scopes.find(s => s.keyword === B).reasons, ["actual_rank_run_month"]);
});

test("reviewed identity changes can expose an older keyword month absent from the previous catalog", () => {
  const input = fixture(); input.catalog.scopes = [scope(A, "2026-11")]; input.state.dirtyKeywords = [B];
  input.state.runs = [{ id: "past_B", keyword: B, collectedAt: "2026-09-12T01:00:00Z", collectedAtSource: "manifest", checkIn: "2026-09-30", bookingRangeDays: 2 }];
  const plan = planScopes(input);
  assert.deepEqual(plan.scopes.filter(s => s.keyword === B).map(s => s.month).sort(), ["2026-09", "2026-10"]);
  assert.equal(plan.scopes.find(s => s.keyword === B && s.month === "2026-09").cutoffDate, "2026-09-30");
});

test("saved raw observation months supplement run coverage without reading original history", () => {
  const input = fixture(); input.state.dirtyKeywords = [B]; input.state.runs = [];
  input.state.history = { partitions: [{ month: "2025-07", keywords: [B, C] }, { month: "2025-08", keywords: [C] }, { month: "", keywords: [B] }] };
  const plan = planScopes(input);
  assert.ok(plan.scopes.some(s => s.keyword === B && s.month === "2025-07" && s.reasons.includes("saved_raw_observation_month")));
  assert.equal(plan.scopes.some(s => s.keyword === C), false); assert.equal(plan.scopes.some(s => s.month === "2025-08"), false);
  assert.equal(plan.rawHistoryRescanRequired, false);
});

test("filesystem timestamps and synthetic today months cannot create new evidence scopes", () => {
  const input = fixture(); input.catalog.scopes = []; input.state.dirtyKeywords = [B]; input.range = { stayMonths: ["2026-10"], collectionMonth: "2026-10" };
  input.state.runs = [{ id: "file_clock", keyword: B, collectedAt: "2026-10-12T00:00:00Z", collectedAtSource: "filesystem", checkIn: "2026-12-01", bookingRangeDays: 3 }];
  const plan = planScopes(input); assert.deepEqual(keys(plan.scopes), keys([scope(A, "2026-10")])); assert.equal(plan.scopes.some(s => s.month === "2026-11"), false);
});

test("null old cutoffs never propagate; generated cutoffs respect KST day, leap year and month end", () => {
  const input = fixture(); input.catalog.scopes = [scope(A, "2024-02"), scope(A, "2025-12"), scope(A, "2026-11"), scope(A, "2026-12")].map(s => ({ ...s, cutoffDate: null }));
  input.inputsFingerprint = "c".repeat(64); input.capturedAt = "2026-11-14T15:00:00Z"; const plan = planScopes(input), cutoff = new Map(plan.scopes.map(s => [s.month, s.cutoffDate]));
  assert.equal(cutoff.get("2024-02"), "2024-02-29"); assert.equal(cutoff.get("2025-12"), "2025-12-31"); assert.equal(cutoff.get("2026-11"), "2026-11-15"); assert.equal(cutoff.get("2026-12"), "2026-11-15");
  assert.ok(plan.scopes.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.cutoffDate) && s.cutoffDate <= "2026-11-15"));
});

test("128-scope fanout is admitted and the next scope fails closed without truncation or input mutation", () => {
  const input = fixture(); input.range = { stayMonths: ["2026-11"], collectionMonth: "2026-11" };
  input.catalog.scopes = Array.from({ length: MAX_SCOPES }, (_, i) => scope(i ? `모의 ${i}` : A, "2026-11")); input.inputsFingerprint = "c".repeat(64);
  assert.equal(planScopes(input).scopeCount, MAX_SCOPES); input.catalog.scopes.push(scope("초과 모의", "2026-11")); const before = JSON.stringify(input);
  assert.throws(() => planScopes(input), { code: "KEYWORD_INCREMENTAL_SCOPE_FANOUT_BOUND" }); assert.equal(JSON.stringify(input), before);
});

test("invalid keyword/month identifiers are rejected before they can become partition paths", () => {
  for (const invalid of [scope("", "2026-11"), scope("bad\nkeyword", "2026-11"), scope(A, "2026-13"), scope(A, "../month")]) {
    const input = fixture(); input.catalog.scopes.push(invalid); input.state.globalDiagnosticsDirty = true;
    assert.throws(() => planScopes(input), { code: "KEYWORD_INCREMENTAL_SCOPE_INVALID" });
  }
});

test("merging dirty replacements preserves every untouched scope's exact old partition binding", () => {
  const input = fixture(), oldPartition = "b".repeat(64), otherPartition = "d".repeat(64), generationDir = path.join(os.tmpdir(), "keyword-plan-fixture-generation");
  input.catalog.scopes = [scope(A, "2026-10", oldPartition), scope(A, "2026-11", oldPartition), scope(B, "2026-09", otherPartition)];
  input.range = { stayMonths: ["2026-11"], collectionMonth: "2026-11" };
  const plan = planScopes(input), replacements = plan.scopes.map((s, i) => ({ directory: path.join(os.tmpdir(), "keyword-plan-new-" + i), exposeScopes: [{ keyword: s.keyword, month: s.month }] }));
  const combined = mergeInputs({ catalog: input.catalog, generationDir }, replacements), bindings = new Map();
  for (const row of combined) for (const scope of row.exposeScopes) bindings.set(scopeId(scope), row.directory);
  assert.equal(bindings.get(scopeId(scope(A, "2026-10"))), path.join(generationDir, "partitions", oldPartition));
  assert.equal(bindings.get(scopeId(scope(B, "2026-09"))), path.join(generationDir, "partitions", otherPartition));
  assert.equal(bindings.get(scopeId(scope(A, "2026-11"))), replacements[0].directory); assert.equal(bindings.size, input.catalog.scopes.length);
});
