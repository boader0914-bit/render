"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { VERSION, createRegionalResponseEvidenceStore } = require("./lib/regional_response_evidence.cjs");
const kind = "fixture-response";
const identity = { provider: "fixture", regionCode: "11111", period: "2026-08", operation: "visits" };
const response = { rows: [{ code: "11111", period: "202608", value: 0 }, { code: "11111", period: "202608", value: 7 }], totalCount: 2 };
const input = () => ({ kind, identity: structuredClone(identity), response: structuredClone(response) });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "regional-response-evidence-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-response-evidence-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const directory = path.join(root, "data");
  const store = createRegionalResponseEvidenceStore({ directory, now: () => "2026-10-17T00:00:00Z", ...options });
  return { root, directory, store, file: ref => path.join(directory, ref.relativePath) };
}
const rejects = (action, code) => assert.rejects(action, error => error.code === code && error.message === code);

test("construction is lazy and identical semantic responses share immutable content across restarts", async t => {
  const f = await fixture(t);
  await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
  const first = await f.store.write(input()), file = f.file(first);
  const before = await fs.readFile(file), stat = await fs.stat(file);
  const reordered = { kind, identity: { operation: "visits", period: "2026-08", regionCode: "11111", provider: "fixture" },
    response: { totalCount: 2, rows: [{ value: 0, period: "202608", code: "11111" }, { value: 7, period: "202608", code: "11111" }] } };
  const restarted = createRegionalResponseEvidenceStore({ directory: f.directory, now: () => "2026-11-17T00:00:00Z" });
  assert.deepEqual(await restarted.write(reordered), first);
  assert.deepEqual(await fs.readFile(file), before); assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.equal(first.version, VERSION); assert.equal(sha(before), first.sha256);
  const loaded = await restarted.read(first, { kind, identity });
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.payload.response)), response);
  assert.equal(loaded.verifiedAt, "2026-11-17T00:00:00.000Z");
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test("corrected values and different request identities receive separate files without overwriting history", async t => {
  const f = await fixture(t), original = await f.store.write(input()), bytes = await fs.readFile(f.file(original));
  const changed = input(); changed.response.rows[1].value = 8;
  const corrected = await f.store.write(changed), other = await f.store.write({ ...input(), identity: { ...identity, regionCode: "22222" } });
  assert.equal(new Set([original.sha256, corrected.sha256, other.sha256]).size, 3);
  assert.deepEqual(await fs.readFile(f.file(original)), bytes);
});

test("concurrent identical writes and reads deduplicate files and do not share mutable payload objects", async t => {
  const f = await fixture(t), refs = await Promise.all(Array.from({ length: 8 }, () => f.store.write(input())));
  assert.ok(refs.every(ref => ref.sha256 === refs[0].sha256));
  const values = await Promise.all(refs.map(ref => f.store.read(ref, { kind, identity })));
  values[0].payload.response.rows[0].value = 99;
  assert.equal(values[1].payload.response.rows[0].value, 0);
  assert.deepEqual(await fs.readdir(path.dirname(f.file(refs[0]))), [path.basename(f.file(refs[0]))]);
});

test("tampered references, path traversal, wrong identity and wrong kind never select another original", async t => {
  const f = await fixture(t), ref = await f.store.write(input());
  for (const altered of [{ relativePath: "../elsewhere.json" }, { relativePath: path.resolve(f.file(ref)) }, { evidenceId: "different-id" },
    { sha256: "A".repeat(64) }, { bytes: 0 }, { bytes: 2 ** 32 }, { kind: "other-response" }, { version: "unknown" }]) {
    await rejects(() => f.store.read({ ...ref, ...altered }, { kind, identity }), "EVIDENCE_REFERENCE_INVALID");
  }
  await rejects(() => f.store.read(ref, { kind, identity: { ...identity, period: "2026-09" } }), "EVIDENCE_IDENTITY_MISMATCH");
  await rejects(() => f.store.read(ref, { kind: "other-response", identity }), "EVIDENCE_REFERENCE_INVALID");
});

test("same-sized corruption is rejected and an existing corrupt original is never overwritten", async t => {
  const f = await fixture(t), ref = await f.store.write(input()), file = f.file(ref);
  const altered = (await fs.readFile(file, "utf8")).replace('"value":7', '"value":8');
  await fs.writeFile(file, altered);
  await rejects(() => f.store.read(ref, { kind, identity }), "EVIDENCE_HASH_MISMATCH");
  await rejects(() => f.store.write(input()), "EVIDENCE_HASH_MISMATCH");
  assert.equal(await fs.readFile(file, "utf8"), altered);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test("known secret values, encoded values and credential fields are rejected before any files are created", async t => {
  const secret = "fixture-only+key/value==";
  for (const response of [{ message: secret }, { message: encodeURIComponent(secret) }, { rows: [{ service_key: "anything" }] },
    { Authorization: "anything" }, { requestUrl: "https://example.invalid" }, { rows: [{ nested: { cookie: "anything" } }] }]) {
    const f = await fixture(t);
    await rejects(() => f.store.write({ kind, identity, response, secretValues: [secret] }), "EVIDENCE_SECRET_DETECTED");
    await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
  }
});

test("changing only archive key order is detected even when semantic JSON is unchanged", async t => {
  const f = await fixture(t), ref = await f.store.write(input()), file = f.file(ref);
  const payload = JSON.parse(await fs.readFile(file, "utf8"));
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()));
  assert.equal(Buffer.byteLength(reordered), ref.bytes);
  await fs.writeFile(file, reordered);
  await rejects(() => f.store.read(ref, { kind, identity }), "EVIDENCE_HASH_MISMATCH");
});

test("oversized bytes, array rows and nested payloads are bounded before storage", async t => {
  const bytes = await fixture(t, { maxBytes: 512 }), rows = await fixture(t, { maxRows: 2 });
  await rejects(() => bytes.store.write({ ...input(), response: { message: "가".repeat(512) } }), "EVIDENCE_LIMIT_EXCEEDED");
  await rejects(() => rows.store.write({ ...input(), response: [1, 2, 3] }), "EVIDENCE_LIMIT_EXCEEDED");
  let nested = {};
  for (let index = 0; index < 35; index++) nested = { nested };
  await rejects(() => bytes.store.write({ ...input(), response: nested }), "EVIDENCE_LIMIT_EXCEEDED");
  for (const f of [bytes, rows]) await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
});

test("invalid identities, non-JSON numbers, cycles and unexpected object types are rejected", async t => {
  const f = await fixture(t), cyclic = {}; cyclic.self = cyclic;
  for (const identity of [null, {}, [], { nested: {} }, { year: Infinity }, { long: "x".repeat(241) }, { "../path": "x" }]) {
    await rejects(() => f.store.write({ ...input(), identity }), "EVIDENCE_REFERENCE_INVALID");
  }
  for (const response of [cyclic, { value: NaN }, { value: Infinity }, { value: undefined }, { value: new Date() }]) {
    await rejects(() => f.store.write({ ...input(), response }), "EVIDENCE_REFERENCE_INVALID");
  }
  await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
});

test("writes fail with a safe diagnostic when the archive folder cannot be created", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory); await fs.writeFile(path.join(f.directory, "evidence"), "occupied");
  await rejects(() => f.store.write(input()), "EVIDENCE_PATH_INVALID");
  assert.equal(await fs.readFile(path.join(f.directory, "evidence"), "utf8"), "occupied");
});

test("missing original and changed file size cannot be reported as verified", async t => {
  const f = await fixture(t), ref = await f.store.write(input());
  await fs.appendFile(f.file(ref), " ");
  await rejects(() => f.store.read(ref, { kind, identity }), "EVIDENCE_LIMIT_EXCEEDED");
  await fs.unlink(f.file(ref));
  await rejects(() => f.store.read(ref, { kind, identity }), "EVIDENCE_NOT_FOUND");
});

test("directory links and linked original files cannot escape the archive", async t => {
  const f = await fixture(t), outside = path.join(f.root, "outside");
  await fs.mkdir(f.directory); await fs.mkdir(outside);
  const link = path.join(f.directory, "evidence");
  try { await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Host cannot create filesystem links"); return; } throw error; }
  await rejects(() => f.store.write(input()), "EVIDENCE_PATH_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(link);
  const ref = await f.store.write(input()), file = f.file(ref), outsideFile = path.join(outside, "original.json");
  await fs.copyFile(file, outsideFile); await fs.unlink(file);
  try { await fs.symlink(outsideFile, file, "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("Host cannot create file links; directory link was checked"); return; } throw error; }
  await rejects(() => f.store.read(ref, { kind, identity }), "EVIDENCE_PATH_INVALID");
});

test("a correctly hashed envelope with a different schema or identity is still rejected", async t => {
  const f = await fixture(t), ref = await f.store.write(input());
  const raw = JSON.parse(await fs.readFile(f.file(ref), "utf8"));
  for (const delta of [{ schemaVersion: 2 }, { kind: "other-response" }, { identity: { ...identity, operation: "other" } }, { extra: "unrecognized" }]) {
    const payload = { ...raw, ...delta };
    function sorted(value) { return Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value; }
    const bytes = Buffer.from(JSON.stringify(sorted(payload))), digest = sha(bytes);
    const changed = { ...ref, sha256: digest, bytes: bytes.length, evidenceId: `${kind}-${digest.slice(0, 16)}`, relativePath: `evidence/responses/${kind}/${digest}.json` };
    await fs.writeFile(f.file(changed), bytes);
    await rejects(() => f.store.read(changed, { kind, identity }), "EVIDENCE_IDENTITY_MISMATCH");
  }
});
