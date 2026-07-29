import { useCallback, useEffect, useState } from "react";
import {
  readStage229Workspace,
  stage229FailureState,
  type Stage229RouteId,
  type Stage229Workspace
} from "./stage229Client";

export type Stage229LoadState = "loading" | "ready" | "permission" | "unavailable" | "error";

export function useStage229Workspace(view: Stage229RouteId, enabled: boolean) {
  const [workspace, setWorkspace] = useState<Stage229Workspace | null>(null);
  const [loadState, setLoadState] = useState<Stage229LoadState>(enabled ? "loading" : "unavailable");
  const [message, setMessage] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return null;
    setLoadState((current) => current === "ready" ? current : "loading");
    try {
      const next = await readStage229Workspace(view, selectedCompanyId, signal);
      setWorkspace(next);
      setLoadState("ready");
      setMessage("");
      return next;
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return null;
      setLoadState(stage229FailureState(reason));
      setMessage(reason instanceof Error ? reason.message : "입지·예측 리포트를 불러오지 못했습니다.");
      return null;
    }
  }, [enabled, selectedCompanyId, view]);

  useEffect(() => {
    if (!enabled) {
      setWorkspace(null);
      setLoadState("unavailable");
      setMessage("");
      return;
    }
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [enabled, reload]);

  const selectCompanyId = useCallback((companyId: string) => {
    if (view !== "admin-location") return;
    setWorkspace(null);
    setLoadState("loading");
    setMessage("");
    setSelectedCompanyId(companyId);
  }, [view]);

  return { workspace, loadState, message, reload, selectedCompanyId, selectCompanyId };
}
