"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  LocationApiTransportError,
  createFixtureTransport,
  createRequestDescriptor,
  normalizePolicy,
  validateRequestDescriptor
} = require("./location_api_transport.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location API transport fixtures" });
const HOST = "apis.data.go.kr";

function descriptor(overrides = {}) {
  return createRequestDescriptor({
    sourceId: "kto.tour_info.resources",
    operation: "areaBasedList2",
    method: "GET",
    url: `https://${HOST}/B551011/KorService2/areaBasedList2?areaCode=31&pageNo=1`,
    ...overrides
  });
}

async function expectCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof LocationApiTransportError);
    assert.equal(error.code, code);
    return true;
  });
}

async function main() {
  const connectionRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_api_connection_registry.json"),
    "utf8"
  ));
  const registryKosis = connectionRegistry.sources.find((source) => source.sourceId === "kosis.population.sigungu");
  const registryKosisPolicy = normalizePolicy(registryKosis);
  assert.equal(registryKosisPolicy.maxPages, 1);
  assert.equal(registryKosisPolicy.timeoutMs, 15_000);
  assert.equal(registryKosisPolicy.retry.maxAttempts, 3);
  assert.deepEqual(registryKosisPolicy.retry.retryableStatusCodes, [429, 500, 502, 503, 504]);
  assert.equal(registryKosisPolicy.rateLimit.requestsPerMinute, 200);
  assert.equal(registryKosisPolicy.rateLimit.minIntervalMs, 300);
  assert.equal(registryKosisPolicy.rateLimit.maxCellsPerRequest, 40_000);
  assert.equal(registryKosisPolicy.rateLimit.maxConcurrency, 1);
  assert.deepEqual(registryKosisPolicy.credentialEnvNames, ["KOSIS_API_KEY"]);
  const registrySearchAd = connectionRegistry.sources.find((source) => source.sourceId === "naver.searchad.keyword_volume");
  assert.equal(normalizePolicy(registrySearchAd).retry.retryAfterRequiredFor429, true);

  const policy = normalizePolicy({
    allowedHosts: [HOST],
    timeoutMs: 100,
    maxResponseBytes: 64,
    maxPages: 2,
    credentialEnvNames: ["KTO_TOURISM_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"],
    retryPolicy: { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 },
    rateLimitPolicy: { minIntervalMs: 0 }
  });
  assert.equal(policy.allowedHosts[0], HOST);
  assert.equal(policy.retry.retryableStatusCodes.includes(429), true);
  assert.equal(policy.retry.retryableStatusCodes.includes(503), true);

  assert.equal(validateRequestDescriptor(descriptor(), policy).sourceId, "kto.tour_info.resources");
  assert.deepEqual(validateRequestDescriptor(descriptor({
    authRef: { credentialEnvNames: ["KTO_TOURISM_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"] }
  }), policy).authRef.credentialEnvNames, ["KTO_TOURISM_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"]);
  assert.throws(
    () => validateRequestDescriptor(descriptor({ url: "http://apis.data.go.kr/path" }), policy),
    (error) => error.code === "HTTPS_REQUIRED"
  );
  assert.throws(
    () => validateRequestDescriptor(descriptor({ url: "https://example.com/path" }), policy),
    (error) => error.code === "HOST_NOT_ALLOWED"
  );
  assert.throws(
    () => createRequestDescriptor({
      sourceId: "unsafe",
      operation: "query",
      url: `https://${HOST}/path?serviceKey=dummy-secret`
    }),
    (error) => error.code === "CREDENTIAL_MATERIAL_FORBIDDEN"
  );
  assert.throws(
    () => descriptor({ headers: { Authorization: "Bearer dummy-secret" } }),
    (error) => error.code === "CREDENTIAL_MATERIAL_FORBIDDEN"
  );
  assert.throws(
    () => descriptor({ method: "POST", body: { clientSecret: "dummy-secret" } }),
    (error) => error.code === "CREDENTIAL_MATERIAL_FORBIDDEN"
  );
  assert.throws(
    () => descriptor({ authRef: { secretValue: "dummy-secret" } }),
    (error) => error.code === "INVALID_AUTH_REFERENCE"
  );
  assert.throws(
    () => descriptor({ authRef: { credentialEnvNames: ["not-an-env-name"] } }),
    (error) => error.code === "INVALID_AUTH_REFERENCE"
  );
  assert.throws(
    () => validateRequestDescriptor(descriptor({
      authRef: { credentialEnvNames: ["NAVER_MAPS_API_KEY"] }
    }), policy),
    (error) => error.code === "AUTH_REFERENCE_NOT_ALLOWED"
  );

  let successCalls = 0;
  const successTransport = createFixtureTransport({
    policy,
    responder: async ({ descriptor: requestDescriptor, request, attempt }) => {
      successCalls += 1;
      assert.equal(requestDescriptor.operation, "areaBasedList2");
      assert.equal(request.options.redirect, "error");
      assert.equal(attempt, 1);
      return {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "fixture-session" },
        body: JSON.stringify({ rows: [1] })
      };
    }
  });
  const success = await successTransport.execute(descriptor());
  assert.equal(successTransport.mode, "fixture");
  assert.equal(successTransport.actualCallsEnabled, false);
  assert.equal(successTransport.approvalRequired, false);
  assert.equal(success.ok, true);
  assert.equal(success.status, 200);
  assert.equal(success.attempts, 1);
  assert.equal(success.executionMode, "fixture");
  assert.deepEqual(JSON.parse(success.bodyText), { rows: [1] });
  assert.equal(success.headers["set-cookie"], "[REDACTED]");
  assert.equal(successCalls, 1);

  let retryCalls = 0;
  const retryTransport = createFixtureTransport({
    policy,
    responder: async () => {
      retryCalls += 1;
      return retryCalls === 1
        ? { status: 503, headers: {}, body: "temporary" }
        : { status: 200, headers: {}, body: "ready" };
    }
  });
  const retried = await retryTransport.execute(descriptor());
  assert.equal(retried.status, 200);
  assert.equal(retried.attempts, 2);
  assert.equal(retryCalls, 2);

  let providerRetryCalls = 0;
  let providerNow = 0;
  const providerWaits = [];
  const providerPolicyTransport = createFixtureTransport({
    policy,
    sourcePolicies: {
      "naver.searchad.keyword_volume": {
        retryPolicy: {
          maxAttempts: 2,
          baseBackoffMs: 0,
          maxBackoffMs: 60_000,
          backoffByStatus: { "429": 45_000 }
        }
      }
    },
    now: () => providerNow,
    sleep: async (milliseconds) => {
      providerWaits.push(milliseconds);
      providerNow += milliseconds;
    },
    responder: async () => {
      providerRetryCalls += 1;
      return providerRetryCalls === 1
        ? { status: 429, headers: {}, body: "rate limited" }
        : { status: 200, headers: {}, body: "ready" };
    }
  });
  const providerResult = await providerPolicyTransport.execute(descriptor({
    sourceId: "naver.searchad.keyword_volume",
    operation: "keywordstool"
  }));
  assert.equal(providerResult.attempts, 2);
  assert.deepEqual(providerWaits, [45_000], "provider-specific 429 backoff must override the common floor");

  let quotaCalls = 0;
  const quotaTransport = createFixtureTransport({
    policy,
    classifyResponse: ({ response }) => response.bodyText.includes("quota")
      ? { retryable: false, reason: "quota_exhausted" }
      : {},
    responder: async () => {
      quotaCalls += 1;
      return { status: 429, headers: {}, body: "quota exhausted" };
    }
  });
  const quotaResult = await quotaTransport.execute(descriptor());
  assert.equal(quotaResult.status, 429);
  assert.equal(quotaResult.attempts, 1, "provider quota failures must be able to override generic 429 retry");
  assert.equal(quotaCalls, 1);

  let badRequestCalls = 0;
  const badRequestTransport = createFixtureTransport({
    policy,
    responder: async () => {
      badRequestCalls += 1;
      return { status: 400, headers: {}, body: "bad request" };
    }
  });
  const badRequest = await badRequestTransport.execute(descriptor());
  assert.equal(badRequest.status, 400);
  assert.equal(badRequest.attempts, 1, "non-transient statuses must never retry");
  assert.equal(badRequestCalls, 1);

  let postCalls = 0;
  const postTransport = createFixtureTransport({
    policy,
    responder: async () => {
      postCalls += 1;
      return { status: 503, headers: {}, body: "temporary" };
    }
  });
  const postResult = await postTransport.execute(descriptor({
    sourceId: "naver.datalab.search_trend",
    operation: "searchTrend",
    method: "POST",
    url: `https://${HOST}/fixture/datalab`,
    headers: { "content-type": "application/json" },
    body: { timeUnit: "month", keywordGroups: [] },
    retrySafe: false
  }));
  assert.equal(postResult.attempts, 1, "POST is not retryable unless the builder explicitly marks it safe");
  assert.equal(postCalls, 1);

  const oversizedTransport = createFixtureTransport({
    policy: { ...policy, maxResponseBytes: 4 },
    responder: async () => ({ status: 200, headers: {}, body: "12345" })
  });
  await expectCode(() => oversizedTransport.execute(descriptor()), "RESPONSE_TOO_LARGE");

  const pageTransport = createFixtureTransport({
    policy,
    responder: async ({ descriptor: current }) => ({ status: 200, headers: {}, body: new URL(current.url).searchParams.get("pageNo") })
  });
  const pages = await pageTransport.executePaginated({
    initialDescriptor: descriptor(),
    getNextDescriptor: ({ descriptor: current, pageIndex }) => pageIndex === 0
      ? descriptor({ url: new URL(current.url.replace("pageNo=1", "pageNo=2")).toString() })
      : null
  });
  assert.equal(pages.pageCount, 2);
  assert.deepEqual(pages.pages.map((page) => page.bodyText), ["1", "2"]);

  await expectCode(
    () => pageTransport.executePaginated({
      initialDescriptor: descriptor(),
      getNextDescriptor: ({ pageIndex }) => descriptor({
        url: `https://${HOST}/fixture?pageNo=${pageIndex + 2}`
      })
    }),
    "PAGE_LIMIT_EXCEEDED"
  );

  let fakeNow = 0;
  const waits = [];
  const rateLimited = createFixtureTransport({
    policy: {
      allowedHosts: [HOST],
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      rateLimitPolicy: { requestsPerMinute: 600 }
    },
    now: () => fakeNow,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      fakeNow += milliseconds;
    },
    responder: async () => ({ status: 200, headers: {}, body: "ok" })
  });
  await rateLimited.execute(descriptor());
  await rateLimited.execute(descriptor());
  assert.deepEqual(waits, [100], "requestsPerMinute must be enforced as a minimum dispatch interval");

  let concurrentCalls = 0;
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  let signalFirstEntered;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { signalFirstEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const serialTransport = createFixtureTransport({
    policy: {
      allowedHosts: [HOST],
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      rateLimitPolicy: { maximumConcurrency: 1 }
    },
    responder: async () => {
      concurrentCalls += 1;
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      if (concurrentCalls === 1) {
        signalFirstEntered();
        await firstGate;
      }
      activeCalls -= 1;
      return { status: 200, headers: {}, body: "ok" };
    }
  });
  const firstConcurrentRequest = serialTransport.execute(descriptor());
  await firstEntered;
  const secondConcurrentRequest = serialTransport.execute(descriptor({
    url: `https://${HOST}/fixture?pageNo=2`
  }));
  await Promise.resolve();
  assert.equal(concurrentCalls, 1, "maximumConcurrency=1 must queue a second dispatch");
  releaseFirst();
  await Promise.all([firstConcurrentRequest, secondConcurrentRequest]);
  assert.equal(maximumActiveCalls, 1);
  assert.equal(concurrentCalls, 2);

  const kosisPolicy = normalizePolicy({
    allowedHosts: [HOST],
    credentialEnvNames: ["KTO_TOURISM_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"],
    rateLimitPolicy: { requestsPerMinute: 200, maxCellsPerRequest: 40_000 }
  });
  assert.equal(kosisPolicy.rateLimit.minIntervalMs, 300);
  assert.throws(
    () => validateRequestDescriptor(descriptor({ estimatedCells: 40_001 }), kosisPolicy),
    (error) => error.code === "REQUEST_SIZE_POLICY_EXCEEDED"
  );

  const timeoutTransport = createFixtureTransport({
    policy: {
      allowedHosts: [HOST],
      timeoutMs: 5,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 0, maxBackoffMs: 0 }
    },
    responder: async () => new Promise(() => {})
  });
  await expectCode(() => timeoutTransport.execute(descriptor()), "TIMEOUT");

  assert.equal(networkGuard.blockedAttempts(), 0, "fixture transport tests must not attempt external network access");
  console.log("Location API fixture transport tests passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => networkGuard.restore());
