import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AppShell,
  AuthPanel,
  EmptyState,
  MetricCard,
  PageHeader,
  StatusBadge,
  type LinkRenderer,
  type ProductRole,
  type ThemeMode
} from "@glamping-datalab-v2/ui";
import { ApiError, logout, readSession, type SessionPayload } from "./apiClient";
import { AuthFooter, AuthRoutePage, MfaResetSection } from "./auth/AuthPages";
import type { AuthPath } from "./auth/authContracts";
import { ConnectorOperations } from "./connectors/ConnectorOperations";
import { AUTH_ROUTES, homeForRole, navigationForRole, routeForPath } from "./routeRegistry";
import {
  AdminCollectionPage,
  AdminCompaniesPage,
  AdminOverviewPage,
  AdminSettingsPage,
  BusinessActivityPage,
  DeferredPage,
  LocationCardPage,
  OnboardingPage
} from "./core/CorePages";
import type { CoreMetric, CoreWorkspace as CoreWorkspacePayload } from "./core/coreClient";
import { useCoreWorkspace } from "./core/useCoreWorkspace";
import { ExplorationRoutePage } from "./exploration/ExplorationPages";
import { isExplorationRoute } from "./exploration/explorationClient";
import { purgeV2UiCaches } from "./pwa";
import { Stage229RoutePage } from "./reporting/Stage229Pages";
import { isStage229OnlyRoute, isStage229Route } from "./reporting/stage229Client";
import { businessReportEnabled, connectorRuntimeEnabled, executionEnabled, locationCardEnabled, mapRankingEnabled, platformCoreEnabled, retrospectiveEnabled, strategyEnabled } from "./runtimeFlags";
import { Stage230RoutePage } from "./strategy/Stage230Pages";
import { adminStage230Route, isStage230Route } from "./strategy/stage230Client";
import { applyTheme, currentTheme, nextTheme } from "./theme";

const renderLink: LinkRenderer = ({ href, className, children, ariaCurrent, title }) =>
  <a href={href} className={className} aria-current={ariaCurrent} title={title}>{children}</a>;

const STAGE227_ROUTE_IDS = new Set([
  "business-onboarding",
  "business-activity",
  "business-location",
  "admin-overview",
  "admin-companies",
  "admin-collection",
  "admin-settings"
]);

const METRICS_BY_ROUTE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "business-onboarding": ["freshCompanyCount", "completedJobCount", "locationCardRequestCount"],
  "business-activity": ["freshCompanyCount", "activeJobCount", "interestCount"],
  "business-report": ["freshCompanyCount", "completedJobCount", "locationCardRequestCount"],
  "business-location": ["freshCompanyCount", "locationCardRequestCount", "completedJobCount"],
  "admin-overview": ["freshCompanyCount", "activeJobCount", "completedJobCount"],
  "admin-companies": ["companyCount", "freshCompanyCount", "completedJobCount"],
  "admin-collection": ["activeJobCount", "completedJobCount", "tourismRequestCount"],
  "admin-location": ["locationCardRequestCount", "freshCompanyCount", "completedJobCount"],
  "admin-settings": ["companyCount", "activeJobCount", "completedJobCount"]
});

function metricSelection(workspace: CoreWorkspacePayload, routeId: string): readonly CoreMetric[] {
  const preferred = METRICS_BY_ROUTE[routeId] || [];
  const byId = new Map(workspace.metrics.map((metric) => [metric.id, metric]));
  return preferred.map((id) => byId.get(id)).filter((metric): metric is CoreMetric => Boolean(metric)).slice(0, 3);
}

function StateDataSection({ kind, message }: { kind: "loading" | "permission" | "unavailable" | "error"; message?: string }) {
  const content = {
    loading: { title: "신규 통합 화면을 불러오는 중입니다", description: "인증된 역할과 fresh-only 데이터 경계를 확인하고 있습니다." },
    permission: { title: "이 역할로 접근할 수 없습니다", description: "화면 숨김에 의존하지 않고 server에서도 요청을 403으로 차단합니다." },
    unavailable: { title: "통합 core 기능이 꺼져 있습니다", description: "V2_INTEGRATION_PLATFORM_CORE_ENABLED는 기본 OFF이며, 승인된 환경에서만 화면과 API가 함께 켜집니다." },
    error: { title: "신규 통합 화면을 불러오지 못했습니다", description: message || "기존 데이터를 대신 표시하지 않습니다. 잠시 후 다시 시도해 주세요." }
  }[kind];
  return <section className="v2-data-section" data-testid="core-data-section" data-workspace-state={kind}>
    <EmptyState title={content.title} description={content.description} action={kind === "loading" ? <StatusBadge tone="info">확인 중</StatusBadge> : <StatusBadge tone="warning">fail closed</StatusBadge>} />
  </section>;
}

function CoreRoutePage({ routeId, workspace, session, reload, insightsEnabled = false, connectorEnabled = false }: {
  routeId: string;
  workspace: CoreWorkspacePayload;
  session: SessionPayload;
  reload: () => Promise<unknown>;
  insightsEnabled?: boolean;
  connectorEnabled?: boolean;
}) {
  if (insightsEnabled && isStage229OnlyRoute(routeId)) {
    return <Stage229RoutePage routeId={routeId} session={session} enabled />;
  }
  const props = { workspace, session, reload };
  switch (routeId) {
    case "business-onboarding": return <OnboardingPage {...props} />;
    case "business-activity": return <BusinessActivityPage {...props} />;
    case "business-location": return <><LocationCardPage {...props} />{insightsEnabled ? <Stage229RoutePage routeId="business-location" session={session} enabled /> : null}</>;
    case "admin-overview": return <AdminOverviewPage {...props} />;
    case "admin-companies": return <AdminCompaniesPage {...props} />;
    case "admin-collection": return <AdminCollectionPage {...props} />;
    case "admin-settings": return <><AdminSettingsPage {...props} /><ConnectorOperations enabled={connectorEnabled} /></>;
    default: return <DeferredPage />;
  }
}

export function AdminMfaResetCard() {
  return <section className="v2-data-section" data-testid="admin-mfa-reset">
    <header className="v2-section-header">
      <div>
        <h2>관리자 MFA 다시 설정</h2>
        <p>Google Authenticator를 교체하거나 등록 키가 맞지 않을 때 현재 비밀번호로 기존 MFA를 폐기하고 다시 등록합니다.</p>
      </div>
    </header>
    <MfaResetSection />
  </section>;
}

export function ProductWorkspace({ session, theme, onThemeChange }: { session: SessionPayload; theme: ThemeMode; onThemeChange: () => void }) {
  const role: ProductRole = session.role === "admin" ? "admin" : "business";
  const route = routeForPath(window.location.pathname, role);
  const navigation = useMemo(() => navigationForRole(role), [role]);
  const roleMismatch = route.role !== role;
  const locationInsightsEnabled = locationCardEnabled();
  const reportInsightsEnabled = businessReportEnabled();
  const insightsEnabled = route.id === "business-report"
    ? reportInsightsEnabled
    : route.id === "business-location" || route.id === "admin-location"
      ? locationInsightsEnabled
      : false;
  const stage229OnlyRoute = insightsEnabled && isStage229OnlyRoute(route.id) ? route.id : null;
  const stage230Route = isStage230Route(route.id) ? route.id : route.id === "admin-stage-review" ? adminStage230Route(window.location.search) : null;
  const stage230Enabled = stage230Route?.endsWith("strategy") ? strategyEnabled()
    : stage230Route?.endsWith("execution") ? executionEnabled()
      : stage230Route?.endsWith("retrospective") ? retrospectiveEnabled()
        : false;
  const stage230Active = stage230Route && stage230Enabled ? stage230Route : null;
  const explorationRoute = isExplorationRoute(route.id) ? route.id : null;
  const explorationEnabled = platformCoreEnabled() && mapRankingEnabled();
  const connectorActive = role === "admin" && route.id === "admin-settings" && connectorRuntimeEnabled();
  const targeted = STAGE227_ROUTE_IDS.has(route.id) || (insightsEnabled && isStage229Route(route.id)) || Boolean(stage230Active) || Boolean(explorationRoute);
  const coreTargeted = STAGE227_ROUTE_IDS.has(route.id);
  const coreEnabled = platformCoreEnabled();
  const { workspace, loadState, message, reload } = useCoreWorkspace(route.id, coreEnabled && coreTargeted && !roleMismatch);
  const metrics = workspace ? metricSelection(workspace, route.id) : [];
  const doLogout = async () => {
    try { await logout(); } finally {
      await purgeV2UiCaches().catch(() => undefined);
      window.location.assign("/login");
    }
  };

  return <AppShell
    role={role}
    roleLabel={role === "admin" ? "관리자" : "사업자"}
    navigation={navigation}
    activePath={route.path}
    theme={theme}
    onThemeChange={onThemeChange}
    brand={{ title: "숙박 데이터랩", subtitle: "V3 통합 UI", mark: "V2" }}
    status={{
      title: explorationRoute ? "live fresh 탐색" : workspace?.state === "ready" ? "신규 수집 결과" : workspace?.state === "partial" ? "일부 데이터 준비" : "신규 수집 대기",
      detail: explorationRoute ? "승인된 business-safe 공개 범위" : workspace ? `${workspace.metrics.find((metric) => metric.id === "freshCompanyCount")?.value || "0"}개 fresh 업체` : "fresh-only 경계 확인 중"
    }}
    homePath={homeForRole(role)}
    renderLink={renderLink}
    accountLabel={session.username}
    onLogout={doLogout}
  >
    <div data-testid="stage227-page" data-route-id={route.id} data-workspace-state={roleMismatch ? "permission" : stage230Active ? "stage230" : stage229OnlyRoute ? "stage229" : connectorActive && (!coreEnabled || loadState !== "ready") ? "connector" : !coreEnabled && targeted ? "unavailable" : explorationRoute ? (explorationEnabled ? "exploration" : "unavailable") : loadState === "ready" ? (workspace?.state || "empty") : loadState}>
    <PageHeader eyebrow={route.eyebrow} title={route.title} description={route.description} actions={<>
      <StatusBadge tone={stage230Active ? "success" : explorationRoute && explorationEnabled || workspace?.collectionCapability.realProviderEnabled ? "info" : "warning"}>{stage230Active ? "Stage 230 fresh-only" : explorationRoute ? (explorationEnabled ? "V2 live fresh 탐색" : "지도·순위 미승인") : workspace?.collectionCapability.sourceLabel || "실수집 미연결"}</StatusBadge>
      {coreEnabled && coreTargeted && !roleMismatch ? <button className="v2-button v2-button--secondary" type="button" onClick={() => void reload()} disabled={loadState === "loading"}>새로고침</button> : null}
    </>} />
    {!stage230Active && !explorationRoute && !(connectorActive && !coreEnabled) ? <div className="v2-metric-grid" aria-label="신규 통합 store 지표" data-testid="core-metrics">
      {metrics.length ? metrics.map((metric) => <MetricCard key={metric.id} label={metric.label} value={metric.value} detail={metric.detail} tone={metric.tone} />) : <>
        <MetricCard label="신규 업체" value="—" detail="server 값 확인 중" />
        <MetricCard label="진행 중 run" value="—" detail="server 값 확인 중" tone="info" />
        <MetricCard label="신규 요청" value="—" detail="server 값 확인 중" tone="success" />
      </>}
    </div> : null}
    <div className="v2-core-content" data-testid="core-data-section">
      {role === "admin" && route.id === "admin-settings" && !roleMismatch ? <AdminMfaResetCard /> : null}
      {roleMismatch ? <StateDataSection kind="permission" />
        : stage230Active ? <Stage230RoutePage routeId={stage230Active} session={session} enabled />
          : explorationRoute ? <ExplorationRoutePage routeId={explorationRoute} session={session} enabled={explorationEnabled} />
          : stage229OnlyRoute ? <Stage229RoutePage routeId={stage229OnlyRoute} session={session} enabled strategyLinkEnabled={strategyEnabled()} />
          : !targeted ? <DeferredPage />
          : connectorActive && (!coreEnabled || loadState !== "ready" || !workspace) ? <>
            {coreEnabled && loadState !== "ready" ? <StateDataSection kind={loadState} message={message} /> : null}
            <ConnectorOperations enabled />
          </>
          : !coreEnabled ? <StateDataSection kind="unavailable" />
          : loadState !== "ready" ? <StateDataSection kind={loadState} message={message} />
            : workspace ? <>
              {workspace.state === "partial" ? <p className="v2-core-notice" data-tone="warning" role="status">일부 신규 수집 필드가 비어 있습니다. 있는 값을 숨기지 않되 누락 상태를 함께 표시합니다.</p> : null}
              <CoreRoutePage routeId={route.id} workspace={workspace} session={session} reload={reload} insightsEnabled={insightsEnabled} connectorEnabled={connectorActive} />
            </> : <StateDataSection kind="error" />}
    </div>
    </div>
  </AppShell>;
}

export function App(): ReactNode {
  const [theme, setTheme] = useState<ThemeMode>(() => currentTheme());
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "failed">("loading");
  const pathname = window.location.pathname;
  const isAuthRoute = (AUTH_ROUTES as readonly string[]).includes(pathname);

  const onThemeChange = () => {
    const updated = nextTheme(theme);
    applyTheme(updated);
    setTheme(updated);
  };

  useEffect(() => {
    if (isAuthRoute) { setSessionState("ready"); return; }
    const controller = new AbortController();
    readSession(controller.signal)
      .then((payload) => {
        if (!payload.authenticated) throw new ApiError(401, "로그인이 필요합니다.");
        setSession(payload);
        setSessionState("ready");
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name === "AbortError") return;
        setSessionState("failed");
      });
    return () => controller.abort();
  }, [isAuthRoute]);

  if (isAuthRoute) return <AuthRoutePage pathname={pathname as AuthPath} theme={theme} onThemeChange={onThemeChange} />;
  if (sessionState === "loading") return <div className="v2-loading" role="status">세션을 안전하게 확인하고 있습니다…</div>;
  if (sessionState === "failed" || !session) {
    return <AuthPanel eyebrow="Session required" title="세션을 확인할 수 없습니다" description="인증 실패를 공개 상태로 간주하지 않습니다. 다시 로그인해 주세요." icon="!" footer={<AuthFooter theme={theme} onThemeChange={onThemeChange} links={false} />}><a className="v2-button v2-button--primary" href="/login">로그인으로 이동</a></AuthPanel>;
  }
  return <ProductWorkspace session={session} theme={theme} onThemeChange={onThemeChange} />;
}
