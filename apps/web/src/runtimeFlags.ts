interface RuntimeMetaSource {
  querySelector(selector: string): { content?: string } | null;
}

export const PLATFORM_CORE_META_NAME = "lodging-v2-platform-core-enabled";
export const LOCATION_CARD_META_NAME = "lodging-v2-location-card-enabled";
export const BUSINESS_REPORT_META_NAME = "lodging-v2-business-report-enabled";

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
