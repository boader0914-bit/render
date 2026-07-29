"use strict";

const {
  INSIGHTS_PROVIDER_ID
} = require("../contracts/insights.cjs");
const {
  createInsightsRepository
} = require("../repositories/insights_store.cjs");
const {
  createDeterministicInsightsFixtureProvider
} = require("../services/insights_fixture_provider.cjs");
const {
  createInsightsService
} = require("../services/insights_service.cjs");
const {
  createInsightsHttpHandler
} = require("../http/insights_http.cjs");
const {
  readIntegrationFeatureFlags
} = require("../../integration_feature_flags.cjs");

const ALLOWED_PROVIDER_MODE = "deterministic-fixture";

function nonZero(value) {
  return Number(value || 0) !== 0;
}

function assertDeterministicProvider(provider) {
  if (
    !provider
    || provider.id !== INSIGHTS_PROVIDER_ID
    || provider.kind !== ALLOWED_PROVIDER_MODE
    || typeof provider.collect !== "function"
    || typeof provider.diagnostics !== "function"
  ) {
    const error = new Error("Stage 229 permits only the deterministic signal fixture adapter");
    error.code = "INSIGHTS_REAL_PROVIDER_FORBIDDEN";
    throw error;
  }
  const diagnostics = provider.diagnostics();
  if (
    nonZero(diagnostics.externalRequests)
    || nonZero(diagnostics.credentialReads)
    || nonZero(diagnostics.legacyRuntimeReads)
    || nonZero(diagnostics.legacyRuntimeCopies)
    || nonZero(diagnostics.productionMutations)
  ) {
    const error = new Error("Stage 229 provider boundary diagnostics must remain zero");
    error.code = "INSIGHTS_PROVIDER_BOUNDARY_VIOLATION";
    throw error;
  }
  return provider;
}

function createInsightsRuntime(options = {}) {
  const env = options.env || process.env;
  const authRuntime = options.authRuntime;
  const freshRuntime = options.freshRuntime;
  if (!authRuntime?.service || !authRuntime?.http) {
    throw new Error("Stage 229 insights runtime requires the Stage 226 auth runtime");
  }
  if (!freshRuntime?.repository || !freshRuntime?.service) {
    throw new Error("Stage 229 insights runtime requires the Stage 228 fresh platform runtime");
  }

  const configuredProviderMode = String(
    env.V2_INTEGRATION_INSIGHTS_PROVIDER
    || env.V2_INTEGRATION_SIGNAL_PROVIDER
    || ALLOWED_PROVIDER_MODE
  ).trim().toLowerCase();
  if (configuredProviderMode !== ALLOWED_PROVIDER_MODE) {
    const error = new Error("Stage 229 real providers, credentials, scheduler and quota traffic are forbidden");
    error.code = "INSIGHTS_REAL_PROVIDER_FORBIDDEN";
    throw error;
  }

  const flags = options.featureFlags || readIntegrationFeatureFlags(env);
  const requestedCapabilities = options.capabilities || {};
  const reliability = Boolean(Object.hasOwn(requestedCapabilities, "reliability")
    ? requestedCapabilities.reliability
    : flags.reliability);
  const locationCardRequested = Boolean(Object.hasOwn(requestedCapabilities, "locationCard")
    ? requestedCapabilities.locationCard
    : flags.locationCard);
  const capabilities = Object.freeze({
    reliability,
    locationCard: locationCardRequested && reliability,
    businessReport: Boolean(Object.hasOwn(requestedCapabilities, "businessReport")
      ? requestedCapabilities.businessReport
      : flags.businessReport)
  });

  async function resolveParentFreshStoreId() {
    if (options.freshStoreId) return options.freshStoreId;
    if (typeof freshRuntime.diagnostics !== "function") return "";
    const diagnostics = await freshRuntime.diagnostics();
    return diagnostics?.storeId || diagnostics?.store?.storeId || "";
  }

  const repository = createInsightsRepository({
    env,
    projectRoot: options.projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths,
    freshStoreId: options.freshStoreId,
    resolveFreshStoreId: resolveParentFreshStoreId,
    clock: options.clock,
    idFactory: options.storeIdFactory || options.idFactory
  });
  const provider = assertDeterministicProvider(
    options.provider || createDeterministicInsightsFixtureProvider({ fixture: options.fixture })
  );
  const service = createInsightsService({
    repository,
    provider,
    freshRepository: freshRuntime.repository,
    freshService: freshRuntime.service,
    authService: authRuntime.service,
    capabilities,
    clock: options.clock
  });
  const http = createInsightsHttpHandler({
    service,
    authService: authRuntime.service,
    authHttp: authRuntime.http,
    send: options.send,
    parseBody: options.parseBody
  });

  async function diagnostics() {
    const [store, fresh] = await Promise.all([
      repository.diagnostics(),
      typeof freshRuntime.diagnostics === "function" ? freshRuntime.diagnostics() : Promise.resolve({})
    ]);
    const providerDiagnostics = provider.diagnostics();
    return {
      ...store,
      capabilities: { ...capabilities },
      provider: providerDiagnostics,
      parentFreshStoreId: store.parentFreshStoreId || fresh?.storeId || "",
      externalProviderCalls: Number(store.externalRequests || 0)
        + Number(providerDiagnostics.externalRequests || 0)
        + Number(fresh?.providerCalls || 0),
      credentialReads: Number(store.credentialReads || 0)
        + Number(providerDiagnostics.credentialReads || 0)
        + Number(fresh?.credentialReads || 0),
      legacyRuntimeReads: Number(store.legacyRuntimeReads || 0)
        + Number(providerDiagnostics.legacyRuntimeReads || 0)
        + Number(fresh?.legacyRuntimeReads || 0),
      legacyRuntimeCopies: Number(store.legacyRuntimeCopies || 0)
        + Number(providerDiagnostics.legacyRuntimeCopies || 0)
        + Number(fresh?.legacyRuntimeCopies || 0),
      productionMutations: Number(store.productionMutations || 0)
        + Number(providerDiagnostics.productionMutations || 0)
        + Number(fresh?.productionMutations || 0)
    };
  }

  async function initialize() {
    const store = await repository.initialize();
    const boundary = await diagnostics();
    if (
      !boundary.parentFreshStoreId
      || nonZero(boundary.externalProviderCalls)
      || nonZero(boundary.credentialReads)
      || nonZero(boundary.legacyRuntimeReads)
      || nonZero(boundary.legacyRuntimeCopies)
      || nonZero(boundary.productionMutations)
    ) {
      const error = new Error("Stage 229 fresh-data/provider boundary verification failed");
      error.code = "INSIGHTS_RUNTIME_BOUNDARY_VIOLATION";
      throw error;
    }
    return { ok: true, store, metadata: service.metadata(), diagnostics: boundary };
  }

  return Object.freeze({
    repository,
    provider,
    service,
    http,
    capabilities,
    initialize,
    diagnostics,
    contract: Object.freeze({
      stage: 229,
      providerId: INSIGHTS_PROVIDER_ID,
      providerMode: ALLOWED_PROVIDER_MODE,
      dataBoundary: "fresh-integration-stage229-only",
      externalProviderCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    })
  });
}

module.exports = {
  ALLOWED_PROVIDER_MODE,
  assertDeterministicProvider,
  createInsightsRuntime
};
