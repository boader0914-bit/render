import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaEnrollmentStep, MfaRecoveryCodeStep, MfaResetSection, navigateAfterAuthentication, replaceSensitiveMfaFlowWithLogin } from "./AuthPages";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin MFA reset and re-enrollment UI", () => {
  it("requires the current password and explicit acknowledgement before destructive reset", () => {
    const markup = renderToStaticMarkup(createElement(MfaResetSection, {
      onSessionRevoked: vi.fn()
    }));

    expect(markup).toContain('data-testid="admin-mfa-reset-form"');
    expect(markup).toContain("현재 MFA 등록, 기존 복구 코드와 로그인된 모든 세션이 즉시 폐기됩니다");
    expect(markup).toContain('name="currentPassword"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("현재 인증 수단·복구 코드·모든 세션의 폐기를 이해했으며");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>MFA 폐기 후 다시 설정<\/button>/);
    expect(markup).not.toContain("RESET_MFA");
    expect(markup).not.toContain("enrollmentToken");
  });

  it("reuses an embedded enrollment step with manual Google Authenticator guidance", () => {
    const markup = renderToStaticMarkup(createElement(MfaEnrollmentStep, {
      challenge: {
        ok: true,
        authenticated: false,
        mfaEnrollmentRequired: true,
        challengeToken: "in-memory-only"
      },
      embedded: true,
      onComplete: vi.fn(),
      onCancel: vi.fn()
    }));

    expect(markup).toContain('data-testid="mfa-enrollment-step"');
    expect(markup).toContain("Google Authenticator에 MFA를 다시 등록하세요");
    expect(markup).toContain("MFA 재등록 시작");
    expect(markup).toContain("브라우저 저장소에 남기지 않습니다");
    expect(markup).toContain("로그인 화면에서 MFA 등록 계속하기");
    expect(markup).not.toContain("재등록 중단");
    expect(markup).not.toContain("in-memory-only");
    expect(markup).not.toContain("v2-auth-shell");
  });

  it("shows replacement recovery codes once and blocks completion until acknowledgement", () => {
    const markup = renderToStaticMarkup(createElement(MfaRecoveryCodeStep, {
      recoveryCodes: ["RECOVERY-ONE", "RECOVERY-TWO"],
      embedded: true,
      onComplete: vi.fn()
    }));

    expect(markup).toContain("RECOVERY-ONE");
    expect(markup).toContain("RECOVERY-TWO");
    expect(markup).toContain("이 화면을 닫으면 다시 표시하지 않습니다");
    expect(markup).toContain("안전한 곳에 별도로 저장했으며");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>확인하고 새로 로그인<\/button>/);
  });

  it("removes the sensitive enrollment page from history when returning to login", () => {
    const replace = vi.fn();
    const assign = vi.fn();

    replaceSensitiveMfaFlowWithLogin({ replace, assign });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login");
    expect(assign).not.toHaveBeenCalled();
  });

  it("replaces only the loginRequired MFA completion while keeping role-home navigation unchanged", () => {
    const replace = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { replace, assign } });

    expect(navigateAfterAuthentication({ loginRequired: true }, { replaceLoginRequired: true })).toBe(true);
    expect(replace).toHaveBeenCalledWith("/login");
    expect(assign).not.toHaveBeenCalled();

    replace.mockClear();
    expect(navigateAfterAuthentication({ ok: true, role: "admin" }, { replaceLoginRequired: true })).toBe(true);
    expect(assign).toHaveBeenCalledWith("/admin/overview");
    expect(replace).not.toHaveBeenCalled();
  });
});
