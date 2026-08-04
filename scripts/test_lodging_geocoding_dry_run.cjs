"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  APPLY_TOKEN,
  ROLLBACK_TOKEN,
  runGeocoding
} = require("./geocode_lodging_companies.cjs");
const {
  acquireCompanyMasterSharedLock
} = require("./company_master_shared_lock.cjs");

let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network forbidden in lodging geocoding dry-run tests: ${url}`);
};

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function semanticHash(value) {
  return hash(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function readJson(filePath) {
  return JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function assertNoTemporaryFiles(directory) {
  const entries = await fsp.readdir(directory);
  assert.deepEqual(
    entries.filter((name) => name.endsWith(".tmp")
      || name.endsWith(".geocoding.lock")
      || name.endsWith(".company-master.lock")),
    [],
    "geocoding must clean up temporary and lock files"
  );
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-geocoding-test-"));
  const input = path.join(tempRoot, "company-master-input.json");
  const fixturePath = path.join(tempRoot, "geocoding-fixture.json");
  const output = path.join(tempRoot, "company-master-output.json");
  const backup = path.join(tempRoot, "company-master-backup.json");
  const receipt = path.join(tempRoot, "company-master-apply-receipt.json");
  const rollbackTarget = path.join(tempRoot, "company-master-rollback.json");
  let protectedRoot = "";
  const fullAddress = "경상남도 합천군 가야면 가야산로 1";
  const secondAddress = "경상남도 합천군 대병면 합천호수로 100";
  const outsideAddress = "경상남도 합천군 용주면 합천호수로 900";
  const errorAddress = "경상남도 합천군 봉산면 오류로 9";
  const notFoundAddress = "경상남도 합천군 쌍책면 없는길 12";

  const master = {
    schemaVersion: 1,
    updatedAt: "2026-08-03T00:00:00.000Z",
    unknownRootField: { keep: true },
    sourceIndex: { "naver:test": "geocode" },
    companies: {
      resolved: {
        companyId: "resolved",
        createdAt: "2026-01-01T00:00:00.000Z",
        name: "기존 좌표 업체",
        addresses: ["경상남도 합천군 야로면 기존로 1"],
        coordinates: [{ latitude: 35.61, longitude: 128.16 }],
        unknownCompanyField: { keep: "resolved" }
      },
      manual: {
        companyId: "manual",
        createdAt: "2026-01-02T00:00:00.000Z",
        name: "수동 위치 업체",
        addresses: ["경상남도 합천군 초계면 수동로 2"],
        manualCorrection: {
          location: {
            latitude: 35.55,
            longitude: 128.27,
            precision: "rooftop",
            resolvedAddress: "경상남도 합천군 초계면 수동로 2"
          },
          note: "수동 위치 보존"
        }
      },
      geocode: {
        companyId: "geocode",
        createdAt: "2026-01-03T00:00:00.000Z",
        name: "주소 좌표 변환 업체",
        addresses: [fullAddress],
        unknownCompanyField: { nested: [1, 2, 3] }
      },
      multiple: {
        companyId: "multiple",
        createdAt: "2026-01-04T00:00:00.000Z",
        name: "주소 검토 업체",
        addresses: [fullAddress, secondAddress],
        duplicateReview: { status: "pending" }
      },
      missing: {
        companyId: "missing",
        createdAt: "2026-01-05T00:00:00.000Z",
        name: "주소 없음 업체",
        unknownUserField: "preserve"
      },
      notFound: {
        companyId: "notFound",
        createdAt: "2026-01-06T00:00:00.000Z",
        name: "검색 결과 없음 업체",
        addresses: [notFoundAddress]
      },
      outside: {
        companyId: "outside",
        createdAt: "2026-01-07T00:00:00.000Z",
        name: "기존 범위 밖 좌표 업체",
        addresses: [outsideAddress],
        coordinates: [{ latitude: 48.8566, longitude: 2.3522 }]
      },
      error: {
        companyId: "error",
        createdAt: "2026-01-08T00:00:00.000Z",
        name: "fixture 실패 업체",
        addresses: [errorAddress]
      }
    }
  };

  const fixture = {
    fixtures: {
      [fullAddress]: {
        latitude: 35.566,
        longitude: 128.165,
        status: "resolved",
        source: "provider",
        providerKey: "fixture",
        precision: "rooftop",
        confidence: 0.98,
        resolvedAddress: fullAddress,
        geocodedAt: "2026-08-03T00:00:00.000Z"
      },
      [outsideAddress]: {
        latitude: 35.57,
        longitude: 128.18,
        status: "resolved",
        source: "provider",
        providerKey: "fixture",
        precision: "street",
        confidence: 0.9,
        resolvedAddress: outsideAddress,
        geocodedAt: "2026-08-03T00:00:00.000Z"
      },
      [errorAddress]: {
        error: { code: "FIXTURE_FAILURE", message: "fixture failure" }
      }
    }
  };

  try {
    await fsp.writeFile(input, JSON.stringify(master, null, 4), "utf8");
    await fsp.writeFile(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
    const original = await fsp.readFile(input);
    const originalHash = hash(original);

    await assert.rejects(
      () => runGeocoding({ mode: "inspect", input: "relative.json" }),
      /explicit absolute JSON path/
    );
    await assert.rejects(
      () => runGeocoding({ mode: "inspect", input: path.join(tempRoot, "not-json.txt") }),
      /JSON file/
    );
    await assert.rejects(
      () => runGeocoding({ mode: "inspect", input: "/var/data/v2-preview-runtime/company_master/companies.json" }),
      /absolute JSON path|persistent disk|Preview data root/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "inspect",
        input,
        env: { V2_PREVIEW_DATA_ROOT: tempRoot }
      }),
      /configured Preview data/
    );

    const inspect = await runGeocoding({ mode: "inspect", input });
    assert.equal(inspect.totalCompanies, 8);
    assert.equal(inspect.withAddress, 7);
    assert.equal(inspect.missingAddress, 1);
    assert.equal(inspect.existingMappable, 1);
    assert.equal(inspect.manualLocations, 1);
    assert.equal(inspect.legacyLocations, 1, "out-of-service-range legacy coordinates are invalid, not mappable legacy locations");
    assert.equal(inspect.coordinateRangeErrors, 1);
    assert.equal(inspect.fingerprintMismatches, 0);
    assert.equal(inspect.eligibleCompanies, 5);
    assert.equal(inspect.fixtureLookups, 0);
    assert.equal(inspect.changedCompanies, 0);
    assert.equal(hash(await fsp.readFile(input)), originalHash, "inspect must not change the input bytes");

    await assert.rejects(
      () => runGeocoding({ mode: "dry-run", input }),
      /--fixture/
    );
    const dryOne = await runGeocoding({ mode: "dry-run", input, fixture: fixturePath });
    const dryTwo = await runGeocoding({ mode: "dry-run", input, fixture: fixturePath });
    const applyApproval = (dry, receiptPath) => ({
      confirm: APPLY_TOKEN,
      expectedInputHash: dry.inputHash,
      expectedFixtureHash: dry.fixtureHash,
      expectedOutputHash: dry.outputHash,
      receipt: receiptPath
    });
    assert.deepEqual(dryOne, dryTwo, "identical fixture dry-runs must be deterministic");
    assert.equal(dryOne.externalProviderCalls, 0);
    assert.equal(dryOne.fixtureLookups, 4);
    assert.equal(dryOne.attemptedCompanies, 4);
    assert.equal(dryOne.resolvedCompanies, 2);
    assert.equal(dryOne.ambiguousCompanies, 1);
    assert.equal(dryOne.notFoundCompanies, 1);
    assert.equal(dryOne.errorCompanies, 1);
    assert.equal(dryOne.changedCompanies, 4);
    assert.equal(dryOne.unchangedCompanies, 4);
    assert.equal(hash(await fsp.readFile(input)), originalHash, "dry-run must not change the input bytes");
    assert.equal(await fsp.stat(output).then(() => true, () => false), false, "dry-run must not create output");
    assert.equal(await fsp.stat(backup).then(() => true, () => false), false, "dry-run must not create backup");

    await assert.rejects(
      () => runGeocoding({ mode: "apply", input, output, backup, fixture: fixturePath }),
      /confirm/
    );
    await assert.rejects(
      () => runGeocoding({ mode: "apply", input, output, backup, fixture: fixturePath, confirm: APPLY_TOKEN }),
      /expected-input-hash/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output,
        backup,
        fixture: fixturePath,
        confirm: APPLY_TOKEN,
        expectedInputHash: dryOne.inputHash
      }),
      /expected-fixture-hash/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output,
        backup,
        fixture: fixturePath,
        confirm: APPLY_TOKEN,
        expectedInputHash: dryOne.inputHash,
        expectedFixtureHash: dryOne.fixtureHash
      }),
      /expected-output-hash/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output,
        backup,
        fixture: fixturePath,
        confirm: APPLY_TOKEN,
        expectedInputHash: "0".repeat(64),
        expectedFixtureHash: dryOne.fixtureHash,
        expectedOutputHash: dryOne.outputHash,
        receipt
      }),
      /does not match the approved dry-run/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: path.join(tempRoot, "wrong-output-plan.json"),
        backup: path.join(tempRoot, "wrong-output-plan-backup.json"),
        fixture: fixturePath,
        ...applyApproval(dryOne, path.join(tempRoot, "wrong-output-plan-receipt.json")),
        expectedOutputHash: "f".repeat(64)
      }),
      /output plan does not match the approved dry-run/
    );

    const mutatedFixturePath = path.join(tempRoot, "mutated-geocoding-fixture.json");
    await fsp.writeFile(mutatedFixturePath, JSON.stringify(fixture, null, 2), "utf8");
    const mutationDryRun = await runGeocoding({ mode: "dry-run", input, fixture: mutatedFixturePath });
    const mutatedFixture = structuredClone(fixture);
    mutatedFixture.fixtures[fullAddress].confidence = 0.77;
    await fsp.writeFile(mutatedFixturePath, JSON.stringify(mutatedFixture, null, 2), "utf8");
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: path.join(tempRoot, "mutated-fixture-output.json"),
        backup: path.join(tempRoot, "mutated-fixture-backup.json"),
        fixture: mutatedFixturePath,
        ...applyApproval(mutationDryRun, path.join(tempRoot, "mutated-fixture-receipt.json"))
      }),
      /fixture hash does not match the approved dry-run/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: input,
        backup,
        fixture: fixturePath,
        ...applyApproval(dryOne, receipt)
      }),
      /in-place/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: fixturePath,
        backup,
        fixture: fixturePath,
        ...applyApproval(dryOne, receipt)
      }),
      /fixture path must differ/
    );
    await assert.rejects(
      () => runGeocoding({ mode: "rollback", input: rollbackTarget, backup }),
      /confirm/
    );

    const applyBlocker = await acquireCompanyMasterSharedLock(output, {
      allowedRoot: tempRoot,
      allowMissingTarget: true,
      purpose: "server-company-master-write"
    });
    try {
      await assert.rejects(
        () => runGeocoding({
          mode: "apply",
          input,
          output,
          backup,
          fixture: fixturePath,
          ...applyApproval(dryOne, receipt)
        }),
        (error) => error?.code === "COMPANY_MASTER_LOCK_BUSY",
        "CLI apply must honor the same canonical lock as the server writer"
      );
    } finally {
      await applyBlocker.release();
    }
    assert.equal(await fsp.stat(output).then(() => true, () => false), false);
    assert.equal(await fsp.stat(backup).then(() => true, () => false), false);
    assert.equal(await fsp.stat(receipt).then(() => true, () => false), false);

    const applied = await runGeocoding({
      mode: "apply",
      input,
      output,
      backup,
      fixture: fixturePath,
      ...applyApproval(dryOne, receipt)
    });
    assert.equal(applied.rollbackPossible, true);
    assert.equal(applied.externalProviderCalls, 0);
    assert.equal(applied.receipt, receipt);
    assert.match(applied.receiptHash, /^[a-f0-9]{64}$/);
    assert.equal(hash(await fsp.readFile(input)), originalHash, "out-of-place apply must not modify its input");
    const receiptDocument = await readJson(receipt);
    assert.equal(receiptDocument.kind, "lodging-geocoding-apply-receipt");
    assert.equal(receiptDocument.schemaVersion, 1);
    assert.equal(path.resolve(receiptDocument.outputPath), path.resolve(output));
    assert.equal(path.resolve(receiptDocument.backupPath), path.resolve(backup));
    assert.equal(path.resolve(receiptDocument.receiptPath), path.resolve(receipt));
    assert.equal(receiptDocument.inputHash, dryOne.inputHash);
    assert.equal(receiptDocument.fixtureHash, dryOne.fixtureHash);
    assert.equal(receiptDocument.outputHash, applied.persistedOutputHash);
    assert.equal(receiptDocument.backupHash, applied.backupHash);
    const backupMaster = await readJson(backup);
    const outputMaster = await readJson(output);
    assert.equal(semanticHash(backupMaster), semanticHash(master), "backup must preserve the original semantic document");
    assert.equal(outputMaster.companies.geocode.location.status, "resolved");
    assert.equal(outputMaster.companies.geocode.location.latitude, 35.566);
    assert.equal(outputMaster.companies.outside.location.latitude, 35.57, "out-of-country legacy points must not block a valid Korean fixture point");
    assert.equal(outputMaster.companies.multiple.location.status, "ambiguous");
    assert.equal(outputMaster.companies.multiple.location.latitude, null);
    assert.equal(outputMaster.companies.notFound.location.status, "not_found");
    assert.equal("location" in outputMaster.companies.error, false, "transient fixture failures must not rewrite a company");
    assert.deepEqual(outputMaster.companies.geocode.unknownCompanyField, { nested: [1, 2, 3] });
    assert.deepEqual(outputMaster.companies.missing, master.companies.missing);
    assert.deepEqual(outputMaster.companies.manual.manualCorrection, master.companies.manual.manualCorrection);
    assert.deepEqual(outputMaster.unknownRootField, { keep: true });
    assert.deepEqual(Object.keys(outputMaster.companies).sort(), Object.keys(master.companies).sort());
    for (const key of Object.keys(master.companies)) {
      assert.equal(outputMaster.companies[key].companyId, master.companies[key].companyId);
      assert.equal(outputMaster.companies[key].createdAt, master.companies[key].createdAt);
    }

    const idempotent = await runGeocoding({ mode: "dry-run", input: output, fixture: fixturePath });
    assert.equal(idempotent.changedCompanies, 0, "an applied fixture result must be idempotent");
    assert.equal(idempotent.outputHash, idempotent.semanticInputHash, "idempotent output hash must equal canonical input hash");

    const rollbackBlocker = await acquireCompanyMasterSharedLock(output, {
      allowedRoot: tempRoot,
      purpose: "server-company-master-write"
    });
    try {
      await assert.rejects(
        () => runGeocoding({
          mode: "rollback",
          input: output,
          backup,
          receipt,
          confirm: ROLLBACK_TOKEN,
          expectedCurrentHash: applied.persistedOutputHash,
          expectedBackupHash: applied.backupHash,
          expectedReceiptHash: applied.receiptHash
        }),
        (error) => error?.code === "COMPANY_MASTER_LOCK_BUSY",
        "CLI rollback must honor the same canonical lock as the server writer"
      );
    } finally {
      await rollbackBlocker.release();
    }

    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: applied.persistedOutputHash,
        expectedBackupHash: applied.backupHash
      }),
      /expected-receipt-hash/
    );
    const receiptBytes = await fsp.readFile(receipt);
    await fsp.writeFile(receipt, JSON.stringify({ ...receiptDocument, appliedAt: "2099-01-01T00:00:00.000Z" }, null, 2), "utf8");
    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: applied.persistedOutputHash,
        expectedBackupHash: applied.backupHash,
        expectedReceiptHash: applied.receiptHash
      }),
      /receipt hash does not match/
    );
    await fsp.writeFile(receipt, receiptBytes);

    await fsp.writeFile(rollbackTarget, JSON.stringify(master, null, 2), "utf8");
    const rollbackTargetHash = hash(await fsp.readFile(rollbackTarget));
    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: rollbackTarget,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: rollbackTargetHash,
        expectedBackupHash: applied.backupHash,
        expectedReceiptHash: applied.receiptHash
      }),
      /target does not match the apply receipt/
    );

    const appliedOutputBytes = await fsp.readFile(output);
    const backupBytes = await fsp.readFile(backup);
    const changedOutput = structuredClone(outputMaster);
    changedOutput.unknownRootField = { tampered: "current" };
    await fsp.writeFile(output, JSON.stringify(changedOutput, null, 2), "utf8");
    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: applied.persistedOutputHash,
        expectedBackupHash: applied.backupHash,
        expectedReceiptHash: applied.receiptHash
      }),
      /target changed after apply/
    );
    await fsp.writeFile(output, appliedOutputBytes);

    const changedBackup = structuredClone(backupMaster);
    changedBackup.unknownRootField = { tampered: "backup" };
    await fsp.writeFile(backup, JSON.stringify(changedBackup, null, 2), "utf8");
    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: applied.persistedOutputHash,
        expectedBackupHash: applied.backupHash,
        expectedReceiptHash: applied.receiptHash
      }),
      /backup hash does not match the apply receipt/
    );
    await fsp.writeFile(backup, backupBytes);

    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: "0".repeat(64),
        expectedBackupHash: applied.backupHash,
        expectedReceiptHash: applied.receiptHash
      }),
      /target changed after apply/
    );
    await assert.rejects(
      () => runGeocoding({
        mode: "rollback",
        input: output,
        backup,
        receipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: applied.persistedOutputHash,
        expectedBackupHash: "0".repeat(64),
        expectedReceiptHash: applied.receiptHash
      }),
      /backup hash does not match the apply receipt/
    );

    const rolledBack = await runGeocoding({
      mode: "rollback",
      input: output,
      backup,
      receipt,
      confirm: ROLLBACK_TOKEN,
      expectedCurrentHash: applied.persistedOutputHash,
      expectedBackupHash: applied.backupHash,
      expectedReceiptHash: applied.receiptHash
    });
    assert.equal(rolledBack.rollbackApplied, true);
    assert.equal(semanticHash(await readJson(output)), semanticHash(master));

    const compensationOutput = path.join(tempRoot, "receipt-race-output.json");
    const compensationBackup = path.join(tempRoot, "receipt-race-backup.json");
    const compensationReceipt = path.join(tempRoot, "receipt-race-receipt.json");
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: compensationOutput,
        backup: compensationBackup,
        fixture: fixturePath,
        ...applyApproval(dryOne, compensationReceipt),
        beforeReceiptCommit: async ({ receiptPath }) => {
          await fsp.writeFile(receiptPath, "external receipt claimant", "utf8");
        }
      }),
      /exist/i
    );
    assert.equal(await fsp.stat(compensationOutput).then(() => true, () => false), false, "failed receipt commit must remove an out-of-place output");
    assert.equal(await fsp.stat(compensationBackup).then(() => true, () => false), false, "failed receipt commit must remove its compensation backup after cleanup");
    assert.equal(await fsp.readFile(compensationReceipt, "utf8"), "external receipt claimant", "a competing receipt must not be removed");
    await fsp.rm(compensationReceipt, { force: true });

    const compensationInput = path.join(tempRoot, "receipt-race-in-place.json");
    const compensationInPlaceBackup = path.join(tempRoot, "receipt-race-in-place-backup.json");
    const compensationInPlaceReceipt = path.join(tempRoot, "receipt-race-in-place-receipt.json");
    await fsp.writeFile(compensationInput, original);
    const compensationDry = await runGeocoding({ mode: "dry-run", input: compensationInput, fixture: fixturePath });
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input: compensationInput,
        output: compensationInput,
        backup: compensationInPlaceBackup,
        fixture: fixturePath,
        inPlace: true,
        ...applyApproval(compensationDry, compensationInPlaceReceipt),
        beforeReceiptCommit: async ({ receiptPath }) => {
          await fsp.writeFile(receiptPath, "external in-place receipt claimant", "utf8");
        }
      }),
      /exist/i
    );
    assert.equal(hash(await fsp.readFile(compensationInput)), originalHash, "failed in-place receipt commit must restore the exact approved input bytes");
    assert.equal(await fsp.stat(compensationInPlaceBackup).then(() => true, () => false), false, "successful compensation must clean its backup");
    assert.equal(await fsp.readFile(compensationInPlaceReceipt, "utf8"), "external in-place receipt claimant");
    await fsp.rm(compensationInPlaceReceipt, { force: true });

    const foreignOutput = path.join(tempRoot, "foreign-writer-output.json");
    const foreignBackup = path.join(tempRoot, "foreign-writer-backup.json");
    const foreignReceipt = path.join(tempRoot, "foreign-writer-receipt.json");
    const foreignMaster = { ...master, unknownRootField: { writer: "foreign" } };
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: foreignOutput,
        backup: foreignBackup,
        fixture: fixturePath,
        ...applyApproval(dryOne, foreignReceipt),
        beforeReceiptCommit: async ({ outputPath, receiptPath }) => {
          await fsp.writeFile(outputPath, JSON.stringify(foreignMaster, null, 2), "utf8");
          await fsp.writeFile(receiptPath, "foreign receipt claimant", "utf8");
        }
      }),
      /compensation was incomplete/
    );
    assert.deepEqual((await readJson(foreignOutput)).unknownRootField, { writer: "foreign" }, "compensation must not remove a foreign writer's replacement");
    assert.equal(await fsp.stat(foreignBackup).then(() => true, () => false), true, "the verified backup must remain when compensation cannot safely restore");
    assert.equal(await fsp.readFile(foreignReceipt, "utf8"), "foreign receipt claimant");
    await fsp.rm(foreignOutput, { force: true });
    await fsp.rm(foreignBackup, { force: true });
    await fsp.rm(foreignReceipt, { force: true });

    const existingOutput = path.join(tempRoot, "existing-output.json");
    const secondBackup = path.join(tempRoot, "second-backup.json");
    await fsp.writeFile(existingOutput, JSON.stringify({ companies: {} }), "utf8");
    await assert.rejects(
      () => runGeocoding({
        mode: "apply",
        input,
        output: existingOutput,
        backup: secondBackup,
        fixture: fixturePath,
        ...applyApproval(dryOne, path.join(tempRoot, "existing-output-receipt.json"))
      }),
      /overwrit/
    );

    const concurrentInputA = path.join(tempRoot, "concurrent-input-a.json");
    const concurrentInputB = path.join(tempRoot, "concurrent-input-b.json");
    const concurrentMasterA = { ...master, unknownRootField: { writer: "a" } };
    const concurrentMasterB = { ...master, unknownRootField: { writer: "b" } };
    await fsp.writeFile(concurrentInputA, JSON.stringify(concurrentMasterA, null, 2), "utf8");
    await fsp.writeFile(concurrentInputB, JSON.stringify(concurrentMasterB, null, 2), "utf8");
    const concurrentDryA = await runGeocoding({ mode: "dry-run", input: concurrentInputA, fixture: fixturePath });
    const concurrentDryB = await runGeocoding({ mode: "dry-run", input: concurrentInputB, fixture: fixturePath });
    const sharedOutput = path.join(tempRoot, "concurrent-shared-output.json");
    const concurrentBackupA = path.join(tempRoot, "concurrent-backup-a.json");
    const concurrentBackupB = path.join(tempRoot, "concurrent-backup-b.json");
    const concurrentReceiptA = path.join(tempRoot, "concurrent-receipt-a.json");
    const concurrentReceiptB = path.join(tempRoot, "concurrent-receipt-b.json");
    const concurrentResults = await Promise.allSettled([
      runGeocoding({
        mode: "apply",
        input: concurrentInputA,
        output: sharedOutput,
        backup: concurrentBackupA,
        fixture: fixturePath,
        ...applyApproval(concurrentDryA, concurrentReceiptA)
      }),
      runGeocoding({
        mode: "apply",
        input: concurrentInputB,
        output: sharedOutput,
        backup: concurrentBackupB,
        fixture: fixturePath,
        ...applyApproval(concurrentDryB, concurrentReceiptB)
      })
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1, "only one apply may claim a shared output path");
    assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
    assert.match(String(concurrentResults.find((result) => result.status === "rejected").reason?.message), /lock|already exists|overwrit/i);
    assert.ok(["a", "b"].includes((await readJson(sharedOutput)).unknownRootField.writer));
    const winningOutputResult = concurrentResults.find((result) => result.status === "fulfilled").value;
    assert.equal(await fsp.stat(winningOutputResult.receipt).then(() => true, () => false), true, "the winning shared-output apply must persist its unique receipt");
    const losingOutputReceipt = winningOutputResult.receipt === concurrentReceiptA ? concurrentReceiptB : concurrentReceiptA;
    assert.equal(await fsp.stat(losingOutputReceipt).then(() => true, () => false), false, "the losing shared-output apply must not persist a receipt");

    const sharedBackup = path.join(tempRoot, "concurrent-shared-backup.json");
    const sharedBackupOutputA = path.join(tempRoot, "concurrent-output-a.json");
    const sharedBackupOutputB = path.join(tempRoot, "concurrent-output-b.json");
    const sharedBackupReceiptA = path.join(tempRoot, "concurrent-shared-backup-receipt-a.json");
    const sharedBackupReceiptB = path.join(tempRoot, "concurrent-shared-backup-receipt-b.json");
    const sharedBackupResults = await Promise.allSettled([
      runGeocoding({
        mode: "apply",
        input: concurrentInputA,
        output: sharedBackupOutputA,
        backup: sharedBackup,
        fixture: fixturePath,
        ...applyApproval(concurrentDryA, sharedBackupReceiptA)
      }),
      runGeocoding({
        mode: "apply",
        input: concurrentInputB,
        output: sharedBackupOutputB,
        backup: sharedBackup,
        fixture: fixturePath,
        ...applyApproval(concurrentDryB, sharedBackupReceiptB)
      })
    ]);
    assert.equal(sharedBackupResults.filter((result) => result.status === "fulfilled").length, 1, "only one apply may claim a shared backup path");
    assert.equal(sharedBackupResults.filter((result) => result.status === "rejected").length, 1);
    assert.match(String(sharedBackupResults.find((result) => result.status === "rejected").reason?.message), /lock|already exists/i);
    const winningBackupResult = sharedBackupResults.find((result) => result.status === "fulfilled").value;
    assert.equal(await fsp.stat(winningBackupResult.receipt).then(() => true, () => false), true, "the winning shared-backup apply must persist its unique receipt");
    const losingBackupReceipt = winningBackupResult.receipt === sharedBackupReceiptA ? sharedBackupReceiptB : sharedBackupReceiptA;
    assert.equal(await fsp.stat(losingBackupReceipt).then(() => true, () => false), false, "the losing shared-backup apply must not persist a receipt");

    const canonicalTargetDir = path.join(tempRoot, "canonical-target-dir");
    const canonicalAliasDir = path.join(tempRoot, "canonical-alias-dir");
    await fsp.mkdir(canonicalTargetDir, { recursive: true });
    let canonicalAliasSupported = true;
    try {
      await fsp.symlink(canonicalTargetDir, canonicalAliasDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      canonicalAliasSupported = false;
    }
    if (canonicalAliasSupported) {
      const canonicalOutputA = path.join(canonicalTargetDir, "shared-output.json");
      const canonicalOutputB = path.join(canonicalAliasDir, "shared-output.json");
      const aliasOutputResults = await Promise.allSettled([
        runGeocoding({
          mode: "apply",
          input: concurrentInputA,
          output: canonicalOutputA,
          backup: path.join(tempRoot, "canonical-output-backup-a.json"),
          fixture: fixturePath,
          ...applyApproval(concurrentDryA, path.join(tempRoot, "canonical-output-receipt-a.json"))
        }),
        runGeocoding({
          mode: "apply",
          input: concurrentInputB,
          output: canonicalOutputB,
          backup: path.join(tempRoot, "canonical-output-backup-b.json"),
          fixture: fixturePath,
          ...applyApproval(concurrentDryB, path.join(tempRoot, "canonical-output-receipt-b.json"))
        })
      ]);
      assert.equal(aliasOutputResults.filter((result) => result.status === "fulfilled").length, 1, "canonical output aliases must share one exclusive lock");
      assert.equal(aliasOutputResults.filter((result) => result.status === "rejected").length, 1);

      const canonicalBackupA = path.join(canonicalTargetDir, "shared-backup.json");
      const canonicalBackupB = path.join(canonicalAliasDir, "shared-backup.json");
      const aliasBackupResults = await Promise.allSettled([
        runGeocoding({
          mode: "apply",
          input: concurrentInputA,
          output: path.join(tempRoot, "canonical-backup-output-a.json"),
          backup: canonicalBackupA,
          fixture: fixturePath,
          ...applyApproval(concurrentDryA, path.join(tempRoot, "canonical-backup-receipt-a.json"))
        }),
        runGeocoding({
          mode: "apply",
          input: concurrentInputB,
          output: path.join(tempRoot, "canonical-backup-output-b.json"),
          backup: canonicalBackupB,
          fixture: fixturePath,
          ...applyApproval(concurrentDryB, path.join(tempRoot, "canonical-backup-receipt-b.json"))
        })
      ]);
      assert.equal(aliasBackupResults.filter((result) => result.status === "fulfilled").length, 1, "canonical backup aliases must share one exclusive lock");
      assert.equal(aliasBackupResults.filter((result) => result.status === "rejected").length, 1);

      await assert.rejects(
        () => runGeocoding({
          mode: "apply",
          input,
          output: path.join(canonicalTargetDir, "output-backup-same.json"),
          backup: path.join(canonicalAliasDir, "output-backup-same.json"),
          fixture: fixturePath,
          ...applyApproval(dryOne, path.join(tempRoot, "output-backup-same-receipt.json"))
        }),
        /must differ|distinct/
      );
    }

    protectedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-geocoding-protected-"));
    const protectedLink = path.join(tempRoot, "linked-preview-data");
    let symlinkSupported = true;
    try {
      await fsp.symlink(protectedRoot, protectedLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      symlinkSupported = false;
    }
    if (symlinkSupported) {
      await assert.rejects(
        () => runGeocoding({
          mode: "apply",
          input,
          output: path.join(protectedLink, "symlink-output.json"),
          backup: path.join(tempRoot, "symlink-output-backup.json"),
          fixture: fixturePath,
          ...applyApproval(dryOne, path.join(tempRoot, "symlink-output-receipt.json")),
          env: { V2_PREVIEW_DATA_ROOT: protectedRoot }
        }),
        /symbolic link|configured Preview data/
      );
      await assert.rejects(
        () => runGeocoding({
          mode: "apply",
          input,
          output: path.join(tempRoot, "symlink-backup-output.json"),
          backup: path.join(protectedLink, "symlink-backup.json"),
          fixture: fixturePath,
          ...applyApproval(dryOne, path.join(tempRoot, "symlink-backup-receipt.json")),
          env: { V2_PREVIEW_DATA_ROOT: protectedRoot }
        }),
        /symbolic link|configured Preview data/
      );
    }

    const symlinkInPlaceSource = path.join(tempRoot, "symlink-in-place-source.json");
    const symlinkInPlaceAlias = path.join(tempRoot, "symlink-in-place-alias.json");
    let fileSymlinkSupported = true;
    await fsp.writeFile(symlinkInPlaceSource, JSON.stringify(master, null, 2), "utf8");
    try {
      await fsp.symlink(symlinkInPlaceSource, symlinkInPlaceAlias, process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      fileSymlinkSupported = false;
    }
    if (fileSymlinkSupported) {
      const symlinkInPlaceBackup = path.join(tempRoot, "symlink-in-place-backup.json");
      const symlinkInPlaceReceipt = path.join(tempRoot, "symlink-in-place-receipt.json");
      const symlinkDry = await runGeocoding({ mode: "dry-run", input: symlinkInPlaceAlias, fixture: fixturePath });
      const symlinkApplied = await runGeocoding({
        mode: "apply",
        input: symlinkInPlaceSource,
        output: symlinkInPlaceAlias,
        backup: symlinkInPlaceBackup,
        fixture: fixturePath,
        inPlace: true,
        ...applyApproval(symlinkDry, symlinkInPlaceReceipt)
      });
      assert.equal((await fsp.lstat(symlinkInPlaceAlias)).isSymbolicLink(), true, "in-place apply through a file symlink must preserve the alias");
      assert.equal((await readJson(symlinkInPlaceSource)).companies.geocode.location.status, "resolved");
      const symlinkReceiptDocument = await readJson(symlinkInPlaceReceipt);
      assert.equal(path.resolve(symlinkReceiptDocument.outputPath), path.resolve(symlinkInPlaceSource));
      const symlinkRolledBack = await runGeocoding({
        mode: "rollback",
        input: symlinkInPlaceAlias,
        backup: symlinkInPlaceBackup,
        receipt: symlinkInPlaceReceipt,
        confirm: ROLLBACK_TOKEN,
        expectedCurrentHash: symlinkApplied.persistedOutputHash,
        expectedBackupHash: symlinkApplied.backupHash,
        expectedReceiptHash: symlinkApplied.receiptHash
      });
      assert.equal(symlinkRolledBack.rollbackApplied, true);
      assert.equal(semanticHash(await readJson(symlinkInPlaceSource)), semanticHash(master));
      assert.equal((await fsp.lstat(symlinkInPlaceAlias)).isSymbolicLink(), true, "rollback through a file symlink must preserve the alias");
    }

    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(output)).mode & 0o777, 0o600, "geocoding output must be owner-only");
      assert.equal((await fsp.stat(backup)).mode & 0o777, 0o600, "geocoding backup must be owner-only");
    }
    await assertNoTemporaryFiles(tempRoot);
    assert.equal(networkCalls, 0, "fixture inspect, dry-run, apply, and rollback must perform zero external requests");

    console.log("Lodging geocoding inspect, deterministic dry-run, apply guards, atomic backup, idempotence, and rollback tests passed");
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected temp path: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
    if (protectedRoot) {
      const protectedRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(protectedRoot));
      if (!protectedRelative || protectedRelative.startsWith("..") || path.isAbsolute(protectedRelative)) {
        throw new Error(`refusing to remove unexpected protected temp path: ${protectedRoot}`);
      }
      await fsp.rm(protectedRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
