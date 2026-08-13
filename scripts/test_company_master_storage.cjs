"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  acquireCompanyMasterSharedLock,
  lockPathForTarget
} = require("./company_master_shared_lock.cjs");

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-company-master-storage-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = tempRoot;
  process.env.OUTPUTS_DIR = path.join(tempRoot, "outputs");
  process.env.CONFIG_DIR = path.join(tempRoot, "config");
  process.env.V2_PREVIEW_DATA_ROOT = "";
  process.env.RENDER = "";
  process.env.RENDER_SERVICE_NAME = "";
  process.env.RENDER_EXTERNAL_HOSTNAME = "";
  process.env.GLAMPING_B2B_ENABLED = "0";

  const { __test } = require("./glamping_app_server.cjs");
  const {
    b2bMyLodgeCandidateItems,
    companyEntityFromItem,
    companyMasterFile,
    companyRecordSummary,
    extractNaverPlaceId,
    mergeCompanyRecords,
    mergeManualCorrectionRecords,
    readCompanyMaster,
    writeCompanyMaster
  } = __test;

  try {
    const naverMapUrl = "https://map.naver.com/p/search/%EA%B2%BD%EB%82%A8%20%EA%B8%80%EB%9E%A8%ED%95%91/place/35644668?entry=pll";
    assert.equal(extractNaverPlaceId({ url: naverMapUrl }), "35644668");
    assert.equal(extractNaverPlaceId({ url: "https://pcmap.place.naver.com/accommodation/35644668/home" }), "35644668");
    assert.equal(extractNaverPlaceId({ url: "https://example.invalid/place/35644668" }), "");
    assert.equal(extractNaverPlaceId({ place_id: "35644668", url: "https://example.invalid/place/999" }), "35644668");
    assert.equal(extractNaverPlaceId({ place_id: "place-35644668" }), "");

    const placeEntity = companyEntityFromItem({
      name: "월명글램핑",
      url: naverMapUrl,
      bookingBusinessId: "987654321"
    }, {
      id: "fixture-place-primary-run",
      keyword: "경남 글램핑"
    }, "2026-08-14T00:00:00.000Z");
    assert.equal(placeEntity.placeId, "35644668");
    assert.equal(placeEntity.bookingBusinessId, "987654321");
    assert.equal(placeEntity.observation.sourceId, "35644668");
    assert.equal(placeEntity.sourceKeys[0], "place:35644668");
    assert.equal(placeEntity.sourceKeys[1], "booking:987654321");

    const samePlaceCandidates = b2bMyLodgeCandidateItems({
      availability: {
        items: [{ name: "월명글램핑", placeId: "35644668", bookingBusinessId: "111", hasInventory: true }]
      },
      ranking: {
        items: [{ name: "월명글램핑", placeId: "35644668", bookingBusinessId: "222", overallRank: 1 }]
      }
    }, "월명글램핑");
    assert.equal(samePlaceCandidates.length, 1, "one Place ID must remain one company when a booking mapping changes");
    assert.equal(samePlaceCandidates[0].item.placeId, "35644668");

    const categoryCorrection = {
      active: true,
      primaryCategoryKey: "pension",
      categoryTags: ["pension"],
      updatedAt: "2026-08-01T00:00:00.000Z"
    };
    const locationCorrection = {
      active: true,
      location: {
        latitude: 37.9,
        longitude: 127.2,
        status: "verified",
        source: "manual"
      },
      note: "manual location fixture",
      updatedAt: "2026-08-02T00:00:00.000Z"
    };
    const mergedForward = mergeManualCorrectionRecords(categoryCorrection, locationCorrection);
    const mergedReverse = mergeManualCorrectionRecords(locationCorrection, categoryCorrection);
    for (const merged of [mergedForward, mergedReverse]) {
      assert.equal(merged.primaryCategoryKey, "pension");
      assert.equal(merged.location.latitude, 37.9);
      assert.equal(merged.location.longitude, 127.2);
      assert.equal(merged.note, "manual location fixture");
    }
    assert.doesNotThrow(() => mergeManualCorrectionRecords(locationCorrection, {
      ...locationCorrection,
      note: "same coordinate"
    }));
    assert.throws(
      () => mergeManualCorrectionRecords(locationCorrection, {
        active: true,
        location: { latitude: 35.2, longitude: 129.1, status: "verified", source: "manual" }
      }),
      (error) => error?.statusCode === 409 && /conflicting manual company locations/i.test(error.message)
    );

    const duplicateMaster = {
      companies: {
        target: { companyId: "target", primaryName: "Target", manualCorrection: categoryCorrection },
        source: { companyId: "source", primaryName: "Source", manualCorrection: locationCorrection }
      },
      sourceIndex: { "fixture:source": "source" },
      duplicateResolutions: {}
    };
    const mergedDuplicate = mergeCompanyRecords(duplicateMaster, ["target", "source"], "fixture-candidate");
    assert.equal(mergedDuplicate.manualCorrection.primaryCategoryKey, "pension");
    assert.equal(mergedDuplicate.manualCorrection.location.source, "manual");
    assert.equal(mergedDuplicate.manualCorrection.location.latitude, 37.9);
    assert.equal("source" in duplicateMaster.companies, false);
    assert.equal(duplicateMaster.sourceIndex["fixture:source"], "target");

    const conflictingMaster = {
      companies: {
        target: { companyId: "target", primaryName: "Target", manualCorrection: locationCorrection },
        source: {
          companyId: "source",
          primaryName: "Source",
          manualCorrection: {
            active: true,
            location: { latitude: 35.2, longitude: 129.1, status: "verified", source: "manual" }
          }
        }
      },
      sourceIndex: {},
      duplicateResolutions: {}
    };
    assert.throws(
      () => mergeCompanyRecords(conflictingMaster, ["target", "source"], "conflicting-candidate"),
      (error) => error?.statusCode === 409
    );
    assert.ok(conflictingMaster.companies.target);
    assert.ok(conflictingMaster.companies.source, "a conflicting source must not be deleted");

    const legacyManualMaster = {
      companies: {
        target: { companyId: "target", primaryName: "Target", manualCorrection: categoryCorrection },
        source: {
          companyId: "source",
          primaryName: "Source",
          location: {
            latitude: 37.91,
            longitude: 127.21,
            status: "verified",
            source: "manual",
            observedAt: "2026-08-02T00:00:00.000Z"
          }
        }
      },
      sourceIndex: {},
      duplicateResolutions: {}
    };
    const legacyManualMerged = mergeCompanyRecords(legacyManualMaster, ["target", "source"], "legacy-manual-candidate");
    assert.equal(legacyManualMerged.manualCorrection.primaryCategoryKey, "pension");
    assert.equal(legacyManualMerged.manualCorrection.location.latitude, 37.91, "a legacy top-level manual point must be promoted before deleting its source record");
    assert.equal(legacyManualMerged.manualCorrection.location.source, "manual");
    assert.notEqual(legacyManualMerged.location?.source, "manual", "the promoted manual correction must not remain mirrored in automatic top-level location");
    assert.equal("source" in legacyManualMaster.companies, false);

    const legacyConflictMaster = {
      companies: {
        target: { companyId: "target", primaryName: "Target", manualCorrection: locationCorrection },
        source: {
          companyId: "source",
          primaryName: "Source",
          coordinates: [{ latitude: 35.2, longitude: 129.1, status: "verified", source: "manual" }]
        }
      },
      sourceIndex: {},
      duplicateResolutions: {}
    };
    assert.throws(
      () => mergeCompanyRecords(legacyConflictMaster, ["target", "source"], "legacy-manual-conflict"),
      (error) => error?.statusCode === 409
    );
    assert.ok(legacyConflictMaster.companies.source, "a legacy manual conflict must fail before deleting its source record");

    const locationReviewSummary = companyRecordSummary({
      companyId: "location-review",
      primaryName: "Location Review",
      locationReview: {
        status: "pending",
        reason: "automatic_coordinate_conflict",
        distanceMeters: 12345.6,
        current: { latitude: 37.9, longitude: 127.2, source: "provider", observedAt: "2026-08-01T00:00:00.000Z" },
        candidate: { latitude: 35.2, longitude: 129.1, source: "provider", observedAt: "2026-08-03T00:00:00.000Z" },
        rawProviderResponse: "must-not-leak"
      }
    });
    assert.equal(locationReviewSummary.locationReview.status, "pending");
    assert.equal(locationReviewSummary.locationReview.reason, "automatic_coordinate_conflict");
    assert.equal(locationReviewSummary.locationReview.distanceMeters, 12346);
    assert.equal(locationReviewSummary.locationReview.current.source, "provider");
    assert.equal(locationReviewSummary.locationReview.candidate.source, "provider");
    assert.equal("rawProviderResponse" in locationReviewSummary.locationReview, false);

    const first = await readCompanyMaster();
    const stale = await readCompanyMaster();
    first.companies.company_a = {
      companyId: "company_a",
      primaryName: "Fixture A",
      unknownExistingField: { keep: true }
    };
    await writeCompanyMaster(first);

    const queued = await readCompanyMaster();
    queued.companies.company_c = { companyId: "company_c", primaryName: "Fixture C" };
    const maintenanceLock = await acquireCompanyMasterSharedLock(companyMasterFile, {
      allowedRoot: tempRoot,
      purpose: "fixture-geocoding-maintenance"
    });
    const releaseMaintenanceLock = new Promise((resolve, reject) => {
      setTimeout(() => maintenanceLock.release().then(resolve, reject), 40);
    });
    await writeCompanyMaster(queued);
    await releaseMaintenanceLock;
    await assert.rejects(
      () => fsp.lstat(lockPathForTarget(companyMasterFile)),
      (error) => error?.code === "ENOENT",
      "the server writer must release the canonical company-master lock"
    );

    const blocked = await readCompanyMaster();
    blocked.companies.company_d = { companyId: "company_d", primaryName: "Fixture D" };
    const busyLock = await acquireCompanyMasterSharedLock(companyMasterFile, {
      allowedRoot: tempRoot,
      purpose: "fixture-long-running-maintenance"
    });
    try {
      await assert.rejects(
        writeCompanyMaster(blocked),
        (error) => error?.code === "COMPANY_MASTER_LOCK_BUSY"
          && error?.statusCode === 503
          && error?.retryAfterSeconds === 1,
        "a busy maintenance lock must fail the server mutation closed with a retryable 503"
      );
    } finally {
      await busyLock.release();
    }

    stale.companies.company_b = { companyId: "company_b", primaryName: "Fixture B" };
    await assert.rejects(
      writeCompanyMaster(stale),
      (error) => error?.statusCode === 409 && /fresh snapshot/i.test(error.message),
      "a stale read must not overwrite a concurrent company-master update"
    );

    const persisted = JSON.parse(await fsp.readFile(companyMasterFile, "utf8"));
    assert.ok(persisted.companies.company_a, "the first committed update must remain present");
    assert.ok(persisted.companies.company_c, "a server write queued behind the shared maintenance lock must commit after release");
    assert.equal("company_b" in persisted.companies, false, "the rejected stale update must not leak into storage");
    assert.equal("company_d" in persisted.companies, false, "the busy-lock rejection must not leak an uncommitted server mutation");
    assert.deepEqual(persisted.companies.company_a.unknownExistingField, { keep: true });

    const corruptBytes = "{ not valid JSON\n";
    await fsp.writeFile(companyMasterFile, corruptBytes, "utf8");
    await assert.rejects(readCompanyMaster(), /JSON|position|property/i, "corrupt JSON must fail closed instead of becoming an empty master");
    assert.equal(await fsp.readFile(companyMasterFile, "utf8"), corruptBytes, "a failed read must not rewrite or truncate the corrupt source");
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  console.log("Company master atomic update, CAS, unknown-field, and corruption fail-closed tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
