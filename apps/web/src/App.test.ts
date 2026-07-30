import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "./apiClient";
import { ProductWorkspace } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator security settings boundary", () => {
  it("renders MFA reset exactly once when platform core and its workspace are unavailable", () => {
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal("window", {
      location: { pathname: "/admin/settings", search: "", assign: vi.fn(), replace: vi.fn() },
      setInterval: vi.fn(),
      clearInterval: vi.fn()
    });
    const session: SessionPayload = {
      authenticated: true,
      username: "preview-admin",
      role: "admin",
      roleLabel: "관리자"
    };

    const markup = renderToStaticMarkup(createElement(ProductWorkspace, {
      session,
      theme: "light",
      onThemeChange: vi.fn()
    }));

    expect(markup).toContain('data-route-id="admin-settings"');
    expect(markup).toContain('data-workspace-state="unavailable"');
    expect(markup.match(/data-testid="admin-mfa-reset"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="admin-mfa-reset-form"/g)).toHaveLength(1);
    expect(markup).toContain("모든 세션이 즉시 폐기됩니다");
    expect(markup).toContain("통합 core 기능이 꺼져 있습니다");
    expect(markup).not.toContain('data-testid="connector-status"');
  });
});
