"use strict";

const { STRATEGY_RULE_VERSION } = require("../contracts/strategy_execution.cjs");
const { createStrategyRepository } = require("../repositories/strategy_store.cjs");
const { createStrategyService } = require("../services/strategy_service.cjs");
const { createStrategyHttpHandler } = require("../http/strategy_http.cjs");
const { readIntegrationFeatureFlags } = require("../../integration_feature_flags.cjs");

function nonZero(value) {
  return Number(value || 0) !== 0;
}

function createStrategyRuntime(options = {}) {
  const env = options.env || process.env;
  const authRuntime = options.authRuntime;
  const freshRuntime = options.freshRuntime;
  const insightsRuntime = options.insightsRuntime;
  if (!authRuntime?.service || !authRuntime?.http) {
    throw new Error("Stage 230 strategy runtime requires the Stage 226 auth runtime");
  }
  if (!freshRuntime?.service) {
    throw new Error("Stage 230 strategy runtime requires the Stage 228 fresh platform runtime");
  }
  if (!insightsRuntime?.service || typeof insightsRuntime?.diagnostics !== "function") {
    throw new Error("Stage 230 strategy runtime requires the Stage 229 insights runtime");
  }

  const flags = options.featureFlags || readIntegrationFeatureFlags(env);
  const requested = options.capabilities || {};
  const businessReport = Boolean(insightsRuntime.capabilities?.businessReport);
  const strategyRequested = Boolean(Object.hasOwn(requested, "strategy") ? requested.strategy : flags.strategy);
  const executionRequested = Boolean(Object.hasOwn(requested, "execution") ? requested.execution : flags.execution);
  const retrospectiveRequested = Boolean(Object.hasOwn(requested, "retrospective") ? requested.retrospective : flags.retrospective);
  const capabilities = Object.freeze({
    strategy: strategyRequested && businessReport,
    execution: executionRequested && strategyRequested && businessReport,
    retrospective: retrospectiveRequested && executionRequested && strategyRequested && businessReport
  });

  async function resolveParentInsightsStoreId() {
    if (options.parentInsightsStoreId) return options.parentInsightsStoreId;
    const diagnostics = await insightsRuntime.diagnostics();
    return diagnostics?.storeId || diagnostics?.store?.storeId || "";
  }

  const repository = createStrategyRepository({
    env,
    projectRoot: options.projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths,
    parentInsightsStoreId: options.parentInsightsStoreId,
    resolveInsightsStoreId: resolveParentInsightsStoreId,
    clock: options.clock,
    idFactory: options.idFactory
  });
  const service = createStrategyService({
    repository,
    insightsService: insightsRuntime.service,
    authService: authRuntime.service,
    freshService: freshRuntime.service,
    capabilities,
    clock: options.clock
  });
  const http = createStrategyHttpHandler({
    service,
    authService: authRuntime.service,
    authHttp: authRuntime.http,
    send: options.send,
    parseBody: options.parseBody
  });

  async function diagnostics() {
    const [store, insights] = await Promise.all([
      repository.diagnostics(),
      insightsRuntime.diagnostics()
    ]);
    return {
      ...store,
      capabilities: { ...capabilities },
      parentInsightsStoreId: store.parentInsightsStoreId || insights?.storeId || "",
      externalProviderCalls: Number(store.externalProviderCalls || 0) + Number(insights.externalProviderCalls || 0),
      credentialReads: Number(store.credentialReads || 0) + Number(insights.credentialReads || 0),
      legacyRuntimeReads: Number(store.legacyRuntimeReads || 0) + Number(insights.legacyRuntimeReads || 0),
      legacyRuntimeCopies: Number(store.legacyRuntimeCopies || 0) + Number(insights.legacyRuntimeCopies || 0),
      productionMutations: Number(store.productionMutations || 0) + Number(insights.productionMutations || 0)
    };
  }

  async function initialize() {
    const store = await repository.initialize();
    const boundary = await diagnostics();
    if (
      !boundary.parentInsightsStoreId
      || nonZero(boundary.externalProviderCalls)
      || nonZero(boundary.credentialReads)
      || nonZero(boundary.legacyRuntimeReads)
      || nonZero(boundary.legacyRuntimeCopies)
      || nonZero(boundary.productionMutations)
    ) {
      const error = new Error("Stage 230 published-report/fresh-data boundary verification failed");
      error.code = "STRATEGY_RUNTIME_BOUNDARY_VIOLATION";
      throw error;
    }
    return { ok: true, store, metadata: service.metadata(), diagnostics: boundary };
  }

  return Object.freeze({
    repository,
    service,
    http,
    capabilities,
    initialize,
    diagnostics,
    contract: Object.freeze({
      stage: 230,
      ruleVersion: STRATEGY_RULE_VERSION,
      dataBoundary: "published-stage229-business-safe-only",
      externalProviderCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    })
  });
}

module.exports = {
  createStrategyRuntime
};
