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
