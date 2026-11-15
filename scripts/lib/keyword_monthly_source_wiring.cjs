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
function buildSourceWiring({ codeRoot, copyDataDir, now, readOnlyOriginalOutputs = null, streamHistoryOnly = false, incremental = null } = {}) {
  need(typeof copyDataDir === "string" && path.isAbsolute(copyDataDir) && Number.isFinite(Date.parse(now)), "KEYWORD_WIRING_COPY_AND_CLOCK_REQUIRED");
  need(incremental === null || incremental && typeof incremental === "object" && incremental.observationIndex
    && ["ensure", "readRows", "revisionPartitions"].every(method => typeof incremental.observationIndex[method] === "function"), "KEYWORD_WIRING_INCREMENTAL_INVALID");
  const dataDir = path.resolve(copyDataDir);
  need(dataDir !== path.parse(dataDir).root && dataDir !== path.resolve("/var/data"), "KEYWORD_WIRING_PRIVATE_COPY_REQUIRED");
  const I = inspectSource(codeRoot), req = createRequire(I.filename), quiet = () => {};
  const metrics = { sourceReads: 0, savedRunLoads: 0, appEntryExecutions: 0, providerFactories: 0, collectorFactories: 0, deniedRequires: 0 };
  const privateIndexFile = path.join(dataDir, "history", "indexes", "observations.sqlite");
  let sourceOptions = null;
  const incrementalRevision = async () => {
    need(typeof incremental?.revision === "string" && incremental.revision.length > 0 && incremental.revision.length <= 1024, "KEYWORD_WIRING_INCREMENTAL_REVISION_REQUIRED");
    return incremental.revision;
  };
  const catalogProxy = incremental && Object.fromEntries(["readCatalog", "readCompanyCatalog", "withCatalog", "withCompanyCatalog", "stats"].map(method => [method, (...args) => {
    const provider = incremental.catalog;
    need(provider && typeof provider[method] === "function", "KEYWORD_WIRING_INCREMENTAL_CATALOG_REQUIRED");
    return provider[method](...args);
  }]));
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
        if (incremental && to === "createHistoryObservationIndex") return incremental.observationIndex;
        if (incremental && ["createMonthlyReportSourceRevision", "createMonthlyReportSelectorRevision"].includes(to)) return incrementalRevision;
        // An explicit saved-copy mode uses the application's pre-existing
        // streaming branch. No SQLite database, WAL or index factory executes.
        if (to === "createHistoryObservationIndex" && streamHistoryOnly) return null;
        if (to.startsWith("create")) {
          args[0] = { ...(args[0] || {}) };
          if (to === "createAnalyticalWorkScheduler") {
            // This scheduler owns only this explicit saved copy/private child.
            // The host already holds the real worker/maintenance admission.
            // Do not evaluate the extracted host callback or import/read its
            // production maintenance ledger inside the restricted VM.
            args[0].externalAdmission = null;
          }
          if (to === "createHistoryObservationIndex") {
            need(path.resolve(args[0].file || "") === path.join(dataDir, "history", "observations.jsonl")
              && path.resolve(args[0].indexFile || "") === privateIndexFile, "KEYWORD_WIRING_PRIVATE_INDEX_REQUIRED");
            // A Worker has a fresh JS filesystem module and would escape the
            // private child's main-thread path guards. Keep the SAME complete
            // SQLite integrity check inside the already isolated copy instead.
            args[0].integrityCheck = ({ indexFile, synchronousCheck } = {}) => {
              need(indexFile === privateIndexFile && typeof synchronousCheck === "function", "KEYWORD_WIRING_PRIVATE_INDEX_REQUIRED");
              return synchronousCheck();
            };
          }
          if (!["createAnalyticalWorkScheduler", "createAnalyticalMemorySampler"].includes(to)) args[0].now = () => new Date(now);
          if (to === "createMonthlyCompanyRecalculation") {
            const read = args[0].loadRun; args[0].loadRun = (...values) => { metrics.savedRunLoads++; return read(...values); };
            if (incremental) args[0].cacheRevisionForRun = details => {
              need(typeof incremental.runRevision === "function", "KEYWORD_WIRING_INCREMENTAL_RUN_REVISION_REQUIRED");
              return incremental.runRevision(details);
            };
            if (incremental?.cacheDirectory) args[0].cacheDirectory = incremental.cacheDirectory;
          }
          if (to === "createMonthlyReportSources") {
            sourceOptions = { ...args[0] };
            if (incremental) Object.assign(args[0], { preparedCatalogProvider: catalogProxy, readRevision: incrementalRevision, readOptionsRevision: incrementalRevision });
          }
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
  if (incremental) sandbox.listRuns = async () => {
    if (incremental.runs === undefined) return vm.runInContext("runCatalog.list()", context);
    need(Array.isArray(incremental.runs), "KEYWORD_WIRING_INCREMENTAL_RUNS_INVALID");
    return structuredClone(incremental.runs).sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || ""))
      || String(b.id || "").localeCompare(String(a.id || "")));
  };
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
    bridge: { prepareCompanies: sourceOptions.prepareCompanies, projectCapacityCompany: sourceOptions.projectCapacityCompany,
      capacityForCompany: sourceOptions.capacityForCompany, maximumRoomCapacity: vm.runInContext("companyMaximumRoomCapacity", context), sourceOptions },
    scheduler: vm.runInContext("analyticalWork", context), metrics, bindings: { ...I.bindings, ranges, imports: IMPORTS.map(row => row[0]), declarationOrder: BUILD_ORDER,
      schedulerScope: "private_saved_copy_no_host_maintenance", schedulerDataDir: dataDir,
      historyIndexIntegrityScope: incremental ? "injected_incremental_index" : streamHistoryOnly ? "streaming_without_sqlite"
        : "same_full_check_inside_isolated_copy",
      observationIndexMode: incremental ? "incremental_saved_deltas" : streamHistoryOnly ? "exact_application_streaming_fallback" : "copied_data_index", originalOutputsReadOnlyReferenced: Boolean(readOnlyOriginalOutputs) },
    assertCodeCurrent() { need(inspectSource(I.root).bindings.codeFingerprint === I.bindings.codeFingerprint, "KEYWORD_WIRING_CODE_CHANGED"); },
    requireAllowlist: [...requireAllowlist] };
}
module.exports = { IMPORTS, BUILD_ORDER, literalSafe, inspectSource, buildSourceWiring };
