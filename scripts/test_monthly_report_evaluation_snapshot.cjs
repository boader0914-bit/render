"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");

async function fixture(t, readOutlookEvaluations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-evaluation-snapshot-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("monthly-evaluation-snapshot-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const region = { id: "region-a", label: "실제 소재지", level: "local" };
  const sources = {
    companies: [
      { companyId: "selected", primaryName: "현재 월 표본", regionKey: "region-a", regionLabel: region.label, keywords: ["키워드"] },
      { companyId: "historical", primaryName: "과거 표본", regionKey: "unrelated-region", keywords: ["키워드"] }
    ],
    regions: [region], observations: [],
    runs: [{ id: "ranking", collectedAt: "2026-09-10T00:00:00Z", keyword: "키워드", collectionQuality: { status: "complete" } }],
    rankObservations: [{ companyId: "selected", keyword: "키워드", runId: "ranking", rank: 3, collectedAt: "2026-09-10T00:00:00Z" }],
    context: { sources: [{ label: "기존 지역 배경" }], warnings: [], networkAttempted: false }
  };
  const service = createMonthlyReportService({ dataDir: directory, loadSources: async () => sources,
    now: () => new Date("2026-10-16T02:00:00Z"), readOutlookEvaluations });
  return { service, sources, request: { type: "keyword", targetId: "키워드", month: "2026-09", cutoffDate: "2026-09-30" } };
}

test("report evaluation uses the exact monthly roster, one creation timestamp and a detached publication snapshot", async t => {
  const calls = [];
  const evaluation = { schemaVersion: 1, reportMonth: "2026-09", networkAttempted: false, status: "pending", regions: [{ regionKey: "region-a", rows: [{ actualValue: null }] }] };
  const { service, sources, request } = await fixture(t, async (...args) => { calls.push(args); return evaluation; });
  const preview = await service.preview(request);
  assert.equal(calls.length, 1, "comparison with the previous month does not trigger a second evaluation read");
  assert.deepEqual(calls[0][1].companies, [{ companyId: "selected", regionKey: "region-a", regionLabel: "실제 소재지" }]);
  assert.equal(calls[0][2].asOfAt, preview.generatedAt);
  assert.equal(calls[0][0].cutoffDate, "2026-09-30", "lodging cutoff is kept separate from October follow-up evaluation");
  assert.equal(preview.context.sources[0].label, "기존 지역 배경");
  assert.equal(sources.context.outlookEvaluations, undefined, "shared source context remains unchanged");
  assert.match(preview.definitions.regionalOutlookEvaluation, /예약 관측 마감일과 별도/);
  evaluation.status = "ready";
  evaluation.regions[0].rows[0].actualValue = 0;
  const draft = await service.create({ ...request, previewToken: preview.previewToken });
  assert.equal(calls.length, 1, "saving an approved preview does not replace its evaluation with newer data");
  assert.equal(draft.snapshot.context.outlookEvaluations.status, "pending");
  assert.equal(draft.snapshot.context.outlookEvaluations.regions[0].rows[0].actualValue, null);
  const review = await service.update(draft.id, { revision: draft.revision, status: "review" });
  const issued = await service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  await service.get(issued.id); await service.list();
  assert.equal(calls.length, 1, "read, metadata edits and publication never re-read evaluation sources");
  const revision = await service.revise(issued.id, { revision: issued.revision });
  const rebuilt = await service.rebuild(revision.id, { revision: revision.revision });
  assert.equal(calls.length, 2);
  assert.equal(rebuilt.snapshot.context.outlookEvaluations.status, "ready");
  assert.equal(rebuilt.snapshot.context.outlookEvaluations.regions[0].rows[0].actualValue, 0);
  assert.deepEqual((await service.get(issued.id)).snapshot, issued.snapshot, "issued pending evidence is immutable after later official values");
});

test("report evaluation refuses any callback that attempts network work", async t => {
  const { service, request } = await fixture(t, async () => ({ networkAttempted: true, regions: [] }));
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
  assert.deepEqual(await service.list(), [], "invalid enrichment cannot create a report");
});

test("an unconfigured legacy report builder retains its previous snapshot shape", async t => {
  const { service, request } = await fixture(t, null);
  const preview = await service.preview(request);
  assert.equal(preview.context.outlookEvaluations, undefined);
  assert.equal(preview.definitions.regionalOutlookEvaluation, undefined);
});
