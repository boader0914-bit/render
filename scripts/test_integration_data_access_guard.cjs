const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CONTRACT_PREVIEW_PURPOSE,
  DEFAULT_BLOCKED_SOURCE_IDENTIFIERS,
  createIntegrationDataAccessGuard,
  isCompleteStaticAssetAllowlistEntry
} = require("./integration_data_access_guard.cjs");

function checksum(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function assertDenied(decision, code) {
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, code);
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lodging-stage224-data-guard-"));
  try {
    const projectRoot = path.join(tempRoot, "project");
    const freshStoreRoot = path.join(projectRoot, "integration-store");
    const freshFile = path.join(freshStoreRoot, "observations", "fresh.jsonl");
    const fixtureRoot = path.join(projectRoot, "test", "fixtures", "stage223");
    const fixtureFile = path.join(fixtureRoot, "history_observations.json");
    const escapeSourceRoot = path.join(projectRoot, "external-fixture-escape");
    const escapeSourceFile = path.join(escapeSourceRoot, "outside.json");
    const escapeLink = path.join(fixtureRoot, "linked-outside");
    const staticAsset = path.join(projectRoot, "web", "assets", "municipalities.geojson");
    const unlistedAsset = path.join(projectRoot, "web", "assets", "unlisted.geojson");
    const incompleteAsset = path.join(projectRoot, "web", "assets", "incomplete.geojson");
    const staticBody = '{"type":"FeatureCollection","features":[]}\n';

    write(freshFile, '{"source":"fresh-collection"}\n');
    write(fixtureFile, '[{"source":"v2_history"}]\n');
    write(escapeSourceFile, '{"source":"outside-fixture-root"}\n');
    fs.symlinkSync(escapeSourceRoot, escapeLink, process.platform === "win32" ? "junction" : "dir");
    write(staticAsset, staticBody);
    write(unlistedAsset, staticBody);
    write(incompleteAsset, staticBody);

    const legacyFiles = Object.fromEntries([
      "data",
      "outputs",
      "db",
      "cache",
      "history",
      "config",
      "backups"
    ].map((name) => {
      const filePath = path.join(projectRoot, name, "legacy.json");
      write(filePath, `{"legacy":"${name}"}\n`);
      return [name, filePath];
    }));

    const validStaticEntry = {
      id: "municipal-boundaries",
      path: staticAsset,
      source: "https://github.com/southkorea/southkorea-maps",
      version: "KOSTAT-2013-simplified-WGS84",
      license: "KOSTAT free to share or remix",
      checksum: checksum(staticBody)
    };
    const incompleteStaticEntry = {
      path: incompleteAsset,
      source: "https://example.invalid/map.geojson",
      version: "TBD",
      license: "unknown",
      checksum: "sha256:not-a-digest"
    };

    assert.equal(isCompleteStaticAssetAllowlistEntry(validStaticEntry), true);
    assert.equal(isCompleteStaticAssetAllowlistEntry(incompleteStaticEntry), false);

    const testGuard = createIntegrationDataAccessGuard({
      projectRoot,
      freshStoreRoot,
      fixtureRoots: [fixtureRoot],
      env: { NODE_ENV: "test" },
      staticAssetAllowlist: [validStaticEntry, incompleteStaticEntry]
    });

    assert.equal(testGuard.policy.invalidStaticAssetEntries.length, 1);
    assert.equal(testGuard.evaluate({ kind: "fresh-store", path: freshFile }).allowed, true);
    assert.equal(testGuard.assertAccess({ kind: "fresh-store", path: path.join(freshStoreRoot, "new.json") }).allowed, true);
    assertDenied(
      testGuard.evaluate({ kind: "fresh-store", path: path.join(freshStoreRoot, "..", "outside.json") }),
      "outside_fresh_store"
    );

    for (const [name, filePath] of Object.entries(legacyFiles)) {
      const decision = testGuard.evaluate({ kind: "fresh-store", path: filePath });
      assertDenied(decision, "legacy_path_blocked");
      assert.ok(decision.blockedRoot.endsWith(name), `${name} must resolve to its blocked root`);
      assert.match(fs.readFileSync(filePath, "utf8"), /legacy/, "guard must not monkey-patch existing V2 file access");
    }

    for (const sourceIdentifier of DEFAULT_BLOCKED_SOURCE_IDENTIFIERS) {
      assertDenied(testGuard.evaluate({
        kind: "fresh-store",
        path: freshFile,
        sourceIdentifier
      }), "preview_source_blocked");
    }

    assert.equal(testGuard.evaluate({
      kind: "test-fixture",
      path: fixtureFile,
      purpose: CONTRACT_PREVIEW_PURPOSE,
      sources: ["v2_history", "v2_run_output"]
    }).allowed, true);
    assertDenied(testGuard.evaluate({
      kind: "test-fixture",
      path: fixtureFile,
      purpose: "fresh-runtime"
    }), "fixture_purpose_blocked");
    assertDenied(testGuard.evaluate({
      kind: "test-fixture",
      path: path.join(projectRoot, "test", "other-fixture.json"),
      purpose: CONTRACT_PREVIEW_PURPOSE
    }), "fixture_path_blocked");
    assertDenied(testGuard.evaluate({
      kind: "test-fixture",
      path: path.join(escapeLink, "outside.json"),
      purpose: CONTRACT_PREVIEW_PURPOSE
    }), "fixture_path_blocked");

    const staticDecision = testGuard.evaluate({ kind: "static-asset", path: staticAsset });
    assert.equal(staticDecision.allowed, true);
    assert.equal(staticDecision.asset.version, validStaticEntry.version);
    assert.equal(staticDecision.asset.checksum, validStaticEntry.checksum);
    assertDenied(
      testGuard.evaluate({ kind: "static-asset", path: unlistedAsset }),
      "static_asset_not_allowlisted"
    );
    assertDenied(
      testGuard.evaluate({ kind: "static-asset", path: incompleteAsset }),
      "static_asset_not_allowlisted"
    );

    fs.appendFileSync(staticAsset, " ");
    assertDenied(
      testGuard.evaluate({ kind: "static-asset", path: staticAsset }),
      "static_asset_checksum_mismatch"
    );

    const productionGuard = createIntegrationDataAccessGuard({
      projectRoot,
      freshStoreRoot,
      fixtureRoots: [fixtureRoot],
      env: { NODE_ENV: "production" },
      staticAssetAllowlist: [validStaticEntry]
    });
    assertDenied(productionGuard.evaluate({
      kind: "test-fixture",
      path: fixtureFile,
      purpose: CONTRACT_PREVIEW_PURPOSE,
      sourceIdentifier: "v2_history"
    }), "fixture_environment_blocked");

    const renderGuard = createIntegrationDataAccessGuard({
      projectRoot,
      freshStoreRoot,
      fixtureRoots: [fixtureRoot],
      env: { NODE_ENV: "test", RENDER: "true" },
      staticAssetAllowlist: [validStaticEntry]
    });
    assert.equal(renderGuard.policy.environment, "production");
    assertDenied(renderGuard.evaluate({
      kind: "test-fixture",
      path: fixtureFile,
      purpose: CONTRACT_PREVIEW_PURPOSE
    }), "fixture_environment_blocked");

    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const spoofedTestGuard = createIntegrationDataAccessGuard({
        projectRoot,
        freshStoreRoot,
        fixtureRoots: [fixtureRoot],
        env: { NODE_ENV: "test" }
      });
      assert.equal(spoofedTestGuard.policy.environment, "production");
      assertDenied(spoofedTestGuard.evaluate({
        kind: "test-fixture",
        path: fixtureFile,
        purpose: CONTRACT_PREVIEW_PURPOSE
      }), "fixture_environment_blocked");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    assertDenied(
      testGuard.evaluate({ kind: "legacy-preview", path: freshFile }),
      "unknown_access_kind"
    );
    assert.throws(
      () => testGuard.assertAccess({ kind: "fresh-store", path: legacyFiles.history }),
      (error) => error.code === "INTEGRATION_DATA_ACCESS_DENIED"
        && error.decision.code === "legacy_path_blocked"
    );
    assert.throws(
      () => createIntegrationDataAccessGuard({
        projectRoot,
        freshStoreRoot: path.join(projectRoot, "data", "new-store")
      }),
      (error) => error.code === "INTEGRATION_DATA_ACCESS_GUARD_CONFIG_INVALID"
    );
    assert.throws(
      () => createIntegrationDataAccessGuard({ projectRoot }),
      (error) => error.code === "INTEGRATION_DATA_ACCESS_GUARD_CONFIG_INVALID"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("Stage 224 integration data access guard checks passed");
}

main();
