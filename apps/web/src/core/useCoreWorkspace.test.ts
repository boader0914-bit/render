import { describe, expect, it, vi } from "vitest";
import type { CoreJob, CoreJobStatus } from "./coreClient";
import {
  isActiveCoreJob,
  isTerminalCoreJob,
  notifyTerminalJobOnce,
  selectRecoverableRequest
} from "./useCoreWorkspace";

function job(clientRequestId: string, status: CoreJobStatus): CoreJob {
  return {
    clientRequestId,
    kind: "business-search",
    status,
    progress: status === "completed" ? 100 : 20,
    progressLabel: status === "completed" ? "100%" : "20%",
    etaLabel: status === "completed" ? "완료" : "1분",
    requestedAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:01.000Z",
    resultValues: []
  };
}

describe("recoverable core job lifecycle", () => {
  it("reuses the same in-flight request without allocating another id", async () => {
    const running = job("running-request", "running");
    const readRecoveredJob = vi.fn(async () => running);
    const createClientRequestId = vi.fn(() => "new-request");
    const selected = await selectRecoverableRequest({
      currentJob: running,
      recoveredClientRequestId: "saved-request",
      readRecoveredJob,
      createClientRequestId
    });

    expect(selected).toMatchObject({ clientRequestId: "running-request", recoveredJob: { status: "running" } });
    expect(readRecoveredJob).toHaveBeenCalledWith("running-request");
    expect(createClientRequestId).not.toHaveBeenCalled();
  });

  it("recovers only a saved in-flight request", async () => {
    const recovered = job("saved-running-request", "queued");
    const createClientRequestId = vi.fn(() => "new-request");
    const selected = await selectRecoverableRequest({
      currentJob: null,
      recoveredClientRequestId: recovered.clientRequestId,
      readRecoveredJob: vi.fn(async () => recovered),
      createClientRequestId
    });

    expect(selected).toEqual({ clientRequestId: recovered.clientRequestId, recoveredJob: recovered });
    expect(createClientRequestId).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"] as const)("never reuses a %s request id", async (status) => {
    const terminal = job("terminal-request", status);
    const selected = await selectRecoverableRequest({
      currentJob: terminal,
      recoveredClientRequestId: terminal.clientRequestId,
      readRecoveredJob: vi.fn(async () => terminal),
      createClientRequestId: () => "fresh-request"
    });

    expect(selected).toEqual({ clientRequestId: "fresh-request", recoveredJob: null });
    expect(selected.clientRequestId).not.toBe(terminal.clientRequestId);
  });

  it("treats a confirmed missing saved id as stale and allocates a fresh id", async () => {
    const selected = await selectRecoverableRequest({
      currentJob: null,
      recoveredClientRequestId: "missing-request",
      readRecoveredJob: vi.fn(async () => { throw { status: 404 }; }),
      createClientRequestId: () => "fresh-request"
    });

    expect(selected).toEqual({ clientRequestId: "fresh-request", recoveredJob: null });
  });

  it("fails closed instead of duplicating an in-flight request when verification fails", async () => {
    await expect(selectRecoverableRequest({
      currentJob: job("possibly-running", "running"),
      recoveredClientRequestId: "possibly-running",
      readRecoveredJob: vi.fn(async () => { throw new Error("network unavailable"); }),
      createClientRequestId: () => "must-not-be-used"
    })).rejects.toThrow("network unavailable");
  });

  it("awaits one immediate workspace reload for each terminal request", async () => {
    const order: string[] = [];
    const notified = new Set<string>();
    const terminal = job("completed-request", "completed");
    const reload = vi.fn(async () => {
      await Promise.resolve();
      order.push("reloaded");
    });

    const first = await notifyTerminalJobOnce(terminal, notified, reload);
    order.push("returned");
    const second = await notifyTerminalJobOnce(terminal, notified, reload);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(order).toEqual(["reloaded", "returned"]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isTerminalCoreJob(terminal)).toBe(true);
    expect(isActiveCoreJob(terminal)).toBe(false);
  });
});
