"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const registry = require("../web/data/location_region_registry.json");
const {
  buildRegionInsightState,
  publishRegionInsightState
} = require("./region_insight_contract.cjs");
const { createRegionInsightRuntime } = require("./region_insight_runtime.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "publication store fixtures" });

function draftPayload(value = 72) {
  return {
    locationAttractiveness: {
      value,
      modelVersion: "publication-store-fixture-v1",
      components: [{ key: "market_demand", value, weight: 1, evidenceIds: ["fixture-demand"] }]
    },
    dataQuality: {
      status: "ready",
      score: 88,
      grade: "A",
      penalties: [],
      coverage: { numerator: 18, denominator: 18, note: "fixture coverage" },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05",
        updatedAt: "2026-08-05T00:00:00.000Z",
        ageDays: 0
      }
    }
  };
}

async function writeFixtureStore(root, name, store) {
  const filePath = path.join(root, name, "regions.json");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return filePath;
}

function fixtureRuntime(filePath, registryInput = registry) {
  return createRegionInsightRuntime({
    filePath,
    registry: registryInput,
    idFactory: ({ regionKey, version }) => `publication:${regionKey}:${version}`
  });
}

(async () => {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "region-publication-store-"));
  const filePath = path.join(fixtureRoot, "primary", "regions.json");
  let tick = 0;
  const runtime = createRegionInsightRuntime({
    filePath,
    registry,
    clock: () => new Date(Date.UTC(2026, 7, 5, 0, 0, tick++)),
    idFactory: ({ regionKey, version }) => `publication:${regionKey}:${version}`
  });

  try {
    const drafted = await runtime.saveDraft("kr_gyeonggi_pocheon", draftPayload(), { id: "admin-one" });
    const draftHash = drafted.regionInsight.state.draftHash;
    const reviewed = await runtime.reviewDraft("kr_gyeonggi_pocheon", {
      status: "reviewed",
      expectedDraftHash: draftHash,
      expectedWorkflowRevision: 1
    }, { id: "admin-one" });
    let revision = reviewed.regionInsight.workflowRevision;
    let published;
    for (let index = 1; index <= 105; index += 1) {
      published = await runtime.publishDraft("kr_gyeonggi_pocheon", {
        expectedDraftHash: draftHash,
        expectedWorkflowRevision: revision,
        version: `2026.08.05.${index}`
      }, { id: "admin-one" });
      revision = published.regionInsight.workflowRevision;
    }

    assert.equal(published.regionInsight.publicationHistory.length, 105, "publication history must never be count-truncated");
    assert.equal(published.regionInsight.publicationHistory[0].publication.status, "superseded");
    assert.equal(published.regionInsight.publicationHistory[104].publication.status, "published");
    assert.equal(published.regionInsight.workflowRevision, 107);

    const currentPublication = published.regionInsight.state.publication;
    const currentHistory = published.regionInsight.publicationHistory[104];
    const pocheon = registry.regions.find((entry) => entry.regionKey === "kr_gyeonggi_pocheon");
    assert.equal(currentPublication.snapshot.registryVersion, registry.registryVersion);
    assert.equal(currentPublication.snapshot.regionKey, pocheon.regionKey);
    assert.equal(currentPublication.snapshot.sido, pocheon.sido);
    assert.equal(currentPublication.snapshot.sigungu, pocheon.sigungu);
    assert.equal(currentPublication.snapshot.displayLabel, `${pocheon.sido} ${pocheon.sigungu}`);
    assert.equal(currentPublication.publishedBy, "admin-one");
    assert.equal(currentHistory.publishedBy, currentPublication.publishedBy);
    assert.equal(currentHistory.supersededAt, currentPublication.supersededAt);
    assert.equal(currentHistory.publication.publicationId, currentHistory.publicationId);
    assert.equal(currentHistory.publication.version, currentHistory.version);
    assert.equal(currentHistory.publication.publishedAt, currentHistory.publishedAt);

    const persisted = JSON.parse(await fsp.readFile(filePath, "utf8"));
    assert.equal(persisted.regions.kr_gyeonggi_pocheon.publicationHistory.length, 105);

    const registryWithoutPocheon = structuredClone(registry);
    registryWithoutPocheon.registryVersion = "location-region-registry-v2-with-pocheon-retired";
    registryWithoutPocheon.regions = registryWithoutPocheon.regions.filter(
      (entry) => entry.regionKey !== "kr_gyeonggi_pocheon"
    );
    const historicalRuntime = fixtureRuntime(filePath, registryWithoutPocheon);
    const historicalStore = await historicalRuntime.readStore();
    assert.equal(
      historicalStore.regions.kr_gyeonggi_pocheon.publicationHistory.length,
      105,
      "history validation must use stored identity rather than the current active matcher"
    );
    await assert.rejects(
      () => historicalRuntime.readAdminRegion("kr_gyeonggi_pocheon"),
      (error) => error.code === "CANONICAL_REGION_KEY_REQUIRED" && error.statusCode === 400
    );

    const legacyRevisionStore = structuredClone(persisted);
    delete legacyRevisionStore.regions.kr_gyeonggi_pocheon.workflowRevision;
    const legacyRevisionPath = await writeFixtureStore(fixtureRoot, "legacy-revision", legacyRevisionStore);
    const legacyRevisionRead = await fixtureRuntime(legacyRevisionPath).readAdminRegion("kr_gyeonggi_pocheon");
    assert.equal(legacyRevisionRead.regionInsight.workflowRevision, 0, "legacy records are upgraded lazily without a read-time migration write");
    assert.equal(
      JSON.parse(await fsp.readFile(legacyRevisionPath, "utf8")).regions.kr_gyeonggi_pocheon.workflowRevision,
      undefined,
      "read compatibility must not mutate the fixture store"
    );

    const legacyDraft = buildRegionInsightState({
      regionKey: "kr_gyeonggi_pocheon",
      ...draftPayload(61)
    });
    const legacyReviewed = buildRegionInsightState({
      ...legacyDraft,
      review: {
        status: "reviewed",
        reviewedDraftHash: legacyDraft.draftHash,
        reviewedAt: "2026-08-04T01:00:00.000Z",
        reviewer: { id: "legacy-admin" }
      }
    });
    const legacyPublication = publishRegionInsightState(legacyReviewed, {
      publicationId: "legacy-publication-v1",
      version: "legacy-v1",
      publishedAt: "2026-08-04T02:00:00.000Z"
    });
    const legacyState = structuredClone(legacyPublication);
    delete legacyState.publication.publishedBy;
    for (const field of ["registryVersion", "sido", "sigungu", "displayLabel"]) {
      delete legacyState.publication.snapshot[field];
    }
    const legacyPublicationStore = {
      documentType: persisted.documentType,
      schemaVersion: persisted.schemaVersion,
      updatedAt: "2026-08-04T02:00:00.000Z",
      regions: {
        kr_gyeonggi_pocheon: {
          region: {
            regionKey: pocheon.regionKey,
            sido: pocheon.sido,
            sigungu: pocheon.sigungu
          },
          state: legacyState,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T02:00:00.000Z",
          updatedBy: "legacy-admin",
          auditHistory: [],
          publicationHistory: [{
            publicationId: legacyState.publication.publicationId,
            version: legacyState.publication.version,
            publishedAt: legacyState.publication.publishedAt,
            publishedBy: "legacy-admin",
            supersededAt: "",
            publication: legacyState.publication
          }]
        }
      }
    };
    const legacyPublicationPath = await writeFixtureStore(
      fixtureRoot,
      "legacy-publication-contract",
      legacyPublicationStore
    );
    const legacyPublicationRead = await fixtureRuntime(legacyPublicationPath).readStore();
    assert.equal(
      legacyPublicationRead.regions.kr_gyeonggi_pocheon.publicationHistory[0].publication.snapshot.registryVersion,
      undefined,
      "legacy snapshots remain readable without inventing registry provenance"
    );
    assert.equal(
      JSON.parse(await fsp.readFile(legacyPublicationPath, "utf8")).regions.kr_gyeonggi_pocheon.workflowRevision,
      undefined,
      "legacy publication compatibility must remain read-only"
    );

    const corruptions = [
      {
        name: "snapshot-hash",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publication.snapshot.snapshotHash = "0".repeat(64);
        },
        pattern: /contract validation|state is invalid|snapshot/i
      },
      {
        name: "outer-version",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].version = "outer-mismatch";
        },
        pattern: /version mismatch/i
      },
      {
        name: "published-by",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publishedBy = "different-admin";
        },
        pattern: /publishedBy mismatch/i
      },
      {
        name: "superseded-at",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[0].supersededAt = "";
        },
        pattern: /supersededAt mismatch/i
      },
      {
        name: "region-identity",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publication.snapshot.sido = "강원";
        },
        pattern: /contract validation|state is invalid|region identity|snapshot/i
      },
      {
        name: "current-link",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publication.status = "stale";
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publication.staleAt = "2026-08-06T00:00:00.000Z";
        },
        pattern: /current publication does not match/i
      },
      {
        name: "multiple-current-publications",
        mutate(store) {
          const first = store.regions.kr_gyeonggi_pocheon.publicationHistory[0];
          first.supersededAt = "";
          first.publication.status = "published";
          first.publication.supersededAt = "";
        },
        pattern: /exactly one current publication/i
      },
      {
        name: "duplicate-id",
        mutate(store) {
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publicationId =
            store.regions.kr_gyeonggi_pocheon.publicationHistory[0].publicationId;
          store.regions.kr_gyeonggi_pocheon.publicationHistory[104].publication.publicationId =
            store.regions.kr_gyeonggi_pocheon.publicationHistory[0].publicationId;
        },
        pattern: /publicationId is duplicated/i
      }
    ];
    for (const corruption of corruptions) {
      const corruptStore = structuredClone(persisted);
      corruption.mutate(corruptStore);
      const corruptPath = await writeFixtureStore(fixtureRoot, corruption.name, corruptStore);
      await assert.rejects(() => fixtureRuntime(corruptPath).readStore(), corruption.pattern);
    }

    const invalidActorDraft = await runtime.saveDraft("kr_gangwon_sokcho", draftPayload(), { id: "admin-one" });
    const invalidActorHash = invalidActorDraft.regionInsight.state.draftHash;
    await runtime.reviewDraft("kr_gangwon_sokcho", {
      status: "reviewed",
      expectedDraftHash: invalidActorHash,
      expectedWorkflowRevision: 1
    }, { id: "admin-one" });
    await assert.rejects(
      () => runtime.publishDraft("kr_gangwon_sokcho", {
        expectedDraftHash: invalidActorHash,
        expectedWorkflowRevision: 2,
        version: "invalid-actor"
      }, { id: "actor with spaces" }),
      (error) => Array.isArray(error.errors)
        && error.errors.some((entry) => entry.code === "invalid_actor_id")
        && error.statusCode === 409
    );

    const globalIdPath = path.join(fixtureRoot, "global-publication-id", "regions.json");
    const globalIdRuntime = createRegionInsightRuntime({
      filePath: globalIdPath,
      registry,
      idFactory: () => "fixed-global-publication-id"
    });
    for (const regionKey of ["kr_gyeonggi_pocheon", "kr_gangwon_sokcho"]) {
      const regionDraft = await globalIdRuntime.saveDraft(regionKey, draftPayload(), { id: "admin-one" });
      await globalIdRuntime.reviewDraft(regionKey, {
        status: "reviewed",
        expectedDraftHash: regionDraft.regionInsight.state.draftHash,
        expectedWorkflowRevision: 1
      }, { id: "admin-one" });
    }
    const globalIdPocheon = await globalIdRuntime.readAdminRegion("kr_gyeonggi_pocheon");
    await globalIdRuntime.publishDraft("kr_gyeonggi_pocheon", {
      expectedDraftHash: globalIdPocheon.regionInsight.state.draftHash,
      expectedWorkflowRevision: 2,
      version: "pocheon-v1"
    }, { id: "admin-one" });
    const globalIdSokcho = await globalIdRuntime.readAdminRegion("kr_gangwon_sokcho");
    await assert.rejects(
      () => globalIdRuntime.publishDraft("kr_gangwon_sokcho", {
        expectedDraftHash: globalIdSokcho.regionInsight.state.draftHash,
        expectedWorkflowRevision: 2,
        version: "sokcho-v1"
      }, { id: "admin-one" }),
      (error) => error.code === "REGION_PUBLICATION_ID_CONFLICT" && error.statusCode === 409
    );
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
    assert.equal(networkGuard.blockedAttempts(), 0);
    networkGuard.restore();
  }

  console.log("Region insight publication store resilience fixture checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
