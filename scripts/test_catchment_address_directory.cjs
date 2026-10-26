"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Readable } = require("node:stream");
const { createCatchmentAddressDirectory } = require("./lib/catchment_address_directory.cjs");
const ADDRESS = "경상남도 합성군 시험로 10";
const company = (id, extra = {}) => ({ companyId: id, primaryName: "모의 업체 " + id, addresses: [ADDRESS],
  keywords: { secret: { runs: [{ token: "never-cache-me" }] } }, inventory: { huge: "never-cache-me" }, ...extra });
const body = companies => JSON.stringify({ companies: Object.fromEntries(companies.map(value => [value.companyId, value])) });
async function fixture(t, companies = [company("a")]) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "catchment-address-directory-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + "catchment-address-directory-"));
  const file = path.join(folder, "companies.json"); await fs.writeFile(file, body(companies));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return { folder, file };
}
function countedFileSystem() {
  const calls = { open: 0, lstat: 0 };
  return { calls, fileSystem: { ...fs,
    async open(...args) { calls.open++; return fs.open(...args); },
    async lstat(...args) { calls.lstat++; return fs.lstat(...args); } } };
}

test("only detached bounded address metadata survives; each cached read freshly checks file/path identity without a second scan", async t => {
  const { folder, file } = await fixture(t, [company("a", { address: ADDRESS, addresses: [ADDRESS, { address: ADDRESS }] }), company("removed", { deletedAt: "2026-10-26" })]);
  const counted = countedFileSystem(), directory = createCatchmentAddressDirectory({ file, dataDir: folder, fileSystem: counted.fileSystem });
  const before = await fs.readFile(file), rows = await directory.read();
  assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]).sort(), ["addressBasis", "addresses", "companyId", "label"]);
  assert.deepEqual(rows[0].addressBasis, { status: "ready", address: ADDRESS, basis: "saved_company_address" });
  assert.deepEqual(rows[0].addresses, [ADDRESS]); assert.equal(JSON.stringify(rows).includes("never-cache-me"), false);
  rows[0].addressBasis.address = "changed"; rows[0].addresses.push("changed"); rows.push({ companyId: "invented" });
  const previousStats = counted.calls.lstat, again = await directory.read();
  assert.equal(again.length, 1); assert.equal(again[0].addressBasis.address, ADDRESS); assert.deepEqual(again[0].addresses, [ADDRESS]);
  assert.equal(counted.calls.open, 1); assert.ok(counted.calls.lstat > previousStats); assert.deepEqual(await fs.readFile(file), before);
});

test("concurrent readers of the same fresh identity share one stream but receive independent results", async t => {
  const { file } = await fixture(t), counted = countedFileSystem();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const directory = createCatchmentAddressDirectory({ file, fileSystem: counted.fileSystem,
    stream: handle => Readable.from((async function* () { entered(); await gate; yield await handle.readFile("utf8"); })()) });
  const reads = Array.from({ length: 8 }, () => directory.read()); await started; release();
  const rows = await Promise.all(reads);
  assert.equal(counted.calls.open, 1); assert.ok(rows.every(value => value[0].companyId === "a"));
  rows[0][0].label = "changed"; assert.notEqual(rows[1][0].label, "changed");
});

test("same-size edits with restored mtime invalidate the source through ctime and are not served from an old cache", async t => {
  const { file } = await fixture(t), counted = countedFileSystem(), directory = createCatchmentAddressDirectory({ file, fileSystem: counted.fileSystem });
  await directory.read();
  const old = await fs.stat(file); await new Promise(resolve => setTimeout(resolve, 15));
  const replacement = body([company("b")]); assert.equal(Buffer.byteLength(replacement), old.size);
  await fs.writeFile(file, replacement); await fs.utimes(file, old.atime, old.mtime);
  const rows = await directory.read(); assert.equal(rows[0].companyId, "b"); assert.equal(counted.calls.open, 2);
});

test("different source identities cannot multiply in-flight generations or scans", async t => {
  const { file } = await fixture(t), counted = countedFileSystem();
  let release, entered, hold = true;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const directory = createCatchmentAddressDirectory({ file, fileSystem: counted.fileSystem,
    stream: handle => Readable.from((async function* () { if (hold) { entered(); await gate; } yield await handle.readFile("utf8"); })()) });
  const first = directory.read(); await started;
  await fs.writeFile(file, body([company("b")]));
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_CHANGED" });
  assert.equal(counted.calls.open, 1); hold = false; release();
  await assert.rejects(first, { code: "CATCHMENT_ADDRESS_SOURCE_CHANGED" });
  assert.equal((await directory.read())[0].companyId, "b"); assert.equal(counted.calls.open, 2);
});

test("corrupt, absent and structurally invalid sources reject instead of promoting an old or empty directory", async t => {
  const { file } = await fixture(t), directory = createCatchmentAddressDirectory({ file }); await directory.read();
  await fs.writeFile(file, '{"companies":{"a":');
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  await fs.writeFile(file, JSON.stringify({ companies: { outer: company("inner") } }));
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  await fs.unlink(file); await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_UNAVAILABLE" });
  await fs.writeFile(file, body([])); assert.deepEqual(await directory.read(), []);
});

test("invalid UTF-8 and literal replacement characters never certify saved address metadata", async t => {
  const { file } = await fixture(t), directory = createCatchmentAddressDirectory({ file }); await directory.read();
  const invalid = Buffer.from(body([company("a")])), index = invalid.indexOf(Buffer.from("시험로")); assert.ok(index > 0);
  invalid[index] = 0xff; await fs.writeFile(file, invalid);
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  await fs.writeFile(file, body([company("a", { addresses: ["경상남도 합성군 \uFFFD시험로 10"] })]));
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  await fs.writeFile(file, body([company("a", { addresses: ["경상남도 합성군 \uFFFD시험로 10"] })]).replaceAll("\uFFFD", "\\uFFFD"));
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  await fs.writeFile(file, body([company("a")])); assert.equal((await directory.read())[0].addressBasis.address, ADDRESS);
});

test("changes while the original is being read reject and never publish a partial directory", async t => {
  const { file } = await fixture(t);
  let changed = false;
  const directory = createCatchmentAddressDirectory({ file, stream: handle => Readable.from((async function* () {
    const content = await handle.readFile("utf8");
    if (!changed) { changed = true; native.writeFileSync(file, body([company("b")])); }
    yield content;
  })()) });
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_CHANGED" });
  assert.equal((await directory.read())[0].companyId, "b");
});

test("every caller rechecks source identity after a shared or cached read", async t => {
  const { file } = await fixture(t), counted = countedFileSystem();
  const directory = createCatchmentAddressDirectory({ file, fileSystem: counted.fileSystem }); await directory.read();
  const nativeLstat = counted.fileSystem.lstat;
  let targetChecks = 0;
  counted.fileSystem.lstat = async (target, options) => {
    if (target === path.resolve(file) && ++targetChecks === 2) native.writeFileSync(file, body([company("b")]));
    return nativeLstat(target, options);
  };
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_CHANGED" });
  assert.equal((await directory.read())[0].companyId, "b");
});

test("company and serialized metadata limits reject rather than truncate; candidates are explicitly bounded to twenty", async t => {
  const { file } = await fixture(t, [company("a"), company("b")]);
  await assert.rejects(createCatchmentAddressDirectory({ file, maxCompanies: 1 }).read(), { code: "CATCHMENT_ADDRESS_SOURCE_LIMIT" });
  await assert.rejects(createCatchmentAddressDirectory({ file, maxBytes: 32 }).read(), { code: "CATCHMENT_ADDRESS_SOURCE_LIMIT" });
  await fs.writeFile(file, body([company("a", { addresses: Array.from({ length: 30 }, (_, i) => "경상남도 합성군 시험로 " + (i + 10)) })]));
  const rows = await createCatchmentAddressDirectory({ file }).read();
  assert.equal(rows[0].addressBasis.status, "ambiguous"); assert.equal(rows[0].addresses.length, 20);
});

test("hard links, symbolic files and symbolic ancestors cannot supply cached address metadata", async t => {
  const { folder, file } = await fixture(t), directory = createCatchmentAddressDirectory({ file }); await directory.read();
  const hard = path.join(folder, "hard.json"); await fs.link(file, hard);
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" }); await fs.unlink(hard);
  const actual = path.join(folder, "actual"), junction = path.join(folder, "linked");
  await fs.mkdir(actual); await fs.writeFile(path.join(actual, "companies.json"), body([company("a")]));
  try { await fs.symlink(actual, junction, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("This host disallows directory symlinks"); return; } throw error; }
  await assert.rejects(createCatchmentAddressDirectory({ file: path.join(junction, "companies.json") }).read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
  const symbolicFile = path.join(folder, "symbolic.json");
  try { await fs.symlink(file, symbolicFile, "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.diagnostic("This host disallows file symlinks; ancestor junction and hardlink checks ran"); return; } throw error; }
  await assert.rejects(createCatchmentAddressDirectory({ file: symbolicFile }).read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" });
});

test("the final-file symbolic-link guard also runs for a formerly cached source", async t => {
  const { file } = await fixture(t), counted = countedFileSystem();
  const directory = createCatchmentAddressDirectory({ file, fileSystem: counted.fileSystem }); await directory.read();
  const previous = counted.fileSystem.lstat;
  counted.fileSystem.lstat = async (target, options) => {
    const stat = await previous(target, options);
    return target === path.resolve(file) ? new Proxy(stat, { get(value, key) { return key === "isSymbolicLink" ? () => true : typeof value[key] === "function" ? value[key].bind(value) : value[key]; } }) : stat;
  };
  await assert.rejects(directory.read(), { code: "CATCHMENT_ADDRESS_SOURCE_INVALID" }); assert.equal(counted.calls.open, 1);
});
