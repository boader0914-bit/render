import { describe, expect, it } from "vitest";
import {
  BUSINESS_REPORT_META_NAME,
  CONNECTOR_RUNTIME_META_NAME,
  EXECUTION_META_NAME,
  LOCATION_CARD_META_NAME,
  MAP_RANKING_META_NAME,
  PLATFORM_CORE_META_NAME,
  RETROSPECTIVE_META_NAME,
  STRATEGY_META_NAME,
  businessReportEnabled,
  connectorRuntimeEnabled,
  executionEnabled,
  locationCardEnabled,
  mapRankingEnabled,
  platformCoreEnabled,
  retrospectiveEnabled,
  strategyEnabled
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

  it("keeps all Stage 230 rollout markers explicit, false by default and independent", () => {
    expect(strategyEnabled(source({ [STRATEGY_META_NAME]: "true" }))).toBe(true);
    expect(executionEnabled(source({ [EXECUTION_META_NAME]: " TRUE " }))).toBe(true);
    expect(retrospectiveEnabled(source({ [RETROSPECTIVE_META_NAME]: "true" }))).toBe(true);
    expect(strategyEnabled(source({ [STRATEGY_META_NAME]: "1" }))).toBe(false);
    expect(executionEnabled(source({ [STRATEGY_META_NAME]: "true" }))).toBe(false);
    expect(retrospectiveEnabled(source({ [EXECUTION_META_NAME]: "true" }))).toBe(false);
    expect(strategyEnabled(source({}))).toBe(false);
    expect(executionEnabled(source({}))).toBe(false);
    expect(retrospectiveEnabled(source({}))).toBe(false);
  });

  it("keeps Stage 231 map/ranking independently false until the server marker is true", () => {
    expect(mapRankingEnabled(source({ [MAP_RANKING_META_NAME]: "true" }))).toBe(true);
    expect(mapRankingEnabled(source({ [MAP_RANKING_META_NAME]: " TRUE " }))).toBe(true);
    expect(mapRankingEnabled(source({ [MAP_RANKING_META_NAME]: "1" }))).toBe(false);
    expect(mapRankingEnabled(source({ [PLATFORM_CORE_META_NAME]: "true" }))).toBe(false);
    expect(mapRankingEnabled(source({}))).toBe(false);
  });

  it("keeps Stage 231 connector operations independently false until the server marker is true", () => {
    expect(connectorRuntimeEnabled(source({ [CONNECTOR_RUNTIME_META_NAME]: "true" }))).toBe(true);
    expect(connectorRuntimeEnabled(source({ [CONNECTOR_RUNTIME_META_NAME]: " TRUE " }))).toBe(true);
    expect(connectorRuntimeEnabled(source({ [CONNECTOR_RUNTIME_META_NAME]: "1" }))).toBe(false);
    expect(connectorRuntimeEnabled(source({ [MAP_RANKING_META_NAME]: "true" }))).toBe(false);
    expect(connectorRuntimeEnabled(source({}))).toBe(false);
  });
});
