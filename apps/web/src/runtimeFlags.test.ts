import { describe, expect, it } from "vitest";
import { PLATFORM_CORE_META_NAME, platformCoreEnabled } from "./runtimeFlags";

const source = (content?: string) => ({
  querySelector: (selector: string) => selector === `meta[name="${PLATFORM_CORE_META_NAME}"]` && content !== undefined
    ? { content }
    : null
});

describe("runtime feature metadata", () => {
  it("enables Stage 227 requests only for an explicit true marker", () => {
    expect(platformCoreEnabled(source("true"))).toBe(true);
    expect(platformCoreEnabled(source("TRUE"))).toBe(true);
    expect(platformCoreEnabled(source("false"))).toBe(false);
    expect(platformCoreEnabled(source("__V2_PLATFORM_CORE_ENABLED__"))).toBe(false);
    expect(platformCoreEnabled(source())).toBe(false);
  });
});
