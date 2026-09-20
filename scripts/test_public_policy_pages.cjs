"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const ROOT = path.resolve(__dirname, "..");
const CURRENT_VERSION = "2026-09-20";
const PREVIOUS_VERSION = "2026-07-08";
const ADMIN = { username: "policy-fixture-admin", password: "PolicyFixtureAdmin-482!" };
const DEMO = { username: "policy-fixture-demo", password: "PolicyFixtureDemo-573!" };
const MEMBER = {
  username: "policy-fixture-member", password: "PolicyFixtureMember-619!",
  passwordConfirm: "PolicyFixtureMember-619!", phone: "010-0000-0000",
  email: "private-member@example.invalid", companyName: "PRIVATE_COMPANY_FIXTURE_8193",
  agreeTerms: "1", agreePrivacy: "1", confirmAge: "1"
};
const POLICY_NAMES = [
  "terms", "privacy", "refund", "data-collection-notice", "data-quality-notice",
  "collection-failure-notice", "api-key-retention-policy", "report-disclaimer",
  "business-info", "google-play-data-safety"
];
const FONT_NAMES = ["MaruBuri-Regular.otf", "Pretendard-Regular.otf", "Pretendard-Bold.otf"];

async function request(server, pathname, options = {}) {
  const { cookie = "", form, json, ...rest } = options;
  const response = await fetch(server.baseUrl + pathname, {
    ...rest,
    redirect: "manual",
    headers: {
      Accept: "application/json", "User-Agent": "STAYDATALAB-policy-integration-fixture",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...rest.headers
    },
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : rest.body,
    signal: AbortSignal.timeout(5000)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let body = null;
  if (text && response.headers.get("content-type")?.includes("application/json")) body = JSON.parse(text);
  return { response, bytes, text, body, cookie: String(response.headers.get("set-cookie") || "").split(";")[0] };
}

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function makeGuard(tempRoot) {
  const guardPath = path.join(tempRoot, "deny-external-io.cjs");
  const attemptsPath = path.join(tempRoot, "forbidden-io.log");
  await fsp.writeFile(guardPath, `
const fs = require('node:fs');
function denied(operation) {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, operation + '\\n');
  throw new Error('Public policy integration test forbids ' + operation);
}
const childProcess = require('node:child_process');
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  childProcess[method] = () => denied('subprocess.' + method);
}
for (const protocol of ['node:http','node:https']) {
  const transport = require(protocol);
  transport.request = () => denied(protocol + '.request');
  transport.get = () => denied(protocol + '.get');
}
require('node:net').Socket.prototype.connect = () => denied('socket.connect');
globalThis.fetch = () => denied('fetch');
`, "utf8");
  return { guardPath, attemptsPath };
}

async function startServer(tempRoot, guardPath, signupEnabled) {
  const appData = path.join(tempRoot, signupEnabled ? "signup-enabled" : "signup-disabled");
  const customerDir = path.join(appData, "customer_db");
  await fsp.mkdir(customerDir, { recursive: true });
  // Preserve an old consent record while creating a new account. This fixture has
  // no usable password and is never a real or externally collected member.
  await fsp.writeFile(path.join(customerDir, "b2b_members.json"), JSON.stringify({
    schemaVersion: 1, members: [{
      memberId: "old-consent-fixture", username: "old-consent-fixture", status: "disabled",
      role: "b2b", accountType: "member", profile: {},
      consents: { termsVersion: PREVIOUS_VERSION, privacyVersion: PREVIOUS_VERSION, acceptedAt: "2026-07-08T00:00:00.000Z" }
    }]
  }));
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["--require", guardPath, path.join(__dirname, "glamping_app_server.cjs")], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_OPTIONS: "", NODE_ENV: "test", RENDER: "", RENDER_EXTERNAL_URL: "",
      PORT: String(port), HOST: "127.0.0.1", DATA_DIR: appData,
      OUTPUTS_DIR: path.join(appData, "outputs"), CONFIG_DIR: path.join(appData, "config"),
      MASTER_DB_PATH: path.join(appData, "master_db", "test.sqlite"), MASTER_DB_WRITE_MODE: "off",
      SEED_OUTPUTS_FROM_REPO: "0", TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0",
      TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", GLAMPING_SIGNUP_ENABLED: signupEnabled ? "1" : "0",
      GLAMPING_ADMIN_USER: ADMIN.username, GLAMPING_ADMIN_PASSWORD: ADMIN.password,
      GLAMPING_B2B_USER: DEMO.username, GLAMPING_B2B_PASSWORD: DEMO.password, GLAMPING_B2B_ENABLED: "1",
      GLAMPING_PRIVACY_EMAIL: "info@sabun.co.kr",
      LODGING_DATALAB_BUSINESS_NAME: "사분", LODGING_DATALAB_OPERATOR_NAME: "사분",
      LODGING_DATALAB_BUSINESS_ADDRESS: "경상남도 진주시 도동로36번길 10",
      LODGING_DATALAB_BUSINESS_REGISTRATION_NO: "515-13-21899"
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  const server = { child, appData, baseUrl: `http://127.0.0.1:${port}`, output };
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output.join(""));
      try {
        const ready = await request(server, "/api/health");
        if (ready.response.ok) return server;
      } catch { /* Server may still be starting. */ }
      await delay(50);
    }
    throw new Error(`Policy test server readiness timed out: ${output.join("")}`);
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

async function stopServer(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function checkPublicRoutes(server) {
  for (const name of POLICY_NAMES) {
    const current = await request(server, `/${name}`);
    assert.equal(current.response.status, 200, name);
    assert.match(current.response.headers.get("content-type"), /text\/html/);
    assert.match(current.text, /<main id="main"/);
    assert.ok(current.text.includes(`최종 수정 ${CURRENT_VERSION.replaceAll("-", ".")}`), name);
    assert.ok(current.text.includes(`/policy-history/${PREVIOUS_VERSION}/${name}.html`), `${name} history link`);
    assert.doesNotMatch(current.text, /<script[^>]*src="https?:|@font-face[^}]+https?:/i);
    const head = await request(server, `/${name}`, { method: "HEAD" });
    assert.equal(head.response.status, 200, `HEAD ${name}`);
    assert.equal(head.bytes.length, 0);
    const historyPath = `/policy-history/${PREVIOUS_VERSION}/${name}.html`;
    const history = await request(server, historyPath);
    assert.equal(history.response.status, 200, historyPath);
    assert.equal(history.bytes.equals(await fsp.readFile(path.join(ROOT, "web", "policy-history", PREVIOUS_VERSION, `${name}.html`))), true);
    const historyHead = await request(server, historyPath, { method: "HEAD" });
    assert.equal(historyHead.response.status, 200);
    assert.equal(historyHead.bytes.length, 0);
  }
  for (const [alias, canonical] of [["refund-cancellation-policy", "refund"], ["external-platform-data-limit", "data-quality-notice"]]) {
    assert.equal((await request(server, `/${alias}`)).text, (await request(server, `/${canonical}`)).text);
    assert.equal((await request(server, `/${alias}`, { method: "HEAD" })).response.status, 200);
  }
  for (const [url, type] of [["/public-site.css", "text/css"], ...FONT_NAMES.map(name => [`/fonts/${name}`, "font/otf"])]) {
    const asset = await request(server, url);
    assert.equal(asset.response.status, 200, url);
    assert.ok(asset.response.headers.get("content-type").startsWith(type), url);
    assert.ok(asset.bytes.length > 100, url);
    const head = await request(server, url, { method: "HEAD" });
    assert.equal(head.response.status, 200);
    assert.equal(head.bytes.length, 0);
  }
  const css = (await request(server, "/public-site.css")).text;
  assert.doesNotMatch(css, /url\(['"]?https?:/i);
  for (const url of ["/fonts/README.md", "/fonts/unknown.otf", "/policy-history/2026-07-08/unknown.html", "/policy-history/2026-07-08/", "/scripts/glamping_app_server.cjs", "/api/b2b-members"]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await request(server, url, { method })).response.status, 401, `${method} ${url} stays private`);
    }
  }
  const login = await request(server, "/login");
  assert.match(login.text, /<form[^>]+method="post"[^>]+action="\/login"/);
  assert.match(login.text, /name="username"/);
  assert.match(login.text, /name="password"/);
  const deletePage = await request(server, "/account-delete");
  assert.match(deletePage.text, /<form[^>]+method="post"[^>]+action="\/account-delete"/);
  assert.match(deletePage.text, /즉시 삭제되지는 않습니다/);
  assert.equal((await request(server, "/account-delete", { method: "HEAD" })).response.status, 200);
}

async function login(server, account, form = false) {
  const result = await request(server, form ? "/login" : "/api/login", {
    method: "POST", ...(form ? { form: account } : { json: account })
  });
  assert.equal(result.response.status, form ? 302 : 200);
  assert.match(result.cookie, /^glamping_datalab_session=/);
  assert.match(result.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(result.response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(result.response.headers.get("set-cookie"), /Max-Age=43200/);
  return result;
}

async function checkMemberFlows(server) {
  const signup = await request(server, "/signup");
  assert.equal(signup.response.status, 200);
  assert.match(signup.text, /<form[^>]+method="post"[^>]+action="\/signup"/);
  assert.match(signup.text, /href="\/privacy#required-consent"/);
  assert.match((await request(server, "/privacy")).text, /id="required-consent"/);
  assert.doesNotMatch(signup.text, /@font-face[^}]+https?:/i);
  assert.equal((await request(server, "/signup.js")).response.status, 200);
  const missingConsent = await request(server, "/api/signup", { method: "POST", json: { ...MEMBER, agreePrivacy: "" } });
  assert.equal(missingConsent.response.status, 400);
  const registration = await request(server, "/signup", { method: "POST", form: MEMBER });
  assert.equal(registration.response.status, 302);
  assert.equal(registration.response.headers.get("location"), "/b2b");
  const members = JSON.parse(await fsp.readFile(path.join(server.appData, "customer_db", "b2b_members.json"), "utf8")).members;
  const member = members.find(row => row.username === MEMBER.username);
  assert.equal(member.consents.termsVersion, CURRENT_VERSION);
  assert.equal(member.consents.privacyVersion, CURRENT_VERSION);
  assert.equal(member.consents.marketingAccepted, false);
  assert.match(member.passwordHash, /^pbkdf2_sha256\$/);
  assert.equal(member.password, undefined);
  assert.equal(members.find(row => row.username === "old-consent-fixture").consents.privacyVersion, PREVIOUS_VERSION);
  const memberSession = await request(server, "/api/session", { cookie: registration.cookie });
  assert.equal(memberSession.body.memberId, member.memberId);
  assert.equal(memberSession.body.role, "b2b");
  const memberLogin = await login(server, { username: MEMBER.username, password: MEMBER.password });
  assert.equal(memberLogin.body.role, "b2b");

  const admin = await login(server, ADMIN, true);
  assert.equal(admin.response.headers.get("location"), "/admin");
  const demo = await login(server, DEMO);
  assert.equal(demo.body.role, "b2b");
  for (const cookie of [registration.cookie, demo.cookie]) {
    assert.equal((await request(server, "/api/b2b-members", { cookie })).response.status, 403);
    assert.equal((await request(server, "/api/account-delete-requests", { cookie })).response.status, 403);
    assert.equal((await request(server, "/api/collection-schedule", { cookie })).response.status, 403);
    assert.equal((await request(server, "/admin", { cookie })).response.headers.get("location"), "/b2b");
    assert.equal((await request(server, "/b2b", { cookie, method: "HEAD" })).response.status, 200);
  }
  assert.equal((await request(server, "/api/b2b-members", { cookie: admin.cookie })).response.status, 200);
  assert.equal((await request(server, "/admin", { cookie: admin.cookie, method: "HEAD" })).response.status, 200);
  assert.equal((await request(server, "/b2b", { cookie: admin.cookie })).response.headers.get("location"), "/admin");

  const deletePayload = { username: MEMBER.username, contact: "requester@example.invalid", requestType: "account_delete", confirmRequest: "1" };
  for (const cookie of ["", demo.cookie]) {
    const deletion = await request(server, "/api/account-delete-request", { method: "POST", json: deletePayload, cookie });
    assert.equal(deletion.response.status, 200);
    assert.deepEqual(Object.keys(deletion.body.request).sort(), ["requestId", "requestedAt", "requestType", "requestTypeLabel", "status", "statusLabel"].sort());
    assert.doesNotMatch(deletion.text, new RegExp(`${MEMBER.companyName}|${member.memberId}|consentAcceptedAt|termsVersion|privacyVersion|adminNote`));
  }
  const publicHtmlReceipt = await request(server, "/account-delete", { method: "POST", form: deletePayload });
  assert.equal(publicHtmlReceipt.response.status, 200);
  assert.ok(publicHtmlReceipt.text.includes("삭제 요청이 접수되었습니다"));
  assert.equal(publicHtmlReceipt.text.includes(MEMBER.companyName), false);
  assert.equal(publicHtmlReceipt.text.includes(member.memberId), false);
  const adminRequests = await request(server, "/api/account-delete-requests", { cookie: admin.cookie });
  assert.equal(adminRequests.response.status, 200);
  assert.ok(adminRequests.body.requests.some(row => row.memberId === member.memberId && row.companyName === MEMBER.companyName));
  assert.equal((await request(server, "/api/session", { cookie: registration.cookie })).body.authenticated, true, "A deletion request does not automatically delete a member");
  const logout = await request(server, "/api/logout", { cookie: demo.cookie, method: "POST", json: {} });
  assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await request(server, "/api/session", { cookie: demo.cookie })).response.status, 401);
}

async function checkSignupDisabled(server) {
  const page = await request(server, "/login");
  assert.match(page.text, /현재 신규 회원가입을 받지 않습니다/);
  assert.doesNotMatch(page.text, /href="\/signup"/);
  assert.equal((await request(server, "/signup")).response.status, 503);
  for (const url of ["/signup", "/api/signup"]) {
    assert.equal((await request(server, url, { method: "POST", json: MEMBER })).response.status, 503);
  }
  assert.equal((await request(server, "/api/signup/check-username?username=fixture")).response.status, 503);
  assert.match((await request(server, "/terms")).text, /현재 신규 회원가입은 중단/);
  const admin = await login(server, ADMIN);
  assert.equal((await request(server, "/api/session", { cookie: admin.cookie })).body.role, "admin");
  assert.equal(JSON.parse(await fsp.readFile(path.join(server.appData, "customer_db", "b2b_members.json"), "utf8")).members.length, 1);
}

async function main() {
  const tempBase = await fsp.realpath(os.tmpdir());
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "staydatalab-public-policies-"));
  const servers = [];
  try {
    const { guardPath, attemptsPath } = await makeGuard(tempRoot);
    const enabled = await startServer(tempRoot, guardPath, true);
    servers.push(enabled);
    await checkPublicRoutes(enabled);
    await checkMemberFlows(enabled);
    const disabled = await startServer(tempRoot, guardPath, false);
    servers.push(disabled);
    await checkSignupDisabled(disabled);
    assert.equal(fs.existsSync(attemptsPath), false, "No external request or crawler may be attempted");
    for (const server of servers) {
      const outputs = await fsp.readdir(path.join(server.appData, "outputs")).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.deepEqual(outputs, [], "No crawl results may be created");
    }
    console.log("Public policies integration passed: 10 documents and history, aliases, local assets, GET/HEAD boundaries, signup on/off, consent preservation, authentication, and deletion-receipt privacy; no external IO or collection.");
  } finally {
    await Promise.all(servers.map(stopServer));
    const resolvedRoot = await fsp.realpath(tempRoot);
    const relative = path.relative(tempBase, resolvedRoot);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
    assert.equal(path.dirname(relative), ".");
    assert.ok(path.basename(relative).startsWith("staydatalab-public-policies-"));
    await fsp.rm(resolvedRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
