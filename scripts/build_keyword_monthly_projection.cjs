"use strict";
// Explicit offline preparation. This command never imports the application,
// collector, source catalog, queue, provider or regional/KOSIS services.
const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const { buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
function stamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}
function validDay(value) { return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function args(values) {
  const allowed = new Set(["source", "output", "now", "data-through", "copied-at", "provenance", "compression"]), result = {};
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.replace(/^--/, "");
    if (!values[i]?.startsWith("--") || !allowed.has(key) || !values[i + 1] || Object.hasOwn(result, key)) throw Error("KEYWORD_MONTHLY_CLI_ARGUMENTS");
    result[key] = values[i + 1];
  }
  if (!result.source || !result.output) throw Error("KEYWORD_MONTHLY_CLI_SOURCE_AND_OUTPUT_REQUIRED");
  if (result.compression && !["auto", "gzip"].includes(result.compression)) throw Error("KEYWORD_MONTHLY_CLI_ARGUMENTS");
  for (const key of ["now", "data-through", "copied-at"]) if (result[key] && !stamp(result[key])) throw Error("KEYWORD_MONTHLY_CLI_CLOCK");
  return result;
}
function samePath(a, b) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function contains(directory, file) {
  const parent = process.platform === "win32" ? directory.toLowerCase() : directory;
  const candidate = process.platform === "win32" ? file.toLowerCase() : file;
  return candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
async function checkPath(resolved) {
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || current !== resolved && !stat.isDirectory()) throw Error("KEYWORD_MONTHLY_CLI_UNSAFE_INPUT");
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.nlink !== 1 || !samePath(await fs.realpath(resolved), resolved)) throw Error("KEYWORD_MONTHLY_CLI_UNSAFE_INPUT");
  return stat;
}
async function safeInput(file, maximum = MAX_INPUT_BYTES) {
  const resolved = path.resolve(file), before = await checkPath(resolved);
  if (before.size <= 0 || before.size > maximum) throw Error("KEYWORD_MONTHLY_CLI_INPUT_BOUND");
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const same = (a, b) => ["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
  let bytes;
  try {
    if (!same(before, await handle.stat())) throw Error("KEYWORD_MONTHLY_CLI_SOURCE_CHANGED");
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    bytes = buffer.subarray(0, count);
    if (bytes.length !== before.size || !same(before, await handle.stat())) throw Error("KEYWORD_MONTHLY_CLI_SOURCE_CHANGED");
  } finally { await handle.close(); }
  if (!same(before, await checkPath(resolved))) throw Error("KEYWORD_MONTHLY_CLI_SOURCE_CHANGED");
  return { file: resolved, bytes, stat: before, same };
}
function sourceProvenance(bytes, sourceRead, copiedAt) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw Error("KEYWORD_MONTHLY_CLI_PROVENANCE_JSON"); }
  const allowed = ["inputSha256", "inputBytes", "copiedAt", "observationScope", "selectionCutoffs", "normalizationCutoffs"];
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
    || value.inputSha256 !== undefined && !SHA.test(value.inputSha256)
    || value.inputBytes !== undefined && (!Number.isSafeInteger(value.inputBytes) || value.inputBytes < 0)
    || value.copiedAt !== undefined && !stamp(value.copiedAt)
    || value.observationScope !== undefined && !["selected_only", "normalized_multirun", "verified_history_subset", "unspecified"].includes(value.observationScope)
    || ["selectionCutoffs", "normalizationCutoffs"].some(key => value[key] !== undefined && (!plain(value[key]) || Object.keys(value[key]).length > 1200
      || key === "normalizationCutoffs" && !Object.keys(value[key]).length
      || Object.entries(value[key]).some(([month, day]) => !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month) || !validDay(day))))) throw Error("KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID");
  if (value.inputSha256 !== undefined && value.inputSha256 !== digest(sourceRead.bytes)
    || value.inputBytes !== undefined && value.inputBytes !== sourceRead.bytes.length
    || value.copiedAt !== undefined && copiedAt !== undefined && Date.parse(value.copiedAt) !== Date.parse(copiedAt)) throw Error("KEYWORD_MONTHLY_CLI_PROVENANCE_CONFLICT");
  return value;
}
async function run(values) {
  const input = args(values), read = await safeInput(input.source), output = path.resolve(input.output);
  const provenanceRead = input.provenance ? await safeInput(input.provenance, MAX_PROVENANCE_BYTES) : null;
  if (contains(output, read.file) || provenanceRead && contains(output, provenanceRead.file)) throw Error("KEYWORD_MONTHLY_CLI_OUTPUT_CONTAINS_SOURCE");
  const supplied = provenanceRead ? sourceProvenance(provenanceRead.bytes, read, input["copied-at"]) : {};
  const at = input.now ? new Date(input.now).toISOString() : new Date().toISOString();
  const result = await buildKeywordMonthlyProjection({ source: JSON.parse(read.bytes.toString("utf8")),
    sourceFingerprint: digest(read.bytes),
    sourceProvenance: { ...supplied, inputSha256: digest(read.bytes), inputBytes: read.bytes.length, ...(input["copied-at"] ? { copiedAt: input["copied-at"] } : {}) },
    materializedAt: at, ...(input["data-through"] ? { dataThrough: input["data-through"] } : {}),
    outputDir: output, now: () => new Date(at), compression: input.compression || "auto" });
  if (!read.same(read.stat, await checkPath(read.file)) || provenanceRead && !provenanceRead.same(provenanceRead.stat, await checkPath(provenanceRead.file))) throw Error("KEYWORD_MONTHLY_CLI_SOURCE_CHANGED");
  return { ...result, explicitOfflinePreparation: true, sourceUnchanged: true, providerCalls: 0, kosisReadOrChanged: false,
    ...(provenanceRead ? { provenanceFileSha256: digest(provenanceRead.bytes), provenanceFileBytes: provenanceRead.bytes.length, provenanceUnchanged: true } : {}) };
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message || "") ? error.code || error.message : "KEYWORD_MONTHLY_CLI_FAILED" }));
  process.exitCode = 1;
});
module.exports = { run, args, safeInput };
