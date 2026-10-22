"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalMemorySampler } = require("./lib/analytical_memory.cjs");
const mib = 1024 ** 2;
function fixture(files = {}, usage = {}) {
  return createAnalyticalMemorySampler({ now: () => 1234, totalMemory: () => 16 * 1024 * mib,
    fileSystem: { readFileSync(file) { if (!(file in files)) throw Object.assign(new Error(), { code: "ENOENT" }); return files[file]; } },
    memoryUsage: () => ({ rss: 900 * mib, heapTotal: 800 * mib, heapUsed: 400 * mib, external: 50 * mib, ...usage }) });
}
test("page cache and unused V8 space are reported separately from admission pressure", () => {
  const s = fixture({ "/sys/fs/cgroup/memory.max": String(2048 * mib), "/sys/fs/cgroup/memory.current": String(2048 * mib),
    "/sys/fs/cgroup/memory.stat": `anon ${900 * mib}\nfile ${1100 * mib}\nkernel ${48 * mib}\n`, "/sys/fs/cgroup/memory.events": "max 561\noom 0\noom_kill 0" });
  assert.deepEqual(s.sample(), { ratio: 548 / 2048, sampledAt: 1234 });
  assert.equal(s.status().cgroupCurrentBytes, 2048 * mib);
  assert.equal(s.status().fileBytes, 1100 * mib);
  assert.equal(s.status().unusedHeapBytes, 400 * mib);
  assert.match(s.status().scope, /estimate/);
});
test("live external/native allocations remain pressure; array buffers are not counted twice", () => {
  const s = fixture({ "/sys/fs/cgroup/memory.max": String(2048 * mib) }, { rss: 1600 * mib, heapTotal: 800 * mib, heapUsed: 700 * mib, external: 400 * mib, arrayBuffers: 350 * mib });
  assert.equal(s.sample().ratio, 1500 / 2048);
});
test("unlimited and absent cgroups use host capacity; permission and invalid memory fail explicitly", () => {
  assert.equal(fixture({ "/sys/fs/cgroup/memory.max": "max" }).sample().ratio, 500 / 16384);
  assert.equal(fixture().status(), null);
  assert.throws(() => fixture({}, { heapUsed: NaN }).sample(), /UNAVAILABLE/);
  const s = createAnalyticalMemorySampler({ fileSystem: { readFileSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
  assert.throws(() => s.sample(), /denied/);
});

test("cached diagnostics expose admission components separately without another source read", () => {
  const files = { "/sys/fs/cgroup/memory.max": String(2048 * mib), "/sys/fs/cgroup/memory.current": String(2048 * mib),
    "/sys/fs/cgroup/memory.stat": `anon ${900 * mib}\nfile ${1100 * mib}\nkernel ${48 * mib}\n`,
    "/sys/fs/cgroup/memory.events": "max 561\noom 0\noom_kill 0\n" };
  let reads = 0;
  const sampler = createAnalyticalMemorySampler({ now: () => 1234, totalMemory: () => 16 * 1024 * mib,
    fileSystem: { readFileSync(file) { reads++; if (!(file in files)) throw Object.assign(Error(), { code: "ENOENT" }); return files[file]; } },
    memoryUsage: () => ({ rss: 900 * mib, heapTotal: 800 * mib, heapUsed: 400 * mib, external: 50 * mib }) });
  sampler.sample(); const afterSample = reads, status = sampler.status();
  assert.equal(status.processLiveEstimateBytes, 500 * mib);
  assert.equal(status.nativeResidentEstimateBytes, 50 * mib);
  assert.equal(status.anonKernelEstimateBytes, 548 * mib);
  assert.equal(status.estimatedLiveBytes, 548 * mib); assert.equal(status.estimatedHeadroomBytes, 1500 * mib);
  assert.equal(status.heapTotalBytes, 800 * mib); assert.equal(status.cgroupCurrentRatio, 1);
  assert.deepEqual(status.cgroupEventCounts, { max: "561", oom: "0", oom_kill: "0" });
  status.cgroupEventCounts.max = "changed";
  assert.equal(sampler.status().cgroupEventCounts.max, "561"); assert.equal(reads, afterSample);
  assert.match(status.interpretation, /cumulative/);
});

test("diagnostics distinguish measured zero current memory from an unavailable reading", () => {
  const measured = fixture({ "/sys/fs/cgroup/memory.max": String(2048 * mib), "/sys/fs/cgroup/memory.current": "0" });
  measured.sample(); assert.equal(measured.status().cgroupCurrentBytes, 0); assert.equal(measured.status().cgroupCurrentRatio, 0);
  const unavailable = fixture(); unavailable.sample();
  assert.equal(unavailable.status().cgroupCurrentBytes, null); assert.equal(unavailable.status().cgroupCurrentRatio, null);
  assert.deepEqual(unavailable.status().cgroupEventCounts, {});
});
