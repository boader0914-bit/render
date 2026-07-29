import { describe, expect, it } from "vitest";
import { AUTH_ROUTES, COMPATIBILITY_ROUTES, ROUTE_REGISTRY, homeForRole, navigationForRole, routeForPath } from "./routeRegistry";

describe("Stage 225 route registry", () => {
  it("creates exactly 9 business and 13 admin navigation items", () => {
    expect(navigationForRole("business")).toHaveLength(9);
    expect(navigationForRole("admin")).toHaveLength(13);
    expect(new Set(ROUTE_REGISTRY.map((route) => route.path)).size).toBe(22);
  });

  it("keeps auth and compatibility routes explicit", () => {
    expect(AUTH_ROUTES).toEqual(["/login", "/signup", "/activate", "/reset-password"]);
    expect(COMPATIBILITY_ROUTES).toEqual({ "/b2b": "/app/onboarding", "/admin": "/admin/overview", "/view": "role-home" });
    expect(routeForPath("/view", "admin").path).toBe("/admin/overview");
    expect(routeForPath("/view", "business").path).toBe("/app/onboarding");
  });

  it("uses stable role homes", () => {
    expect(homeForRole("business")).toBe("/app/onboarding");
    expect(homeForRole("admin")).toBe("/admin/overview");
  });
});
