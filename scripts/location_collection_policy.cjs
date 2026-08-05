"use strict";

const INVOCATION_CLASSES = Object.freeze([
  "scheduled_current_snapshot",
  "scheduled_closed_period",
  "rolling_window_signal",
  "release_driven",
  "event_driven_reference",
  "unavailable"
]);
const ACTIVATION_STATUSES = Object.freeze(["blocked", "reference_only", "unavailable"]);
const PROVIDER_CADENCE_STATUSES = Object.freeze(["unverified", "verified"]);
const CADENCE_UNITS = new Set(["day", "week", "month", "release", "event"]);
const AUTOMATIC_INVOCATION_CLASSES = new Set([
  "scheduled_current_snapshot",
  "scheduled_closed_period",
  "rolling_window_signal",
  "release_driven"
]);
const REQUIRED_POLICY_FIELDS = Object.freeze([
  "policyId",
  "sourceId",
  "invocationClass",
  "activationStatus",
  "actualCallsEnabled",
  "externalCallOnRead",
  "triggerType",
  "timezone",
  "proposedCadence",
  "providerCadenceStatus",
  "providerCadence",
  "minimumRefreshInterval",
  "measurementWindowRule",
  "expectedAvailabilityDelay",
  "overlapWindow",
  "lateArrivalPolicy",
  "watermarkRule",
  "idempotencyKeyRule",
  "duplicateKeyRule",
  "sharedCollectionScope",
  "freshnessPolicy",
  "staleAfter",
  "backfillPolicy",
  "retentionPolicy",
  "failurePolicy",
  "manualRefreshPolicy",
  "approvalRequired",
  "remainingBlockers",
  "schemaVersion"
]);

class LocationCollectionPolicyError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "LocationCollectionPolicyError";
    this.code = "INVALID_LOCATION_COLLECTION_POLICY";
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNullableNonNegativeNumber(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function normalizeSourceIdSet(value) {
  if (value instanceof Set) return new Set(value);
  if (!Array.isArray(value)) return null;
  return new Set(value.map((entry) => (
    typeof entry === "string" ? entry : entry?.sourceId
  )).filter(Boolean));
}

function validateLocationCollectionPolicyRegistry(registry, options = {}) {
  if (!isPlainObject(registry)) {
    throw new LocationCollectionPolicyError("Location collection policy registry must be an object", ["registry"]);
  }

  const errors = [];
  if (registry.schemaVersion !== "location-collection-policy-registry.v1") {
    errors.push("schemaVersion must be location-collection-policy-registry.v1");
  }
  if (typeof registry.policyVersion !== "string" || !registry.policyVersion.trim()) {
    errors.push("policyVersion is required");
  }
  if (registry.timezone !== "Asia/Seoul") errors.push("timezone must be Asia/Seoul");
  if (registry.actualCallsEnabled !== false) errors.push("actualCallsEnabled must be false");
  if (registry.externalCallOnRead !== false) errors.push("externalCallOnRead must be false");
  if (JSON.stringify(registry.allowedInvocationClasses) !== JSON.stringify(INVOCATION_CLASSES)) {
    errors.push("allowedInvocationClasses must match the supported invocation classes");
  }
  if (JSON.stringify(registry.allowedActivationStatuses) !== JSON.stringify(ACTIVATION_STATUSES)) {
    errors.push("allowedActivationStatuses must match the fixture-only activation states");
  }
  if (JSON.stringify(registry.policyFieldContract) !== JSON.stringify(REQUIRED_POLICY_FIELDS)) {
    errors.push("policyFieldContract must match the required policy fields");
  }
  if (!isPlainObject(registry.preparationBoundary)) errors.push("preparationBoundary is required");
  if (registry.preparationBoundary?.externalDataEndpointCalls !== false) {
    errors.push("preparationBoundary.externalDataEndpointCalls must be false");
  }
  if (registry.preparationBoundary?.credentialsRead !== false) {
    errors.push("preparationBoundary.credentialsRead must be false");
  }
  if (registry.preparationBoundary?.previewReadOrWrite !== false) {
    errors.push("preparationBoundary.previewReadOrWrite must be false");
  }
  if (registry.preparationBoundary?.schedulerRegistered !== false) {
    errors.push("preparationBoundary.schedulerRegistered must be false");
  }
  if (registry.preparationBoundary?.uiReadBehavior !== "stored_snapshot_only") {
    errors.push("preparationBoundary.uiReadBehavior must be stored_snapshot_only");
  }
  if (!Array.isArray(registry.policies)) errors.push("policies must be an array");
  if (!Array.isArray(registry.referenceDependencies)) errors.push("referenceDependencies must be an array");
  if (!Array.isArray(registry.excludedSources)) errors.push("excludedSources must be an array");

  const policyIds = new Set();
  const sourceIds = new Set();
  const policies = Array.isArray(registry.policies) ? registry.policies : [];
  for (const [index, policy] of policies.entries()) {
    const prefix = `policies[${index}]`;
    if (!isPlainObject(policy)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of REQUIRED_POLICY_FIELDS) {
      if (!Object.hasOwn(policy, field)) errors.push(`${prefix}.${field} is required`);
    }
    if (!/^location\.collection\.[a-z0-9._-]+\.v\d+$/.test(policy.policyId || "")) {
      errors.push(`${prefix}.policyId is invalid`);
    }
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(policy.sourceId || "")) {
      errors.push(`${prefix}.sourceId is invalid`);
    }
    if (policyIds.has(policy.policyId)) errors.push(`${prefix}.policyId is duplicated`);
    if (sourceIds.has(policy.sourceId)) errors.push(`${prefix}.sourceId is duplicated`);
    policyIds.add(policy.policyId);
    sourceIds.add(policy.sourceId);

    if (!INVOCATION_CLASSES.includes(policy.invocationClass)) {
      errors.push(`${prefix}.invocationClass is invalid`);
    }
    if (!ACTIVATION_STATUSES.includes(policy.activationStatus)) {
      errors.push(`${prefix}.activationStatus is invalid`);
    }
    if (policy.actualCallsEnabled !== false) errors.push(`${prefix}.actualCallsEnabled must be false`);
    if (policy.externalCallOnRead !== false) errors.push(`${prefix}.externalCallOnRead must be false`);
    if (policy.timezone !== registry.timezone) errors.push(`${prefix}.timezone must match registry timezone`);
    if (policy.schemaVersion !== "location-collection-policy.v1") {
      errors.push(`${prefix}.schemaVersion must be location-collection-policy.v1`);
    }
    if (!isPlainObject(policy.proposedCadence) || !CADENCE_UNITS.has(policy.proposedCadence?.unit)) {
      errors.push(`${prefix}.proposedCadence is invalid`);
    } else {
      const interval = policy.proposedCadence.interval;
      if (interval !== null && (!Number.isInteger(interval) || interval <= 0)) {
        errors.push(`${prefix}.proposedCadence.interval must be null or a positive integer`);
      }
      if (AUTOMATIC_INVOCATION_CLASSES.has(policy.invocationClass)
        && !["release"].includes(policy.proposedCadence.unit)
        && (!Number.isInteger(interval) || interval <= 0)) {
        errors.push(`${prefix}.proposedCadence.interval is required for scheduled policies`);
      }
    }
    if (!PROVIDER_CADENCE_STATUSES.includes(policy.providerCadenceStatus)) {
      errors.push(`${prefix}.providerCadenceStatus is invalid`);
    }
    if (!isPlainObject(policy.minimumRefreshInterval)
      || !isNullableNonNegativeNumber(policy.minimumRefreshInterval?.hours)) {
      errors.push(`${prefix}.minimumRefreshInterval.hours is invalid`);
    }
    if (!isPlainObject(policy.measurementWindowRule) || typeof policy.measurementWindowRule?.type !== "string") {
      errors.push(`${prefix}.measurementWindowRule is invalid`);
    }
    if (!isPlainObject(policy.expectedAvailabilityDelay)
      || !isNullableNonNegativeNumber(policy.expectedAvailabilityDelay?.hours)) {
      errors.push(`${prefix}.expectedAvailabilityDelay.hours is invalid`);
    }
    if (!isPlainObject(policy.overlapWindow)
      || !isNullableNonNegativeNumber(policy.overlapWindow?.days)
      || !isNullableNonNegativeNumber(policy.overlapWindow?.months)) {
      errors.push(`${prefix}.overlapWindow is invalid`);
    }
    if (!isPlainObject(policy.watermarkRule) || !Array.isArray(policy.watermarkRule?.fields)) {
      errors.push(`${prefix}.watermarkRule is invalid`);
    }
    if (!isPlainObject(policy.idempotencyKeyRule) || !Array.isArray(policy.idempotencyKeyRule?.fields)) {
      errors.push(`${prefix}.idempotencyKeyRule is invalid`);
    } else if (AUTOMATIC_INVOCATION_CLASSES.has(policy.invocationClass)) {
      const idempotencyFields = new Set(policy.idempotencyKeyRule.fields);
      const requiredIdentityFields = [
        "sourceId",
        policy.sharedCollectionScope ? "sharedCollectionScope" : "regionKey",
        "measurementPeriod",
        "operation",
        "sourceSchemaVersion",
        "mappingVersion",
        "configVersion"
      ];
      for (const field of requiredIdentityFields) {
        if (!idempotencyFields.has(field)) errors.push(`${prefix}.idempotencyKeyRule must include ${field}`);
      }
      if (["scheduled_closed_period", "release_driven"].includes(policy.invocationClass)
        && policy.lateArrivalPolicy?.enabled === true
        && !idempotencyFields.has("lateArrivalVersion")) {
        errors.push(`${prefix}.idempotencyKeyRule must include lateArrivalVersion`);
      }
    }
    if (!isPlainObject(policy.duplicateKeyRule) || !Array.isArray(policy.duplicateKeyRule?.fields)) {
      errors.push(`${prefix}.duplicateKeyRule is invalid`);
    }
    if (!isPlainObject(policy.freshnessPolicy)
      || !isNullableNonNegativeNumber(policy.freshnessPolicy?.freshForHours)
      || !isNullableNonNegativeNumber(policy.freshnessPolicy?.staleAfterHours)) {
      errors.push(`${prefix}.freshnessPolicy is invalid`);
    }
    if (!isPlainObject(policy.staleAfter) || !isNullableNonNegativeNumber(policy.staleAfter?.hours)) {
      errors.push(`${prefix}.staleAfter.hours is invalid`);
    }
    if (policy.freshnessPolicy?.staleAfterHours !== policy.staleAfter?.hours) {
      errors.push(`${prefix}.freshnessPolicy.staleAfterHours must equal staleAfter.hours`);
    }
    if (Number.isFinite(policy.freshnessPolicy?.freshForHours)
      && Number.isFinite(policy.freshnessPolicy?.staleAfterHours)
      && policy.freshnessPolicy.freshForHours > policy.freshnessPolicy.staleAfterHours) {
      errors.push(`${prefix}.freshnessPolicy fresh boundary must not exceed stale boundary`);
    }
    if (!isPlainObject(policy.retentionPolicy)
      || policy.retentionPolicy?.automaticDeletion !== false
      || policy.retentionPolicy?.maximumSnapshots !== null) {
      errors.push(`${prefix}.retentionPolicy must preserve unbounded immutable history`);
    }
    if (!isPlainObject(policy.failurePolicy) || policy.failurePolicy?.overwriteReadyOnFailure !== false) {
      errors.push(`${prefix}.failurePolicy must not overwrite the last ready snapshot`);
    }
    if (!isPlainObject(policy.manualRefreshPolicy)
      || policy.manualRefreshPolicy?.bypassMinimumRefreshInterval !== false) {
      errors.push(`${prefix}.manualRefreshPolicy cannot bypass the minimum refresh interval`);
    }
    if (!Array.isArray(policy.remainingBlockers) || policy.remainingBlockers.length === 0) {
      errors.push(`${prefix}.remainingBlockers must be a non-empty array`);
    }
    if (policy.providerCadenceStatus === "unverified" && policy.providerCadence !== null) {
      errors.push(`${prefix}.providerCadence must be null while unverified`);
    }
    if (policy.invocationClass === "event_driven_reference") {
      if (policy.activationStatus !== "reference_only") errors.push(`${prefix} reference must be reference_only`);
      if (policy.triggerType !== "manual_change_event") errors.push(`${prefix} reference must use manual_change_event`);
      if (policy.manualRefreshPolicy?.allowed !== true) errors.push(`${prefix} reference must require an explicit manual action`);
    } else if (policy.invocationClass === "unavailable") {
      if (policy.activationStatus !== "unavailable") errors.push(`${prefix} unavailable source must remain unavailable`);
      if (policy.triggerType !== "none") errors.push(`${prefix} unavailable source must not have a trigger`);
      if (policy.manualRefreshPolicy?.allowed !== false) errors.push(`${prefix} unavailable source must not allow refresh`);
      if (policy.approvalRequired !== false) errors.push(`${prefix} unavailable source cannot be activated by approval alone`);
      if (policy.adapterCreationAllowed !== false || policy.taskCreationAllowed !== false) {
        errors.push(`${prefix} unavailable source must not create an adapter or task`);
      }
    } else if (policy.activationStatus !== "blocked") {
      errors.push(`${prefix} collection source must remain blocked in fixture-only readiness`);
    }
  }

  const expectedSourceIds = normalizeSourceIdSet(options.catalogSources || options.expectedSourceIds);
  if (expectedSourceIds) {
    for (const sourceId of expectedSourceIds) {
      if (!sourceIds.has(sourceId)) errors.push(`catalog source is not classified: ${sourceId}`);
    }
    for (const sourceId of sourceIds) {
      if (!expectedSourceIds.has(sourceId)) errors.push(`policy source is not in the catalog: ${sourceId}`);
    }
  }

  const connectionSources = Array.isArray(options.connectionSources) ? options.connectionSources : [];
  const policyBySourceId = new Map(policies.map((policy) => [policy.sourceId, policy]));
  for (const connection of connectionSources) {
    const policy = policyBySourceId.get(connection.sourceId);
    if (!policy) {
      errors.push(`connection source has no policy: ${connection.sourceId}`);
      continue;
    }
    if (connection.collectionPolicyId !== policy.policyId) {
      errors.push(`connection policyId mismatch: ${connection.sourceId}`);
    }
    if (connection.invocationClass !== policy.invocationClass) {
      errors.push(`connection invocationClass mismatch: ${connection.sourceId}`);
    }
    if (connection.externalCallOnRead !== false || connection.externalCallOnRead !== policy.externalCallOnRead) {
      errors.push(`connection externalCallOnRead mismatch: ${connection.sourceId}`);
    }
    if (connection.activationStatus !== policy.activationStatus) {
      errors.push(`connection activationStatus mismatch: ${connection.sourceId}`);
    }
  }

  const referenceIds = new Set();
  for (const [index, reference] of (Array.isArray(registry.referenceDependencies) ? registry.referenceDependencies : []).entries()) {
    const prefix = `referenceDependencies[${index}]`;
    if (!isPlainObject(reference) || typeof reference.referenceId !== "string") {
      errors.push(`${prefix} is invalid`);
      continue;
    }
    if (referenceIds.has(reference.referenceId)) errors.push(`${prefix}.referenceId is duplicated`);
    referenceIds.add(reference.referenceId);
    if (!Array.isArray(reference.appliesToSourceIds) || reference.appliesToSourceIds.length === 0) {
      errors.push(`${prefix}.appliesToSourceIds is required`);
    }
    for (const sourceId of reference.appliesToSourceIds || []) {
      if (!sourceIds.has(sourceId)) errors.push(`${prefix} references an unknown source: ${sourceId}`);
    }
    if (reference.activationStatus !== "reference_only") errors.push(`${prefix} must be reference_only`);
    if (reference.externalCallOnRead !== false) errors.push(`${prefix}.externalCallOnRead must be false`);
    if (reference.automaticTaskCreation !== false) errors.push(`${prefix}.automaticTaskCreation must be false`);
    if (reference.versionRequired !== true) errors.push(`${prefix}.versionRequired must be true`);
    if (reference.exactMappingOnly !== true) errors.push(`${prefix}.exactMappingOnly must be true`);
  }

  const excludedIds = new Set();
  for (const [index, excluded] of (Array.isArray(registry.excludedSources) ? registry.excludedSources : []).entries()) {
    const prefix = `excludedSources[${index}]`;
    if (!isPlainObject(excluded) || !/^[a-z0-9][a-z0-9._-]+$/.test(excluded.sourceId || "")) {
      errors.push(`${prefix}.sourceId is invalid`);
      continue;
    }
    if (excludedIds.has(excluded.sourceId)) errors.push(`${prefix}.sourceId is duplicated`);
    excludedIds.add(excluded.sourceId);
    if (excluded.invocationClass !== "unavailable") {
      errors.push(`${prefix}.invocationClass must be unavailable`);
    }
    if (excluded.activationStatus !== "unavailable") {
      errors.push(`${prefix}.activationStatus must be unavailable`);
    }
    if (excluded.actualCallsEnabled !== false || excluded.externalCallOnRead !== false) {
      errors.push(`${prefix} must disable calls and calls on read`);
    }
    if (excluded.noAdapter !== true || excluded.noTask !== true) {
      errors.push(`${prefix} must set noAdapter and noTask`);
    }
    if (sourceIds.has(excluded.sourceId)) errors.push(`${prefix} must not also be a policy source`);
  }

  if (errors.length) {
    throw new LocationCollectionPolicyError("Location collection policy validation failed", errors);
  }
  return registry;
}

function indexCollectionPolicies(registry, options = {}) {
  const validated = validateLocationCollectionPolicyRegistry(registry, options);
  return new Map(validated.policies.map((policy) => [policy.sourceId, policy]));
}

function getCollectionPolicy(registry, sourceId, options = {}) {
  return indexCollectionPolicies(registry, options).get(String(sourceId || "").trim()) || null;
}

function isAutomaticCollectionAllowed(policy) {
  return Boolean(policy)
    && AUTOMATIC_INVOCATION_CLASSES.has(policy.invocationClass)
    && policy.activationStatus === "active"
    && policy.actualCallsEnabled === true
    && policy.externalCallOnRead === false;
}

function assertStoredSnapshotReadBoundary(registry) {
  const validated = validateLocationCollectionPolicyRegistry(registry);
  if (validated.externalCallOnRead !== false
    || validated.policies.some((policy) => policy.externalCallOnRead !== false)) {
    throw new LocationCollectionPolicyError("UI reads must use stored snapshots only", ["externalCallOnRead"]);
  }
  return true;
}

module.exports = {
  ACTIVATION_STATUSES,
  AUTOMATIC_INVOCATION_CLASSES,
  INVOCATION_CLASSES,
  LocationCollectionPolicyError,
  PROVIDER_CADENCE_STATUSES,
  REQUIRED_POLICY_FIELDS,
  assertStoredSnapshotReadBoundary,
  getCollectionPolicy,
  indexCollectionPolicies,
  isAutomaticCollectionAllowed,
  validateLocationCollectionPolicyRegistry
};
