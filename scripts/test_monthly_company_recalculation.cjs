"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");

const request = { type: "company", targetId: "cmp_a", month: "2026-09", cutoffDate: "2026-09-26" };
const makeRun = (id, extra = {}) => ({ id, keyword: "경남글램핑", collectedAt: "2026-09-20T00:00:00Z", collectedAtSource: "manifest",
  checkIn: "2026-09-20", collectionQuality: { status: "complete" }, ...extra });
const makeCompany = (id = "cmp_a", extra = {}) => ({ companyId: id, primaryName: "월명글램핑", placeIds: [id === "cmp_a" ? "1001" : "2002"],
  manualCorrection: { active: true, lodgingBasisTotal: 16 }, ...extra });
function catalog(companies, runs) {
  return { rawCompanies: new Map(companies.map(company => [company.companyId, company])),
    companies: companies.map(company => ({ companyId: company.companyId, regionKey: "sancheong", regionKeys: ["sancheong", "gyeongnam"] })), runs };
}
function dependencies(loadRun, extra = {}) {
  return {
    loadRun,
    companyProductAvailabilityMatch: (company, item) => company.placeIds.includes(item.placeId) ? "place_id" : "",
    applyCompanyManualCorrection: (item, company) => ({ ...item, total: company.manualCorrection.lodgingBasisTotal || 16,
      inventoryEvidence: { version: item.legacy ? 2 : 4 } }),
    buildHistoryObservations: (stored, collectedAt) => stored.availability.items.flatMap(item => (item.dates || ["2026-09-26"]).map(stayDate => ({
      companyKey: item.companyId, runId: stored.run.id, keyword: stored.run.keyword, collectedAt, stayDate,
      productType: "lodging", inventoryEvidenceVersion: item.inventoryEvidence.version, supply: item.total,
      sold: 3, publicBookings: 1, phoneBookings: 2
    }))),
    ...extra
  };
}

test("recalculation spans every keyword run and preserves original observation times with read-only loading", async () => {
  const runs = Array.from({ length: 24 }, (_, i) => makeRun(`run_${i}`, {
    keyword: i % 2 ? "산청글램핑" : "경남글램핑",
    collectedAt: `2026-09-${String(i + 3).padStart(2, "0")}T00:00:00Z`
  }));
  runs.push(makeRun("blocked", { collectionQuality: { status: "blocked" } }), makeRun("unknown", { collectionQuality: null }),
    makeRun("future", { collectedAt: "2026-09-26T15:01:00Z" }), makeRun("unverified", { collectedAtSource: "filesystem" }),
    makeRun("future_stay", { checkIn: "2026-10-01" }));
  const company = makeCompany("cmp_a", { keywords: {
    broad: { keyword: "경남글램핑", runs: runs.filter(run => run.keyword === "경남글램핑").map(run => ({ runId: run.id })) },
    local: { keyword: "산청글램핑", runs: runs.filter(run => run.keyword === "산청글램핑").map(run => ({ runId: run.id })) }
  } });
  const data = catalog([company], runs), before = JSON.stringify([...data.rawCompanies]);
  const calls = [];
  const helper = createMonthlyCompanyRecalculation(dependencies(async (id, options) => {
    calls.push(id);
    for (const key of ["skipCompanyMaster", "skipHistory", "skipTraffic", "skipTourismVisitors", "skipTourismVisitorHistory",
      "skipTourismDemandStrengthHistory", "skipTourismResourceDemandHistory", "skipTourismDiversityHistory"]) assert.equal(options[key], true, key);
    assert.equal(options.applyCompanyMaster, false); assert.equal(options.includeRankComparison, false);
    return { run: { id, collectedAt: "2026-09-27T00:00:00Z" }, availability: { items: [
      { placeId: "1001", dates: ["2026-08-31", "2026-09-02", "2026-09-26", "2026-10-01"] }
    ] } };
  }));
  const rows = await helper(request, data);
  assert.equal(calls.length, 24, "the previous company-detail limit of twenty runs must not truncate a month");
  assert.equal(rows.length, 24, "outside-month and post-stay observations are omitted");
  assert.deepEqual(new Set(rows.map(row => row.keyword)), new Set(["경남글램핑", "산청글램핑"]));
  for (const row of rows) {
    assert.equal(row.collectedAt, runs.find(run => run.id === row.runId).collectedAt, "never stamp historic evidence with recalculation time");
    assert.equal(row.companyKey, "cmp_a"); assert.equal(row.companyId, "cmp_a");
    assert.equal(row.supply, 16); assert.equal(row.inventoryEvidenceVersion, 4); assert.equal(row.readOnlyRecalculated, true);
  }
  assert.equal(JSON.stringify([...data.rawCompanies]), before);
});

test("only inventory corrections and exact report scope trigger saved-run loading", async () => {
  const run = makeRun("shared");
  const companies = [
    makeCompany("cmp_a", { runIds: [run.id] }),
    makeCompany("cmp_meta", { runIds: [run.id], manualCorrection: { active: true, regionOverride: "sancheong", note: "검토 메모" } }),
    makeCompany("cmp_disabled", { runIds: [run.id], manualCorrection: { active: false, lodgingBasisTotal: 16 } }),
    makeCompany("cmp_segments", { runIds: [run.id], manualCorrection: { active: true, roomSegments: [{ count: "8" }, { count: "8" }] } }),
    makeCompany("cmp_day", { runIds: [run.id], manualCorrection: { active: true, dayUseBasisTotal: 3 } }),
    makeCompany("cmp_product", { runIds: [run.id], manualCorrection: { active: true, productStockCorrections: [{ productId: "room", stock: 8 }] } }),
    makeCompany("cmp_outside", { runIds: [run.id] })
  ];
  companies.forEach((company, index) => { company.placeIds = [`place_${index}`]; });
  const data = catalog(companies, [run]);
  data.companies.find(company => company.companyId === "cmp_outside").regionKey = "other";
  data.companies.find(company => company.companyId === "cmp_outside").regionKeys = ["other"];
  let calls = 0;
  const helper = createMonthlyCompanyRecalculation(dependencies(async id => {
    calls++; return { run: { id }, availability: { items: companies.map(company => ({ placeId: company.placeIds[0] })) } };
  }));
  const rows = await helper({ ...request, type: "region", targetId: "sancheong" }, data);
  assert.equal(calls, 1, "a shared run is only loaded once for multiple corrected companies");
  assert.deepEqual(new Set(rows.map(row => row.companyId)), new Set(["cmp_a", "cmp_segments", "cmp_day", "cmp_product"]));
  assert.equal((await helper({ ...request, targetId: "cmp_meta" }, data)).length, 0);
  assert.equal(calls, 1, "metadata-only correction does not read any raw runs");
});

test("known collection spans outside the month are skipped without reading unrelated old evidence", async () => {
  const runs = [
    makeRun("old", { collectedAt: "2026-07-01T00:00:00Z", checkIn: "2026-07-01", checkOut: "2026-07-02", bookingRangeDays: 31 }),
    makeRun("boundary", { collectedAt: "2026-08-31T00:00:00Z", checkIn: "2026-08-31", checkOut: "2026-09-01", bookingRangeDays: 1 }),
    makeRun("overlap", { collectedAt: "2026-08-15T00:00:00Z", checkIn: "2026-08-15", checkOut: "2026-08-16", bookingRangeDays: 31 }),
    makeRun("unknown_span", { collectedAt: "2026-08-01T00:00:00Z", checkIn: "2026-08-01", checkOut: "2026-08-02" }),
    makeRun("current", { bookingRangeDays: 31 })
  ];
  const company = makeCompany("cmp_a", { runIds: runs.map(run => run.id) });
  const calls = [];
  const helper = createMonthlyCompanyRecalculation(dependencies(async id => {
    calls.push(id);
    if (["old", "boundary"].includes(id)) throw new Error("unrelated old evidence is unavailable");
    return { run: { id }, availability: { items: [{ placeId: "1001" }] } };
  }));
  const rows = await helper(request, catalog([company], runs));
  assert.deepEqual(calls, ["overlap", "unknown_span", "current"]);
  assert.equal(rows.length, 3, "unknown spans remain candidates and one-night checkout never truncates a 31-day query");
});

test("keyword reports only recalculate matching keyword runs and strong provider identities", async () => {
  const runs = [makeRun("broad"), makeRun("local", { keyword: "산청글램핑" })];
  const company = makeCompany("cmp_a", { runIds: runs.map(run => run.id) });
  const calls = [];
  const helper = createMonthlyCompanyRecalculation(dependencies(async id => {
    calls.push(id); return { run: { id }, availability: { items: [
      { placeId: "9999", name: company.primaryName }, { placeId: "1001", name: "이름 변경" }
    ] } };
  }));
  const rows = await helper({ ...request, type: "keyword", targetId: "산청글램핑" }, catalog([company], runs));
  assert.deepEqual(calls, ["local"]); assert.equal(rows.length, 1); assert.equal(rows[0].keyword, "산청글램핑");
});

test("unreadable needed evidence fails closed while insufficient legacy evidence stays excluded", async () => {
  const data = catalog([makeCompany("cmp_a", { inventory: { runIds: ["r"] } })], [makeRun("r")]);
  for (const loadRun of [async () => null, async () => { throw new Error("unreadable"); }, async () => ({ run: { id: "different" }, availability: { items: [] } })]) {
    await assert.rejects(createMonthlyCompanyRecalculation(dependencies(loadRun))(request, data), error => error.code === "MONTHLY_RECALCULATION_UNAVAILABLE");
  }
  const legacy = createMonthlyCompanyRecalculation(dependencies(async id => ({ run: { id }, availability: { items: [{ placeId: "1001", legacy: true }] } })));
  assert.deepEqual(await legacy(request, data), [], "unreconstructable rows are not fabricated as successful current evidence");
  const noCompany = createMonthlyCompanyRecalculation(dependencies(async id => ({ run: { id }, availability: { items: [{ placeId: "other", name: "월명글램핑" }] } })));
  assert.deepEqual(await noCompany(request, data), []);
  const blocked = createMonthlyCompanyRecalculation(dependencies(async id => ({ run: { id, collectionQuality: { status: "blocked" } }, availability: { items: [{ placeId: "1001" }] } })));
  assert.deepEqual(await blocked(request, data), []);
  const ambiguous = createMonthlyCompanyRecalculation(dependencies(async id => ({ run: { id }, availability: { items: [{ placeId: "1001" }, { placeId: "1001" }] } })));
  await assert.rejects(ambiguous(request, data), error => error.code === "MONTHLY_RECALCULATION_UNAVAILABLE");
});
