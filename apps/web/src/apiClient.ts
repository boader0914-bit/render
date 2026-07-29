import {
  DISABLED_AUTH_CAPABILITIES,
  normalizeAuthCapabilities,
  type AuthCapabilities,
  type AuthCompletionResult,
  type LoginResult,
  type MfaEnrollmentSetup,
  type SessionPayload,
  type SignupPayload,
  type UsernameAvailability
} from "./auth/authContracts";

export type { SessionPayload } from "./auth/authContracts";

type JsonPayload = Record<string, unknown>;

export class ApiError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly fieldErrors: Record<string, string>;
  readonly payload: JsonPayload;

  constructor(public readonly status: number, message: string, payload: JsonPayload = {}) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
    this.code = typeof payload.code === "string" ? payload.code : "";
    this.retryAfterSeconds = Number(payload.retryAfterSeconds) || 0;
    this.fieldErrors = payload.fieldErrors && typeof payload.fieldErrors === "object"
      ? payload.fieldErrors as Record<string, string>
      : {};
  }
}

let inMemoryCsrfToken = "";

function cookieValue(name: string): string {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const row = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return row ? decodeURIComponent(row.slice(prefix.length)) : "";
}

function csrfTokenFromDocument(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || cookieValue("lodging_v2_csrf");
}

function csrfTokenFromPayload(payload: JsonPayload): string {
  for (const key of ["csrfToken", "token"]) {
    if (typeof payload[key] === "string" && payload[key]) return String(payload[key]);
  }
  return "";
}

async function jsonPayload(response: Response): Promise<JsonPayload> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as JsonPayload : {};
  } catch {
    return {};
  }
}

async function ensureCsrfToken(): Promise<string> {
  const existing = inMemoryCsrfToken || csrfTokenFromDocument();
  if (existing) return existing;
  try {
    const response = await fetch("/api/auth/csrf", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) return csrfTokenFromDocument();
    const payload = await jsonPayload(response);
    inMemoryCsrfToken = response.headers.get("x-csrf-token") || csrfTokenFromPayload(payload) || csrfTokenFromDocument();
    return inMemoryCsrfToken;
  } catch {
    // Legacy V2 has no CSRF bootstrap endpoint. Its login/signup contract must remain usable while the integration flag is off.
    return csrfTokenFromDocument();
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = String(init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("X-CSRF-Token")) {
    const token = await ensureCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const response = await fetch(path, { ...init, method, headers, credentials: "same-origin" });
  const payload = await jsonPayload(response);
  const rotatedCsrfToken = response.headers.get("x-csrf-token") || csrfTokenFromPayload(payload);
  if (rotatedCsrfToken) inMemoryCsrfToken = rotatedCsrfToken;
  if (!response.ok) throw new ApiError(response.status, String(payload.error || "요청을 완료하지 못했습니다."), payload);
  return payload as T;
}

export function readSession(signal?: AbortSignal): Promise<SessionPayload> {
  return apiRequest<SessionPayload>("/api/session", { signal });
}

export async function readAuthCapabilities(): Promise<AuthCapabilities> {
  try {
    return normalizeAuthCapabilities(await apiRequest<unknown>("/api/auth/capabilities"));
  } catch (reason) {
    const unavailableReason = reason instanceof ApiError && reason.status !== 404
      ? "인증 기능 상태를 안전하게 확인하지 못했습니다."
      : undefined;
    return { ...DISABLED_AUTH_CAPABILITIES, unavailableReason };
  }
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await apiRequest<Record<string, unknown>>("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (result.mfaEnrollmentRequired === true && !result.challengeToken && typeof result.enrollmentToken === "string") {
    return { ...result, challengeToken: result.enrollmentToken } as unknown as LoginResult;
  }
  return result as unknown as LoginResult;
}

export function verifyMfa(challengeToken: string, code: string, recoveryCode = false): Promise<AuthCompletionResult> {
  return apiRequest("/api/auth/mfa/verify", {
    method: "POST",
    body: JSON.stringify({ challengeToken, code, ...(recoveryCode ? { recoveryCode: code } : {}) })
  });
}

export async function startMfaEnrollment(challengeToken: string): Promise<MfaEnrollmentSetup> {
  const payload = await apiRequest<JsonPayload>("/api/auth/mfa/enroll", {
    method: "POST",
    body: JSON.stringify({ challengeToken })
  });
  const setup = payload.setup && typeof payload.setup === "object" ? payload.setup as JsonPayload : {};
  return {
    ok: true,
    secret: String(payload.secret || setup.secret || ""),
    otpauthUri: String(payload.otpauthUri || setup.otpauthUri || "") || undefined,
    enrollmentToken: String(payload.enrollmentToken || setup.enrollmentToken || "") || undefined,
    expiresAt: String(payload.expiresAt || setup.expiresAt || "") || undefined
  };
}

export function confirmMfaEnrollment(challengeToken: string, code: string, enrollmentToken = ""): Promise<AuthCompletionResult> {
  return apiRequest("/api/auth/mfa/confirm", {
    method: "POST",
    body: JSON.stringify({ challengeToken, enrollmentToken, code })
  });
}

export function checkSignupUsername(username: string): Promise<UsernameAvailability> {
  return apiRequest(`/api/signup/check-username?username=${encodeURIComponent(username)}`);
}

export function signup(payload: SignupPayload): Promise<AuthCompletionResult> {
  return apiRequest("/api/signup", { method: "POST", body: JSON.stringify(payload) });
}

export function activateInvitation(payload: {
  token: string;
  password: string;
  passwordConfirm: string;
}): Promise<AuthCompletionResult> {
  return apiRequest("/api/auth/invitations/activate", { method: "POST", body: JSON.stringify(payload) });
}

export function requestPasswordReset(identifier: string): Promise<{ ok: true; message?: string }> {
  return apiRequest("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ identifier, username: identifier })
  });
}

export function confirmPasswordReset(token: string, password: string, passwordConfirm: string): Promise<{ ok: true; message?: string }> {
  return apiRequest("/api/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ token, password, passwordConfirm })
  });
}

export function logout(): Promise<{ ok: true }> {
  return apiRequest("/api/logout", { method: "POST", body: "{}" });
}
