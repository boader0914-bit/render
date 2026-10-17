"use strict";

// Provider-neutral immutable storage only. Provider-specific parsers must prove
// geography, periods, completeness and values before publishing observations.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "regional-response-evidence-v1";
const MAX_BYTES = 32 * 1024 * 1024, MAX_ROWS = 100000;
const KINDS = /^[a-z][a-z0-9-]{1,63}$/;
const FORBIDDEN = /^(?:servicekey|apikey|authorization|cookie|setcookie|password|passwd|secret|token|accesstoken|refreshtoken|requesturl|url|headers|environment|env)$/i;
const fault = code => Object.assign(new Error(code), { code });
const check = (value, code = "EVIDENCE_REFERENCE_INVALID") => { if (!value) throw fault(code); };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => target.startsWith(root + path.sep);

function canonical(value, { maxBytes = MAX_BYTES, maxRows = MAX_ROWS, secretValues = [] } = {}) {
  const secrets = [...new Set(secretValues.filter(value => typeof value === "string" && value).flatMap(value => [value, encodeURIComponent(value)]))];
  const seen = new Set(); let budget = 0, items = 0;
  const text = value => {
    budget += Buffer.byteLength(value);
    check(budget <= maxBytes, "EVIDENCE_LIMIT_EXCEEDED");
    check(!secrets.some(secret => value.includes(secret)), "EVIDENCE_SECRET_DETECTED");
    return value;
  };
  function visit(value, depth = 0) {
    check(depth <= 32, "EVIDENCE_LIMIT_EXCEEDED");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { check(Number.isFinite(value)); return value; }
    if (typeof value === "string") return text(value);
    check(value && typeof value === "object" && !seen.has(value));
    const proto = Object.getPrototypeOf(value);
    check(Array.isArray(value) || proto === Object.prototype || proto === null);
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      items += value.length; check(items <= maxRows, "EVIDENCE_LIMIT_EXCEEDED");
      result = value.map(entry => visit(entry, depth + 1));
    } else {
      result = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        check(!FORBIDDEN.test(key.replace(/[_\s-]/g, "")), "EVIDENCE_SECRET_DETECTED");
        text(key); result[key] = visit(value[key], depth + 1);
      }
    }
    seen.delete(value); return result;
  }
  const normalized = visit(value), serialized = JSON.stringify(normalized);
  check(Buffer.byteLength(serialized) <= maxBytes, "EVIDENCE_LIMIT_EXCEEDED");
  return { value: normalized, serialized };
}
function identityOf(identity) {
  check(identity && typeof identity === "object" && !Array.isArray(identity) && Object.keys(identity).length > 0 && Object.keys(identity).length <= 24);
  for (const [key, value] of Object.entries(identity)) {
    check(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key));
    check(typeof value === "string" && value.length <= 240 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean");
  }
  return canonical(identity, { maxBytes: 16384 }).value;
}

function createRegionalResponseEvidenceStore({ directory, now = () => new Date(), maxBytes = MAX_BYTES, maxRows = MAX_ROWS } = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("An evidence data directory is required");
  maxBytes = Math.min(MAX_BYTES, Math.max(1, Number(maxBytes) || MAX_BYTES));
  maxRows = Math.min(MAX_ROWS, Math.max(1, Number(maxRows) || MAX_ROWS));
  const rootPath = path.resolve(directory), reads = new Map();
  async function folder(kind, create) {
    check(KINDS.test(kind || ""));
    if (create) await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(rootPath);
    let current = root;
    for (const segment of ["evidence", "responses", kind]) {
      const next = path.join(current, segment);
      if (create) { try { await fs.mkdir(next, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      const stat = await fs.lstat(next);
      check(stat.isDirectory() && !stat.isSymbolicLink(), "EVIDENCE_PATH_INVALID");
      current = await fs.realpath(next);
      check(inside(root, current), "EVIDENCE_PATH_INVALID");
    }
    return current;
  }
  function referenceFor(kind, digest, bytes) {
    return { status: "stored", version: VERSION, kind, evidenceId: `${kind}-${digest.slice(0, 16)}`, sha256: digest,
      relativePath: `evidence/responses/${kind}/${digest}.json`, bytes };
  }
  function validateReference(reference, kind) {
    check(reference?.status === "stored" && reference.version === VERSION && reference.kind === kind && KINDS.test(kind || "")
      && /^[a-f0-9]{64}$/.test(reference.sha256 || "") && Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && reference.bytes <= maxBytes);
    const expected = referenceFor(kind, reference.sha256, reference.bytes);
    check(reference.evidenceId === expected.evidenceId && reference.relativePath === expected.relativePath);
    return expected;
  }
  async function read(reference, { kind, identity } = {}) {
    try {
      const normalized = validateReference(reference, kind), expectedIdentity = identityOf(identity);
      const parent = await folder(kind, false), filename = path.join(parent, `${normalized.sha256}.json`);
      const named = await fs.lstat(filename);
      check(named.isFile() && !named.isSymbolicLink(), "EVIDENCE_PATH_INVALID");
      check(named.size > 0 && named.size <= maxBytes && named.size === normalized.bytes, "EVIDENCE_LIMIT_EXCEEDED");
      const key = JSON.stringify([filename, named.ino, named.size, named.mtimeMs, named.ctimeMs, normalized.sha256, expectedIdentity]);
      if (!reads.has(key)) {
        const operation = (async () => {
          const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const before = await handle.stat();
            check(before.isFile() && before.ino === named.ino && before.size === named.size && before.mtimeMs === named.mtimeMs && before.ctimeMs === named.ctimeMs, "EVIDENCE_READ_ERROR");
            const chunks = [], digest = crypto.createHash("sha256"); let size = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
              size += chunk.length; check(size <= maxBytes, "EVIDENCE_LIMIT_EXCEEDED"); digest.update(chunk); chunks.push(chunk);
            }
            const after = await handle.stat();
            check(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && size === before.size, "EVIDENCE_READ_ERROR");
            // New archives are canonical bytes. Detect changes in key ordering
            // or whitespace as well as semantic content after publication.
            check(digest.digest("hex") === normalized.sha256, "EVIDENCE_HASH_MISMATCH");
            let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fault("EVIDENCE_READ_ERROR"); }
            const source = canonical(parsed, { maxBytes, maxRows });
            check(sha(source.serialized) === normalized.sha256, "EVIDENCE_HASH_MISMATCH");
            const payload = source.value;
            check(payload.schemaVersion === 1 && payload.version === VERSION && payload.kind === kind
              && Object.keys(payload).length === 5 && Object.hasOwn(payload, "response")
              && JSON.stringify(identityOf(payload.identity)) === JSON.stringify(expectedIdentity), "EVIDENCE_IDENTITY_MISMATCH");
            return { payload, reference: normalized, verifiedAt: new Date(now()).toISOString() };
          } finally { await handle.close(); }
        })();
        reads.set(key, operation);
        operation.finally(() => reads.delete(key)).catch(() => {});
      }
      return structuredClone(await reads.get(key));
    } catch (error) {
      if (error.code?.startsWith("EVIDENCE_")) throw error;
      throw fault(error.code === "ENOENT" ? "EVIDENCE_NOT_FOUND" : error.code === "ELOOP" ? "EVIDENCE_PATH_INVALID" : "EVIDENCE_READ_ERROR");
    }
  }
  async function write({ kind, identity, response, secretValues = [] } = {}) {
    let temporary;
    try {
      check(KINDS.test(kind || ""));
      const normalizedIdentity = identityOf(identity);
      const source = canonical({ schemaVersion: 1, version: VERSION, kind, identity: normalizedIdentity, response }, { maxBytes, maxRows, secretValues });
      const bytes = Buffer.from(source.serialized), reference = referenceFor(kind, sha(bytes), bytes.length);
      const parent = await folder(kind, true), filename = path.join(parent, `${reference.sha256}.json`);
      temporary = path.join(parent, `.pending-${crypto.randomUUID()}.json`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, filename); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      // Existing content is never overwritten, including after a lost response.
      await read(reference, { kind, identity: normalizedIdentity });
      return reference;
    } catch (error) {
      if (error.code?.startsWith("EVIDENCE_")) throw error;
      throw fault("EVIDENCE_WRITE_ERROR");
    } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }
  return { write, read };
}

module.exports = { VERSION, MAX_BYTES, MAX_ROWS, createRegionalResponseEvidenceStore };
