const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  DECISIONS,
  FROZEN_CLUSTER_HANDLER_CONFLICTS,
  FROZEN_CURATED_FEATURE_IDS,
  FROZEN_INVENTORY_EXPECTED,
  OUTPUT_PATH,
  REQUIRED_LEDGER_FIELDS,
  SOURCE_REFS,
  buildLedger,
  calculateBlockers,
  serialize
} = require("./stage224_inventory.cjs");
const {
  createIntegrationDataAccessGuard,
  isCompleteStaticAssetAllowlistEntry,
  sha256File
} = require("./integration_data_access_guard.cjs");

const ROOT = path.resolve(__dirname, "..");

function assertEqualFields(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${label}.${key}`);
  }
}

function assertNoFlagCycles(flags) {
  const byName = new Map(flags.map((flag) => [flag.name, flag]));
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    assert.ok(byName.has(name), `unknown feature flag dependency: ${name}`);
    if (visited.has(name)) return;
    assert.equal(visiting.has(name), false, `feature flag dependency cycle at ${name}`);
    visiting.add(name);
    for (const dependency of byName.get(name).dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of byName.keys()) visit(name);
}

function main() {
  const result = buildLedger();
  assert.equal(fs.readFileSync(OUTPUT_PATH, "utf8"), serialize(result), "generated ledger must be current");
  assert.equal(result.blockers.length, 0);
  const blockerProbe = structuredClone(result);
  const renamedDeferred = blockerProbe.ledger.find((item) => item.id === "CL-X01");
  const swappedPort = blockerProbe.ledger.find((item) => item.id === "CL-A01");
  renamedDeferred.id = "CL-X99";
  renamedDeferred.decision = "port";
  renamedDeferred.targetStage = swappedPort.targetStage;
  renamedDeferred.featureFlag = swappedPort.featureFlag;
  swappedPort.decision = "defer";
  swappedPort.targetStage = "post-234";
  swappedPort.featureFlag = null;
  const firstClusterPort = blockerProbe.ledger.find((item) => item.source === "glamping-cluster-app" && item.decision === "port" && item.id !== "CL-X99");
  firstClusterPort.featureFlag = "NO_SUCH_FLAG";
  blockerProbe.ledger[0].sourceCommit = "0000000000000000000000000000000000000000";
  const zeroLineItem = blockerProbe.ledger.find((item) => /:\d+$/.test(item.sourcePath));
  zeroLineItem.sourcePath = zeroLineItem.sourcePath.replace(/:\d+$/, ":0");
  const removedConflict = blockerProbe.ledger.find((item) =>
    item.source === "glamping-cluster-app"
      && item.routeOrScreen.method === "POST"
      && item.routeOrScreen.value === "/api/crawl"
  );
  const injectedConflict = blockerProbe.ledger.find((item) =>
    item.source === "glamping-cluster-app"
      && ["handler-contract", "dynamic-handler"].includes(item.inventoryKind)
      && !item.v2Conflict
  );
  removedConflict.v2Conflict = false;
  removedConflict.decision = "port";
  removedConflict.featureFlag = "V2_INTEGRATION_PLATFORM_CORE_ENABLED";
  injectedConflict.v2Conflict = true;
  injectedConflict.decision = "keep";
  injectedConflict.featureFlag = null;
  blockerProbe.inventoryReconciliation.v2.stage221LiteralRawCount = 44;
  blockerProbe.inventoryReconciliation.frozenExpected.v2.stage221LiteralRawCount = 44;
  blockerProbe.stageRaci[0].accountable = "TBD";
  blockerProbe.acceptanceMetrics[0].numerator = "미정";
  const probeCodes = new Set(calculateBlockers(blockerProbe).map((blocker) => blocker.code));
  for (const code of [
    "cluster-curated-feature-id-set-mismatch",
    "ledger-unknown-feature-flag",
    "source-ref-or-line-invalid",
    "handler-conflict-set-mismatch",
    "v2-inventory-count-mismatch",
    "v2-embedded-inventory-contract-mutated",
    "governance-role-unregistered-or-unresolved",
    "acceptance-metric-incomplete"
  ]) assert.ok(probeCodes.has(code), `calculated blockers must detect ${code}`);
  assert.equal(result.featureSummary.totalLedgerRecords, 962);
  assert.equal(result.featureSummary.curatedV2Features, 52);
  assert.equal(result.featureSummary.curatedClusterFeatures, 77);
  assert.equal(result.featureSummary.clusterUnclassifiedCount, 0);
  assert.ok(Object.values(result.sourceIntegrity).every((entry) => entry.headUnchanged && entry.worktreeStatusUnchanged));

  assert.deepEqual(result.inventoryReconciliation.frozenExpected, FROZEN_INVENTORY_EXPECTED);
  assertEqualFields(result.inventoryReconciliation.v2, FROZEN_INVENTORY_EXPECTED.v2, "v2 inventory");
  assertEqualFields(result.inventoryReconciliation.cluster, FROZEN_INVENTORY_EXPECTED.cluster, "cluster inventory");
  assert.equal(result.inventoryReconciliation.v2.v3SurveyMatchesFrozenArtifact, true);
  assert.equal(result.inventoryReconciliation.cluster.v3SurveyMatchesFrozenArtifact, true);
  assert.deepEqual(result.inventoryReconciliation.v2.v3SurveyOnlyRoutes, [
    "/admin", "/b2b", "/outputs", "/outputs/*", "/view"
  ]);
  assert.deepEqual(result.inventoryReconciliation.cluster.v3SurveyOnlyRoutes, [
    "/admin",
    "/api",
    "/api/admin/auth/invitations/${action}",
    "/api/admin/master-db/companies${query}",
    "/app",
    "/outputs",
    "/view"
  ]);

  const ids = new Set();
  for (const item of result.ledger) {
    assert.equal(ids.has(item.id), false, `duplicate ledger id ${item.id}`);
    ids.add(item.id);
    for (const field of REQUIRED_LEDGER_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, field), true, `${item.id} missing ${field}`);
    }
    assert.ok(item.id && item.domain && item.source && item.sourceCommit && item.sourcePath);
    assert.equal(typeof item.v2Conflict, "boolean", `${item.id} v2Conflict`);
    assert.ok(item.v2PriorityReason, `${item.id} v2PriorityReason`);
    assert.ok(Array.isArray(item.role) && item.role.length > 0, `${item.id} role`);
    assert.ok(DECISIONS.has(item.decision), `${item.id} decision`);
    assert.ok(item.decisionRationale, `${item.id} decisionRationale`);
    assert.ok(String(item.targetStage).length > 0, `${item.id} targetStage`);
    assert.ok(item.owner && item.approver && item.owner !== item.approver, `${item.id} governance`);
    assert.ok(Array.isArray(item.tests) && item.tests.length > 0, `${item.id} tests`);
    assert.ok(item.releaseGate, `${item.id} releaseGate`);
    assert.equal(item.freshDataInputs.policy, "empty-integrated-store-fresh-only");
    assert.equal(item.freshDataInputs.legacyRuntimeReadAllowed, false);
    assert.equal(item.freshDataInputs.migrationAllowed, false);
    assert.equal(item.freshDataInputs.backfillAllowed, false);
    assert.equal(item.freshDataInputs.dualWriteAllowed, false);
    if (/migration|backfill|dual-write|\/outputs(?:\/|$)/i.test(item.routeOrScreen.value)) {
      assert.equal(item.decision, "exclude", `${item.id} legacy data action must be excluded`);
    }
  }

  for (const sourceKey of ["v2", "cluster"]) {
    const source = SOURCE_REFS[sourceKey];
    const sourceItems = result.ledger.filter((item) => item.source === source.name);
    assert.ok(sourceItems.every((item) => !item.sourcePath.endsWith(":dynamic-route-audit")), `${source.name} unresolved sourcePath`);
    const sourcePaths = new Set(sourceItems.map((item) => item.sourcePath.replace(/:(?:\d+|dynamic-route-audit)$/, "")));
    for (const sourcePath of sourcePaths) {
      const check = childProcess.spawnSync(
        "git",
        ["-C", source.repository, "show", `${source.commit}:${sourcePath}`],
        { windowsHide: true, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
      );
      assert.equal(check.status, 0, `${source.name} sourcePath missing at fixed commit: ${sourcePath}`);
      const lineCount = String(check.stdout || "").split(/\r?\n/).length;
      for (const item of sourceItems.filter((entry) => entry.sourcePath.startsWith(`${sourcePath}:`))) {
        const suffix = item.sourcePath.slice(sourcePath.length + 1);
        if (/^\d+$/.test(suffix)) {
          assert.ok(Number(suffix) >= 1, `${item.id} source line must be one-based`);
          assert.ok(Number(suffix) <= lineCount, `${item.id} source line outside fixed file`);
        }
      }
    }
  }

  const clusterItems = result.ledger.filter((item) => item.source === "glamping-cluster-app");
  assert.equal(clusterItems.length, 775);
  assert.ok(clusterItems.every((item) => DECISIONS.has(item.decision) && item.targetStage));
  const clusterFeatures = clusterItems.filter((item) => item.inventoryKind === "curated-business-feature");
  assert.equal(clusterFeatures.length, 77);
  assert.deepEqual(clusterFeatures.map((item) => item.id).sort(), [...FROZEN_CURATED_FEATURE_IDS.cluster].sort());
  assert.deepEqual(result.ledger
    .filter((item) => item.source === "glamping-datalab-v2" && item.inventoryKind === "curated-business-feature")
    .map((item) => item.id)
    .sort(), [...FROZEN_CURATED_FEATURE_IDS.v2].sort());
  for (const item of clusterFeatures.filter((entry) => /^CL-X0[1-7]$/.test(entry.id))) {
    assert.equal(item.decision, "defer", `${item.id} must wait for an approved sample protocol`);
    assert.equal(item.targetStage, "post-234");
  }
  for (const item of clusterFeatures.filter((entry) => /^(?:CL-C10|CL-Z\d{2})$/.test(entry.id))) {
    assert.equal(item.decision, "exclude", `${item.id} recursive learning/quality chain must be excluded`);
    assert.equal(item.targetStage, "224");
  }
  for (const item of clusterFeatures.filter((entry) => entry.sourceReviewStatus === "제외")) {
    assert.equal(item.decision, "exclude", `${item.id} source review exclusion must remain excluded`);
  }
  for (const item of clusterItems.filter((entry) => /auto-approval|calibration|candidate-quality|rereview|reassessment|\bSLA\b/i.test(entry.routeOrScreen.value))) {
    assert.equal(item.decision, "exclude", `${item.id} recursive/automatic approval must be excluded`);
    assert.equal(item.targetStage, "224");
  }
  assert.deepEqual(clusterFeatures.reduce((counts, item) => {
    counts[item.decision] = (counts[item.decision] || 0) + 1;
    return counts;
  }, {}), { port: 60, defer: 7, exclude: 10 });
  const expectedFeatureDomains = {
    "CL-A04": "auth-security",
    "CL-A05": "auth-security",
    "CL-A09": "auth-security",
    "CL-C02": "external-connectors",
    "CL-C03": "external-connectors",
    "CL-C07": "external-connectors",
    "CL-C08": "external-connectors",
    "CL-C09": "external-connectors",
    "CL-D03": "company-observation",
    "CL-D08": "company-observation",
    "CL-O01": "release-operations",
    "CL-O08": "release-operations",
    "CL-U01": "ui-shell",
    "CL-U06": "ui-shell"
  };
  for (const [id, domain] of Object.entries(expectedFeatureDomains)) {
    assert.equal(clusterFeatures.find((item) => item.id === id).domain, domain, `${id} domain`);
  }
  assert.ok(clusterItems.filter((item) => item.decision === "port").every((item) => item.featureFlag), "every Cluster port must be feature-gated");

  const clusterHandlerConflicts = clusterItems.filter((item) =>
    ["handler-contract", "dynamic-handler"].includes(item.inventoryKind) && item.v2Conflict
  );
  assert.equal(clusterHandlerConflicts.length, 8);
  assert.deepEqual(clusterHandlerConflicts
    .map((item) => `${item.routeOrScreen.method} ${item.routeOrScreen.value}`)
    .sort(), [...FROZEN_CLUSTER_HANDLER_CONFLICTS].sort());
  assert.ok(clusterHandlerConflicts.every((item) => item.decision === "keep"));
  assert.ok(clusterItems
    .filter((item) => ["handler-contract", "dynamic-handler"].includes(item.inventoryKind) && !item.v2Conflict)
    .every((item) => item.decision !== "keep"));

  assert.deepEqual(result.dataPolicy, {
    integratedStoreInitialState: "empty",
    allowedPopulation: "fresh collection after provider approval only",
    migrationCount: 0,
    backfillCount: 0,
    dualWriteCount: 0,
    legacyRuntimeReadCount: 0,
    stage223PreviewRuntimeMigrationPath: false
  });

  const providers = result.collectionBudget.providers;
  assert.equal(providers.reduce((sum, provider) => sum + provider.expectedCalls, 0), 21252);
  assert.equal(providers.reduce((sum, provider) => sum + provider.hardMaxCalls, 0), 275402);
  assert.equal(providers.reduce((sum, provider) => sum + provider.expectedSeconds, 0), 49036);
  assert.equal(providers.reduce((sum, provider) => sum + provider.hardMaxSeconds, 0), 559130);
  assert.deepEqual(providers.map((provider) => provider.id), [
    "quick",
    "detail",
    "ota-direct",
    "ota-generic",
    "leadtime",
    "tourism",
    "search-volume-searchad",
    "search-volume-trend",
    "sns"
  ]);
  for (const provider of providers) {
    for (const field of ["targetCount", "expectedCalls", "hardMaxCalls", "expectedSeconds", "hardMaxSeconds", "rateLimitPerMinute", "dailyQuota", "unitCostKRW", "expectedCostKRW", "hardMaxCostKRW", "approvedCapKRW", "realRequestLimit"]) {
      assert.equal(Number.isFinite(provider[field]), true, `${provider.id}.${field} must be numeric`);
      assert.ok(provider[field] >= 0, `${provider.id}.${field} cannot be negative`);
    }
    assert.equal(provider.rateLimitPerMinute, 0);
    assert.equal(provider.dailyQuota, 0);
    assert.equal(provider.unitCostKRW, 0);
    assert.equal(provider.expectedCostKRW, 0);
    assert.equal(provider.hardMaxCostKRW, 0);
    assert.equal(provider.approvedCapKRW, 0);
    assert.equal(provider.realRequestLimit, 0);
    assert.equal(provider.retryPolicy.disabledRealRetryCount, 0);
    assert.deepEqual(provider.retryPolicy.immediate429DelaysMs, [1200, 2400]);
    assert.equal(provider.retryPolicy.requestTimeoutMs, 15000);
    assert.deepEqual(provider.retryPolicy.rescheduleDelaySeconds, {
      rateLimit: 3600,
      networkOrHttp5xx: 7200,
      providerQuota: 86400
    });
    assert.equal(provider.stopPolicy.conditions.readApiP95AboveMs, 1000);
    assert.equal(provider.stopPolicy.conditions.writeApiP95AboveMs, 1500);
    assert.equal(provider.stopPolicy.conditions.workerThroughputBelowTasksPerMinute, 22.5);
    assert.equal(provider.resumePolicy.automaticResumeCount, 0);
    assert.equal(provider.resumePolicy.createNewRunId, true);
    assert.equal(provider.resumePolicy.legacyCursorOrIdentityRestoreAllowed, false);
  }
  assert.deepEqual(Object.fromEntries(providers.map((provider) => [provider.id, provider.owner])), {
    quick: "DE",
    detail: "DE",
    "ota-direct": "PIE",
    "ota-generic": "PIE",
    leadtime: "DE",
    tourism: "DE",
    "search-volume-searchad": "SPE",
    "search-volume-trend": "SPE",
    sns: "SPE"
  });

  const requiredMetrics = new Set([
    "coverage",
    "success-rate",
    "missing-rate",
    "logical-duplicate-rate",
    "companyId-collision",
    "freshness-compliance",
    "read-api-p95",
    "write-api-p95",
    "worker-throughput",
    "provider-cost",
    "provider-quota",
    "quota-exceeded",
    "denylist-access",
    "static-allowlist-violation"
  ]);
  const metricIds = new Set(result.acceptanceMetrics.map((metric) => metric.id));
  for (const metricId of requiredMetrics) assert.ok(metricIds.has(metricId), `missing metric ${metricId}`);
  for (const metric of result.acceptanceMetrics) {
    for (const field of ["numerator", "denominator", "window", "minimumSample", "warning", "stop"]) {
      assert.ok(metric[field] !== undefined && metric[field] !== null && String(metric[field]).trim(), `${metric.id}.${field}`);
    }
    assert.ok(Array.isArray(metric.approver) && metric.approver.length > 0, `${metric.id}.approver`);
    assert.equal(Number.isFinite(metric.minimumSample), true, `${metric.id}.minimumSample`);
    assert.match(String(metric.warning), /\d/);
    assert.match(String(metric.stop), /\d/);
    assert.doesNotMatch(`${metric.warning} ${metric.stop}`, /TBD|TODO|unknown|pending|미정/i);
  }
  for (const metricId of ["logical-duplicate-rate", "companyId-collision", "quota-exceeded", "denylist-access", "static-allowlist-violation"]) {
    assert.equal(result.acceptanceMetrics.find((metric) => metric.id === metricId).allowedCount, 0);
  }

  assert.equal(result.staticAssets.allowlist.length, 1);
  assert.equal(result.staticAssets.quarantine.length, 2);
  const asset = result.staticAssets.allowlist[0];
  assert.equal(isCompleteStaticAssetAllowlistEntry(asset), true);
  const assetPath = path.join(ROOT, asset.path);
  assert.equal(sha256File(assetPath), asset.checksum);
  assert.equal(asset.canonicalGitBlobSha256, "E0CF2030DC893F40B6E97DFA7183D47C2197EA74551B041EABFD7BC318A74285");
  assert.deepEqual(asset.approver, ["DGO", "SO"]);
  assert.equal(result.staticAssets.quarantine.some((entry) => entry.runtimePath === asset.path), false);
  assert.ok(result.legacyDataDenylist.length >= 10);
  assert.equal(result.runtimeAccessGuard.expectedLegacyReadCount, 0);
  assert.equal(result.runtimeAccessGuard.expectedNonAllowlistedStaticReadCount, 0);

  const guard = createIntegrationDataAccessGuard({
    projectRoot: ROOT,
    freshStoreRoot: path.join(ROOT, ".stage224-fresh-store-contract"),
    staticAssetAllowlist: [asset],
    env: { NODE_ENV: "production" }
  });
  assert.equal(guard.evaluate({ kind: "static-asset", path: assetPath }).allowed, true);
  assert.equal(guard.evaluate({ kind: "static-asset", path: path.join(ROOT, "web", "data", "tourism_region_map.json") }).allowed, false);
  assert.equal(guard.evaluate({ kind: "fresh-store", path: path.join(ROOT, "outputs", "legacy.json") }).allowed, false);
  assert.equal(guard.evaluate({ kind: "fresh-store", path: path.join(ROOT, ".stage224-fresh-store-contract", "new.json") }).allowed, true);
  for (const entry of result.legacyDataDenylist) {
    assert.equal(guard.evaluate({
      kind: "fresh-store",
      path: path.join(ROOT, ".stage224-fresh-store-contract", "new.json"),
      sourceIdentifier: entry.identifier
    }).allowed, false, `${entry.identifier} must be denied at runtime`);
  }

  const flagNames = new Set(result.featureFlags.map((flag) => flag.name));
  assert.equal(result.featureFlags.length, 31);
  assert.equal(flagNames.size, result.featureFlags.length);
  const rolloutOrders = new Set();
  for (const flag of result.featureFlags) {
    assert.equal(flag.default, false, `${flag.name} must default false`);
    assert.ok(flag.owner && flag.approver && flag.owner !== flag.approver, `${flag.name} governance`);
    assert.ok(Array.isArray(flag.approvalRoles) && flag.approvalRoles.length > 0, `${flag.name} approvalRoles`);
    assert.ok(Array.isArray(flag.dependsOn));
    assert.ok(Array.isArray(flag.nonFlagRequirements), `${flag.name} nonFlagRequirements`);
    assert.ok(Array.isArray(flag.targetRoles) && flag.targetRoles.length > 0);
    assert.equal(Number.isFinite(flag.rolloutOrder), true);
    assert.equal(rolloutOrders.has(flag.rolloutOrder), false, `${flag.name} duplicate rolloutOrder`);
    rolloutOrders.add(flag.rolloutOrder);
    assert.ok(Array.isArray(flag.observedMetrics) && flag.observedMetrics.length > 0);
    assert.ok(flag.rollback);
  }
  assertNoFlagCycles(result.featureFlags);
  const knownRoles = new Set(Object.keys(result.roleGlossary));
  for (const item of result.ledger.filter((entry) => entry.featureFlag)) {
    assert.ok(flagNames.has(item.featureFlag), `${item.id} references unknown flag ${item.featureFlag}`);
  }
  for (const flag of result.featureFlags) {
    for (const role of [flag.owner, flag.approver, ...flag.approvalRoles]) {
      assert.ok(knownRoles.has(role), `${flag.name} unknown governance role ${role}`);
    }
  }
  for (const previewName of ["V2_INTEGRATION_COMPANY_ENABLED", "V2_INTEGRATION_OBSERVATION_ENABLED"]) {
    const flag = result.featureFlags.find((entry) => entry.name === previewName);
    assert.equal(flag.scope, "contract-preview-test-only");
    assert.deepEqual(flag.allowedEnvironments, ["test"]);
    assert.deepEqual(flag.nonFlagRequirements, ["NODE_ENV=test", "contract-preview-purpose", "approved-fixture-root"]);
  }
  for (const collectionFlag of result.featureFlags.filter((flag) => flag.scope === "production-provider-zero-limit-gate")) {
    assert.ok(collectionFlag.approvalRoles.includes("PO"), `${collectionFlag.name} PO approval`);
    assert.ok(collectionFlag.nonFlagRequirements.length > 0, `${collectionFlag.name} non-flag gate`);
    if (collectionFlag.name !== "freshCollection.enabled") {
      for (const role of ["PO", "ProviderOps", "SO", "Finance"]) {
        assert.ok(collectionFlag.approvalRoles.includes(role), `${collectionFlag.name} ${role} approval`);
      }
    }
  }

  assert.deepEqual(result.stageRaci.map((entry) => entry.stage), [224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234]);
  assert.ok(result.stageRaci.every((entry) => entry.responsible.length > 0 && entry.accountable && entry.consulted.length > 0 && entry.informed.length > 0));
  for (const entry of result.stageRaci) {
    for (const role of [...entry.responsible, entry.accountable, ...entry.consulted, ...entry.informed]) {
      assert.ok(knownRoles.has(role), `Stage ${entry.stage} unknown RACI role ${role}`);
    }
  }
  assert.equal(result.providerApprovalGates.length, 8);
  assert.ok(result.providerApprovalGates.every((gate) =>
    gate.currentRealRequestLimit === 0
      && gate.currentApprovedCapKRW === 0
      && ["PO", "ProviderOps", "SO", "Finance"].every((role) => gate.nextApprovers.includes(role))
      && ["DGO", "QA", "Legal"].every((role) => gate.consulted.includes(role))
  ));

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.name, "glamping-datalab-v2");
  assert.match(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), /^# glamping-datalab-v2/m);
  for (const manifest of ["render.yaml", "render.persistent.yaml"]) {
    const source = fs.readFileSync(path.join(ROOT, manifest), "utf8");
    assert.match(source, /LEGACY CLUSTER REFERENCE ONLY - DO NOT DEPLOY/);
    assert.doesNotMatch(source, /^services\s*:/m, `${manifest} must not expose deployable services`);
    assert.match(source, /^x-legacy-cluster-services\s*:/m, `${manifest} must remain inert reference data`);
  }
  const serverSource = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
  for (const marker of [
    "createIntegrationDataAccessGuard",
    "IS_PRODUCTION_RUNTIME",
    "V2_INTEGRATION_PREVIEW_PURPOSE",
    "V2_INTEGRATION_PREVIEW_FIXTURE_ROOT",
    "integrationPreviewFixtureAccessAllowed",
    "integrationPreviewRunCandidates",
    "integrationPreviewFixtureAccessAllowed([manifestPath]",
    "integrationPreviewFixtureAccessAllowed([filePath]",
    "availability: summarizeAvailabilityRows(rows)"
  ]) assert.ok(serverSource.includes(marker), `preview guard marker ${marker}`);
  const observationPreviewSource = serverSource.slice(
    serverSource.indexOf("async function integrationObservationPreview"),
    serverSource.indexOf("async function backfillCompanyMasterFromRuns")
  );
  assert.ok(observationPreviewSource.includes("integrationPreviewRunCandidates"));
  assert.equal(observationPreviewSource.includes("listRuns()"), false, "preview must not invoke the operational run loader");
  const ledgerMarkdown = fs.readFileSync(path.join(ROOT, "docs", "stage224_feature_ledger.md"), "utf8");
  assert.match(ledgerMarkdown, /Cluster는 port 60, defer 7,[\s\S]{0,30}exclude 10/);
  assert.match(ledgerMarkdown, /31개 flag/);
  const budgetMarkdown = fs.readFileSync(path.join(ROOT, "docs", "stage224_fresh_collection_budget.md"), "utf8");
  for (const marker of ["21,252", "275,402", "817.3분", "9,318.8분", "49,036초", "559,130초"]) {
    assert.ok(budgetMarkdown.includes(marker), `budget markdown marker ${marker}`);
  }
  assert.equal(result.naming.packageName, packageJson.name);
  assert.deepEqual(result.naming.canonicalManifests, ["render.v2.yaml", "render.v2.persistent.yaml"]);

  console.log("Stage 224 inventory, ledger, budget, governance and access checks passed");
}

main();
