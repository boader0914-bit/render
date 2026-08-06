"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "NAVER legacy limited activation crawler fixtures" });
const ROOT = path.resolve(__dirname, "..");
const CRAWLER = path.join(__dirname, "gyeongnam_glamping_crawl.cjs");
const PRELOAD = path.join(__dirname, "naver_legacy_limited_activation_fixture_preload.cjs");

function childEnvironment(root, mode, stamp, auditFile) {
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${PRELOAD.replace(/\\/gu, "/")}`].filter(Boolean).join(" "),
    NODE_ENV: "test",
    CHECK_IN: "2026-08-06",
    CHECK_OUT: "2026-08-06",
    SEARCH_MODE: "keyword",
    SEARCH_INTENT: "region_category",
    SEARCH_INTENT_CONFIDENCE: "1",
    LODGING_CATEGORY_KEY: "glamping",
    SEARCH_REGION_KEY: "gyeongnam",
    SEARCH_REGION_QUERY: "경남",
    SEARCH_CANDIDATE_MODE: "keyword",
    SEARCH_CANDIDATE_QUERY: "경남 글램핑",
    COLLECTION_MODE: "fast",
    COLLECTION_PURPOSE: "revenue_detail",
    DETAIL_RANK_RANGES: "",
    PRODUCT_MODE: "all",
    BOOKING_RANGE_DAYS: "1",
    BOOKING_RANGE_PLACE_LIMIT: "0",
    SOURCE_ROLE: "admin",
    COLLECTION_SOURCE: "admin_search",
    COLLECTION_SOURCE_LABEL: "관리자 수집",
    REQUESTED_COLLECTION_MODE: "precision",
    REQUESTED_COLLECTION_PURPOSE: "revenue_detail",
    NAVER_LEGACY_LIMITED_ACTIVATION: "1",
    NAVER_COLLECTOR_STRATEGY: "legacy_candidate",
    NAVER_COLLECTOR_SCOPE: "main_place_only",
    NAVER_LIMITED_ACTIVATION_PROFILE: "preview-admin-keyword-fast-main-place.v1",
    NAVER_PROVIDER_CALL_BUDGET: "1",
    NAVER_AUTOMATIC_RETRY: "0",
    NAVER_AUTOMATIC_FALLBACK: "0",
    RUN_STAMP: stamp,
    DATA_DIR: root,
    OUTPUTS_DIR: path.join(root, "outputs"),
    CONFIG_DIR: path.join(root, "config"),
    NAVER_LIMITED_FIXTURE_MODE: mode,
    NAVER_LIMITED_FIXTURE_AUDIT_FILE: auditFile
  };
}

function runFixture(root, mode, stamp) {
  const auditFile = path.join(root, `audit-${mode}-${stamp}.json`);
  const child = spawnSync(process.execPath, [CRAWLER, "경남 글램핑"], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnvironment(root, mode, stamp, auditFile),
    timeout: 120_000,
    windowsHide: true
  });
  const audit = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, "utf8")) : null;
  return { child, audit };
}

function runDirectories(root) {
  const outputs = path.join(root, "outputs");
  if (!fs.existsSync(outputs) || !fs.statSync(outputs).isDirectory()) return [];
  return fs.readdirSync(outputs).filter((name) => fs.statSync(path.join(outputs, name)).isDirectory());
}

(async () => {
  const roots = [];
  try {
    const successRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-limited-success-"));
    roots.push(successRoot);
    const success = runFixture(successRoot, "success", "20260806_120000");
    assert.equal(success.child.status, 0, success.child.stderr || success.child.stdout);
    assert.deepEqual(success.audit, {
      callCount: 1,
      hostname: "pcmap.place.naver.com",
      pathname: "/accommodation/list",
      method: "GET"
    });
    const successRuns = runDirectories(successRoot);
    assert.equal(successRuns.length, 1, "one successful run must be atomically published");
    assert.doesNotMatch(successRuns[0], /\.pending-/u);
    const runDir = path.join(successRoot, "outputs", successRuns[0]);
    const manifest = JSON.parse(await fsp.readFile(path.join(runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.outputDir, runDir);
    assert.equal(manifest.collectorStrategy, "legacy_candidate");
    assert.equal(manifest.collectorStrategyVersion, "legacy-candidate.4e4e190.v1");
    assert.equal(manifest.collectorScope, "main_place_only");
    assert.equal(manifest.collectionMode, "fast");
    assert.equal(manifest.collectionProfile, "fast_rank");
    assert.equal(manifest.requestedCollectionMode, "precision");
    assert.equal(manifest.naverKeyword, "경상남도 글램핑");
    assert.equal(manifest.providerCallBudget, 1);
    assert.equal(manifest.providerRequestCount, 1);
    assert.equal(manifest.automaticRetry, false);
    assert.equal(manifest.automaticFallback, false);
    assert.equal(manifest.saveRunOnSuccessOnly, true);
    assert.equal(manifest.counts.naverOverall, 50);
    assert.equal(manifest.counts.naverRegional, 0);
    assert.equal(manifest.counts.naverBookingStockChecked, 0);
    assert.equal(manifest.counts.nolFirstPage, 0);
    assert.equal(manifest.counts.ddnayo, 0);
    for (const file of [...manifest.files, "manifest.json"]) {
      assert.equal(fs.existsSync(path.join(runDir, file)), true, `missing successful run file ${file}`);
    }
    const overallCsv = await fsp.readFile(path.join(runDir, manifest.fileRoles.overall), "utf8");
    assert.match(overallCsv, /"'=HYPERLINK\(""https:\/\/fixture\.invalid"",""Synthetic""\)"/u);
    assert.match(overallCsv, /"'@SUM\(1,1\)"/u);
    assert.doesNotMatch(overallCsv, /(?:^|,)=HYPERLINK|(?:^|,)@SUM/u);

    for (const [mode, expectedCode] of [
      ["http_403", "NAVER_ACCESS_BLOCKED"],
      ["http_429", "NAVER_ACCESS_BLOCKED"],
      ["challenge", "NAVER_ACCESS_BLOCKED"],
      ["malformed", "NAVER_APOLLO_STATE_INVALID"]
    ]) {
      const failureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `naver-limited-${mode}-`));
      roots.push(failureRoot);
      const failure = runFixture(failureRoot, mode, "20260806_120100");
      assert.notEqual(failure.child.status, 0, `${mode} must fail closed`);
      assert.equal(failure.audit?.callCount, 1, `${mode} must not retry`);
      assert.equal(runDirectories(failureRoot).length, 0, `${mode} must not publish a run or staging directory`);
      assert.match(`${failure.child.stdout}\n${failure.child.stderr}`, new RegExp(`"code":"${expectedCode}"`, "u"));
      assert.doesNotMatch(`${failure.child.stdout}\n${failure.child.stderr}`, /경상남도 글램핑|pcmap\.place\.naver\.com\/accommodation\/list\?query=/u);
    }

    const writeFailureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-limited-write-failure-"));
    roots.push(writeFailureRoot);
    await fsp.writeFile(path.join(writeFailureRoot, "outputs"), "not-a-directory", "utf8");
    const writeFailure = runFixture(writeFailureRoot, "success", "20260806_120200");
    assert.notEqual(writeFailure.child.status, 0, "a local write failure must not become a successful run");
    assert.equal(writeFailure.audit?.callCount, 1);
    assert.deepEqual(runDirectories(writeFailureRoot), []);

    assert.equal(guard.blockedAttempts(), 0, "the parent fixture must not perform external network requests");
    console.log("NAVER legacy limited activation crawler fixtures passed.");
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
