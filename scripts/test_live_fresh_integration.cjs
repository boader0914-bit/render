"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createFreshIntegrationRepository } = require("./integration/repositories/fresh_store.cjs");
const { createFreshCollectionService } = require("./integration/services/fresh_collection_service.cjs");
const { createFreshCollectionWorker } = require("./integration/services/fresh_collection_worker.cjs");
const { createConfiguredProvider } = require("./integration/bootstrap/fresh_platform_runtime.cjs");
const { PROVIDER_KEYS, approvalManifestDigest } = require("./integration/services/v2_live_collection_provider.cjs");

function runtimeApprovalManifest() {
  return {
    version: "v2-live-approval-v1",
    approvalId: "approval-runtime-gate-228",
    issuedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    targets: [{ targetName: "승인 테스트 숙소", regionCode: "test-region", targetDates: ["2026-08-15"] }],
    providers: Object.values(PROVIDER_KEYS),
    stages: ["discovery", "quick", "detail", "ota"],
    requestCaps: { perRun: 20, perDay: 100 },
    providerCaps: {
      [PROVIDER_KEYS.naverSearch]: { perRun: 20, perDay: 100, costMicros: 0, stages: ["discovery", "quick", "detail"] },
      [PROVIDER_KEYS.naverBooking]: { perRun: 20, perDay: 100, costMicros: 0, stages: ["detail"] },
      [PROVIDER_KEYS.nol]: { perRun: 20, perDay: 100, costMicros: 0, stages: ["ota"] },
      [PROVIDER_KEYS.ddnayo]: { perRun: 20, perDay: 100, costMicros: 0, stages: ["ota"] }
    },
    cost: { currency: "KRW", maximumCostMicros: 0 }
  };
}

function createLiveFixtureProvider(clock) {
  let externalNetworkCalls = 0;
  const base = (source) => ({
    provider: "v2-live-collection",
    providerMode: "live",
    dataMode: "live",
    synthetic: false,
    source,
    collectedAt: new Date(clock()).toISOString()
  });
  return Object.freeze({
    id: "v2-live-collection",
    kind: "live",
    enabled: true,
    synthetic: false,
    dataMode: "live",
    seedSourceUrl: "https://pcmap.place.naver.com/accommodation/list",
    async discover(input) {
      externalNetworkCalls += 1;
      return {
        ...base("https://pcmap.place.naver.com/accommodation/list?query=fresh-live"),
        candidate: {
          companyName: input.targetName,
          regionLabel: input.regionLabel,
          address: "경남 통영시 산양읍 1",
          placeId: "live2280001",
          bookingBusinessId: "booking-live2280001",
          externalIdentities: [{ source: "naver-place", externalId: "live2280001" }],
          duplicateCandidates: []
        }
      };
    },
    async collectQuick(input) {
      externalNetworkCalls += 1;
      return {
        ...base("https://m.place.naver.com/accommodation/live2280001/home"),
        profile: {
          companyName: input.targetName,
          regionLabel: input.regionLabel,
          category: "glamping",
          rank: 3,
          reviewCount: 124,
          latitude: 34.841,
          longitude: 128.423,
          rankingCondition: {
            conditionHash: "b".repeat(64),
            requestKey: `v2req_${"c".repeat(64)}`,
            provider: PROVIDER_KEYS.naverSearch,
            channel: "naver-search"
          }
        }
      };
    },
    async collectDetail(input) {
      externalNetworkCalls += 1;
      return {
        ...base("https://m.booking.naver.com/graphql"),
        products: [{
          productKey: "booking-live-room-1",
          targetDate: input.targetDate,
          price: 149000,
          totalStock: 5,
          availableStock: 2
        }]
      };
    },
    async collectOta(input) {
      externalNetworkCalls += 1;
      return {
        ...base("https://nol.yanolja.com/discovery/api/list/universal-search/v1/list"),
        channels: [{
          channel: "yanolja-nol",
          productKey: "company",
          targetDate: input.targetDate,
          exposed: true,
          provider: PROVIDER_KEYS.nol,
          sourceUrl: "https://nol.yanolja.com/discovery/api/list/universal-search/v1/list",
          requestKey: `v2req_${"d".repeat(64)}`
        }]
      };
    },
    diagnostics() {
      return { externalNetworkCalls, syntheticCalls: 0, credentialReads: 0 };
    }
  });
}

function testRuntimeProviderGate() {
  const productionSynthetic = createConfiguredProvider({
    env: { NODE_ENV: "production", V2_INTEGRATION_FRESH_PROVIDER: "synthetic" }
  });
  assert.equal(productionSynthetic.kind, "disabled");
  assert.equal(productionSynthetic.enabled, false);
  assert.equal(productionSynthetic.diagnostics().externalNetworkCalls, 0);

  const renderSyntheticWithoutNodeEnv = createConfiguredProvider({
    env: {
      RENDER: "true",
      V2_INTEGRATION_FRESH_PROVIDER: "synthetic",
      V2_INTEGRATION_SYNTHETIC_TEST_ENABLED: "true"
    }
  });
  assert.equal(renderSyntheticWithoutNodeEnv.kind, "disabled");
  assert.equal(renderSyntheticWithoutNodeEnv.enabled, false);
  assert.equal(renderSyntheticWithoutNodeEnv.diagnostics().externalNetworkCalls, 0);

  const injectedRenderSynthetic = createConfiguredProvider({
    env: { RENDER: "true" },
    provider: createLiveFixtureProvider(Date.now)
  });
  assert.equal(injectedRenderSynthetic.kind, "live");

  const injectedSynthetic = createConfiguredProvider({
    env: { RENDER: "true" },
    provider: { kind: "synthetic", synthetic: true }
  });
  assert.equal(injectedSynthetic.kind, "disabled");

  const liveDefault = createConfiguredProvider({
    env: { NODE_ENV: "production", V2_INTEGRATION_FRESH_PROVIDER: "v2-live" }
  });
  assert.equal(liveDefault.kind, "live");
  assert.equal(liveDefault.enabled, false);
  assert(liveDefault.diagnostics().reasons.includes("live-disabled"));
  assert(liveDefault.diagnostics().reasons.includes("approval-manifest-invalid"));
  assert(liveDefault.diagnostics().reasons.includes("per-run-budget-disabled"));
  assert(liveDefault.diagnostics().reasons.includes("daily-budget-disabled"));
  assert(liveDefault.diagnostics().reasons.includes("naver-search-mode-disabled"));
  assert.equal(liveDefault.diagnostics().externalNetworkCalls, 0);

  const apiHubMissingCredentials = createConfiguredProvider({
    env: {
      NODE_ENV: "production",
      V2_INTEGRATION_FRESH_PROVIDER: "v2-live",
      V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE: "api-hub"
    }
  });
  assert.equal(apiHubMissingCredentials.enabled, false);
  assert.equal(apiHubMissingCredentials.diagnostics().naverSearchMode, "api-hub");
  assert(apiHubMissingCredentials.diagnostics().reasons.includes("naver-api-hub-credentials-missing"));
  assert.deepEqual(apiHubMissingCredentials.diagnostics().hostnameAllowlist[PROVIDER_KEYS.naverSearch], ["naverapihub.apigw.ntruss.com"]);
  assert.equal(apiHubMissingCredentials.diagnostics().externalNetworkCalls, 0);

  const officialManifest = runtimeApprovalManifest();
  const officialKeyId = "runtime-api-hub-id-not-real";
  const officialKey = "runtime-api-hub-secret-not-real";
  const officialLive = createConfiguredProvider({
    env: {
      NODE_ENV: "production",
      V2_INTEGRATION_FRESH_PROVIDER: "v2-live",
      V2_INTEGRATION_LIVE_COLLECTION_ENABLED: "true",
      V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE: "api-hub",
      V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY_ID: officialKeyId,
      V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY: officialKey,
      V2_INTEGRATION_LIVE_APPROVAL_MANIFEST: JSON.stringify(officialManifest),
      V2_INTEGRATION_LIVE_APPROVAL_SHA256: approvalManifestDigest(officialManifest),
      V2_INTEGRATION_LIVE_APPROVED_PROVIDERS: "naver-search",
      V2_INTEGRATION_LIVE_REQUESTED_STAGES: "discovery,quick",
      V2_INTEGRATION_LIVE_NAVER_SEARCH_KILL_SWITCH: "false",
      V2_INTEGRATION_LIVE_REQUESTS_PER_RUN: "20",
      V2_INTEGRATION_LIVE_REQUESTS_PER_DAY: "100"
    },
    transport: Object.assign(async () => {
      throw new Error("Runtime wiring test must not call transport");
    }, { transportKind: "injected" }),
    quotaRepository: { reserveProviderRequest: async () => { throw new Error("runtime wiring test must not reserve quota"); } }
  });
  assert.equal(officialLive.enabled, true);
  assert.equal(officialLive.diagnostics().naverSearchMode, "api-hub");
  const officialDiagnostics = JSON.stringify(officialLive.diagnostics());
  assert.equal(officialDiagnostics.includes(officialKeyId), false);
  assert.equal(officialDiagnostics.includes(officialKey), false);
  assert.equal(officialLive.diagnostics().externalNetworkCalls, 0);

  const testSynthetic = createConfiguredProvider({
    env: { NODE_ENV: "test", V2_INTEGRATION_FRESH_PROVIDER: "synthetic" }
  });
  assert.equal(testSynthetic.kind, "synthetic");
  assert.equal(testSynthetic.enabled, true);

  const approvalManifest = runtimeApprovalManifest();
  const live = createConfiguredProvider({
    env: {
      NODE_ENV: "production",
      V2_INTEGRATION_FRESH_PROVIDER: "v2-live",
      V2_INTEGRATION_LIVE_COLLECTION_ENABLED: "true",
      V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE: "internal-web",
      V2_INTEGRATION_LIVE_APPROVAL_MANIFEST: JSON.stringify(approvalManifest),
      V2_INTEGRATION_LIVE_APPROVAL_SHA256: approvalManifestDigest(approvalManifest),
      V2_INTEGRATION_LIVE_APPROVED_PROVIDERS: "naver-search,naver-booking,nol,ddnayo",
      V2_INTEGRATION_LIVE_NAVER_SEARCH_KILL_SWITCH: "false",
      V2_INTEGRATION_LIVE_NAVER_BOOKING_KILL_SWITCH: "false",
      V2_INTEGRATION_LIVE_NOL_KILL_SWITCH: "false",
      V2_INTEGRATION_LIVE_DDNAYO_KILL_SWITCH: "false",
      V2_INTEGRATION_LIVE_REQUESTS_PER_RUN: "20",
      V2_INTEGRATION_LIVE_REQUESTS_PER_DAY: "100"
    },
    transport: Object.assign(async () => {
      throw new Error("Provider gate test must not call transport");
    }, { transportKind: "injected" }),
    quotaRepository: { reserveProviderRequest: async () => { throw new Error("gate test must not reserve quota"); } }
  });
  assert.equal(live.kind, "live");
  assert.equal(live.enabled, true);
  assert.equal(live.diagnostics().externalNetworkCalls, 0);
}

async function testLiveVerticalSlice() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-v2-live-fresh-"));
  const dataDir = path.join(temporaryRoot, "integration-store");
  const legacyDir = path.join(temporaryRoot, "legacy-boundary");
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  const clock = () => now;
  try {
    await fsp.mkdir(legacyDir, { recursive: true });
    const repository = createFreshIntegrationRepository({
      env: {
        NODE_ENV: "test",
        V2_INTEGRATION_DATA_DIR: dataDir,
        DATA_DIR: legacyDir
      },
      projectRoot: temporaryRoot,
      dataDir,
      legacyPaths: [legacyDir],
      clock
    });
    await repository.initialize();
    const provider = createLiveFixtureProvider(clock);
    const service = createFreshCollectionService({
      repository,
      provider,
      clock,
      idFactory: () => "fresh_run_live_contract"
    });
    const worker = createFreshCollectionWorker({
      repository,
      provider,
      clock,
      workerId: "live-contract-worker"
    });
    const submitted = await service.submit({
      clientRequestId: "live-contract-request-228",
      targetName: "실수집 계약 글램핑",
      regionCode: "gyeongnam-tongyeong",
      regionLabel: "경남 통영",
      targetDate: "2026-08-15",
      kind: "admin-collection",
      collectionMode: "precision",
      productMode: "all",
      tenantCompanyId: "company_admin"
    }, { accountId: "admin_live", role: "admin" });
    const completed = await worker.processRun(submitted.run.runId);
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.run.result.dataMode, "live");

    const companyId = completed.run.companyId;
    const identity = await repository.getCompany(companyId);
    const projection = await repository.getCompany(companyId, { projection: "business-safe" });
    const observations = await repository.listObservations({ companyId, limit: 100 });
    const diagnostics = await repository.diagnostics();
    assert.equal(identity.synthetic, false);
    assert.equal(identity.dataMode, "live");
    assert.equal(projection.synthetic, false);
    assert.equal(projection.dataMode, "live");
    assert.equal(projection.dataQuality.dataCompleteness.score, 100);
    assert.ok(observations.length >= 9);
    assert.ok(observations.every((row) => (
      row.synthetic === false
      && row.dataMode === "live"
      && row.provenance?.provider
      && row.provenance?.dataMode === "live"
    )));
    const category = observations.find((row) => row.kind === "profile.category");
    const ranking = observations.find((row) => row.kind === "profile.rank");
    const ota = observations.find((row) => row.kind === "ota.exposure");
    assert.equal(category.value, "glamping");
    assert.equal(ranking.conditionHash, "b".repeat(64));
    assert.equal(ranking.provenance.requestKey, `v2req_${"c".repeat(64)}`);
    assert.equal(ota.provenance.provider, PROVIDER_KEYS.nol);
    assert.equal(ota.provenance.sourceUrl, "https://nol.yanolja.com/discovery/api/list/universal-search/v1/list");
    assert.equal(ota.provenance.requestKey, `v2req_${"d".repeat(64)}`);
    assert.deepEqual(
      [...new Set(observations.filter((row) => row.kind === "product.price").map((row) => row.targetDate))].sort(),
      ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"]
    );
    assert.equal(diagnostics.layerCounts.raw, 10);
    assert.equal(diagnostics.providerCalls, 10);
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);

    const interest = await repository.addInterest({
      actorAccountId: "account_business_live",
      tenantCompanyId: "company_admin",
      companyId
    }, { type: "account", accountId: "account_business_live", role: "b2b" });
    assert.equal(interest.idempotent, false);
    assert.equal((await repository.addInterest({
      actorAccountId: "account_business_live",
      tenantCompanyId: "company_admin",
      companyId
    })).idempotent, true);
    assert.equal((await repository.listInterests({
      actorAccountId: "account_business_live",
      tenantCompanyId: "company_admin"
    })).length, 1);
    await assert.rejects(
      () => repository.addInterest({
        actorAccountId: "account_business_live",
        tenantCompanyId: "company_other",
        companyId
      }),
      (error) => error.code === "FRESH_TENANT_FORBIDDEN" && error.statusCode === 403
    );
    assert.equal((await repository.removeInterest({
      actorAccountId: "account_business_live",
      tenantCompanyId: "company_admin",
      companyId
    })).removed, 1);
    assert.equal((await repository.listInterests({ actorAccountId: "account_business_live" })).length, 0);

    now += 60_000;
    const replay = await service.submit({
      ...submitted.run.input,
      clientRequestId: "live-contract-request-228"
    }, { accountId: "admin_live", role: "admin" });
    assert.equal(replay.idempotent, true);
    assert.equal((await repository.diagnostics()).providerCalls, 10);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testOfficialApiHubFastVerticalSlice() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-v2-api-hub-fresh-"));
  const dataDir = path.join(temporaryRoot, "integration-store");
  const legacyDir = path.join(temporaryRoot, "legacy-boundary");
  const clock = () => Date.parse("2026-07-30T03:00:00.000Z");
  const targetName = "승인 테스트 숙소";
  const targetDate = "2026-08-15";
  const regionCode = "test-region";
  const approval = runtimeApprovalManifest();
  let injectedCalls = 0;
  try {
    await fsp.mkdir(legacyDir, { recursive: true });
    const repository = createFreshIntegrationRepository({
      env: { NODE_ENV: "test", V2_INTEGRATION_DATA_DIR: dataDir, DATA_DIR: legacyDir },
      projectRoot: temporaryRoot,
      dataDir,
      legacyPaths: [legacyDir],
      clock
    });
    await repository.initialize();
    const transport = Object.assign(async (request) => {
      injectedCalls += 1;
      assert.equal(new URL(request.url).hostname, "naverapihub.apigw.ntruss.com");
      return {
        status: 200,
        headers: {},
        url: request.url,
        body: {
          lastBuildDate: "Wed, 30 Jul 2026 12:00:00 +0900",
          total: 1,
          start: 1,
          display: 1,
          items: [{
            title: `<b>${targetName}</b>`,
            link: "https://untrusted-provider-link.example/landing",
            category: "숙박>펜션",
            description: "",
            telephone: "",
            address: `${regionCode} 신규수집로 1`,
            roadAddress: `${regionCode} 신규수집로 1`,
            mapx: "311277",
            mapy: "552097"
          }]
        }
      };
    }, { transportKind: "injected" });
    const provider = createConfiguredProvider({
      env: {
        NODE_ENV: "production",
        V2_INTEGRATION_FRESH_PROVIDER: "v2-live",
        V2_INTEGRATION_LIVE_COLLECTION_ENABLED: "true",
        V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE: "api-hub",
        V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY_ID: "api-hub-test-id-not-real",
        V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY: "api-hub-test-key-not-real",
        V2_INTEGRATION_LIVE_APPROVAL_MANIFEST: JSON.stringify(approval),
        V2_INTEGRATION_LIVE_APPROVAL_SHA256: approvalManifestDigest(approval),
        V2_INTEGRATION_LIVE_APPROVED_PROVIDERS: "naver-search",
        V2_INTEGRATION_LIVE_REQUESTED_STAGES: "discovery,quick",
        V2_INTEGRATION_LIVE_NAVER_SEARCH_KILL_SWITCH: "false",
        V2_INTEGRATION_LIVE_REQUESTS_PER_RUN: "20",
        V2_INTEGRATION_LIVE_REQUESTS_PER_DAY: "100"
      },
      transport,
      quotaRepository: repository,
      clock
    });
    const service = createFreshCollectionService({
      repository,
      provider,
      clock,
      idFactory: () => "fresh_run_api_hub_fast"
    });
    const worker = createFreshCollectionWorker({ repository, provider, clock, workerId: "api-hub-fast-worker" });
    const submitted = await service.submit({
      clientRequestId: "api-hub-fast-request-228",
      targetName,
      regionCode,
      regionLabel: regionCode,
      targetDate,
      kind: "admin-collection",
      collectionMode: "fast",
      collectionPurpose: "basic_db",
      productMode: "all",
      tenantCompanyId: "company_admin"
    }, { accountId: "admin_live", role: "admin" });
    const completed = await worker.processRun(submitted.run.runId);
    assert.equal(completed.outcome, "completed");
    assert.deepEqual(completed.run.executionStages, ["discovery", "quick", "finalize"]);
    assert.equal(injectedCalls, 1, "discovery and quick must reuse the one bounded official search response");
    const projection = await repository.getCompany(completed.run.companyId, { projection: "business-safe" });
    const observations = await repository.listObservations({ companyId: completed.run.companyId, limit: 100 });
    const diagnostics = await repository.diagnostics();
    assert.equal(projection.synthetic, false);
    assert.equal(projection.dataMode, "live");
    assert.deepEqual(observations.map((row) => row.kind).sort(), ["profile.category", "profile.company-name", "profile.region"]);
    assert.ok(observations.every((row) => row.sourceUrl.startsWith("https://naverapihub.apigw.ntruss.com/search/v1/local")));
    assert.equal(JSON.stringify({ projection, observations }).includes("untrusted-provider-link.example"), false, "third-party result links must not enter the trusted fresh store");
    assert.equal(diagnostics.providerCalls, 1);
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);
    assert.equal(provider.diagnostics().transportAttempts, 1);
    assert.equal(provider.diagnostics().externalNetworkCalls, 0, "injected acceptance must never count as a real network request");
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testDurableQuotaReservationAcrossWorkersAndRestart() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-v2-live-quota-"));
  const dataDir = path.join(temporaryRoot, "integration-store");
  const repositoryOptions = {
    env: { NODE_ENV: "test", V2_INTEGRATION_DATA_DIR: dataDir },
    projectRoot: temporaryRoot,
    dataDir,
    legacyPaths: [],
    clock: () => Date.parse("2026-07-30T02:00:00.000Z")
  };
  try {
    const firstWorkerRepository = createFreshIntegrationRepository(repositoryOptions);
    const secondWorkerRepository = createFreshIntegrationRepository(repositoryOptions);
    await firstWorkerRepository.initialize();
    await secondWorkerRepository.initialize();
    const service = createFreshCollectionService({
      repository: firstWorkerRepository,
      clock: repositoryOptions.clock,
      idFactory: () => "fresh_run_quota_contract"
    });
    const submitted = await service.submit({
      clientRequestId: "live-quota-request-228",
      targetName: "quota reservation target",
      regionCode: "test-region",
      regionLabel: "test-region",
      targetDate: "2026-08-15",
      kind: "admin-collection",
      collectionMode: "fast",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      tenantCompanyId: "company_admin"
    }, { accountId: "admin_live", role: "admin" });
    const base = {
      approvalId: "approval-durable-quota-228",
      approvalDigest: "a".repeat(64),
      provider: PROVIDER_KEYS.naverSearch,
      stage: "discovery",
      runId: submitted.run.runId,
      targetHash: "target-scope-hash",
      day: "2026-07-30",
      costMicros: 0,
      currency: "KRW",
      caps: {
        perRun: 1,
        perDay: 10,
        providerPerRun: 1,
        providerPerDay: 10,
        maximumCostMicros: 0
      }
    };
    await assert.rejects(
      () => firstWorkerRepository.reserveProviderRequest({
        ...base,
        reservationId: "reservation-cost-overflow",
        requestKey: "request-cost-overflow",
        costMicros: 1
      }, { type: "worker", id: "worker-cost-guard" }),
      (error) => error.code === "FRESH_PROVIDER_QUOTA_EXCEEDED"
    );
    const attempts = await Promise.allSettled([
      firstWorkerRepository.reserveProviderRequest({
        ...base,
        reservationId: "reservation-worker-one",
        requestKey: "request-worker-one"
      }, { type: "worker", id: "worker-one" }),
      secondWorkerRepository.reserveProviderRequest({
        ...base,
        reservationId: "reservation-worker-two",
        requestKey: "request-worker-two"
      }, { type: "worker", id: "worker-two" })
    ]);
    assert.equal(attempts.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((row) => row.status === "rejected").length, 1);
    assert.equal(attempts.find((row) => row.status === "rejected").reason.code, "FRESH_PROVIDER_QUOTA_EXCEEDED");

    const winnerIndex = attempts.findIndex((row) => row.status === "fulfilled");
    const winningReservationId = winnerIndex === 0 ? "reservation-worker-one" : "reservation-worker-two";
    const winningRequestKey = winnerIndex === 0 ? "request-worker-one" : "request-worker-two";
    const restartedRepository = createFreshIntegrationRepository(repositoryOptions);
    await restartedRepository.initialize();
    await assert.rejects(
      () => restartedRepository.reserveProviderRequest({
        ...base,
        reservationId: winningReservationId,
        requestKey: "request-replay-conflict"
      }, { type: "worker", id: "worker-after-restart" }),
      (error) => error.code === "FRESH_PROVIDER_RESERVATION_CONFLICT"
    );
    const replay = await restartedRepository.reserveProviderRequest({
      ...base,
      reservationId: winningReservationId,
      requestKey: winningRequestKey
    }, { type: "worker", id: "worker-after-restart" });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.reservation.approvalDigest, "a".repeat(64));
    assert.deepEqual(replay.reservation.caps, base.caps);
    await assert.rejects(
      () => restartedRepository.reserveProviderRequest({
        ...base,
        reservationId: "reservation-after-restart",
        requestKey: "request-after-restart"
      }, { type: "worker", id: "worker-after-restart" }),
      (error) => error.code === "FRESH_PROVIDER_QUOTA_EXCEEDED"
    );
    const diagnostics = await restartedRepository.diagnostics();
    assert.equal(diagnostics.providerCalls, 1);
    assert.equal(diagnostics.providerReservations, 1);
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  testRuntimeProviderGate();
  await testLiveVerticalSlice();
  await testOfficialApiHubFastVerticalSlice();
  await testDurableQuotaReservationAcrossWorkersAndRestart();
  console.log("V2 live fresh integration contract checks passed (external calls: injected 10, real network: 0)");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
