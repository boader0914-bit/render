"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const registry = require("../web/data/location_region_registry.json");
const { createLocationRegionMatcher } = require("./location_region_matcher.cjs");
const { createRegionInsightRuntime } = require("./region_insight_runtime.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const ADMIN_USER = "member-projection-admin";
const ADMIN_PASSWORD = "MemberProjectionAdmin!123";
const B2B_USER = "member-projection-b2b";
const B2B_PASSWORD = "MemberProjectionB2B!123";
const PUBLISHED_RUN_ID = "pocheon_glamping_20260805_090000";
const UNPUBLISHED_RUN_ID = "sancheong_glamping_20260805_091000";
const MISMATCH_RUN_ID = "unknown_glamping_20260805_092000";
const PRIVATE_SENTINELS = [
  "private-reviewer-actor",
  "PRIVATE_REVIEW_MEMO_V1",
  "PRIVATE_REVIEW_MEMO_V2",
  "PRIVATE_PUBLISH_MEMO_V1",
  "PRIVATE_PUBLISH_MEMO_V2",
  "PRIVATE_SANCHEONG_MEMO"
];
const PRIVATE_KEYS = new Set([
  "reviewer",
  "adminMemo",
  "draftHash",
  "reviewedDraftHash",
  "snapshotHash",
  "publicationHistory",
  "auditHistory",
  "history",
  "updatedBy",
  "publishedBy"
]);

const networkGuard = installFixtureNetworkGuard({
  allowLocalhost: true,
  label: "member projection E2E fixtures"
});

function assertNoPrivatePublicationData(value, location = "response") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivatePublicationData(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(PRIVATE_KEYS.has(key), false, `${location}.${key} exposed a private publication field`);
    assertNoPrivatePublicationData(nested, `${location}.${key}`);
  }
}

function assertNoPrivateSentinels(value, label) {
  const serialized = JSON.stringify(value);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `${label} leaked ${sentinel}`);
  }
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("fixture server health timeout");
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => server.child.once("exit", resolve));
}

async function holdBrowserFixtureServer(baseUrl) {
  console.log(`REGION_BROWSER_FIXTURE_READY ${JSON.stringify({
    baseUrl,
    adminUser: ADMIN_USER,
    adminPassword: ADMIN_PASSWORD,
    b2bUser: B2B_USER,
    b2bPassword: B2B_PASSWORD,
    publishedRunId: PUBLISHED_RUN_ID,
    unpublishedRunId: UNPUBLISHED_RUN_ID,
    mismatchRunId: MISMATCH_RUN_ID
  })}`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function safeChildEnvironment(overrides) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function spawnServer(port, runtimeRoot, networkGuardPath) {
  const child = spawn(process.execPath, ["--require", networkGuardPath, SERVER_PATH], {
    cwd: ROOT,
    env: safeChildEnvironment({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      RENDER: "",
      RENDER_SERVICE_NAME: "",
      RENDER_EXTERNAL_URL: "",
      RENDER_EXTERNAL_HOSTNAME: "",
      V2_PREVIEW_DATA_ROOT: runtimeRoot,
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: ADMIN_USER,
      GLAMPING_ADMIN_PASSWORD: ADMIN_PASSWORD,
      GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: B2B_USER,
      GLAMPING_B2B_PASSWORD: B2B_PASSWORD
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-8000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${pathname}, received: ${text.slice(0, 240)}`);
    }
  }
  return { response, body };
}

async function login(baseUrl, username, password) {
  const result = await jsonRequest(baseUrl, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "region-member-projection-e2e" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(result.response.status, 200, `login failed for ${username}`);
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/);
  return cookie;
}

function draftPayload(value, note) {
  return {
    locationAttractiveness: {
      value,
      modelVersion: "member-projection-location-v1",
      components: [
        { key: "market_demand", value, weight: 0.6, evidenceIds: ["fixture-demand"] },
        { key: "tourism_access", value: 70, weight: 0.4, evidenceIds: ["fixture-tourism"] }
      ]
    },
    dataQuality: {
      status: "partial",
      score: 78,
      grade: "B",
      penalties: [{ code: "fixture_partial", message: "fixture source partial", points: 8 }],
      coverage: { numerator: 14, denominator: 18, note },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05",
        updatedAt: "2026-08-05T00:00:00.000Z",
        ageDays: 0
      }
    }
  };
}

async function writeRun(outputsDir, runId, keyword, searchRegionKey) {
  const runDir = path.join(outputsDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, "report.md"), `# ${keyword} isolated fixture\n`, "utf8");
  await fsp.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify({
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    collectorVersion: "member-projection-fixture-v1",
    keyword,
    searchRegionKey,
    checkIn: "2026-08-07",
    checkOut: "2026-08-13",
    bookingRangeDays: 7,
    provinceKey: searchRegionKey.includes("gyeongnam") ? "gyeongnam" : "gyeonggi",
    collectionStartedAt: "2026-08-05T00:00:00.000Z",
    collectionCompletedAt: "2026-08-05T00:01:00.000Z",
    dataAvailableAt: "2026-08-05T00:01:00.000Z",
    fileRoles: { report: "report.md" },
    files: ["report.md"],
    counts: { naverOverall: 0, naverAds: 0, naverRegional: 0 }
  }, null, 2)}\n`, "utf8");
}

async function writeSearchHistory(runtimeRoot) {
  const customerDb = path.join(runtimeRoot, "customer_db");
  await fsp.mkdir(customerDb, { recursive: true });
  await fsp.writeFile(path.join(customerDb, "b2b_search_history.json"), `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-05T00:02:00.000Z",
    entries: [PUBLISHED_RUN_ID, UNPUBLISHED_RUN_ID, MISMATCH_RUN_ID].map((runId, index) => ({
      id: `member-history-${index + 1}`,
      runId,
      username: B2B_USER,
      status: "completed",
      createdAt: `2026-08-05T00:0${index + 3}:00.000Z`,
      completedAt: `2026-08-05T00:0${index + 3}:30.000Z`
    }))
  }, null, 2)}\n`, "utf8");
}

async function writeChildNetworkGuard(runtimeRoot) {
  const guardPath = path.join(runtimeRoot, "fixture_network_guard.cjs");
  const guardModulePath = path.join(ROOT, "scripts", "fixture_network_guard.cjs");
  const source = [
    '"use strict";',
    `require(${JSON.stringify(guardModulePath)}).installFixtureNetworkGuard({ allowLocalhost: true, label: "member projection child server" });`
  ].join("\n");
  await fsp.writeFile(guardPath, `${source}\n`, "utf8");
  return guardPath;
}

async function buildPublicationFixtures(runtimeRoot) {
  const matcher = createLocationRegionMatcher(registry);
  let tick = 0;
  const runtime = createRegionInsightRuntime({
    filePath: path.join(runtimeRoot, "region_insights", "regions.json"),
    registry,
    matcher,
    clock: () => new Date(Date.UTC(2026, 7, 5, 1, tick++)),
    idFactory: ({ regionKey, version }) => `fixture:${regionKey}:${version}`
  });
  const actor = { id: "private-reviewer-actor", displayName: "Private Reviewer" };

  const draftV1 = await runtime.saveDraft(
    "kr_gyeonggi_pocheon",
    draftPayload(73, "published fixture v1"),
    actor
  );
  const hashV1 = draftV1.regionInsight.state.draftHash;
  const reviewV1 = await runtime.reviewDraft("kr_gyeonggi_pocheon", {
    status: "reviewed",
    expectedDraftHash: hashV1,
    expectedWorkflowRevision: draftV1.regionInsight.workflowRevision,
    adminMemo: "PRIVATE_REVIEW_MEMO_V1"
  }, actor);
  const publicationV1 = await runtime.publishDraft("kr_gyeonggi_pocheon", {
    expectedDraftHash: hashV1,
    expectedWorkflowRevision: reviewV1.regionInsight.workflowRevision,
    version: "member-e2e-v1",
    adminMemo: "PRIVATE_PUBLISH_MEMO_V1"
  }, actor);

  const draftV2 = await runtime.saveDraft("kr_gyeonggi_pocheon", {
    ...draftPayload(68, "published fixture v2"),
    expectedDraftHash: hashV1,
    expectedWorkflowRevision: publicationV1.regionInsight.workflowRevision
  }, actor);
  const hashV2 = draftV2.regionInsight.state.draftHash;
  const reviewV2 = await runtime.reviewDraft("kr_gyeonggi_pocheon", {
    status: "reviewed",
    expectedDraftHash: hashV2,
    expectedWorkflowRevision: draftV2.regionInsight.workflowRevision,
    adminMemo: "PRIVATE_REVIEW_MEMO_V2"
  }, actor);
  const publicationV2 = await runtime.publishDraft("kr_gyeonggi_pocheon", {
    expectedDraftHash: hashV2,
    expectedWorkflowRevision: reviewV2.regionInsight.workflowRevision,
    version: "member-e2e-v2",
    adminMemo: "PRIVATE_PUBLISH_MEMO_V2"
  }, actor);

  const sancheongDraft = await runtime.saveDraft(
    "kr_gyeongnam_sancheong",
    draftPayload(57, "PRIVATE_SANCHEONG_MEMO"),
    actor
  );
  assert.equal(sancheongDraft.regionInsight.state.publication.status, "unpublished");
  assert.equal(publicationV2.regionInsight.publicationHistory.length, 2);
  assert.equal(publicationV2.regionInsight.publicationHistory[0].publication.status, "superseded");
  assert.equal(publicationV2.regionInsight.publicationHistory[1].publication.status, "published");

  return { runtime, hashV2, workflowRevision: publicationV2.regionInsight.workflowRevision };
}

async function memberRun(baseUrl, runId, cookie) {
  return jsonRequest(baseUrl, `/api/member/runs/${encodeURIComponent(runId)}`, {
    headers: { cookie, "user-agent": "region-member-projection-e2e" }
  });
}

async function assertPublishedHttpBoundary(baseUrl, adminCookie, b2bCookie) {
  const adminUserView = await memberRun(baseUrl, PUBLISHED_RUN_ID, adminCookie);
  const b2b = await memberRun(baseUrl, PUBLISHED_RUN_ID, b2bCookie);
  assert.equal(adminUserView.response.status, 200);
  assert.equal(b2b.response.status, 200);
  assert.deepEqual(adminUserView.body, b2b.body, "Admin User View and B2B must receive the same publicRunForRole(..., b2b) projection");
  assert.equal(b2b.body.regionContext.regionKey, "kr_gyeonggi_pocheon");
  assert.equal(b2b.body.regionContext.matchStatus, "matched");
  assert.equal(b2b.body.b2bRegionInsight.locationAttractiveness.value, 68);
  assert.equal(b2b.body.b2bRegionInsight.publication.status, "published");
  assert.equal(b2b.body.b2bRegionInsight.publication.version, "member-e2e-v2");
  assert.equal(Object.hasOwn(b2b.body, "regionInsight"), false);
  assert.equal(Object.hasOwn(b2b.body, "adminRegionalOperations"), false);
  assert.equal(Object.hasOwn(b2b.body, "b2bRegionReviewSummary"), false);
  assertNoPrivatePublicationData(b2b.body);
  assertNoPrivateSentinels(b2b.body, "published B2B response");

  const unpublished = await memberRun(baseUrl, UNPUBLISHED_RUN_ID, b2bCookie);
  assert.equal(unpublished.response.status, 200);
  assert.equal(unpublished.body.regionContext.regionKey, "kr_gyeongnam_sancheong");
  assert.equal(unpublished.body.regionContext.matchStatus, "matched");
  assert.equal(unpublished.body.b2bRegionInsight, null, "an unpublished draft must not cross the member boundary");
  assertNoPrivatePublicationData(unpublished.body);
  assertNoPrivateSentinels(unpublished.body, "unpublished B2B response");

  const mismatch = await memberRun(baseUrl, MISMATCH_RUN_ID, b2bCookie);
  assert.equal(mismatch.response.status, 200);
  assert.equal(mismatch.body.regionContext.matchStatus, "unmatched");
  assert.equal(mismatch.body.regionContext.regionKey, "");
  assert.equal(mismatch.body.b2bRegionInsight, null, "an explicit non-canonical region key must fail closed without another region fallback");
  assertNoPrivatePublicationData(mismatch.body);
  assertNoPrivateSentinels(mismatch.body, "mismatched B2B response");
}

async function assertReloadedStaleBoundary(baseUrl, adminCookie, b2bCookie) {
  const adminUserView = await memberRun(baseUrl, PUBLISHED_RUN_ID, adminCookie);
  const b2b = await memberRun(baseUrl, PUBLISHED_RUN_ID, b2bCookie);
  assert.equal(adminUserView.response.status, 200);
  assert.equal(b2b.response.status, 200);
  assert.deepEqual(adminUserView.body, b2b.body);
  assert.equal(b2b.body.b2bRegionInsight.publication.status, "stale");
  assert.equal(b2b.body.b2bRegionInsight.locationAttractiveness.value, 68, "stale projection must keep the last immutable published snapshot");
  assert.notEqual(b2b.body.b2bRegionInsight.locationAttractiveness.value, 41, "current draft must not replace the published snapshot");
  assertNoPrivatePublicationData(b2b.body);
  assertNoPrivateSentinels(b2b.body, "reloaded stale B2B response");

  const adminRecord = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon", {
    headers: { cookie: adminCookie, "user-agent": "region-member-projection-e2e" }
  });
  assert.equal(adminRecord.response.status, 200);
  assert.equal(adminRecord.body.regionInsight.state.locationAttractiveness.value, 41, "admin draft reload confirms this is not a cached first-server payload");
  assert.equal(adminRecord.body.regionInsight.state.publication.status, "stale");
  assert.equal(adminRecord.body.regionInsight.state.publication.snapshot.locationAttractiveness.value, 68);
  assert.equal(adminRecord.body.regionInsight.publicationHistory.length, 2, "server restart must reload the complete immutable publication history");
  assert.equal(adminRecord.body.regionInsight.publicationHistory[0].publication.status, "superseded");
  assert.equal(adminRecord.body.regionInsight.publicationHistory[1].publication.status, "stale");
  assert.deepEqual(
    adminRecord.body.regionInsight.publicationHistory.map((entry) => entry.version),
    ["member-e2e-v1", "member-e2e-v2"]
  );
}

async function main() {
  assert.match(
    SERVER_SOURCE,
    /\/api\/member\/runs\/[\s\S]*?publicRunForRole\(data, USER_ROLES\.b2b\)/,
    "member route, including Admin User View, must explicitly use the B2B projector"
  );

  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "region-member-projection-e2e-"));
  let firstServer = null;
  let secondServer = null;
  try {
    const outputsDir = path.join(runtimeRoot, "outputs");
    await Promise.all([
      writeRun(outputsDir, PUBLISHED_RUN_ID, "포천 글램핑", "kr_gyeonggi_pocheon"),
      writeRun(outputsDir, UNPUBLISHED_RUN_ID, "산청 글램핑", "kr_gyeongnam_sancheong"),
      writeRun(outputsDir, MISMATCH_RUN_ID, "포천 글램핑", "kr_unknown_missing"),
      writeSearchHistory(runtimeRoot)
    ]);
    const networkGuardPath = await writeChildNetworkGuard(runtimeRoot);
    const publicationFixture = await buildPublicationFixtures(runtimeRoot);

    const firstPort = await availablePort();
    const firstBaseUrl = `http://127.0.0.1:${firstPort}`;
    firstServer = spawnServer(firstPort, runtimeRoot, networkGuardPath);
    try {
      await waitForHealth(firstBaseUrl, firstServer.child);
      const adminCookie = await login(firstBaseUrl, ADMIN_USER, ADMIN_PASSWORD);
      const b2bCookie = await login(firstBaseUrl, B2B_USER, B2B_PASSWORD);
      await assertPublishedHttpBoundary(firstBaseUrl, adminCookie, b2bCookie);
      if (process.env.REGION_UI_E2E_HOLD === "1") {
        await holdBrowserFixtureServer(firstBaseUrl);
        return;
      }
    } catch (error) {
      const output = firstServer.output();
      error.message += `\nfirst server stdout=${output.stdout}\nfirst server stderr=${output.stderr}`;
      throw error;
    } finally {
      await stopServer(firstServer);
    }

    const changed = await publicationFixture.runtime.saveDraft("kr_gyeonggi_pocheon", {
      ...draftPayload(41, "current private draft must remain admin-only"),
      expectedDraftHash: publicationFixture.hashV2,
      expectedWorkflowRevision: publicationFixture.workflowRevision
    }, { id: "private-reviewer-actor", displayName: "Private Reviewer" });
    assert.equal(changed.regionInsight.state.publication.status, "stale");
    assert.equal(changed.regionInsight.state.publication.snapshot.locationAttractiveness.value, 68);
    assert.equal(changed.regionInsight.publicationHistory.length, 2);

    const secondPort = await availablePort();
    const secondBaseUrl = `http://127.0.0.1:${secondPort}`;
    secondServer = spawnServer(secondPort, runtimeRoot, networkGuardPath);
    try {
      await waitForHealth(secondBaseUrl, secondServer.child);
      const adminCookie = await login(secondBaseUrl, ADMIN_USER, ADMIN_PASSWORD);
      const b2bCookie = await login(secondBaseUrl, B2B_USER, B2B_PASSWORD);
      await assertReloadedStaleBoundary(secondBaseUrl, adminCookie, b2bCookie);
    } catch (error) {
      const output = secondServer.output();
      error.message += `\nsecond server stdout=${output.stdout}\nsecond server stderr=${output.stderr}`;
      throw error;
    } finally {
      await stopServer(secondServer);
    }

    console.log("Region member projection HTTP E2E passed (published, unpublished, mismatch, stale, restart reload; external network blocked)");
  } finally {
    await stopServer(firstServer).catch(() => {});
    await stopServer(secondServer).catch(() => {});
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
    assert.equal(networkGuard.blockedAttempts(), 0);
    networkGuard.restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
