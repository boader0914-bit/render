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
    companyMasterFile,
    companyRecordSummary,
    mergeCompanyRecords,
    mergeManualCorrectionRecords,
    readCompanyMaster,
    writeCompanyMaster
  } = __test;

  try {
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
