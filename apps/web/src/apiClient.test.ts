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

  it("resets MFA with explicit confirmation and bootstraps a fresh anonymous CSRF token before enrollment", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-authenticated" }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        authenticated: false,
        mfaEnrollmentRequired: true,
        enrollmentToken: "reset-enrollment-once",
        expiresAt: "2026-07-30T12:00:00.000Z"
      }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-anonymous" }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        secret: "SETUPKEYONLYINMEMORY",
        enrollmentToken: "mfa-confirm-once"
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { resetMfaEnrollment, startMfaEnrollment } = await import("./apiClient");

    const challenge = await resetMfaEnrollment("CurrentPassword1!");
    expect(challenge).toMatchObject({
      mfaEnrollmentRequired: true,
      challengeToken: "reset-enrollment-once"
    });
    await expect(startMfaEnrollment(challenge.challengeToken)).resolves.toMatchObject({
      secret: "SETUPKEYONLYINMEMORY",
      enrollmentToken: "mfa-confirm-once"
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/csrf",
      "/api/auth/mfa/reset",
      "/api/auth/csrf",
      "/api/auth/mfa/enroll"
    ]);
    const resetInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(resetInit.body))).toEqual({
      currentPassword: "CurrentPassword1!",
      confirmation: "RESET_MFA"
    });
    expect(new Headers(resetInit.headers).get("X-CSRF-Token")).toBe("csrf-authenticated");
    const enrollInit = fetchMock.mock.calls[3][1] as RequestInit;
    expect(new Headers(enrollInit.headers).get("X-CSRF-Token")).toBe("csrf-anonymous");
  });

  it("fails closed when the MFA reset response does not carry the exact enrollment challenge contract", async () => {
    vi.stubGlobal("document", { cookie: "", querySelector: () => null });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-authenticated" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, enrollmentToken: "unexpected-token" })));
    const { resetMfaEnrollment } = await import("./apiClient");

    await expect(resetMfaEnrollment("CurrentPassword1!")).rejects.toMatchObject({ status: 502 });
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
