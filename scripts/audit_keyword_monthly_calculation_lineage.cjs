"use strict";
// Parse source text only. Never import or start the application being audited.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const native = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
if (!native) throw Error("AUDIT_PARSER_UNAVAILABLE");
const parserModule = { exports: {} };
new Function("exports", "module", native)(parserModule.exports, parserModule);
function functions(source) {
  const result = new Map();
  const ast = parserModule.exports.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "FunctionDeclaration" && value.id) {
      const name = value.id.name, sourceHash = hash(source.slice(value.start, value.end));
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(sourceHash);
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === "object") visit(child);
  }
  visit(ast); return result;
}
function read(file, ref) {
  const bytes = ref ? execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }) : fs.readFileSync(path.join(root, file));
  if (bytes.length > 8 * 1024 * 1024) throw Error("AUDIT_SOURCE_BOUND");
  return bytes.toString("utf8").replace(/\r\n/g, "\n");
}
function run(reference = "4d1273ccb7ac5cb326017896b61c6b1f8341a20d", output) {
  const files = ["scripts/glamping_app_server.cjs", "scripts/lib/monthly_reports.cjs", "scripts/lib/monthly_report_sources.cjs",
    "scripts/lib/monthly_company_recalculation.cjs", "scripts/inventory_estimation.cjs", "scripts/lib/inventory_manual_corrections.cjs",
    "scripts/lib/company_capacity_registry.cjs", "scripts/lib/product_capacity_baseline.cjs", "scripts/lib/product_capacity_store.cjs", "scripts/lib/monthly_company_source_catalog.cjs"];
  const selected = {
    "scripts/glamping_app_server.cjs": ["companyHistoryObservationWithCurrentCapacity", "manualCorrectionLodgingBasisTotal", "companyMaximumRoomCapacity", "applyCompanyManualCorrection", "companyProductAvailabilityMatch", "buildHistoryObservations", "companyInventorySnapshotWithCurrentCapacity", "withCompanyInventoryCapacityRecord", "withCompanyInventoryCapacity", "createCompanyInventoryCapacityIndex", "withIndexedCompanyInventoryCapacity", "summarizeAvailabilityRows", "historySeriesForItem", "inventoryEstimateBreakdown", "applyOfflineReservationBasis", "hasActiveManualCorrection", "parseAvailabilityDetail", "parseReservationRateDetail", "singleAvailabilityRow", "normalizeObservationNumber"],
    "scripts/lib/monthly_company_source_catalog.cjs": ["compactMonthlyCapacityCompany"],
    "scripts/lib/monthly_reports.cjs": ["buildSnapshot", "validCounts", "knownPartialRevenue", "priceEvidence", "aggregate", "keywordMembership", "rowKey", "compareRows"],
    "scripts/lib/monthly_report_sources.cjs": ["canonical", "addRow", "readSourceData", "readSources", "readHistory"]
  };
  const records = files.map(file => {
    const before = read(file, reference), after = read(file), a = functions(before), b = functions(after);
    const checks = (selected[file] || []).map(name => ({ name, presentBefore: a.has(name), presentAfter: b.has(name),
      beforeHashes: a.get(name) || [], afterHashes: b.get(name) || [], equal: a.has(name) && b.has(name) && JSON.stringify(a.get(name)) === JSON.stringify(b.get(name)) }));
    return { file, beforeSha256: hash(before), afterSha256: hash(after), wholeFileUnchanged: before === after, functions: checks };
  });
  const receipt = { schemaVersion: 1, referenceCommit: reference, currentCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    observedAt: new Date().toISOString(), sourceTextOnly: true, applicationImportedOrStarted: false, providerCalls: 0, kosisCalls: 0, records };
  if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}
if (require.main === module) {
  const result = run(process.argv[2] || undefined, process.argv[3]);
  console.log(JSON.stringify({ files: result.records.length, functions: result.records.flatMap(row => row.functions).length,
    differences: result.records.flatMap(row => row.functions.filter(item => !item.equal).map(item => ({ file: row.file, name: item.name, presentBefore: item.presentBefore, presentAfter: item.presentAfter }))) }));
}
module.exports = { run };
