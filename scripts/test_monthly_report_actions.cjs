"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listMonthlyReportActionEvidence: evidence, normalizeMonthlyReportActionPlan: normalize } = require("./lib/monthly_report_actions.cjs");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");

function snapshot() { return { summary: { lodging: { sold: 2, supply: 10 }, dayuse: { sold: 0, supply: 0 } },
  sources: { digest: "saved-revision-one" }, quality: { status: "partial", warnings: ["자료 미확보"] }, comparison: { previousMonth: "2026-08" },
  context: { sources: [{ key: "visitors", label: "방문 흐름", regionLabel: "[모의] 지역", rows: [{ value: null, status: "missing" }] }],
    outlookEvaluations: { regions: [{ regionKey: "r1", source: { resultId: "outlook-one" } }] },
    catchment: { entries: [{ regionKey: "r1", snapshot: { resultId: "catchment-one", publicSubtotal: 0, total: null } }] } },
  industryBenchmarks: { entries: [{ regionLabel: "[모의] 지역", industry: { label: "글램핑" }, storage: { resultRevision: "saved-one" } }] } }; }
function plan(s = snapshot(), changes = {}) { return { summary: "관리자 검토 의견", items: [{ title: "자료를 확인하세요", owner: "담당자", dueDate: "2026-10-31",
  status: "planned", evidenceRefs: [evidence(s)[0].id], outcome: "작성자 메모이며 검증된 실적이 아닙니다.", ...changes }] }; }

test("saved references are deterministic, content-bound, detached and do not invent unknown values", () => {
  const s = snapshot(), before = JSON.stringify(s), a = evidence(s), b = evidence(s);
  assert.deepEqual(a, b); assert.equal(a.length, 8); assert.equal(JSON.stringify(s), before);
  assert.ok(a.every(row => /^[a-z-]+:[a-f0-9]{64}$/.test(row.id) && typeof row.label === "string"));
  a[0].label = "caller edit"; assert.notEqual(evidence(s)[0].label, "caller edit");
  const changed = snapshot(); changed.summary.lodging.sold = 3;
  assert.notEqual(evidence(changed)[0].id, b[0].id);
  assert.equal(s.context.catchment.entries[0].snapshot.total, null);
});
test("regional and precise catchment evidence have distinct content-bound references while old references stay unchanged", () => {
  const s = snapshot(), original = evidence(s).find(row => row.id.startsWith("catchment:"));
  const oldEntry = s.context.catchment.entries[0];
  assert.equal(original.id, "catchment:" + require("node:crypto").createHash("sha256").update(JSON.stringify(oldEntry)).digest("hex"));
  s.context.catchment = { schemaVersion: 2, defaultMode: "administrative_region",
    entries: [{ mode: "administrative_region", regionKey: "r1", companyIds: ["company-a", "company-b"], regionSnapshot: { source: { resultId: "region-one" }, metrics: [{ value: null }] } }],
    preciseEntries: [{ ...oldEntry, mode: "address_radius", companyId: "company-a" }] };
  const refs = evidence(s), region = refs.find(row => row.id.startsWith("catchment-region:")), address = refs.find(row => row.id.startsWith("catchment-address:"));
  assert.ok(region && address); assert.notEqual(region.id, address.id); assert.equal(refs.length, 9);
  s.context.catchment.entries[0].regionSnapshot.source.resultId = "region-two";
  const changed = evidence(s); assert.notEqual(changed.find(row => row.id.startsWith("catchment-region:")).id, region.id);
  assert.equal(changed.find(row => row.id.startsWith("catchment-address:")).id, address.id);
});
test("normalization preserves four statuses, actual dates, bounded author notes and independent references", () => {
  const s = snapshot();
  for (const status of ["planned", "in_progress", "completed", "held"]) {
    const input = plan(s, { status }), before = JSON.stringify(input), normalized = normalize(input, s);
    assert.equal(normalized.schemaVersion, 1); assert.equal(normalized.items[0].id, "action-1");
    assert.equal(normalized.items[0].status, status); assert.equal(JSON.stringify(input), before);
    assert.deepEqual(normalize(normalized, s), normalized);
    normalized.items[0].evidenceRefs.push("caller-only"); assert.equal(input.items[0].evidenceRefs.length, 1);
  }
  const noDate = normalize(plan(s, { dueDate: "" }), s); assert.equal(noDate.items[0].dueDate, null);
});
test("unknown evidence, another snapshot, arbitrary URLs and duplicate references fail closed", () => {
  const s = snapshot(), other = snapshot(); other.sources.digest = "different-source";
  for (const refs of [["https://provider.invalid/raw"], ["summary-lodging:unknown"], [evidence(other)[0].id], [], [evidence(s)[0].id, evidence(s)[0].id], new Array(1)]) {
    assert.throws(() => normalize(plan(s, { evidenceRefs: refs }), s), { code: "invalid_action_evidence" });
  }
});
test("unknown fields, getters, statuses, IDs and invalid calendar dates are rejected", () => {
  const s = snapshot();
  for (const changes of [{ title: " " }, { title: "x".repeat(201) }, { owner: "x".repeat(101) }, { status: "verified_result" },
    { dueDate: "2026-02-29" }, { dueDate: "2026-10-32" }, { id: "../outside" }, { resultRevenue: 999 }, { outcome: "x".repeat(4001) }]) {
    assert.throws(() => normalize(plan(s, changes), s), { code: "invalid_action_plan" });
  }
  assert.throws(() => normalize({ ...plan(s), snapshot: {} }, s), { code: "invalid_action_plan" });
  assert.throws(() => normalize({ summary: "", items: new Array(1) }, s), { code: "invalid_action_plan" });
  let getterCalls = 0; const input = { summary: "" }; Object.defineProperty(input, "items", { enumerable: true, get() { getterCalls++; return []; } });
  assert.throws(() => normalize(input, s), { code: "invalid_action_plan" }); assert.equal(getterCalls, 0);
  assert.throws(() => normalize(null, s), { code: "invalid_action_plan" });
});
test("item/reference/total size limits and duplicate IDs cannot be bypassed", () => {
  const s = snapshot(), item = plan(s).items[0];
  assert.throws(() => normalize({ items: Array.from({ length: 21 }, () => item) }, s), { code: "invalid_action_plan" });
  assert.throws(() => normalize({ items: [{ ...item, id: "same" }, { ...item, id: "same" }] }, s), { code: "invalid_action_plan" });
  assert.throws(() => normalize(plan(s, { evidenceRefs: Array(13).fill(evidence(s)[0].id) }), s), { code: "invalid_action_evidence" });
  assert.throws(() => normalize({ summary: "한".repeat(4000), items: Array.from({ length: 20 }, () => ({ ...item, outcome: "한".repeat(4000) })) }, s), { code: "invalid_action_plan" });
  assert.deepEqual(normalize({ summary: "", items: [] }, s), { schemaVersion: 1, summary: "", items: [] });
});

const request = { type: "company", targetId: "company-a", month: "2026-09", cutoffDate: "2026-09-30" };
function source() { return { companies: [{ companyId: "company-a", primaryName: "[모의] 숙소", regionKey: "r1", regionKeys: ["r1"] }],
  regions: [{ id: "r1", label: "[모의] 지역", level: "local" }], observations: [], runs: [] }; }
async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-actions-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("monthly-actions-")); await fs.rm(dir, { recursive: true, force: true }); });
  let reads = 0;
  const service = createMonthlyReportService({ dataDir: dir, now: () => new Date("2026-10-25T03:00:00Z"), loadSources: async () => { reads++; return source(); }, ...overrides });
  return { dir, service, reads: () => reads };
}
test("preview/create/update/publish/revise freeze actions with numerical evidence and revision protection", async t => {
  const f = await fixture(t), p = await f.service.preview(request), numeric = JSON.stringify(p.summary), actionPlan = plan(p);
  const draft = await f.service.create({ ...request, previewToken: p.previewToken, actionPlan });
  assert.equal(f.reads(), 2, "token-backed create must not rebuild sources"); assert.deepEqual(draft.snapshot.actionEvidence, p.actionEvidence);
  assert.equal(JSON.stringify(draft.snapshot.summary), numeric); assert.equal(draft.snapshot.actionPlan.items[0].owner, "담당자");
  await assert.rejects(f.service.update(draft.id, { revision: 99, actionPlan }), { code: "revision_conflict" });
  await assert.rejects(f.service.update(draft.id, { revision: 1, actionPlan: plan(p, { evidenceRefs: ["outside"] }) }), { code: "invalid_action_evidence" });
  assert.equal((await f.service.get(draft.id)).revision, 1);
  const edited = await f.service.update(draft.id, { revision: 1, status: "review", actionPlan: plan(p, { status: "completed", outcome: "작성자 완료 메모" }) });
  const issued = await f.service.publish(draft.id, { revision: edited.revision, acknowledgeQuality: true });
  const original = JSON.stringify(await f.service.get(issued.id));
  await assert.rejects(f.service.update(issued.id, { revision: issued.revision, actionPlan }), { code: "published_immutable" });
  await assert.rejects(f.service.rebuild(issued.id, { revision: issued.revision }), { code: "published_immutable" });
  const revised = await f.service.revise(issued.id, { revision: issued.revision });
  assert.deepEqual(revised.snapshot.actionPlan, issued.snapshot.actionPlan);
  await f.service.update(revised.id, { revision: 1, actionPlan: { summary: "다음 검토", items: [] } });
  assert.equal(JSON.stringify(await f.service.get(issued.id)), original); assert.equal(JSON.stringify(issued.snapshot.summary), numeric);
});
test("a changed rebuild cannot silently rebind an old action or replace the saved draft", async t => {
  let version = 1;
  const f = await fixture(t, { readReportContext: async () => ({ networkAttempted: false, sources: [{ key: "visitors", label: "방문", rows: [{ value: version }] }] }) });
  const preview = await f.service.preview(request), ref = preview.actionEvidence.find(row => row.id.startsWith("regional:"));
  const draft = await f.service.create({ ...request, previewToken: preview.previewToken, actionPlan: plan(preview, { evidenceRefs: [ref.id] }) });
  const raw = await fs.readFile(path.join(f.dir, draft.id + ".json"), "utf8"); version = 2;
  await assert.rejects(f.service.rebuild(draft.id, { revision: 1 }), { code: "invalid_action_evidence" });
  assert.equal(await fs.readFile(path.join(f.dir, draft.id + ".json"), "utf8"), raw);
  const cleared = await f.service.update(draft.id, { revision: 1, actionPlan: { summary: "검토 후 재집계", items: [] } });
  const rebuilt = await f.service.rebuild(draft.id, { revision: cleared.revision });
  assert.equal(rebuilt.snapshot.context.sources[0].rows[0].value, 2); assert.equal(rebuilt.snapshot.actionPlan.items.length, 0);
});
test("older reports without action plans remain readable and published action tampering is detected", async t => {
  const f = await fixture(t), draft = await f.service.create(request);
  assert.equal(draft.snapshot.actionPlan, undefined); assert.equal((await f.service.get(draft.id)).snapshot.actionPlan, undefined);
  const review = await f.service.update(draft.id, { revision: 1, actionPlan: plan(draft.snapshot), status: "review" });
  const issued = await f.service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  const file = path.join(f.dir, issued.id + ".json"), corrupt = JSON.parse(await fs.readFile(file, "utf8"));
  corrupt.snapshot.actionPlan.items[0].outcome = "위조된 결과"; await fs.writeFile(file, JSON.stringify(corrupt));
  await assert.rejects(f.service.get(issued.id), { code: "corrupt_report" });
});
test("catchment attaches per preview without rebuilding stable lodging; token, issued copy and source stay fixed", async t => {
  let version = 1, contextReads = 0;
  const f = await fixture(t, { readSourceRevision: async () => "stable", readCatchmentContext: async (input, roster, options) => {
    contextReads++; assert.equal(input.targetId, request.targetId); assert.equal(roster.companies[0].companyId, "company-a"); assert.equal(options.asOfAt, "2026-10-25T03:00:00.000Z");
    return { schemaVersion: 1, networkAttempted: false, status: "partial", entries: [{ regionKey: "r1", snapshot: { resultId: "catchment-" + version, publicSubtotal: 0, total: null } }] };
  } });
  const p = await f.service.preview(request); assert.equal(p.context.catchment.entries[0].snapshot.total, null);
  assert.equal(p.generation.timings.catchmentContextMs >= 0, true); assert.equal(f.reads(), 2);
  version = 2; const draft = await f.service.create({ ...request, previewToken: p.previewToken });
  const review = await f.service.update(draft.id, { revision: 1, status: "review" });
  const issued = await f.service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  assert.equal(issued.snapshot.context.catchment.entries[0].snapshot.resultId, "catchment-1"); assert.equal(contextReads, 1);
  const next = await f.service.preview(request); assert.equal(next.context.catchment.entries[0].snapshot.resultId, "catchment-2");
  assert.equal(f.reads(), 2); assert.equal(contextReads, 2);
  assert.equal((await f.service.get(issued.id)).snapshot.context.catchment.entries[0].snapshot.resultId, "catchment-1");
});
test("new regional context refreshes previews while token approval and issued address evidence remain frozen", async t => {
  let version = 1;
  const f = await fixture(t, { readSourceRevision: async () => "stable-region-default", readCatchmentContext: async () => ({
    schemaVersion: 2, defaultMode: "administrative_region", networkAttempted: false, status: "partial",
    entries: [{ mode: "administrative_region", regionKey: "r1", companyIds: ["company-a"], regionSnapshot: {
      source: { resultId: "regional-" + version }, metrics: [{ value: null, status: "missing" }] } }],
    preciseEntries: [{ mode: "address_radius", regionKey: "r1", companyId: "company-a", snapshot: { resultId: "precise-" + version } }] }) });
  const preview = await f.service.preview(request), summary = JSON.stringify(preview.summary);
  const reference = preview.actionEvidence.find(row => row.id.startsWith("catchment-region:"));
  version = 2;
  const draft = await f.service.create({ ...request, previewToken: preview.previewToken,
    actionPlan: plan(preview, { evidenceRefs: [reference.id] }) });
  const review = await f.service.update(draft.id, { revision: draft.revision, status: "review" });
  const published = await f.service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  assert.equal(published.snapshot.context.catchment.entries[0].regionSnapshot.source.resultId, "regional-1");
  assert.equal(published.snapshot.context.catchment.preciseEntries[0].snapshot.resultId, "precise-1");
  const issuedFile = path.join(f.dir, published.id + ".json"), bytes = await fs.readFile(issuedFile);
  const next = await f.service.preview(request); assert.equal(next.context.catchment.entries[0].regionSnapshot.source.resultId, "regional-2");
  assert.equal(JSON.stringify(next.summary), summary); assert.equal(f.reads(), 2);
  assert.notEqual(next.actionEvidence.find(row => row.id.startsWith("catchment-region:")).id, reference.id);
  assert.deepEqual(await fs.readFile(issuedFile), bytes); assert.equal((await f.service.get(published.id)).snapshot.actionPlan.items[0].evidenceRefs[0], reference.id);
});
test("catchment read failures remain unknown, sensitive errors are hidden and external work is rejected", async t => {
  const failed = await fixture(t, { readCatchmentContext: async () => { throw new Error("PRIVATE_PROVIDER_SECRET"); } });
  const preview = await failed.service.preview(request);
  assert.equal(preview.context.catchment.status, "missing"); assert.equal(preview.context.catchment.selectionCoverage.selectedRegionCount, null);
  assert.equal(preview.context.catchment.entries.length, 0); assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_PROVIDER_SECRET/);
  const network = await fixture(t, { readCatchmentContext: async () => ({ networkAttempted: true }) });
  await assert.rejects(network.service.preview(request), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
});
