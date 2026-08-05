"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  LocationCollectionPolicyError,
  assertStoredSnapshotReadBoundary,
  getCollectionPolicy,
  indexCollectionPolicies,
  isAutomaticCollectionAllowed,
  validateLocationCollectionPolicyRegistry
} = require("./location_collection_policy.cjs");

const guard = installFixtureNetworkGuard({ label: "location collection policy fixtures" });

try {
  const root = path.join(__dirname, "..");
  const policyPath = path.join(root, "web", "data", "location_collection_policy.json");
  const connectionPath = path.join(root, "web", "data", "location_api_connection_registry.json");
  const catalogPath = path.join(root, "web", "data", "location_public_source_catalog.json");
  const modulePath = path.join(__dirname, "location_collection_policy.cjs");
  const registry = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const connectionRegistry = JSON.parse(fs.readFileSync(connectionPath, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const moduleSource = fs.readFileSync(modulePath, "utf8");
  const options = {
    catalogSources: catalog.sources,
    connectionSources: connectionRegistry.sources
  };

  assert.equal(validateLocationCollectionPolicyRegistry(registry, options), registry);
  assert.equal(assertStoredSnapshotReadBoundary(registry), true);
  assert.equal(registry.schemaVersion, "location-collection-policy-registry.v1");
  assert.equal(registry.policyVersion, "pilot-2026-08-05.v1");
  assert.equal(registry.timezone, "Asia/Seoul");
  assert.equal(registry.actualCallsEnabled, false);
  assert.equal(registry.externalCallOnRead, false);
  assert.equal(registry.preparationBoundary.mode, "fixture-only-collection-readiness");
  assert.equal(registry.preparationBoundary.externalDataEndpointCalls, false);
  assert.equal(registry.preparationBoundary.credentialsRead, false);
  assert.equal(registry.preparationBoundary.previewReadOrWrite, false);
  assert.equal(registry.preparationBoundary.schedulerRegistered, false);
  assert.equal(registry.preparationBoundary.uiReadBehavior, "stored_snapshot_only");

  const catalogSourceIds = new Set(catalog.sources.map((source) => source.sourceId));
  const policySourceIds = new Set(registry.policies.map((policy) => policy.sourceId));
  assert.equal(registry.policies.length, 16);
  assert.equal(policySourceIds.size, 16);
  assert.deepEqual(policySourceIds, catalogSourceIds, "every catalog source must have exactly one policy");

  const invocationBySource = {
    "kto.tour_info.resources": "scheduled_current_snapshot",
    "kto.tour_info.events": "scheduled_current_snapshot",
    "kto.tour_info.lodging": "scheduled_current_snapshot",
    "kto.gocamping.inventory": "scheduled_current_snapshot",
    "kto.bigdata.visitors": "scheduled_closed_period",
    "kto.bigdata.resource_demand": "scheduled_closed_period",
    "mois.legal_dong.reference": "event_driven_reference",
    "kma.asos.daily_weather": "scheduled_closed_period",
    "kosis.population.sigungu": "release_driven",
    "molit.traffic_volume.statistics": "scheduled_closed_period",
    "molit.standard_node_link.snapshot": "event_driven_reference",
    "naver.datalab.search_trend": "rolling_window_signal",
    "naver.searchad.keyword_volume": "scheduled_closed_period",
    "kto.events.snapshot.20230830": "unavailable",
    "public.raw_sns.regional_mentions": "unavailable",
    "public.booking_inventory.lead_time": "unavailable"
  };
  const policyIndex = indexCollectionPolicies(registry, options);
  for (const [sourceId, invocationClass] of Object.entries(invocationBySource)) {
    const policy = policyIndex.get(sourceId);
    assert.ok(policy, `missing policy for ${sourceId}`);
    assert.equal(policy.invocationClass, invocationClass, `${sourceId} invocation class`);
    assert.equal(policy.actualCallsEnabled, false, `${sourceId} calls must remain disabled`);
    assert.equal(policy.externalCallOnRead, false, `${sourceId} must never call on UI read`);
    if (["scheduled_current_snapshot", "scheduled_closed_period", "rolling_window_signal", "release_driven"].includes(policy.invocationClass)) {
      assert.ok(policy.idempotencyKeyRule.fields.includes("configVersion"));
    }
    if (["scheduled_closed_period", "release_driven"].includes(policy.invocationClass)
      && policy.lateArrivalPolicy.enabled) {
      assert.ok(policy.idempotencyKeyRule.fields.includes("lateArrivalVersion"));
    }
    assert.equal(policy.providerCadenceStatus, "unverified");
    assert.equal(policy.providerCadence, null, `${sourceId} provider cadence must not be invented`);
    assert.equal(policy.proposedCadence.status.includes("proposal")
      || policy.proposedCadence.status.includes("only")
      || policy.proposedCadence.status === "not_applicable", true);
    assert.equal(policy.retentionPolicy.automaticDeletion, false);
    assert.equal(policy.retentionPolicy.maximumSnapshots, null);
    assert.equal(policy.failurePolicy.overwriteReadyOnFailure, false);
    assert.equal(policy.manualRefreshPolicy.bypassMinimumRefreshInterval, false);
    assert.equal(policy.freshnessPolicy.staleAfterHours, policy.staleAfter.hours);
    assert.equal(isAutomaticCollectionAllowed(policy), false, `${sourceId} must not auto-run`);
  }

  const proposedCadenceBySource = {
    "kto.tour_info.resources": "week",
    "kto.tour_info.events": "day",
    "kto.tour_info.lodging": "week",
    "kto.gocamping.inventory": "week",
    "kto.bigdata.visitors": "month",
    "kto.bigdata.resource_demand": "month",
    "kma.asos.daily_weather": "day",
    "kosis.population.sigungu": "release",
    "molit.traffic_volume.statistics": "month",
    "naver.datalab.search_trend": "day",
    "naver.searchad.keyword_volume": "month"
  };
  for (const [sourceId, unit] of Object.entries(proposedCadenceBySource)) {
    assert.equal(policyIndex.get(sourceId).proposedCadence.unit, unit, `${sourceId} proposed cadence`);
  }
  assert.equal(getCollectionPolicy(registry, "missing.source", options), null);
  assert.equal(getCollectionPolicy(registry, " kto.gocamping.inventory ", options).sharedCollectionScope,
    "provider:kto.gocamping:national");
  assert.deepEqual(policyIndex.get("kto.bigdata.visitors").overlapWindow, {
    days: 0,
    months: 2,
    status: "proposal_only"
  });
  assert.equal(policyIndex.get("kma.asos.daily_weather").overlapWindow.days, 7);
  assert.equal(policyIndex.get("naver.datalab.search_trend").measurementWindowRule.days, null,
    "an unapproved rolling window length must remain null");
  assert.ok(policyIndex.get("naver.datalab.search_trend").remainingBlockers
    .includes("rolling_window_keyword_group_anchor_and_timeunit_approval"));

  const catalogById = new Map(catalog.sources.map((source) => [source.sourceId, source]));
  for (const policy of registry.policies) {
    const catalogSource = catalogById.get(policy.sourceId);
    if (catalogSource.selectionStatus === "candidate") {
      assert.ok(["blocked", "reference_only"].includes(policy.activationStatus));
      assert.equal(isAutomaticCollectionAllowed(policy), false);
    }
    if (["rejected", "unavailable"].includes(catalogSource.selectionStatus)) {
      assert.equal(policy.invocationClass, "unavailable");
      assert.equal(policy.activationStatus, "unavailable");
      assert.equal(policy.triggerType, "none");
      assert.equal(policy.manualRefreshPolicy.allowed, false);
      assert.equal(policy.adapterCreationAllowed, false);
      assert.equal(policy.taskCreationAllowed, false);
      assert.equal(policy.idempotencyKeyRule.fields.length, 0);
    }
  }

  assert.equal(connectionRegistry.sources.length, 12);
  for (const connection of connectionRegistry.sources) {
    const policy = policyIndex.get(connection.sourceId);
    assert.equal(connection.collectionPolicyId, policy.policyId);
    assert.equal(connection.invocationClass, policy.invocationClass);
    assert.equal(connection.externalCallOnRead, false);
    assert.equal(connection.activationStatus, policy.activationStatus);
    assert.equal(connection.actualCallsEnabled, false);
  }

  assert.deepEqual(
    new Set(registry.policies
      .filter((policy) => policy.invocationClass === "event_driven_reference")
      .map((policy) => policy.sourceId)),
    new Set(["mois.legal_dong.reference", "molit.standard_node_link.snapshot"])
  );
  assert.equal(registry.referenceDependencies.length, 5);
  for (const reference of registry.referenceDependencies) {
    assert.equal(reference.activationStatus, "reference_only");
    assert.equal(reference.externalCallOnRead, false);
    assert.equal(reference.automaticTaskCreation, false);
    assert.equal(reference.versionRequired, true);
    assert.equal(reference.exactMappingOnly, true);
  }
  assert.ok(registry.referenceDependencies.some((reference) => reference.referenceId === "reference.kma.station_crosswalk"));
  assert.ok(registry.referenceDependencies.some((reference) => reference.referenceId === "reference.kto.tourapi.region_codes"));
  assert.ok(registry.referenceDependencies.some((reference) => reference.referenceId === "reference.kto.datalab.region_codes"));
  assert.ok(registry.referenceDependencies.some((reference) => reference.referenceId === "reference.molit.traffic_station_road_crosswalk"));
  assert.ok(registry.referenceDependencies.some((reference) => reference.referenceId === "reference.naver.keyword_configuration"));

  assert.deepEqual(new Set(registry.excludedSources.map((source) => source.sourceId)), new Set([
    "ota.booking_inventory.unapproved",
    "regional.average_revenue.validation_target"
  ]));
  for (const excluded of registry.excludedSources) {
    assert.equal(excluded.invocationClass, "unavailable");
    assert.equal(excluded.activationStatus, "unavailable");
    assert.equal(excluded.actualCallsEnabled, false);
    assert.equal(excluded.externalCallOnRead, false);
    assert.equal(excluded.noAdapter, true);
    assert.equal(excluded.noTask, true);
    assert.equal(policySourceIds.has(excluded.sourceId), false);
  }

  function assertNoCredentialMaterial(value, pointer = "registry") {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.doesNotMatch(key, /credentialValue|secretValue|apiKeyValue|authorizationHeader|serviceKeyValue/i,
        `${pointer}.${key} must not contain a credential value`);
      assertNoCredentialMaterial(nested, `${pointer}.${key}`);
    }
  }
  assertNoCredentialMaterial(registry);
  assert.doesNotMatch(moduleSource, /process\.env/);
  assert.doesNotMatch(moduleSource, /\bfetch\s*\(/);
  assert.doesNotMatch(moduleSource, /require\(["']node:(?:http|https|net|tls)["']\)/);

  const enabledMutation = structuredClone(registry);
  enabledMutation.policies[0].actualCallsEnabled = true;
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(enabledMutation, options),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /actualCallsEnabled must be false/.test(detail))
  );

  const readMutation = structuredClone(registry);
  readMutation.policies[0].externalCallOnRead = true;
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(readMutation, options),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /externalCallOnRead must be false/.test(detail))
  );

  const providerCadenceMutation = structuredClone(registry);
  providerCadenceMutation.policies[0].providerCadence = { unit: "day", interval: 1 };
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(providerCadenceMutation, options),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /providerCadence must be null while unverified/.test(detail))
  );

  const duplicateMutation = structuredClone(registry);
  duplicateMutation.policies[1].sourceId = duplicateMutation.policies[0].sourceId;
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(duplicateMutation, options),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /sourceId is duplicated/.test(detail))
  );

  const missingCatalogPolicy = structuredClone(registry);
  missingCatalogPolicy.policies.pop();
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(missingCatalogPolicy, options),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /catalog source is not classified/.test(detail))
  );

  const connectionMismatch = structuredClone(connectionRegistry.sources);
  connectionMismatch[0].invocationClass = "release_driven";
  assert.throws(
    () => validateLocationCollectionPolicyRegistry(registry, {
      catalogSources: catalog.sources,
      connectionSources: connectionMismatch
    }),
    (error) => error instanceof LocationCollectionPolicyError
      && error.details.some((detail) => /connection invocationClass mismatch/.test(detail))
  );

  assert.equal(guard.blockedAttempts(), 0);
  console.log("Location collection policy contract passed (16 catalog sources, all calls/read triggers disabled)");
} finally {
  guard.restore();
}
