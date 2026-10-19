"use strict";
// Exercise the actual detail-only prepared matcher and unchanged shared
// identity functions. Each read prepares its identity once; a later read always
// creates a fresh closure, even if a caller reuses a changed company object.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const names = ["normalizeCompanyIdentityName", "companyHistoryKeys", "historyObservationMatchesCompany", "companyHistoryDailyIdentity",
  "historyDailyObservationMatchesCompany", "createCompanyDetailObservationMatcher"];
const declarations = names.map(name => {
  const code = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(code, `Missing actual server function ${name}`); return code;
});
function fixture() {
  const context = vm.createContext({}); vm.runInContext(declarations.join("\n"), context);
  const calls = { keys: 0, daily: 0 }, keys = context.companyHistoryKeys, daily = context.companyHistoryDailyIdentity;
  context.companyHistoryKeys = company => { calls.keys++; return keys(company); };
  context.companyHistoryDailyIdentity = company => { calls.daily++; return daily(company); };
  return { context, calls, prepare: company => context.createCompanyDetailObservationMatcher(company), baseline: (row, company) => context.historyObservationMatchesCompany(row, company)
    || context.historyDailyObservationMatchesCompany(row, context.companyHistoryDailyIdentity(company)) };
}
const companies = [
  { companyId: "cmp_place_35644668", primaryName: "월명 글램핑 (주)", nameKey: "월명글램핑", aliases: ["월명글램핑", "㈜Moonlight", "별칭"], duplicateNotes: [{ mergedCompanyId: "old-one" }] },
  { companyId: "cmp_place_two", primaryName: "다른 글램핑", aliases: ["다른글램핑", "공통이름"], duplicateNotes: [{ mergedCompanyId: "old-two" }] },
  { companyId: "cmp_place_three", primaryName: "주식회사 ＭＯＯＮＬＩＧＨＴ", aliases: ["공통이름"], duplicateNotes: [] }
];
function rows(count = 6000) {
  let seed = 35644668;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const keys = ["cmp_place_35644668", " CMP_PLACE_35644668 ", "cmp_place_two", "cmp_place_three", "old-one", "old-two", "별칭", "월명 글램핑", "㈜moonlight", "unknown", "", null];
  const names = ["월명 글램핑", "다른 글램핑", "농업회사법인 Ｍｏｏｎｌｉｇｈｔ", "공통이름", "미등록", "", null];
  return Array.from({ length: count }, (_, index) => ({ observationId: "row" + random(107), companyKey: keys[random(keys.length)],
    companyName: names[random(names.length)], sold: index % 7 === 0 ? 0 : index % 11 === 0 ? null : random(17), missing: index % 11 === 0 }));
}
function scoped(values, company, matcher) {
  const selected = new Map();
  for (const row of values) if (matcher(row, company)) selected.set(row.observationId, row); else selected.delete(row.observationId);
  return [...selected.values()];
}

test("prepared detail matcher is exactly equivalent to the original shared OR for repeated company keys, names, aliases and merged ids", () => {
  const f = fixture(), reference = fixture(), values = rows(), before = JSON.stringify(values);
  for (const company of companies) {
    const prepared = f.prepare(company);
    for (const row of values) assert.equal(prepared(row), reference.baseline(row, company));
  }
  assert.deepEqual(f.calls, { keys: companies.length, daily: companies.length }, "identity sets are prepared once for each selected source read");
  assert.equal(JSON.stringify(values), before, "matching cannot rewrite normal zero or missing observations");
});

test("the prepared matcher preserves scoped last-id reassignment, row order, zero and missing values", () => {
  const f = fixture(), reference = fixture(), values = rows(1200);
  values.push({ observationId: "reassigned", companyKey: companies[0].companyId, sold: 4 },
    { observationId: "other", companyKey: companies[0].companyId, sold: 0, publicRevenue: 0 },
    { observationId: "reassigned", companyKey: companies[1].companyId, sold: 8 },
    { observationId: "reassigned", companyKey: companies[0].companyId, sold: null, missing: true });
  for (const company of companies) assert.deepEqual(scoped(values, company, f.prepare(company)), scoped(values, company, reference.baseline));
  const selected = scoped(values, companies[0], f.prepare(companies[0]));
  assert.deepEqual(selected.slice(-2), values.slice(-3).filter(row => row.companyKey === companies[0].companyId));
  assert.equal(selected.at(-2).sold, 0); assert.equal(selected.at(-1).sold, null);
});

test("each prepared read handles a later company identity without retaining a previous read's aliases", () => {
  const f = fixture(), before = structuredClone(companies[0]);
  const oldRead = f.prepare(before);
  assert.equal(oldRead({ companyKey: "new-alias" }), false);
  const latest = { ...before, aliases: [...before.aliases, "new-alias"], duplicateNotes: [...before.duplicateNotes, { mergedCompanyId: "new-merged" }] };
  const latestRead = f.prepare(latest);
  assert.equal(latestRead({ companyKey: "new-alias" }), true);
  assert.equal(latestRead({ companyKey: "new-merged" }), true);
  assert.equal(oldRead({ companyKey: "new-alias" }), false);
  before.aliases.push("in-place-alias");
  assert.equal(f.prepare(before)({ companyKey: "in-place-alias" }), true, "a new read of the same changed object prepares new identity sets");
  assert.equal(oldRead({ companyKey: "in-place-alias" }), false);
  assert.deepEqual(f.calls, { keys: 3, daily: 3 });
});

test("only the company detail store uses the prepared matcher and it is outside monthly calculation dependencies", () => {
  assert.ok(/historyReader:\s*\(file, company\)\s*=>\s*companyDetailSourceIndex\.readHistory\(file, company, createCompanyDetailObservationMatcher\(company\)\)/.test(source),
    "only detail history gets a read-scoped prepared matcher");
  const fingerprint = source.match(/^function companyIntegratedCalculationFingerprint\([^]*?^}/m)?.[0];
  assert.ok(fingerprint);
  const callbacks = fingerprint.match(/const callbacks = \[([\s\S]*?)\];/)?.[1].split(",").map(value => value.trim());
  assert.equal(callbacks.length, 45);
  assert.equal(callbacks.includes("createCompanyDetailObservationMatcher"), false);
  assert.equal(callbacks.includes("companyDetailObservationMatcher"), false);
});
