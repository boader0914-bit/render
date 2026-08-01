"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const ADMIN_USERNAME = "sensitive-store-admin";
const ADMIN_PASSWORD = "SensitiveStoreTest!123";
const TEST_PASSWORD = "Integration1!";

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

function spawnServer(port, runtimeRoot) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      RENDER: "",
      RENDER_SERVICE_NAME: "",
      RENDER_EXTERNAL_URL: "",
      RENDER_EXTERNAL_HOSTNAME: "",
      V2_PREVIEW_DATA_ROOT: runtimeRoot,
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: ADMIN_USERNAME,
      GLAMPING_ADMIN_PASSWORD: ADMIN_PASSWORD,
      GLAMPING_B2B_ENABLED: "0",
      GLAMPING_B2B_USER: "",
      GLAMPING_B2B_PASSWORD: "",
      NAVER_CLIENT_ID: "",
      NAVER_CLIENT_SECRET: "",
      NAVER_SEARCHAD_API_KEY: "",
      NAVER_SEARCHAD_SECRET_KEY: "",
      NAVER_SEARCHAD_CUSTOMER_ID: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-8000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before health check: ${child.exitCode}`);
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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const url = new URL(pathname, baseUrl);
  assert.equal(url.origin, baseUrl, "integration test requests must remain on the isolated localhost server");
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON from ${pathname}, received status ${response.status}`);
    }
  }
  return { response, body };
}

function signupPayload(username) {
  return {
    username,
    password: TEST_PASSWORD,
    passwordConfirm: TEST_PASSWORD,
    phone: "010-0000-0000",
    email: `${username}@example.invalid`,
    companyName: `${username} fixture company`,
    ownershipStatus: "owned",
    agreeTerms: "1",
    agreePrivacy: "1",
    confirmAge: "1"
  };
}

async function signup(baseUrl, username) {
  const result = await jsonRequest(baseUrl, "/api/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "sensitive-store-integration-test"
    },
    body: JSON.stringify(signupPayload(username))
  });
  const cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  return { ...result, cookie };
}

async function assertPrivateMode(filePath) {
  if (process.platform === "win32") return;
  const mode = (await fsp.stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600, `${path.basename(filePath)} must be stored with mode 0600`);
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-sensitive-store-integration-"));
  const customerDbDir = path.join(tempRoot, "customer_db");
  const configDir = path.join(tempRoot, "config");
  const memberFile = path.join(customerDbDir, "b2b_members.json");
  const interestFile = path.join(customerDbDir, "b2b_interest_lodges.json");
  const credentialFile = path.join(configDir, "traffic_api_keys.local.json");
  await fsp.mkdir(customerDbDir, { recursive: true });
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(memberFile, JSON.stringify({
    schemaVersion: 1,
    unknownRootField: { preserve: "root-value" },
    updatedAt: "",
    members: [{
      memberId: "member-preseeded",
      username: "preseeded-user",
      passwordHash: "fixture-not-used",
      role: "b2b",
      accountType: "member",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      profile: { companyName: "Preseeded Company" },
      unknownMemberField: { preserve: "member-value" }
    }]
  }, null, 2), { encoding: "utf8", mode: 0o644 });

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawnServer(port, tempRoot);

  try {
    await waitForHealth(baseUrl, server.child);

    const duplicateResults = await Promise.all([
      signup(baseUrl, "duplicate-user"),
      signup(baseUrl, "duplicate-user")
    ]);
    assert.deepEqual(
      duplicateResults.map((result) => result.response.status).sort((a, b) => a - b),
      [200, 409],
      "two concurrent requests for the same username must yield one success and one conflict"
    );

    const [alphaSignup, betaSignup] = await Promise.all([
      signup(baseUrl, "alpha-user"),
      signup(baseUrl, "beta-user")
    ]);
    assert.equal(alphaSignup.response.status, 200);
    assert.equal(betaSignup.response.status, 200);
    assert.match(alphaSignup.cookie, /^glamping_datalab_session=/);
    assert.match(betaSignup.cookie, /^glamping_datalab_session=/);

    const memberStore = JSON.parse(await fsp.readFile(memberFile, "utf8"));
    assert.deepEqual(memberStore.unknownRootField, { preserve: "root-value" });
    const preseededMember = memberStore.members.find((member) => member.memberId === "member-preseeded");
    assert.ok(preseededMember, "preseeded member must not be removed");
    assert.deepEqual(preseededMember.unknownMemberField, { preserve: "member-value" });
    assert.equal(memberStore.members.filter((member) => member.username === "duplicate-user").length, 1);
    assert.ok(memberStore.members.some((member) => member.username === "alpha-user"));
    assert.ok(memberStore.members.some((member) => member.username === "beta-user"));
    assert.equal(new Set(memberStore.members.map((member) => member.memberId)).size, memberStore.members.length);

    const alphaMemberId = String(alphaSignup.body?.memberId || "");
    assert.match(alphaMemberId, /^m_/);
    const ownerKey = `member:${alphaMemberId}`;
    await fsp.writeFile(interestFile, JSON.stringify({
      schemaVersion: 1,
      unknownRootField: { preserve: "interest-root" },
      updatedAt: "2026-01-01T00:00:00.000Z",
      accounts: {
        [ownerKey]: {
          unknownAccountField: { preserve: "account-value" },
          owner: {
            memberId: alphaMemberId,
            username: "alpha-user",
            accountType: "member",
            unknownOwnerField: { preserve: "owner-value" }
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
          interestLodges: [{
            id: "lodge-preserve-1",
            lodgingName: "Old Fixture Lodge",
            roomCount: "1",
            savedAt: "2026-01-01T00:00:00.000Z",
            unknownLodgeField: { preserve: "lodge-value" }
          }]
        }
      }
    }, null, 2), { encoding: "utf8", mode: 0o644 });

    const interestUpdate = await jsonRequest(baseUrl, "/api/member/interest-lodges", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: alphaSignup.cookie,
        "user-agent": "sensitive-store-integration-test"
      },
      body: JSON.stringify({
        interestLodges: [{
          id: "lodge-preserve-1",
          lodgingName: "Updated Fixture Lodge",
          roomCount: "3",
          roomType: "glamping",
          savedAt: "2026-01-01T00:00:00.000Z"
        }]
      })
    });
    assert.equal(interestUpdate.response.status, 200);
    const interestStore = JSON.parse(await fsp.readFile(interestFile, "utf8"));
    assert.deepEqual(interestStore.unknownRootField, { preserve: "interest-root" });
    const alphaAccount = interestStore.accounts[ownerKey];
    assert.deepEqual(alphaAccount.unknownAccountField, { preserve: "account-value" });
    assert.deepEqual(alphaAccount.owner.unknownOwnerField, { preserve: "owner-value" });
    assert.equal(alphaAccount.owner.memberId, alphaMemberId);
    assert.equal(alphaAccount.interestLodges[0].lodgingName, "Updated Fixture Lodge");
    assert.equal(alphaAccount.interestLodges[0].roomCount, "3");
    assert.deepEqual(alphaAccount.interestLodges[0].unknownLodgeField, { preserve: "lodge-value" });

    const adminLogin = await jsonRequest(baseUrl, "/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "sensitive-store-integration-test"
      },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    });
    assert.equal(adminLogin.response.status, 200);
    const adminCookie = String(adminLogin.response.headers.get("set-cookie") || "").split(";")[0];
    assert.match(adminCookie, /^glamping_datalab_session=/);

    await fsp.writeFile(credentialFile, JSON.stringify({
      unknownCredentialField: { preserve: "credential-value" }
    }, null, 2), { encoding: "utf8", mode: 0o644 });
    const credentialResults = await Promise.all([
      jsonRequest(baseUrl, "/api/settings/traffic-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "user-agent": "sensitive-store-integration-test"
        },
        body: JSON.stringify({
          naverClientId: "fixture-client-id",
          naverClientSecret: "fixture-client-secret"
        })
      }),
      jsonRequest(baseUrl, "/api/settings/traffic-keys", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "user-agent": "sensitive-store-integration-test"
        },
        body: JSON.stringify({
          searchadApiKey: "fixture-searchad-key",
          searchadSecretKey: "fixture-searchad-secret",
          searchadCustomerId: "fixture-customer-id"
        })
      })
    ]);
    assert.deepEqual(credentialResults.map((result) => result.response.status), [200, 200]);
    const credentialStore = JSON.parse(await fsp.readFile(credentialFile, "utf8"));
    assert.equal(credentialStore.naverClientId, "fixture-client-id");
    assert.equal(credentialStore.naverClientSecret, "fixture-client-secret");
    assert.equal(credentialStore.searchadApiKey, "fixture-searchad-key");
    assert.equal(credentialStore.searchadSecretKey, "fixture-searchad-secret");
    assert.equal(credentialStore.searchadCustomerId, "fixture-customer-id");
    assert.deepEqual(credentialStore.unknownCredentialField, { preserve: "credential-value" });

    await Promise.all([
      assertPrivateMode(memberFile),
      assertPrivateMode(interestFile),
      assertPrivateMode(credentialFile)
    ]);

    const sensitiveFiles = [memberFile, interestFile, credentialFile];
    for (const sensitiveFile of sensitiveFiles) {
      const directoryEntries = await fsp.readdir(path.dirname(sensitiveFile));
      assert.equal(
        directoryEntries.some((entry) => entry.startsWith(`.${path.basename(sensitiveFile)}.`) && entry.endsWith(".tmp")),
        false,
        `atomic write temp files must be cleaned for ${path.basename(sensitiveFile)}`
      );
    }
  } catch (error) {
    const output = server.output();
    error.message += `\nserver stdout=${output.stdout}\nserver stderr=${output.stderr}`;
    throw error;
  } finally {
    await stopChild(server.child).catch(() => {});
    const resolvedRoot = path.resolve(tempRoot);
    const relative = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`unsafe temp cleanup: ${resolvedRoot}`);
    }
    await fsp.rm(resolvedRoot, { recursive: true, force: true });
  }

  console.log("Sensitive store server integration tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
