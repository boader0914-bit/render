import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, MetricCard, StatusBadge } from "@glamping-datalab-v2/ui";
import { ApiError } from "../apiClient";
import {
  cancelConnectorJob,
  createConnectorJob,
  enableConnectorScheduler,
  readConnectorStatus,
  resumeConnectorJob,
  resumeConnectorProvider,
  stopConnectorProvider,
  stopConnectorScheduler,
  type ConnectorProviderStatus,
  type ConnectorStatus
} from "./connectorClient";

function Section({ title, description, actions, children, testId }: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return <section className="v2-data-section v2-connector-operations" data-testid={testId}>
    <header className="v2-section-header">
      <div><h2>{title}</h2><p>{description}</p></div>
      {actions ? <div className="v2-section-actions">{actions}</div> : null}
    </header>
    {children}
  </section>;
}

function percent(value: number | null): string {
  return value === null ? "미수집" : `${Math.round(value * 10) / 10}%`;
}

function quotaText(provider: ConnectorProviderStatus): string {
  const dailyCap = provider.quota.daily.callCap;
  const monthlyCap = provider.quota.monthly.callCap;
  return `오늘 ${provider.quota.daily.calls}/${dailyCap ?? "미승인"}회 · 이번 달 ${provider.quota.monthly.calls}/${monthlyCap ?? "미승인"}회`;
}

function actionError(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === "SIGNAL_CONNECTOR_ADAPTER_REQUIRED") {
    return "승인된 실제 provider adapter가 없어 실행하지 않았습니다.";
  }
  if (reason instanceof ApiError && reason.code === "SIGNAL_CONNECTOR_SCHEDULER_DISABLED") {
    return "scheduler feature flag가 꺼져 있어 실행하지 않았습니다.";
  }
  return reason instanceof Error ? reason.message : "요청을 안전하게 처리하지 못했습니다.";
}

export function connectorFeedbackTone(success: boolean): "success" | "warning" {
  return success ? "success" : "warning";
}

export function ConnectorOperations({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [busyKey, setBusyKey] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackTone, setFeedbackTone] = useState<"success" | "warning">("success");
  const [providerId, setProviderId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [periodMonth, setPeriodMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    try {
      setStatus(await readConnectorStatus(signal));
      setLoadState("ready");
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return;
      setFeedback(actionError(reason));
      setFeedbackTone(connectorFeedbackTone(false));
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [enabled, reload]);

  useEffect(() => {
    if (!status) return;
    const operational = status.providers.find((provider) => provider.operational && provider.state !== "stopped");
    if (!status.providers.some((provider) => provider.id === providerId && provider.operational && provider.state !== "stopped")) {
      setProviderId(operational?.id || "");
    }
    if (!status.companies.some((company) => company.companyId === companyId)) {
      setCompanyId(status.companies[0]?.companyId || "");
    }
  }, [status, providerId, companyId]);

  useEffect(() => {
    if (!enabled || !status?.jobs.some((job) => ["queued", "running", "retry-wait"].includes(job.status))) return;
    const timer = window.setInterval(() => void reload(), 1500);
    return () => window.clearInterval(timer);
  }, [enabled, status, reload]);

  const runAction = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setBusyKey(key);
    setFeedback("");
    setFeedbackTone(connectorFeedbackTone(true));
    try {
      await operation();
      setFeedback(success);
      setFeedbackTone(connectorFeedbackTone(true));
      await reload();
    } catch (reason) {
      setFeedback(actionError(reason));
      setFeedbackTone(connectorFeedbackTone(false));
    } finally {
      setBusyKey("");
    }
  };

  if (!enabled) return null;
  if ((loadState === "idle" || loadState === "loading") && !status) {
    return <Section title="Signal connector 운영" description="fresh store의 provider 상태를 확인하고 있습니다." testId="stage231-connectors">
      <p className="v2-core-notice" data-tone="info" role="status">provider 상태와 quota를 불러오는 중입니다.</p>
    </Section>;
  }
  if (!status) {
    return <Section title="Signal connector 운영" description="상태 조회 실패 시 connector를 자동 실행하지 않습니다." actions={<Button variant="secondary" onClick={() => void reload()}>다시 확인</Button>} testId="stage231-connectors">
      <EmptyState title="Connector 상태를 확인할 수 없습니다" description={feedback || "외부 provider 호출은 수행되지 않았습니다."} />
    </Section>;
  }

  const operationalCount = status.providers.filter((provider) => provider.operational).length;
  const stoppedCount = status.providers.filter((provider) => provider.state === "stopped").length;
  return <>
    <Section
      title="Signal connector 운영"
      description="Stage 229 신호 계약을 재사용하며, 승인된 adapter가 없으면 실제 요청을 만들지 않습니다."
      actions={<Button variant="secondary" disabled={busyKey === "reload"} onClick={() => void runAction("reload", () => readConnectorStatus().then(setStatus), "최신 상태로 갱신했습니다.")}>새로고침</Button>}
      testId="stage231-connectors"
    >
      <div className="v2-metric-grid v2-connector-metrics" aria-label="connector 핵심 상태">
        <MetricCard label="운영 가능 provider" value={`${operationalCount}/${status.providers.length}`} detail="승인 adapter가 있는 provider만 운영 가능" tone={operationalCount ? "success" : "warning"} />
        <MetricCard label="실제 외부 호출" value={`${status.diagnostics.externalNetworkCalls}건`} detail="credential 조회도 0건 유지" tone={status.diagnostics.externalNetworkCalls ? "warning" : "success"} />
        <MetricCard label="Scheduler" value={status.scheduler.stopped ? "중단" : "실행"} detail={status.scheduler.operational ? "quota 보호 활성" : "adapter 승인 대기"} tone={status.scheduler.stopped ? "warning" : "success"} />
      </div>
      <p className="v2-core-notice" data-tone={operationalCount ? "success" : "warning"} role="status">
        {operationalCount
          ? "승인 범위의 connector만 실행할 수 있습니다."
          : "현재 승인된 실제 adapter가 없습니다. 합성 결과나 fallback 호출 없이 데이터 부족 상태를 유지합니다."}
      </p>
      {feedback ? <p className="v2-core-notice" data-tone={feedbackTone} role="status">{feedback}</p> : null}
      <form
        className="v2-connector-run-form"
        aria-label="실제 signal 수집 요청"
        onSubmit={(event) => {
          event.preventDefault();
          const clientRequestId = `signal_manual_${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
          void runAction("submit", () => createConnectorJob({ clientRequestId, providerId, companyId, periodMonth }), "수집 작업을 등록했습니다. 완료될 때까지 상태를 갱신합니다.");
        }}
      >
        <label>Provider
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)} disabled={Boolean(busyKey)}>
            <option value="">승인된 provider 없음</option>
            {status.providers.filter((provider) => provider.operational && provider.state !== "stopped").map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.label} · {provider.signalKinds.join(" · ")}</option>
            ))}
          </select>
        </label>
        <label>Fresh 업체
          <select value={companyId} onChange={(event) => setCompanyId(event.target.value)} disabled={Boolean(busyKey)}>
            <option value="">실수집 업체 없음</option>
            {status.companies.map((company) => <option key={company.companyId} value={company.companyId}>{company.name || company.region} · {company.region}</option>)}
          </select>
        </label>
        <label>대상 월
          <input type="month" value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)} required disabled={Boolean(busyKey)} />
        </label>
        <Button type="submit" disabled={Boolean(busyKey) || !providerId || !companyId || !/^\d{4}-\d{2}$/.test(periodMonth)}>실제 수집 시작</Button>
      </form>
      <div className="v2-connector-provider-grid">
        {status.providers.map((provider) => {
          const actionKey = `provider:${provider.id}`;
          return <article className="v2-connector-provider" key={provider.id} data-provider-state={provider.state}>
            <header>
              <div><strong>{provider.label}</strong><small>{provider.signalKinds.join(" · ")}</small></div>
              <StatusBadge tone={provider.state === "operational" ? "success" : provider.state === "stopped" ? "warning" : "info"}>{provider.state === "operational" ? "운영 가능" : provider.state === "stopped" ? "수동 중단" : "승인 대기"}</StatusBadge>
            </header>
            <dl className="v2-connector-facts">
              <div><dt>Freshness</dt><dd>{provider.freshness === "not-collected" ? "미수집" : provider.freshness}</dd></div>
              <div><dt>Coverage</dt><dd>{percent(provider.coverage)}</dd></div>
              <div><dt>성공률</dt><dd>{percent(provider.successRate)}</dd></div>
              <div><dt>Job</dt><dd>{provider.completed} 완료 / {provider.failed} 실패</dd></div>
            </dl>
            <p className="v2-connector-quota">{quotaText(provider)} · 외부 호출 {provider.quota.externalNetworkCalls}건</p>
            {!provider.operational ? <p className="v2-connector-reason">{provider.reason || "승인된 adapter와 quota가 필요합니다."}</p> : null}
            <div className="v2-section-actions">
              {provider.state === "stopped"
                ? <Button variant="secondary" disabled={Boolean(busyKey)} onClick={() => void runAction(actionKey, () => resumeConnectorProvider(provider.id), `${provider.label} kill switch를 해제했습니다. adapter는 계속 미연결 상태입니다.`)}>중단 해제</Button>
                : <Button variant="secondary" disabled={Boolean(busyKey)} onClick={() => void runAction(actionKey, () => stopConnectorProvider(provider.id), `${provider.label} connector를 수동 중단했습니다.`)}>Kill switch</Button>}
            </div>
          </article>;
        })}
      </div>
    </Section>

    <Section
      title="Scheduler와 작업"
      description="중복 slot은 만들지 않고, quota 예약 전에는 transport를 시작하지 않습니다."
      actions={<>
        <Button variant="secondary" disabled={Boolean(busyKey) || status.scheduler.stopped} onClick={() => void runAction("scheduler-stop", stopConnectorScheduler, "Scheduler를 중단했습니다.")}>Scheduler 중단</Button>
        <Button disabled={Boolean(busyKey) || !status.scheduler.configured || !status.scheduler.operational} onClick={() => void runAction("scheduler-enable", enableConnectorScheduler, "Scheduler를 시작했습니다.")}>Scheduler 시작</Button>
      </>}
      testId="stage231-connector-jobs"
    >
      <p className="v2-core-notice" data-tone="info" role="status">수동 중단 provider {stoppedCount}개 · 실행 중 작업 {status.diagnostics.activeJobs}개 · migration/backfill/dual-write 0건</p>
      {status.jobs.length ? <ul className="v2-connector-job-list">{status.jobs.map((job) => {
        const actionable = ["queued", "running", "retry-wait"].includes(job.status);
        const resumable = ["failed", "cancelled"].includes(job.status);
        return <li key={job.clientRequestId}>
          <div className="v2-connector-job-heading">
            <div><strong>{job.providerId} · {job.target.region}</strong><small>{job.target.periodMonth} · {job.clientRequestId}</small></div>
            <StatusBadge tone={job.status === "completed" ? "success" : job.status === "failed" || job.status === "cancelled" ? "warning" : "info"}>{job.status}</StatusBadge>
          </div>
          <p>{job.target.signalKinds.join(" · ")} · 시도 {job.attempts}/{job.maxAttempts}</p>
          {job.error ? <p className="v2-core-notice" data-tone="warning">{job.error.category} · {job.error.message}</p> : null}
          {actionable ? <Button variant="secondary" disabled={Boolean(busyKey)} onClick={() => void runAction(`job:${job.clientRequestId}`, () => cancelConnectorJob(job.clientRequestId), "작업을 취소했습니다.")}>취소</Button> : null}
          {resumable ? <Button variant="secondary" disabled={Boolean(busyKey)} onClick={() => void runAction(`job:${job.clientRequestId}`, () => resumeConnectorJob(job.clientRequestId), "작업을 재개했습니다.")}>재개</Button> : null}
        </li>;
      })}</ul> : <EmptyState title="Signal 작업이 없습니다" description="승인된 adapter와 수집 예산이 연결되기 전에는 job을 자동 생성하지 않습니다." />}
    </Section>
  </>;
}
