"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(
  ROOT,
  "scripts",
  "frozen_v2_4e4e190",
  "runtime",
  "fetch_safety_preload.cjs"
);
const SENSITIVE_VALUES = Object.freeze([
  "synthetic-secret-query-value",
  "synthetic-sensitive-response-body",
  "synthetic-secret-header-value"
]);

const INJECTOR_SOURCE = `
"use strict";
const scenario = JSON.parse(process.env.FROZEN_FETCH_SCENARIO);
globalThis.__syntheticFetchCalls = [];
globalThis.fetch = async function syntheticOriginalFetch(input, init) {
  globalThis.__syntheticFetchCalls.push({ input, init });
  const responseIndex = globalThis.__syntheticFetchCalls.length - 1;
  const responseSpec = Array.isArray(scenario.responses) ? scenario.responses[responseIndex] : scenario;
  if (!responseSpec || responseSpec.reject) {
    throw new Error(\`synthetic rejection: \${scenario.body}; input=\${String(input)}\`);
  }
  const response = new Response(responseSpec.body, {
    status: responseSpec.status,
    headers: responseSpec.headers
  });
  globalThis.__syntheticLastResponse = response;
  return response;
};
`;

const CHILD_SOURCE = `
"use strict";
(async () => {
  const scenario = JSON.parse(process.env.FROZEN_FETCH_SCENARIO);
  const input = scenario.url;
  const init = {
    method: "POST",
    headers: { "x-synthetic-secret": "synthetic-secret-header-value" },
    body: "synthetic-secret-query-value"
  };
  let response = null;
  let error = null;
  try {
    response = await fetch(input, init);
  } catch (caught) {
    error = caught;
  }
  const call = globalThis.__syntheticFetchCalls[0];
  if (scenario.expectedRejectedBeforeTransport) {
    if (call || !error || error.code !== "FROZEN_V2_REQUEST_NOT_ALLOWED") {
      throw new Error("unapproved request was not rejected before transport");
    }
    let secondError = null;
    try {
      await fetch(input, init);
    } catch (caught) {
      secondError = caught;
    }
    if (!secondError || secondError.code !== "FROZEN_V2_REQUEST_NOT_ALLOWED" || globalThis.__syntheticFetchCalls.length !== 0) {
      throw new Error("unapproved request rejection was not latched");
    }
    process.stdout.write(JSON.stringify({
      rejected: true,
      code: error.code,
      calls: globalThis.__syntheticFetchCalls.length
    }));
    return;
  }
  const callHeaders = new Headers(call && call.init && call.init.headers || {});
  if (!call || call.input !== input || call.init.redirect !== "manual" || call.init.method !== init.method
    || call.init.body !== init.body || callHeaders.get("x-synthetic-secret") !== "synthetic-secret-header-value") {
    throw new Error("fetch arguments changed");
  }
  if (scenario.expectedFailureCode) {
    if (!error || error.code !== scenario.expectedFailureCode) {
      throw new Error(\`expected \${scenario.expectedFailureCode}\`);
    }
    let secondError = null;
    try {
      await fetch(input, init);
    } catch (caught) {
      secondError = caught;
    }
    if (!secondError || secondError.code !== scenario.expectedFailureCode) {
      throw new Error("latched NAVER failure was not preserved");
    }
    process.stdout.write(JSON.stringify({
      failed: true,
      code: error.code,
      retryable: error.retryable,
      calls: globalThis.__syntheticFetchCalls.length
    }));
    return;
  }
  if (scenario.expectedBlocked) {
    if (!error || error.code !== "NAVER_ACCESS_BLOCKED") {
      throw new Error("expected NAVER_ACCESS_BLOCKED");
    }
    let secondError = null;
    try {
      await fetch(input, init);
    } catch (caught) {
      secondError = caught;
    }
    if (!secondError || secondError.code !== "NAVER_ACCESS_BLOCKED") {
      throw new Error("latched NAVER block was not preserved");
    }
    process.stdout.write(JSON.stringify({
      blocked: true,
      code: error.code,
      subtype: error.providerFailureSubtype,
      status: error.providerHttpStatus,
      calls: globalThis.__syntheticFetchCalls.length
    }));
    return;
  }
  if (error) throw error;
  if (response !== globalThis.__syntheticLastResponse) {
    throw new Error("response identity changed");
  }
  const body = await response.text();
  if (body !== scenario.body || response.status !== scenario.status) {
    throw new Error("response changed");
  }
  process.stdout.write(JSON.stringify({
    blocked: false,
    status: response.status,
    calls: globalThis.__syntheticFetchCalls.length
  }));
})().catch((error) => {
  process.stderr.write(String(error && error.code || "CHILD_ASSERTION_FAILED"));
  process.exitCode = 2;
});
`;

function runScenario(tempRoot, id, scenario) {
  const injector = path.join(tempRoot, `${id}-injector.cjs`);
  fs.writeFileSync(injector, INJECTOR_SOURCE, "utf8");
  const result = spawnSync(process.execPath, [
    "--require",
    injector,
    "--require",
    PRELOAD,
    "--eval",
    CHILD_SOURCE
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      FROZEN_FETCH_SCENARIO: JSON.stringify(scenario)
    },
    timeout: 10_000
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const secret of SENSITIVE_VALUES) {
    assert.equal(combined.includes(secret), false, `${id} leaked a sensitive fixture string`);
  }
  return result;
}

function markerPayload(stderr) {
  const marker = String(stderr || "")
    .split(/\r?\n/u)
    .find((line) => line.startsWith("CRAWL_ERROR_V1:"));
  assert.ok(marker, "safe crawl failure marker is required");
  return JSON.parse(marker.slice("CRAWL_ERROR_V1:".length));
}

function runModuleGuardScenario() {
  return spawnSync(process.execPath, [
    "--require",
    PRELOAD,
    "--eval",
    `
      "use strict";
      const path = require("node:path");
      if (path.basename("synthetic/non-target.txt") !== "non-target.txt") {
        throw new Error("non-target module loading changed");
      }
      let xlsxError = null;
      try {
        require("xlsx");
      } catch (error) {
        xlsxError = error;
      }
      if (!xlsxError || xlsxError.code !== "MODULE_NOT_FOUND") {
        throw new Error("exact require('xlsx') was not blocked");
      }
      process.stdout.write(JSON.stringify({
        nonTargetModuleLoaded: true,
        xlsxCode: xlsxError.code
      }));
    `
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 10_000
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-frozen-fetch-safety-"));
try {
  const blockedScenarios = [
    {
      id: "http-403",
      expectedSubtype: "http_403",
      scenario: {
        url: "https://pcmap.place.naver.com/accommodation/list?query=synthetic-secret-query-value",
        status: 403,
        headers: { "content-type": "text/html" },
        body: "synthetic-sensitive-response-body",
        expectedBlocked: true
      }
    },
    {
      id: "http-429",
      expectedSubtype: "http_429",
      scenario: {
        url: "https://m.booking.naver.com/graphql?query=synthetic-secret-query-value",
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "37" },
        body: "synthetic-sensitive-response-body",
        expectedBlocked: true
      }
    },
    {
      id: "challenge-html",
      expectedSubtype: "challenge_html",
      scenario: {
        url: "https://pcmap-api.place.naver.com/graphql?query=synthetic-secret-query-value",
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body>CAPTCHA synthetic-sensitive-response-body</body></html>",
        expectedBlocked: true
      }
    }
  ];

  for (const fixture of blockedScenarios) {
    const result = runScenario(tempRoot, fixture.id, fixture.scenario);
    assert.equal(result.status, 1, `${fixture.id} must leave a nonzero exit status`);
    const payload = markerPayload(result.stderr);
    assert.equal(payload.version, 1);
    assert.equal(payload.code, "NAVER_ACCESS_BLOCKED");
    assert.equal(payload.providerFailureSubtype, fixture.expectedSubtype);
    assert.equal(result.stderr.match(/CRAWL_ERROR_V1:/gu)?.length, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.calls, 1);
    assert.equal(summary.subtype, fixture.expectedSubtype);
  }

  const rejectedResult = runScenario(tempRoot, "naver-fetch-rejection", {
    url: "https://pcmap.place.naver.com/accommodation/list?query=synthetic-secret-query-value",
    body: "synthetic-sensitive-response-body",
    reject: true,
    expectedFailureCode: "NAVER_TEMPORARY_UNAVAILABLE"
  });
  assert.equal(rejectedResult.status, 1, "NAVER fetch rejection must leave a nonzero exit status");
  const rejectedPayload = markerPayload(rejectedResult.stderr);
  assert.deepEqual(rejectedPayload, {
    version: 1,
    code: "NAVER_TEMPORARY_UNAVAILABLE",
    retryable: true
  });
  assert.equal(rejectedResult.stderr.match(/CRAWL_ERROR_V1:/gu)?.length, 1);
  assert.deepEqual(JSON.parse(rejectedResult.stdout), {
    failed: true,
    code: "NAVER_TEMPORARY_UNAVAILABLE",
    retryable: true,
    calls: 1
  });

  const apolloResult = runScenario(tempRoot, "apollo-marker", {
    url: "https://pcmap.place.naver.com/accommodation/list?query=synthetic-secret-query-value",
    status: 200,
    headers: { "content-type": "text/html" },
    body: '<script>window.__APOLLO_STATE__ = {"message":"CAPTCHA synthetic-sensitive-response-body"}</script>',
    expectedBlocked: false
  });
  assert.equal(apolloResult.status, 0, "valid Apollo marker must not be classified as a challenge");
  assert.equal(apolloResult.stderr.includes("CRAWL_ERROR_V1:"), false);
  assert.deepEqual(JSON.parse(apolloResult.stdout), { blocked: false, status: 200, calls: 1 });

  const approvedOtaResult = runScenario(tempRoot, "approved-ota", {
    url: "https://nol.yanolja.com/discovery/api/list/universal-search/v1/list?query=synthetic-secret-query-value",
    status: 403,
    headers: { "content-type": "text/html" },
    body: "<html>CAPTCHA synthetic-sensitive-response-body</html>",
    expectedBlocked: false
  });
  assert.equal(approvedOtaResult.status, 0, "approved historical OTA response must be untouched");
  assert.equal(approvedOtaResult.stderr.includes("CRAWL_ERROR_V1:"), false);
  assert.deepEqual(JSON.parse(approvedOtaResult.stdout), { blocked: false, status: 403, calls: 1 });

  for (const [id, url] of [
    ["unapproved-host", "https://fixture.invalid/path?query=synthetic-secret-query-value"],
    ["internal-address", "http://127.0.0.1/search?query=synthetic-secret-query-value"],
    ["booking-host-confusion", "https://m.booking.naver.com.fixture.invalid/booking/3/bizes/123/search"],
    ["booking-wrong-path", "https://m.booking.naver.com/booking/3/bizes/123/admin"],
    ["booking-credentials", "https://user:pass@m.booking.naver.com/booking/3/bizes/123/search"],
    ["yeogi-direct-target", "https://www.yeogi.com/domestic-accommodations?query=synthetic-secret-query-value"],
    ["yeogi-wrong-path", "https://www.yeogi.com/admin?query=synthetic-secret-query-value"],
    ["yeogi-host-confusion", "https://www.yeogi.com.fixture.invalid/domestic-accommodations?query=synthetic-secret-query-value"]
  ]) {
    const rejected = runScenario(tempRoot, id, {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: "synthetic-sensitive-response-body",
      expectedRejectedBeforeTransport: true
    });
    assert.equal(rejected.status, 1, `${id} must fail closed`);
    assert.equal(markerPayload(rejected.stderr).code, "NAVER_TEMPORARY_UNAVAILABLE");
    assert.deepEqual(JSON.parse(rejected.stdout), {
      rejected: true,
      code: "FROZEN_V2_REQUEST_NOT_ALLOWED",
      calls: 0
    });
  }

  const allowedRedirect = runScenario(tempRoot, "allowed-redirect", {
    url: "https://www.goodchoice.kr/product/result?keyword=synthetic-secret-query-value",
    status: 200,
    body: "synthetic-sensitive-response-body",
    expectedBlocked: false,
    responses: [
      {
        status: 302,
        headers: { location: "/product/result?redirected=1" },
        body: ""
      },
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "synthetic-sensitive-response-body"
      }
    ]
  });
  assert.equal(allowedRedirect.status, 0, allowedRedirect.stderr || "allowlisted redirect must complete");
  assert.deepEqual(JSON.parse(allowedRedirect.stdout), { blocked: false, status: 200, calls: 2 });

  const verifiedYeogiRedirect = runScenario(tempRoot, "verified-yeogi-redirect", {
    url: "https://www.goodchoice.kr/product/result?keyword=synthetic-secret-query-value",
    status: 403,
    body: "Sorry, you have been blocked synthetic-sensitive-response-body",
    expectedBlocked: false,
    responses: [
      {
        status: 302,
        headers: {
          location: "https://www.yeogi.com/domestic-accommodations?keyword=synthetic-secret-query-value"
        },
        body: ""
      },
      {
        status: 403,
        headers: { "content-type": "text/html" },
        body: "Sorry, you have been blocked synthetic-sensitive-response-body"
      }
    ]
  });
  assert.equal(
    verifiedYeogiRedirect.status,
    0,
    verifiedYeogiRedirect.stderr || "verified Goodchoice to Yeogi redirect must remain a nonfatal OTA response"
  );
  assert.equal(verifiedYeogiRedirect.stderr.includes("CRAWL_ERROR_V1:"), false);
  assert.deepEqual(JSON.parse(verifiedYeogiRedirect.stdout), { blocked: false, status: 403, calls: 2 });

  const rejectedYeogiRedirect = runScenario(tempRoot, "rejected-yeogi-redirect-path", {
    url: "https://www.goodchoice.kr/product/result?keyword=synthetic-secret-query-value",
    expectedFailureCode: "FROZEN_V2_REDIRECT_NOT_ALLOWED",
    body: "synthetic-sensitive-response-body",
    responses: [
      {
        status: 302,
        headers: { location: "https://www.yeogi.com/admin" },
        body: ""
      }
    ]
  });
  assert.equal(rejectedYeogiRedirect.status, 1, "unverified Yeogi redirect path must fail closed");
  assert.equal(markerPayload(rejectedYeogiRedirect.stderr).code, "NAVER_TEMPORARY_UNAVAILABLE");
  assert.deepEqual(JSON.parse(rejectedYeogiRedirect.stdout), {
    failed: true,
    code: "FROZEN_V2_REDIRECT_NOT_ALLOWED",
    retryable: false,
    calls: 1
  });

  const rejectedRedirect = runScenario(tempRoot, "rejected-redirect", {
    url: "https://www.goodchoice.kr/product/result?keyword=synthetic-secret-query-value",
    expectedFailureCode: "FROZEN_V2_REDIRECT_NOT_ALLOWED",
    body: "synthetic-sensitive-response-body",
    responses: [
      {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
        body: ""
      }
    ]
  });
  assert.equal(rejectedRedirect.status, 1, "an allowlisted origin must not redirect to an internal address");
  assert.equal(markerPayload(rejectedRedirect.stderr).code, "NAVER_TEMPORARY_UNAVAILABLE");
  assert.deepEqual(JSON.parse(rejectedRedirect.stdout), {
    failed: true,
    code: "FROZEN_V2_REDIRECT_NOT_ALLOWED",
    retryable: false,
    calls: 1
  });

  const moduleGuardResult = runModuleGuardScenario();
  assert.equal(moduleGuardResult.status, 0, moduleGuardResult.stderr || "module guard child must pass");
  assert.equal(moduleGuardResult.stderr.includes("CRAWL_ERROR_V1:"), false);
  assert.deepEqual(JSON.parse(moduleGuardResult.stdout), {
    nonTargetModuleLoaded: true,
    xlsxCode: "MODULE_NOT_FOUND"
  });

  console.log("v2 frozen fetch safety preload fixture passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
