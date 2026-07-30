import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { AuthPanel, Button, type ThemeMode } from "@glamping-datalab-v2/ui";
import {
  activateInvitation,
  ApiError,
  checkSignupUsername,
  confirmMfaEnrollment,
  confirmPasswordReset,
  login,
  readAuthCapabilities,
  requestPasswordReset,
  resetMfaEnrollment,
  signup,
  startMfaEnrollment,
  verifyMfa
} from "../apiClient";
import { homeForRole } from "../routeRegistry";
import {
  isAuthChallenge,
  OWNERSHIP_OPTIONS,
  passwordConfirmationError,
  passwordPolicyError,
  recoveryCodesFromResult,
  roleFromAuthResult,
  tokenFromSearch,
  type AuthChallengeResult,
  type AuthCompletionResult,
  type AuthPath,
  type MfaEnrollmentSetup,
  type SignupPayload
} from "./authContracts";

export interface AuthPageProps {
  theme: ThemeMode;
  onThemeChange: () => void;
}

const unavailableCopy = {
  "/activate": {
    icon: "✓",
    eyebrow: "Invitation",
    title: "계정 활성화",
    description: "관리자가 발급한 초대의 활성화 상태를 이 화면에서 확인하게 됩니다.",
    note: "통합 인증 기능이 꺼져 있어 초대 token 검증과 비밀번호 설정을 시작하지 않았습니다."
  },
  "/reset-password": {
    icon: "↺",
    eyebrow: "Recovery",
    title: "비밀번호 재설정",
    description: "계정 식별 정보를 확인하고 안전한 재설정 절차를 시작합니다.",
    note: "통합 인증 기능이 꺼져 있어 재설정 token, 만료와 감사 기록을 만들지 않았습니다."
  }
} as const;

function ThemeAction({ theme, onChange }: { theme: ThemeMode; onChange: () => void }) {
  return <button type="button" onClick={onChange}>{theme === "light" ? "다크 모드" : "라이트 모드"}</button>;
}

export function AuthFooter({ theme, onThemeChange, links = true }: AuthPageProps & { links?: boolean }) {
  return <>
    {links
      ? <span><a href="/signup">회원가입</a> · <a href="/reset-password">비밀번호 재설정</a></span>
      : <a href="/login">로그인으로 돌아가기</a>}
    <ThemeAction theme={theme} onChange={onThemeChange} />
  </>;
}

function messageForError(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

export function navigateAfterAuthentication(result: unknown, options: { replaceLoginRequired?: boolean } = {}): boolean {
  const role = roleFromAuthResult(result);
  if (role) {
    window.location.assign(homeForRole(role === "admin" ? "admin" : "business"));
    return true;
  }
  const payload = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (payload.loginRequired === true) {
    if (options.replaceLoginRequired) replaceSensitiveMfaFlowWithLogin();
    else window.location.assign("/login");
    return true;
  }
  return false;
}

function FieldMessage({ id, state, children }: {
  id?: string;
  state?: "error" | "success" | "neutral";
  children: ReactNode;
}) {
  return <small id={id} className="v2-field-message" data-state={state || "neutral"} aria-live="polite">{children}</small>;
}

function MfaVerifyStep({ challenge, onComplete, onCancel, page }: {
  challenge: AuthChallengeResult;
  onComplete: (result: AuthCompletionResult) => void;
  onCancel: () => void;
  page: AuthPageProps;
}) {
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onComplete(await verifyMfa(challenge.challengeToken, code.trim(), useRecoveryCode));
    } catch (reason) {
      setError(messageForError(reason, "MFA 확인 서버에 연결하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return <AuthPanel
    eyebrow="Multi-factor authentication"
    title={useRecoveryCode ? "복구 코드로 확인하세요" : "인증 앱 코드를 입력하세요"}
    description="관리자 계정의 두 번째 인증 단계입니다. challenge는 이 화면의 메모리에서만 유지됩니다."
    icon="2F"
    onSubmit={submit}
    footer={<AuthFooter {...page} links={false} />}
  >
    <label className="v2-field">
      <span>{useRecoveryCode ? "복구 코드" : "6자리 인증 코드"}</span>
      <input
        name="mfaCode"
        inputMode={useRecoveryCode ? "text" : "numeric"}
        autoComplete={useRecoveryCode ? "off" : "one-time-code"}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        minLength={6}
        required
        autoFocus
      />
    </label>
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    <Button className="v2-auth-submit" type="submit" disabled={busy}>{busy ? "확인 중…" : "MFA 확인"}</Button>
    <div className="v2-auth-actions">
      <Button type="button" variant="quiet" onClick={() => { setCode(""); setUseRecoveryCode(!useRecoveryCode); }}>
        {useRecoveryCode ? "인증 앱 코드 사용" : "복구 코드 사용"}
      </Button>
      <Button type="button" variant="quiet" onClick={onCancel}>로그인 취소</Button>
    </div>
  </AuthPanel>;
}

function MfaEnrollmentFrame({ embedded, eyebrow, title, description, onSubmit, page, children }: {
  embedded: boolean;
  eyebrow: string;
  title: string;
  description: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  page?: AuthPageProps;
  children: ReactNode;
}) {
  const titleId = useId();
  if (!embedded) {
    return <AuthPanel
      eyebrow={eyebrow}
      title={title}
      description={description}
      icon={eyebrow === "Recovery codes" ? "RC" : "2F"}
      onSubmit={onSubmit}
      footer={page ? <AuthFooter {...page} links={false} /> : undefined}
    >{children}</AuthPanel>;
  }
  return <section className="v2-mfa-enrollment" aria-labelledby={titleId} data-testid="mfa-enrollment-step">
    <header>
      <span className="v2-eyebrow">{eyebrow}</span>
      <h3 id={titleId}>{title}</h3>
      <p>{description}</p>
    </header>
    {onSubmit
      ? <form className="v2-auth-form" onSubmit={onSubmit}>{children}</form>
      : <div className="v2-auth-form">{children}</div>}
  </section>;
}

export function MfaRecoveryCodeStep({ recoveryCodes, onComplete, embedded = false, page }: {
  recoveryCodes: readonly string[];
  onComplete: () => void;
  embedded?: boolean;
  page?: AuthPageProps;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <MfaEnrollmentFrame
    embedded={embedded}
    eyebrow="Recovery codes"
    title="새 복구 코드를 안전하게 보관하세요"
    description="각 코드는 한 번만 사용할 수 있습니다. 이 화면을 닫으면 다시 표시하지 않습니다."
    page={page}
  >
    <ul className="v2-recovery-list" aria-label="관리자 MFA 복구 코드">
      {recoveryCodes.map((recoveryCode) => <li key={recoveryCode}><code>{recoveryCode}</code></li>)}
    </ul>
    <label className="v2-check v2-recovery-acknowledgement">
      <input
        type="checkbox"
        checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)}
        autoFocus
      />
      <span>복구 코드를 안전한 곳에 별도로 저장했으며, 이 화면을 닫으면 다시 볼 수 없음을 확인했습니다.</span>
    </label>
    <Button className="v2-auth-submit" type="button" disabled={!acknowledged} onClick={onComplete}>
      {embedded ? "확인하고 새로 로그인" : "안전하게 보관했습니다"}
    </Button>
  </MfaEnrollmentFrame>;
}

export function MfaEnrollmentStep({ challenge, onComplete, onCancel, page, embedded = false }: {
  challenge: AuthChallengeResult;
  onComplete: (result: AuthCompletionResult) => void;
  onCancel: () => void;
  page?: AuthPageProps;
  embedded?: boolean;
}) {
  const [setup, setSetup] = useState<MfaEnrollmentSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completion, setCompletion] = useState<AuthCompletionResult | null>(null);
  const recoveryCodes = completion ? recoveryCodesFromResult(completion) : [];

  const begin = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await startMfaEnrollment(challenge.challengeToken);
      if (!result.secret) throw new Error("MFA 등록 secret이 비어 있습니다.");
      setSetup(result);
    } catch (reason) {
      setError(messageForError(reason, "MFA 등록을 시작하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError("");
    try {
      const result = await confirmMfaEnrollment(challenge.challengeToken, code.trim(), setup.enrollmentToken);
      const codes = recoveryCodesFromResult(result);
      if (!codes.length) throw new Error("새 복구 코드를 받지 못했습니다.");
      setSetup(null);
      setCode("");
      setCompletion(result);
    } catch (reason) {
      setError(messageForError(reason, "MFA 등록 코드를 확인하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  if (completion && recoveryCodes.length) {
    return <MfaRecoveryCodeStep
      recoveryCodes={recoveryCodes}
      embedded={embedded}
      page={page}
      onComplete={() => {
        const result = completion;
        setCompletion(null);
        onComplete(result);
      }}
    />;
  }

  return <MfaEnrollmentFrame
    embedded={embedded}
    eyebrow="MFA enrollment"
    title={embedded ? "Google Authenticator에 MFA를 다시 등록하세요" : "관리자 MFA를 등록하세요"}
    description="Google Authenticator에 수동 설정 키를 추가한 뒤 생성된 6자리 코드를 확인합니다. 설정 키와 token은 완료 전 이 화면의 메모리에서만 유지됩니다."
    onSubmit={setup ? confirm : undefined}
    page={page}
  >
    {setup ? <>
      <div className="v2-sensitive-value">
        <span>수동 등록 키</span>
        <code>{setup.secret}</code>
      </div>
      <p className="v2-auth-note" role="status">Google Authenticator에서 <strong>+</strong> → <strong>설정 키 입력</strong>을 선택하고 위 키를 등록하세요. 키 유형은 <strong>시간 기반</strong>입니다.</p>
      <label className="v2-field">
        <span>6자리 인증 코드</span>
        <input name="mfaEnrollmentCode" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} minLength={6} required autoFocus />
      </label>
      {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
      <Button className="v2-auth-submit" type="submit" disabled={busy}>{busy ? "등록 확인 중…" : "MFA 등록 완료"}</Button>
    </> : <>
      <p className="v2-auth-note" role="status">관리자 계정은 MFA 등록을 완료해야 운영 화면에 접근할 수 있습니다. 등록 정보는 브라우저 저장소에 남기지 않습니다.</p>
      {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
      <Button className="v2-auth-submit" type="button" onClick={begin} disabled={busy} autoFocus={embedded}>{busy ? "등록 준비 중…" : embedded ? "MFA 재등록 시작" : "MFA 등록 시작"}</Button>
    </>}
    <Button type="button" variant="quiet" onClick={() => {
      setSetup(null);
      setCode("");
      setCompletion(null);
      onCancel();
    }}>{embedded ? "로그인 화면에서 MFA 등록 계속하기" : "로그인 취소"}</Button>
  </MfaEnrollmentFrame>;
}

export function MfaResetSection({ onSessionRevoked }: { onSessionRevoked?: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [challenge, setChallenge] = useState<AuthChallengeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const warningId = useId();
  const finish = () => {
    setChallenge(null);
    if (onSessionRevoked) onSessionRevoked();
    else replaceSensitiveMfaFlowWithLogin();
  };

  if (challenge) {
    return <MfaEnrollmentStep challenge={challenge} onComplete={finish} onCancel={finish} embedded />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed) {
      setError("MFA 재설정의 영향을 확인해 주세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await resetMfaEnrollment(currentPassword);
      setCurrentPassword("");
      setConfirmed(false);
      setChallenge(result);
    } catch (reason) {
      setError(messageForError(reason, "MFA 재설정을 시작하지 못했습니다."));
      setCurrentPassword("");
    } finally {
      setBusy(false);
    }
  };

  return <form className="v2-mfa-reset-form" onSubmit={submit} data-testid="admin-mfa-reset-form">
    <p className="v2-mfa-reset-warning" id={warningId} role="alert">
      재설정을 실행하면 현재 MFA 등록, 기존 복구 코드와 로그인된 모든 세션이 즉시 폐기됩니다. 이 브라우저도 로그아웃되며 새 MFA 등록 후 다시 로그인해야 합니다.
    </p>
    <label className="v2-field">
      <span>현재 비밀번호</span>
      <input
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        aria-describedby={warningId}
        required
        autoFocus
      />
    </label>
    <label className="v2-check v2-mfa-reset-confirmation">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required />
      <span>현재 인증 수단·복구 코드·모든 세션의 폐기를 이해했으며 MFA를 다시 설정하겠습니다.</span>
    </label>
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    <Button className="v2-mfa-reset-submit" type="submit" disabled={busy || !confirmed || currentPassword.length === 0}>
      {busy ? "MFA 재설정 중…" : "MFA 폐기 후 다시 설정"}
    </Button>
  </form>;
}

export function replaceSensitiveMfaFlowWithLogin(location: Pick<Location, "replace" | "assign"> = window.location): void {
  // Replacing this history entry prevents setup keys and one-time recovery
  // codes from being revisited through Back/BFCache after the flow ends.
  location.replace("/login");
}

function LoginPage(page: AuthPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<AuthChallengeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const finishChallenge = (result: AuthCompletionResult) => {
    if (!navigateAfterAuthentication(result, { replaceLoginRequired: true })) {
      setChallenge(null);
      setPassword("");
      setNotice("MFA 등록을 완료했습니다. 새 로그인에서 MFA 확인을 계속하세요.");
    }
  };

  if (challenge?.mfaEnrollmentRequired) {
    return <MfaEnrollmentStep challenge={challenge} onComplete={finishChallenge} onCancel={() => setChallenge(null)} page={page} />;
  }
  if (challenge?.mfaRequired) {
    return <MfaVerifyStep challenge={challenge} onComplete={finishChallenge} onCancel={() => setChallenge(null)} page={page} />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await login(username.trim(), password);
      if (isAuthChallenge(result)) setChallenge(result);
      else if (!navigateAfterAuthentication(result)) setError("로그인 응답에서 역할을 확인하지 못했습니다.");
    } catch (reason) {
      setError(messageForError(reason, "로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요."));
    } finally {
      setBusy(false);
    }
  };

  return <AuthPanel
    eyebrow="Secure access"
    title="운영 데이터에 안전하게 접속하세요"
    description="V2 호환 아이디 또는 이메일과 비밀번호를 입력하세요. 인증 정보는 브라우저 저장소에 보관하지 않습니다."
    icon="V2"
    onSubmit={submit}
    footer={<AuthFooter {...page} />}
  >
    <label className="v2-field"><span>아이디 또는 이메일</span><input name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus /></label>
    <label className="v2-field"><span>비밀번호</span><input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    {notice ? <p className="v2-form-success" role="status">{notice}</p> : null}
    <Button className="v2-login-submit v2-auth-submit" type="submit" disabled={busy}>{busy ? "확인 중…" : "로그인"}</Button>
  </AuthPanel>;
}

function SignupPage(page: AuthPageProps) {
  const [username, setUsername] = useState("");
  const [checkedUsername, setCheckedUsername] = useState("");
  const [usernameAvailable, setUsernameAvailable] = useState(false);
  const [usernameMessage, setUsernameMessage] = useState("아이디 중복 확인을 진행하세요.");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const resetUsernameCheck = (value: string) => {
    setUsername(value);
    setCheckedUsername("");
    setUsernameAvailable(false);
    setUsernameMessage("아이디 중복 확인을 진행하세요.");
  };

  const checkUsername = async () => {
    const value = username.trim().toLowerCase();
    if (!value) {
      setUsernameMessage("아이디를 입력하세요.");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const result = await checkSignupUsername(value);
      setCheckedUsername(result.username || value);
      setUsernameAvailable(result.available);
      setUsernameMessage(result.message || (result.available ? "사용 가능한 아이디입니다." : "사용할 수 없는 아이디입니다."));
    } catch (reason) {
      setCheckedUsername("");
      setUsernameAvailable(false);
      setUsernameMessage(messageForError(reason, "중복 확인에 실패했습니다."));
    } finally {
      setChecking(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const normalizedUsername = String(form.get("username") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const passwordConfirm = String(form.get("passwordConfirm") || "");
    const policyError = passwordPolicyError(password) || passwordConfirmationError(password, passwordConfirm);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (!usernameAvailable || checkedUsername !== normalizedUsername) {
      setError("아이디 중복 확인을 완료해 주세요.");
      return;
    }
    const payload: SignupPayload = {
      username: normalizedUsername,
      password,
      passwordConfirm,
      phone: String(form.get("phone") || "").trim(),
      email: String(form.get("email") || "").trim(),
      companyName: String(form.get("companyName") || "").trim(),
      ownershipStatus: String(form.get("ownershipStatus") || "owned") as SignupPayload["ownershipStatus"],
      agreeTerms: form.get("agreeTerms") === "1",
      agreePrivacy: form.get("agreePrivacy") === "1",
      agreeMarketing: form.get("agreeMarketing") === "1",
      confirmAge: form.get("confirmAge") === "1"
    };
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await signup(payload);
      if (!navigateAfterAuthentication(result)) {
        const resultPayload = result as unknown as Record<string, unknown>;
        setSuccess(resultPayload.activationRequired === true
          ? "가입 요청을 접수했습니다. mock 이메일 또는 초대 안내에서 활성화를 계속하세요."
          : String(resultPayload.message || "계정을 새로 발급했습니다. 로그인해 주세요."));
      }
    } catch (reason) {
      setError(messageForError(reason, "회원가입 요청을 완료하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return <AuthPanel
    eyebrow="Account request"
    title="사업자 계정을 시작하세요"
    description="V2 회원가입 필드와 비밀번호·동의 정책을 그대로 사용해 새 통합 계정을 발급합니다."
    icon="+"
    onSubmit={submit}
    footer={<AuthFooter {...page} links={false} />}
  >
    <label className="v2-field">
      <span>아이디</span>
      <span className="v2-field-with-action">
        <input name="username" autoComplete="username" value={username} onChange={(event) => resetUsernameCheck(event.target.value)} aria-describedby="signup-username-status" required autoFocus />
        <Button type="button" variant="secondary" onClick={checkUsername} disabled={checking}>{checking ? "확인 중" : "중복 확인"}</Button>
      </span>
      <FieldMessage id="signup-username-status" state={usernameAvailable ? "success" : checkedUsername ? "error" : "neutral"}>{usernameMessage}</FieldMessage>
    </label>
    <div className="v2-auth-grid">
      <label className="v2-field"><span>비밀번호</span><input name="password" type="password" autoComplete="new-password" aria-describedby="signup-password-help" required /><FieldMessage id="signup-password-help">8자 이상 · 영문+숫자 · 대문자 또는 특수문자</FieldMessage></label>
      <label className="v2-field"><span>비밀번호 확인</span><input name="passwordConfirm" type="password" autoComplete="new-password" required /></label>
    </div>
    <div className="v2-auth-grid">
      <label className="v2-field"><span>연락처</span><input name="phone" autoComplete="tel" required /></label>
      <label className="v2-field"><span>이메일</span><input name="email" type="email" autoComplete="email" required /></label>
    </div>
    <label className="v2-field"><span>숙소 또는 회사명</span><input name="companyName" autoComplete="organization" /></label>
    <label className="v2-field"><span>숙박업소 보유 여부</span><select name="ownershipStatus" defaultValue="owned">{OWNERSHIP_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
    <fieldset className="v2-check-list">
      <legend>회원가입 동의</legend>
      <label className="v2-check"><input type="checkbox" name="agreeTerms" value="1" required /><span>(필수) 이용약관에 동의합니다. <a href="/terms" target="_blank" rel="noreferrer">보기</a></span></label>
      <label className="v2-check"><input type="checkbox" name="agreePrivacy" value="1" required /><span>(필수) 개인정보 수집 및 이용에 동의합니다. <a href="/privacy" target="_blank" rel="noreferrer">보기</a></span></label>
      <label className="v2-check"><input type="checkbox" name="agreeMarketing" value="1" /><span>(선택) 서비스·요금제 안내 수신에 동의합니다.</span></label>
      <label className="v2-check"><input type="checkbox" name="confirmAge" value="1" required /><span>(필수) 만 14세 이상입니다.</span></label>
    </fieldset>
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    {success ? <p className="v2-form-success" role="status">{success}</p> : null}
    <Button className="v2-auth-submit" type="submit" disabled={busy || Boolean(success)}>{busy ? "계정 발급 중…" : "가입하고 시작"}</Button>
  </AuthPanel>;
}

function useSensitiveQueryToken() {
  const [token, setToken] = useState(() => tokenFromSearch(window.location.search));
  useEffect(() => {
    if (!token) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [token]);
  return [token, setToken] as const;
}

function ActivationPage(page: AuthPageProps) {
  const [token, setToken] = useSensitiveQueryToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const passwordConfirm = String(form.get("passwordConfirm") || "");
    const policyError = passwordPolicyError(password) || passwordConfirmationError(password, passwordConfirm);
    if (policyError) {
      setError(policyError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await activateInvitation({
        token: token.trim(),
        password,
        passwordConfirm
      });
      if (isAuthChallenge(result)) {
        setSuccess("계정을 활성화했습니다. 로그인하여 관리자 MFA 등록을 계속하세요.");
      } else if (!navigateAfterAuthentication(result)) {
        setSuccess("계정을 활성화했습니다. 새 비밀번호로 로그인하세요.");
      }
    } catch (reason) {
      setError(messageForError(reason, "초대를 활성화하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return <AuthPanel
    eyebrow="Invitation"
    title="계정을 활성화하세요"
    description="초대 token은 단일 사용·만료·취소 검증을 거친 뒤 새 계정 발급에만 사용됩니다."
    icon="✓"
    onSubmit={submit}
    footer={<AuthFooter {...page} links={false} />}
  >
    <label className="v2-field"><span>초대 token</span><input name="inviteToken" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required autoFocus={!token} /></label>
    <label className="v2-field"><span>새 비밀번호</span><input name="password" type="password" autoComplete="new-password" required autoFocus={Boolean(token)} /></label>
    <label className="v2-field"><span>새 비밀번호 확인</span><input name="passwordConfirm" type="password" autoComplete="new-password" required /></label>
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    {success ? <p className="v2-form-success" role="status">{success}</p> : null}
    <Button className="v2-auth-submit" type="submit" disabled={busy || Boolean(success)}>{busy ? "활성화 중…" : "계정 활성화"}</Button>
  </AuthPanel>;
}

function PasswordResetPage(page: AuthPageProps) {
  const [token, setToken] = useSensitiveQueryToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const requestReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await requestPasswordReset(String(form.get("identifier") || "").trim());
      setSuccess("계정 존재 여부와 관계없이 동일하게 처리했습니다. mock 이메일 또는 안내 메시지를 확인하세요.");
    } catch (reason) {
      setError(messageForError(reason, "비밀번호 재설정 요청을 완료하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const passwordConfirm = String(form.get("passwordConfirm") || "");
    const policyError = passwordPolicyError(password) || passwordConfirmationError(password, passwordConfirm);
    if (policyError) {
      setError(policyError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await confirmPasswordReset(token.trim(), password, passwordConfirm);
      setSuccess("비밀번호를 변경하고 기존 세션을 모두 폐기했습니다. 새 비밀번호로 로그인하세요.");
    } catch (reason) {
      setError(messageForError(reason, "비밀번호를 변경하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };

  return <AuthPanel
    eyebrow="Recovery"
    title={token ? "새 비밀번호를 설정하세요" : "비밀번호 재설정을 요청하세요"}
    description={token ? "일회용 token을 확인한 뒤 새 비밀번호로 바꾸고 기존 세션을 폐기합니다." : "아이디 또는 이메일을 입력하면 등록된 mock 이메일 경로로만 안내합니다."}
    icon="↺"
    onSubmit={token ? confirmReset : requestReset}
    footer={<AuthFooter {...page} links={false} />}
  >
    {token ? <>
      <label className="v2-field"><span>재설정 token</span><input name="resetToken" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
      <label className="v2-field"><span>새 비밀번호</span><input name="password" type="password" autoComplete="new-password" required autoFocus /></label>
      <label className="v2-field"><span>새 비밀번호 확인</span><input name="passwordConfirm" type="password" autoComplete="new-password" required /></label>
    </> : <label className="v2-field"><span>아이디 또는 이메일</span><input name="identifier" autoComplete="username" required autoFocus /></label>}
    {error ? <p className="v2-form-error" role="alert">{error}</p> : null}
    {success ? <p className="v2-form-success" role="status">{success}</p> : null}
    <Button className="v2-auth-submit" type="submit" disabled={busy || Boolean(success)}>{busy ? "처리 중…" : token ? "새 비밀번호 저장" : "재설정 안내 받기"}</Button>
  </AuthPanel>;
}

function UnavailablePage({ pathname, page, checking = false, note }: {
  pathname: keyof typeof unavailableCopy;
  page: AuthPageProps;
  checking?: boolean;
  note?: string;
}) {
  const copy = unavailableCopy[pathname];
  return <AuthPanel eyebrow={copy.eyebrow} title={copy.title} description={copy.description} icon={copy.icon} footer={<AuthFooter {...page} links={false} />}>
    <p className="v2-auth-note" role="status">{checking ? "통합 인증 기능 상태를 안전하게 확인하고 있습니다…" : note || copy.note}</p>
    <Button type="button" disabled>{checking ? "확인 중" : "사용할 수 없음"}</Button>
  </AuthPanel>;
}

function IntegrationAuthGate({ pathname, page }: {
  pathname: "/activate" | "/reset-password";
  page: AuthPageProps;
}) {
  const [state, setState] = useState<"checking" | "enabled" | "disabled">("checking");
  const [reason, setReason] = useState("");
  useEffect(() => {
    let active = true;
    readAuthCapabilities().then((capabilities) => {
      if (!active) return;
      const routeEnabled = pathname === "/activate" ? capabilities.invitationEnabled : capabilities.passwordResetEnabled;
      setReason(capabilities.unavailableReason || "");
      setState(capabilities.integrationAuthEnabled && routeEnabled ? "enabled" : "disabled");
    });
    return () => { active = false; };
  }, [pathname]);
  if (state === "checking") return <UnavailablePage pathname={pathname} page={page} checking />;
  if (state === "disabled") return <UnavailablePage pathname={pathname} page={page} note={reason} />;
  return pathname === "/activate" ? <ActivationPage {...page} /> : <PasswordResetPage {...page} />;
}

export function AuthRoutePage({ pathname, ...page }: AuthPageProps & { pathname: AuthPath }) {
  if (pathname === "/login") return <LoginPage {...page} />;
  if (pathname === "/signup") return <SignupPage {...page} />;
  return <IntegrationAuthGate pathname={pathname} page={page} />;
}
