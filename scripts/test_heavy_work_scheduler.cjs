"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { AsyncLocalStorage } = require("node:async_hooks");
const vm = require("node:vm");
const { createHeavyWorkScheduler, readHeavyWorkMemory } = require("./lib/heavy_work_scheduler.cjs");
const MiB = 1024 * 1024;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const memory = (rss = 100 * MiB, anon = 120 * MiB, file = 100 * MiB) => ({ rssBytes: rss, heapUsedBytes: rss / 2, externalBytes: 0, arrayBufferBytes: 0,
  cgroup: { currentBytes: anon + file, limitBytes: 2048 * MiB, anonBytes: anon, fileBytes: file, shmemBytes: 0, kernelBytes: 0, reclaimableFileBytes: file, nonFileBytes: anon } });
const scheduler = options => createHeavyWorkScheduler({ memoryProbe: async () => memory(), pollIntervalMs: 5, maxWaitMs: 2000, ...options });
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); } assert.fail("condition did not become true"); }

test("one heavy slot queues independent callers, retains foreground priority, and releases after failure", async () => {
  const work = scheduler(), held = gate(), started = gate(), order = []; let concurrent = 0, peak = 0;
  const action = name => async () => { peak = Math.max(peak, ++concurrent); order.push(name); await turn(); concurrent--; return name; };
  const first = work.run(async () => { concurrent++; peak = Math.max(peak, concurrent); started.resolve(); await held.promise; concurrent--; throw Object.assign(new Error("safe failure"), { code: "TEST_FAILURE" }); }, { label: "first" });
  const failure = assert.rejects(first, { code: "TEST_FAILURE" }); await started.promise;
  const back = work.run(action("background"), { label: "background", priority: "background" });
  const front = work.run(action("foreground"), { label: "foreground" });
  assert.equal(work.status().queued, 2); assert.equal(work.status().active.phase, "running");
  held.resolve(); await failure; await Promise.all([back, front]);
  assert.deepEqual(order, ["foreground", "background"]); assert.equal(peak, 1);
  assert.equal(work.status().counts.failed, 1); assert.equal(work.status().counts.completed, 2); assert.equal(work.status().active, null);
});

test("recursive nested awaits do not deadlock and sibling heavy calls remain serial", async () => {
  const work = scheduler(), order = []; let inflight = 0, peak = 0;
  const result = await work.run(async () => Promise.all([1, 2, 3].map(index => work.run(async () => {
    peak = Math.max(peak, ++inflight); order.push(index);
    const nested = await work.run(async () => index * 10, { label: "deep" }); await turn(); inflight--; return nested;
  }, { label: "sibling" }))), { label: "outer" });
  assert.deepEqual(result, [10, 20, 30]); assert.deepEqual(order, [1, 2, 3]); assert.equal(peak, 1);
  assert.equal(work.status().counts.nested, 6); assert.equal(work.status().counts.completed, 1);
});

test("a larger nested reservation checks fresh memory once and rejects promptly instead of waiting on its owner's heap", async () => {
  let changed = false, calls = 0;
  const work = scheduler({ maxWaitMs: 1000, memoryProbe: async () => { calls++; return memory((changed ? 700 : 100) * MiB); } });
  await work.run(async () => {
    changed = true;
    await assert.rejects(work.run(async () => assert.fail("larger denied reservation must not run"), { estimatedBytes: 512 * MiB }), { code: "HEAVY_WORK_MEMORY_BUSY" });
    changed = false;
    assert.equal(await work.run(async () => 7, { estimatedBytes: 512 * MiB }), 7);
  }, { estimatedBytes: 128 * MiB });
  assert.equal(work.status().counts.nestedRejected, 1); assert.ok(calls < 10, "no nested polling loop");
});

test("queued and nested actions retain their own request ALS even when another caller owns the drain loop", async () => {
  const requests = new AsyncLocalStorage(), work = scheduler(), held = gate(), started = gate(), seen = [];
  const first = requests.run({ request: "first", reads: 0 }, () => work.run(async () => {
    started.resolve(); await held.promise; assert.equal(requests.getStore().request, "first");
  })); await started.promise;
  const second = requests.run({ request: "second", reads: 0 }, () => work.run(async () => {
    const own = requests.getStore(); own.reads++; seen.push(own.request);
    await work.run(async () => { assert.equal(requests.getStore(), own); requests.getStore().reads++; }, { label: "request-nested" });
    return own.reads;
  }));
  const third = requests.run({ request: "third", reads: 0 }, () => work.run(async () => { seen.push(requests.getStore().request); return requests.getStore().reads; }));
  held.resolve(); await first; assert.equal(await second, 2); assert.equal(await third, 0); assert.deepEqual(seen, ["second", "third"]);
});

test("a nested sibling waits for its preceding branch's detached grandchildren", async () => {
  const work = scheduler(), grandchild = gate(), started = gate(), order = [];
  const pending = work.run(async () => {
    const a = work.run(async () => {
      void work.run(async () => { started.resolve(); await grandchild.promise; order.push("grandchild"); }, { label: "grandchild" });
      return "branch-returned";
    }, { label: "branch" });
    const b = work.run(async () => { order.push("sibling"); }, { label: "sibling" });
    await Promise.all([a, b]);
  });
  await started.promise; await turn(); assert.deepEqual(order, []); grandchild.resolve(); await pending;
  assert.deepEqual(order, ["grandchild", "sibling"]);
});

test("a callback from a finished nested branch cannot reuse the owner while its sibling is running", async () => {
  const work = scheduler(), trigger = gate(), sibling = gate(), started = gate(), order = []; let delayed;
  const pending = work.run(async () => {
    await work.run(async () => { delayed = trigger.promise.then(() => work.run(async () => { order.push("delayed"); })); });
    await work.run(async () => { started.resolve(); await sibling.promise; order.push("sibling"); });
  });
  await started.promise; trigger.resolve(); await turn(); assert.deepEqual(order, []);
  assert.equal(work.status().queued, 1); sibling.resolve(); await Promise.all([pending, delayed]);
  assert.deepEqual(order, ["sibling", "delayed"]);
});

test("detached nested preparation retains ownership and stale async context cannot bypass a later owner", async () => {
  const work = scheduler(), child = gate(), childStarted = gate(), staleTrigger = gate(), other = gate(), otherStarted = gate(), order = [];
  let stalePending;
  const first = work.run(async () => {
    void work.run(async () => { childStarted.resolve(); await child.promise; order.push("child"); }, { label: "detached-child" });
    stalePending = staleTrigger.promise.then(() => work.run(async () => { order.push("stale"); }, { label: "stale-context" }));
    return "parent";
  }, { label: "parent" });
  await childStarted.promise;
  let finished = false; first.then(() => { finished = true; });
  const second = work.run(async () => { otherStarted.resolve(); await other.promise; order.push("other"); }, { label: "other" });
  await turn(); assert.equal(finished, false); assert.equal(work.status().queued, 1);
  child.resolve(); assert.equal(await first, "parent"); await otherStarted.promise;
  staleTrigger.resolve(); await turn(); assert.equal(work.status().queued, 1);
  other.resolve(); await Promise.all([second, stalePending]); assert.deepEqual(order, ["child", "other", "stale"]);
});

test("anonymous pressure is a truthful memory wait, times out safely, and can recover without restarting", async () => {
  let allowed = false, calls = 0;
  const work = scheduler({ memoryProbe: async () => memory(allowed ? 100 * MiB : 1000 * MiB), maxWaitMs: 45 });
  const pending = work.run(async () => { calls++; }, { label: "memory" });
  const rejected = assert.rejects(pending, { code: "HEAVY_WORK_MEMORY_BUSY" });
  await until(() => work.status().active?.phase === "waiting-memory");
  assert.equal(work.status().active.waitReason, "application_rss"); await rejected; assert.equal(calls, 0);
  allowed = true; await work.run(async () => { calls++; }, { label: "recovered" }); assert.equal(calls, 1);
});

test("a busy slot and queue capacity are reported separately from actual memory denial", async () => {
  const work = scheduler({ maxWaitMs: 35, maxQueued: 1 }), held = gate(), started = gate();
  const first = work.run(async () => { started.resolve(); await held.promise; }); await started.promise;
  const queued = work.run(async () => assert.fail("expired work must not start"));
  const slotRejected = assert.rejects(queued, { code: "HEAVY_WORK_SLOT_BUSY" });
  await assert.rejects(work.run(async () => {}), { code: "HEAVY_WORK_QUEUE_FULL" });
  await slotRejected; held.resolve(); await first; assert.equal(work.status().queued, 0);
  const pressure = scheduler({ maxWaitMs: 30, memoryProbe: async () => memory(100 * MiB, 1900 * MiB, 0) });
  await assert.rejects(pressure.run(async () => assert.fail("container pressure must wait")), { code: "HEAVY_WORK_MEMORY_BUSY" });
  assert.equal(pressure.status().memory.cgroup.anonBytes, 1900 * MiB);
});

test("file-cache accounting stays separate from anonymous memory and limits/status are explicit", async () => {
  const work = scheduler({ memoryProbe: async () => memory(100 * MiB, 100 * MiB, 1800 * MiB) });
  await work.run(async () => 1, { label: "a private customer name / must be bounded" });
  const state = work.status();
  assert.equal(state.memory.cgroup.anonBytes, 100 * MiB); assert.equal(state.memory.cgroup.fileBytes, 1800 * MiB);
  assert.equal(state.limits.memoryBudgetBytes, 2048 * MiB); assert.equal(state.limits.maxAppRssBytes, 1024 * MiB);
  assert.equal(state.limits.slots, 1); assert.equal(state.limits.admissionIsEstimate, true);
  assert.match(state.instanceId, /^[a-f0-9]{24}$/); assert.equal(state.pid, process.pid);
  assert.ok(state.recent[0].waitMs >= 0); assert.ok(state.recent[0].elapsedMs >= 0);
  const actual = await readHeavyWorkMemory(); assert.ok(actual.rssBytes > 0); assert.ok(Object.hasOwn(actual.cgroup, "fileBytes"));
});

test("final memory sample contributes to sampled peaks even for work shorter than the timer interval", async () => {
  let after = false;
  const work = scheduler({ memoryProbe: async () => memory((after ? 128 : 64) * MiB, (after ? 160 : 80) * MiB, (after ? 256 : 128) * MiB) });
  await work.run(async () => { after = true; });
  const row = work.status().recent[0]; assert.equal(row.sampledPeakRssBytes, 128 * MiB);
  assert.equal(row.sampledPeakAnonBytes, 160 * MiB); assert.equal(row.sampledPeakFileBytes, 256 * MiB);
});

test("optional cooperating-process lease serializes separate scheduler instances without guessing from lock age", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "heavy-work-lease-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const first = scheduler({ dataDir, crossProcessLease: true }), second = scheduler({ dataDir, crossProcessLease: true });
  const release = gate(), started = gate(), order = [];
  const a = first.run(async () => { started.resolve(); await release.promise; order.push("first"); }); await started.promise;
  const b = second.run(async () => { order.push("second"); });
  await until(() => second.status().active?.waitReason === "cooperating_process"); release.resolve(); await Promise.all([a, b]);
  assert.deepEqual(order, ["first", "second"]);
  const filename = path.join(dataDir, "operations/heavy_work/active.json");
  await assert.rejects(fs.stat(filename), { code: "ENOENT" });
  await fs.writeFile(filename, JSON.stringify({ pid: 123, bootId: "unknown-host", processStart: "unknown", token: "do-not-delete" }));
  const blocked = scheduler({ dataDir, crossProcessLease: true, maxWaitMs: 35 });
  await assert.rejects(blocked.run(async () => assert.fail("unknown lease must hold")), { code: "HEAVY_WORK_LEASE_BUSY" });
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).token, "do-not-delete");
});

test("lease recovery treats only ENOENT or a valid reused PID as dead; denied, malformed, and other failed process reads stay held", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "heavy-work-proc-proof-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const filename = path.join(dataDir, "operations/heavy_work/active.json"), boot = "11111111-1111-1111-1111-111111111111", targetPid = process.pid + 100000;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const source = await fs.readFile(path.join(__dirname, "lib/heavy_work_scheduler.cjs"), "utf8");
  const proc = (pid, start) => pid + " (fixture) " + ["S", ...Array(18).fill("0"), start].join(" ");
  for (const mode of ["EACCES", "EIO", "malformed", "ENOENT", "reused"]) {
    await fs.writeFile(filename, JSON.stringify({ version: 1, pid: targetPid, bootId: boot, processStart: "100", token: "preserve-unproven" }));
    const fileSystem = Object.create(fs);
    fileSystem.readFile = async (file, ...args) => {
      if (file === "/proc/sys/kernel/random/boot_id") return boot;
      if (file === "/proc/" + process.pid + "/stat") return proc(process.pid, "777");
      if (file === "/proc/" + targetPid + "/stat") {
        if (mode === "reused") return proc(targetPid, "999");
        if (mode === "malformed") return proc(targetPid, "not-a-valid-process-start");
        throw Object.assign(new Error("process inspection unavailable"), { code: mode });
      }
      return fs.readFile(file, ...args);
    };
    const module = { exports: {} };
    vm.runInNewContext("(function(require,module,exports){" + source + "\n})", { process, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Buffer })(
      id => id === "node:fs/promises" ? fileSystem : require(id), module, module.exports);
    const work = module.exports.createHeavyWorkScheduler({ dataDir, crossProcessLease: true, memoryProbe: async () => memory(), maxWaitMs: 30, pollIntervalMs: 3 });
    if (["ENOENT", "reused"].includes(mode)) { await work.run(async () => 1); await assert.rejects(fs.stat(filename), { code: "ENOENT" }); }
    else { await assert.rejects(work.run(async () => assert.fail("unproven process must stay held")), { code: "HEAVY_WORK_LEASE_BUSY" }); assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).token, "preserve-unproven"); }
  }
});
