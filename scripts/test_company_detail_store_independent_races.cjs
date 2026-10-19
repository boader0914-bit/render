"use strict";
// Independent guard-epoch regression: an in-flight filesystem call can have
// already sampled an old inode before a later verification joins its promise.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { test } = require("node:test");
const { createCompanyDetailStore } = require("./lib/company_detail_store.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("a final run-file verification cannot join another request's pre-change lstat sample", { timeout: 10000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "detail-independent-epoch-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const masterFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl"),
    runId = "same_run", runDir = path.join(dataDir, "outputs", runId), runFile = path.join(runDir, "manifest.json");
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true }); await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(masterFile, JSON.stringify({ companies: { one: { companyId: "one", runIds: [runId] }, two: { companyId: "two", runIds: [runId] } } }));
  await fs.writeFile(historyFile, ""); await fs.writeFile(runFile, JSON.stringify({ marker: "before" }));
  const cachedOne = path.join(dataDir, "company_master/detail_read_models", crypto.createHash("sha256").update(JSON.stringify("one")).digest("hex") + ".json");
  const sampled = gate(), release = gate(); let armed = false, sampleHeld = false, injected = false, other;
  const fileSystem = Object.create(fs);
  fileSystem.lstat = async (filename, options) => {
    const value = await fs.lstat(filename, options);
    if (armed && !sampleHeld && filename === runFile) {
      sampleHeld = true; sampled.resolve(); await release.promise;
    }
    return value;
  };
  let store;
  fileSystem.rename = async (from, to) => {
    await fs.rename(from, to);
    if (armed || injected || to !== cachedOne) return;
    // This hook is armed only after priming normal caches below.
    if (!fileSystem.inject) return;
    injected = true; armed = true;
    other = store.get("two");
    await sampled.promise;
    await fs.writeFile(runFile, JSON.stringify({ marker: "after" }));
    setTimeout(() => release.resolve(), 50);
  };
  store = createCompanyDetailStore({ dataDir, projectionVersion: "independent-epoch-v1", fileSystem,
    matchesObservation: (row, company) => row.companyKey === company.companyId, runIdsForCompany: company => company.runIds,
    build: async (id, { master }) => ({ company: master.companies[id], marker: JSON.parse(await fs.readFile(runFile, "utf8")).marker }) });
  await store.get("one"); await store.get("two");
  await fs.writeFile(historyFile, JSON.stringify({ observationId: "changed", companyKey: "one" }) + "\n");
  fileSystem.inject = true;
  let result, failure;
  try { result = await store.get("one"); } catch (error) { failure = error; }
  finally { release.resolve(); if (other) await other.catch(() => {}); }
  assert.equal(injected, true); assert.equal(sampleHeld, true);
  // Explicit source-change failure or a genuinely refreshed result is safe.
  assert.ok(failure?.code === "COMPANY_DETAIL_SOURCE_CHANGED" || result?.data?.marker === "after",
    "a stale pre-change detail must not be certified by shared old stat: " + JSON.stringify({ errorCode: failure?.code, marker: result?.data?.marker }));
});
