"use strict";

const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_PROVIDER_ID,
  INSIGHTS_SIGNAL_KINDS,
  cleanId,
  cleanText,
  normalizeSignalObservation,
  requiredIso,
  requiredMonth,
  stableHash
} = require("../contracts/insights.cjs");

function stableIndex(seed, minimum = 25, maximum = 92) {
  const value = Number.parseInt(stableHash(seed, 12), 16);
  return minimum + (value % (maximum - minimum + 1));
}

function fixtureValues(fixture, companyId) {
  if (!fixture || typeof fixture !== "object") return {};
  const companies = fixture.companies && typeof fixture.companies === "object" ? fixture.companies : {};
  return companies[companyId] || fixture.default || {};
}

function configuredIndex(config, kind, fallback) {
  const aliases = {
    "tourism.visitors": ["tourismVisitors", "visitors"],
    "tourism.resource-demand": ["tourismResourceDemand", "resourceDemand"],
    "tourism.diversity": ["tourismDiversity", "diversity"],
    "search.volume": ["searchVolume"],
    "trend.index": ["trendIndex", "trend"],
    "sns.mentions": ["snsMentions", "sns"],
    "structure.industry": ["industryIndex", "industry"],
    "structure.catchment": ["catchmentIndex", "catchment"],
    "structure.accessibility": ["accessibilityIndex", "accessibility"]
  }[kind] || [];
  if (Object.hasOwn(config, kind)) return config[kind];
  for (const alias of aliases) {
    if (Object.hasOwn(config, alias)) return config[alias];
  }
  return fallback;
}

function createDeterministicInsightsFixtureProvider(options = {}) {
  const fixture = options.fixture || null;
  const stats = {
    providerId: INSIGHTS_PROVIDER_ID,
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
    fixtureVersion: INSIGHTS_FIXTURE_VERSION,
    fixtureCollections: 0,
    generatedSignals: 0,
    externalRequests: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0
  };

  async function collect(input = {}) {
    const companyId = cleanId(input.companyId, "companyId");
    const runId = cleanId(input.runId, "runId");
    const observedAt = requiredIso(input.observedAt || new Date().toISOString(), "observedAt");
    const periodMonth = requiredMonth(input.periodMonth || observedAt.slice(0, 7), "periodMonth");
    const region = cleanText(input.region, 160);
    const config = fixtureValues(fixture, companyId);
    const signals = INSIGHTS_SIGNAL_KINDS.map((kind) => normalizeSignalObservation({
      companyId,
      runId,
      observedAt,
      periodMonth,
      region,
      kind,
      index: configuredIndex(config, kind, stableIndex(`${companyId}|${region}|${periodMonth}|${kind}|${INSIGHTS_FIXTURE_VERSION}`)),
      source: INSIGHTS_PROVIDER_ID,
      sourceUrl: `https://signals.example.invalid/stage229/${encodeURIComponent(kind)}/${encodeURIComponent(companyId)}`,
      fixtureVersion: INSIGHTS_FIXTURE_VERSION,
      synthetic: true,
      provenance: {
        adapter: "deterministic-fixture",
        fixtureLabel: cleanText(fixture?.label || "generated-default", 120),
        externalNetworkCalls: 0
      }
    }));
    stats.fixtureCollections += 1;
    stats.generatedSignals += signals.length;
    return {
      providerId: INSIGHTS_PROVIDER_ID,
      fixtureVersion: INSIGHTS_FIXTURE_VERSION,
      synthetic: true,
      externalNetworkCalls: 0,
      signals
    };
  }

  return Object.freeze({
    id: INSIGHTS_PROVIDER_ID,
    kind: "deterministic-fixture",
    collect,
    diagnostics() {
      return structuredClone(stats);
    }
  });
}

module.exports = {
  createDeterministicInsightsFixtureProvider,
  stableIndex
};
