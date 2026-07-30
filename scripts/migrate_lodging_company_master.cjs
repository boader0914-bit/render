"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { CATEGORY_PROFILES, PLATFORM_LABELS, validKey } = require("./lodging_category_profile.cjs");

const APPLY_TOKEN = "APPLY_LODGING_COMPANY_MIGRATION";
const ROLLBACK_TOKEN = "ROLLBACK_LODGING_COMPANY_MIGRATION";
const MAX_EVIDENCE = 40;
const unique = (values) => [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
const hashBuffer = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBuffer = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

function evidenceKey(row = {}) {
  return [row.categoryKey, row.source, row.reason].map((value) => String(value || "").trim().toLowerCase()).join("|");
}

function normalizeEvidence(value, stats) {
  const byKey = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    const categoryKey = validKey(raw?.categoryKey);
    if (!categoryKey) { stats.invalidValues += 1; continue; }
    const row = {
      categoryKey,
      source: PLATFORM_LABELS[String(raw.source || "").trim()] ? String(raw.source).trim() : "",
      reason: String(raw.reason || "").trim().slice(0, 180),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      observedAt: String(raw.observedAt || "").trim()
    };
    const key = evidenceKey(row);
    const previous = byKey.get(key);
    if (previous) stats.evidenceDeduped += 1;
    if (!previous || row.confidence > previous.confidence || row.observedAt > previous.observedAt) byKey.set(key, row);
  }
  return [...byKey.values()]
    .sort((a, b) => b.confidence - a.confidence || b.observedAt.localeCompare(a.observedAt))
    .slice(0, MAX_EVIDENCE);
}

function migrateCompany(company = {}, stats) {
  const hasCategoryData = ["categoryKey", "primaryCategoryKey", "categoryTags", "categoryConfidence", "categoryEvidence", "sourcePlatforms"]
    .some((key) => Object.prototype.hasOwnProperty.call(company, key));
  if (!hasCategoryData) return { company, changed: false };
  stats.categoryFieldCompanies += 1;
  if (company.categoryKey) stats.legacyCategoryKeyCompanies += 1;
  const legacy = validKey(company.categoryKey);
  const primary = validKey(company.primaryCategoryKey) || legacy;
  if ((company.primaryCategoryKey || company.categoryKey) && !primary) {
    stats.unknownCategoryValues += 1;
    return { company, changed: false };
  }
  const tags = unique([primary, ...(Array.isArray(company.categoryTags) ? company.categoryTags.map(validKey) : [])]).filter(Boolean)
    .sort((a, b) => CATEGORY_PROFILES[a].order - CATEGORY_PROFILES[b].order);
  if (company.categoryTags !== undefined && !Array.isArray(company.categoryTags)) stats.invalidValues += 1;
  const evidence = normalizeEvidence(company.categoryEvidence, stats);
  const sourcePlatforms = unique((Array.isArray(company.sourcePlatforms) ? company.sourcePlatforms : [])
    .map((value) => String(value || "").trim()).filter((value) => PLATFORM_LABELS[value]));
  const next = {
    ...company,
    primaryCategoryKey: primary,
    categoryTags: tags,
    categoryConfidence: Math.max(0, Math.min(1, Number(company.categoryConfidence) || 0)),
    categoryEvidence: evidence,
    sourcePlatforms
  };
  const changed = JSON.stringify(next) !== JSON.stringify(company);
  return { company: next, changed };
}

function inspectAndMigrate(master = {}) {
  const stats = {
    totalCompanies: 0, categoryFieldCompanies: 0, legacyCategoryKeyCompanies: 0, compoundTagCompanies: 0,
    unknownCategoryCompanies: 0, manualOverrideCompanies: 0, duplicateReviewCompanies: 0,
    invalidValues: 0, unknownCategoryValues: 0, evidenceDeduped: 0, changedCompanies: 0, unchangedCompanies: 0,
    primaryCounts: Object.fromEntries([...Object.keys(CATEGORY_PROFILES), "unknown"].map((key) => [key, 0]))
  };
  const next = { ...master, companies: { ...(master.companies || {}) } };
  for (const [id, company] of Object.entries(master.companies || {})) {
    stats.totalCompanies += 1;
    const migrated = migrateCompany(company, stats);
    next.companies[id] = migrated.company;
    migrated.changed ? stats.changedCompanies += 1 : stats.unchangedCompanies += 1;
    const primary = validKey(migrated.company.primaryCategoryKey || migrated.company.categoryKey);
    stats.primaryCounts[primary || "unknown"] += 1;
    if ((migrated.company.categoryTags || []).length > 1) stats.compoundTagCompanies += 1;
    if (!primary) stats.unknownCategoryCompanies += 1;
    if (validKey(migrated.company.manualCorrection?.primaryCategoryKey)) stats.manualOverrideCompanies += 1;
    if (migrated.company.duplicateReview?.status === "pending") stats.duplicateReviewCompanies += 1;
  }
  return { migrated: next, stats };
}

async function readMaster(inputPath) {
  if (!inputPath || !path.isAbsolute(inputPath)) throw new Error("--input must be an explicit absolute JSON path");
  const raw = await fsp.readFile(inputPath);
  return { raw, master: JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")), hash: hashBuffer(raw) };
}

async function atomicWrite(target, buffer) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, buffer, { flag: "wx" });
  await fsp.rename(temp, target);
}

async function runMigration(options = {}) {
  const mode = options.mode || "inspect";
  if (mode === "rollback") {
    if (options.confirm !== ROLLBACK_TOKEN) throw new Error(`rollback requires --confirm ${ROLLBACK_TOKEN}`);
    if (!options.input || !options.backup || !path.isAbsolute(options.input) || !path.isAbsolute(options.backup)) throw new Error("rollback requires absolute --input and --backup paths");
    if (path.resolve(options.input) === path.resolve(options.backup)) throw new Error("rollback target and backup must differ");
    const backup = await fsp.readFile(options.backup);
    JSON.parse(backup.toString("utf8").replace(/^\uFEFF/, ""));
    await atomicWrite(options.input, backup);
    return { mode, targetHash: hashBuffer(backup), rollbackApplied: true };
  }
  const source = await readMaster(options.input);
  const result = inspectAndMigrate(source.master);
  const outputBuffer = jsonBuffer(result.migrated);
  const report = { mode, input: options.input, inputHash: source.hash, outputHash: hashBuffer(outputBuffer), ...result.stats, rollbackPossible: false };
  if (mode === "inspect" || mode === "dry-run") return report;
  if (mode !== "apply") throw new Error("mode must be inspect, dry-run, apply, or rollback");
  if (options.confirm !== APPLY_TOKEN) throw new Error(`apply requires --confirm ${APPLY_TOKEN}`);
  if (!options.output || !options.backup || !path.isAbsolute(options.output) || !path.isAbsolute(options.backup)) throw new Error("apply requires absolute --output and --backup paths");
  if (path.resolve(options.backup) === path.resolve(options.input) || path.resolve(options.backup) === path.resolve(options.output)) throw new Error("backup path must differ from input and output");
  if (path.resolve(options.input) === path.resolve(options.output) && options.inPlace !== true && options.inPlace !== "true") throw new Error("in-place apply requires --in-place true");
  if (fs.existsSync(options.backup)) throw new Error("backup path already exists");
  await atomicWrite(options.backup, source.raw);
  try {
    await atomicWrite(options.output, outputBuffer);
  } catch (error) {
    await fsp.rm(options.backup, { force: true });
    throw error;
  }
  return { ...report, rollbackPossible: true, backup: options.backup, output: options.output };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    options[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return options;
}

if (require.main === module) {
  runMigration(parseArgs(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`Migration blocked: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { APPLY_TOKEN, ROLLBACK_TOKEN, inspectAndMigrate, runMigration };
