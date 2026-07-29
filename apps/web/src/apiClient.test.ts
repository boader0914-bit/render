import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Stage 226 API client", () => {
  it("obtains CSRF before login and preserves the V2 username body for an email", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, username: "owner@example.com", role: "b2b" }));
    vi.stubGlobal("fetch", fetchMock);
    const { login } = await import("./apiClient");

    await login("owner@example.com", "Password1!");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/csrf");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/login");
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ username: "owner@example.com", password: "Password1!" });
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-test");
    expect(init.credentials).toBe("same-origin");
  });

  it("continues through the legacy login contract when the CSRF endpoint is absent", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Not found" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, username: "legacy", role: "admin" }));
    vi.stubGlobal("fetch", fetchMock);
    const { login } = await import("./apiClient");

    await expect(login("legacy", "Password1!")).resolves.toMatchObject({ role: "admin" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes the server enrollment token into the in-memory MFA challenge contract", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-enroll" }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        authenticated: false,
        mfaEnrollmentRequired: true,
        enrollmentToken: "enrollment-once"
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { login } = await import("./apiClient");

    await expect(login("admin", "Password1!")).resolves.toMatchObject({
      mfaEnrollmentRequired: true,
      challengeToken: "enrollment-once"
    });
  });

  it("fails closed when capabilities are absent and preserves structured lockout errors", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    const capabilityFetch = vi.fn().mockResolvedValue(jsonResponse({ error: "Not found" }, { status: 404 }));
    vi.stubGlobal("fetch", capabilityFetch);
    let client = await import("./apiClient");
    await expect(client.readAuthCapabilities()).resolves.toMatchObject({
      integrationAuthEnabled: false,
      invitationEnabled: false,
      passwordResetEnabled: false
    });

    vi.resetModules();
    const lockoutFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-lock" }))
      .mockResolvedValueOnce(jsonResponse({ error: "잠시 후 다시 시도하세요.", code: "ACCOUNT_LOCKED", retryAfterSeconds: 60 }, { status: 429 }));
    vi.stubGlobal("fetch", lockoutFetch);
    client = await import("./apiClient");
    await expect(client.login("locked", "Wrong1!")).rejects.toMatchObject({
      status: 429,
      code: "ACCOUNT_LOCKED",
      retryAfterSeconds: 60
    });
    expect(lockoutFetch).toHaveBeenCalledTimes(2);
  });
});
