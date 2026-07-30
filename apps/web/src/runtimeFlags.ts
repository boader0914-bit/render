interface RuntimeMetaSource {
  querySelector(selector: string): { content?: string } | null;
}

export const PLATFORM_CORE_META_NAME = "lodging-v2-platform-core-enabled";
export const LOCATION_CARD_META_NAME = "lodging-v2-location-card-enabled";
export const BUSINESS_REPORT_META_NAME = "lodging-v2-business-report-enabled";
export const STRATEGY_META_NAME = "lodging-v2-strategy-enabled";
export const EXECUTION_META_NAME = "lodging-v2-execution-enabled";
export const RETROSPECTIVE_META_NAME = "lodging-v2-retrospective-enabled";
export const MAP_RANKING_META_NAME = "lodging-v2-map-ranking-enabled";
export const CONNECTOR_RUNTIME_META_NAME = "lodging-v2-connector-runtime-enabled";

function explicitRuntimeFlag(source: RuntimeMetaSource, name: string): boolean {
  const value = source.querySelector(`meta[name="${name}"]`)?.content;
  return String(value || "").trim().toLowerCase() === "true";
}

/** Runtime server truth; an absent or unexpanded marker is deliberately false. */
export function platformCoreEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, PLATFORM_CORE_META_NAME);
}

/** Stage 229 location cards are independently gated and never inferred from another feature. */
export function locationCardEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, LOCATION_CARD_META_NAME);
}

/** Stage 229 reports are independently gated and never inferred from another feature. */
export function businessReportEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, BUSINESS_REPORT_META_NAME);
}

/** Stage 230 strategy generation requires an independently approved published-report rollout. */
export function strategyEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, STRATEGY_META_NAME);
}

/** Stage 230 action plans remain independently rollbackable after strategy rollout. */
export function executionEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, EXECUTION_META_NAME);
}

/** Stage 230 retrospectives remain independently rollbackable after execution rollout. */
export function retrospectiveEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, RETROSPECTIVE_META_NAME);
}

/** Stage 231 map/ranking reads require their own fresh-observation rollout gate. */
export function mapRankingEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, MAP_RANKING_META_NAME);
}

/** Stage 231 connector operations are visible only when the server runtime is explicitly enabled. */
export function connectorRuntimeEnabled(source: RuntimeMetaSource = document): boolean {
  return explicitRuntimeFlag(source, CONNECTOR_RUNTIME_META_NAME);
}
