"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  APPROVAL_SCOPE,
  LocationApiTransportError,
  assertExecutionApproved,
  createApprovalDescriptorHash,
  createLiveTransport,
  createRequestDescriptor
} = require("./location_api_transport.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location API approval fixtures" });
const now = "2026-08-05T00:00:00.000Z";
const request = createRequestDescriptor({
  sourceId: "kto.tour_info.resources",
  operation: "areaBasedList2",
  method: "GET",
  url: "https://apis.data.go.kr/B551011/KorService2/areaBasedList2?areaCode=31"
});

const validReceipt = Object.freeze({
  approvalId: "fixture-approval-do-not-use-live",
  scope: APPROVAL_SCOPE,
  approved: true,
  allowExternalNetwork: true,
  issuedAt: "2026-08-04T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
  sourceIds: [request.sourceId],
  allowedHosts: ["apis.data.go.kr"],
  descriptorHash: createApprovalDescriptorHash(request)
});

function expectSyncCode(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof LocationApiTransportError);
    assert.equal(error.code, code);
    return true;
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
  expectSyncCode(
    () => assertExecutionApproved({ descriptor: request, actualCallsEnabled: false, approvalReceipt: validReceipt, now }),
    "LIVE_CALLS_DISABLED"
  );
  expectSyncCode(
    () => assertExecutionApproved({ descriptor: request, actualCallsEnabled: true, approvalReceipt: null, now }),
    "APPROVAL_REQUIRED"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: request,
      actualCallsEnabled: true,
      approvalReceipt: { ...validReceipt, sourceIds: ["kto.tour_info.events"] },
      now
    }),
    "APPROVAL_SOURCE_MISMATCH"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: request,
      actualCallsEnabled: true,
      approvalReceipt: { ...validReceipt, allowedHosts: ["openapi.naver.com"] },
      now
    }),
    "APPROVAL_HOST_MISMATCH"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: request,
      actualCallsEnabled: true,
      approvalReceipt: { ...validReceipt, expiresAt: "2026-08-05T00:00:00.000Z" },
      now
    }),
    "APPROVAL_EXPIRED"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: request,
      actualCallsEnabled: true,
      approvalReceipt: { ...validReceipt, scope: "different_scope" },
      now
    }),
    "APPROVAL_INVALID"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: createRequestDescriptor({
        ...request,
        url: "https://apis.data.go.kr/B551011/KorService2/areaBasedList2?areaCode=48"
      }),
      actualCallsEnabled: true,
      approvalReceipt: validReceipt,
      now
    }),
    "APPROVAL_DESCRIPTOR_MISMATCH"
  );
  expectSyncCode(
    () => assertExecutionApproved({
      descriptor: createRequestDescriptor({
        ...request,
        authRef: { credentialEnvNames: ["DATA_GO_KR_SERVICE_KEY"] }
      }),
      actualCallsEnabled: true,
      approvalReceipt: validReceipt,
      now
    }),
    "APPROVAL_DESCRIPTOR_MISMATCH"
  );
  assert.equal(assertExecutionApproved({ descriptor: request, actualCallsEnabled: true, approvalReceipt: validReceipt, now }), true);

  const disabled = createLiveTransport({
    policy: { allowedHosts: ["apis.data.go.kr"] },
    actualCallsEnabled: false,
    approvalReceipt: validReceipt,
    now: () => Date.parse(now)
  });
  assert.equal(disabled.mode, "live");
  assert.equal(disabled.actualCallsEnabled, false);
  assert.equal(disabled.approvalRequired, true);
  await expectCode(() => disabled.execute(request), "LIVE_CALLS_DISABLED");

  const unapproved = createLiveTransport({
    policy: { allowedHosts: ["apis.data.go.kr"] },
    actualCallsEnabled: true,
    approvalReceipt: null,
    now: () => Date.parse(now)
  });
  await expectCode(() => unapproved.execute(request), "APPROVAL_REQUIRED");

  const noExecutor = createLiveTransport({
    policy: { allowedHosts: ["apis.data.go.kr"] },
    actualCallsEnabled: true,
    approvalReceipt: validReceipt,
    now: () => Date.parse(now)
  });
  await expectCode(() => noExecutor.execute(request), "TRANSPORT_NOT_INJECTED");

  expectSyncCode(
    () => createLiveTransport({ fetchImpl: async () => ({ status: 200 }), policy: { allowedHosts: ["apis.data.go.kr"] } }),
    "TRANSPORT_INTERFACE_INVALID"
  );

  let authorizedExecutorCalls = 0;
  const authorized = createLiveTransport({
    policy: { allowedHosts: ["apis.data.go.kr"], retryPolicy: { maxAttempts: 1 } },
    actualCallsEnabled: true,
    approvalReceipt: validReceipt,
    now: () => Date.parse(now),
    authorizeRequest: (descriptor) => {
      const url = new URL(descriptor.url);
      url.searchParams.set("serviceKey", "fixture-service-key");
      return {
        ...descriptor,
        url: url.toString(),
        headers: { ...descriptor.headers, Authorization: "Bearer fixture-token" }
      };
    },
    executor: async ({ request: executable }) => {
      authorizedExecutorCalls += 1;
      assert.equal(new URL(executable.url).searchParams.get("serviceKey"), "fixture-service-key");
      assert.equal(executable.options.headers.authorization, "Bearer fixture-token");
      return { status: 200, headers: {}, body: "fixture-ok" };
    }
  });
  const authorizedResult = await authorized.execute(request);
  assert.equal(authorizedResult.status, 200);
  assert.equal(authorizedExecutorCalls, 1, "auth-only additions may reach the injected fixture executor");

  async function expectAuthorizationMutationBlocked(authorizeRequest, descriptor = request) {
    let executorCalls = 0;
    const transport = createLiveTransport({
      policy: { allowedHosts: ["apis.data.go.kr"], retryPolicy: { maxAttempts: 1 } },
      actualCallsEnabled: true,
      approvalReceipt: {
        ...validReceipt,
        sourceIds: [descriptor.sourceId],
        allowedHosts: [new URL(descriptor.url).hostname],
        descriptorHash: createApprovalDescriptorHash(descriptor)
      },
      now: () => Date.parse(now),
      authorizeRequest,
      executor: async () => {
        executorCalls += 1;
        return { status: 200, headers: {}, body: "must-not-run" };
      }
    });
    await expectCode(() => transport.execute(descriptor), "AUTHORIZED_REQUEST_SCOPE_MISMATCH");
    assert.equal(executorCalls, 0, "mutated authorized requests must be rejected before executor dispatch");
  }

  await expectAuthorizationMutationBlocked((descriptor) => ({
    ...descriptor,
    url: descriptor.url.replace("/areaBasedList2", "/searchFestival2")
  }));
  await expectAuthorizationMutationBlocked((descriptor) => {
    const url = new URL(descriptor.url);
    url.searchParams.set("areaCode", "48");
    return { ...descriptor, url: url.toString() };
  });
  await expectAuthorizationMutationBlocked((descriptor) => ({
    ...descriptor,
    headers: { ...descriptor.headers, "x-extra-routing": "changed" }
  }));

  const postRequest = createRequestDescriptor({
    sourceId: request.sourceId,
    operation: "fixturePost",
    method: "POST",
    url: "https://apis.data.go.kr/fixture/post",
    headers: { "content-type": "application/json" },
    body: { regionKey: "kr_gyeonggi_pocheon" }
  });
  await expectAuthorizationMutationBlocked((descriptor) => ({
    ...descriptor,
    body: { regionKey: "kr_gyeongnam_hadong" }
  }), postRequest);

  assert.equal(networkGuard.blockedAttempts(), 0, "approval fixtures must not reach a network executor");
  console.log("Location API approval gate tests passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => networkGuard.restore());
