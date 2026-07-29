export type SessionRole = "admin" | "b2b" | "";
export type AuthPath = "/login" | "/signup" | "/activate" | "/reset-password";

export interface SessionPayload {
  authenticated: boolean;
  username: string;
  role: SessionRole;
  roleLabel: string;
  expiresAt?: string;
  companyId?: string;
  accountType?: string;
  entitlements?: Record<string, unknown>;
}

export interface AuthCapabilities {
  integrationAuthEnabled: boolean;
  signupEnabled: boolean;
  invitationEnabled: boolean;
  passwordResetEnabled: boolean;
  mfaEnabled: boolean;
  unavailableReason?: string;
}

export interface AuthChallengeResult {
  ok: true;
  authenticated: false;
  mfaRequired?: boolean;
  mfaEnrollmentRequired?: boolean;
  challengeToken: string;
  expiresAt?: string;
  username?: string;
}

export interface AuthSuccessResult extends Partial<SessionPayload> {
  ok: true;
  session?: SessionPayload;
  activationRequired?: boolean;
  loginRequired?: boolean;
  recoveryCodes?: string[];
  message?: string;
}

export type LoginResult = AuthSuccessResult | AuthChallengeResult;
export type AuthCompletionResult = AuthSuccessResult | AuthChallengeResult;

export interface MfaEnrollmentSetup {
  ok: true;
  secret: string;
  otpauthUri?: string;
  enrollmentToken?: string;
  expiresAt?: string;
}

export interface SignupPayload {
  username: string;
  password: string;
  passwordConfirm: string;
  phone: string;
  email: string;
  companyName: string;
  ownershipStatus: "owned" | "planning" | "none" | "agency";
  agreeTerms: boolean;
  agreePrivacy: boolean;
  agreeMarketing: boolean;
  confirmAge: boolean;
}

export interface UsernameAvailability {
  available: boolean;
  username: string;
  message: string;
}

export const DISABLED_AUTH_CAPABILITIES: AuthCapabilities = Object.freeze({
  integrationAuthEnabled: false,
  signupEnabled: true,
  invitationEnabled: false,
  passwordResetEnabled: false,
  mfaEnabled: false
});

export const OWNERSHIP_OPTIONS = Object.freeze([
  { value: "owned", label: "숙박업소 보유" },
  { value: "planning", label: "오픈 준비 중" },
  { value: "none", label: "미보유 / 투자 검토" },
  { value: "agency", label: "대행사 / 컨설턴트" }
] as const);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeAuthCapabilities(value: unknown): AuthCapabilities {
  const payload = objectValue(value);
  const features = objectValue(payload.features);
  const integrationAuthEnabled = payload.integrationAuthEnabled === true || payload.enabled === true;
  return {
    integrationAuthEnabled,
    signupEnabled: payload.signupEnabled !== false && payload.signup !== false && features.signup !== false,
    invitationEnabled: integrationAuthEnabled && payload.invitationEnabled !== false && payload.invitationActivation !== false && features.invitation !== false,
    passwordResetEnabled: integrationAuthEnabled && payload.passwordResetEnabled !== false && payload.passwordReset !== false && features.passwordReset !== false,
    mfaEnabled: integrationAuthEnabled && payload.mfaEnabled !== false && payload.adminMfaRequired !== false && features.mfa !== false,
    unavailableReason: typeof payload.unavailableReason === "string" ? payload.unavailableReason : undefined
  };
}

export function isAuthChallenge(value: unknown): value is AuthChallengeResult {
  const payload = objectValue(value);
  return payload.ok === true
    && payload.authenticated === false
    && typeof payload.challengeToken === "string"
    && payload.challengeToken.length > 0
    && (payload.mfaRequired === true || payload.mfaEnrollmentRequired === true);
}

export function roleFromAuthResult(value: unknown): SessionRole {
  const payload = objectValue(value);
  const nested = objectValue(payload.session);
  const role = nested.role || payload.role;
  return role === "admin" || role === "b2b" ? role : "";
}

export function recoveryCodesFromResult(value: unknown): string[] {
  const payload = objectValue(value);
  const nested = objectValue(payload.session);
  const codes = Array.isArray(payload.recoveryCodes) ? payload.recoveryCodes : nested.recoveryCodes;
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string" && code.length > 0) : [];
}

export function passwordPolicyError(value: string): string {
  if (value.length < 8) return "비밀번호는 8자 이상이어야 합니다.";
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return "영문과 숫자를 함께 포함해야 합니다.";
  if (!(/[A-Z]/.test(value) || /[^A-Za-z0-9]/.test(value))) return "대문자 또는 특수문자를 포함해야 합니다.";
  return "";
}

export function passwordConfirmationError(password: string, confirmation: string): string {
  return password === confirmation ? "" : "비밀번호 확인이 일치하지 않습니다.";
}

export function tokenFromSearch(search: string, key = "token"): string {
  try {
    return new URLSearchParams(search).get(key)?.trim() || "";
  } catch {
    return "";
  }
}
