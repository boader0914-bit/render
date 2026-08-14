"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  ENV_NAMES,
  LOCAL_STATE_ROOT,
  OPERATOR_TOKEN_HEADER,
  V2BasicUiError,
  createCoordinator,
  createServer,
  parseConfig
} = require("./v2_basic_place_test_ui_server.cjs");
const { createBasicPlaceDemoHtml } = require("./v2_basic_place_ui_demo_fixture.cjs");

const TOKEN = "fixture-ui-operator-token-with-at-least-thirty-two-characters";
let assertions = 0;

function equal(actual, expected) {
  assert.equal(actual, expected);
  assertions += 1;
}

function ok(value) {
  assert.ok(value);
  assertions += 1;
}

function match(value, pattern) {
  assert.match(value, pattern);
  assertions += 1;
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof V2BasicUiError);
    assert.equal(error.code, code);
    return true;
  });
  assertions += 3;
}

function envFor(stateDir, overrides = {}) {
  return {
    PORT: "10000",
    [ENV_NAMES.stateDir]: stateDir,
    [ENV_NAMES.runEnabled]: "0",
    [ENV_NAMES.dailyRequestBudget]: "0",
    [ENV_NAMES.automaticRetry]: "0",
    [ENV_NAMES.fallback]: "0",
    [ENV_NAMES.operationalWrites]: "0",
    [ENV_NAMES.demoPublic]: "1",
    ...overrides
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonRequest(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const value = await response.json();
  return { response, value };
}

function requestBody(mode, idempotencyKey, keyword = "경남 글램핑") {
  return JSON.stringify({ mode, keyword, idempotencyKey });
}

async function main() {
  const roots = [
    path.join(LOCAL_STATE_ROOT, `server-test-${process.pid}`),
    path.join(LOCAL_STATE_ROOT, `live-test-${process.pid}`),
    path.join(LOCAL_STATE_ROOT, `concurrency-test-${process.pid}`),
    path.join(LOCAL_STATE_ROOT, `provider-failure-test-${process.pid}`),
    path.join(LOCAL_STATE_ROOT, `manual-unlimited-test-${process.pid}`)
  ];
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  const servers = [];
  try {
    const demoConfig = parseConfig(envFor(roots[0]));
    equal(demoConfig.liveEnabled, false);
    equal(demoConfig.demoPublic, true);
    equal(demoConfig.dailyRequestBudget, 0);
    equal(demoConfig.operationalWrites, false);

    const demoCoordinator = createCoordinator({ config: demoConfig });
    const demoServer = createServer({ coordinator: demoCoordinator });
    servers.push(demoServer);
    const demoBase = await listen(demoServer);

    const health = await jsonRequest(demoBase, "/healthz");
    equal(health.response.status, 200);
    equal(health.value.status, "ok");
    equal(health.response.headers.get("x-frame-options"), "DENY");

    const page = await fetch(`${demoBase}/`);
    const pageHtml = await page.text();
    equal(page.status, 200);
    match(page.headers.get("content-security-policy"), /default-src 'self'/u);
    match(pageHtml, /DataLab Place 수집 콘솔/u);
    match(pageHtml, /id="collectorForm"/u);

    const browserContract = await fetch(`${demoBase}/naver-visible-place-ad-contract.js`);
    const browserContractSource = await browserContract.text();
    equal(browserContract.status, 200);
    match(browserContract.headers.get("content-type"), /text\/javascript/u);
    match(browserContractSource, /V2NaverVisiblePlaceAdContract/u);

    const bookmarkletResponse = await fetch(`${demoBase}/naver-ad-bookmarklet.txt`);
    const bookmarklet = (await bookmarkletResponse.text()).trim();
    equal(bookmarkletResponse.status, 200);
    match(bookmarkletResponse.headers.get("content-type"), /text\/plain/u);
    match(bookmarklet, /^javascript:\(/u);
    assert.doesNotMatch(bookmarklet, /V2_BASIC_UI_OPERATOR_TOKEN|document\.cookie|localStorage|sessionStorage/iu);
    assertions += 1;

    const status = await jsonRequest(demoBase, "/api/status");
    equal(status.response.status, 200);
    equal(status.value.status, "ready");
    equal(status.value.mode, "demo-only");
    equal(status.value.liveEnabled, false);
    equal(status.value.authRequired, false);
    equal(status.value.dailyLiveRequestsUsed, 0);

    const demoHeaders = { "content-type": "application/json" };
    const demoBody = requestBody("demo", "demo-request-0001");
    const demoResult = await jsonRequest(demoBase, "/api/collect", { method: "POST", headers: demoHeaders, body: demoBody });
    equal(demoResult.response.status, 200);
    equal(demoResult.value.status, "completed");
    equal(demoResult.value.mode, "demo");
    equal(demoResult.value.organic.length, 5);
    equal(demoResult.value.advertisements.length, 3);
    equal(demoResult.value.externalRequests, 0);
    equal(demoResult.value.operationalWrites, 0);
    equal(demoResult.value.rawProviderResponseStored, false);
    equal(demoResult.value.diagnostics.status, "current-filter-matched-with-items");
    equal(demoResult.value.organic[3].placeId, "35644668");
    equal(demoResult.value.organic[3].name, "월명 글램핑");
    equal(demoResult.value.organic[3].minimumPrice, 179000);
    match(demoResult.value.manifestDigest, /^[a-f0-9]{64}$/u);
    match(demoResult.value.requestHash, /^[a-f0-9]{64}$/u);

    const duplicate = await jsonRequest(demoBase, "/api/collect", { method: "POST", headers: demoHeaders, body: demoBody });
    equal(duplicate.response.status, 200);
    equal(duplicate.value.status, "completed");
    equal(duplicate.value.duplicate, true);
    equal(duplicate.value.runId, demoResult.value.runId);

    const liveBlocked = await jsonRequest(demoBase, "/api/collect", {
      method: "POST",
      headers: demoHeaders,
      body: requestBody("live", "live-disabled-0001")
    });
    equal(liveBlocked.response.status, 401);
    equal(liveBlocked.value.code, "V2_BASIC_UI_UNAUTHORIZED");

    const originBlocked = await jsonRequest(demoBase, "/api/collect", {
      method: "POST",
      headers: { ...demoHeaders, origin: "https://example.invalid" },
      body: requestBody("demo", "origin-blocked-001")
    });
    equal(originBlocked.response.status, 403);
    equal(originBlocked.value.code, "V2_BASIC_UI_ORIGIN_BLOCKED");

    const invalid = await jsonRequest(demoBase, "/api/collect", {
      method: "POST",
      headers: demoHeaders,
      body: JSON.stringify({ mode: "demo", keyword: "x", idempotencyKey: "short" })
    });
    equal(invalid.response.status, 400);
    equal(invalid.value.code, "V2_BASIC_UI_REQUEST_INVALID");

    const unsupportedType = await jsonRequest(demoBase, "/api/collect", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}"
    });
    equal(unsupportedType.response.status, 415);
    equal(unsupportedType.value.code, "V2_BASIC_UI_CONTENT_TYPE_INVALID");

    const disabledWithAuthConfig = parseConfig(envFor(path.join(LOCAL_STATE_ROOT, `disabled-test-${process.pid}`), {
      [ENV_NAMES.demoPublic]: "0",
      [ENV_NAMES.operatorTokenSha256]: crypto.createHash("sha256").update(TOKEN).digest("hex")
    }));
    const disabledWithAuth = createCoordinator({ config: disabledWithAuthConfig });
    await rejectsCode(() => disabledWithAuth.collect({
      request: { headers: { [OPERATOR_TOKEN_HEADER]: TOKEN } },
      body: { mode: "live", keyword: "경남 글램핑", idempotencyKey: "live-disabled-auth-1" }
    }), "V2_BASIC_UI_LIVE_DISABLED");

    const liveConfig = parseConfig(envFor(roots[1], {
      [ENV_NAMES.runEnabled]: "1",
      [ENV_NAMES.dailyRequestBudget]: "2",
      [ENV_NAMES.demoPublic]: "0",
      [ENV_NAMES.operatorTokenSha256]: crypto.createHash("sha256").update(TOKEN).digest("hex")
    }));
    equal(liveConfig.liveEnabled, true);
    equal(liveConfig.dailyRequestBudget, 2);
    equal(liveConfig.demoPublic, false);
    let fixtureCalls = 0;
    const liveCoordinator = createCoordinator({
      config: liveConfig,
      fetchImpl: async () => {
        fixtureCalls += 1;
        return new Response(createBasicPlaceDemoHtml("경남 글램핑"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    });
    const liveServer = createServer({ coordinator: liveCoordinator });
    servers.push(liveServer);
    const liveBase = await listen(liveServer);

    const unauthorized = await jsonRequest(liveBase, "/api/collect", {
      method: "POST",
      headers: demoHeaders,
      body: requestBody("live", "live-auth-block-01")
    });
    equal(unauthorized.response.status, 401);
    equal(unauthorized.value.code, "V2_BASIC_UI_UNAUTHORIZED");
    equal(fixtureCalls, 0);

    const liveHeaders = { "content-type": "application/json", [OPERATOR_TOKEN_HEADER]: TOKEN };
    const liveResult = await jsonRequest(liveBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "live-success-00001")
    });
    equal(liveResult.response.status, 200);
    equal(liveResult.value.status, "completed");
    equal(liveResult.value.mode, "live");
    equal(liveResult.value.externalRequests, 1);
    equal(liveResult.value.organic.length, 5);
    equal(liveResult.value.advertisements.length, 3);
    equal(fixtureCalls, 1);

    const secondLiveResult = await jsonRequest(liveBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "live-success-00002")
    });
    equal(secondLiveResult.response.status, 200);
    equal(secondLiveResult.value.status, "completed");
    equal(secondLiveResult.value.externalRequests, 1);
    equal(fixtureCalls, 2);

    const budgetBlocked = await jsonRequest(liveBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "live-budget-00001")
    });
    equal(budgetBlocked.response.status, 429);
    equal(budgetBlocked.value.code, "V2_BASIC_UI_DAILY_BUDGET_EXHAUSTED");
    equal(fixtureCalls, 2);

    const liveStatus = await jsonRequest(liveBase, "/api/status");
    equal(liveStatus.value.dailyLiveRequestsUsed, 2);
    equal(liveStatus.value.dailyLiveRequestLimit, 2);
    equal(liveStatus.value.authRequired, true);

    let providerFailureCalls = 0;
    const providerFailureConfig = parseConfig(envFor(roots[3], {
      [ENV_NAMES.runEnabled]: "1",
      [ENV_NAMES.dailyRequestBudget]: "1",
      [ENV_NAMES.demoPublic]: "0",
      [ENV_NAMES.operatorTokenSha256]: crypto.createHash("sha256").update(TOKEN).digest("hex")
    }));
    const providerFailureCoordinator = createCoordinator({
      config: providerFailureConfig,
      fetchImpl: async () => {
        providerFailureCalls += 1;
        return new Response("synthetic-provider-secret-body", {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    });
    const providerFailureServer = createServer({ coordinator: providerFailureCoordinator });
    servers.push(providerFailureServer);
    const providerFailureBase = await listen(providerFailureServer);
    const providerFailure = await jsonRequest(providerFailureBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "live-provider-failure-01")
    });
    equal(providerFailure.response.status, 500);
    equal(providerFailure.value.code, "V2_BASIC_PLACE_HTTP_ERROR");
    equal(providerFailure.value.stage, "provider-response");
    equal(providerFailure.value.providerStatus, 403);
    equal(providerFailure.value.providerStatusClass, "4xx");
    equal(providerFailure.value.externalRequests, 1);
    equal(providerFailureCalls, 1);
    const providerFailureTerminalNames = await fs.readdir(path.join(roots[3], "terminals"));
    equal(providerFailureTerminalNames.length, 1);
    const providerFailureTerminal = JSON.parse(await fs.readFile(
      path.join(roots[3], "terminals", providerFailureTerminalNames[0]),
      "utf8"
    ));
    equal(providerFailureTerminal.providerStatus, 403);
    equal(providerFailureTerminal.providerStatusClass, "4xx");
    assert.doesNotMatch(JSON.stringify(providerFailureTerminal), /synthetic-provider-secret-body/iu);
    assertions += 1;
    const providerBlockedStatus = await jsonRequest(providerFailureBase, "/api/status");
    equal(providerBlockedStatus.value.providerBlocked, true);
    equal(providerBlockedStatus.value.providerBlockStatus, 403);
    const providerCircuitBlocked = await jsonRequest(providerFailureBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "live-provider-blocked-02")
    });
    equal(providerCircuitBlocked.response.status, 503);
    equal(providerCircuitBlocked.value.code, "V2_BASIC_UI_PROVIDER_CIRCUIT_OPEN");
    equal(providerCircuitBlocked.value.providerStatus, 403);
    equal(providerCircuitBlocked.value.externalRequests, 0);
    equal(providerFailureCalls, 1);

    let unlimitedNow = new Date("2026-08-14T15:00:00.000Z");
    let unlimitedFixtureCalls = 0;
    const unlimitedConfig = parseConfig(envFor(roots[4], {
      [ENV_NAMES.runEnabled]: "1",
      [ENV_NAMES.dailyRequestBudget]: "unlimited",
      [ENV_NAMES.demoPublic]: "0",
      [ENV_NAMES.operatorTokenSha256]: crypto.createHash("sha256").update(TOKEN).digest("hex")
    }));
    equal(unlimitedConfig.unlimitedLiveRequests, true);
    equal(unlimitedConfig.dailyRequestBudget, null);
    equal(unlimitedConfig.liveRequestPolicy, "manual-unlimited");
    equal(unlimitedConfig.minimumLiveIntervalMs, 3000);
    const unlimitedCoordinator = createCoordinator({
      config: unlimitedConfig,
      now: () => new Date(unlimitedNow.getTime()),
      fetchImpl: async () => {
        unlimitedFixtureCalls += 1;
        return new Response(createBasicPlaceDemoHtml("경남 글램핑"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    });
    const unlimitedServer = createServer({ coordinator: unlimitedCoordinator });
    servers.push(unlimitedServer);
    const unlimitedBase = await listen(unlimitedServer);
    const unlimitedFirst = await jsonRequest(unlimitedBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "manual-unlimited-live-0001")
    });
    equal(unlimitedFirst.response.status, 200);
    equal(unlimitedFirst.value.externalRequests, 1);
    equal(unlimitedFixtureCalls, 1);
    const intervalBlocked = await jsonRequest(unlimitedBase, "/api/collect", {
      method: "POST",
      headers: liveHeaders,
      body: requestBody("live", "manual-unlimited-live-0002")
    });
    equal(intervalBlocked.response.status, 429);
    equal(intervalBlocked.value.code, "V2_BASIC_UI_RATE_LIMITED");
    equal(intervalBlocked.value.externalRequests, 0);
    equal(unlimitedFixtureCalls, 1);
    for (let ordinal = 2; ordinal <= 21; ordinal += 1) {
      unlimitedNow = new Date(unlimitedNow.getTime() + 3000);
      const result = await jsonRequest(unlimitedBase, "/api/collect", {
        method: "POST",
        headers: liveHeaders,
        body: requestBody("live", `manual-unlimited-live-${String(ordinal).padStart(4, "0")}`)
      });
      equal(result.response.status, 200);
    }
    equal(unlimitedFixtureCalls, 21);
    const unlimitedStatus = await jsonRequest(unlimitedBase, "/api/status");
    equal(unlimitedStatus.value.liveRequestPolicy, "manual-unlimited");
    equal(unlimitedStatus.value.dailyLiveRequestLimit, null);
    equal(unlimitedStatus.value.dailyLiveRequestsUsed, 21);
    equal(unlimitedStatus.value.providerBlocked, false);

    const usageFiles = await fs.readdir(path.join(roots[1], "usage"));
    equal(usageFiles.length, 1);
    await fs.writeFile(path.join(roots[1], "usage", usageFiles[0]), '{"consumed":"invalid"}\n', "utf8");
    await rejectsCode(() => liveCoordinator.status(), "V2_BASIC_UI_STATE_UNCERTAIN");

    const allStateFiles = [];
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else allStateFiles.push(await fs.readFile(full, "utf8"));
      }
    }
    await walk(roots[1]);
    const persisted = allStateFiles.join("\n");
    assert.doesNotMatch(persisted, new RegExp(TOKEN, "u"));
    assertions += 1;
    assert.doesNotMatch(persisted, /__APOLLO_STATE__|authorization|set-cookie/iu);
    assertions += 1;

    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    const concurrencyConfig = parseConfig(envFor(roots[2]));
    const concurrencyCoordinator = createCoordinator({
      config: concurrencyConfig,
      runCollection: async ({ request, requestHash }) => {
        started();
        await releasePromise;
        return {
          schemaVersion: "v2-basic-place-test-ui-result.v1",
          event: "v2_basic_place_test_ui_result",
          status: "completed",
          duplicate: false,
          mode: request.mode,
          runId: `ui-demo-${requestHash.slice(0, 24)}`,
          keyword: request.keyword,
          requestHash,
          organic: [],
          advertisements: [],
          externalRequests: 0,
          operationalWrites: 0,
          rawProviderResponseStored: false
        };
      }
    });
    const fakeRequest = { headers: {} };
    const first = concurrencyCoordinator.collect({
      request: fakeRequest,
      body: { mode: "demo", keyword: "경남 글램핑", idempotencyKey: "concurrent-first-01" }
    });
    await startedPromise;
    await rejectsCode(() => concurrencyCoordinator.collect({
      request: fakeRequest,
      body: { mode: "demo", keyword: "산청 펜션", idempotencyKey: "concurrent-second-1" }
    }), "V2_BASIC_UI_BUSY");
    release();
    equal((await first).status, "completed");

    await rejectsCode(() => Promise.resolve().then(() => parseConfig(envFor(roots[2], {
      [ENV_NAMES.runEnabled]: "1",
      [ENV_NAMES.dailyRequestBudget]: "1"
    }))), "V2_BASIC_UI_CONFIG_INVALID");
    await rejectsCode(() => Promise.resolve().then(() => parseConfig(envFor(roots[2], {
      [ENV_NAMES.automaticRetry]: "1"
    }))), "V2_BASIC_UI_CONFIG_INVALID");
    await rejectsCode(() => Promise.resolve().then(() => parseConfig(envFor(roots[2], {
      [ENV_NAMES.dailyRequestBudget]: "unlimited"
    }))), "V2_BASIC_UI_CONFIG_INVALID");

    ok(assertions >= 74);
  } finally {
    await Promise.all(servers.filter((server) => server.listening).map(close));
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
  process.stdout.write(`${JSON.stringify({
    event: "v2_basic_place_test_ui_server_tests_complete",
    assertions,
    externalNetworkRequests: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: 0
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
