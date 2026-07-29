interface RuntimeMetaSource {
  querySelector(selector: string): { content?: string } | null;
}

export const PLATFORM_CORE_META_NAME = "lodging-v2-platform-core-enabled";

/** Runtime server truth; an absent or unexpanded marker is deliberately false. */
export function platformCoreEnabled(source: RuntimeMetaSource = document): boolean {
  const value = source.querySelector(`meta[name="${PLATFORM_CORE_META_NAME}"]`)?.content;
  return String(value || "").trim().toLowerCase() === "true";
}
