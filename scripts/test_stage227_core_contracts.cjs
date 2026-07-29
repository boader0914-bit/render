"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./test_stage227_helpers.cjs");
const {
  CORE_API_BASE,
  CORE_DATA_BOUNDARY,
  CORE_STAGE,
  CORE_STORE_KIND,
  normalizeV2CollectionMode,
  normalizeV2DetailRankRanges,
  normalizeV2ProductMode,
  projectV2ResultSummary,
  projectV2SearchHistoryEntry,
  provisionalMetadata
} = require("./integration/contracts/core_ui.cjs");
const { emptyCoreStore, normalizeFixture } = require("./integration/repositories/core_store.cjs");
const {
  assertSyntheticFixtureStrings,
  loadFixture
} = require("./integration/bootstrap/core_runtime.cjs");
const {
  INTEGRATION_FEATURE_DEFINITIONS,
  readIntegrationFeatureFlags
} = require("./integration_feature_flags.cjs");

const CORE_FLAG = "V2_INTEGRATION_PLATFORM_CORE_ENABLED";
const FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage227", "fresh_collection.json");

assert.equal(CORE_STAGE, 227);
assert.equal(CORE_API_BASE, "/api/integration/core");
assert.equal(CORE_STORE_KIND, "stage227-provisional-memory");
assert.equal(CORE_DATA_BOUNDARY, "fresh-only");

const definition = INTEGRATION_FEATURE_DEFINITIONS.platformCore;
assert.ok(definition, "Stage 224's platformCore feature definition is required");
assert.equal(definition.envKey, CORE_FLAG, "the Stage 224-frozen flag name must not drift");
assert.deepEqual(definition.dependsOn, ["auth"], "platformCore must depend on integration auth");
assert.equal(readIntegrationFeatureFlags({ NODE_ENV: "test" }).platformCore, false, "platformCore defaults false");
assert.equal(readIntegrationFeatureFlags({ NODE_ENV: "test", [CORE_FLAG]: "true" }).platformCore, false, "core must fail closed without auth");
assert.equal(readIntegrationFeatureFlags({
  NODE_ENV: "test",
  V2_INTEGRATION_AUTH_ENABLED: "true",
  [CORE_FLAG]: "true"
}).platformCore, true, "core may turn on only with integration auth");

assert.equal(normalizeV2CollectionMode("fast"), "fast");
assert.equal(normalizeV2CollectionMode("unknown"), "precision");
assert.equal(normalizeV2ProductMode("lodging"), "lodging");
assert.equal(normalizeV2ProductMode("unknown"), "all");
assert.equal(normalizeV2DetailRankRanges("1-20"), "1-20");
assert.equal(normalizeV2DetailRankRanges("arbitrary", "1-5"), "1-5");

const metadata = provisionalMetadata();
assert.deepEqual(metadata, {
  stage: 227,
  provisional: true,
  acceptance: "synthetic-fixture-only",
  dataBoundary: "fresh-only",
  store: "stage227-provisional-memory",
  source: "empty",
  fixtureMode: false,
  providerCalls: 0,
  legacyRuntimeReads: 0,
  processRestartRecovery: false
});
assert.equal(provisionalMetadata({ fixtureMode: true }).source, "synthetic-fresh-collection");

const empty = emptyCoreStore();
assert.equal(empty.storeKind, CORE_STORE_KIND);
assert.equal(empty.fixtureMode, false);
for (const field of ["companies", "fixtureHistory", "jobs", "interests", "locationCardRequests", "tourismRequests"]) {
  assert.deepEqual(empty[field], [], `default ${field} must be empty`);
}
assert.throws(
  () => normalizeFixture({ source: "synthetic-fresh-collection", companies: [] }),
  /explicitly synthetic/,
  "a fixture needs an explicit synthetic marker"
);
assert.throws(
  () => normalizeFixture({ synthetic: true, source: "legacy-copy", companies: [] }),
  /synthetic fresh-collection/,
  "old-source fixtures must be rejected"
);

assert.ok(fs.existsSync(FIXTURE_PATH), "Stage 227 fresh-collection fixture is required");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
assert.equal(fixture.synthetic, true);
assert.equal(fixture.source, "synthetic-fresh-collection");
assert.match(String(fixture.fixtureVersion || ""), /^stage227-/);
const normalizedFixture = normalizeFixture(fixture);
assert.equal(normalizedFixture.fixtureMode, true);
assert.ok(normalizedFixture.companies.length > 0, "fixture needs fresh companies for populated-state acceptance");
assert.equal(loadFixture({ env: { NODE_ENV: "test", V2_STAGE227_FIXTURE_MODE: "" }, projectRoot: ROOT }), null);
assert.equal(loadFixture({ env: { NODE_ENV: "production", V2_STAGE227_FIXTURE_MODE: "true" }, projectRoot: ROOT }), null);
assert.equal(
  loadFixture({ env: { NODE_ENV: "test", V2_STAGE227_FIXTURE_MODE: "true" }, projectRoot: ROOT }).fixtureVersion,
  fixture.fixtureVersion,
  "only an explicit test environment may load the synthetic fixture"
);
assert.throws(
  () => loadFixture({
    env: { NODE_ENV: "test", V2_STAGE227_FIXTURE_MODE: "true", V2_STAGE227_FIXTURE_PATH: path.join(ROOT, "package.json") },
    projectRoot: ROOT
  }),
  /must stay inside/,
  "fixture traversal outside the Stage 227 fixture root must fail"
);
assert.throws(
  () => assertSyntheticFixtureStrings({ referenceUrl: "https://provider.example.com/live" }),
  /example\.invalid/,
  "non-reserved provider URLs must fail the synthetic fixture guard"
);

const parity = fixture.parity || {};
assert.ok(parity.input, "fixture parity.input is required");
assert.ok(parity.expectedV2ResultSummary, "fixture parity.expectedV2ResultSummary is required");
assert.deepEqual(
  projectV2ResultSummary(parity.input),
  parity.expectedV2ResultSummary,
  "the additive compatibility projection must preserve frozen V2 business values"
);
const expectedHistory = projectV2SearchHistoryEntry(fixture.history?.[0] || {});
assert.deepEqual(Object.keys(expectedHistory), [
  "id", "runId", "keyword", "clientRequestId", "runLabel", "regionLabel", "checkIn", "checkOut",
  "detailRankRanges", "collectionMode", "collectionModeLabel", "bookingRangeDays", "status", "createdAt",
  "completedAt", "quotaCounted", "reuseMode", "reusedFromRunId", "resultSummary"
], "V2 history compatibility keys must remain frozen");

const productionCoreFiles = [
  "scripts/integration/contracts/core_ui.cjs",
  "scripts/integration/repositories/core_store.cjs",
  "scripts/integration/services/core_service.cjs",
  "scripts/integration/http/core_http.cjs",
  "scripts/integration/bootstrap/core_runtime.cjs"
];
const disallowedRuntimeDependencies = [
  /\bOUTPUTS_DIR\b/,
  /\bCUSTOMER_DB_DIR\b/,
  /\bCOMPANY_MASTER_FILE\b/,
  /\bB2B_SEARCH_HISTORY_FILE\b/,
  /\bB2B_INTEREST_LODGES_FILE\b/,
  /\bLOCATION_CARD_REQUESTS_FILE\b/,
  /createTourismCollector/,
  /gyeongnam_glamping_crawl/,
  /tourism_collector/,
  /require\(["']node:child_process["']\)/,
  /\bfetch\s*\(/
];
for (const relative of productionCoreFiles) {
  const absolute = path.join(ROOT, relative);
  assert.ok(fs.existsSync(absolute), `${relative} is required`);
  const source = fs.readFileSync(absolute, "utf8");
  for (const pattern of disallowedRuntimeDependencies) {
    assert.doesNotMatch(source, pattern, `${relative} must not read legacy runtime data or call a provider (${pattern})`);
  }
  assert.doesNotMatch(source, /(?:raw|output|source|fixture)(?:File)?Path\s*:/i, `${relative} must not expose a raw filesystem path`);
}

const fixtureText = fs.readFileSync(FIXTURE_PATH, "utf8");
assert.doesNotMatch(fixtureText, /(?:customer_db|company_master|tourism_data|(?:^|[\\/])outputs[\\/])/i);
assert.doesNotMatch(fixtureText, /[A-Z]:\\|\/Users\/|\/var\/data/);

console.log("Stage 227 frozen flag, empty boundary, fixture parity and no-provider/no-legacy contracts passed");
