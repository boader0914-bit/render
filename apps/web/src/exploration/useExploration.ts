import { useCallback, useEffect, useState } from "react";
import {
  explorationFailureState,
  readExplorationWorkspace,
  type ExplorationWorkspace
} from "./explorationClient";

export type ExplorationLoadState = "loading" | "ready" | "permission" | "unavailable" | "error";

export function useExploration(enabled: boolean) {
  const [workspace, setWorkspace] = useState<ExplorationWorkspace | null>(null);
  const [loadState, setLoadState] = useState<ExplorationLoadState>(enabled ? "loading" : "unavailable");
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async (companyRef = "", signal?: AbortSignal) => {
    if (!enabled) return;
    setLoadState((current) => workspace ? current : "loading");
    setRefreshing(true);
    try {
      setWorkspace(await readExplorationWorkspace(companyRef, signal));
      setLoadState("ready");
    } catch (reason) {
      if ((reason as { name?: string }).name === "AbortError") return;
      setWorkspace(null);
      setLoadState(explorationFailureState(reason));
    } finally {
      setRefreshing(false);
    }
  }, [enabled, workspace]);

  useEffect(() => {
    if (!enabled) {
      setWorkspace(null);
      setLoadState("unavailable");
      return;
    }
    const controller = new AbortController();
    void reload("", controller.signal);
    return () => controller.abort();
  }, [enabled]); // reload is intentionally excluded so a settled workspace does not restart the request.

  return { workspace, loadState, refreshing, reload };
}
