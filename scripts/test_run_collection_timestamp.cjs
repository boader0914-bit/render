"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const result = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(result, `${name} exists`);
  return result;
}
const recordedId = "pocheon_glamping_20260921_140000";
const legacyId = "legacy_glamping_20260101";
const fallback = "2026-09-19T03:00:00.000Z";
const manifests = new Map([[recordedId, { keyword: "포천글램핑", completedAt: "2026-09-21T05:00:00.000Z" }], [legacyId, null]]);
const stat = { birthtime: new Date(fallback), ctime: new Date("2026-09-20T01:00:00.000Z"), mtime: new Date("2026-09-21T01:00:00.000Z") };
const context = vm.createContext({
  Date, path, OUTPUTS_DIR: "outputs",
  fsp: {
    mkdir: async () => {}, stat: async () => stat,
    readdir: async (_dir, options) => options?.withFileTypes
      ? [...manifests.keys()].map((name) => ({ name, isDirectory: () => true })) : ["saved.csv"]
  },
  readManifest: async (dir) => manifests.get(path.basename(dir)),
  isIncompleteRunDirectory: () => false, provinceKeyForRun: () => "local",
  displayNameForRun: (id, manifest) => manifest?.keyword || id,
  PROVINCES: { local: { keyword: "지역 검색", label: "검색 권역" } },
  SEARCH_MODES: { company: "업체", keyword: "키워드" }, COLLECTION_MODES: { precision: "상세" },
  USER_ROLES: { admin: "admin" }, COLLECTION_PURPOSES: { revenue_detail: "매출 상세" },
  sourceRoleForCollectionSource: () => "admin", normalizeCollectionSource: () => "admin", collectionSourceLabel: () => "관리자"
});
const api = vm.runInContext(`${["runCollectedAtSource", "runCollectedAt", "listRuns"].map(declaration).join("\n")}\n({runCollectedAtSource,runCollectedAt,listRuns})`, context);

async function main() {
  for (const key of ["completedAt", "finishedAt", "collectedAt", "startedAt", "createdAt"]) {
    assert.equal(api.runCollectedAtSource({ [key]: "2026-09-21T05:00:00.000Z" }), "recorded", `${key} is a recorded collection timestamp`);
  }
  assert.equal(api.runCollectedAtSource({}), "filesystem");
  assert.equal(api.runCollectedAtSource(null), "filesystem");
  assert.equal(api.runCollectedAtSource({ completedAt: "invalid", collectedAt: "" }), "filesystem");
  assert.equal(api.runCollectedAt(legacyId, {}, stat), fallback, "Legacy run ID date cannot replace the filesystem fallback");
  const preserved = { collectedAt: fallback, collectedAtSource: "filesystem" };
  assert.equal(api.runCollectedAtSource(preserved), "filesystem", "A manual supplement preserves fallback provenance");
  assert.equal(api.runCollectedAtSource({ ...preserved, completedAt: "2026-09-21T05:00:00.000Z" }), "recorded", "A real completed timestamp takes precedence over an older preserved fallback");
  const runs = await api.listRuns();
  assert.equal(runs.find((run) => run.id === recordedId).collectedAtSource, "recorded");
  assert.equal(runs.find((run) => run.id === legacyId).collectedAtSource, "filesystem");
  assert.equal(runs.find((run) => run.id === legacyId).collectedAt, fallback);
  const detail = declaration("loadRun");
  assert.match(detail, /const collectedAtSource = runCollectedAtSource\(manifest\)/);
  assert.match(detail, /collectedAt,\s+collectedAtSource,\s+updatedAt: collectedAt/);
  const supplement = declaration("importYeogiSupplement");
  assert.match(supplement, /manifest\.collectedAt = collectedAt;\s+manifest\.collectedAtSource = collectedAtSource/);
  console.log("Run timestamp provenance: recorded fields, legacy filesystem fallback, list/detail metadata and manual-supplement preservation passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
