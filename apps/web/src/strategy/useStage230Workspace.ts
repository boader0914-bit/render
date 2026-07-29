import { useCallback, useEffect, useState } from "react";
import {
  readStage230Workspace,
  stage230AdminTargetReady,
  stage230FailureState,
  type Stage230Filters,
  type Stage230RouteId,
  type Stage230Workspace
} from "./stage230Client";

export type Stage230LoadState = "loading" | "ready" | "permission" | "unavailable" | "error";

function initialFilters(view: Stage230RouteId): Stage230Filters {
  if (!view.startsWith("admin-") || typeof window === "undefined") return { due: "all" };
  const query = new URLSearchParams(window.location.search);
  return { due: "all", companyId: query.get("companyId") || "", tenantCompanyId: query.get("tenantCompanyId") || "" };
}

export function useStage230Workspace(view: Stage230RouteId, enabled: boolean) {
  const [workspace, setWorkspace] = useState<Stage230Workspace | null>(null);
  const [loadState, setLoadState] = useState<Stage230LoadState>(enabled ? "loading" : "unavailable");
  const [message, setMessage] = useState("");
  const [filters, setFilters] = useState<Stage230Filters>(() => initialFilters(view));
  const adminTargetMissing = view.startsWith("admin-") && !stage230AdminTargetReady(filters);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || adminTargetMissing) {
      if (enabled && adminTargetMissing) {
        setWorkspace(null);
        setLoadState("ready");
        setMessage("");
      }
      return null;
    }
    setLoadState((current) => current === "ready" ? current : "loading");
    try {
      const next = await readStage230Workspace(view, view.startsWith("admin-") || view === "business-execution" ? filters : {}, signal);
      setWorkspace(next);
      setLoadState("ready");
      setMessage("");
      return next;
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return null;
      setLoadState(stage230FailureState(reason));
      setMessage(reason instanceof Error ? reason.message : "전략·실행 화면을 불러오지 못했습니다.");
      return null;
    }
  }, [adminTargetMissing, enabled, filters, view]);

  useEffect(() => {
    if (!enabled) {
      setWorkspace(null);
      setLoadState("unavailable");
      setMessage("");
      return;
    }
    if (adminTargetMissing) {
      setWorkspace(null);
      setLoadState("ready");
      setMessage("");
      return;
    }
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [adminTargetMissing, enabled, reload]);

  return { workspace, loadState, message, filters, setFilters, reload };
}
