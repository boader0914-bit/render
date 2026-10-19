"use strict";

// Admission control for cooperating analytical work. This is a process-wide
// application policy when callers share one instance, not an OS memory limit.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const heavyContext = new AsyncLocalStorage();
const MiB = 1024 * 1024;
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const safeLabel = value => String(value || "analytical-work").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 72);
const fault = code => Object.assign(new Error("분석 작업이 대기 중입니다. 저장 결과는 유지됩니다. 잠시 후 다시 시도해 주세요."), { code, statusCode: 503 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const getCurrentHeavyWorkOwner = () => { const frame = heavyContext.getStore(); return frame?.open && frame.owner?.active ? frame.owner : null; };
const smallText = async filename => { try { const value = await fs.readFile(filename, "utf8"); return value.length <= 16384 ? value.trim() : null; } catch { return null; } };
const processStartFromStat = (value, pid) => {
  if (typeof value !== "string" || value.length > 16384 || !value.startsWith(String(pid) + " (")) return null;
  const close = value.lastIndexOf(")"); if (close < String(pid).length + 2 || value[close + 1] !== " ") return null;
  const fields = value.slice(close + 2).trim().split(/\s+/);
  return /^[a-zA-Z]$/.test(fields[0] || "") && /^\d+$/.test(fields[19] || "") ? fields[19] : null;
};

async function readHeavyWorkMemory() {
  const usage = process.memoryUsage();
  const [currentText, limitText, statText] = await Promise.all([
    smallText("/sys/fs/cgroup/memory.current"), smallText("/sys/fs/cgroup/memory.max"), smallText("/sys/fs/cgroup/memory.stat")
  ]);
  const number = value => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const fields = Object.fromEntries(String(statText || "").split("\n").map(line => line.trim().split(/\s+/)).filter(row => row.length === 2));
  const currentBytes = number(currentText), limitBytes = number(limitText), anonBytes = number(fields.anon), fileBytes = number(fields.file), shmemBytes = number(fields.shmem), kernelBytes = number(fields.kernel);
  // cgroup file includes shmem. Only the remainder is potentially reclaimable;
  // it must never be reported as anonymous application memory or guaranteed free.
  const reclaimableFileBytes = fileBytes === null ? null : Math.max(0, fileBytes - (shmemBytes || 0));
  const nonFileBytes = currentBytes === null || reclaimableFileBytes === null ? null : Math.max(0, currentBytes - reclaimableFileBytes);
  return { sampledAt: new Date().toISOString(), rssBytes: usage.rss, heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external, arrayBufferBytes: usage.arrayBuffers,
    cgroup: { currentBytes, limitBytes, anonBytes, fileBytes, shmemBytes, kernelBytes, reclaimableFileBytes, nonFileBytes } };
}

function createHeavyWorkScheduler({ dataDir = null, logger = null, memoryBudgetBytes = 2 * 1024 * MiB,
  maxAppRssBytes = 1024 * MiB, minimumHeadroomBytes = 256 * MiB, defaultEstimatedBytes = 256 * MiB,
  maxWaitMs = 30000, pollIntervalMs = 250, sampleIntervalMs = 100,
  memoryProbe = readHeavyWorkMemory, crossProcessLease = false, maxQueued = 128 } = {}) {
  memoryBudgetBytes = positive(memoryBudgetBytes, 2 * 1024 * MiB);
  maxAppRssBytes = positive(maxAppRssBytes, 1024 * MiB);
  minimumHeadroomBytes = positive(minimumHeadroomBytes, 256 * MiB);
  defaultEstimatedBytes = positive(defaultEstimatedBytes, 256 * MiB);
  maxWaitMs = positive(maxWaitMs, 30000); pollIntervalMs = positive(pollIntervalMs, 250); sampleIntervalMs = Math.max(100, positive(sampleIntervalMs, 100));
  maxQueued = positive(maxQueued, 128);
  if (typeof memoryProbe !== "function" || crossProcessLease && (!dataDir || !path.isAbsolute(dataDir))) throw new TypeError("Invalid heavy-work scheduler options");
  const context = heavyContext, queue = [], recent = [];
  const instanceId = crypto.randomBytes(12).toString("hex"), startedAt = new Date().toISOString();
  const lockDir = dataDir ? path.join(path.resolve(dataDir), "operations", "heavy_work") : null;
  const lockFile = lockDir ? path.join(lockDir, "active.json") : null;
  let active = null, draining = false, latestMemory = null, foregroundBurst = 0, sequence = 0;
  const counts = { completed: 0, failed: 0, rejected: 0, nested: 0, nestedRejected: 0 };
  let processIdentity = null;
  const identityPromise = Promise.all([smallText("/proc/sys/kernel/random/boot_id"), smallText("/proc/" + process.pid + "/stat")]).then(([boot, proc]) => (processIdentity = {
    pid: process.pid, instanceId, startedAt, bootId: boot && /^[a-f0-9-]{36}$/.test(boot) ? boot : null,
    processStart: processStartFromStat(proc, process.pid)
  }));
  function safeMemory(value) {
    const n = input => Number.isFinite(input) && input >= 0 ? Math.round(input) : null;
    const cg = value?.cgroup || {};
    return { sampledAt: typeof value?.sampledAt === "string" ? value.sampledAt : new Date().toISOString(),
      rssBytes: n(value?.rssBytes), heapUsedBytes: n(value?.heapUsedBytes), externalBytes: n(value?.externalBytes), arrayBufferBytes: n(value?.arrayBufferBytes),
      cgroup: Object.fromEntries(["currentBytes", "limitBytes", "anonBytes", "fileBytes", "shmemBytes", "kernelBytes", "reclaimableFileBytes", "nonFileBytes"].map(key => [key, n(cg[key])])) };
  }
  async function sample() { const value = safeMemory(await memoryProbe()); latestMemory = value; return value; }
  function admission(memory, estimate) {
    const limit = Math.min(memoryBudgetBytes, memory.cgroup.limitBytes || memoryBudgetBytes);
    if (memory.rssBytes === null) return "memory_unavailable";
    if (memory.rssBytes + estimate > Math.min(maxAppRssBytes, limit - minimumHeadroomBytes)) return "application_rss";
    // Account for file cache separately. Its reclaimability is an estimate, so
    // retain explicit headroom instead of pretending it is already free RAM.
    const used = memory.cgroup.nonFileBytes ?? memory.cgroup.currentBytes;
    if (used !== null && used + estimate + minimumHeadroomBytes > limit) return "container_headroom";
    return null;
  }
  function emit(stage, job, extra = {}) {
    const value = { stage, pid: process.pid, instanceId, ...(processIdentity ? { bootId: processIdentity.bootId, processStart: processIdentity.processStart } : {}), label: job.label, priority: job.priority, waitMs: +(performance.now() - job.enqueued).toFixed(3), ...extra };
    try { if (typeof logger === "function") logger(value); else if (logger?.info) logger.info("[heavy-work] " + JSON.stringify(value)); } catch { /* Logging never owns a lease. */ }
  }
  async function lease() {
    if (!crossProcessLease) return async () => {};
    const directories = [path.resolve(dataDir), path.dirname(lockDir), lockDir];
    for (let index = 0; index < directories.length; index++) {
      if (index > 0) { try { await fs.mkdir(directories[index]); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      const directory = await fs.lstat(directories[index]); if (!directory.isDirectory() || directory.isSymbolicLink()) throw fault("HEAVY_WORK_LEASE_UNAVAILABLE");
    }
    const identity = await identityPromise, token = crypto.randomBytes(16).toString("hex"), body = { version: 1, ...identity, token };
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(body)); } catch (error) { await handle.close(); await fs.unlink(lockFile).catch(() => {}); throw error; }
      await handle.close();
    } catch (error) {
      if (error.code !== "EEXIST") throw fault("HEAVY_WORK_LEASE_UNAVAILABLE");
      // Never clear another host's lock or guess from age. A CLI can recover
      // only a proven dead/reused PID from this same Linux boot.
      let recovery = null;
      const recoveryFile = path.join(lockDir, "recovery.json");
      try {
        // Only one cooperating process may prove/remove a dead lease. Without
        // this second exclusive lock, two stale removers could unlink a newly
        // acquired live lease between their final stat and unlink operations.
        recovery = await fs.open(recoveryFile, "wx", 0o600);
        const before = await fs.lstat(lockFile); if (!before.isFile() || before.isSymbolicLink() || before.size > 2048) return null;
        const saved = JSON.parse(await fs.readFile(lockFile, "utf8"));
        if (identity.bootId && saved.bootId === identity.bootId && Number.isSafeInteger(saved.pid) && saved.pid > 0 && /^\d+$/.test(saved.processStart || "")) {
          let proc = null, knownDead = false;
          try { proc = await fs.readFile("/proc/" + saved.pid + "/stat", "utf8"); }
          catch (error) { knownDead = error.code === "ENOENT"; }
          const start = processStartFromStat(proc, saved.pid);
          if (knownDead || start && start !== saved.processStart) {
            const after = await fs.lstat(lockFile);
            if (before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs && before.size === after.size) await fs.unlink(lockFile);
          }
        }
      } catch { /* Unknown or unreadable locks remain held. */ }
      finally { if (recovery) { await recovery.close(); await fs.unlink(recoveryFile).catch(() => {}); } }
      return null;
    }
    return async () => {
      try { const saved = JSON.parse(await fs.readFile(lockFile, "utf8")); if (saved.token === token && saved.instanceId === instanceId) await fs.unlink(lockFile); }
      catch (error) { if (error.code !== "ENOENT") emit("lease-release-warning", { label: "lease", priority: "background", enqueued: performance.now() }, { code: "HEAVY_WORK_LEASE_RELEASE_FAILED" }); }
    };
  }
  function select() {
    const foreground = queue.findIndex(job => job.priority === "foreground"), background = queue.findIndex(job => job.priority === "background");
    const index = foreground !== -1 && (background === -1 || foregroundBurst < 3) ? foreground : background;
    const job = queue.splice(index < 0 ? 0 : index, 1)[0]; clearTimeout(job.expiry);
    foregroundBurst = job.priority === "foreground" ? foregroundBurst + 1 : 0; return job;
  }
  function nested(action, frame, capture, options) {
    const owner = frame.owner;
    counts.nested++;
    // Recursive awaits are reentrant; siblings in Promise.all still run one
    // at a time. A fresh frame lets a child await its own nested work without
    // enqueuing behind itself or inheriting a sibling's local lock.
    const pending = frame.tail.catch(() => {}).then(() => capture(() => {
      const child = { owner, tail: Promise.resolve(), children: new Set(), open: true };
      return context.run(child, async () => {
        let result, failure;
        try {
          const estimate = positive(options.estimatedBytes, defaultEstimatedBytes);
          if (estimate > owner.reservationEstimate) {
            const memory = await sample();
            owner.sampledPeakRssBytes = Math.max(owner.sampledPeakRssBytes || 0, memory.rssBytes || 0);
            owner.sampledPeakAnonBytes = Math.max(owner.sampledPeakAnonBytes || 0, memory.cgroup.anonBytes || 0);
            owner.sampledPeakFileBytes = Math.max(owner.sampledPeakFileBytes || 0, memory.cgroup.fileBytes || 0);
            // Waiting here could wait for this same owner's retained heap.
            // A larger nested reservation is checked once and fails promptly.
            const reason = admission(memory, estimate);
            if (reason) {
              counts.nestedRejected++;
              emit("nested-rejected", { label: safeLabel(options.label), priority: owner.job.priority, enqueued: performance.now() }, { code: "HEAVY_WORK_MEMORY_BUSY", waitReason: reason });
              throw fault("HEAVY_WORK_MEMORY_BUSY");
            }
            owner.reservationEstimate = estimate;
          }
          result = await action();
        } catch (error) { failure = error; }
        finally { child.open = false; }
        // A sibling must also wait for detached grandchildren of this branch,
        // not just its direct action's return. The owner-wide set alone only
        // protects the outer lease and would permit two nested branches to run.
        while (child.children.size) await Promise.allSettled([...child.children]);
        if (failure) throw failure; return result;
      });
    }));
    frame.tail = pending; frame.children.add(pending); owner.children.add(pending);
    pending.finally(() => { frame.children.delete(pending); owner.children.delete(pending); }).catch(() => {});
    return pending;
  }
  async function execute(job, memory, release) {
    const owner = { token: {}, active: true, children: new Set(), job, phase: "running", started: performance.now(), before: memory, reservationEstimate: job.estimatedBytes,
      sampledPeakRssBytes: memory.rssBytes, sampledPeakAnonBytes: memory.cgroup.anonBytes, sampledPeakFileBytes: memory.cgroup.fileBytes };
    active = owner; let sampling = null;
    const takeSample = () => { if (sampling) return; sampling = sample().then(value => {
      owner.sampledPeakRssBytes = Math.max(owner.sampledPeakRssBytes || 0, value.rssBytes || 0);
      owner.sampledPeakAnonBytes = Math.max(owner.sampledPeakAnonBytes || 0, value.cgroup.anonBytes || 0);
      owner.sampledPeakFileBytes = Math.max(owner.sampledPeakFileBytes || 0, value.cgroup.fileBytes || 0);
    }).catch(() => {}).finally(() => { sampling = null; }); };
    const timer = setInterval(takeSample, sampleIntervalMs); timer.unref?.();
    emit("started", job, { memory }); let result, failure;
    // Restore the caller's request/diagnostic contexts first, then install our
    // fresh owner frame. Reversing that order would restore a stale/null owner
    // and deadlock recursive work or lose request-local raw-read accounting.
    const rootFrame = { owner, tail: Promise.resolve(), children: new Set(), open: true };
    try { result = await job.capture(() => context.run(rootFrame, async () => {
      try { return await job.action(); } finally { rootFrame.open = false; }
    })); }
    catch (error) { failure = error; }
    finally {
      // Detached index preparation is allowed by existing callers. Keep this
      // lease until all such descendants finish, including children they start.
      while (owner.children.size) await Promise.allSettled([...owner.children]);
      owner.active = false; clearInterval(timer); if (sampling) await sampling;
      let after = null; try { after = await sample(); } catch { /* Preserve the action's result. */ }
      if (after) {
        owner.sampledPeakRssBytes = Math.max(owner.sampledPeakRssBytes || 0, after.rssBytes || 0);
        owner.sampledPeakAnonBytes = Math.max(owner.sampledPeakAnonBytes || 0, after.cgroup.anonBytes || 0);
        owner.sampledPeakFileBytes = Math.max(owner.sampledPeakFileBytes || 0, after.cgroup.fileBytes || 0);
      }
      const report = { label: job.label, priority: job.priority, waitMs: +(owner.started - job.enqueued).toFixed(3),
        elapsedMs: +(performance.now() - owner.started).toFixed(3), outcome: failure ? "failed" : "completed",
        sampledPeakRssBytes: owner.sampledPeakRssBytes, sampledPeakAnonBytes: owner.sampledPeakAnonBytes, sampledPeakFileBytes: owner.sampledPeakFileBytes,
        before: memory, after };
      recent.push(report); if (recent.length > 8) recent.shift();
      counts[failure ? "failed" : "completed"]++; emit(report.outcome, job, report);
      await release(); active = null;
    }
    if (failure) job.reject(failure); else job.resolve(result);
  }
  async function drain() {
    if (draining) return; draining = true;
    try {
      while (queue.length) {
        const job = select(); let release = null, memory = null;
        try {
          while (!release) {
            if (performance.now() - job.enqueued >= maxWaitMs) throw fault(job.waitReason === "cooperating_process" ? "HEAVY_WORK_LEASE_BUSY"
              : ["application_rss", "container_headroom", "memory_unavailable"].includes(job.waitReason) ? "HEAVY_WORK_MEMORY_BUSY" : "HEAVY_WORK_SLOT_BUSY");
            memory = await sample(); job.waitReason = admission(memory, job.estimatedBytes);
            if (!job.waitReason) { release = await lease(); if (!release) job.waitReason = "cooperating_process"; }
            if (!release) { job.phase = job.waitReason === "cooperating_process" ? "waiting-lease" : "waiting-memory"; active = { waiting: true, job, phase: job.phase }; await delay(pollIntervalMs); }
          }
          active = null; await execute(job, memory, release);
        } catch (error) { active = null; if (release) await release(); counts.rejected++; emit("rejected", job, { code: error.code?.startsWith("HEAVY_WORK_") ? error.code : "HEAVY_WORK_UNAVAILABLE" }); job.reject(error.code?.startsWith("HEAVY_WORK_") ? error : fault("HEAVY_WORK_UNAVAILABLE")); }
        await tick();
      }
    } finally { draining = false; if (queue.length) void drain(); }
  }
  function run(action, options = {}) {
    if (typeof action !== "function") return Promise.reject(new TypeError("Heavy work must be a function"));
    const capture = AsyncLocalStorage.snapshot();
    const frame = context.getStore();
    if (frame?.open && frame.owner === active && frame.owner.active) return nested(action, frame, capture, options);
    if (queue.length >= maxQueued) { counts.rejected++; return Promise.reject(fault("HEAVY_WORK_QUEUE_FULL")); }
    return new Promise((resolve, reject) => {
      const job = { id: ++sequence, action, capture, resolve, reject, label: safeLabel(options.label), priority: options.priority === "background" ? "background" : "foreground",
        estimatedBytes: positive(options.estimatedBytes, defaultEstimatedBytes), enqueued: performance.now(), phase: "queued", waitReason: active ? "heavy_slot" : null };
      job.expiry = setTimeout(() => { const index = queue.indexOf(job); if (index !== -1) {
        queue.splice(index, 1); counts.rejected++; emit("rejected", job, { code: "HEAVY_WORK_SLOT_BUSY" }); reject(fault("HEAVY_WORK_SLOT_BUSY"));
      } }, maxWaitMs);
      queue.push(job);
      void drain();
    });
  }
  return { run, status: () => ({ version: 1, pid: process.pid, instanceId, startedAt,
    limits: { slots: 1, memoryBudgetBytes, maxAppRssBytes, minimumHeadroomBytes, defaultEstimatedBytes, maxWaitMs, sampleIntervalMs, maxQueued,
      crossProcessLease, admissionIsEstimate: true },
    active: active ? { label: active.job.label, priority: active.job.priority, phase: active.phase, waitReason: active.job.waitReason,
      waitMs: +((active.started || performance.now()) - active.job.enqueued).toFixed(3), runningMs: active.started ? +(performance.now() - active.started).toFixed(3) : 0 } : null,
    queued: queue.length, queuedForeground: queue.filter(job => job.priority === "foreground").length,
    queue: queue.slice(0, 20).map(job => ({ label: job.label, priority: job.priority, phase: job.phase, waitReason: "heavy_slot", waitMs: +(performance.now() - job.enqueued).toFixed(3) })),
    counts: { ...counts }, memory: latestMemory, recent: recent.slice(-4) }), sampleMemory: sample };
}

module.exports = { createHeavyWorkScheduler, readHeavyWorkMemory, getCurrentHeavyWorkOwner };
