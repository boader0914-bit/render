"use strict";
// Inert, explicit saved-copy normalization. The application entry point is
// parsed as text and NEVER required. Only exact declaration ranges execute.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function need(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const IMPORTS = [
  ["inventory_estimation.cjs", ["applyInventoryEvidence", "buildCapacityReview", "buildStoredCapacityReview"]],
  ["lib/company_bootstrap.cjs", ["compactCompanyInventory"]],
  ["lib/collection_capacity_coverage.cjs", ["collectionCapacityCoverageForBusiness"]],
  ["lib/inventory_manual_corrections.cjs", ["sanitizeProductStockCorrections"]],
  ["lib/product_capacity_baseline.cjs", ["observedProductCapacityEvidence", "productCapacityBaselineAt", "compactProductCapacityEvidence", "mergeProductCapacityBaselines"]],
  ["lib/product_capacity_store.cjs", ["createProductCapacityStore", "productCapacityCorrectionSignature"]],
  ["naver_place_ota_observation.cjs", ["otaProviderFromUrl"]],
  ["lib/monthly_report_sources.cjs", ["createMonthlyReportSources"]],
  ["lib/monthly_report_source_revision.cjs", ["createMonthlyReportSourceRevision"]],
  ["lib/monthly_report_selector_revision.cjs", ["createMonthlyReportSelectorRevision"]],
  ["lib/analytical_work_scheduler.cjs", ["createAnalyticalWorkScheduler"]],
  ["lib/analytical_memory.cjs", ["createAnalyticalMemorySampler"]],
  ["lib/company_capacity_registry.cjs", ["createCompanyCapacityRegistry"]],
  ["lib/monthly_company_recalculation.cjs", ["createMonthlyCompanyRecalculation"]],
  ["lib/saved_product_recovery.cjs", ["createSavedProductRecovery"]],
  ["lib/monthly_company_source_catalog.cjs", ["compactMonthlyCapacityCompany"]],
  ["daily_collection_quality.cjs", [["inspectResult", "inspectDailyCollectionResult"], "allowsDerivedUpdates"]],
  ["lib/collection_diagnostics.cjs", ["readCollectionDiagnostics"]],
  ["lib/history_observation_index.cjs", ["createHistoryObservationIndex"]],
  ["lib/run_catalog.cjs", ["createRunCatalog"]]
];
const BUILD_ORDER = ["historyObservationIndex", "runCatalog", "companyCapacityRegistry", "productCapacityStore", "readMonthlyReportRevision",
  "analyticalMemory", "analyticalWork", "runAnalyticalWork", "monthlyCompanySourceVersion", "recalculateMonthlyCompanyObservations", "savedProductRecovery", "monthlyReportSources"];
function literalSafe(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  if (node.type === "ArrayExpression") return node.elements.every(value => !value || literalSafe(value));
  if (node.type === "ObjectExpression") return node.properties.every(value => value.type === "Property" && !value.computed && literalSafe(value.value));
  if (node.type === "UnaryExpression") return ["+", "-", "!", "~", "void"].includes(node.operator) && literalSafe(node.argument);
  if (node.type === "BinaryExpression") return literalSafe(node.left) && literalSafe(node.right);
  if (node.type === "NewExpression") return node.callee.type === "Identifier" && ["Set", "Map"].includes(node.callee.name) && node.arguments.every(literalSafe);
  return node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && node.callee.object.name === "Object" && node.callee.property.name === "freeze" && node.arguments.every(literalSafe);
}
function inspectSource(codeRoot) {
  need(typeof codeRoot === "string" && path.isAbsolute(codeRoot), "KEYWORD_WIRING_CODE_ROOT_REQUIRED");
  const root = path.resolve(codeRoot), filename = path.join(root, "scripts", "glamping_app_server.cjs"), raw = fs.readFileSync(filename), source = raw.toString("utf8");
  const body = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
  need(typeof body === "string", "KEYWORD_WIRING_ACORN_UNAVAILABLE"); const parser = { exports: {} };
  new Function("exports", "module", body)(parser.exports, parser);
  const ast = parser.exports.parse(source, { ecmaVersion: "latest", sourceType: "script" }), vars = new Map(), functions = [];
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration") functions.push(node);
    if (node.type === "VariableDeclaration") for (const d of node.declarations) if (d.id.type === "Identifier") vars.set(d.id.name, { node, d });
  }
  const files = ["glamping_app_server.cjs", "inventory_estimation.cjs", "verified_room_inventory.json",
    ...fs.readdirSync(path.join(root, "scripts", "lib")).filter(name => name.endsWith(".cjs")).sort().map(name => "lib/" + name)];
  const calculationFiles = files.map(name => ({ name, sha256: sha(fs.readFileSync(path.join(root, "scripts", name))) }));
  return { root, filename, source, ast, vars, functions, bindings: { appSha256: sha(raw), appBytes: raw.length,
    codeFingerprint: sha(JSON.stringify(calculationFiles)), calculationFiles, appEntryExecutions: 0, providerFactories: 0, collectorFactories: 0 } };
}
function buildSourceWiring({ codeRoot, copyDataDir, now, readOnlyOriginalOutputs = null, streamHistoryOnly = false } = {}) {
  need(typeof copyDataDir === "string" && path.isAbsolute(copyDataDir) && Number.isFinite(Date.parse(now)), "KEYWORD_WIRING_COPY_AND_CLOCK_REQUIRED");
  const I = inspectSource(codeRoot), dataDir = path.resolve(copyDataDir), req = createRequire(I.filename), quiet = () => {};
  const metrics = { sourceReads: 0, savedRunLoads: 0, appEntryExecutions: 0, providerFactories: 0, collectorFactories: 0, deniedRequires: 0 };
  const requireAllowlist = new Set([...IMPORTS.map(row => "./" + row[0]), "./yeogi_import_parser.cjs", "./lib/company_master_stream.cjs", "./lib/company_address_basis.cjs"]);
  const vmRequire = filename => { if (!requireAllowlist.has(filename)) { metrics.deniedRequires++; throw Object.assign(new Error("KEYWORD_WIRING_REQUIRE_DENIED"), { code: "KEYWORD_WIRING_REQUIRE_DENIED" }); } return req(filename); };
  const sandbox = { Buffer, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, AbortSignal, structuredClone,
    setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask, performance,
    console: { log: quiet, warn: quiet, error: quiet, info: quiet, debug: quiet }, process: { pid: process.pid, env: Object.freeze({}), platform: process.platform },
    fs, fsp: require("node:fs/promises"), path, crypto, os: require("node:os"), require: vmRequire,
    ROOT: I.root, WEB_DIR: path.join(I.root, "web"), DATA_DIR: dataDir, OUTPUTS_DIR: readOnlyOriginalOutputs ? path.resolve(readOnlyOriginalOutputs) : path.join(dataDir, "outputs"),
    CONFIG_DIR: path.join(dataDir, "config"), HISTORY_DIR: path.join(dataDir, "history"), HISTORY_OBSERVATIONS_FILE: path.join(dataDir, "history", "observations.jsonl"),
    HISTORY_EVIDENCE_DIR: path.join(dataDir, "history", "evidence"), HISTORY_DATALAB_TRENDS_FILE: path.join(dataDir, "history", "datalab_trends.json"),
    COMPANY_MASTER_DIR: path.join(dataDir, "company_master"), COMPANY_MASTER_FILE: path.join(dataDir, "company_master", "companies.json"),
    TOURISM_DATA_DIR: path.join(dataDir, "tourism_data"), TRAFFIC_KEYS_FILE: path.join(dataDir, "config", "traffic_api_keys.local.json"),
    __dirname: path.join(I.root, "scripts"), __filename: I.filename, regionalAnalysisStore: null, regionalOutlookService: null,
    readMonthlyRegionContext: async () => null, yeogiImportParser: req("./yeogi_import_parser.cjs") };
  for (const [filename, names] of IMPORTS) {
    const module = req("./" + filename);
    for (const entry of names) {
      const [from, to] = Array.isArray(entry) ? entry : [entry, entry]; need(typeof module[from] === "function", "KEYWORD_WIRING_IMPORT_MISSING");
      sandbox[to] = (...args) => {
        // An explicit saved-copy mode uses the application's pre-existing
        // streaming branch. No SQLite database, WAL or index factory executes.
        if (to === "createHistoryObservationIndex" && streamHistoryOnly) return null;
        if (to.startsWith("create")) {
          args[0] = { ...(args[0] || {}) };
          if (!["createAnalyticalWorkScheduler", "createAnalyticalMemorySampler"].includes(to)) args[0].now = () => new Date(now);
          if (to === "createMonthlyCompanyRecalculation") { const read = args[0].loadRun; args[0].loadRun = (...values) => { metrics.savedRunLoads++; return read(...values); }; }
        }
        const result = module[from](...args);
        if (to === "createMonthlyReportSources") for (const method of ["loadSources", "loadSourcesWithCatalog"]) { const read = result[method]; result[method] = (...values) => { metrics.sourceReads++; return read(...values); }; }
        return result;
      };
    }
  }
  sandbox.specialDaysService = req("./lib/special_days.cjs").createSpecialDaysService({ dataDir: path.join(dataDir, "history", "special_days"),
    readServiceKey: async () => "", fetchImpl: async () => { throw Object.assign(new Error("KEYWORD_COPY_NETWORK_DENIED"), { code: "KEYWORD_COPY_NETWORK_DENIED" }); }, now: () => Date.parse(now) });
  const context = vm.createContext(sandbox, { name: "explicit-keyword-saved-copy" }), ranges = [];
  const evaluate = (text, name) => new vm.Script(text, { filename: "keyword-source-extract-" + name + ".cjs" }).runInContext(context);
  evaluate(I.functions.map(node => I.source.slice(node.start, node.end)).join("\n"), "function-declarations");
  for (const [name, { d }] of I.vars) if (/^[A-Z][A-Z0-9_]*$/.test(name) && literalSafe(d.init) && !Object.hasOwn(sandbox, name)) evaluate(`this.${name}=(${I.source.slice(d.init.start, d.init.end)});`, name);
  for (const name of ["ADMIN_REGION_ALIAS_TO_KEY", "ADMIN_REGION_CHILD_SETS"]) {
    const { d } = I.vars.get(name) || {}; need(d, "KEYWORD_WIRING_REGION_MAP_MISSING"); evaluate("this." + name + "=(" + I.source.slice(d.init.start, d.init.end) + ");", name);
  }
  for (const name of BUILD_ORDER) {
    const value = I.vars.get(name); need(value && value.node.declarations.length === 1, "KEYWORD_WIRING_DECLARATION_MISSING");
    const text = I.source.slice(value.node.start, value.node.end); ranges.push({ name, start: value.node.start, end: value.node.end, sha256: sha(text) }); evaluate(text, name);
  }
  return { sources: vm.runInContext("monthlyReportSources", context), index: vm.runInContext("historyObservationIndex", context),
    listRuns: vm.runInContext("listRuns", context),
    scheduler: vm.runInContext("analyticalWork", context), metrics, bindings: { ...I.bindings, ranges, imports: IMPORTS.map(row => row[0]), declarationOrder: BUILD_ORDER,
      observationIndexMode: streamHistoryOnly ? "exact_application_streaming_fallback" : "copied_data_index", originalOutputsReadOnlyReferenced: Boolean(readOnlyOriginalOutputs) },
    assertCodeCurrent() { need(inspectSource(I.root).bindings.codeFingerprint === I.bindings.codeFingerprint, "KEYWORD_WIRING_CODE_CHANGED"); },
    requireAllowlist: [...requireAllowlist] };
}
module.exports = { IMPORTS, BUILD_ORDER, literalSafe, inspectSource, buildSourceWiring };
