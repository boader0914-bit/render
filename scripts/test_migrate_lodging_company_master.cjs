"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
global.fetch = (url) => { throw new Error(`Network forbidden: ${url}`); };
const { APPLY_TOKEN, ROLLBACK_TOKEN, inspectAndMigrate, runMigration } = require("./migrate_lodging_company_master.cjs");
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const fixture = {
  schemaVersion: 1,
  customRoot: { keep: true },
  companies: {
    legacy: { companyId: "legacy", createdAt: "2026-01-01", categoryKey: "pension", unknownUserField: 7 },
    compound: { companyId: "compound", createdAt: "2026-01-02", primaryCategoryKey: "poolVilla", categoryTags: ["pension", "poolVilla", "poolVilla"], categoryConfidence: 1.4, sourcePlatforms: ["naver", "naver", "cookie"], categoryEvidence: [
      { categoryKey: "poolVilla", source: "naver", reason: "업체명에 풀빌라 포함", confidence: 0.9, observedAt: "2026-01-01" },
      { categoryKey: "poolVilla", source: "naver", reason: "업체명에 풀빌라 포함", confidence: 0.95, observedAt: "2026-01-02", headers: "drop" }
    ] },
    manual: { companyId: "manual", primaryCategoryKey: "poolVilla", categoryTags: ["poolVilla"], manualCorrection: { primaryCategoryKey: "pension", categoryTags: ["pension"], note: "보존" }, duplicateReview: { status: "pending" } },
    unknown: { companyId: "unknown", categoryKey: "stayfolio", name: "스테이폴리오 제주" },
    plain: { companyId: "plain", name: "스테이 123", anotherUnknown: { keep: true } }
  }
};

(async () => {
  const pure = inspectAndMigrate(fixture);
  assert.equal(pure.stats.totalCompanies, 5);
  assert.equal(pure.stats.legacyCategoryKeyCompanies, 2);
  assert.equal(pure.stats.evidenceDeduped, 1);
  assert.equal(pure.migrated.companies.legacy.primaryCategoryKey, "pension");
  assert.deepEqual(pure.migrated.companies.compound.categoryTags, ["pension", "poolVilla"]);
  assert.equal(pure.migrated.companies.compound.categoryConfidence, 1);
  assert.deepEqual(pure.migrated.companies.compound.sourcePlatforms, ["naver"]);
  assert.equal(pure.migrated.companies.compound.categoryEvidence.length, 1);
  assert.equal("headers" in pure.migrated.companies.compound.categoryEvidence[0], false);
  assert.equal(pure.migrated.companies.unknown.categoryKey, "stayfolio");
  assert.equal("primaryCategoryKey" in pure.migrated.companies.unknown, false);
  assert.deepEqual(pure.migrated.companies.plain, fixture.companies.plain);
  assert.equal(pure.migrated.companies.manual.manualCorrection.note, "보존");
  assert.equal(pure.migrated.companies.legacy.unknownUserField, 7);
  const second = inspectAndMigrate(pure.migrated);
  assert.equal(second.stats.changedCompanies, 0);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-migration-test-"));
  const input = path.join(tempRoot, "input.json");
  const output = path.join(tempRoot, "output.json");
  const backup = path.join(tempRoot, "backup.json");
  const rollbackTarget = path.join(tempRoot, "rollback.json");
  await fsp.writeFile(input, JSON.stringify(fixture, null, 2));
  const before = await fsp.readFile(input);
  const inspect = await runMigration({ mode: "inspect", input });
  const dryOne = await runMigration({ mode: "dry-run", input });
  const dryTwo = await runMigration({ mode: "dry-run", input });
  assert.equal(inspect.inputHash, hash(before));
  assert.deepEqual(dryOne, dryTwo);
  assert.equal(hash(await fsp.readFile(input)), hash(before));
  await assert.rejects(runMigration({ mode: "apply", input, output, backup }), /confirm/);
  await assert.rejects(runMigration({ mode: "apply", input, output: input, backup, confirm: APPLY_TOKEN }), /in-place/);
  await assert.rejects(runMigration({ mode: "rollback", input: rollbackTarget, backup }), /confirm/);
  const applied = await runMigration({ mode: "apply", input, output, backup, confirm: APPLY_TOKEN });
  assert.equal(applied.rollbackPossible, true);
  assert.equal(hash(await fsp.readFile(input)), hash(before));
  assert.equal(hash(await fsp.readFile(backup)), hash(before));
  const rolledBack = await runMigration({ mode: "rollback", input: rollbackTarget, backup, confirm: ROLLBACK_TOKEN });
  assert.equal(rolledBack.rollbackApplied, true);
  assert.equal(hash(await fsp.readFile(rollbackTarget)), hash(before));
  const resolved = path.resolve(tempRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
  await fsp.rm(resolved, { recursive: true, force: true });
  console.log("Company-master migration inspect, dry-run, apply guards and rollback tests passed in an isolated temp directory");
})().catch((error) => { console.error(error); process.exitCode = 1; });
