"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { serialExecutor } = require("./collection_reuse.cjs");
const { collectionEnv } = require("./collector_dispatch.cjs");
const { inspectResult } = require("./daily_collection_quality.cjs");

const RUNTIME_KEYS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ", "NODE_PATH"]);
const SPEED_KEYS = /^(?:NAVER_REQUEST_|NAVER_BOOKING_DETAIL_CONCURRENCY$|NAVER_SCHEDULE_CONCURRENCY$|NAVER_SCHEDULE_DELAY_MS$|NAVER_OTA_OBSERVATION_CONCURRENCY$|REGIONAL_SEARCH_CONCURRENCY$)/;
const PROGRESS = /^(?:Collecting Naver main\.\.\.|Collecting Naver regional clusters\.\.\.|Collecting NOL\.\.\.|Checking Yeogi\.\.\.|Collecting DDNayo\.\.\.|Observing external reservation links on Naver Place\.\.\.|Checking Naver booking stock\.\.\.|Writing outputs\.\.\.)$/;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,100}$/;
function fault(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode, cancelled: code === "CRAWL_CANCELLED" }); }
function safeCode(value, fallback = "COLLECTOR_WEB_FAILED") { return SAFE_CODE.test(value || "") ? value : fallback; }
function compact(value) { return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase(); }

function createOperatingWebCollector({ dataDir, outputsDir, root, spawnImpl = spawn, onProviderBlocked = async () => {}, onProgress = () => {} }) {
  const base = path.resolve(dataDir, "collector-web"), stateFile = path.join(base, "state.json");
  const destinationRoot = path.resolve(outputsDir), lock = serialExecutor();
  let ready, state = { version: 1, halted: null, active: null }, active = null;

  async function persist() {
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, stateFile);
  }
  async function initialize() {
    ready ||= lock(async () => {
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      try {
        const stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
        if (stored?.version !== 1 || (stored.active && !ID.test(stored.active.jobId || ""))
          || (stored.halted && !SAFE_CODE.test(stored.halted.code || ""))) throw fault("COLLECTOR_WEB_STATE_INVALID");
        state = stored;
      } catch (error) { if (error.code !== "ENOENT") throw fault("COLLECTOR_WEB_STATE_UNREADABLE"); }
      if (state.active) {
        state.lastInterruptedJobId = state.active.jobId;
        state.active = null;
        state.halted = { code: state.halted?.code || "COLLECTOR_WEB_RESTART_INTERRUPTED", at: new Date().toISOString() };
      }
      await persist();
    });
    return ready;
  }
  async function status() {
    await initialize();
    return { configured: true, connected: true, workerKey: "web", halted: Boolean(state.halted), errorCode: state.halted?.code || "",
      activeJobId: state.active?.jobId || null, queued: 0, workerLastSeenAt: new Date().toISOString() };
  }
  async function halt(code, { cancelActive = false } = {}) {
    await initialize();
    if (cancelActive && active) active.stop(safeCode(code));
    await lock(async () => { state.halted = { code: safeCode(code), at: new Date().toISOString() }; await persist(); });
    return status();
  }
  async function resetHalt() {
    await initialize();
    return lock(async () => {
      if (active || state.active) throw fault("COLLECTOR_WEB_BUSY");
      state.halted = null; await persist(); return status();
    });
  }
  async function checkedTree(directory, prefix = "", files = []) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault("COLLECTOR_ARTIFACT_INVALID");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, file = path.join(directory, entry.name), info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw fault("COLLECTOR_ARTIFACT_INVALID");
      if (info.isDirectory()) await checkedTree(file, `${relative}/`, files);
      else if (info.isFile()) {
        if (info.size > 64 * 1024 * 1024 || files.length >= 2048) throw fault("COLLECTOR_ARTIFACT_TOO_LARGE");
        files.push({ name: relative, size: info.size });
      } else throw fault("COLLECTOR_ARTIFACT_INVALID");
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 256 * 1024 * 1024) throw fault("COLLECTOR_ARTIFACT_TOO_LARGE");
    return files;
  }
  function relativeFile(value) {
    if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")
      || value.split("/").some(part => !part || part === "." || part === "..") || /[:\x00-\x1f]/.test(value)) throw fault("COLLECTOR_ARTIFACT_INVALID");
    return value;
  }
  async function verify(stagingOutputs, keyword, env, payload, jobId, token, exitCode, assertCanFinish) {
    const entries = await fs.readdir(stagingOutputs, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw fault("COLLECTOR_ARTIFACT_INVALID");
    const runId = entries[0].name, directory = path.join(stagingOutputs, runId);
    if (!/^[a-z0-9][a-z0-9_-]*_glamping_\d{8}_\d{6}$/.test(runId)
      || !runId.endsWith(`_web_${token}_glamping_${env.RUN_STAMP}`)) throw fault("COLLECTOR_RUN_ID_MISMATCH");
    const files = await checkedTree(directory), manifestFile = files.find(file => file.name === "manifest.json");
    if (!manifestFile || manifestFile.size > 1024 * 1024) throw fault("COLLECTOR_INVALID_MANIFEST");
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")); } catch { throw fault("COLLECTOR_INVALID_MANIFEST"); }
    if (!manifest || manifest.schemaVersion !== 2 || manifest.webCollection !== true || manifest.workerCollection === true || manifest.scheduledCollection === true
      || manifest.workerKey !== "web" || manifest.trigger !== "manual" || manifest.jobId !== jobId || manifest.collectorEngine !== "operating-web-v2"
      || manifest.collectorRunToken !== token || manifest.executionHost?.role !== "operating_web"
      || compact(manifest.keyword) !== compact(keyword) || path.resolve(manifest.outputDir || "") !== directory) throw fault("COLLECTOR_SCOPE_MISMATCH");
    const fields = { CHECK_IN: "checkIn", CHECK_OUT: "checkOut", ADULTS: "adults", SEARCH_MODE: "searchMode", SEARCH_INTENT: "searchIntent",
      SEARCH_REGION: "searchRegion", SEARCH_SCOPE: "searchScope", COLLECTION_MODE: "collectionMode", COLLECTION_PURPOSE: "collectionPurpose",
      PRODUCT_MODE: "productMode", BOOKING_RANGE_DAYS: "bookingRangeDays", BOOKING_RANGE_PLACE_LIMIT: "bookingRangePlaceLimit",
      SOURCE_ROLE: "sourceRole", COLLECTION_SOURCE: "collectionSource" };
    for (const [key, field] of Object.entries(fields)) {
      const expected = env[key] ?? payload[field];
      if (expected !== undefined && String(expected) !== String(manifest[field] ?? "")) throw fault("COLLECTOR_SCOPE_MISMATCH");
    }
    if (compact(env.DETAIL_RANK_RANGES).replace(/[~–]/g, "-") !== compact(manifest.detailRankRanges).replace(/[~–]/g, "-")) throw fault("COLLECTOR_SCOPE_MISMATCH");
    if (manifest.requestPacing?.guardEnabled !== true || manifest.requestPacing?.enabled !== false
      || manifest.requestPacing?.pacingEnabled !== false || manifest.requestPacing?.minIntervalMs !== 0
      || manifest.requestPacing?.maxConcurrentRequests !== null) throw fault("COLLECTOR_GUARD_RECEIPT_REQUIRED");
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.detailJsonFiles || []) || (!manifest.files.length && !manifest.collectionFailed)) throw fault("COLLECTOR_FILE_SET_MISMATCH");
    const referenced = ["manifest.json", ...manifest.files, ...(manifest.detailJsonFiles || []).map(item => item?.file)].map(relativeFile);
    const unique = new Set(referenced.map(name => name.toLowerCase()));
    if (unique.size !== referenced.length || files.length !== referenced.length || files.some(file => !referenced.includes(file.name))) throw fault("COLLECTOR_FILE_SET_MISMATCH");
    if (Object.values(manifest.fileRoles || {}).some(name => !manifest.files.includes(relativeFile(name)))) throw fault("COLLECTOR_FILE_SET_MISMATCH");
    if (exitCode !== 0 && manifest.collectionFailed !== true) throw fault("COLLECTOR_CRAWL_FAILED");
    const quality = await inspectResult({ output: manifest, runId }, { ...payload, keyword });
    // Reserve the final directory exclusively. Publish the manifest last so a
    // partially transferred directory cannot appear as an accepted result.
    assertCanFinish();
    await fs.mkdir(destinationRoot, { recursive: true });
    const outputDir = path.join(destinationRoot, runId);
    try { await fs.mkdir(outputDir, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") throw fault("COLLECTOR_RUN_ALREADY_EXISTS"); throw error; }
    for (const entry of await fs.readdir(directory)) if (entry !== "manifest.json") await fs.rename(path.join(directory, entry), path.join(outputDir, entry));
    manifest.outputDir = outputDir;
    manifest.collectionQuality = quality;
    assertCanFinish();
    await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    assertCanFinish();
    return { manifest, runId, collectionQuality: quality };
  }

  async function run({ keyword, env: suppliedEnv = {}, payload = {}, jobId = crypto.randomUUID(), onChild = () => {}, isCancelled = () => false, context = {} }) {
    await initialize();
    if (!ID.test(jobId) || typeof keyword !== "string" || !keyword.trim() || keyword.length > 160 || /[\x00-\x1f]/.test(keyword)
      || !/^\d{4}-\d{2}-\d{2}$/.test(suppliedEnv.CHECK_IN || "")) throw fault("COLLECTOR_JOB_INVALID", 400);
    const runtime = { stopCode: null, child: null, closed: false, killTimer: null, stop(code) {
      this.stopCode = code === "COLLECTOR_PROVIDER_BLOCKED" ? code : (this.stopCode || code);
      if (this.child && !this.closed) {
        try { this.child.kill("SIGTERM"); } catch {}
        this.killTimer ||= setTimeout(() => { if (!this.closed) { try { this.child.kill("SIGKILL"); } catch {} } }, 2500);
        this.killTimer.unref?.();
      }
    } };
    await lock(async () => {
      if (state.halted) throw fault(state.halted.code);
      if (active || state.active) throw fault("COLLECTOR_WEB_BUSY");
      state.active = { jobId, startedAt: new Date().toISOString() }; active = runtime;
      try { await persist(); } catch { active = null; throw fault("COLLECTOR_WEB_STATE_WRITE_FAILED"); }
    });
    let cancellationTimer, timeoutTimer, childDone, blocked = false, blockedWork = Promise.resolve(), retainedDirectory;
    try {
      if (isCancelled()) throw fault("CRAWL_CANCELLED", 499);
      const disk = await fs.statfs(base);
      if (Number(disk.bavail) * Number(disk.bsize) <= 200 * 1024 * 1024) throw fault("COLLECTOR_DISK_LOW");
      retainedDirectory = await fs.mkdtemp(path.join(base, "job-"));
      const locations = Object.fromEntries(["data", "outputs", "config", "tmp"].map(name => [name, path.join(retainedDirectory, name)]));
      await Promise.all(Object.values(locations).map(dir => fs.mkdir(dir, { mode: 0o700 })));
      const historical = context.historicalBookingBusinesses || [];
      if (!Array.isArray(historical) || historical.some(item => !item || Object.keys(item).length !== 2
        || typeof item.placeId !== "string" || typeof item.businessId !== "string"
        || !/^[1-9]\d{0,19}$/.test(item.placeId) || !/^[1-9]\d{0,19}$/.test(item.businessId))
        || Buffer.byteLength(JSON.stringify(historical)) > 900000) throw fault("COLLECTOR_CONTEXT_INVALID");
      const contextFile = path.join(locations.config, "historical-booking-businesses.json");
      await fs.writeFile(contextFile, JSON.stringify(historical), { flag: "wx", mode: 0o600 });
      const token = crypto.randomBytes(12).toString("hex").replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
      const observed = new Date(Date.now() + 9 * 3600000).toISOString();
      const stamp = observed.slice(0, 10).replaceAll("-", "") + "_" + observed.slice(11, 19).replaceAll(":", "");
      const env = Object.fromEntries(Object.entries(suppliedEnv).filter(([key, value]) => RUNTIME_KEYS.has(key.toUpperCase()) && typeof value === "string"));
      if (/^srv-[a-z0-9]+$/.test(suppliedEnv.RENDER_SERVICE_ID || "")) env.RENDER_SERVICE_ID = suppliedEnv.RENDER_SERVICE_ID;
      Object.assign(env, collectionEnv(suppliedEnv));
      for (const key of Object.keys(env)) if (SPEED_KEYS.test(key)) delete env[key];
      Object.assign(env, { DATA_DIR: locations.data, OUTPUTS_DIR: locations.outputs, CONFIG_DIR: locations.config, TMPDIR: locations.tmp, TMP: locations.tmp, TEMP: locations.tmp,
        HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile, COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_WORKER_RUNTIME: "0", COLLECTOR_WORKER_KEY: "web",
        COLLECTOR_TRIGGER: "manual", COLLECTOR_ENGINE: "operating-web-v2", COLLECTOR_JOB_ID: jobId, COLLECTOR_RUN_TOKEN: token,
        SCHEDULED_COLLECTION: "0", NAVER_REQUEST_PACING_ENABLED: "0", RUN_STAMP: stamp });
      if (runtime.stopCode || isCancelled()) throw fault(runtime.stopCode || "CRAWL_CANCELLED");
      const child = spawnImpl(process.execPath, [path.join(root, "scripts", "gyeongnam_glamping_crawl.cjs"), keyword],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
      runtime.child = child;
      const finished = childDone = new Promise((resolve, reject) => {
        child.once("error", () => { runtime.closed = true; reject(fault("COLLECTOR_CRAWL_FAILED")); });
        child.once("close", (code, signal) => { runtime.closed = true; resolve({ code, signal }); });
      });
      finished.catch(() => {});
      let tail = "";
      child.stdout?.on("data", chunk => {
        tail += chunk.toString("utf8");
        const lines = tail.split(/\r?\n/); tail = lines.pop().slice(-1024);
        for (const line of lines) {
          if (line === "COLLECTOR_PROVIDER_BLOCKED" && !blocked) {
            blocked = true;
            blockedWork = halt("COLLECTOR_PROVIDER_BLOCKED").then(() => onProviderBlocked());
            blockedWork.catch(() => runtime.stop("COLLECTOR_PROVIDER_BLOCKED"));
          } else if (PROGRESS.test(line)) { try { onProgress(`${line}\n`); } catch {} }
        }
      });
      child.stderr?.resume();
      onChild(child);
      cancellationTimer = setInterval(() => { if (isCancelled()) runtime.stop("CRAWL_CANCELLED"); }, 200);
      timeoutTimer = setTimeout(() => runtime.stop("COLLECTOR_WEB_TIMEOUT"), 12 * 60 * 60 * 1000);
      cancellationTimer.unref?.(); timeoutTimer.unref?.();
      const outcome = await finished;
      await blockedWork;
      const assertCanFinish = () => {
        const stopped = runtime.stopCode || (isCancelled() ? "CRAWL_CANCELLED" : null);
        if (stopped) throw fault(stopped, stopped === "CRAWL_CANCELLED" ? 499 : 409);
      };
      assertCanFinish();
      if (outcome.signal) throw fault("COLLECTOR_CRAWL_FAILED");
      const result = await verify(locations.outputs, keyword, env, payload, jobId, token, outcome.code, assertCanFinish);
      assertCanFinish();
      if (result.collectionQuality.status === "blocked" && !blocked) {
        blocked = true; await halt("COLLECTOR_PROVIDER_BLOCKED"); await onProviderBlocked();
      }
      if (blocked && result.collectionQuality.status !== "blocked") throw fault("COLLECTOR_PROVIDER_BLOCKED");
      return result;
    } catch (error) {
      if (runtime.child && !runtime.closed) runtime.stop(blocked ? "COLLECTOR_PROVIDER_BLOCKED" : "COLLECTOR_WEB_FAILED");
      throw fault(blocked ? "COLLECTOR_PROVIDER_BLOCKED" : safeCode(error?.code), error?.statusCode || 503);
    } finally {
      clearInterval(cancellationTimer); clearTimeout(timeoutTimer);
      // Keep ownership until the child actually exits; a kill request alone
      // must not allow a second web collection to start.
      if (childDone && !runtime.closed) await childDone.catch(() => {});
      if (runtime.closed) clearTimeout(runtime.killTimer);
      try { onChild(null); } catch {}
      await lock(async () => {
        state.active = null;
        state.lastFinishedAt = new Date().toISOString();
        if (runtime.stopCode && runtime.stopCode !== "CRAWL_CANCELLED") state.halted ||= { code: safeCode(runtime.stopCode), at: state.lastFinishedAt };
        try { await persist(); } catch { state.halted = { code: "COLLECTOR_WEB_STATE_WRITE_FAILED", at: state.lastFinishedAt }; throw fault("COLLECTOR_WEB_STATE_WRITE_FAILED"); }
        finally { active = null; }
      });
    }
  }
  return { initialize, status, halt, resetHalt, run };
}

module.exports = { createOperatingWebCollector };
