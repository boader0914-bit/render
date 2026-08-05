"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  isRenderRuntime,
  isV2PreviewRuntime,
  normalizeIpAddress,
  projectB2BPublicPayload,
  trustedClientAddress
} = require("./runtime_security.cjs");

const networkGuard = installFixtureNetworkGuard({
  allowLocalhost: true,
  label: "server security fixtures"
});

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const SERVER_SOURCE = require("node:fs").readFileSync(SERVER_PATH, "utf8");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function safeChildEnvironment(overrides) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

async function writeChildPreload(runtimeRoot) {
  const preloadPath = path.join(runtimeRoot, "server_security_preload.cjs");
  const guardPath = path.join(ROOT, "scripts", "fixture_network_guard.cjs");
  const source = [
    '"use strict";',
    `require(${JSON.stringify(guardPath)}).installFixtureNetworkGuard({ allowLocalhost: true, label: "server security child" });`,
    'const crypto = require("node:crypto");',
    "const nativeRandomUUID = crypto.randomUUID.bind(crypto);",
    "crypto.randomUUID = (...args) => String(new Error().stack || '').includes('region_insight_runtime.cjs')",
    "  ? '00000000-0000-4000-8000-000000000001'",
    "  : nativeRandomUUID(...args);"
  ].join("\n");
  await fsp.writeFile(preloadPath, `${source}\n`, "utf8");
  return preloadPath;
}

function spawnServer(port, runtimeRoot, preloadPath) {
  const child = spawn(process.execPath, ["--require", preloadPath, SERVER_PATH], {
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
      GLAMPING_ADMIN_USER: "security-test-admin",
      GLAMPING_ADMIN_PASSWORD: "SecurityTestOnly!123",
      GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "security-test-b2b",
      GLAMPING_B2B_PASSWORD: "SecurityB2BOnly!123"
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-6000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-6000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("server health timeout");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function assertNoSensitiveKey(value) {
  if (Array.isArray(value)) return value.forEach(assertNoSensitiveKey);
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key, /password|token|cookie|headers|authorization|secret|credential|session|sourceKey|memberId/i);
    if (typeof nested === "string") {
      assert.doesNotMatch(nested, /(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|\/(?:var|home|users?|etc|proc|sys|run|tmp)(?:\/|$)|file:\/\/)/i);
    }
    assertNoSensitiveKey(nested);
  }
}

async function main() {
  assert.match(SERVER_SOURCE, /classifyCollectorProcessFailure\(\{ stderr, stdout, exitCode: code \}\)/, "collector failures are classified before crossing the API boundary");
  assert.doesNotMatch(SERVER_SOURCE, /new Error\(stderr \|\| stdout/, "raw collector stderr cannot become a public Error message");
  assert.match(SERVER_SOURCE, /const publicFailure = publicErrorPayload\(error\)/, "the final JSON error boundary is fail-closed");
  assert.match(SERVER_SOURCE, /stderr = \(stderr \+ chunk\.toString\("utf8"\)\)\.slice\(-64 \* 1024\)/, "collector stderr retention is bounded");
  assert.match(SERVER_SOURCE, /updateSecureJsonFile\(B2B_MEMBERS_FILE/);
  assert.match(SERVER_SOURCE, /updateSecureJsonFile\(B2B_SEARCH_HISTORY_FILE/);
  assert.match(SERVER_SOURCE, /updateSecureJsonFile\(B2B_INTEREST_LODGES_FILE/);
  assert.match(SERVER_SOURCE, /updateSecureJsonFile\(ACCOUNT_DELETE_REQUESTS_FILE/);
  assert.match(SERVER_SOURCE, /updateSecureJsonFile\(TRAFFIC_KEYS_FILE/);
  assert.doesNotMatch(SERVER_SOURCE, /`\$\{(?:B2B_MEMBERS_FILE|B2B_SEARCH_HISTORY_FILE|B2B_INTEREST_LODGES_FILE|ACCOUNT_DELETE_REQUESTS_FILE)\}\.\$\{process\.pid\}\.tmp`/);
  assert.match(SERVER_SOURCE, /accountDeleteRateLimitIdentities\(payload, session\)[\s\S]{0,500}identityOnly:\s*true/);
  assert.equal(normalizeIpAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIpAddress("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIpAddress("2001:0db8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeIpAddress("not-an-ip"), "");
  assert.equal(isRenderRuntime({ RENDER: "false" }), false);
  assert.equal(isRenderRuntime({ RENDER: "0" }), false);
  assert.equal(isRenderRuntime({ RENDER: "false", RENDER_SERVICE_NAME: "lodging-datalab-preview" }), true, "exact Preview metadata remains a fail-closed runtime identity");
  assert.equal(isRenderRuntime({ RENDER: "true" }), true);
  assert.equal(isV2PreviewRuntime({ RENDER_SERVICE_NAME: "lodging-datalab-preview" }), true, "exact service metadata identifies Preview alone");
  assert.equal(isV2PreviewRuntime({ RENDER_EXTERNAL_HOSTNAME: "sa-labs-datalab-v4-preview.onrender.com" }), true, "exact host metadata identifies Preview alone");
  const localRequest = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "::ffff:127.0.0.1" } };
  assert.equal(trustedClientAddress(localRequest, { env: { RENDER: "false" } }), "127.0.0.1", "local runtime ignores spoofable XFF");
  const renderRequestA = { headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.20" }, socket: { remoteAddress: "10.0.0.4" } };
  const renderRequestB = { headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.20" }, socket: { remoteAddress: "10.0.0.4" } };
  const renderEnv = {
    RENDER: "true",
    RENDER_SERVICE_NAME: "lodging-datalab-preview",
    RENDER_EXTERNAL_HOSTNAME: "sa-labs-datalab-v4-preview.onrender.com"
  };
  assert.equal(trustedClientAddress(renderRequestA, { env: renderEnv }), "198.51.100.20");
  assert.equal(trustedClientAddress(renderRequestB, { env: renderEnv }), "198.51.100.20", "changing first XFF cannot change trusted address");
  assert.equal(trustedClientAddress(renderRequestA, { env: { RENDER: "true" } }), "10.0.0.4", "a boolean marker alone is not an exact proxy boundary");
  assert.equal(trustedClientAddress(renderRequestA, { env: { RENDER: "false", RENDER_SERVICE_NAME: "lodging-datalab-preview" } }), "198.51.100.20", "exact Preview metadata retains its trusted proxy boundary");
  assert.equal(trustedClientAddress(renderRequestA, { env: { RENDER: "false", RENDER_SERVICE_NAME: "untrusted-local-name" } }), "10.0.0.4");
  assert.equal(trustedClientAddress({ headers: { "x-forwarded-for": "bad" }, socket: { remoteAddress: "10.0.0.4" } }, { env: renderEnv }), "10.0.0.4");

  const publicPayload = projectB2BPublicPayload({
    run: {
      id: "run-1",
      keyword: "fixture",
      counts: { naverOverall: 4, nolFirstPage: 2, unknownFutureCount: 99 },
      token: "drop",
      files: { report: "drop" },
      collectionDbRoute: {
        key: "revenue_detail",
        label: "상세정보",
        note: "fixture route",
        targets: ["company_master.inventory", "history.observations"],
        appliesMasterBasic: true,
        appliesInventory: true,
        appliesHistory: true,
        appliesDemandLocation: false,
        credential: "drop",
        internalPath: "/var/data/private.json"
      }
    },
    availability: {
      stats: {
        checkedPlaces: 1,
        byType: {
          glamping: 1,
          password: 7,
          unknownFutureCount: 3,
          "../../private": 2,
          caravan: Number.POSITIVE_INFINITY
        },
        credential: "drop"
      },
      items: [{
        name: "Fixture Lodge",
        companyId: "company-public-1",
        companyProfile: {
          companyId: "company-public-1",
          primaryName: "Fixture Lodge",
          regions: ["가평"],
          addresses: ["경기 가평군"],
          primaryCategoryKey: "glamping",
          categoryTags: ["glamping"],
          location: {
            status: "verified",
            statusLabel: "검증 위치",
            source: "manual",
            precision: "rooftop",
            confidence: 1,
            crs: "EPSG:4326",
            lat: 37.1,
            lon: 127.2,
            resolvedAddress: "경기 가평군 fixture 1",
            displayAddress: "경기 가평군 fixture 1",
            geocodedAt: "2026-08-03T00:00:00.000Z",
            providerKey: "drop",
            addressFingerprint: "drop",
            rawProviderResponse: { secret: "drop" },
            unknownFutureLocationField: "drop"
          },
          resolvedAddress: "must stay private outside location",
          precision: "must stay private outside location",
          passwordHash: "drop"
        },
        price: "100000",
        primaryCategoryKey: "glamping",
        verifiedCorrectionApplied: true,
        verifiedLodgingBasisTotal: 8,
        verifiedRoomSegments: [{ type: "glamping", count: 8, weekdayPrice: 120000 }],
        itemDetails: [{ bizItemId: "room-1", name: "Room 1", saleType: "lodging", stock: 8, available: 3 }],
        headers: { cookie: "drop" },
        note: "/var/data/v2-preview-runtime/private.json",
        description: "internal source /var/data/v2-preview-runtime/hidden.json",
        unknownFutureField: "drop"
      }]
    },
    companyMaster: { companies: [{ passwordHash: "drop" }] },
    unknownTopLevel: { value: "drop" }
  });
  assert.equal(publicPayload.run.id, "run-1");
  assert.deepEqual(publicPayload.run.counts, { naverOverall: 4, nolFirstPage: 2 }, "reviewed manifest count fields remain compatible");
  assert.deepEqual(publicPayload.run.collectionDbRoute, {
    key: "revenue_detail",
    label: "상세정보",
    note: "fixture route",
    targets: ["company_master.inventory", "history.observations"],
    appliesMasterBasic: true,
    appliesInventory: true,
    appliesHistory: true,
    appliesDemandLocation: false
  }, "collection DB route fields consumed by the UI remain public");
  assert.equal(publicPayload.availability.items[0].name, "Fixture Lodge");
  assert.deepEqual(publicPayload.availability.items[0].companyProfile, {
    companyId: "company-public-1",
    primaryName: "Fixture Lodge",
    regions: ["가평"],
    addresses: ["경기 가평군"],
    primaryCategoryKey: "glamping",
    categoryTags: ["glamping"],
    location: {
      status: "verified",
      statusLabel: "검증 위치",
      source: "manual",
      precision: "rooftop",
      confidence: 1,
      crs: "EPSG:4326",
      lat: 37.1,
      lon: 127.2,
      resolvedAddress: "경기 가평군 fixture 1",
      displayAddress: "경기 가평군 fixture 1",
      geocodedAt: "2026-08-03T00:00:00.000Z"
    }
  }, "reviewed public company identity and category fields remain available to the B2B UI");
  assert.equal("resolvedAddress" in publicPayload.availability.items[0].companyProfile, false, "location metadata names are not globally allowlisted");
  assert.equal("precision" in publicPayload.availability.items[0].companyProfile, false, "location precision is scoped to the location object");
  assert.equal("providerKey" in publicPayload.availability.items[0].companyProfile.location, false, "provider identity remains private");
  assert.equal("addressFingerprint" in publicPayload.availability.items[0].companyProfile.location, false, "address fingerprints remain private");
  assert.equal("rawProviderResponse" in publicPayload.availability.items[0].companyProfile.location, false, "raw provider payloads remain private");
  assert.equal(publicPayload.availability.items[0].verifiedCorrectionApplied, true, "reviewed B2B correction remains public");
  assert.equal(publicPayload.availability.items[0].verifiedRoomSegments[0].weekdayPrice, 120000);
  assert.equal(publicPayload.availability.items[0].itemDetails[0].bizItemId, "room-1");
  assert.equal(publicPayload.availability.stats.byType.glamping, 1);
  assert.deepEqual(publicPayload.availability.stats.byType, { glamping: 1 }, "numeric maps reject forbidden, unknown, path-like, and non-finite entries");
  assert.deepEqual(projectB2BPublicPayload({ stats: { byType: [1, 2] } }).stats.byType, {}, "numeric maps reject arrays");
  assert.deepEqual(projectB2BPublicPayload({ stats: { byType: "glamping" } }).stats.byType, {}, "numeric maps reject scalar values");
  assert.equal("note" in publicPayload.availability.items[0], false, "local filesystem values are excluded even under an allowlisted field");
  assert.equal("description" in publicPayload.availability.items[0], false, "embedded local filesystem values are excluded too");
  assert.deepEqual(projectB2BPublicPayload(null), {});
  assert.deepEqual(projectB2BPublicPayload("not-an-object"), {});
  assert.deepEqual(projectB2BPublicPayload([publicPayload]), {});
  assert.equal("companyMaster" in publicPayload, false);
  assert.equal("unknownTopLevel" in publicPayload, false);
  assert.equal("unknownFutureField" in publicPayload.availability.items[0], false);
  assertNoSensitiveKey(publicPayload);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-security-contract-"));
  const memberFile = path.join(tempRoot, "customer_db", "b2b_members.json");
  await fsp.mkdir(path.dirname(memberFile), { recursive: true });
  const memberFixture = {
    schemaVersion: 1,
    members: [{
      memberId: "member_internal_fixture",
      username: "known-user",
      accountType: "member",
      profile: { companyName: "Internal Company", email: "internal@example.invalid" },
      passwordHash: "not-used-by-this-test"
    }]
  };
  await fsp.writeFile(memberFile, JSON.stringify(memberFixture, null, 2), "utf8");
  const originalMemberText = await fsp.readFile(memberFile, "utf8");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const childPreload = await writeChildPreload(tempRoot);
  const server = spawnServer(port, tempRoot, childPreload);

  try {
    await waitForHealth(baseUrl, server.child);
    const anonymousHealth = await jsonRequest(baseUrl, "/api/health");
    assert.deepEqual(anonymousHealth.body, { ok: true, loginRequired: true });

    const anonymousRegionInsight = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon");
    assert.equal(anonymousRegionInsight.response.status, 401, "region insight APIs require authentication");

    const b2bLogin = await jsonRequest(baseUrl, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "security-contract-test" },
      body: JSON.stringify({ username: "security-test-b2b", password: "SecurityB2BOnly!123" })
    });
    assert.equal(b2bLogin.response.status, 200);
    const b2bCookie = String(b2bLogin.response.headers.get("set-cookie") || "").split(";")[0];
    const b2bRegionInsight = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon", {
      headers: { cookie: b2bCookie, "user-agent": "security-contract-test" }
    });
    assert.equal(b2bRegionInsight.response.status, 403, "B2B sessions cannot read the admin region workbench API");
    for (const action of ["review", "publish"]) {
      const forbiddenMutation = await jsonRequest(baseUrl, `/api/region-insights/kr_gyeonggi_pocheon/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: b2bCookie, "user-agent": "security-contract-test" },
        body: JSON.stringify({ expectedWorkflowRevision: 0 })
      });
      assert.equal(forbiddenMutation.response.status, 403, `B2B sessions cannot call the admin ${action} API`);
    }

    const login = await jsonRequest(baseUrl, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "security-contract-test" },
      body: JSON.stringify({ username: "security-test-admin", password: "SecurityTestOnly!123" })
    });
    assert.equal(login.response.status, 200);
    const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^glamping_datalab_session=/);
    const authenticatedHealth = await jsonRequest(baseUrl, "/api/health", {
      headers: { cookie, "user-agent": "security-contract-test" }
    });
    assert.deepEqual(authenticatedHealth.body, anonymousHealth.body, "health shape is independent of authentication");

    const emptyRegionInsight = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon", {
      headers: { cookie, "user-agent": "security-contract-test" }
    });
    assert.equal(emptyRegionInsight.response.status, 200);
    assert.equal(emptyRegionInsight.body.regionInsight, null);
    const invalidRegionInsight = await jsonRequest(baseUrl, "/api/region-insights/kr_unknown_missing", {
      headers: { cookie, "user-agent": "security-contract-test" }
    });
    assert.equal(invalidRegionInsight.response.status, 400);
    const missingDraftReview = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeongnam_sancheong/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({ status: "reviewed", expectedWorkflowRevision: 0, expectedDraftHash: "0".repeat(64) })
    });
    assert.equal(missingDraftReview.response.status, 404);
    assert.equal(missingDraftReview.body.code, "REGION_DRAFT_NOT_FOUND");

    const regionDraftPayload = {
      locationAttractiveness: {
        value: 73,
        modelVersion: "security-http-fixture-v1",
        components: [{ key: "market_demand", value: 73, weight: 1, evidenceIds: ["fixture-demand"] }]
      },
      dataQuality: {
        status: "partial",
        score: 78,
        grade: "B",
        penalties: [{ code: "ota_partial", message: "OTA 일부", points: 8 }],
        coverage: { numerator: 4, denominator: 6, note: "fixture coverage" },
        freshness: { status: "fresh", asOf: "2026-08-05", updatedAt: "2026-08-05T00:00:00.000Z", ageDays: 0 }
      }
    };
    const savedRegionDraft = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/draft", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify(regionDraftPayload)
    });
    assert.equal(savedRegionDraft.response.status, 200);
    const regionDraftHash = savedRegionDraft.body.regionInsight?.state?.draftHash;
    assert.match(regionDraftHash, /^[a-f0-9]{64}$/);
    assert.equal(savedRegionDraft.body.regionInsight?.workflowRevision, 1);
    const missingRevisionReview = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({ status: "reviewed", expectedDraftHash: regionDraftHash })
    });
    assert.equal(missingRevisionReview.response.status, 409);
    assert.equal(missingRevisionReview.body.code, "REGION_WORKFLOW_REVISION_REQUIRED");
    const conflictingRevisionReview = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({ status: "reviewed", expectedDraftHash: regionDraftHash, expectedWorkflowRevision: 0 })
    });
    assert.equal(conflictingRevisionReview.response.status, 409);
    assert.equal(conflictingRevisionReview.body.code, "REGION_WORKFLOW_REVISION_CONFLICT");
    const missingHashReview = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({ status: "reviewed", expectedWorkflowRevision: 1 })
    });
    assert.equal(missingHashReview.response.status, 409);
    const reviewedRegionDraft = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({
        status: "reviewed",
        expectedDraftHash: regionDraftHash,
        expectedWorkflowRevision: 1,
        adminMemo: "private-review-note"
      })
    });
    assert.equal(reviewedRegionDraft.response.status, 200);
    const missingVersionPublish = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/publish", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({ expectedDraftHash: regionDraftHash, expectedWorkflowRevision: 2 })
    });
    assert.equal(missingVersionPublish.response.status, 400);
    const publishedRegionDraft = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/publish", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({
        expectedDraftHash: regionDraftHash,
        expectedWorkflowRevision: 2,
        version: "security-http-v1",
        adminMemo: "private-publish-note"
      })
    });
    assert.equal(publishedRegionDraft.response.status, 200);
    assert.equal(publishedRegionDraft.body.regionInsight?.state?.publication?.status, "published");
    const duplicateVersionPublish = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeonggi_pocheon/publish", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({
        expectedDraftHash: regionDraftHash,
        expectedWorkflowRevision: 3,
        version: "security-http-v1"
      })
    });
    assert.equal(duplicateVersionPublish.response.status, 409);
    assert.equal(duplicateVersionPublish.body.code, "REGION_PUBLICATION_VERSION_CONFLICT");

    const secondRegionDraft = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeongnam_sancheong/draft", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify(regionDraftPayload)
    });
    assert.equal(secondRegionDraft.response.status, 200);
    const secondRegionHash = secondRegionDraft.body.regionInsight?.state?.draftHash;
    const secondRegionReview = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeongnam_sancheong/review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({
        status: "reviewed",
        expectedDraftHash: secondRegionHash,
        expectedWorkflowRevision: 1
      })
    });
    assert.equal(secondRegionReview.response.status, 200);
    const duplicatePublicationId = await jsonRequest(baseUrl, "/api/region-insights/kr_gyeongnam_sancheong/publish", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify({
        expectedDraftHash: secondRegionHash,
        expectedWorkflowRevision: 2,
        version: "security-http-sancheong-v1"
      })
    });
    assert.equal(duplicatePublicationId.response.status, 409);
    assert.equal(duplicatePublicationId.body.code, "REGION_PUBLICATION_ID_CONFLICT");

    const hardening = await jsonRequest(baseUrl, "/api/security-hardening", {
      headers: { cookie, "user-agent": "security-contract-test" }
    });
    assert.equal(hardening.response.status, 200);
    assert.ok(hardening.body.dataStorage && typeof hardening.body.dataStorage === "object");
    assert.doesNotMatch(JSON.stringify(hardening.body.dataStorage), /customer_db|\.json|\\|\/var\/|storageFile|storagePath/i);
    assert.equal("storage" in (hardening.body.accountDeleteLog || {}), false, "account deletion diagnostics do not expose a storage path");
    assert.deepEqual(
      hardening.body.roleSeparation?.previewAdminConditionalApis,
      [{
        path: "/api/b2b-map/geocode",
        roles: ["b2b", "admin"],
        adminRequirements: ["v2-preview-runtime", "admin-user-view", "explicit-consent", "organic-top-20", "max-18", "once-per-runtime-run"]
      }],
      "security diagnostics must disclose the narrowly scoped Preview admin geocoding exception"
    );
    assert.equal(
      hardening.body.roleSeparation?.b2bOnlyApis?.includes("/api/b2b-map/geocode"),
      false,
      "conditionally shared Preview endpoint must not be reported as B2B-only"
    );

    const trafficStatus = await jsonRequest(baseUrl, "/api/settings/traffic-keys", {
      headers: { cookie, "user-agent": "security-contract-test" }
    });
    assert.equal(trafficStatus.response.status, 200);
    assert.doesNotMatch(JSON.stringify(trafficStatus.body), /configDir|\.json|masked|\/var\/|customer_db/i);
    for (const field of Object.values(trafficStatus.body.fields || {})) {
      assert.deepEqual(Object.keys(field), ["configured"], "credential status exposes only configured state");
    }

    const deletePayload = (username, contact) => ({
      username,
      contact,
      companyName: "Submitted Company",
      requestType: "account_delete",
      detail: "fixture request",
      confirmRequest: "1"
    });
    const known = await jsonRequest(baseUrl, "/api/account-delete-request", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77, 198.51.100.20" },
      body: JSON.stringify(deletePayload("known-user", "known-contact@example.invalid"))
    });
    const unknown = await jsonRequest(baseUrl, "/api/account-delete-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deletePayload("unknown-user", "unknown-contact@example.invalid"))
    });
    assert.equal(known.response.status, 200);
    assert.equal(unknown.response.status, 200);
    assert.deepEqual(Object.keys(known.body.request).sort(), Object.keys(unknown.body.request).sort(), "known and unknown accounts use the same receipt shape");
    assert.deepEqual(Object.keys(known.body.request).sort(), ["requestId", "requestType", "requestTypeLabel", "status", "statusLabel"].sort());
    for (const response of [known.body, unknown.body]) {
      assert.equal(response.ok, true);
      assert.equal(response.request.status, "received");
      assert.equal("memberId" in response.request, false);
      assert.equal("accountType" in response.request, false);
      assert.equal("companyName" in response.request, false);
    }

    const authenticatedDelete = await jsonRequest(baseUrl, "/api/account-delete-request", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": "security-contract-test" },
      body: JSON.stringify(deletePayload("forged-target", "admin-contact@example.invalid"))
    });
    assert.equal(authenticatedDelete.response.status, 200);

    const deleteStorePath = path.join(tempRoot, "customer_db", "account_delete_requests.json");
    const deleteStore = JSON.parse(await fsp.readFile(deleteStorePath, "utf8"));
    const deleteStoreText = JSON.stringify(deleteStore);
    assert.doesNotMatch(deleteStoreText, /203\.0\.113\.77|198\.51\.100\.20|127\.0\.0\.1|::1/, "raw client addresses are not persisted");
    const knownStored = deleteStore.requests.find((entry) => entry.username === "known-user");
    const unknownStored = deleteStore.requests.find((entry) => entry.username === "unknown-user");
    const authenticatedStored = deleteStore.requests.find((entry) => entry.username === "security-test-admin");
    for (const stored of [knownStored, unknownStored]) {
      assert.ok(stored, "anonymous request stored for manual verification");
      assert.equal(stored.memberId, "");
      assert.equal(stored.accountType, "");
      assert.equal(stored.companyName, "");
      assert.equal(stored.identityVerified, false);
    }
    assert.ok(authenticatedStored, "authenticated request uses session username");
    assert.equal(authenticatedStored.identityVerified, true);
    assert.equal(deleteStore.requests.some((entry) => entry.username === "forged-target"), false, "payload cannot retarget authenticated request");
    assert.equal(await fsp.readFile(memberFile, "utf8"), originalMemberText, "member fixture remains unchanged");

    let limitedResponse;
    for (let index = 0; index < 10; index += 1) {
      limitedResponse = await jsonRequest(baseUrl, "/api/account-delete-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deletePayload("repeat-user", "repeat@example.invalid"))
      });
      if (limitedResponse.response.status === 429) break;
    }
    assert.equal(limitedResponse.response.status, 429, "repeated anonymous deletion requests are rate limited");
  } catch (error) {
    const output = server.output();
    error.message += `\nserver stdout=${output.stdout}\nserver stderr=${output.stderr}`;
    throw error;
  } finally {
    await stopChild(server.child).catch(() => {});
    const resolvedRoot = path.resolve(tempRoot);
    const relative = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`unsafe temp cleanup: ${resolvedRoot}`);
    await fsp.rm(resolvedRoot, { recursive: true, force: true });
    assert.equal(networkGuard.blockedAttempts(), 0);
    networkGuard.restore();
  }

  console.log("Server fail-closed, privacy, enumeration, IP trust, and B2B allowlist tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
