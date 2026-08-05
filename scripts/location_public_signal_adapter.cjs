"use strict";

const crypto = require("node:crypto");

const { buildRegionalSignalObservation } = require("./regional_market_momentum_contract.cjs");

const ADAPTER_SCHEMA_VERSION = "location-public-signal-adapter.v1";
const FIXTURE_ENVELOPE_SCHEMA_VERSION = "location-public-signal-pilot-fixture.v1";
const SOURCE_SELECTION_STATUSES = Object.freeze(["selected", "candidate", "rejected", "unavailable"]);
const NON_NUMERIC_SOURCE_STATUSES = new Set(["rejected", "unavailable"]);
const CANDIDATE_PUBLISHABLE_STATUSES = new Set(["ready", "zero"]);
const SECRET_KEY_TOKENS = Object.freeze([
  "apikey",
  "servicekey",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "authorization",
  "credential",
  "signature",
  "accesskey",
  "privatekey"
]);

class LocationPublicSignalAdapterError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "LocationPublicSignalAdapterError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "") {
  throw new LocationPublicSignalAdapterError(code, message, path);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function rawPayloadHash(rawPayload) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(rawPayload)), "utf8").digest("hex");
}

function normalizedSecretKey(value = "") {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretLikeKey(value = "") {
  const normalized = normalizedSecretKey(value);
  return SECRET_KEY_TOKENS.some((token) => normalized === token || normalized.startsWith(token) || normalized.endsWith(token));
}

function credentialUrl(value = "") {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    const parsed = new URL(value);
    return [...parsed.searchParams.keys()].some(isSecretLikeKey)
      || Boolean(parsed.username)
      || Boolean(parsed.password);
  } catch {
    return true;
  }
}

function sensitivePayloadPath(value, path = "rawPayload", seen = new WeakSet()) {
  if (typeof value === "string") return credentialUrl(value) ? path : "";
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return path;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isSecretLikeKey(key)) return childPath;
    const nested = sensitivePayloadPath(child, childPath, seen);
    if (nested) return nested;
  }
  return "";
}

function numeric(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function activeRegistryRegions(registry = {}) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) fail("REGISTRY_REQUIRED", "An injected canonical region registry is required", "registry");
  if (registry.active === false) fail("REGISTRY_INACTIVE", "The injected canonical region registry is inactive", "registry.active");
  if (typeof registry.registryVersion !== "string" || !registry.registryVersion.trim()) fail("REGISTRY_INVALID", "The injected canonical region registry requires registryVersion", "registry.registryVersion");
  if (!Array.isArray(registry.regions)) fail("REGISTRY_INVALID", "The injected canonical region registry must contain regions", "registry.regions");
  return registry.regions.filter((region) => region && region.active === true && typeof region.regionKey === "string");
}

function catalogSources(catalog = {}) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) fail("CATALOG_REQUIRED", "An injected public source catalog is required", "catalog");
  if (!catalog.catalogVersion || !Array.isArray(catalog.sources)) fail("CATALOG_INVALID", "The injected public source catalog is invalid", "catalog");
  return catalog.sources;
}

function exactRegion(registry, regionKey) {
  const matches = activeRegistryRegions(registry).filter((region) => region.regionKey === regionKey);
  if (matches.length !== 1) fail("REGION_NOT_ACTIVE_CANONICAL", "Fixture regionKey must exactly match one active canonical region", "fixture.regionKey");
  return matches[0];
}

function exactSource(catalog, sourceId, regionKey) {
  const matches = catalogSources(catalog).filter((source) => source && source.sourceId === sourceId);
  if (matches.length !== 1) fail("SOURCE_NOT_UNIQUE", "Fixture sourceId must exactly match one catalog source", "fixture.sourceId");
  const source = matches[0];
  if (!SOURCE_SELECTION_STATUSES.includes(source.selectionStatus)) fail("SOURCE_SELECTION_INVALID", "Catalog source selectionStatus is invalid", "source.selectionStatus");
  if (!Array.isArray(source.pilotRegionKeys) || !source.pilotRegionKeys.includes(regionKey)) {
    fail("SOURCE_REGION_NOT_SELECTED", "Catalog source is not scoped to the exact fixture regionKey", "source.pilotRegionKeys");
  }
  if (credentialUrl(source.officialUrl)) fail("SOURCE_CREDENTIAL_URL_FORBIDDEN", "Catalog officialUrl must not contain credentials", "source.officialUrl");
  return source;
}

function validateFixtureEnvelope(envelope = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("FIXTURE_ENVELOPE_REQUIRED", "A stored fixture envelope is required", "envelope");
  if (envelope.schemaVersion !== FIXTURE_ENVELOPE_SCHEMA_VERSION) fail("FIXTURE_ENVELOPE_VERSION_INVALID", "Fixture envelope schemaVersion is invalid", "envelope.schemaVersion");
  if (envelope.fixtureOnly !== true || envelope.synthetic !== true || envelope.actualData !== false || envelope.networkAccess !== false) {
    fail("FIXTURE_BOUNDARY_REQUIRED", "Only stored synthetic fixture envelopes with networkAccess=false are accepted", "envelope");
  }
  if (!Array.isArray(envelope.observations)) fail("FIXTURE_OBSERVATIONS_REQUIRED", "Fixture envelope observations are required", "envelope.observations");
  const fixtureIds = envelope.observations.map((fixture) => fixture?.fixtureId);
  if (fixtureIds.some((fixtureId) => typeof fixtureId !== "string" || !fixtureId.trim())) fail("FIXTURE_ID_REQUIRED", "Every fixture observation requires fixtureId", "envelope.observations");
  if (new Set(fixtureIds).size !== fixtureIds.length) fail("FIXTURE_ID_DUPLICATE", "Fixture IDs must be unique", "envelope.observations");
}

function adaptFixtureObservation({ catalog, registry, envelope, fixture }) {
  const region = exactRegion(registry, fixture.regionKey);
  const source = exactSource(catalog, fixture.sourceId, fixture.regionKey);
  const status = String(fixture.status || "missing").trim().toLowerCase();
  const sensitivePath = sensitivePayloadPath(fixture.rawPayload);
  if (sensitivePath) fail("RAW_PAYLOAD_SENSITIVE_FIELD", "Raw fixture payload contains a secret-like key or credential URL", sensitivePath);
  if (fixture.rawPayload === undefined) fail("RAW_PAYLOAD_REQUIRED", "Stored rawPayload is required for fixture provenance", "fixture.rawPayload");
  if (["missing", "conflict"].includes(status) && (numeric(fixture.rawValue) || numeric(fixture.normalizedValue))) {
    fail("NON_NUMERIC_STATUS_VALUE_FORBIDDEN", "Missing or conflict observations cannot carry numeric values", "fixture.status");
  }
  if (
    NON_NUMERIC_SOURCE_STATUSES.has(source.selectionStatus)
    && (!["missing", "conflict"].includes(status) || numeric(fixture.rawValue) || numeric(fixture.normalizedValue))
  ) {
    fail("SOURCE_NUMERIC_OBSERVATION_FORBIDDEN", "Rejected or unavailable catalog sources cannot create numeric observations", "source.selectionStatus");
  }
  if (source.selectionStatus === "candidate" && CANDIDATE_PUBLISHABLE_STATUSES.has(status)) {
    fail("CANDIDATE_PUBLISHABLE_OBSERVATION_FORBIDDEN", "Candidate sources cannot create ready or zero observations", "fixture.status");
  }

  const observation = buildRegionalSignalObservation({
    schemaVersion: fixture.schemaVersion,
    regionKey: fixture.regionKey,
    signalKey: fixture.signalKey,
    signalRole: fixture.signalRole,
    source: {
      sourceId: source.sourceId,
      provider: source.provider,
      datasetId: source.datasetId,
      officialUrl: source.officialUrl
    },
    observedAt: fixture.observedAt,
    measurementPeriod: fixture.measurementPeriod,
    sampleCount: fixture.sampleCount,
    coverage: fixture.coverage,
    refreshedAt: fixture.refreshedAt,
    asOf: fixture.asOf,
    availableAt: fixture.availableAt,
    status,
    confidence: fixture.confidence,
    penalties: fixture.penalties,
    rawValue: fixture.rawValue,
    normalizedValue: fixture.normalizedValue,
    normalization: fixture.normalization,
    provenance: {
      catalogVersion: catalog.catalogVersion,
      fixtureId: fixture.fixtureId,
      payloadHash: rawPayloadHash(fixture.rawPayload),
      license: source.license
    }
  });

  return Object.freeze({
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    fixtureEnvelopeSchemaVersion: envelope.schemaVersion,
    fixtureSetId: String(envelope.fixtureSetId || ""),
    fixtureId: fixture.fixtureId,
    synthetic: true,
    catalogVersion: catalog.catalogVersion,
    registryVersion: String(registry.registryVersion || ""),
    regionKey: region.regionKey,
    sourceId: source.sourceId,
    sourceSelectionStatus: source.selectionStatus,
    observation
  });
}

function adaptLocationPublicSignalEnvelope({ catalog, registry, envelope } = {}) {
  validateFixtureEnvelope(envelope);
  activeRegistryRegions(registry);
  catalogSources(catalog);
  const adapted = envelope.observations.map((fixture) => adaptFixtureObservation({ catalog, registry, envelope, fixture }));
  return Object.freeze({
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    fixtureEnvelopeSchemaVersion: envelope.schemaVersion,
    fixtureSetId: String(envelope.fixtureSetId || ""),
    fixtureOnly: true,
    synthetic: true,
    networkAccess: false,
    catalogVersion: catalog.catalogVersion,
    registryVersion: String(registry.registryVersion || ""),
    observations: Object.freeze(adapted)
  });
}

module.exports = {
  ADAPTER_SCHEMA_VERSION,
  FIXTURE_ENVELOPE_SCHEMA_VERSION,
  LocationPublicSignalAdapterError,
  SOURCE_SELECTION_STATUSES,
  adaptLocationPublicSignalEnvelope,
  isSecretLikeKey,
  rawPayloadHash,
  sensitivePayloadPath
};
