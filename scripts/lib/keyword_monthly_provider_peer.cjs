"use strict";
// Explicit current-instance provider-peer review. This never authenticates a
// provider from a process name alone and is not used for owner/child liveness.
const fs = require("node:fs/promises"), C = require("node:fs").constants, crypto = require("node:crypto");
const SERVICE = "srv-da9q6don74is738t7id0", SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = v => crypto.createHash("sha256").update(v).digest("hex"), bytes = v => Buffer.from(JSON.stringify(v));
const fault = code => Object.assign(Error(code), { code }), need = (v, code = "KEYWORD_INCREMENTAL_PROVIDER_PEER_UNVERIFIED") => { if (!v) throw fault(code); };
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = v => Number.isSafeInteger(v) && v > 0, iso = v => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function contextSha(context) { need(context && UUID.test(context.bootId || "") && /^pid:\[\d+\]$/.test(context.pidNamespace || "") && SHA.test(context.hostId || "")); return hash(bytes([context.bootId, context.pidNamespace, context.hostId])); }
async function pseudo(file, bound) { const h = await fs.open(file, C.O_RDONLY); try { const b = Buffer.alloc(bound + 1); let n = 0;
  while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; } need(n <= bound); return b.subarray(0, n).toString("utf8");
} finally { await h.close(); } }
function parsePeerMetadata({ pid, uid, stat, status, comm, exeReadCode }) {
  need(positive(pid) && Number.isSafeInteger(uid) && uid >= 0 && ["EACCES", "EPERM"].includes(exeReadCode));
  const end = stat.lastIndexOf(") "), f = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
  need(stat.startsWith(String(pid) + " (") && f.length >= 20 && !["Z", "X", "x"].includes(f[0]) && f[1] === "0" && /^\d{1,30}$/.test(f[19] || ""));
  const fields = {}; for (const line of status.split("\n")) { const m = line.match(/^([A-Za-z]+):\s*(.*)$/); if (m && ["Name", "PPid", "Uid", "Gid", "NSpid", "CapInh", "CapPrm", "CapEff", "CapAmb", "NoNewPrivs", "Seccomp"].includes(m[1])) { need(!Object.hasOwn(fields, m[1])); fields[m[1]] = m[2].trim(); } }
  const numbers = key => { need(typeof fields[key] === "string" && /^\d+(?:\s+\d+)*$/.test(fields[key])); return fields[key].split(/\s+/).map(Number); };
  const uids = numbers("Uid"), gids = numbers("Gid"), nspid = numbers("NSpid");
  need(comm === "portdetectorv2\n" && fields.Name === "portdetectorv2" && fields.PPid === "0" && uids.length === 4 && uids.every(v => v === uid)
    && gids.length === 4 && gids.every(v => Number.isSafeInteger(v) && v >= 0) && nspid.length > 0 && nspid.length <= 8 && nspid.every(positive) && nspid[nspid.length - 1] === pid
    && fields.NoNewPrivs === "1" && fields.Seccomp === "0" && ["CapInh", "CapPrm", "CapEff", "CapAmb"].every(k => /^0{1,16}$/.test(fields[k] || "")));
  const stable = { comm: "portdetectorv2", ppid: 0, uids, gids, nspid, capInh: fields.CapInh, capPrm: fields.CapPrm, capEff: fields.CapEff, capAmb: fields.CapAmb, noNewPrivs: 1, seccomp: 0 };
  return { pid, ppid: 0, uid, startTicks: f[19], comm: "portdetectorv2", exeReadCode, stableStatus: stable, metadataSha256: hash(bytes(stable)) };
}
async function readExternalPeer(pid, uid) {
  async function one() {
    need((await fs.lstat("/proc/" + pid)).uid === uid);
    let denied; try { await fs.readlink("/proc/" + pid + "/exe"); } catch (e) { denied = e.code; }
    const [stat, status, comm] = await Promise.all([pseudo("/proc/" + pid + "/stat", 8192), pseudo("/proc/" + pid + "/status", 16384), pseudo("/proc/" + pid + "/comm", 256)]);
    return parsePeerMetadata({ pid, uid, stat, status, comm, exeReadCode: denied });
  }
  const a = await one(), b = await one(); need(JSON.stringify(a) === JSON.stringify(b), "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED"); return a;
}
function createReviewedProviderPeerGuard({ proof, readContext, readServer, expectedServerPid, expectedJobId, expectedLockSha256, uid = process.getuid(), readPeer = readExternalPeer, now = Date.now }) {
  const fields = ["schemaVersion", "action", "serviceId", "targetJobId", "lockSha256", "currentContextSha256", "serverPid", "serverStartTicks", "peer", "providerEvidenceSha256", "reviewedAt"];
  need(exact(proof, fields) && proof.schemaVersion === 1 && proof.action === "reviewed_render_external_port_detector" && proof.serviceId === SERVICE
    && proof.targetJobId === expectedJobId && SHA.test(expectedJobId || "") && proof.lockSha256 === expectedLockSha256 && SHA.test(expectedLockSha256 || "")
    && SHA.test(proof.currentContextSha256 || "") && SHA.test(proof.providerEvidenceSha256 || "") && proof.serverPid === expectedServerPid && positive(expectedServerPid)
    && /^\d{1,30}$/.test(proof.serverStartTicks || "") && iso(proof.reviewedAt) && Date.parse(proof.reviewedAt) <= new Date(now()).getTime() + 5000
    && exact(proof.peer, ["pid", "ppid", "uid", "startTicks", "comm", "exeReadCode", "stableStatus", "metadataSha256"])
    && positive(proof.peer.pid) && proof.peer.pid !== expectedServerPid && proof.peer.pid !== process.pid && proof.peer.ppid === 0 && proof.peer.uid === uid
    && /^\d{1,30}$/.test(proof.peer.startTicks || "") && BigInt(proof.peer.startTicks) < BigInt(proof.serverStartTicks)
    && proof.peer.comm === "portdetectorv2" && ["EACCES", "EPERM"].includes(proof.peer.exeReadCode) && SHA.test(proof.peer.metadataSha256 || ""));
  const proofSha256 = hash(bytes(proof));
  return Object.freeze({ pid: proof.peer.pid, proofSha256, async verify() {
    need(contextSha(await readContext()) === proof.currentContextSha256, "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED");
    const server = await readServer(expectedServerPid); need(server?.pid === expectedServerPid && server.kind === "node" && server.startTicks === proof.serverStartTicks, "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED");
    const observed = await readPeer(proof.peer.pid, uid); need(JSON.stringify(observed) === JSON.stringify(proof.peer), "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED");
    need(contextSha(await readContext()) === proof.currentContextSha256, "KEYWORD_INCREMENTAL_PROVIDER_PEER_CHANGED"); return { proofSha256 };
  } });
}
async function inspectProviderPeerCandidates({ readContext, readServer, serverPid, uid = process.getuid() }) {
  const context = contextSha(await readContext()), server = await readServer(serverPid); need(server?.pid === serverPid && server.kind === "node" && /^\d+$/.test(server.startTicks || ""));
  const entries = await fs.readdir("/proc", { withFileTypes: true }); need(entries.length <= 8192); const unreadable = [];
  for (const e of entries) if (/^\d+$/.test(e.name)) { const pid = Number(e.name); let stat; try { stat = await fs.lstat("/proc/" + pid); } catch (x) { if (x.code === "ENOENT") continue; throw x; }
    if (stat.uid !== uid) continue; try { await fs.readlink("/proc/" + pid + "/exe"); } catch (x) { if (["ENOENT", "ESRCH"].includes(x.code)) continue; need(["EACCES", "EPERM"].includes(x.code)); unreadable.push(await readExternalPeer(pid, uid)); }
  }
  need(unreadable.length === 1 && BigInt(unreadable[0].startTicks) < BigInt(server.startTicks) && contextSha(await readContext()) === context);
  return { schemaVersion: 1, status: "provider_review_required", currentContextSha256: context, serverPid, serverStartTicks: server.startTicks, peer: unreadable[0], providerAuthenticated: false, changed: false };
}
async function reviewedPeerReadFailure(guard, pid, code) {
  if (!guard || pid !== guard.pid || !["EACCES", "EPERM"].includes(code)) return false;
  await guard.verify(); return true;
}
module.exports = { parsePeerMetadata, readExternalPeer, createReviewedProviderPeerGuard, inspectProviderPeerCandidates, reviewedPeerReadFailure, providerContextSha: contextSha };
