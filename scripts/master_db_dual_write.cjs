const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

function normalizeWriteMode(value) {
  return String(value || "off").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

function safeLog(logger, level, message) {
  try {
    const output = logger?.[level] || logger?.warn || console.warn;
    output.call(logger || console, message);
  } catch {
    // Shadow logging must never affect the primary collection path.
  }
}

function isPathInside(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingPath(candidatePath) {
  let current = path.resolve(candidatePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
  return current;
}

function resolvedCandidatePath(candidatePath) {
  const absolute = path.resolve(candidatePath);
  const existing = nearestExistingPath(absolute);
  if (!existing) return absolute;
  const relative = path.relative(existing, absolute);
  return path.resolve(fs.realpathSync(existing), relative);
}

function decodeMountInfoPath(value = "") {
  return String(value)
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

function mountInfoHasPath(mountInfo = "", mountPath = "") {
  const expected = path.resolve(mountPath);
  return String(mountInfo || "").split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 6 && path.resolve(decodeMountInfoPath(fields[4])) === expected;
  });
}

function renderShadowStorageValidation(options = {}) {
  const isRenderRuntime = options.isRenderRuntime
    ?? Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
  if (!isRenderRuntime) return { ok: true, code: "not_render" };

  const platform = options.platform || process.platform;
  const renderDiskDir = path.resolve(options.renderDiskDir || "/var/data");
  const dataDir = path.resolve(options.dataDir || renderDiskDir);
  const databasePath = path.resolve(options.databasePath || path.join(dataDir, "master_db", "sabun_master.sqlite"));
  if (!fs.existsSync(renderDiskDir) || !fs.statSync(renderDiskDir).isDirectory()) {
    return { ok: false, code: "render_persistent_disk_unavailable", message: `${renderDiskDir} 영구디스크 폴더를 확인할 수 없습니다.` };
  }
  if (platform === "linux") {
    let mountInfo = options.mountInfoText;
    if (mountInfo === undefined) {
      try {
        mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
      } catch (error) {
        return {
          ok: false,
          code: "render_mountinfo_unavailable",
          message: `Render 영구디스크 mount 정보를 확인할 수 없습니다: ${error.message || error}`
        };
      }
    }
    if (!mountInfoHasPath(mountInfo, renderDiskDir)) {
      return { ok: false, code: "render_persistent_disk_not_mounted", message: `${renderDiskDir}가 실제 mount 지점이 아닙니다.` };
    }
  }

  const diskRealPath = fs.realpathSync(renderDiskDir);
  const dataRealPath = resolvedCandidatePath(dataDir);
  const databaseRealPath = resolvedCandidatePath(databasePath);
  if (!isPathInside(diskRealPath, dataRealPath)) {
    return { ok: false, code: "master_db_data_outside_render_disk", message: "Master DB 데이터 경로가 Render 영구디스크 하위가 아닙니다." };
  }
  if (!isPathInside(dataRealPath, databaseRealPath)) {
    return { ok: false, code: "master_db_path_outside_data_root", message: "Master DB 파일 경로가 데이터 경로 하위가 아닙니다." };
  }
  const diskDevice = fs.statSync(diskRealPath).dev;
  const dataDevice = fs.statSync(nearestExistingPath(dataDir)).dev;
  const databaseDevice = fs.statSync(nearestExistingPath(databasePath)).dev;
  if (diskDevice !== dataDevice || diskDevice !== databaseDevice) {
    return { ok: false, code: "master_db_storage_device_mismatch", message: "Master DB 데이터와 DB 파일 경로가 같은 영구디스크에 있지 않습니다." };
  }
  return { ok: true, code: "render_persistent_disk_verified", renderDiskDir: diskRealPath };
}

function createMasterDbDualWriteQueue(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const dataDir = path.resolve(options.dataDir || rootDir);
  const outputsDir = path.resolve(options.outputsDir || path.join(dataDir, "outputs"));
  const databasePath = path.resolve(options.databasePath || path.join(dataDir, "master_db", "sabun_master.sqlite"));
  const workerPath = path.resolve(options.workerPath || path.join(__dirname, "master_db_incremental_worker.cjs"));
  const workerTimeoutMs = Math.max(10_000, Number(options.workerTimeoutMs) || 5 * 60 * 1000);
  const logger = options.logger || console;
  const mode = normalizeWriteMode(options.mode ?? process.env.MASTER_DB_WRITE_MODE);
  const storageValidation = mode === "shadow"
    ? renderShadowStorageValidation({ ...options, dataDir, databasePath })
    : { ok: true, code: "write_mode_off" };
  const configurationError = storageValidation.ok ? null : {
    code: storageValidation.code,
    message: storageValidation.message || "Shadow Master DB 저장소 검증에 실패했습니다."
  };
  const queue = [];
  const pendingKeys = new Set();
  const waiters = [];
  let active = null;
  let sequence = 0;
  let stopped = false;
  let lastResult = null;
  let lastError = null;
  let lastFailure = null;
  if (configurationError) {
    safeLog(logger, "error", `[master-db-shadow] ${configurationError.code}: ${configurationError.message}`);
  }

  function eventKey(event = {}) {
    if (event.type === "naver_run") return `naver:${event.runId || ""}:${event.manifestSha256 || ""}:${event.history?.evidence?.sha256 || ""}`;
    if (event.type === "tourism_snapshot") return `tourism:${event.sha256 || event.evidencePath || event.filePath || ""}`;
    if (event.type === "reconcile") return "reconcile";
    return "";
  }

  function publicStatus() {
    return {
      mode,
      enabled: mode === "shadow",
      queued: queue.length,
      active: Boolean(active),
      databasePath: mode === "shadow" ? databasePath : "",
      configurationError,
      lastResult,
      lastError,
      lastFailure
    };
  }

  function settleWaiters() {
    if (active || queue.length) return;
    while (waiters.length) waiters.shift()(publicStatus());
  }

  function startNext() {
    if (stopped || active || !queue.length || mode !== "shadow" || configurationError) {
      settleWaiters();
      return;
    }
    const item = queue.shift();
    const child = fork(workerPath, [], {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        MASTER_DB_ROOT_DIR: rootDir,
        MASTER_DB_DATA_DIR: dataDir,
        MASTER_DB_OUTPUTS_DIR: outputsDir,
        MASTER_DB_PATH: databasePath,
        MASTER_DB_WRITE_MODE: mode
      }
    });
    active = { item, child, messageReceived: false };
    const timeout = setTimeout(() => {
      if (!active || active.item.id !== item.id) return;
      lastError = {
        eventId: item.id,
        failedAt: new Date().toISOString(),
        code: "master_db_worker_timeout",
        message: `Shadow worker exceeded ${workerTimeoutMs}ms`
      };
      lastFailure = { ...lastError };
      safeLog(logger, "warn", `[master-db-shadow] ${lastError.message}`);
      child.kill();
    }, workerTimeoutMs);
    timeout.unref?.();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8").slice(0, 2000);
    });
    child.on("message", (message = {}) => {
      if (message.id !== item.id) return;
      active.messageReceived = true;
      active.result = message.result || null;
      if (message.ok) {
        lastResult = { eventId: item.id, completedAt: new Date().toISOString(), result: message.result || null };
        if (message.result?.type === "reconcile" && message.result?.status === "partial") {
          lastError = {
            eventId: item.id,
            failedAt: new Date().toISOString(),
            code: "master_db_reconcile_partial",
            message: `Shadow reconcile skipped ${Number(message.result?.skipped) || 0} item(s)`
          };
          lastFailure = { ...lastError };
          safeLog(logger, "warn", `[master-db-shadow] ${lastError.message}`);
        } else {
          lastError = null;
        }
      } else {
        lastError = {
          eventId: item.id,
          failedAt: new Date().toISOString(),
          code: message.error?.code || "master_db_incremental_failed",
          message: message.error?.message || "Shadow Master DB 기록 실패"
        };
        lastFailure = { ...lastError };
        safeLog(logger, "warn", `[master-db-shadow] ${lastError.code}: ${lastError.message}`);
      }
    });
    child.on("error", (error) => {
      lastError = {
        eventId: item.id,
        failedAt: new Date().toISOString(),
        code: error?.code || "master_db_worker_start_failed",
        message: error?.message || String(error)
      };
      lastFailure = { ...lastError };
      safeLog(logger, "warn", `[master-db-shadow] worker error: ${lastError.message}`);
    });
    child.on("close", (code) => {
      const completed = active;
      clearTimeout(timeout);
      active = null;
      pendingKeys.delete(item.key);
      if (!completed?.messageReceived && lastError?.eventId !== item.id) {
        lastError = {
          eventId: item.id,
          failedAt: new Date().toISOString(),
          code: code === 0 ? "master_db_worker_no_result" : "master_db_worker_exit",
          message: stderr.trim() || (code === 0
            ? "Shadow worker exited without a result"
            : `Shadow worker exited with code ${code}`)
        };
        lastFailure = { ...lastError };
        safeLog(logger, "warn", `[master-db-shadow] ${lastError.message}`);
      }
      if (!stopped
        && item.event.type === "reconcile"
        && completed?.result?.hasMore) {
        enqueue({
          type: "reconcile",
          limit: item.event.limit,
          excludeNaverRunIds: completed.result?.continuation?.excludeNaverRunIds || [],
          excludeTourismEvidenceHashes: completed.result?.continuation?.excludeTourismEvidenceHashes || []
        });
      }
      setImmediate(startNext);
    });
    try {
      child.send({ id: item.id, event: item.event });
    } catch (error) {
      lastError = {
        eventId: item.id,
        failedAt: new Date().toISOString(),
        code: "master_db_worker_send_failed",
        message: error?.message || String(error)
      };
      lastFailure = { ...lastError };
      safeLog(logger, "warn", `[master-db-shadow] ${lastError.message}`);
      child.kill();
    }
  }

  function enqueue(event = {}) {
    if (mode !== "shadow" || stopped) return { status: "off", mode };
    if (configurationError) return { status: "error", mode, ...configurationError };
    const key = eventKey(event);
    if (key && pendingKeys.has(key)) return { status: "duplicate", mode, key, queued: queue.length };
    const id = `mdb_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
    if (key) pendingKeys.add(key);
    queue.push({ id, key, event: { ...event } });
    setImmediate(startNext);
    return { status: "queued", mode, eventId: id, queued: queue.length };
  }

  function reconcile(limit = 200) {
    return enqueue({ type: "reconcile", limit });
  }

  function flush() {
    if (!active && !queue.length) return Promise.resolve(publicStatus());
    return new Promise((resolve) => waiters.push(resolve));
  }

  function stop() {
    stopped = true;
    for (const item of queue) pendingKeys.delete(item.key);
    queue.length = 0;
    if (active?.item?.key) pendingKeys.delete(active.item.key);
    if (active?.child) active.child.kill();
    active = null;
    settleWaiters();
  }

  return { mode, enqueue, reconcile, flush, stop, status: publicStatus };
}

module.exports = {
  normalizeWriteMode,
  isPathInside,
  nearestExistingPath,
  resolvedCandidatePath,
  decodeMountInfoPath,
  mountInfoHasPath,
  renderShadowStorageValidation,
  createMasterDbDualWriteQueue
};
