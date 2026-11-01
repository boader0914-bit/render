"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createSearchDemandActivation, SCHEDULE_VERSION } = require("./lib/search_demand_activation.cjs");
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-activation-")), rootDir = path.join(parent, "demand");
  t.after(async () => { assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(parent, { recursive: true, force: true }); });
  const state = { now: "2026-11-01T11:00:00.000Z" }, file = path.join(rootDir, "activation.json");
  const policy = { enabled: true, approvedAt: "2026-11-01T10:00:00.000Z", notBeforeDay: "2026-11-02", scheduleVersion: SCHEDULE_VERSION };
  const reader = createSearchDemandActivation({ rootDir, clock: () => new Date(state.now) });
  const write = async value => { await fs.mkdir(rootDir, { recursive: true }); await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
  return { parent, rootDir, file, state, policy, reader, write };
}
test("missing policy does not create a directory or activate late same-day catchup", async t => {
  const f = await fixture(t), result = await f.reader.read();
  assert.equal(result.enabled, false); assert.equal(result.reasonCode, "SEARCH_DEMAND_ACTIVATION_MISSING");
  await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
});
test("approved start day is KST aligned and the reader never rewrites the policy", async t => {
  const f = await fixture(t); await f.write(f.policy); const before = await fs.readFile(f.file), stat = await fs.stat(f.file);
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_NOT_BEFORE_DAY");
  f.state.now = "2026-11-01T14:59:59.999Z"; assert.equal((await f.reader.read()).enabled, false);
  f.state.now = "2026-11-01T15:00:00.000Z"; const result = await f.reader.read(); assert.equal(result.enabled, true);
  assert.equal(result.notBeforeDay, "2026-11-02"); assert.equal(result.scheduleVersion, SCHEDULE_VERSION);
  assert.deepEqual(await fs.readFile(f.file), before); assert.equal((await fs.stat(f.file)).mtimeMs, stat.mtimeMs);
});
test("explicit disable takes precedence after the approved day", async t => {
  const f = await fixture(t); f.state.now = "2026-11-02T01:00:00.000Z"; await f.write({ ...f.policy, enabled: false });
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_DISABLED");
});
test("malformed, extra, absent, secret-like or incompatible fields fail closed", async t => {
  const f = await fixture(t);
  for (const value of ["{", [], { ...f.policy, key: "not-returned" }, { ...f.policy, enabled: "true" }, { ...f.policy, scheduleVersion: "other-v1" },
    { ...f.policy, notBeforeDay: "2026-11-31" }, { ...f.policy, notBeforeDay: "2026-10-31" }, { ...f.policy, approvedAt: "2026-11-01T12:00:00.000Z" },
    { ...f.policy, approvedAt: "2026-11-01T10:00:00Z" }, { enabled: true }]) {
    await f.write(value); const result = await f.reader.read(); assert.equal(result.enabled, false); assert.equal(result.status, "unavailable");
    assert.equal(JSON.stringify(result).includes("not-returned"), false); assert.equal(result.approvedAt, null);
  }
});
test("oversized and hard-linked payloads fail before reading a policy body", async t => {
  const f = await fixture(t); await f.write(" ".repeat(4097)); assert.equal((await f.reader.read()).enabled, false);
  await f.write(f.policy); await fs.link(f.file, path.join(f.parent, "other-policy.json"));
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_FILE_UNSAFE");
});
test("linked parents are rejected before opening an outside payload", async t => {
  const f = await fixture(t), outside = path.join(f.parent, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "activation.json"), JSON.stringify(f.policy));
  try { await fs.symlink(outside, f.rootDir, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) return t.skip("directory link creation unavailable"); throw error; }
  let opened = 0; const open = fs.open; t.mock.method(fs, "open", (...args) => { opened++; return open(...args); });
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_PATH_UNSAFE"); assert.equal(opened, 0);
});
test("parent identity changes during a read are not approved", async t => {
  const f = await fixture(t); await f.write(f.policy); const stat = fs.lstat; let seen = 0;
  t.mock.method(fs, "lstat", async function (file, ...args) {
    const value = await stat(file, ...args);
    if (String(file) === f.rootDir && ++seen >= 2) return new Proxy(value, { get(target, key) { return key === "ino" ? -1n : Reflect.get(target, key); } });
    return value;
  });
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_EVIDENCE_CHANGED");
});
test("payload inode changes during the bounded read are not approved", async t => {
  const f = await fixture(t); await f.write(f.policy); const stat = fs.lstat; let seen = 0;
  t.mock.method(fs, "lstat", async function (file, ...args) {
    const value = await stat(file, ...args);
    if (String(file) === f.file && ++seen >= 2) return new Proxy(value, { get(target, key) { return key === "ino" ? -1n : Reflect.get(target, key); } });
    return value;
  });
  assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_EVIDENCE_CHANGED");
});
test("invalid clock and relative root are never accepted", async t => {
  const f = await fixture(t); assert.throws(() => createSearchDemandActivation({ rootDir: "relative" }), TypeError);
  f.state.now = "invalid"; assert.equal((await f.reader.read()).reasonCode, "SEARCH_DEMAND_ACTIVATION_CLOCK_UNAVAILABLE");
});
