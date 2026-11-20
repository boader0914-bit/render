"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  markSavedMonthlyJsonSource: mark,
  carrySavedMonthlyJsonSource: carry,
  registerIndustryDiscard: register,
  withIndustryEvidenceScope: withScope,
  mayBorrowMonthlyEvidence: mayBorrow
} = require("./lib/monthly_snapshot_owned_inputs.cjs");

const fixture = () => ({ observations: [{ value: 1 }] });
const diagnostic = () => register(function industryDiagnostic() {});

test("trusted marking and registration return their inputs without adding source, row, or callback properties", () => {
  const source = fixture(), fn = function discard() {};
  const sourceDescriptors = Object.getOwnPropertyDescriptors(source);
  const rowDescriptors = Object.getOwnPropertyDescriptors(source.observations[0]);
  const fnKeys = Reflect.ownKeys(fn);
  assert.equal(mark(source), source);
  assert.equal(register(fn), fn);
  assert.deepEqual(Object.getOwnPropertyDescriptors(source), sourceDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(source.observations[0]), rowDescriptors);
  assert.deepEqual(Reflect.ownKeys(fn), fnKeys);
});

test("a marked source alone never authorizes borrowing, including with a registered or null callback", () => {
  const source = mark(fixture()), fn = diagnostic();
  assert.equal(mayBorrow(source, fn), false);
  assert.equal(mayBorrow(source, null), false);
  assert.equal(mayBorrow(source, () => {}), false);
});

test("public fake labels and a registered callback cannot substitute for a producer brand", () => {
  const source = { ...fixture(), savedMonthlyJson: true, readOnly: true };
  const fn = diagnostic();
  withScope(source, source, fn, () => assert.equal(mayBorrow(source, fn), false));
  assert.equal(mayBorrow(source, fn), false);
});

test("only the exact registered callback can borrow during a valid synchronous scope", () => {
  const source = mark(fixture()), fn = diagnostic(), other = diagnostic();
  const result = withScope(source, source, fn, () => {
    assert.equal(mayBorrow(source, fn), true);
    assert.equal(mayBorrow(source, other), false);
    assert.equal(mayBorrow(source, null), false);
    assert.equal(mayBorrow(source, (...args) => fn(...args)), false);
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(mayBorrow(source, fn), false);
});

test("carry accepts only wrappers retaining the branded producer's current array", () => {
  const original = mark(fixture()), target = { observations: original.observations }, fn = diagnostic();
  assert.equal(carry(original, target), target);
  withScope(target, target, fn, () => assert.equal(mayBorrow(target, fn), true));
  withScope(target, original, fn, () => assert.equal(mayBorrow(target, fn), true));
  assert.equal(mayBorrow(target, fn), false);
});

test("carry rejects unbranded and different-array sources and clears stale target authority", () => {
  const original = mark(fixture()), target = mark(fixture()), fn = diagnostic();
  assert.equal(carry(original, target), target);
  withScope(target, target, fn, () => assert.equal(mayBorrow(target, fn), false));
  const unbranded = fixture(), copied = { observations: unbranded.observations };
  carry(unbranded, copied);
  withScope(copied, copied, fn, () => assert.equal(mayBorrow(copied, fn), false));
});

test("carry revalidates the original current array before carrying", () => {
  const original = mark(fixture()), previous = original.observations;
  const target = { observations: previous }, fn = diagnostic();
  original.observations = [];
  carry(original, target);
  withScope(target, target, fn, () => assert.equal(mayBorrow(target, fn), false));
  withScope(target, original, fn, () => assert.equal(mayBorrow(target, fn), false));
});

test("carrying a branded source to itself preserves valid authority", () => {
  const source = mark(fixture()), fn = diagnostic();
  assert.equal(carry(source, source), source);
  withScope(source, source, fn, () => assert.equal(mayBorrow(source, fn), true));
});

test("scope construction rejects a different scoped array or an unregistered callback", () => {
  const original = mark(fixture()), scoped = fixture(), fn = diagnostic(), unknown = () => {};
  withScope(scoped, original, fn, () => assert.equal(mayBorrow(scoped, fn), false));
  withScope(original, original, unknown, () => assert.equal(mayBorrow(original, unknown), false));
});

test("without an active scope even an observations getter is never read", () => {
  let reads = 0;
  const source = { get observations() { reads++; throw Error("must not read"); } };
  assert.equal(mayBorrow(source, diagnostic()), false);
  assert.equal(mayBorrow(source, null), false);
  assert.equal(reads, 0);
  for (const value of [null, undefined, 1, "source", () => {}]) assert.equal(mayBorrow(value, null), false);
});

test("marking and scoped validation do not invoke observations accessors", () => {
  let reads = 0;
  const source = { get observations() { reads++; return []; } }, fn = diagnostic();
  mark(source);
  withScope(source, source, fn, () => assert.equal(mayBorrow(source, fn), false));
  assert.equal(reads, 0);
});

test("active authority revalidates both scoped and original array identities", () => {
  const original = mark(fixture()), array = original.observations;
  const scoped = { observations: array }, fn = diagnostic();
  withScope(scoped, original, fn, () => {
    assert.equal(mayBorrow(scoped, fn), true);
    scoped.observations = [];
    assert.equal(mayBorrow(scoped, fn), false);
    scoped.observations = array;
    original.observations = [];
    assert.equal(mayBorrow(scoped, fn), false);
    original.observations = array;
    assert.equal(mayBorrow(scoped, fn), true);
  });
});

test("active authority also revalidates the origin brand after trusted re-marking", () => {
  const original = mark(fixture()), scoped = { observations: original.observations }, fn = diagnostic();
  withScope(scoped, original, fn, () => {
    original.observations = [];
    mark(original);
    assert.equal(mayBorrow(scoped, fn), false);
  });
});

test("an accessor replacing a live scoped array is refused without invoking it", () => {
  const original = mark(fixture()), scoped = { observations: original.observations }, fn = diagnostic();
  let reads = 0;
  withScope(scoped, original, fn, () => {
    Object.defineProperty(scoped, "observations", { configurable: true, get() { reads++; return original.observations; } });
    assert.equal(mayBorrow(scoped, fn), false);
  });
  assert.equal(reads, 0);
});

test("nested valid scopes restore the previous callback authority", () => {
  const source = mark(fixture()), first = diagnostic(), second = diagnostic();
  withScope(source, source, first, () => {
    assert.equal(mayBorrow(source, first), true);
    withScope(source, source, second, () => {
      assert.equal(mayBorrow(source, first), false);
      assert.equal(mayBorrow(source, second), true);
    });
    assert.equal(mayBorrow(source, first), true);
    assert.equal(mayBorrow(source, second), false);
  });
  assert.equal(mayBorrow(source, first), false);
});

test("an invalid nested callback shadows rather than inherits previous authority", () => {
  const source = mark(fixture()), fn = diagnostic();
  withScope(source, source, fn, () => {
    withScope(source, source, () => {}, () => assert.equal(mayBorrow(source, fn), false));
    assert.equal(mayBorrow(source, fn), true);
  });
});

test("an invalid nested original shadows and then restores the previous scope", () => {
  const source = mark(fixture()), invalidOriginal = fixture(), fn = diagnostic();
  withScope(source, source, fn, () => {
    withScope(source, invalidOriginal, fn, () => assert.equal(mayBorrow(source, fn), false));
    assert.equal(mayBorrow(source, fn), true);
  });
});

test("exceptions clean up a top-level scope and restore a nested previous scope", () => {
  const source = mark(fixture()), first = diagnostic(), second = diagnostic(), expected = Error("fixture");
  assert.throws(() => withScope(source, source, first, () => { throw expected; }), error => error === expected);
  assert.equal(mayBorrow(source, first), false);
  withScope(source, source, first, () => {
    assert.throws(() => withScope(source, source, second, () => { throw expected; }), error => error === expected);
    assert.equal(mayBorrow(source, first), true);
    assert.equal(mayBorrow(source, second), false);
  });
  assert.equal(mayBorrow(source, first), false);
});

test("a returned promise does not extend the synchronous evidence scope", async () => {
  const source = mark(fixture()), fn = diagnostic();
  const result = withScope(source, source, fn, async () => {
    assert.equal(mayBorrow(source, fn), true);
    await Promise.resolve();
    assert.equal(mayBorrow(source, fn), false);
    return "done";
  });
  assert.equal(mayBorrow(source, fn), false);
  assert.equal(await result, "done");
});

test("a returned thenable is not inspected or wrapped", () => {
  const source = mark(fixture()), fn = diagnostic();
  let reads = 0;
  const value = { get then() { reads++; throw Error("then inspected"); } };
  assert.equal(withScope(source, source, fn, () => value), value);
  assert.equal(reads, 0);
  assert.equal(mayBorrow(source, fn), false);
});

test("inherited observations and invalid shapes cannot acquire producer authority", () => {
  const fn = diagnostic(), inherited = Object.create({ observations: [] });
  mark(inherited);
  withScope(inherited, inherited, fn, () => assert.equal(mayBorrow(inherited, fn), false));
  for (const source of [null, undefined, [], {}, { observations: null }, { observations: {} }]) {
    assert.equal(mark(source), source);
    assert.equal(carry(source, source), source);
    withScope(source, source, fn, () => assert.equal(mayBorrow(source, fn), false));
  }
});

test("invalid callable arguments fail before entering work or leaving authority", () => {
  const source = mark(fixture()), fn = diagnostic();
  assert.throws(() => register(null), TypeError);
  assert.throws(() => withScope(source, source, fn, null), TypeError);
  assert.equal(mayBorrow(source, fn), false);
});


// Common-engine integration uses only small synthetic saved JSON observations.
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const ENGINE_REQUEST = { type: "company", targetId: "company-fixture", month: "2026-10", cutoffDate: "2026-10-31" };
const ENGINE_AT = "2026-11-01T00:00:00.000Z";
const BORROW_FIELDS = ["phonePriceEstimates", "phoneValuation", "sharedDayUseEvidence", "capacityWitnesses"];
function engineSource() {
  const shared = {
    phonePriceEstimates: [{ sourceDate: "2026-10-15", price: 100, nested: { value: 1 } }],
    phoneValuation: { nested: { value: 2 } },
    sharedDayUseEvidence: { nested: { value: 3 } },
    capacityWitnesses: [{ nested: { value: 4 } }]
  };
  const row = (runId, date, collectedAt) => ({
    companyId: "company-fixture", runId, keyword: "fixture",
    stayDate: date, productType: "lodging", collectedAt,
    inventoryEvidenceVersion: 3, supply: 10, sold: 2,
    publicBookings: 1, phoneBookings: 1,
    publicRevenue: 100, phoneRevenue: 100, estimatedRevenue: 200,
    ...shared, capacityBasis: { count: 10, source: "fixture" }
  });
  return {
    companies: [{ companyId: "company-fixture", primaryName: "Synthetic fixture", capacity: 10 }],
    observations: [
      row("fixture-early", "2026-10-15", "2026-10-10T03:00:00.000Z"),
      row("fixture-late", "2026-10-15", "2026-10-14T03:00:00.000Z"),
      row("fixture-late", "2026-10-16", "2026-10-14T03:00:00.000Z")
    ],
    runs: [
      { id: "fixture-early", keyword: "fixture", collectedAt: "2026-10-10T03:00:00.000Z", collectionQuality: { status: "complete" } },
      { id: "fixture-late", keyword: "fixture", collectedAt: "2026-10-14T03:00:00.000Z", collectionQuality: { status: "complete" } }
    ],
    regions: [], rankObservations: []
  };
}
function engineSnapshot(source, onDiscard = null) {
  return buildMonthlyReportSnapshot(ENGINE_REQUEST, source, ENGINE_AT, { onDiscard });
}
function mutateEvidence(row, value) {
  row.phonePriceEstimates[0].nested.value = value;
  row.phoneValuation.nested.value = value;
  row.sharedDayUseEvidence.nested.value = value;
  row.capacityWitnesses[0].nested.value = value;
}

test("engine scoped borrowing has exact eager JSON output and leaves the synthetic source untouched", () => {
  const source = engineSource(), before = JSON.stringify(source), eager = engineSnapshot(source);
  let superseded = 0;
  const fn = register((reason, row) => {
    assert.equal(mayBorrow(source, fn), true);
    if (reason !== "superseded_observation") return;
    superseded++;
    for (const key of BORROW_FIELDS) assert.equal(row[key], source.observations[0][key]);
    assert.notEqual(row.capacityBasis, source.observations[0].capacityBasis);
  });
  mark(source);
  const borrowed = withScope(source, source, fn, () => engineSnapshot(source, fn));
  assert.equal(superseded, 1, "the historical normalized row really used borrowed evidence");
  assert.equal(JSON.stringify(borrowed), JSON.stringify(eager));
  assert.equal(JSON.stringify(source), before);
  assert.equal(mayBorrow(source, fn), false);
});

test("engine winner evidence is cloned per output row with unchanged key order and plain descriptors", () => {
  const source = mark(engineSource()), eager = engineSnapshot(source), fn = diagnostic();
  const result = withScope(source, source, fn, () => engineSnapshot(source, fn));
  const rows = result.sources.observations;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.date), ["2026-10-15", "2026-10-16"]);
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(Reflect.ownKeys(rows[index]), Reflect.ownKeys(eager.sources.observations[index]));
    for (const key of BORROW_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(rows[index], key);
      assert.equal(Object.hasOwn(descriptor, "value"), true);
      assert.equal(descriptor.writable, true);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.configurable, true);
      assert.equal(descriptor.get, undefined);
      assert.notEqual(rows[index][key], source.observations[0][key]);
    }
  }
  for (const key of BORROW_FIELDS) assert.notEqual(rows[0][key], rows[1][key]);
  const sourceBefore = JSON.stringify(source), secondBefore = JSON.stringify(rows[1]);
  mutateEvidence(rows[0], 99);
  assert.equal(JSON.stringify(rows[1]), secondBefore);
  assert.equal(JSON.stringify(source), sourceBefore);
});

test("engine marked input with a registered callback stays eager outside a scope", () => {
  const source = mark(engineSource());
  let checked = false;
  const fn = register((reason, row) => {
    if (reason !== "superseded_observation") return;
    checked = true;
    for (const key of BORROW_FIELDS) assert.notEqual(row[key], source.observations[0][key]);
  });
  assert.equal(mayBorrow(source, fn), false);
  const result = engineSnapshot(source, fn);
  assert.equal(checked, true);
  assert.equal(JSON.stringify(result), JSON.stringify(engineSnapshot(engineSource())));
});

test("engine unknown public discard remains eager even when a callback mutates historical evidence and source aliases", () => {
  const source = mark(engineSource()), expected = JSON.stringify(engineSnapshot(engineSource()));
  let checked = false;
  const publicDiscard = (reason, row) => {
    if (reason !== "superseded_observation") return;
    checked = true;
    for (const key of BORROW_FIELDS) assert.notEqual(row[key], source.observations[0][key]);
    mutateEvidence(row, 77);
    mutateEvidence(source.observations[0], 88);
  };
  const result = withScope(source, source, publicDiscard, () => engineSnapshot(source, publicDiscard));
  assert.equal(checked, true);
  assert.equal(JSON.stringify(result), expected, "eager winners were captured before the public callback mutated the source");
  assert.equal(mayBorrow(source, publicDiscard), false);
});

test("engine fake source properties cannot activate a registered discard", () => {
  const source = { ...engineSource(), savedMonthlyJson: true, evidenceReadOnly: true };
  let checked = false;
  const fn = register((reason, row) => {
    if (reason !== "superseded_observation") return;
    checked = true;
    for (const key of BORROW_FIELDS) assert.notEqual(row[key], source.observations[0][key]);
  });
  const result = withScope(source, source, fn, () => engineSnapshot(source, fn));
  assert.equal(checked, true);
  assert.equal(JSON.stringify(result), JSON.stringify(engineSnapshot(engineSource())));
});

test("engine a changed original array refuses borrowing while retaining eager output", () => {
  const original = mark(engineSource()), scoped = { ...original };
  original.observations = [];
  let checked = false;
  const fn = register((reason, row) => {
    if (reason !== "superseded_observation") return;
    checked = true;
    for (const key of BORROW_FIELDS) assert.notEqual(row[key], scoped.observations[0][key]);
  });
  const result = withScope(scoped, original, fn, () => engineSnapshot(scoped, fn));
  assert.equal(checked, true);
  assert.equal(JSON.stringify(result), JSON.stringify(engineSnapshot(engineSource())));
});

test("engine eager paths reject a superseded toJSON-undefined observation before any discard callback", () => {
  for (const scoped of [false, true]) {
    const source = engineSource();
    let calls = 0, discarded = 0;
    source.observations[0].phoneValuation = { toJSON() { calls++; return undefined; } };
    const unknownPublicCallback = () => { discarded++; };
    // Such custom inputs are deliberately not claimed to be trusted saved JSON.
    const operation = () => engineSnapshot(source, unknownPublicCallback);
    if (scoped) {
      mark(source);
      assert.throws(() => withScope(source, source, unknownPublicCallback, operation), SyntaxError);
    } else assert.throws(operation, SyntaxError);
    assert.ok(calls > 0);
    assert.equal(discarded, 0);
    assert.equal(mayBorrow(source, unknownPublicCallback), false);
  }
});

test("engine borrowed output preserves absent, null, empty-array and original property order rules", () => {
  const source = engineSource();
  source.observations = [source.observations[1]];
  const row = source.observations[0];
  row.phonePriceEstimates = null;
  row.phoneValuation = null;
  row.sharedDayUseEvidence = null;
  row.capacityWitnesses = null;
  const eager = engineSnapshot(source);
  mark(source);
  const fn = diagnostic(), borrowed = withScope(source, source, fn, () => engineSnapshot(source, fn));
  assert.equal(JSON.stringify(borrowed), JSON.stringify(eager));
  const value = borrowed.sources.observations[0];
  assert.deepEqual(value.phonePriceEstimates, []);
  for (const key of ["phoneValuation", "sharedDayUseEvidence", "capacityWitnesses"]) assert.equal(Object.hasOwn(value, key), false);
  assert.notEqual(value.capacityBasis, row.capacityBasis);
});


test("industry compact carry and scoped wrapper borrow historical evidence while preserving exact eager output", { concurrency: false }, async () => {
  const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
  const markerKey = "__industryOwnedEvidenceParseFixtureV1";
  function sourceForIndustry() {
    const source = engineSource();
    const early = source.observations[0], late = source.observations[1];
    const middle = { ...source.observations[2], runId: "fixture-middle", stayDate: "2026-10-15",
      collectedAt: "2026-10-12T03:00:00.000Z" };
    source.observations = [early, middle, late];
    source.runs.push({ id: "fixture-middle", keyword: "fixture", collectedAt: middle.collectedAt,
      collectionQuality: { status: "complete" } });
    for (const row of source.observations) row.rank = 1;
    early.phonePriceEstimates[0][markerKey] = "phonePriceEstimates";
    early.phoneValuation[markerKey] = "phoneValuation";
    early.sharedDayUseEvidence[markerKey] = "sharedDayUseEvidence";
    early.capacityWitnesses[0][markerKey] = "capacityWitnesses";
    return source;
  }
  async function analyze(marked) {
    const source = sourceForIndustry(), before = JSON.stringify(source);
    if (marked) mark(source);
    const raw = { ...source.companies[0], industryIds: ["glamping"], lodgingTypes: ["glamping"] };
    const catalog = { companies: source.companies, regions: [], runs: source.runs,
      rawCompanies: new Map([[raw.companyId, raw]]) };
    const service = createIndustryAnalysisService({
      dataDir: null, now: () => new Date(ENGINE_AT), runWork: operation => operation(),
      sources: { loadSourcesWithCatalog: async () => ({ source, catalog }) }
    });
    const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, "parse");
    let fixtureParses = 0;
    try {
      Object.defineProperty(JSON, "parse", { ...parseDescriptor, value: function countFixtureParse(text, ...rest) {
        if (typeof text === "string" && text.includes('"' + markerKey + '"')) fixtureParses++;
        return Reflect.apply(parseDescriptor.value, this, [text, ...rest]);
      } });
      const result = await service.analyze({ industry: "glamping", region: "all", month: "2026-10", cutoffDate: "2026-10-31" });
      assert.equal(JSON.stringify(source), before, "the industry path must not mutate synthetic input");
      assert.equal(result.cohort.selectedCompanyCount, 1);
      assert.equal(result.companies.length, 1);
      assert.equal(result.review.observedCompanyDays, 1);
      return { serialized: JSON.stringify(result), fixtureParses };
    } finally {
      Object.defineProperty(JSON, "parse", parseDescriptor);
      await service.stop();
    }
  }
  const originalParse = JSON.parse;
  const eager = await analyze(false);
  assert.equal(JSON.parse, originalParse);
  const borrowed = await analyze(true);
  assert.equal(JSON.parse, originalParse);
  assert.equal(borrowed.serialized, eager.serialized);
  assert.equal(eager.fixtureParses, 12, "three valid temporal rows eagerly clone all four synthetic evidence fields");
  assert.equal(borrowed.fixtureParses, 0, "compact carry plus private industry projection must not expand unused nested evidence");
});


const {
  buildMonthlyReportInsights,
  buildMonthlyReportInsightSourceRunIds
} = require("./lib/monthly_report_insights.cjs");

function insightSourceFixture() {
  const request = { type: "keyword", targetId: "fixture", month: "2026-10", cutoffDate: "2026-10-20" };
  const period = { start: "2026-10-01", end: "2026-10-31", days: 31 };
  const companies = [{ companyId: "company-fixture", primaryName: "Synthetic fixture", capacity: 10 }];
  const specifications = [
    ["rank-a", "2026-10-10T03:00:00.000Z", "complete"],
    ["rank-z", "2026-10-10T03:00:00.000Z", "complete"],
    ["rank-partial", "2026-10-11T03:00:00.000Z", "partial"],
    ["rank-reused", "2026-10-12T03:00:00.000Z", "reused"],
    ["rank-unknown", "2026-10-13T03:00:00.000Z", "unknown"],
    ["rank-bad-date", "not-a-timestamp", "complete"],
    ["rank-null", "2026-10-14T03:00:00.000Z", "complete"],
    ["rank-bool", "2026-10-15T03:00:00.000Z", "complete"],
    ["rank-other", "2026-10-16T03:00:00.000Z", "complete"],
    ["rank-outside", "2026-10-17T03:00:00.000Z", "complete"],
    ["rank-kst-start", "2026-09-30T15:00:00.000Z", "complete"],
    ["rank-before", "2026-09-30T14:59:59.000Z", "complete"],
    ["rank-after", "2026-10-20T15:00:00.000Z", "complete"],
    ["rank-filesystem", "2026-10-18T03:00:00.000Z", "complete"],
    ["rank-fractional", "2026-10-19T03:00:00.000Z", "complete"]
  ];
  const runs = specifications.map(([id, collectedAt, status]) => ({
    id, collectedAt, keyword: id === "rank-other" ? "other" : "fixture",
    collectionQuality: { status }, ...(id === "rank-filesystem" ? { collectedAtSource: "filesystem" } : {})
  }));
  const rankObservations = runs.map(run => ({
    companyId: run.id === "rank-outside" ? "company-outside" : "company-fixture",
    runId: run.id, rank: run.id === "rank-null" ? null : run.id === "rank-bool" ? true : run.id === "rank-fractional" ? 1.5 : 2
  }));
  const observations = [
    {
      companyId: "company-fixture", date: "2026-10-15", productType: "lodging", runId: "normal-z",
      collectedAt: "2026-10-10T03:00:00.000Z", time: Date.parse("2026-10-10T03:00:00.000Z"), observationLeadTimeDays: 5,
      supply: 10, sold: 2, publicBookings: 1, phoneBookings: 1, explicitBlockedBookings: 0,
      estimatedRevenue: 200, publicRevenue: 100, phoneRevenue: 100, revenueEligible: true,
      inventoryEvidenceVersion: 3, capacityBasis: { count: 10, source: "fixture" }, runQuality: "complete"
    },
    { runId: "normal-a", productType: "unsupported", collectedAt: "invalid" },
    { runId: "rank-partial", productType: "unsupported" },
    { runId: "unknown-normal", productType: "unsupported" },
    { runId: null, productType: "unsupported" },
    { runId: "", productType: "unsupported" },
    { runId: 0, productType: "unsupported" }
  ];
  return { request, period, companies, observations, rankObservations, runs };
}

test("insight source-run helper preserves empty and rank-free defaults", () => {
  const input = { request: { type: "keyword", targetId: "fixture", month: "2026-10", cutoffDate: "2026-10-31" },
    period: { start: "2026-10-01", end: "2026-10-31", days: 31 } };
  assert.deepEqual(buildMonthlyReportInsightSourceRunIds(input), []);
  assert.deepEqual(buildMonthlyReportInsightSourceRunIds(input), buildMonthlyReportInsights(input).sourceRunIds);
});

test("insight source-run helper preserves unfiltered normal IDs and exact rank quality, tie, cutoff and KST union", () => {
  const input = insightSourceFixture(), before = JSON.stringify(input);
  const expected = ["normal-a", "normal-z", "rank-kst-start", "rank-partial", "rank-reused", "rank-z", "unknown-normal"];
  const full = buildMonthlyReportInsights(input), sourceIds = buildMonthlyReportInsightSourceRunIds(input);
  assert.deepEqual(sourceIds, expected);
  assert.deepEqual(sourceIds, full.sourceRunIds);
  assert.equal(sourceIds.filter(id => id === "rank-partial").length, 1, "normal/partial-rank overlap is a union");
  assert.equal(JSON.stringify(input), before);
});

test("insight source-run helper keeps same-time lexical rank choice independent of rank input order", () => {
  const input = insightSourceFixture();
  const expected = buildMonthlyReportInsightSourceRunIds(input);
  input.rankObservations.reverse();
  assert.deepEqual(buildMonthlyReportInsightSourceRunIds(input), expected);
  assert.deepEqual(buildMonthlyReportInsights(input).sourceRunIds, expected);
  assert.ok(expected.includes("rank-z"));
  assert.equal(expected.includes("rank-a"), false);
});

test("insight source-run output arrays are fresh and cannot mutate source inputs or full insights", () => {
  const input = insightSourceFixture(), before = JSON.stringify(input);
  const full = buildMonthlyReportInsights(input), first = buildMonthlyReportInsightSourceRunIds(input);
  const expected = [...first];
  first.push("fixture-output-mutation");
  assert.deepEqual(full.sourceRunIds, expected);
  assert.deepEqual(buildMonthlyReportInsightSourceRunIds(input), expected);
  assert.notEqual(first, full.sourceRunIds);
  assert.equal(JSON.stringify(input), before);
});

test("the public full snapshot still clones all four winner fields while private industry projection skips them", () => {
  const marker = "__monthlyFullWinnerCloneFixtureV1";
  function temporalSource() {
    const source = engineSource();
    const middle = { ...source.observations[2], runId: "fixture-middle", stayDate: "2026-10-15",
      collectedAt: "2026-10-12T03:00:00.000Z" };
    source.observations = [source.observations[0], middle, source.observations[1]];
    source.runs.push({ id: "fixture-middle", keyword: "fixture", collectedAt: middle.collectedAt,
      collectionQuality: { status: "complete" } });
    source.observations[0].phonePriceEstimates[0][marker] = 1;
    source.observations[0].phoneValuation[marker] = 2;
    source.observations[0].sharedDayUseEvidence[marker] = 3;
    source.observations[0].capacityWitnesses[0][marker] = 4;
    return source;
  }
  function build(marked) {
    const source = temporalSource(), before = JSON.stringify(source), descriptor = Object.getOwnPropertyDescriptor(JSON, "parse");
    const fn = diagnostic();
    let parses = 0;
    if (marked) mark(source);
    try {
      Object.defineProperty(JSON, "parse", { ...descriptor, value: function countSyntheticParse(text, ...rest) {
        if (typeof text === "string" && text.includes('"' + marker + '"')) parses++;
        return Reflect.apply(descriptor.value, this, [text, ...rest]);
      } });
      const result = marked ? withScope(source, source, fn, () => engineSnapshot(source, fn)) : engineSnapshot(source);
      assert.equal(result.sources.observations.length, 1);
      assert.equal(JSON.stringify(source), before);
      return { serialized: JSON.stringify(result), parses };
    } finally { Object.defineProperty(JSON, "parse", descriptor); }
  }
  const originalParse = JSON.parse, eager = build(false), borrowed = build(true);
  assert.equal(JSON.parse, originalParse);
  assert.equal(borrowed.serialized, eager.serialized);
  assert.equal(eager.parses, 12);
  assert.equal(borrowed.parses, 4, "the public full DTO must still own independent winner evidence");
});


test("private industry projection equals the full subset and preserves intermediate, partial, recovery and rank lineage without aliases", () => {
  const { buildMonthlyReportIndustryProjection } = require("./lib/monthly_reports.cjs");
  const { recoveryRowDigest } = require("./lib/saved_product_recovery.cjs");
  const source = engineSource();
  const normal = source.observations[0];
  const middle = { ...normal, runId: "fixture-middle", collectedAt: "2026-10-12T03:00:00.000Z" };
  const partial = { ...normal, runId: "fixture-partial", stayDate: "2026-10-18",
    collectedAt: "2026-10-13T03:00:00.000Z", partial: true,
    sold: 1, publicBookings: 1, phoneBookings: 0, publicRevenue: 80, phoneRevenue: 0, estimatedRevenue: 80 };
  source.observations.push(middle, partial);
  const recovered = { ...normal, runId: "fixture-recovered", stayDate: "2026-10-17",
    collectedAt: "2026-10-13T03:00:00.000Z" };
  const proof = { kind: "saved_product_recovery_v1", originalRunQuality: "unknown",
    companyId: recovered.companyId, runId: recovered.runId, date: recovered.stayDate,
    productType: recovered.productType, collectedAt: recovered.collectedAt,
    sourceDigest: "a".repeat(64), receiptId: "b".repeat(64), rowDigest: recoveryRowDigest(recovered) };
  source.savedProductRecoveries = [{ row: recovered, certificate: proof }];
  source.runs.push(
    { id: middle.runId, keyword: "fixture", collectedAt: middle.collectedAt, collectionQuality: { status: "complete" } },
    { id: partial.runId, keyword: "fixture", collectedAt: partial.collectedAt, collectionQuality: { status: "partial" } },
    { id: recovered.runId, keyword: "fixture", collectedAt: recovered.collectedAt, collectionQuality: { status: "unknown" } }
  );
  for (const [id, collectedAt, rank] of [
    ["fixture-rank-first", "2026-10-05T03:00:00.000Z", 8],
    ["fixture-rank-middle", "2026-10-06T03:00:00.000Z", 6],
    ["fixture-rank-last", "2026-10-07T03:00:00.000Z", 4]
  ]) {
    source.runs.push({ id, keyword: "fixture", collectedAt, collectionQuality: { status: "complete" } });
    source.rankObservations.push({ companyId: normal.companyId, runId: id, keyword: "fixture", collectedAt, rank });
  }
  const sharedBasis = normal.capacityBasis;
  for (const row of source.observations) row.capacityBasis = sharedBasis;
  recovered.capacityBasis = sharedBasis;
  // The proof binds the exact row, so keep its digest current after sharing metadata.
  proof.rowDigest = recoveryRowDigest(recovered);
  const before = JSON.stringify(source), full = engineSnapshot(source);
  mark(source);
  const fn = diagnostic();
  const projected = withScope(source, source, fn, () =>
    buildMonthlyReportIndustryProjection(ENGINE_REQUEST, source, ENGINE_AT, { onDiscard: fn }));
  const expected = {
    period: full.period, daily: full.daily.map(({ date }) => ({ date })),
    sources: {
      observations: full.sources.observations.map(({ phonePriceEstimates, phoneValuation, sharedDayUseEvidence, capacityWitnesses, ...row }) => row),
      partialEvidence: full.sources.partialEvidence, runIds: full.sources.runIds, observationPolicy: full.sources.observationPolicy
    }
  };
  assert.equal(JSON.stringify(projected), JSON.stringify(expected));
  assert.deepEqual(projected.sources.runIds, [
    "fixture-early", "fixture-late", "fixture-middle", "fixture-partial", "fixture-rank-first",
    "fixture-rank-last", "fixture-rank-middle", "fixture-recovered"
  ]);
  assert.equal(Object.hasOwn(projected, "summary"), false);
  assert.ok(projected.sources.partialEvidence.some(row => row.runId === "fixture-partial" && row.includedInPartialSubtotal));
  const recoveredOutput = projected.sources.observations.find(row => row.runId === "fixture-recovered");
  assert.notEqual(recoveredOutput.sourceRecovery, proof);
  assert.notEqual(recoveredOutput.capacityBasis, sharedBasis);
  assert.notEqual(projected.sources.observations[0].capacityBasis, projected.sources.observations[1].capacityBasis);
  assert.equal(JSON.stringify(source), before);
  recoveredOutput.sourceRecovery.sourceDigest = "c".repeat(64);
  recoveredOutput.capacityBasis.count = 999;
  assert.equal(JSON.stringify(source), before);
  assert.equal(full.sources.observations.find(row => row.runId === "fixture-recovered").sourceRecovery.sourceDigest, proof.sourceDigest);
});

test("public snapshot cannot be switched to projection by unknown options or a foreign token and projection falls back without authority", () => {
  const { buildMonthlyReportIndustryProjection } = require("./lib/monthly_reports.cjs");
  const source = engineSource(), expected = JSON.stringify(engineSnapshot(source)), fn = diagnostic();
  assert.equal(JSON.stringify(buildMonthlyReportIndustryProjection(ENGINE_REQUEST, source, ENGINE_AT, { onDiscard: fn })), expected);
  mark(source);
  assert.equal(JSON.stringify(buildMonthlyReportIndustryProjection(ENGINE_REQUEST, source, ENGINE_AT, { onDiscard: fn })), expected);
  const publicResult = withScope(source, source, fn, () =>
    buildMonthlyReportSnapshot(ENGINE_REQUEST, source, ENGINE_AT,
      { onDiscard: fn, projection: true, industryProjection: true, projectionToken: Symbol.for("owned-industry-projection") },
      Symbol("owned-industry-projection")));
  assert.equal(JSON.stringify(publicResult), expected);
  assert.equal(Object.hasOwn(publicResult, "summary"), true);
  for (const key of BORROW_FIELDS) assert.equal(Object.hasOwn(publicResult.sources.observations[0], key), true);
  const unknown = () => {};
  const fallback = withScope(source, source, unknown, () =>
    buildMonthlyReportIndustryProjection(ENGINE_REQUEST, source, ENGINE_AT, { onDiscard: unknown }));
  assert.equal(JSON.stringify(fallback), expected);
});
