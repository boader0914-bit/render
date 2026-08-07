"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  FROZEN_V2_COLLECTOR_BLOB,
  FROZEN_V2_COLLECTOR_STRATEGY,
  FROZEN_V2_FETCH_SAFETY_PRELOAD_BLOB,
  FROZEN_V2_PACKAGE_LOCK_BLOB,
  FROZEN_V2_SOURCE_COMMIT,
  FROZEN_V2_WORKBOOK_BRIDGE_BLOB,
  FROZEN_V2_WORKBOOK_PACKAGE,
  FROZEN_V2_WORKBOOK_PACKAGE_VERSION,
  gitBlobHash,
  verifyFrozenCollectorIntegrity
} = require("./v2_frozen_collector_adapter.cjs");

const ROOT = path.resolve(__dirname, "..");
const FROZEN_ROOT = path.join(ROOT, "scripts", "frozen_v2_4e4e190");

const UI_BASELINE_BLOBS = Object.freeze({
  "web/app.js": "b01941439045030a7bae81c4086c37b5bf790de8",
  "web/index.html": "b0e92308ff28edb4d8de76e0f886d257530904b1",
  "web/styles.css": "6e8c1413d845b256b5cb0e20249f5e8749f8cd6e",
  "web/public-ui.css": "988eed0436ac6d34a779ee6a85b0af5a7bbaf5c8",
  "web/login-theme.js": "5ee22ec02d65a314243cbaa6ad31303f2a129793",
  "web/sw.js": "21c3b283773b4c1240a8593fbd88f1204040cb35"
});

async function blobFor(relativePath) {
  const content = await fsp.readFile(path.join(ROOT, ...relativePath.split("/")), "utf8");
  return gitBlobHash(Buffer.from(content.replace(/\r\n/gu, "\n"), "utf8"));
}

async function main() {
  const verified = await verifyFrozenCollectorIntegrity({ rootDir: ROOT });
  assert.equal(verified.valid, true);
  assert.equal(verified.sourceCommit, FROZEN_V2_SOURCE_COMMIT);
  assert.equal(verified.actualBlob, FROZEN_V2_COLLECTOR_BLOB);
  assert.equal(verified.workbookPackage, FROZEN_V2_WORKBOOK_PACKAGE);
  assert.equal(verified.workbookPackageVersion, FROZEN_V2_WORKBOOK_PACKAGE_VERSION);

  const frozenSource = await fsp.readFile(path.join(FROZEN_ROOT, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const requiredModules = [...frozenSource.matchAll(/require\(["']([^"']+)["']\)/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(requiredModules)].sort(),
    ["@oai/artifact-tool", "node:crypto", "node:fs/promises", "node:path", "xlsx"].sort(),
    "the frozen source dependency closure must remain the historical one"
  );

  const manifest = JSON.parse(await fsp.readFile(path.join(FROZEN_ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.sourceCommit, FROZEN_V2_SOURCE_COMMIT);
  assert.equal(manifest.sourceBlob, FROZEN_V2_COLLECTOR_BLOB);
  assert.equal(manifest.collectorStrategy, FROZEN_V2_COLLECTOR_STRATEGY);
  assert.equal(manifest.immutable, true);
  assert.ok(Number.isFinite(Date.parse(manifest.restoredAt)));
  const manifestDependencies = new Map(manifest.dependencies.map((entry) => [entry.id, entry]));
  assert.equal(manifestDependencies.get("safe-workbook-bridge").dependencyBlob, FROZEN_V2_WORKBOOK_BRIDGE_BLOB);
  assert.equal(manifestDependencies.get("fetch-safety-preload").dependencyBlob, FROZEN_V2_FETCH_SAFETY_PRELOAD_BLOB);
  assert.equal(manifestDependencies.get("locked-workbook-dependency").dependencyBlob, FROZEN_V2_PACKAGE_LOCK_BLOB);
  assert.equal(manifestDependencies.get("locked-workbook-dependency").version, FROZEN_V2_WORKBOOK_PACKAGE_VERSION);

  const verifiedDependencies = new Map(verified.dependencyClosure.map((entry) => [entry.id, entry]));
  for (const dependencyId of ["safe-workbook-bridge", "fetch-safety-preload", "locked-workbook-dependency"]) {
    const expected = manifestDependencies.get(dependencyId);
    const actual = verifiedDependencies.get(dependencyId);
    assert.ok(expected && actual, `missing dependency closure entry: ${dependencyId}`);
    assert.equal(actual.actualBlob, expected.dependencyBlob);
  }

  const packageManifest = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageManifest.dependencies[FROZEN_V2_WORKBOOK_PACKAGE], FROZEN_V2_WORKBOOK_PACKAGE_VERSION);
  assert.equal(Object.hasOwn(packageManifest.dependencies, "xlsx"), false, "vulnerable xlsx must not be restored");

  for (const [relativePath, expectedBlob] of Object.entries(UI_BASELINE_BLOBS)) {
    assert.equal(await blobFor(relativePath), expectedBlob, `${relativePath} must remain byte-identical to v46`);
  }
  const serviceWorker = await fsp.readFile(path.join(ROOT, "web", "sw.js"), "utf8");
  assert.match(serviceWorker, /lodging-datalab-pwa-v20260807-worker-top20-ui-v46/u);

  console.log("Frozen V2 collector integrity fixture passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
