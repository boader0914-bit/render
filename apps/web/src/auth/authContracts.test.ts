import { describe, expect, it } from "vitest";
import {
  isAuthChallenge,
  normalizeAuthCapabilities,
  passwordConfirmationError,
  passwordPolicyError,
  recoveryCodesFromResult,
  roleFromAuthResult,
  tokenFromSearch
} from "./authContracts";

describe("Stage 226 auth contracts", () => {
  it("keeps the V2 password policy exact", () => {
    expect(passwordPolicyError("short1!")).toContain("8자");
    expect(passwordPolicyError("abcdefgh!")).toContain("숫자");
    expect(passwordPolicyError("abcdefgh1")).toContain("대문자 또는 특수문자");
    expect(passwordPolicyError("Abcdefg1")).toBe("");
    expect(passwordConfirmationError("Abcdefg1", "Abcdefg2")).toContain("일치");
  });

  it("recognizes additive MFA responses without confusing a normal V2 login", () => {
    expect(isAuthChallenge({ ok: true, authenticated: false, mfaRequired: true, challengeToken: "challenge" })).toBe(true);
    expect(isAuthChallenge({ ok: true, authenticated: false, mfaEnrollmentRequired: true, challengeToken: "enroll" })).toBe(true);
    expect(isAuthChallenge({ ok: true, username: "legacy", role: "b2b" })).toBe(false);
    expect(roleFromAuthResult({ ok: true, username: "legacy", role: "b2b" })).toBe("b2b");
    expect(roleFromAuthResult({ ok: true, session: { role: "admin" } })).toBe("admin");
  });

  it("normalizes only an explicitly enabled integration capability", () => {
    expect(normalizeAuthCapabilities({ integrationAuthEnabled: true }).invitationEnabled).toBe(true);
    expect(normalizeAuthCapabilities({ enabled: false, invitationEnabled: true }).invitationEnabled).toBe(false);
    expect(normalizeAuthCapabilities({ integrationAuthEnabled: true, features: { passwordReset: false } }).passwordResetEnabled).toBe(false);
  });

  it("parses URL tokens and recovery codes without a persistence contract", () => {
    expect(tokenFromSearch("?token=once%20only")).toBe("once only");
    expect(tokenFromSearch("?other=value")).toBe("");
    expect(recoveryCodesFromResult({ recoveryCodes: ["one", "", 2, "two"] })).toEqual(["one", "two"]);
  });
});
