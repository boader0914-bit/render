"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), P = require("./lib/keyword_monthly_provider_peer.cjs");
const NOW = "2026-11-15T15:00:00.000Z", context = { bootId: "11111111-1111-4111-8111-111111111111", pidNamespace: "pid:[123]", hostId: "a".repeat(64) };
function raw(change = {}) { return { pid: 38, uid: 1000, stat: "38 (portdetectorv2) S 0 " + Array(17).fill("0").join(" ") + " 100 0", comm: "portdetectorv2\n", exeReadCode: "EACCES",
  status: "Name:\tportdetectorv2\nPPid:\t0\nUid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nNSpid:\t38\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t0\nVmRSS:\t100 kB\nThreads:\t1\n", ...change }; }
function fixture() {
  let current = { ...context }, observed = P.parsePeerMetadata(raw()), server = { pid: 85, kind: "node", startTicks: "200" };
  const proof = { schemaVersion: 1, action: "reviewed_render_external_port_detector", serviceId: "srv-da9q6don74is738t7id0", targetJobId: "b".repeat(64), lockSha256: "c".repeat(64),
    currentContextSha256: P.providerContextSha(context), serverPid: 85, serverStartTicks: "200", peer: observed, providerEvidenceSha256: "d".repeat(64), reviewedAt: NOW };
  const options = { proof, readContext: async () => current, readServer: async () => server, expectedServerPid: 85, expectedJobId: "b".repeat(64), expectedLockSha256: "c".repeat(64), uid: 1000, now: () => NOW,
    readPeer: async (pid, uid) => { assert.equal(pid, 38); assert.equal(uid, 1000); return observed; } };
  return { proof, options, setContext: v => { current = v; }, setObserved: v => { observed = v; }, setServer: v => { server = v; } };
}
test("selected stable kernel metadata excludes dynamic memory and thread counters", () => {
  const a = P.parsePeerMetadata(raw()), b = P.parsePeerMetadata(raw({ status: raw().status.replace("100 kB", "999999 kB").replace("Threads:\t1", "Threads:\t9") }));
  assert.deepEqual(a, b); assert.equal(a.ppid, 0); assert.equal(a.startTicks, "100"); assert.equal(a.stableStatus.uids.length, 4); assert.equal(JSON.stringify(a).includes("VmRSS"), false);
});
for (const [name, change] of [
  ["local parent", v => ({ ...v, stat: v.stat.replace(") S 0 ", ") S 85 "), status: v.status.replace("PPid:\t0", "PPid:\t85") })],
  ["one differing uid", v => ({ ...v, status: v.status.replace("1000 1000 1000 1000\nGid", "1000 1000 0 1000\nGid") })],
  ["effective capability", v => ({ ...v, status: v.status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001") })],
  ["permitted capability", v => ({ ...v, status: v.status.replace("CapPrm:\t0000000000000000", "CapPrm:\t0000000000000001") })],
  ["inherited capability", v => ({ ...v, status: v.status.replace("CapInh:\t0000000000000000", "CapInh:\t0000000000000001") })],
  ["ambient capability", v => ({ ...v, status: v.status.replace("CapAmb:\t0000000000000000", "CapAmb:\t0000000000000001") })],
  ["new privileges", v => ({ ...v, status: v.status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0") })],
  ["changed seccomp profile", v => ({ ...v, status: v.status.replace("Seccomp:\t0", "Seccomp:\t2") })],
  ["wrong name", v => ({ ...v, comm: "node\n" })], ["readable exe", v => ({ ...v, exeReadCode: null })],
  ["different denial", v => ({ ...v, exeReadCode: "ENOENT" })]
]) test(`${name} is never a provider helper exception`, () => assert.throws(() => P.parsePeerMetadata(change(raw())), { code: "KEYWORD_INCREMENTAL_PROVIDER_PEER_UNVERIFIED" }));
test("exact operator proof permits only one denied peer while preserving unknown peers", async () => {
  const f = fixture(), guard = P.createReviewedProviderPeerGuard(f.options); await guard.verify();
  assert.equal(await P.reviewedPeerReadFailure(guard, 38, "EACCES"), true); assert.equal(await P.reviewedPeerReadFailure(guard, 38, "EPERM"), true);
  assert.equal(await P.reviewedPeerReadFailure(guard, 39, "EACCES"), false, "a newly unreadable peer must still hit the caller's hold");
  assert.equal(await P.reviewedPeerReadFailure(guard, 38, "ENOENT"), false); assert.equal(await P.reviewedPeerReadFailure(null, 38, "EACCES"), false);
});
for (const [name, change] of [
  ["missing provider evidence", p => { p.providerEvidenceSha256 = null; }], ["wrong context scope", p => { p.serviceId = "srv-other"; }],
  ["wrong job", p => { p.targetJobId = "e".repeat(64); }], ["wrong lock", p => { p.lockSha256 = "e".repeat(64); }],
  ["born after web", p => { p.peer = { ...p.peer, startTicks: "201" }; }], ["same web birth", p => { p.peer = { ...p.peer, startTicks: "200" }; }],
  ["extra wildcard", p => { p.ignoreAllUnknown = true; }]
]) test(`${name} cannot create a reviewed exception`, () => { const f = fixture(); change(f.proof); assert.throws(() => P.createReviewedProviderPeerGuard(f.options), { code: "KEYWORD_INCREMENTAL_PROVIDER_PEER_UNVERIFIED" }); });
for (const [name, change] of [
  ["PID reuse", f => f.setObserved({ ...f.proof.peer, startTicks: "101" })], ["parent changed", f => f.setObserved({ ...f.proof.peer, ppid: 85 })],
  ["stable status changed", f => f.setObserved({ ...f.proof.peer, metadataSha256: "f".repeat(64) })], ["instance changed", f => f.setContext({ ...context, hostId: "f".repeat(64) })],
  ["web restarted", f => f.setServer({ pid: 85, kind: "node", startTicks: "201" })]
]) test(`${name} invalidates an already reviewed peer`, async () => { const f = fixture(), guard = P.createReviewedProviderPeerGuard(f.options); await guard.verify(); change(f); await assert.rejects(guard.verify(), { code: "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED" }); });
