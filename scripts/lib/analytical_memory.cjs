"use strict";
const fs = require("node:fs"), os = require("node:os"), v8 = require("node:v8");

// Admission estimate only. File cache and unused V8 heap are reported apart
// from live allocations; neither working-set subtraction nor RSS is a promise
// that a later allocation fits. Never reset cgroup peaks or request forced GC.
function createAnalyticalMemorySampler({ fileSystem = fs, memoryUsage = () => process.memoryUsage(),
  totalMemory = () => os.totalmem(), getHeapStatistics = () => v8.getHeapStatistics(), now = Date.now } = {}) {
  function optional(file) {
    try { return fileSystem.readFileSync(file, "utf8").trim(); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
  }
  const count = value => /^\d+$/.test(value || "") && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const positive = value => { const result = count(value); return result > 0 ? result : null; };
  const numericLines = value => Object.fromEntries(String(value || "").split("\n").flatMap(line => {
    const match = /^(\w+)\s+(\d+)$/.exec(line.trim()); return match ? [[match[1], match[2]]] : [];
  }));
  function heapPressure(heapUsed) {
    const unavailable = heapStatisticsStatus => ({ heapLimitBytes: null, heapRatio: null, heapHeadroomBytes: null, heapStatisticsStatus });
    if (typeof getHeapStatistics !== "function") return unavailable(getHeapStatistics == null ? "unavailable" : "invalid_reader");
    try {
      const statistics = getHeapStatistics();
      if (statistics == null) return unavailable("unavailable");
      const limit = statistics.heap_size_limit;
      if (!Number.isSafeInteger(limit) || limit <= 0) return unavailable("invalid");
      return { heapLimitBytes: limit, heapRatio: heapUsed / limit,
        heapHeadroomBytes: Math.max(0, limit - heapUsed), heapStatisticsStatus: "available" };
    } catch { return unavailable("reader_threw"); }
  }
  let last = null;
  function sample() {
    const usage = memoryUsage(), statText = optional("/sys/fs/cgroup/memory.stat");
    const stat = Object.fromEntries((statText || "").split("\n").filter(Boolean).map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
    const cgroupLimit = positive(optional("/sys/fs/cgroup/memory.max")) || positive(optional("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    const hostLimit = Number(totalMemory()), limit = cgroupLimit && cgroupLimit < 2 ** 60 ? Math.min(cgroupLimit, hostLimit) : hostLimit;
    if (!Number.isFinite(limit) || limit <= 0 || ![usage.rss, usage.heapUsed, usage.heapTotal, usage.external].every(value => Number.isFinite(value) && value >= 0)) throw new Error("ANALYTICAL_MEMORY_UNAVAILABLE");
    const unusedHeap = Math.max(0, usage.heapTotal - usage.heapUsed);
    const nativeResidentEstimate = Math.max(0, usage.rss - usage.heapTotal - usage.external);
    const liveEstimate = usage.heapUsed + usage.external + nativeResidentEstimate;
    const anonKernelEstimate = Number.isFinite(stat.anon) ? Math.max(0, stat.anon + (stat.kernel || 0) - unusedHeap) : 0;
    const estimatedLiveBytes = Math.max(liveEstimate, anonKernelEstimate), current = count(optional("/sys/fs/cgroup/memory.current")),
      events = optional("/sys/fs/cgroup/memory.events");
    const liveAllocationRatio = estimatedLiveBytes / limit, heap = heapPressure(usage.heapUsed);
    last = { sampledAt: Number(now()), ratio: heap.heapRatio === null ? liveAllocationRatio : Math.max(liveAllocationRatio, heap.heapRatio),
      liveAllocationRatio, ...heap,
      scope: "live-allocation-and-v8-heap-admission-estimate", limitBytes: limit, rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external, unusedHeapBytes: unusedHeap, estimatedLiveBytes: Math.max(liveEstimate, anonKernelEstimate),
      processLiveEstimateBytes: liveEstimate, nativeResidentEstimateBytes: nativeResidentEstimate, anonKernelEstimateBytes: anonKernelEstimate,
      estimatedHeadroomBytes: Math.max(0, limit - estimatedLiveBytes),
      cgroupCurrentBytes: current, cgroupCurrentRatio: current === null ? null : current / limit,
      anonBytes: stat.anon ?? null, fileBytes: stat.file ?? null, kernelBytes: stat.kernel ?? null,
      cgroupEvents: events, cgroupEventCounts: numericLines(events),
      interpretation: "Admission ratio is the maximum of estimated live allocation pressure and measured V8 heap pressure. Heap pressure excludes external/native allocations, which remain in the live estimate. An unavailable heap limit is null, not zero or a retained earlier value. Cgroup current includes file cache and is reported separately. No estimate guarantees that the next allocation fits. Event counters are cumulative, not per-task failures." };
    return { ratio: last.ratio, sampledAt: last.sampledAt };
  }
  return { sample, status: () => last ? { ...last, cgroupEventCounts: { ...last.cgroupEventCounts } } : null };
}
module.exports = { createAnalyticalMemorySampler };
