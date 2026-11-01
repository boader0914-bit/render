"use strict";

// This reader has no writer, environment lookup, provider or application import.
// Its only payload is the explicitly approved search-demand activation policy.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const SCHEDULE_VERSION = "search-demand-schedule-v1";
const MAX_BYTES = 4096;
const FIELDS = ["enabled", "approvedAt", "notBeforeDay", "scheduleVersion"];
const problem = suffix => Object.assign(new Error("검색 수요 승인 정책을 확인해 주세요."), { code: "SEARCH_DEMAND_ACTIVATION_" + suffix });
const fingerprint = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const identity = stat => [stat.dev, stat.ino, stat.mode].map(String).join(":");
const validDay = value => typeof value === "string" && /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)
  && new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;
const validIso = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const kstDay = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);

function createSearchDemandActivation({ rootDir, clock = Date.now } = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir) || typeof clock !== "function") throw new TypeError("Absolute search demand root and clock required");
  const root = path.resolve(rootDir), file = path.join(root, "activation.json");
  async function parentsBefore(entries) {
    const parent = path.dirname(file), parsed = path.parse(parent); let current = parsed.root;
    for (const part of ["", ...parent.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current, { bigint: true }), real = await fs.realpath(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || real !== path.resolve(current)) throw problem("PATH_UNSAFE");
      entries.push({ file: current, identity: identity(stat), real });
    }
  }
  async function parentsAfter(entries) {
    for (const entry of entries) {
      let stat, real;
      try { stat = await fs.lstat(entry.file, { bigint: true }); real = await fs.realpath(entry.file); }
      catch { throw problem("EVIDENCE_CHANGED"); }
      if (!stat.isDirectory() || stat.isSymbolicLink() || real !== path.resolve(entry.file)) throw problem("PATH_UNSAFE");
      if (identity(stat) !== entry.identity || real !== entry.real) throw problem("EVIDENCE_CHANGED");
    }
  }
  async function read() {
    let observedAt = null, handle; const parents = [];
    const unavailable = reasonCode => ({ enabled: false, status: reasonCode === "SEARCH_DEMAND_ACTIVATION_MISSING" ? "missing" : "unavailable",
      reasonCode, observedAt, approvedAt: null, notBeforeDay: null, scheduleVersion: null });
    try {
      const value = new Date(clock());
      if (!Number.isFinite(value.getTime())) return unavailable("SEARCH_DEMAND_ACTIVATION_CLOCK_UNAVAILABLE");
      observedAt = value.toISOString();
      await parentsBefore(parents);
      const before = await fs.lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES) || await fs.realpath(file) !== file) throw problem("FILE_UNSAFE");
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))) throw problem("EVIDENCE_CHANGED");
      const bytes = Buffer.alloc(MAX_BYTES + 1); let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count > MAX_BYTES || BigInt(count) !== before.size || fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))
        || fingerprint(before) !== fingerprint(await fs.lstat(file, { bigint: true }))) throw problem("EVIDENCE_CHANGED");
      await parentsAfter(parents);
      let policy;
      try { policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))); }
      catch { throw problem("INVALID"); }
      if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).length !== FIELDS.length
        || Object.keys(policy).some(key => !FIELDS.includes(key)) || typeof policy.enabled !== "boolean" || !validIso(policy.approvedAt)
        || !validDay(policy.notBeforeDay) || policy.scheduleVersion !== SCHEDULE_VERSION || policy.notBeforeDay < kstDay(policy.approvedAt)) throw problem("INVALID");
      if (Date.parse(policy.approvedAt) > Date.parse(observedAt)) throw problem("APPROVAL_IN_FUTURE");
      const enabled = policy.enabled && kstDay(observedAt) >= policy.notBeforeDay;
      return { enabled, status: !policy.enabled ? "disabled" : enabled ? "ready" : "waiting",
        reasonCode: !policy.enabled ? "SEARCH_DEMAND_ACTIVATION_DISABLED" : enabled ? "SEARCH_DEMAND_ACTIVATION_APPROVED" : "SEARCH_DEMAND_ACTIVATION_NOT_BEFORE_DAY",
        observedAt, approvedAt: policy.approvedAt, notBeforeDay: policy.notBeforeDay, scheduleVersion: policy.scheduleVersion };
    } catch (error) {
      if (error.code === "ENOENT") {
        try { await parentsAfter(parents); } catch { return unavailable("SEARCH_DEMAND_ACTIVATION_EVIDENCE_CHANGED"); }
        return unavailable("SEARCH_DEMAND_ACTIVATION_MISSING");
      }
      return unavailable(/^SEARCH_DEMAND_ACTIVATION_[A-Z_]{1,70}$/.test(error.code || "") ? error.code : "SEARCH_DEMAND_ACTIVATION_UNAVAILABLE");
    } finally { await handle?.close().catch(() => {}); }
  }
  return { read };
}

module.exports = { createSearchDemandActivation, SCHEDULE_VERSION, MAX_BYTES };
