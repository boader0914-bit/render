import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCoreJob,
  coreFailureState,
  type CoreCollectionJobInput,
  createCoreJob,
  forgetJobId,
  newClientRequestId,
  readCoreJob,
  readCoreWorkspace,
  recoveredJobId,
  rememberJobId,
  resumeCoreJob,
  type CoreJob,
  type CoreJobKind,
  type CoreWorkspace
} from "./coreClient";

export type CoreLoadState = "loading" | "ready" | "permission" | "unavailable" | "error";

const ACTIVE_JOB_STATUSES = new Set<CoreJob["status"]>(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set<CoreJob["status"]>(["completed", "cancelled", "failed"]);
type ActiveCoreJob = CoreJob & { status: "queued" | "running" };
type TerminalCoreJob = CoreJob & { status: "completed" | "cancelled" | "failed" };

export function isActiveCoreJob(job: CoreJob | null | undefined): job is ActiveCoreJob {
  return Boolean(job && ACTIVE_JOB_STATUSES.has(job.status));
}

export function isTerminalCoreJob(job: CoreJob | null | undefined): job is TerminalCoreJob {
  return Boolean(job && TERMINAL_JOB_STATUSES.has(job.status));
}

export async function selectRecoverableRequest(input: {
  currentJob: CoreJob | null;
  recoveredClientRequestId: string;
  readRecoveredJob: (clientRequestId: string) => Promise<CoreJob>;
  createClientRequestId: () => string;
}): Promise<{ clientRequestId: string; recoveredJob: CoreJob | null }> {
  const candidateId = isActiveCoreJob(input.currentJob)
    ? input.currentJob.clientRequestId
    : input.recoveredClientRequestId;
  if (candidateId) {
    try {
      const recoveredJob = await input.readRecoveredJob(candidateId);
      if (isActiveCoreJob(recoveredJob)) {
        return { clientRequestId: recoveredJob.clientRequestId, recoveredJob };
      }
    } catch (reason) {
      if ((reason as { status?: number }).status !== 404) throw reason;
      // A confirmed missing request is stale. Other read failures stay fail-closed.
    }
  }
  return { clientRequestId: input.createClientRequestId(), recoveredJob: null };
}

export async function notifyTerminalJobOnce(
  job: CoreJob,
  notifiedClientRequestIds: Set<string>,
  onTerminal: () => Promise<unknown>
): Promise<boolean> {
  if (!isTerminalCoreJob(job) || notifiedClientRequestIds.has(job.clientRequestId)) return false;
  notifiedClientRequestIds.add(job.clientRequestId);
  await onTerminal();
  return true;
}

export function useCoreWorkspace(view: string, enabled: boolean) {
  const [workspace, setWorkspace] = useState<CoreWorkspace | null>(null);
  const [loadState, setLoadState] = useState<CoreLoadState>(enabled ? "loading" : "unavailable");
  const [message, setMessage] = useState("");

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    setLoadState((current) => workspace ? current : "loading");
    try {
      setWorkspace(await readCoreWorkspace(view, signal));
      setLoadState("ready");
      setMessage("");
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return;
      setLoadState(coreFailureState(reason));
      setMessage(reason instanceof Error ? reason.message : "신규 통합 화면을 불러오지 못했습니다.");
    }
  }, [enabled, view, workspace]);

  useEffect(() => {
    if (!enabled) {
      setWorkspace(null);
      setLoadState("unavailable");
      return;
    }
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [enabled, view]); // reload intentionally excluded: retaining prior data must not restart the request.

  return { workspace, loadState, message, reload };
}

export function useRecoverableJob(kind: CoreJobKind, onMutation: () => Promise<unknown>) {
  const [job, setJob] = useState<CoreJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutationRef = useRef(onMutation);
  const terminalNotificationsRef = useRef(new Set<string>());
  mutationRef.current = onMutation;

  const acceptJob = useCallback(async (next: CoreJob) => {
    setJob(next);
    setError("");
    if (isTerminalCoreJob(next)) {
      forgetJobId(kind);
      await notifyTerminalJobOnce(next, terminalNotificationsRef.current, () => mutationRef.current());
    } else {
      rememberJobId(kind, next.clientRequestId);
    }
    return next;
  }, [kind]);

  const refreshJob = useCallback(async (clientRequestId?: string, signal?: AbortSignal) => {
    const id = clientRequestId || job?.clientRequestId || recoveredJobId(kind);
    if (!id) return null;
    try {
      const current = await readCoreJob(id, signal);
      return await acceptJob(current);
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return null;
      setError(reason instanceof Error ? reason.message : "진행 상태를 확인하지 못했습니다.");
      return null;
    }
  }, [acceptJob, job?.clientRequestId, kind]);

  useEffect(() => {
    const id = recoveredJobId(kind);
    if (!id) return;
    const controller = new AbortController();
    void refreshJob(id, controller.signal);
    return () => controller.abort();
  }, [kind]); // refresh once for the id persisted in this browser tab.

  useEffect(() => {
    if (!isActiveCoreJob(job)) return;
    const timer = window.setInterval(() => { void refreshJob(job.clientRequestId); }, 1_500);
    return () => window.clearInterval(timer);
  }, [job?.clientRequestId, job?.status]);

  const start = useCallback(async (input: CoreCollectionJobInput) => {
    setBusy(true);
    setError("");
    try {
      const recovered = recoveredJobId(kind);
      const selection = await selectRecoverableRequest({
        currentJob: job,
        recoveredClientRequestId: recovered,
        readRecoveredJob: (clientRequestId) => readCoreJob(clientRequestId),
        createClientRequestId: newClientRequestId
      });
      if (recovered && selection.clientRequestId !== recovered) forgetJobId(kind);
      if (selection.recoveredJob) setJob(selection.recoveredJob);
      const clientRequestId = selection.clientRequestId;
      rememberJobId(kind, clientRequestId);
      const created = await createCoreJob({ clientRequestId, kind, ...input });
      await acceptJob(created);
      if (!isTerminalCoreJob(created)) await mutationRef.current();
      return created;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "신규 수집 요청을 시작하지 못했습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [acceptJob, job, kind]);

  const cancel = useCallback(async (clientRequestId?: string) => {
    const id = clientRequestId || job?.clientRequestId;
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const cancelled = await cancelCoreJob(id);
      await acceptJob(cancelled);
      if (!isTerminalCoreJob(cancelled)) await mutationRef.current();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "수집을 취소하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [acceptJob, job?.clientRequestId]);

  const resume = useCallback(async (clientRequestId?: string) => {
    const id = clientRequestId || job?.clientRequestId;
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const resumed = await resumeCoreJob(id);
      await acceptJob(resumed);
      await mutationRef.current();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "작업을 재개하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [acceptJob, job?.clientRequestId]);

  return { job, busy, error, start, cancel, resume, refreshJob };
}
