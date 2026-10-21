"use strict";
const fs = require("node:fs"), os = require("node:os");

// Admission estimate only. File cache and unused V8 heap are reported apart
// from live allocations; neither working-set subtraction nor RSS is a promise
// that a later allocation fits. Never reset cgroup peaks or request forced GC.
function createAnalyticalMemorySampler({ fileSystem = fs, memoryUsage = () => process.memoryUsage(),
  totalMemory = () => os.totalmem(), now = Date.now } = {}) {
  function optional(file) {
    try { return fileSystem.readFileSync(file, "utf8").trim(); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
  }
  const count = value => /^\d+$/.test(value || "") && Number(value) > 0 ? Number(value) : null;
  let last = null;
  function sample() {
    const usage = memoryUsage(), statText = optional("/sys/fs/cgroup/memory.stat");
    const stat = Object.fromEntries((statText || "").split("\n").filter(Boolean).map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
    const cgroupLimit = count(optional("/sys/fs/cgroup/memory.max")) || count(optional("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    const hostLimit = Number(totalMemory()), limit = cgroupLimit && cgroupLimit < 2 ** 60 ? Math.min(cgroupLimit, hostLimit) : hostLimit;
    if (!Number.isFinite(limit) || limit <= 0 || ![usage.rss, usage.heapUsed, usage.heapTotal, usage.external].every(value => Number.isFinite(value) && value >= 0)) throw new Error("ANALYTICAL_MEMORY_UNAVAILABLE");
    const unusedHeap = Math.max(0, usage.heapTotal - usage.heapUsed);
    const nativeResidentEstimate = Math.max(0, usage.rss - usage.heapTotal - usage.external);
    const liveEstimate = usage.heapUsed + usage.external + nativeResidentEstimate;
    const anonKernelEstimate = Number.isFinite(stat.anon) ? Math.max(0, stat.anon + (stat.kernel || 0) - unusedHeap) : 0;
    last = { sampledAt: Number(now()), ratio: Math.max(liveEstimate, anonKernelEstimate) / limit,
      scope: "live-allocation-admission-estimate", limitBytes: limit, rssBytes: usage.rss, heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external, unusedHeapBytes: unusedHeap, estimatedLiveBytes: Math.max(liveEstimate, anonKernelEstimate),
      cgroupCurrentBytes: count(optional("/sys/fs/cgroup/memory.current")), anonBytes: stat.anon ?? null, fileBytes: stat.file ?? null,
      kernelBytes: stat.kernel ?? null, cgroupEvents: optional("/sys/fs/cgroup/memory.events") };
    return { ratio: last.ratio, sampledAt: last.sampledAt };
  }
  return { sample, status: () => last ? { ...last } : null };
}
module.exports = { createAnalyticalMemorySampler };
