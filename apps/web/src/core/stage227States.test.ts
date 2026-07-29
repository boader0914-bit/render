import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../apiClient";
import {
  coreFailureState,
  forgetJobId,
  normalizeCoreWorkspace,
  recoveredJobId,
  rememberJobId
} from "./coreClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stage 227 role-safe UI state contracts", () => {
  it("maps permission, unavailable and generic failures without exposing old data", () => {
    expect(coreFailureState(new ApiError(403, "forbidden"))).toBe("permission");
    expect(coreFailureState(new ApiError(404, "flag off"))).toBe("unavailable");
    expect(coreFailureState(new ApiError(503, "not ready"))).toBe("unavailable");
    expect(coreFailureState(new ApiError(500, "failed"))).toBe("error");
    expect(coreFailureState(new Error("network"))).toBe("error");
  });

  it("preserves explicit empty and partial contracts and never turns null into zero", () => {
    const empty = normalizeCoreWorkspace({
      metadata: { source: "empty" },
      state: { kind: "empty" },
      metrics: { companyCount: 0 },
      companies: [], history: [], interests: []
    }, "business-onboarding");
    expect(empty.state).toBe("empty");
    expect(empty.companies).toEqual([]);
    expect(empty.history).toEqual([]);

    const partial = normalizeCoreWorkspace({
      metadata: { source: "synthetic-fresh-collection" },
      state: { kind: "partial", partialCount: 1 },
      companies: [{
        companyId: "syn_partial_001",
        companyName: "Synthetic partial",
        businessValues: { weeklyRevenue: null, averagePrice: 142000 }
      }]
    }, "admin-companies");
    expect(partial.state).toBe("partial");
    expect(partial.companies[0].fields).toContainEqual({ label: "평균 가격", value: "142000" });
    expect(partial.companies[0].fields?.some((field) => field.value === "0")).toBe(false);
  });

  it("stores only a recoverable in-flight clientRequestId in tab-scoped storage", () => {
    const rows = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => rows.get(key) || null,
      setItem: (key: string, value: string) => { rows.set(key, value); },
      removeItem: (key: string) => { rows.delete(key); }
    });
    rememberJobId("business-search", "stage227-browser-refresh-01");
    expect(recoveredJobId("business-search")).toBe("stage227-browser-refresh-01");
    expect([...rows.keys()]).toEqual(["lodging-v2-stage227-job:business-search"]);
    forgetJobId("business-search");
    expect(recoveredJobId("business-search")).toBe("");
  });
});
