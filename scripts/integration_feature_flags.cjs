const TEST_ONLY_ENVIRONMENTS = Object.freeze(["test"]);

const INTEGRATION_FEATURE_DEFINITIONS = Object.freeze({
  company: Object.freeze({
    envKey: "V2_INTEGRATION_COMPANY_ENABLED",
    scope: "test-only",
    allowedEnvironments: TEST_ONLY_ENVIRONMENTS
  }),
  observation: Object.freeze({
    envKey: "V2_INTEGRATION_OBSERVATION_ENABLED",
    scope: "test-only",
    allowedEnvironments: TEST_ONLY_ENVIRONMENTS
  }),
  auth: Object.freeze({ envKey: "V2_INTEGRATION_AUTH_ENABLED", scope: "runtime" }),
  platformCore: Object.freeze({
    envKey: "V2_INTEGRATION_PLATFORM_CORE_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["auth"])
  }),
  freshCompany: Object.freeze({
    envKey: "V2_INTEGRATION_FRESH_COMPANY_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["auth", "platformCore"])
  }),
  freshObservation: Object.freeze({
    envKey: "V2_INTEGRATION_FRESH_OBSERVATION_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["freshCompany"])
  }),
  reliability: Object.freeze({
    envKey: "V2_INTEGRATION_RELIABILITY_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["freshObservation"])
  }),
  locationCard: Object.freeze({
    envKey: "V2_INTEGRATION_LOCATION_CARD_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["reliability"])
  }),
  businessReport: Object.freeze({
    envKey: "V2_INTEGRATION_BUSINESS_REPORT_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["freshObservation"])
  }),
  strategy: Object.freeze({
    envKey: "V2_INTEGRATION_STRATEGY_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["businessReport"])
  }),
  execution: Object.freeze({
    envKey: "V2_INTEGRATION_EXECUTION_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["strategy"])
  }),
  retrospective: Object.freeze({
    envKey: "V2_INTEGRATION_RETROSPECTIVE_ENABLED",
    scope: "runtime",
    dependsOn: Object.freeze(["execution"])
  }),
  mapRanking: Object.freeze({
    envKey: "V2_INTEGRATION_MAP_RANKING_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["freshObservation"])
  }),
  connectorRuntime: Object.freeze({
    envKey: "V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["auth", "freshObservation"])
  }),
  tourismReal: Object.freeze({
    envKey: "V2_CONNECTOR_TOURISM_REAL_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  }),
  naverSearchAdReal: Object.freeze({
    envKey: "V2_CONNECTOR_NAVER_SEARCHAD_REAL_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  }),
  naverTrendReal: Object.freeze({
    envKey: "V2_CONNECTOR_NAVER_TREND_REAL_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  }),
  snsReal: Object.freeze({
    envKey: "V2_CONNECTOR_SNS_REAL_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  }),
  otaReal: Object.freeze({
    envKey: "V2_CONNECTOR_OTA_REAL_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  }),
  scheduler: Object.freeze({
    envKey: "V2_INTEGRATION_SCHEDULER_ENABLED",
    scope: "runtime",
    default: false,
    dependsOn: Object.freeze(["connectorRuntime"])
  })
});

function flagEnabled(value) {
  return /^(1|true|on|yes)$/i.test(String(value || "").trim());
}

function environmentAllows(definition, env) {
  if (!Array.isArray(definition.allowedEnvironments)) return true;
  const processEnvironment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const configuredEnvironment = String(env.NODE_ENV || "").trim().toLowerCase();
  const renderRuntime = Boolean(
    process.env.RENDER
    || process.env.RENDER_EXTERNAL_URL
    || env.RENDER
    || env.RENDER_EXTERNAL_URL
  );
  const environment = processEnvironment === "production"
    || configuredEnvironment === "production"
    || renderRuntime
    ? "production"
    : configuredEnvironment;
  return definition.allowedEnvironments.includes(environment);
}

function evaluateIntegrationFeatureFlags(env = process.env) {
  const configured = Object.fromEntries(
    Object.entries(INTEGRATION_FEATURE_DEFINITIONS).map(([name, definition]) => [
      name,
      environmentAllows(definition, env) && flagEnabled(env[definition.envKey])
    ])
  );
  const effective = {};
  const resolving = new Set();
  function resolve(name) {
    if (Object.hasOwn(effective, name)) return effective[name];
    if (!configured[name] || resolving.has(name)) return false;
    resolving.add(name);
    const definition = INTEGRATION_FEATURE_DEFINITIONS[name];
    const enabled = (definition.dependsOn || []).every((dependency) => resolve(dependency));
    resolving.delete(name);
    effective[name] = enabled;
    return enabled;
  }
  const resolved = Object.freeze(Object.fromEntries(
    Object.entries(INTEGRATION_FEATURE_DEFINITIONS).map(([name]) => [
      name,
      resolve(name)
    ])
  ));
  return Object.freeze({
    configured: Object.freeze(configured),
    effective: resolved
  });
}

function readIntegrationFeatureFlags(env = process.env) {
  return evaluateIntegrationFeatureFlags(env).effective;
}

function integrationFeatureFlagDiagnostics(env = process.env) {
  const evaluation = evaluateIntegrationFeatureFlags(env);
  const flags = Object.freeze(Object.fromEntries(
    Object.entries(INTEGRATION_FEATURE_DEFINITIONS).map(([name, definition]) => {
      const dependsOn = Object.freeze([...(definition.dependsOn || [])]);
      const blockedBy = Object.freeze(
        evaluation.configured[name]
          ? dependsOn.filter((dependency) => !evaluation.effective[dependency])
          : []
      );
      return [name, Object.freeze({
        envKey: definition.envKey,
        scope: definition.scope,
        default: false,
        configured: evaluation.configured[name],
        effective: evaluation.effective[name],
        dependsOn,
        blockedBy
      })];
    })
  ));
  return Object.freeze({
    schemaVersion: "integration-feature-flags-v1",
    flags
  });
}

function serializeIntegrationFeatureFlagDiagnostics(env = process.env) {
  return JSON.stringify(integrationFeatureFlagDiagnostics(env));
}

module.exports = {
  INTEGRATION_FEATURE_DEFINITIONS,
  flagEnabled,
  integrationFeatureFlagDiagnostics,
  serializeIntegrationFeatureFlagDiagnostics,
  readIntegrationFeatureFlags
};
