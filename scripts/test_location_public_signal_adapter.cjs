"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "public signal adapter fixtures" });

const {
  ADAPTER_SCHEMA_VERSION,
  FIXTURE_ENVELOPE_SCHEMA_VERSION,
  LocationPublicSignalAdapterError,
  adaptLocationPublicSignalEnvelope,
  rawPayloadHash,
  sensitivePayloadPath
} = require("./location_public_signal_adapter.cjs");

const root = path.resolve(__dirname, "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "web", "data", "location_public_source_catalog.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(root, "web", "data", "location_region_registry.json"), "utf8"));
const fixtureEnvelope = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "location_public_signal_pilot.json"), "utf8"));
const adapterSource = fs.readFileSync(path.join(__dirname, "location_public_signal_adapter.cjs"), "utf8");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function singleFixtureEnvelope(fixture, overrides = {}) {
  return {
    ...clone(fixtureEnvelope),
    ...overrides,
    observations: [clone(fixture)]
  };
}

function expectAdapterError(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof LocationPublicSignalAdapterError);
    assert.equal(error.code, code);
    assert.equal(typeof error.path, "string");
    return true;
  });
}

assert.equal(fixtureEnvelope.schemaVersion, FIXTURE_ENVELOPE_SCHEMA_VERSION);
assert.equal(fixtureEnvelope.fixtureOnly, true);
assert.equal(fixtureEnvelope.synthetic, true);
assert.equal(fixtureEnvelope.actualData, false);
assert.equal(fixtureEnvelope.networkAccess, false);

const result = adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: fixtureEnvelope });
assert.equal(result.schemaVersion, ADAPTER_SCHEMA_VERSION);
assert.equal(result.fixtureOnly, true);
assert.equal(result.synthetic, true);
assert.equal(result.networkAccess, false);
assert.equal(result.catalogVersion, catalog.catalogVersion);
assert.equal(result.registryVersion, registry.registryVersion);
assert.equal(result.observations.length, 4);
assert.equal(Object.isFrozen(result), true);
assert.equal(Object.isFrozen(result.observations), true);

const byFixtureId = new Map(result.observations.map((entry) => [entry.fixtureId, entry]));
const pilotRegions = new Set(result.observations.slice(0, 3).map((entry) => entry.regionKey));
assert.deepEqual(
  [...pilotRegions].sort(),
  ["kr_gyeonggi_pocheon", "kr_gyeongnam_hadong", "kr_gyeongnam_sancheong"].sort(),
  "the stored synthetic pilot must contain an exact canonical observation for each pilot region"
);

for (const fixture of fixtureEnvelope.observations) {
  const adapted = byFixtureId.get(fixture.fixtureId);
  assert.ok(adapted, `missing adapted fixture ${fixture.fixtureId}`);
  const source = catalog.sources.find((entry) => entry.sourceId === fixture.sourceId);
  const observation = adapted.observation;
  assert.equal(adapted.schemaVersion, ADAPTER_SCHEMA_VERSION);
  assert.equal(adapted.fixtureEnvelopeSchemaVersion, fixtureEnvelope.schemaVersion);
  assert.equal(adapted.regionKey, fixture.regionKey);
  assert.equal(adapted.sourceId, fixture.sourceId);
  assert.equal(adapted.sourceSelectionStatus, source.selectionStatus);
  assert.equal(observation.schemaVersion, fixture.schemaVersion);
  assert.equal(observation.regionKey, fixture.regionKey);
  assert.equal(observation.signalKey, fixture.signalKey);
  assert.equal(observation.signalRole, fixture.signalRole);
  assert.deepEqual(observation.source, {
    sourceId: source.sourceId,
    provider: source.provider,
    datasetId: source.datasetId,
    officialUrl: source.officialUrl
  });
  assert.equal(observation.observedAt, fixture.observedAt);
  assert.equal(observation.measurementPeriod.from, fixture.measurementPeriod.from);
  assert.equal(observation.measurementPeriod.to, fixture.measurementPeriod.to);
  assert.equal(observation.sampleCount, fixture.sampleCount);
  assert.equal(observation.coverage.numerator, fixture.coverage.numerator);
  assert.equal(observation.coverage.denominator, fixture.coverage.denominator);
  assert.equal(observation.coverage.note, fixture.coverage.note);
  assert.equal(observation.asOf, fixture.asOf);
  assert.equal(observation.refreshedAt, fixture.refreshedAt);
  assert.equal(observation.availableAt, fixture.availableAt);
  assert.equal(observation.status, fixture.status);
  assert.equal(observation.confidence.grade, fixture.confidence.grade);
  assert.equal(observation.confidence.score, fixture.confidence.score);
  assert.deepEqual(observation.penalties, fixture.penalties);
  assert.equal(observation.rawValue, fixture.rawValue);
  assert.equal(observation.normalizedValue, fixture.normalizedValue);
  assert.equal(observation.provenance.catalogVersion, catalog.catalogVersion);
  assert.equal(observation.provenance.fixtureId, fixture.fixtureId);
  assert.equal(observation.provenance.payloadHash, rawPayloadHash(fixture.rawPayload));
  assert.equal(observation.provenance.license, source.license);
  assert.match(observation.provenance.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.prototype.hasOwnProperty.call(adapted, "rawPayload"), false, "raw fixture payload must not leak into the adapter result");
}

const ready = byFixtureId.get("synthetic-pocheon-visitors-2026-07");
const zero = byFixtureId.get("synthetic-sancheong-events-zero-2026-07");
const partial = byFixtureId.get("synthetic-hadong-camping-supply-2026-07");
const unavailableSns = byFixtureId.get("synthetic-pocheon-public-sns-unavailable-2026-07");
assert.equal(ready.sourceSelectionStatus, "selected");
assert.equal(ready.observation.status, "ready");
assert.equal(ready.observation.rawValue, 12840);
assert.equal(zero.observation.status, "zero");
assert.equal(zero.observation.rawValue, 0);
assert.equal(zero.observation.normalizedValue, 0);
assert.equal(partial.observation.status, "partial");
assert.equal(partial.observation.coverage.numerator, 18);
assert.equal(partial.observation.coverage.denominator, 22);
assert.equal(partial.observation.penalties[0].code, "synthetic_capacity_missing");
assert.equal(unavailableSns.sourceSelectionStatus, "unavailable");
assert.equal(unavailableSns.observation.status, "missing");
assert.equal(unavailableSns.observation.rawValue, null);
assert.equal(unavailableSns.observation.normalizedValue, null);
assert.equal(unavailableSns.observation.confidence.grade, "U");
assert.notEqual(zero.observation.status, unavailableSns.observation.status, "an explicit observed zero must remain distinct from missing data");

const hashA = rawPayloadHash({ b: 2, a: { y: 4, x: 3 } });
const hashB = rawPayloadHash({ a: { x: 3, y: 4 }, b: 2 });
const hashChanged = rawPayloadHash({ a: { x: 3, y: 5 }, b: 2 });
assert.equal(hashA, hashB, "raw payload hash must be stable across object key order");
assert.notEqual(hashA, hashChanged, "raw payload hash must bind provenance to payload content");

const readyFixture = fixtureEnvelope.observations[0];
for (const invalidRegionKey of ["kr_gyeonggi_pocheonn", "KR_GYEONGGI_POCHEON", ""]) {
  expectAdapterError(
    () => adaptLocationPublicSignalEnvelope({
      catalog,
      registry,
      envelope: singleFixtureEnvelope({ ...readyFixture, regionKey: invalidRegionKey })
    }),
    "REGION_NOT_ACTIVE_CANONICAL"
  );
}
const inactiveRegistry = clone(registry);
inactiveRegistry.regions.find((entry) => entry.regionKey === readyFixture.regionKey).active = false;
expectAdapterError(
  () => adaptLocationPublicSignalEnvelope({ catalog, registry: inactiveRegistry, envelope: singleFixtureEnvelope(readyFixture) }),
  "REGION_NOT_ACTIVE_CANONICAL"
);

const candidateSourceId = "naver.datalab.search_trend";
for (const forbiddenStatus of ["ready", "zero"]) {
  const candidateFixture = {
    ...clone(readyFixture),
    fixtureId: `synthetic-candidate-${forbiddenStatus}`,
    sourceId: candidateSourceId,
    status: forbiddenStatus,
    rawValue: forbiddenStatus === "zero" ? 0 : 50,
    normalizedValue: forbiddenStatus === "zero" ? 0 : 50
  };
  expectAdapterError(
    () => adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: singleFixtureEnvelope(candidateFixture) }),
    "CANDIDATE_PUBLISHABLE_OBSERVATION_FORBIDDEN"
  );
}
const candidatePartialFixture = {
  ...clone(readyFixture),
  fixtureId: "synthetic-candidate-partial",
  sourceId: candidateSourceId,
  status: "partial",
  coverage: { numerator: 20, denominator: 31, note: "synthetic candidate coverage" },
  penalties: [{ code: "candidate_not_selected", message: "Synthetic candidate fixture", points: 15 }],
  confidence: {
    grade: "C",
    score: 60,
    penalties: [{ code: "candidate_not_selected", message: "Synthetic candidate fixture", points: 15 }]
  }
};
const candidatePartial = adaptLocationPublicSignalEnvelope({
  catalog,
  registry,
  envelope: singleFixtureEnvelope(candidatePartialFixture)
}).observations[0];
assert.equal(candidatePartial.sourceSelectionStatus, "candidate");
assert.equal(candidatePartial.observation.status, "partial");

for (const blockedSourceId of ["kto.events.snapshot.20230830", "public.raw_sns.regional_mentions"]) {
  const blockedFixture = {
    ...clone(readyFixture),
    fixtureId: `synthetic-blocked-${blockedSourceId}`,
    sourceId: blockedSourceId,
    status: "partial",
    rawValue: 5,
    normalizedValue: 25
  };
  expectAdapterError(
    () => adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: singleFixtureEnvelope(blockedFixture) }),
    "SOURCE_NUMERIC_OBSERVATION_FORBIDDEN"
  );
}

const missingWithZero = {
  ...clone(unavailableSns ? fixtureEnvelope.observations.find((entry) => entry.fixtureId === unavailableSns.fixtureId) : readyFixture),
  fixtureId: "synthetic-missing-with-zero",
  rawValue: 0,
  normalizedValue: 0
};
expectAdapterError(
  () => adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: singleFixtureEnvelope(missingWithZero) }),
  "NON_NUMERIC_STATUS_VALUE_FORBIDDEN"
);

const unavailableImplicitZero = {
  ...clone(readyFixture),
  fixtureId: "synthetic-unavailable-implicit-zero",
  sourceId: "public.raw_sns.regional_mentions",
  status: "zero",
  rawValue: null,
  normalizedValue: null
};
expectAdapterError(
  () => adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: singleFixtureEnvelope(unavailableImplicitZero) }),
  "SOURCE_NUMERIC_OBSERVATION_FORBIDDEN"
);

for (const rawPayload of [
  { nested: { serviceKey: "must-not-appear" } },
  { referenceUrl: "https://example.go.kr/catalog?access_token=must-not-appear" }
]) {
  const sensitiveFixture = {
    ...clone(readyFixture),
    fixtureId: "synthetic-sensitive-payload",
    rawPayload
  };
  let caught;
  try {
    adaptLocationPublicSignalEnvelope({ catalog, registry, envelope: singleFixtureEnvelope(sensitiveFixture) });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LocationPublicSignalAdapterError);
  assert.equal(caught.code, "RAW_PAYLOAD_SENSITIVE_FIELD");
  assert.equal(caught.message.includes("must-not-appear"), false, "adapter errors must not echo secret-like fixture values");
}
assert.equal(sensitivePayloadPath({ nested: { clientSecret: "redacted" } }), "rawPayload.nested.clientSecret");

const credentialCatalog = clone(catalog);
credentialCatalog.sources.find((entry) => entry.sourceId === readyFixture.sourceId).officialUrl += "?serviceKey=must-not-appear";
let credentialError;
try {
  adaptLocationPublicSignalEnvelope({ catalog: credentialCatalog, registry, envelope: singleFixtureEnvelope(readyFixture) });
} catch (error) {
  credentialError = error;
}
assert.ok(credentialError instanceof LocationPublicSignalAdapterError);
assert.equal(credentialError.code, "SOURCE_CREDENTIAL_URL_FORBIDDEN");
assert.equal(credentialError.message.includes("must-not-appear"), false);

expectAdapterError(
  () => adaptLocationPublicSignalEnvelope({
    catalog,
    registry,
    envelope: { ...singleFixtureEnvelope(readyFixture), networkAccess: true }
  }),
  "FIXTURE_BOUNDARY_REQUIRED"
);
expectAdapterError(
  () => adaptLocationPublicSignalEnvelope({
    catalog,
    registry,
    envelope: { ...singleFixtureEnvelope(readyFixture), actualData: true }
  }),
  "FIXTURE_BOUNDARY_REQUIRED"
);

assert.doesNotMatch(adapterSource, /\bfetch\s*\(|https?\.(?:get|request)\s*\(|\baxios\b|XMLHttpRequest|WebSocket/, "fixture adapter must not contain network execution code");
assert.equal(networkGuard.blockedAttempts(), 0, "public signal adapter fixtures must never call the network");
networkGuard.restore();

console.log("Location public signal pilot adapter fixture checks passed");
