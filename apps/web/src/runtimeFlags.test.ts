import { describe, expect, it } from "vitest";
import {
  BUSINESS_REPORT_META_NAME,
  LOCATION_CARD_META_NAME,
  PLATFORM_CORE_META_NAME,
  businessReportEnabled,
  locationCardEnabled,
  platformCoreEnabled
} from "./runtimeFlags";

const source = (values: Partial<Record<string, string>>) => ({
  querySelector: (selector: string) => {
    const name = selector.match(/meta\[name="([^"]+)"\]/)?.[1] || "";
    return values[name] !== undefined ? { content: values[name] } : null;
  }
});

describe("runtime feature metadata", () => {
  it("enables Stage 227 requests only for an explicit true marker", () => {
    expect(platformCoreEnabled(source({ [PLATFORM_CORE_META_NAME]: "true" }))).toBe(true);
    expect(platformCoreEnabled(source({ [PLATFORM_CORE_META_NAME]: "TRUE" }))).toBe(true);
    expect(platformCoreEnabled(source({ [PLATFORM_CORE_META_NAME]: "false" }))).toBe(false);
    expect(platformCoreEnabled(source({ [PLATFORM_CORE_META_NAME]: "__V2_PLATFORM_CORE_ENABLED__" }))).toBe(false);
    expect(platformCoreEnabled(source({}))).toBe(false);
  });

  it("enables Stage 229 location cards only for their explicit true marker", () => {
    expect(locationCardEnabled(source({ [LOCATION_CARD_META_NAME]: "true" }))).toBe(true);
    expect(locationCardEnabled(source({ [LOCATION_CARD_META_NAME]: " TRUE " }))).toBe(true);
    expect(locationCardEnabled(source({ [LOCATION_CARD_META_NAME]: "1" }))).toBe(false);
    expect(locationCardEnabled(source({ [LOCATION_CARD_META_NAME]: "__V2_LOCATION_CARD_ENABLED__" }))).toBe(false);
    expect(locationCardEnabled(source({ [BUSINESS_REPORT_META_NAME]: "true" }))).toBe(false);
  });

  it("enables Stage 229 reports only for their explicit true marker", () => {
    expect(businessReportEnabled(source({ [BUSINESS_REPORT_META_NAME]: "true" }))).toBe(true);
    expect(businessReportEnabled(source({ [BUSINESS_REPORT_META_NAME]: " TRUE " }))).toBe(true);
    expect(businessReportEnabled(source({ [BUSINESS_REPORT_META_NAME]: "1" }))).toBe(false);
    expect(businessReportEnabled(source({ [BUSINESS_REPORT_META_NAME]: "__V2_BUSINESS_REPORT_ENABLED__" }))).toBe(false);
    expect(businessReportEnabled(source({ [PLATFORM_CORE_META_NAME]: "true" }))).toBe(false);
  });

  it("keeps location and report truth independent for partial rollouts", () => {
    const locationOnly = source({ [LOCATION_CARD_META_NAME]: "true", [BUSINESS_REPORT_META_NAME]: "false" });
    expect(locationCardEnabled(locationOnly)).toBe(true);
    expect(businessReportEnabled(locationOnly)).toBe(false);

    const reportOnly = source({ [LOCATION_CARD_META_NAME]: "false", [BUSINESS_REPORT_META_NAME]: "true" });
    expect(locationCardEnabled(reportOnly)).toBe(false);
    expect(businessReportEnabled(reportOnly)).toBe(true);
  });
});
