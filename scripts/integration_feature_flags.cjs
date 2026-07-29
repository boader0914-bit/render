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

function readIntegrationFeatureFlags(env = process.env) {
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
  return Object.freeze(Object.fromEntries(
    Object.entries(INTEGRATION_FEATURE_DEFINITIONS).map(([name]) => [
      name,
      resolve(name)
    ])
  ));
}

module.exports = {
  INTEGRATION_FEATURE_DEFINITIONS,
  flagEnabled,
  readIntegrationFeatureFlags
};
