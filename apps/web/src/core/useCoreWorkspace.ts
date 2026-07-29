import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCoreJob,
  coreFailureState,
  createCoreJob,
  newClientRequestId,
  readCoreJob,
  readCoreWorkspace,
  recoveredJobId,
  rememberJobId,
  type CoreJob,
  type CoreJobKind,
  type CoreWorkspace
} from "./coreClient";

export type CoreLoadState = "loading" | "ready" | "permission" | "unavailable" | "error";

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
  mutationRef.current = onMutation;

  const refreshJob = useCallback(async (clientRequestId?: string, signal?: AbortSignal) => {
    const id = clientRequestId || job?.clientRequestId || recoveredJobId(kind);
    if (!id) return null;
    try {
      const current = await readCoreJob(id, signal);
      setJob(current);
      setError("");
      return current;
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return null;
      setError(reason instanceof Error ? reason.message : "진행 상태를 확인하지 못했습니다.");
      return null;
    }
  }, [job?.clientRequestId, kind]);

  useEffect(() => {
    const id = recoveredJobId(kind);
    if (!id) return;
    const controller = new AbortController();
    void refreshJob(id, controller.signal);
    return () => controller.abort();
  }, [kind]); // refresh once for the id persisted in this browser tab.

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(() => { void refreshJob(job.clientRequestId); }, 1_500);
    return () => window.clearInterval(timer);
  }, [job?.clientRequestId, job?.status]);

  const start = useCallback(async (input: { keyword?: string; companyId?: string }) => {
    setBusy(true);
    setError("");
    try {
      const recovered = recoveredJobId(kind);
      const clientRequestId = job && ["queued", "running"].includes(job.status)
        ? job.clientRequestId
        : (!job && recovered ? recovered : newClientRequestId());
      rememberJobId(kind, clientRequestId);
      const created = await createCoreJob({ clientRequestId, kind, ...input });
      rememberJobId(kind, created.clientRequestId || clientRequestId);
      setJob(created);
      await mutationRef.current();
      return created;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "신규 수집 요청을 시작하지 못했습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [job, kind]);

  const cancel = useCallback(async (clientRequestId?: string) => {
    const id = clientRequestId || job?.clientRequestId;
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const cancelled = await cancelCoreJob(id);
      setJob(cancelled);
      await mutationRef.current();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "수집을 취소하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [job?.clientRequestId]);

  return { job, busy, error, start, cancel, refreshJob };
}
