const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_BLOCKED_SOURCE_IDENTIFIERS,
  createIntegrationDataAccessGuard,
  isCompleteStaticAssetAllowlistEntry,
  sha256File
} = require("./integration_data_access_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const V3_REPOSITORY = process.env.STAGE224_V3_REPOSITORY
  || "C:\\Users\\USER\\Documents\\lodging-datalab-v3";
const OUTPUT_PATH = path.join(ROOT, "docs", "stage224_feature_ledger.json");

const SOURCE_REFS = Object.freeze({
  v2: Object.freeze({
    name: "glamping-datalab-v2",
    repository: ROOT,
    commit: "4e4e1906e2967fe58df66f8ad67f832043d2763b"
  }),
  cluster: Object.freeze({
    name: "glamping-cluster-app",
    repository: ROOT,
    commit: "57a6c561496812126e2ff2e8a61bff51099b2423"
  }),
  v3: Object.freeze({
    name: "lodging-datalab-v3",
    repository: V3_REPOSITORY,
    commit: "2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154"
  })
});

const REQUIRED_LEDGER_FIELDS = Object.freeze([
  "id",
  "domain",
  "source",
  "sourceCommit",
  "sourcePath",
  "role",
  "routeOrScreen",
  "v2Conflict",
  "decision",
  "decisionRationale",
  "v2PriorityReason",
  "targetStage",
  "featureFlag",
  "freshDataInputs",
  "tests",
  "releaseGate",
  "notes",
  "owner",
  "approver"
]);

const DECISIONS = new Set(["keep", "port", "defer", "exclude"]);
function numberedIds(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}
const FROZEN_CURATED_FEATURE_IDS = Object.freeze({
  v2: Object.freeze([
    ...numberedIds("V2-A", 8),
    ...numberedIds("V2-B", 8),
    ...numberedIds("V2-C", 12),
    ...numberedIds("V2-D", 10),
    ...numberedIds("V2-E", 7),
    ...numberedIds("V2-F", 7)
  ]),
  cluster: Object.freeze([
    ...numberedIds("CL-A", 13),
    ...numberedIds("CL-C", 10),
    ...numberedIds("CL-D", 8),
    ...numberedIds("CL-O", 8),
    ...numberedIds("CL-R", 8),
    ...numberedIds("CL-S", 8),
    ...numberedIds("CL-U", 6),
    ...numberedIds("CL-X", 8),
    ...numberedIds("CL-Z", 8)
  ])
});
const FROZEN_INVENTORY_EXPECTED = Object.freeze({
  v2: Object.freeze({
    stage221LiteralRawCount: 43,
    stage221LiteralCanonicalCount: 40,
    stage221TrailingSlashCollisionCount: 3,
    v3SurveyCount: 45,
    v3SurveyMatchesFrozenArtifact: true,
    v3SurveyOnlyRoutes: Object.freeze(["/admin", "/b2b", "/outputs", "/outputs/*", "/view"]),
    handlerPathPatternCount: 41,
    handlerMethodPathCount: 47,
    dynamicRouteCount: 4
  }),
  cluster: Object.freeze({
    stage221LiteralRawCount: 228,
    stage221LiteralCanonicalCount: 207,
    stage221TrailingSlashCollisionCount: 21,
    v3SurveyCount: 214,
    v3SurveyMatchesFrozenArtifact: true,
    v3SurveyOnlyRoutes: Object.freeze([
      "/admin",
      "/api",
      "/api/admin/auth/invitations/${action}",
      "/api/admin/master-db/companies${query}",
      "/app",
      "/outputs",
      "/view"
    ]),
    handlerPathPatternCount: 232,
    handlerMethodPathCount: 256,
    dynamicRouteCount: 28
  })
});
const FROZEN_CLUSTER_HANDLER_CONFLICTS = Object.freeze([
  "GET /api/health",
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/settings/traffic-keys",
  "HEAD /api/health",
  "POST /api/crawl",
  "POST /api/settings/traffic-keys",
  "POST /api/yeogi-import"
]);
const TEXT_SOURCE_FILES = Object.freeze([
  "scripts/glamping_app_server.cjs",
  "web/app.js"
]);

function runGit(repository, args, options = {}) {
  const result = childProcess.spawnSync(
    "git",
    ["-C", repository, ...args],
    {
      encoding: options.buffer ? null : "utf8",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr || "");
    throw new Error(`git ${args.join(" ")} failed in ${repository}: ${stderr.trim()}`);
  }
  return result.stdout;
}

function readRef(source, sourcePath, options = {}) {
  return runGit(source.repository, ["show", `${source.commit}:${sourcePath}`], options);
}

function normalizeRoute(route) {
  return String(route || "").replace(/\/$/, "") || "/";
}

function collectSurveyRoutes(text) {
  const routes = new Set();
  const pattern = /["'`](\/(?:api|outputs|admin|app|b2b|view)(?:\/[^"'`\s?)]*)?)["'`]/g;
  for (const match of text.matchAll(pattern)) routes.add(normalizeRoute(match[1]));
  return [...routes].sort();
}

function collectStage221LiteralRoutes(text) {
  const routes = new Set();
  // Stage 221 deliberately counted static single/double-quoted endpoint
  // literals. Bare `/api/` sentinels and template literals were not routes.
  const pattern = /["'](\/api\/[^"'\s?)]*)["']/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== "/api/") routes.add(match[1]);
  }
  return [...routes].sort();
}

function methodsFromCondition(condition) {
  return [...new Set(
    [...condition.matchAll(/req\.method\s*===\s*["'](GET|HEAD|POST|PUT|PATCH|DELETE)["']/g)]
      .map((match) => match[1])
  )].sort();
}

function dynamicContracts(serverText) {
  const contracts = [];
  const lines = serverText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("req.method") || !line.includes("pathname.startsWith(")) continue;
    const methods = methodsFromCondition(line);
    const prefixMatch = line.match(/pathname\.startsWith\(["'](\/api\/[^"']+)["']\)/);
    if (!prefixMatch || methods.length === 0) continue;
    const prefix = prefixMatch[1].replace(/\/$/, "");
    const suffixes = [...line.matchAll(/pathname\.endsWith\(["'](\/[^"']+)["']\)/g)]
      .map((match) => match[1]);
    const patterns = suffixes.length > 0
      ? suffixes.map((suffix) => `${prefix}/:id${suffix}`)
      : [`${prefix}/:id`];
    for (const method of methods) {
      for (const routePath of patterns) {
        contracts.push({
          method,
          path: routePath,
          dynamic: true,
          sourceLine: index + 1,
          parameterInference: "generic-id-reviewed"
        });
      }
    }
  }

  if (serverText.includes("commercial-launch-rc-rehearsals\\/([^/]+)\\/actions\\/([^/]+)")) {
    const line = lines.findIndex((value) => value.includes("const launchRcActionMatch"));
    contracts.push({
      method: "POST",
      path: "/api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/:actionId",
      dynamic: true,
      sourceLine: line + 1,
      parameterInference: "regex-captures"
    });
  }
  return contracts;
}

function collectHandlerContracts(serverText) {
  const contracts = [];
  const lines = serverText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("req.method") || !line.includes("pathname ===")) continue;
    const methods = methodsFromCondition(line);
    const paths = [...line.matchAll(/(?:reqUrl\.)?pathname\s*===\s*["'](\/api(?:\/[^"']*)?)["']/g)]
      .map((match) => normalizeRoute(match[1]));
    for (const method of methods) {
      for (const routePath of paths) {
        contracts.push({ method, path: routePath, dynamic: false, sourceLine: index + 1 });
      }
    }
  }
  contracts.push(...dynamicContracts(serverText));
  return [...new Map(
    contracts.map((contract) => [`${contract.method} ${contract.path}`, contract])
  ).values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function parseFeatureReview(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*((?:V2|CL)-[A-Z]\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (!match) continue;
    rows.push({
      id: match[1],
      title: match[2].trim(),
      sourceMethod: match[3].trim(),
      v3Status: match[4].trim(),
      v3Application: match[5].trim()
    });
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function domainFor(value, featureId = "") {
  if (/^V2-A/.test(featureId) || /^CL-A(?:0[1-9]|10|13)$/.test(featureId)) return "auth-security";
  if (/^V2-B/.test(featureId)) return "platform-core";
  if (/^V2-C/.test(featureId)) return "collection-runtime";
  if (/^(?:V2-D|CL-D)/.test(featureId)) return "company-observation";
  if (/^V2-E/.test(featureId)) return "location-tourism";
  if (/^V2-F0[12]$/.test(featureId) || /^CL-C/.test(featureId)) return "external-connectors";
  if (/^V2-F0[3-5]$/.test(featureId) || /^CL-A1[12]$/.test(featureId)) return "import-export";
  if (/^V2-F0[67]$/.test(featureId) || /^CL-U/.test(featureId) || /^CL-R07$/.test(featureId)) return "ui-shell";
  if (/^CL-O/.test(featureId) || /^CL-Z/.test(featureId)) return "release-operations";
  if (/^CL-R0[128]$/.test(featureId)) return "location-tourism";
  if (/^CL-R0[3-6]$/.test(featureId)) return "reporting-forecast";
  if (/^CL-S/.test(featureId)) return "strategy-execution";
  if (/^CL-X/.test(featureId)) return "experimentation";
  const text = String(value || "");
  if (/auth|login|logout|session|signup|account|password|invitation|mfa|csrf|security|tenant|entitlement|subscription|요금|계정|로그인|보안|세션|회원/i.test(text)) return "auth-security";
  if (/experiment|variant|a\/b|학습|calibration|실험/i.test(text)) return "experimentation";
  if (/strategy|plan|board|retrospective|next-month|kpi|전략|실행|회고|후보/i.test(text)) return "strategy-execution";
  if (/report|forecast|cohort|리포트|예측|비교군/i.test(text)) return "reporting-forecast";
  if (/location|region-card|tourism|map|geojson|입지|관광|지역|지도/i.test(text)) return "location-tourism";
  if (/connector|interest-signal|search.?volume|trend|sns|ota|schedule|quota|signal|검색량|관심도|신호/i.test(text)) return "external-connectors";
  if (/deployment|backup|readiness|smoke|launch|alert|diagnostic|배포|백업|출시/i.test(text)) return "release-operations";
  if (/export|import|xlsx|csv|spreadsheet|다운로드|가져오기/i.test(text)) return "import-export";
  if (/company|master-db|verified|duplicate|reliability|observation|업체|관측|신뢰|중복|검수|보정/i.test(text)) return "company-observation";
  if (/crawl|collect|run|quick|detail|leadtime|availability|예약|수집|검색|재고/i.test(text)) return "collection-runtime";
  if (/admin|view|app|b2b|screen|ui|pwa|화면|탭/i.test(text)) return "ui-shell";
  return "platform-core";
}

function stageFor(domain, decision, featureId = "") {
  if (decision === "exclude") return "224";
  if (decision === "defer") return "post-234";
  if (/^(?:V2|CL)-A/.test(featureId)) return /(?:V2-F0[345]|CL-A1[12])/.test(featureId) ? "232" : "226";
  if (/^V2-B/.test(featureId)) return "227";
  if (/^(?:V2-C|V2-D|CL-D)/.test(featureId)) return "228";
  if (/^(?:V2-E|CL-R)/.test(featureId)) return "229";
  if (/^CL-S/.test(featureId)) return "230";
  if (/^CL-C/.test(featureId)) return "231";
  if (/^CL-O0[1-4]$/.test(featureId)) return "232";
  if (/^CL-O0[5-8]$/.test(featureId)) return "233";
  if (/^CL-U0[1-3]$/.test(featureId)) return "225";
  if (/^CL-U0[4-6]$/.test(featureId)) return "227";
  if (/^CL-Z/.test(featureId)) return "232";
  if (/^V2-F0[12]$/.test(featureId)) return "231";
  if (/^V2-F0[67]$/.test(featureId)) return "225";
  return ({
    "ui-shell": "225",
    "auth-security": "226",
    "platform-core": "227",
    "collection-runtime": "228",
    "company-observation": "228",
    "location-tourism": "229",
    "reporting-forecast": "229",
    "strategy-execution": "230",
    experimentation: "post-234",
    "external-connectors": "231",
    "import-export": "232",
    "release-operations": "232"
  })[domain] || "232";
}

function isRecursiveQuality(value) {
  return /(?:auto-approval|auto.?approve|calibration|candidate-quality|rereview|reassessment|recursive|\bsla\b|자동\s*승인|재귀|재평가|보정\s*시뮬레이션)/i.test(String(value || ""));
}

function isExperiment(value) {
  return /(?:experiment|variant|segment-learning|strategy-quality-history|experiment-quality-history|a\/b|실험|세그먼트\s*학습)/i.test(String(value || ""));
}

function decisionFor(sourceKey, value, featureId = "", kind = "") {
  const text = `${featureId} ${value}`;
  if (sourceKey === "v2") {
    if (/V2-D09|V2-F04|V2-F05|backfill|\/outputs(?:\/|$)|company-master\/backfill|\/api\/company-master\/\*/i.test(text)) return "exclude";
    return "keep";
  }
  if (kind === "v3-survey-screen-or-file-surface") return "exclude";
  if (/^CL-X0[1-7]$/.test(featureId) || (isExperiment(text) && !/^CL-(?:C10|Z\d{2})$/.test(featureId))) return "defer";
  if (
    /^(?:CL-X08|CL-C10|CL-Z\d{2})$/.test(featureId)
    || isRecursiveQuality(text)
    || /\/(?:deployment|external-connector)-operation-(?:quality|alert-quality)/i.test(text)
    || /^\s*\/(?:api|api\/admin|api\/admin\/master-db|api\/business)\s*$/i.test(text)
    || /\/rebuild(?:\/|$)|\/outputs(?:\/|$)/i.test(text)
  ) return "exclude";
  if (/^\/api\/(?:health|crawl|runs|settings\/traffic-keys|yeogi-import)(?:\/|$)/i.test(String(value || ""))) return "keep";
  return "port";
}

function decisionRationaleFor(sourceKey, decision, value) {
  if (sourceKey === "v2") {
    return decision === "keep"
      ? "Keep the V2 contract because it is the canonical operational behavior."
      : "Exclude legacy-data rebuild/output behavior or an unsafe implementation while preserving unrelated V2 contracts.";
  }
  if (decision === "keep") return "Keep the V2 implementation of this overlapping contract; do not import the Cluster implementation.";
  if (decision === "defer") return "Defer A/B or learning behavior until the post-234 sample protocol and explicit Product Owner approval are satisfied.";
  if (decision === "exclude") return "Exclude recursive quality, SLA, automatic approval, rebuild, output, or equivalent unbounded runtime behavior.";
  return "Port only the bounded additive capability behind its target-stage flag; no Cluster whole-file or runtime-data copy is allowed.";
}

function rolesFor(domain, value) {
  const text = String(value || "");
  if (/\/api\/health|terms|privacy|약관|개인정보/i.test(text)) return ["public"];
  if (domain === "auth-security") return ["public", "business", "admin"];
  if (/business|b2b|사업자/i.test(text)) return ["business", "admin"];
  if (domain === "ui-shell") return ["business", "admin"];
  if (["external-connectors", "release-operations", "import-export"].includes(domain)) return ["admin", "system-worker"];
  return ["admin"];
}

function governanceFor(domain) {
  if (domain === "auth-security") return { owner: "SE", approver: "SO" };
  if (["collection-runtime", "company-observation", "external-connectors", "location-tourism", "reporting-forecast"].includes(domain)) {
    return { owner: "DE", approver: "DGO" };
  }
  if (domain === "ui-shell") return { owner: "FE", approver: "PO" };
  if (domain === "release-operations") return { owner: "SRE", approver: "RM" };
  return { owner: "BE", approver: "PO" };
}

function flagFor(domain, decision, value, featureId = "") {
  if (decision === "exclude" || decision === "defer" || decision === "keep") return null;
  if (domain === "auth-security") return "V2_INTEGRATION_AUTH_ENABLED";
  if (domain === "company-observation") return /observation|reliability|관측|신뢰/i.test(value)
    ? "V2_INTEGRATION_FRESH_OBSERVATION_ENABLED"
    : "V2_INTEGRATION_FRESH_COMPANY_ENABLED";
  if (domain === "location-tourism") return /(?:R08|map|ranking|지도|순위)/i.test(`${featureId} ${value}`)
    ? "V2_INTEGRATION_MAP_RANKING_ENABLED"
    : "V2_INTEGRATION_LOCATION_CARD_ENABLED";
  if (domain === "reporting-forecast") return "V2_INTEGRATION_BUSINESS_REPORT_ENABLED";
  if (domain === "strategy-execution") return "V2_INTEGRATION_STRATEGY_ENABLED";
  if (domain === "external-connectors") {
    if (/searchad|검색광고/i.test(value)) return "V2_CONNECTOR_NAVER_SEARCHAD_REAL_ENABLED";
    if (/datalab|데이터랩|trend/i.test(value)) return "V2_CONNECTOR_NAVER_TREND_REAL_ENABLED";
    if (/\bsns\b|언급량/i.test(value)) return "V2_CONNECTOR_SNS_REAL_ENABLED";
    if (/\bota\b/i.test(value)) return "V2_CONNECTOR_OTA_REAL_ENABLED";
    if (/scheduler|schedule|스케줄/i.test(value)) return "V2_INTEGRATION_SCHEDULER_ENABLED";
    return "V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED";
  }
  if (domain === "ui-shell") return "V2_V3_UI_ENABLED";
  if (domain === "import-export") return "V2_INTEGRATION_IMPORT_EXPORT_ENABLED";
  if (domain === "release-operations") return "V2_INTEGRATION_RELEASE_OPERATIONS_ENABLED";
  return "V2_INTEGRATION_PLATFORM_CORE_ENABLED";
}

function freshInputsFor(domain, decision) {
  const inputsByDomain = {
    "auth-security": ["new-account-bootstrap", "new-session-events"],
    "collection-runtime": ["fresh-provider-response", "new-run-metadata"],
    "company-observation": ["fresh-provider-response", "new-company-identity", "new-observation"],
    "location-tourism": ["approved-static-asset", "fresh-tourism-response", "fresh-observation"],
    "reporting-forecast": ["fresh-observation", "fresh-interest-signal", "fresh-tourism-signal"],
    "strategy-execution": ["new-published-report", "new-user-action"],
    "external-connectors": ["fresh-provider-response", "new-connector-run"],
    "import-export": ["new-user-upload", "new-integrated-store-record"],
    "release-operations": ["new-release-evidence"],
    "ui-shell": ["new-integrated-api-response"],
    "platform-core": ["new-integrated-store-record"]
  };
  return {
    policy: "empty-integrated-store-fresh-only",
    inputs: decision === "exclude" ? ["none-excluded"] : (inputsByDomain[domain] || ["new-integrated-store-record"]),
    legacyRuntimeReadAllowed: false,
    migrationAllowed: false,
    backfillAllowed: false,
    dualWriteAllowed: false
  };
}

function testsFor(domain, decision) {
  const tests = ["stage224-ledger-schema", "stage224-classification-coverage", "legacy-data-read-zero"];
  if (decision === "exclude") tests.push("excluded-route-runtime-reference-zero");
  if (decision === "defer") tests.push("deferred-flag-default-off");
  if (domain === "auth-security") tests.push("role-session-csrf-contract");
  if (["collection-runtime", "company-observation", "external-connectors"].includes(domain)) tests.push("fresh-provenance-and-idempotency-contract");
  if (domain === "ui-shell") tests.push("v3-four-state-visual-contract");
  return tests;
}

function releaseGateFor(domain, decision) {
  if (decision === "exclude") return "runtime route/flag/reference count = 0";
  if (decision === "defer") return "approved sample protocol and PO approval after Stage 234";
  if (["collection-runtime", "company-observation", "external-connectors"].includes(domain)) {
    return "fresh provenance = 100%; logical duplicates = 0; companyId collisions = 0";
  }
  if (domain === "auth-security") return "role/tenant/session/CSRF contract pass = 100%";
  if (domain === "ui-shell") return "loading/empty/error/success and light/dark QA pass = 100%";
  return "owner test pass = 100% and approver sign-off recorded";
}

function sourcePathForRoute(sourceTexts, route) {
  for (const [sourcePath, text] of Object.entries(sourceTexts)) {
    const index = text.indexOf(route.replace(/:\w+/g, ""));
    if (index >= 0) return `${sourcePath}:${text.slice(0, index).split(/\r?\n/).length}`;
  }
  return "scripts/glamping_app_server.cjs:dynamic-route-audit";
}

function comparableRoutePattern(value) {
  return normalizeRoute(String(value || "")
    .replace(/\$\{query\}$/g, "")
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":param"));
}

function featureSourcePath(sourceKey, featureId) {
  if (sourceKey === "cluster") {
    if (/^CL-U/.test(featureId)) return "web/app.js";
    if (/^CL-A0[3-5]$/.test(featureId)) return "scripts/auth_delivery_service.cjs";
    if (/^CL-A06$/.test(featureId)) return "scripts/auth_mfa.cjs";
    if (/^CL-A10$/.test(featureId)) return "scripts/auth_key_rotation_service.cjs";
    if (/^CL-A/.test(featureId)) return "scripts/auth_service.cjs";
    return "scripts/glamping_app_server.cjs";
  }
  if (/^V2-C0[1-9]$/.test(featureId)) return "scripts/gyeongnam_glamping_crawl.cjs";
  if (/^V2-F0[12]$/.test(featureId)) return "scripts/traffic_sources_probe.cjs";
  if (/^V2-F0[34]$/.test(featureId)) return "scripts/yeogi_import_parser.cjs";
  if (/^V2-F0[567]$/.test(featureId)) return "web/app.js";
  if (/^V2-E0[1-3]$/.test(featureId)) return "scripts/tourism_collector.cjs";
  return "scripts/glamping_app_server.cjs";
}

function ledgerRecord({ id, sourceKey, kind, value, sourcePath, method = null, featureId = "", notes = "" }) {
  const source = SOURCE_REFS[sourceKey];
  const domain = domainFor(value, featureId);
  const decision = decisionFor(sourceKey, value, featureId, kind);
  const governance = governanceFor(domain);
  return {
    id,
    inventoryKind: kind,
    domain,
    source: source.name,
    sourceCommit: source.commit,
    sourcePath,
    role: rolesFor(domain, value),
    routeOrScreen: { kind, method, value },
    v2Conflict: false,
    decision,
    decisionRationale: decisionRationaleFor(sourceKey, decision, value),
    v2PriorityReason: sourceKey === "v2"
      ? "V2 input, output, API, calculation and companyId behavior is canonical."
      : "V2 behavior remains canonical; only additive Cluster behavior may be ported behind a gate.",
    targetStage: stageFor(domain, decision, featureId),
    featureFlag: flagFor(domain, decision, value, featureId),
    freshDataInputs: freshInputsFor(domain, decision),
    tests: testsFor(domain, decision),
    releaseGate: releaseGateFor(domain, decision),
    notes: `${decisionRationaleFor(sourceKey, decision, value)} ${notes}`.trim(),
    owner: governance.owner,
    approver: governance.approver
  };
}

function featureFlags() {
  const rollback = "set false, drain new work, preserve V2 route and discard no evidence";
  const rows = [
    ["V2_V3_UI_ENABLED", "FE", "PO", [], ["business", "admin"], 10, ["ui-error-rate", "api-p95"]],
    ["V2_INTEGRATION_AUTH_ENABLED", "SE", "SO", [], ["public", "business", "admin"], 20, ["login-success", "auth-deny-rate"]],
    ["V2_INTEGRATION_ENTITLEMENTS_ENABLED", "BE", "PO", ["V2_INTEGRATION_AUTH_ENABLED"], ["business", "admin"], 30, ["entitlement-deny-rate"]],
    ["V2_INTEGRATION_FRESH_COMPANY_ENABLED", "DE", "DGO", [], ["admin", "system-worker"], 40, ["coverage", "companyId-collision"]],
    ["V2_INTEGRATION_FRESH_OBSERVATION_ENABLED", "DE", "DGO", ["V2_INTEGRATION_FRESH_COMPANY_ENABLED"], ["admin", "system-worker"], 50, ["success-rate", "missing-rate", "logical-duplicate"]],
    ["V2_INTEGRATION_RELIABILITY_ENABLED", "DE", "DGO", ["V2_INTEGRATION_FRESH_OBSERVATION_ENABLED"], ["admin"], 60, ["freshness", "coverage"]],
    ["V2_INTEGRATION_LOCATION_CARD_ENABLED", "DE", "PO", ["V2_INTEGRATION_RELIABILITY_ENABLED"], ["business", "admin"], 70, ["freshness", "api-p95"]],
    ["V2_INTEGRATION_MAP_RANKING_ENABLED", "FE", "PO", ["V2_INTEGRATION_FRESH_OBSERVATION_ENABLED"], ["business", "admin"], 80, ["api-p95", "ui-error-rate"]],
    ["V2_INTEGRATION_BUSINESS_REPORT_ENABLED", "DE", "PO", ["V2_INTEGRATION_FRESH_OBSERVATION_ENABLED"], ["business", "admin"], 90, ["coverage", "freshness", "api-p95"]],
    ["V2_INTEGRATION_STRATEGY_ENABLED", "DE", "PO", ["V2_INTEGRATION_BUSINESS_REPORT_ENABLED"], ["business", "admin"], 100, ["lineage-completeness"]],
    ["V2_INTEGRATION_EXECUTION_ENABLED", "BE", "PO", ["V2_INTEGRATION_STRATEGY_ENABLED"], ["business", "admin"], 110, ["write-api-p95"]],
    ["V2_INTEGRATION_RETROSPECTIVE_ENABLED", "DE", "PO", ["V2_INTEGRATION_EXECUTION_ENABLED"], ["business", "admin"], 120, ["lineage-completeness"]],
    ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED", "DE", "DGO", [], ["admin", "system-worker"], 130, ["quota-use", "provider-cost", "worker-throughput"]],
    ["V2_CONNECTOR_NAVER_TREND_REAL_ENABLED", "DE", "DGO", ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["system-worker"], 140, ["quota-use", "provider-cost"]],
    ["V2_CONNECTOR_NAVER_SEARCHAD_REAL_ENABLED", "DE", "DGO", ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["system-worker"], 150, ["quota-use", "provider-cost"]],
    ["V2_CONNECTOR_SNS_REAL_ENABLED", "DE", "DGO", ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["system-worker"], 160, ["quota-use", "provider-cost"]],
    ["V2_CONNECTOR_OTA_REAL_ENABLED", "DE", "DGO", ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["system-worker"], 170, ["quota-use", "provider-cost"]],
    ["V2_INTEGRATION_SCHEDULER_ENABLED", "DE", "DGO", ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["system-worker"], 180, ["worker-throughput", "success-rate"]],
    ["V2_INTEGRATION_PLATFORM_CORE_ENABLED", "BE", "PO", [], ["business", "admin"], 185, ["read-api-p95", "write-api-p95"]],
    ["V2_INTEGRATION_IMPORT_EXPORT_ENABLED", "BE", "SO", ["V2_INTEGRATION_AUTH_ENABLED", "V2_INTEGRATION_ENTITLEMENTS_ENABLED"], ["business", "admin"], 190, ["write-api-p95", "security-rejection-rate"]],
    ["V2_INTEGRATION_RELEASE_OPERATIONS_ENABLED", "SRE", "RM", ["V2_INTEGRATION_PLATFORM_CORE_ENABLED", "V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"], ["admin"], 195, ["read-api-p95", "denylist-access"]]
  ];
  const production = rows.map(([name, owner, approver, dependsOn, targetRoles, rolloutOrder, observedMetrics]) => ({
    name,
    scope: "production-candidate",
    default: false,
    owner,
    approver,
    dependsOn,
    targetRoles,
    rolloutOrder,
    observedMetrics,
    approvalRoles: [approver],
    nonFlagRequirements: [],
    rollback
  }));
  const providerApprovalRoles = ["PO", "ProviderOps", "SO", "Finance"];
  const collectionGates = [
    {
      name: "freshCollection.enabled", owner: "DE", approver: "PO", approvalRoles: ["PO", "RM"],
      dependsOn: ["V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED"],
      nonFlagRequirements: ["fresh-store-schema", "deny-guard", "empty-store-proof"],
      targetRoles: ["collector-admin"], rolloutOrder: 200,
      observedMetrics: ["denylist-access", "logical-duplicate-rate", "provider-cost"],
      rollback: "issue zero new leases, set every child collection flag false, and preserve succeeded fresh evidence"
    },
    {
      name: "freshCollection.quick", owner: "DE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.enabled"], nonFlagRequirements: ["provider-approval"],
      targetRoles: ["collector-worker"], rolloutOrder: 210,
      observedMetrics: ["coverage", "success-rate", "provider-cost"],
      rollback: "open the quick provider circuit and cancel queued quick work"
    },
    {
      name: "freshCollection.detail", owner: "DE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.quick"], nonFlagRequirements: ["atomic-task-checkpoint", "timeout-guard"],
      targetRoles: ["detail-worker"], rolloutOrder: 220,
      observedMetrics: ["coverage", "missing-rate", "worker-throughput"],
      rollback: "open the detail circuit and stop after active leases expire"
    },
    {
      name: "freshCollection.leadtime", owner: "DE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.detail"], nonFlagRequirements: ["W=3-schedule"],
      targetRoles: ["leadtime-worker"], rolloutOrder: 230,
      observedMetrics: ["coverage", "freshness-compliance", "logical-duplicate-rate"],
      rollback: "cancel future leadtime observations and preserve succeeded observations"
    },
    {
      name: "freshCollection.ota", owner: "PIE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.quick"], nonFlagRequirements: ["provider-specific-approval"],
      targetRoles: ["ota-worker"], rolloutOrder: 240,
      observedMetrics: ["coverage", "provider-cost", "provider-quota"],
      rollback: "open each affected OTA provider circuit"
    },
    {
      name: "freshCollection.tourism", owner: "DE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.enabled"],
      nonFlagRequirements: ["46-region-code-verification", "approved-static-allowlist"],
      targetRoles: ["tourism-worker"], rolloutOrder: 250,
      observedMetrics: ["coverage", "freshness-compliance", "static-allowlist-violation"],
      rollback: "open the tourism source circuit and prohibit cache writes"
    },
    {
      name: "freshCollection.searchVolume", owner: "SPE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.enabled"],
      nonFlagRequirements: ["K=598-manifest", "SearchAd-and-Trend-approval"],
      targetRoles: ["signal-worker"], rolloutOrder: 260,
      observedMetrics: ["coverage", "provider-quota", "provider-cost"],
      rollback: "open the affected search-volume provider circuit"
    },
    {
      name: "freshCollection.sns", owner: "SPE", approver: "PO", approvalRoles: providerApprovalRoles,
      dependsOn: ["freshCollection.enabled"], nonFlagRequirements: ["K=598-manifest", "SNS-provider-approval"],
      targetRoles: ["signal-worker"], rolloutOrder: 270,
      observedMetrics: ["coverage", "provider-quota", "provider-cost"],
      rollback: "open the SNS provider circuit"
    }
  ].map((flag) => ({
    scope: "production-provider-zero-limit-gate",
    default: false,
    ...flag,
    approvalRoles: [...flag.approvalRoles]
  }));
  const preview = ["V2_INTEGRATION_COMPANY_ENABLED", "V2_INTEGRATION_OBSERVATION_ENABLED"].map((name, index) => ({
    name,
    scope: "contract-preview-test-only",
    allowedEnvironments: ["test"],
    default: false,
    owner: "BE",
    approver: "QA",
    dependsOn: [],
    targetRoles: ["admin-test-fixture"],
    rolloutOrder: -20 + index,
    observedMetrics: ["contract-parity"],
    approvalRoles: ["QA"],
    nonFlagRequirements: ["NODE_ENV=test", "contract-preview-purpose", "approved-fixture-root"],
    rollback: "unset flag; non-test environments already fail closed"
  }));
  return [...preview, ...production, ...collectionGates];
}

function collectionBudget() {
  const retryPolicy = {
    disabledRealRetryCount: 0,
    schedulerExecutionMax: 2,
    providerCallsPerSchedulerExecutionMax: 3,
    providerCallsPerTaskHardMax: 6,
    immediate429DelaysMs: [1200, 2400],
    requestTimeoutMs: 15000,
    rescheduleDelaySeconds: { rateLimit: 3600, networkOrHttp5xx: 7200, providerQuota: 86400 },
    nonRetryable: ["HTTP 401", "HTTP 403", "schema mismatch", "checksum mismatch", "denylist access"],
    zeroQuotaAutomaticRescheduleAllowed: false,
    hardMaxRule: "provider-specific hardMaxCalls is absolute; enable is prohibited if retry configuration can exceed it"
  };
  const stopPolicy = {
    action: "set new lease issuance to zero, open the provider circuit, and persist the stop reason",
    conditions: {
      quotaExceededEventsGte: 1,
      logicalDuplicateEventsGte: 1,
      companyIdCollisionEventsGte: 1,
      denylistAccessEventsGte: 1,
      staticAllowlistViolationEventsGte: 1,
      costRule: "approvedCapKRW=0 requires accruedCostKRW=0; otherwise stop at accruedCostKRW >= approvedCapKRW",
      successRateBelowPercentAfterMinimumSample: 95,
      readApiP95AboveMs: 1000,
      writeApiP95AboveMs: 1500,
      workerThroughputBelowTasksPerMinute: 22.5
    }
  };
  const resumePolicy = {
    automaticResumeCount: 0,
    requiredChecks: ["incident root cause", "fix commit", "provider quota balance", "provider cost balance", "denylist counter = 0"],
    checker: "RM",
    approver: "PO",
    createNewRunId: true,
    skipSucceededIdempotencyKeys: true,
    expiredCollectingLeaseToQueuedOnly: true,
    failedTaskAttemptCountMustBeBelow: 2,
    legacyCursorOrIdentityRestoreAllowed: false
  };
  const common = {
    currency: "KRW",
    fixedFeeKRW: 0,
    unitCostKRW: 0,
    expectedCostKRW: 0,
    hardMaxCostKRW: 0,
    billingUnitRequests: 1,
    retryReserve: 0,
    approvedCapKRW: 0,
    realRequestLimit: 0,
    approvers: ["PO", "ProviderOps", "SO", "Finance"],
    approvalStatus: "frozen-disabled-until-provider-and-finance-approval",
    retryPolicy,
    stopPolicy,
    resumePolicy
  };
  return [
    { id: "quick", provider: "Naver Place web surface", owner: "DE", sourceAutomaticRetries: 0, targetUnit: "region query", targetCount: 46, approvedTargetCount: 0, expectedCalls: 46, hardMaxCalls: 46, expectedSeconds: 6624, hardMaxSeconds: 6624, rateLimitPerMinute: 0, dailyQuota: 0, formula: "R=46; one regional main request per target", ...common },
    { id: "detail", provider: "Naver Place and Booking GraphQL", owner: "DE", sourceAutomaticRetries: 0, targetUnit: "company", targetCount: 460, approvedTargetCount: 0, expectedCalls: 17480, hardMaxCalls: 252080, expectedSeconds: 34960, hardMaxSeconds: 504160, rateLimitPerMinute: 0, dailyQuota: 0, formula: "R=46,P=10,D=460,T=7; expected=38D; hard=D*(68+80*(T-1))", ...common },
    { id: "ota-direct", provider: "NOL, Goodchoice, Ddnayo", owner: "PIE", sourceAutomaticRetries: 0, targetUnit: "region query", targetCount: 46, approvedTargetCount: 0, expectedCalls: 230, hardMaxCalls: 230, expectedSeconds: 460, hardMaxSeconds: 460, rateLimitPerMinute: 0, dailyQuota: 0, formula: "R=46; 5R (NOL 2 + Goodchoice 1 + Ddnayo 2)", ...common },
    { id: "ota-generic", provider: "unselected generic OTA provider", owner: "PIE", sourceAutomaticRetries: 5, targetUnit: "company", targetCount: 460, approvedTargetCount: 0, expectedCalls: 460, hardMaxCalls: 2760, expectedSeconds: 920, hardMaxSeconds: 5520, rateLimitPerMinute: 0, dailyQuota: 0, formula: "D=460; nominal=D; connector plus scheduler hard max=6D", ...common },
    { id: "leadtime", provider: "Naver Booking repeated detail", owner: "DE", sourceAutomaticRetries: 0, targetUnit: "representative company wave", targetCount: 138, approvedTargetCount: 0, expectedCalls: 1104, hardMaxCalls: 9384, expectedSeconds: 2208, hardMaxSeconds: 18768, calendarDays: 13, rateLimitPerMinute: 0, dailyQuota: 0, formula: "L=46,W=3 at D-14/D-7/D-1; expected=L*W*8; hard=L*W*68", ...common },
    { id: "tourism", provider: "data.go.kr 15101972/15152138/15151365", owner: "DE", sourceAutomaticRetries: 0, targetUnit: "region-month-source", targetCount: 138, verifiedCodeTargetCount: 111, approvedTargetCount: 0, expectedCalls: 138, hardMaxCalls: 138, expectedSeconds: 276, hardMaxSeconds: 2070, rateLimitPerMinute: 0, dailyQuota: 0, formula: "R=46,M=1,S=3; R*M*S; 9 codes and region map remain gated", ...common },
    { id: "search-volume-searchad", provider: "Naver SearchAd keyword tool", owner: "SPE", sourceAutomaticRetries: 5, targetUnit: "keyword", targetCount: 598, approvedTargetCount: 0, expectedCalls: 598, hardMaxCalls: 3588, expectedSeconds: 1196, hardMaxSeconds: 7176, rateLimitPerMinute: 0, dailyQuota: 0, formula: "E=0,R=46,U=3,D=460,K=598; nominal=K; hard=6K", ...common },
    { id: "search-volume-trend", provider: "Naver DataLab trend", owner: "SPE", sourceAutomaticRetries: 5, targetUnit: "keyword", targetCount: 598, approvedTargetCount: 0, expectedCalls: 598, hardMaxCalls: 3588, expectedSeconds: 1196, hardMaxSeconds: 7176, rateLimitPerMinute: 0, dailyQuota: 0, formula: "E=0,R=46,U=3,D=460,K=598; nominal=K; hard=6K", ...common },
    { id: "sns", provider: "unselected generic SNS provider", owner: "SPE", sourceAutomaticRetries: 5, targetUnit: "keyword", targetCount: 598, approvedTargetCount: 0, expectedCalls: 598, hardMaxCalls: 3588, expectedSeconds: 1196, hardMaxSeconds: 7176, rateLimitPerMinute: 0, dailyQuota: 0, formula: "E=0,R=46,U=3,D=460,K=598; nominal=K; hard=6K", ...common }
  ];
}

function acceptanceMetrics() {
  return [
    { id: "coverage", numerator: "unique targets with valid required fields and lineage", denominator: "frozen target count for the collection category", window: "each collection wave", minimumSample: 30, warning: "<98%", stop: "<95%", approver: ["QA", "PO"] },
    { id: "success-rate", numerator: "succeeded terminal tasks", denominator: "succeeded plus failed terminal tasks", window: "rolling 24h", minimumSample: 100, warning: "<98%", stop: "<95%", approver: ["QA", "RM"] },
    { id: "missing-rate", numerator: "null, empty, or schema-invalid required-field cells", denominator: "expected required-field cells", window: "each collection wave", minimumSample: 300, warning: ">2%", stop: ">5%", approver: ["DGO", "QA"] },
    { id: "logical-duplicate-rate", numerator: "second-or-later write attempts for the same logical key, including rejected attempts", denominator: "valid write attempts", window: "entire run", minimumSample: 1, warning: ">0", stop: ">0", allowedCount: 0, approver: ["DGO", "PO"] },
    { id: "companyId-collision", numerator: "identity-to-multiple-companyId or conflicting-signature-to-one-companyId events", denominator: "identity mapping write attempts", window: "entire run", minimumSample: 1, warning: ">0", stop: ">0", allowedCount: 0, approver: ["DGO", "PO"] },
    { id: "freshness-compliance", numerator: "publish-target records inside the category freshness SLA", denominator: "publish-target records in the wave", window: "each collection wave", minimumSample: 30, warning: "<98%", stop: "<95%", approver: ["PO", "QA"], thresholds: { operationalMaxHours: 24, signalMaxHours: 168, tourismMaxHours: 168, tourismMaxClosedMonthLagExclusive: 1 } },
    { id: "read-api-p95", numerator: "latency sample at sorted ascending index ceil(0.95*N)", denominator: "N = completed read API requests", window: "rolling 15m", minimumSample: 500, warning: ">500ms", stop: ">1000ms", approver: ["APO", "RM"] },
    { id: "write-api-p95", numerator: "latency sample at sorted ascending index ceil(0.95*N)", denominator: "N = completed enqueue/write API requests", window: "rolling 15m", minimumSample: 200, warning: ">750ms", stop: ">1500ms", approver: ["APO", "RM"] },
    { id: "worker-throughput", numerator: "succeeded tasks", denominator: "active worker minutes", window: "rolling 30m", minimumSample: 100, warning: "<27 tasks/min", stop: "<22.5 tasks/min", approver: ["DE", "RM"] },
    { id: "provider-cost", numerator: "accrued provider cost KRW", denominator: "approved provider cap KRW", window: "provider billing sample and collection wave", minimumSample: 1, warning: ">=80%", stop: ">=100%", approver: ["Finance", "PO"], zeroDenominatorPolicy: "calls=0 and cost=0 only" },
    { id: "provider-quota", numerator: "completed provider calls", denominator: "approved daily request quota", window: "KST calendar day 00:00-24:00", minimumSample: 1, warning: ">=70%", stop: ">=90%", approver: ["ProviderOps", "RM"], zeroDenominatorPolicy: "calls=0 only" },
    { id: "quota-exceeded", numerator: "quota rejection or quota-exceeded events", denominator: "provider call attempts", window: "KST calendar day 00:00-24:00", minimumSample: 1, warning: ">0", stop: ">0", allowedCount: 0, approver: ["ProviderOps", "PO"] },
    { id: "denylist-access", numerator: "denied legacy read/write/stat/open attempts", denominator: "integrated runtime filesystem attempts", window: "process lifetime", minimumSample: 1, warning: ">0", stop: ">0", allowedCount: 0, approver: ["SO", "RM"] },
    { id: "static-allowlist-violation", numerator: "non-allowlisted static asset attempts", denominator: "integrated runtime static asset attempts", window: "process lifetime", minimumSample: 1, warning: ">0", stop: ">0", allowedCount: 0, approver: ["SO", "RM"] }
  ];
}

function staticAssets() {
  return {
    allowlist: [
      {
        id: "kostat-2013-municipalities-geo-simple",
        path: "web/assets/korea_municipalities.geojson",
        runtimePath: "web/assets/korea_municipalities.geojson",
        source: "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2013/json/skorea_municipalities_geo_simple.json",
        attribution: "KOSTAT via southkorea/southkorea-maps",
        sourceUrl: "https://github.com/southkorea/southkorea-maps/blob/master/kostat/2013/json/skorea_municipalities_geo_simple.json",
        version: "KOSTAT-2013; WGS84; 1%-simplified",
        license: "KOSTAT: free to share or remix; upstream attribution retained",
        checksum: "sha256:1cd70bc95ec6ce5cbce1a98ea49fe7a81bdaada98a536b075f25c471e998aae8",
        canonicalGitBlobSha256: "E0CF2030DC893F40B6E97DFA7183D47C2197EA74551B041EABFD7BC318A74285",
        runtimeWorkingTreeSha256: "1CD70BC95EC6CE5CBCE1A98EA49FE7A81BDAADA98A536B075F25C471E998AAE8",
        gitBlobSha1: "10242ab3557773d08b05ab8985fc7e192ae331c6",
        approver: ["DGO", "SO"]
      }
    ],
    quarantine: [
      { runtimePath: "web/data/tourism_region_map.json", sha256: "6C82E7C57E130C22C78656E09856E9AAA8B6110AB5D677BD28132A9DFCF19F94", reason: "upstream URL/license absent and 9 of 46 codes unverified", runtimeAllowed: false },
      { runtimePath: "web/data/location_dictionary.json", sha256: "B4F6565D429CF166AAE1AC594D5700B820C9E32FA22ABBA425C67E71ABEBE4B0", reason: "declared workbook and license absent", runtimeAllowed: false }
    ],
    policy: "Only exact allowlist path and checksum pairs are readable by integrated runtime."
  };
}

function legacyDataDenylist() {
  return [
    { id: "v2-service", identifier: "service:glamping-datalab-v2", pattern: "/var/data/{outputs,company_master,customer_db,history,tourism_data,config}/**" },
    { id: "v2-disk", identifier: "disk:glamping-datalab-v2-data", pattern: "/var/data/**" },
    { id: "cluster-service", identifier: "service:glamping-cluster-app:srv-d8jcapmrnols738cg40g", pattern: "/var/data/**" },
    { id: "cluster-disk", identifier: "disk:glamping-data", pattern: "/var/data/{db,backups,outputs,config}/**" },
    { id: "repo-outputs", identifier: "repository", pattern: "outputs/**" },
    { id: "repo-local-config", identifier: "repository", pattern: "config/**" },
    { id: "legacy-company", identifier: "preview-source", pattern: "company_master/companies.json" },
    { id: "legacy-observations", identifier: "preview-source", pattern: "history/observations.jsonl" },
    { id: "legacy-runs", identifier: "preview-source", pattern: "outputs/**/{manifest.json,*.csv}" },
    { id: "legacy-tourism-cache", identifier: "preview-source", pattern: "tourism_data/{cache/**,collections.jsonl}" },
    { id: "legacy-auth-session-secret", identifier: "legacy-runtime", pattern: "{b2b_members.json,sessions/**,*secret*,*token*,traffic_api_keys.local.json}" }
  ];
}

function providerApprovalGates() {
  const groups = [
    ["Naver Place quick", ["quick"]],
    ["Naver Booking detail and leadtime", ["detail", "leadtime"]],
    ["NOL, Goodchoice, Ddnayo direct OTA", ["ota-direct"]],
    ["generic OTA provider", ["ota-generic"]],
    ["data.go.kr tourism APIs", ["tourism"]],
    ["Naver SearchAd", ["search-volume-searchad"]],
    ["Naver DataLab", ["search-volume-trend"]],
    ["generic SNS provider", ["sns"]]
  ];
  return groups.map(([provider, budgetIds]) => ({
    provider,
    budgetIds,
    currentRealRequestLimit: 0,
    currentApprovedCapKRW: 0,
    nextApprovers: ["PO", "ProviderOps", "SO", "Finance"],
    consulted: ["DGO", "QA", "Legal"],
    stage224Blocker: false,
    reason: "Risk is closed by a numeric zero-call/zero-cost gate; actual collection remains blocked."
  }));
}

function calculateBlockers(result) {
  const blockers = [];
  const add = (code, detail) => blockers.push({ code, detail });
  const clusterItems = result.ledger.filter((item) => item.source === SOURCE_REFS.cluster.name);
  const missingRequired = result.ledger.filter((item) => REQUIRED_LEDGER_FIELDS.some(
    (field) => !Object.prototype.hasOwnProperty.call(item, field)
      || item[field] === undefined
      || item[field] === ""
  ));
  if (missingRequired.length > 0) add("ledger-required-field-missing", missingRequired.map((item) => item.id));
  const allowedTargetStages = new Set([...Array.from({ length: 11 }, (_, index) => String(224 + index)), "post-234"]);
  const invalidLedgerContracts = result.ledger.filter((item) =>
    !DECISIONS.has(item.decision)
    || !allowedTargetStages.has(String(item.targetStage))
    || !Array.isArray(item.role)
    || item.role.length === 0
    || !Array.isArray(item.tests)
    || item.tests.length === 0
    || !item.releaseGate
    || item.freshDataInputs?.policy !== "empty-integrated-store-fresh-only"
    || item.freshDataInputs?.legacyRuntimeReadAllowed !== false
    || item.freshDataInputs?.migrationAllowed !== false
    || item.freshDataInputs?.backfillAllowed !== false
    || item.freshDataInputs?.dualWriteAllowed !== false
  );
  if (invalidLedgerContracts.length > 0) add("ledger-contract-incomplete", invalidLedgerContracts.map((item) => item.id));
  const classificationRuleMismatches = result.ledger.filter((item) => {
    const sourceKey = item.source === SOURCE_REFS.v2.name
      ? "v2"
      : (item.source === SOURCE_REFS.cluster.name ? "cluster" : "");
    if (!sourceKey) return true;
    const featureId = item.inventoryKind === "curated-business-feature" ? item.id : "";
    const expectedDomain = domainFor(item.routeOrScreen?.value, featureId);
    const expectedDecision = decisionFor(sourceKey, item.routeOrScreen?.value, featureId, item.inventoryKind);
    const expectedGovernance = governanceFor(expectedDomain);
    return item.domain !== expectedDomain
      || item.decision !== expectedDecision
      || String(item.targetStage) !== String(stageFor(expectedDomain, expectedDecision, featureId))
      || item.featureFlag !== flagFor(expectedDomain, expectedDecision, item.routeOrScreen?.value, featureId)
      || item.owner !== expectedGovernance.owner
      || item.approver !== expectedGovernance.approver
      || JSON.stringify(item.role) !== JSON.stringify(rolesFor(expectedDomain, item.routeOrScreen?.value))
      || JSON.stringify(item.freshDataInputs) !== JSON.stringify(freshInputsFor(expectedDomain, expectedDecision))
      || JSON.stringify(item.tests) !== JSON.stringify(testsFor(expectedDomain, expectedDecision))
      || item.releaseGate !== releaseGateFor(expectedDomain, expectedDecision);
  });
  if (classificationRuleMismatches.length > 0) {
    add("ledger-classification-rule-mismatch", classificationRuleMismatches.map((item) => item.id));
  }
  const unclassified = clusterItems.filter((item) => !DECISIONS.has(item.decision) || !item.targetStage || !item.owner || !item.approver);
  if (unclassified.length > 0) add("cluster-classification-incomplete", unclassified.map((item) => item.id));
  const excludedSourceMismatch = clusterItems.filter((item) => item.sourceReviewStatus === "제외" && item.decision !== "exclude");
  if (excludedSourceMismatch.length > 0) add("source-exclusion-policy-mismatch", excludedSourceMismatch.map((item) => item.id));
  const ungatedPorts = clusterItems.filter((item) => item.decision === "port" && !item.featureFlag);
  if (ungatedPorts.length > 0) add("cluster-port-without-feature-flag", ungatedPorts.map((item) => item.id));

  const clusterFeatures = clusterItems.filter((item) => item.inventoryKind === "curated-business-feature");
  const clusterFeatureIds = clusterFeatures.map((item) => item.id).sort();
  if (JSON.stringify(clusterFeatureIds) !== JSON.stringify([...FROZEN_CURATED_FEATURE_IDS.cluster].sort())) {
    add("cluster-curated-feature-id-set-mismatch", clusterFeatureIds);
  }
  const v2FeatureIds = result.ledger
    .filter((item) => item.source === SOURCE_REFS.v2.name && item.inventoryKind === "curated-business-feature")
    .map((item) => item.id)
    .sort();
  if (JSON.stringify(v2FeatureIds) !== JSON.stringify([...FROZEN_CURATED_FEATURE_IDS.v2].sort())) {
    add("v2-curated-feature-id-set-mismatch", v2FeatureIds);
  }
  const clusterFeatureCounts = clusterFeatures.reduce((counts, item) => {
    counts[item.decision] = (counts[item.decision] || 0) + 1;
    return counts;
  }, {});
  if (
    clusterFeatures.length !== 77
    || clusterFeatureCounts.port !== 60
    || clusterFeatureCounts.defer !== 7
    || clusterFeatureCounts.exclude !== 10
  ) add("cluster-curated-decision-count-mismatch", clusterFeatureCounts);
  const fixedDecisionMismatches = clusterFeatures.filter((item) => {
    if (/^CL-X0[1-7]$/.test(item.id)) return item.decision !== "defer" || item.targetStage !== "post-234";
    if (/^(?:CL-C10|CL-Z\d{2})$/.test(item.id)) return item.decision !== "exclude" || item.targetStage !== "224";
    return false;
  });
  if (fixedDecisionMismatches.length > 0) {
    add("cluster-curated-fixed-decision-mismatch", fixedDecisionMismatches.map((item) => item.id));
  }

  const sourcesByName = new Map(Object.values(SOURCE_REFS).map((source) => [source.name, source]));
  const invalidSourceRefs = [];
  const sourceFileCache = new Map();
  for (const item of result.ledger) {
    const source = sourcesByName.get(item.source);
    const rawSourcePath = String(item.sourcePath || "");
    const pathMatch = rawSourcePath.match(/^(.*):(\d+)$/);
    const dynamicAudit = /:dynamic-route-audit$/.test(rawSourcePath);
    const sourcePath = pathMatch ? pathMatch[1] : rawSourcePath;
    if (!source || item.sourceCommit !== source.commit || !sourcePath || dynamicAudit) {
      invalidSourceRefs.push(item.id);
      continue;
    }
    const cacheKey = `${item.source}|${sourcePath}`;
    if (!sourceFileCache.has(cacheKey)) {
      try {
        sourceFileCache.set(cacheKey, String(readRef(source, sourcePath)));
      } catch {
        sourceFileCache.set(cacheKey, null);
      }
    }
    const sourceText = sourceFileCache.get(cacheKey);
    if (sourceText === null) {
      invalidSourceRefs.push(item.id);
      continue;
    }
    if (pathMatch && (Number(pathMatch[2]) < 1 || Number(pathMatch[2]) > sourceText.split(/\r?\n/).length)) {
      invalidSourceRefs.push(item.id);
    }
  }
  if (invalidSourceRefs.length > 0) add("source-ref-or-line-invalid", invalidSourceRefs);
  const changedSources = Object.entries(result.sourceIntegrity || {})
    .filter(([, integrity]) => !integrity.headUnchanged || !integrity.worktreeStatusUnchanged)
    .map(([source]) => source);
  if (changedSources.length > 0) add("source-worktree-mutated-during-inventory", changedSources);

  for (const sourceKey of ["v2", "cluster"]) {
    const actual = result.inventoryReconciliation[sourceKey];
    const expected = FROZEN_INVENTORY_EXPECTED[sourceKey];
    const mismatches = Object.entries(expected).filter(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value));
    if (mismatches.length > 0) add(`${sourceKey}-inventory-count-mismatch`, mismatches);
    const embeddedExpected = result.inventoryReconciliation.frozenExpected?.[sourceKey];
    if (JSON.stringify(embeddedExpected) !== JSON.stringify(expected)) {
      add(`${sourceKey}-embedded-inventory-contract-mutated`, embeddedExpected);
    }
    const dynamicRoutesFromLedger = result.ledger
      .filter((item) => item.source === SOURCE_REFS[sourceKey].name && item.inventoryKind === "dynamic-handler")
      .map((item) => `${item.routeOrScreen.method} ${item.routeOrScreen.value}`)
      .sort();
    if (JSON.stringify([...(actual.dynamicRoutes || [])].sort()) !== JSON.stringify(dynamicRoutesFromLedger)) {
      add(`${sourceKey}-dynamic-route-ledger-mismatch`, dynamicRoutesFromLedger);
    }
  }
  const clusterHandlerConflicts = clusterItems.filter((item) =>
    ["handler-contract", "dynamic-handler"].includes(item.inventoryKind) && item.v2Conflict
  );
  const clusterHandlerConflictSet = clusterHandlerConflicts
    .map((item) => `${item.routeOrScreen.method} ${item.routeOrScreen.value}`)
    .sort();
  if (JSON.stringify(clusterHandlerConflictSet) !== JSON.stringify([...FROZEN_CLUSTER_HANDLER_CONFLICTS].sort())) {
    add("handler-conflict-set-mismatch", clusterHandlerConflictSet);
  }
  const conflictDecisionMismatch = clusterHandlerConflicts.filter((item) => item.decision !== "keep");
  if (conflictDecisionMismatch.length > 0) add("v2-priority-conflict-decision-mismatch", conflictDecisionMismatch.map((item) => item.id));

  if (["migrationCount", "backfillCount", "dualWriteCount", "legacyRuntimeReadCount"].some((key) => result.dataPolicy[key] !== 0)) {
    add("legacy-data-policy-nonzero", result.dataPolicy);
  }
  if (result.dataPolicy.stage223PreviewRuntimeMigrationPath !== false) add("preview-runtime-migration-enabled", true);

  const flagNames = result.featureFlags.map((flag) => flag.name);
  const flagsByName = new Map(result.featureFlags.map((flag) => [flag.name, flag]));
  const duplicateFlagNames = flagNames.filter((name, index) => flagNames.indexOf(name) !== index);
  if (duplicateFlagNames.length > 0) add("feature-flag-name-duplicate", [...new Set(duplicateFlagNames)]);
  const badFlags = result.featureFlags.filter((flag) =>
    flag.default !== false
    || !flag.owner
    || !flag.approver
    || !Array.isArray(flag.approvalRoles)
    || flag.approvalRoles.length === 0
    || !Array.isArray(flag.dependsOn)
    || !Array.isArray(flag.nonFlagRequirements)
    || !Array.isArray(flag.targetRoles)
    || flag.targetRoles.length === 0
    || !Number.isFinite(flag.rolloutOrder)
    || !Array.isArray(flag.observedMetrics)
    || flag.observedMetrics.length === 0
    || !flag.rollback
  );
  if (badFlags.length > 0) add("feature-flag-governance-incomplete", badFlags.map((flag) => flag.name));
  const unknownLedgerFlags = result.ledger
    .filter((item) => item.featureFlag && !flagsByName.has(item.featureFlag))
    .map((item) => `${item.id}->${item.featureFlag}`);
  if (unknownLedgerFlags.length > 0) add("ledger-unknown-feature-flag", unknownLedgerFlags);
  const duplicateRolloutOrders = result.featureFlags
    .filter((flag, index, flags) => flags.findIndex((candidate) => candidate.rolloutOrder === flag.rolloutOrder) !== index)
    .map((flag) => `${flag.name}:${flag.rolloutOrder}`);
  if (duplicateRolloutOrders.length > 0) add("feature-flag-rollout-order-duplicate", duplicateRolloutOrders);
  const unknownDependencies = result.featureFlags.flatMap((flag) =>
    flag.dependsOn.filter((dependency) => !flagsByName.has(dependency)).map((dependency) => `${flag.name}->${dependency}`)
  );
  if (unknownDependencies.length > 0) add("feature-flag-unknown-dependency", unknownDependencies);
  const nonPrecedingDependencies = result.featureFlags.flatMap((flag) =>
    flag.dependsOn
      .filter((dependency) => flagsByName.has(dependency) && flagsByName.get(dependency).rolloutOrder >= flag.rolloutOrder)
      .map((dependency) => `${flag.name}->${dependency}`)
  );
  if (nonPrecedingDependencies.length > 0) add("feature-flag-dependency-order-invalid", nonPrecedingDependencies);
  const visiting = new Set();
  const visited = new Set();
  let cycle = "";
  function visitFlag(name) {
    if (cycle || visited.has(name)) return;
    if (visiting.has(name)) {
      cycle = name;
      return;
    }
    visiting.add(name);
    for (const dependency of flagsByName.get(name)?.dependsOn || []) visitFlag(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of flagsByName.keys()) visitFlag(name);
  if (cycle) add("feature-flag-dependency-cycle", cycle);

  const placeholder = /(?:TBD|TODO|unknown|pending|미정)/i;
  const roleGlossary = result.roleGlossary || {};
  const invalidRoles = [];
  const validateRole = (role, location) => {
    const normalized = String(role || "").trim();
    if (!normalized || placeholder.test(normalized) || !roleGlossary[normalized] || placeholder.test(roleGlossary[normalized])) {
      invalidRoles.push(`${location}:${normalized || "<empty>"}`);
    }
  };
  for (const item of result.ledger) {
    validateRole(item.owner, `${item.id}.owner`);
    validateRole(item.approver, `${item.id}.approver`);
    if (item.owner === item.approver) invalidRoles.push(`${item.id}:owner-equals-approver`);
  }
  for (const flag of result.featureFlags) {
    validateRole(flag.owner, `${flag.name}.owner`);
    validateRole(flag.approver, `${flag.name}.approver`);
    for (const role of flag.approvalRoles || []) validateRole(role, `${flag.name}.approvalRoles`);
    if (flag.owner === flag.approver) invalidRoles.push(`${flag.name}:owner-equals-approver`);
  }
  for (const metric of result.acceptanceMetrics || []) {
    for (const role of metric.approver || []) validateRole(role, `${metric.id}.approver`);
  }
  for (const provider of result.collectionBudget?.providers || []) {
    validateRole(provider.owner, `${provider.id}.owner`);
    for (const role of provider.approvers || []) validateRole(role, `${provider.id}.approvers`);
  }
  for (const gate of result.providerApprovalGates || []) {
    for (const role of gate.nextApprovers || []) validateRole(role, `${gate.provider}.nextApprovers`);
    for (const role of gate.consulted || []) validateRole(role, `${gate.provider}.consulted`);
  }
  const expectedStages = Array.from({ length: 11 }, (_, index) => 224 + index);
  if (JSON.stringify((result.stageRaci || []).map((entry) => entry.stage)) !== JSON.stringify(expectedStages)) {
    add("stage-raci-range-mismatch", (result.stageRaci || []).map((entry) => entry.stage));
  }
  for (const entry of result.stageRaci || []) {
    if (!Array.isArray(entry.responsible) || entry.responsible.length === 0 || !entry.accountable
      || !Array.isArray(entry.consulted) || entry.consulted.length === 0
      || !Array.isArray(entry.informed) || entry.informed.length === 0) {
      invalidRoles.push(`stage${entry.stage}:incomplete-raci`);
      continue;
    }
    for (const role of entry.responsible) validateRole(role, `stage${entry.stage}.responsible`);
    validateRole(entry.accountable, `stage${entry.stage}.accountable`);
    for (const role of entry.consulted) validateRole(role, `stage${entry.stage}.consulted`);
    for (const role of entry.informed) validateRole(role, `stage${entry.stage}.informed`);
  }
  if (invalidRoles.length > 0) add("governance-role-unregistered-or-unresolved", invalidRoles);

  const unsafeProviders = result.collectionBudget.providers.filter((provider) =>
    provider.realRequestLimit !== 0
    || provider.dailyQuota !== 0
    || provider.unitCostKRW !== 0
    || provider.expectedCostKRW !== 0
    || provider.hardMaxCostKRW !== 0
    || provider.approvedCapKRW !== 0
    || !Array.isArray(provider.approvers)
    || provider.approvers.length < 4
  );
  if (unsafeProviders.length > 0) add("provider-zero-gate-open", unsafeProviders.map((provider) => provider.id));
  const providers = result.collectionBudget.providers;
  const providerTotals = providers.reduce((totals, provider) => ({
    expectedCalls: totals.expectedCalls + provider.expectedCalls,
    hardMaxCalls: totals.hardMaxCalls + provider.hardMaxCalls,
    expectedSeconds: totals.expectedSeconds + provider.expectedSeconds,
    hardMaxSeconds: totals.hardMaxSeconds + provider.hardMaxSeconds
  }), { expectedCalls: 0, hardMaxCalls: 0, expectedSeconds: 0, hardMaxSeconds: 0 });
  if (JSON.stringify(providerTotals) !== JSON.stringify({
    expectedCalls: 21252,
    hardMaxCalls: 275402,
    expectedSeconds: 49036,
    hardMaxSeconds: 559130
  })) add("provider-budget-total-mismatch", providerTotals);
  const badExecutionPolicies = providers.filter((provider) => {
    const retry = provider.retryPolicy || {};
    const stop = provider.stopPolicy?.conditions || {};
    const resume = provider.resumePolicy || {};
    return retry.disabledRealRetryCount !== 0
      || retry.schedulerExecutionMax !== 2
      || retry.providerCallsPerSchedulerExecutionMax !== 3
      || retry.providerCallsPerTaskHardMax !== 6
      || JSON.stringify(retry.immediate429DelaysMs) !== JSON.stringify([1200, 2400])
      || retry.requestTimeoutMs !== 15000
      || retry.rescheduleDelaySeconds?.rateLimit !== 3600
      || retry.rescheduleDelaySeconds?.networkOrHttp5xx !== 7200
      || retry.rescheduleDelaySeconds?.providerQuota !== 86400
      || retry.zeroQuotaAutomaticRescheduleAllowed !== false
      || stop.quotaExceededEventsGte !== 1
      || stop.logicalDuplicateEventsGte !== 1
      || stop.companyIdCollisionEventsGte !== 1
      || stop.denylistAccessEventsGte !== 1
      || stop.staticAllowlistViolationEventsGte !== 1
      || stop.successRateBelowPercentAfterMinimumSample !== 95
      || stop.readApiP95AboveMs !== 1000
      || stop.writeApiP95AboveMs !== 1500
      || stop.workerThroughputBelowTasksPerMinute !== 22.5
      || resume.automaticResumeCount !== 0
      || resume.checker !== "RM"
      || resume.approver !== "PO"
      || resume.createNewRunId !== true
      || resume.skipSucceededIdempotencyKeys !== true
      || resume.expiredCollectingLeaseToQueuedOnly !== true
      || resume.failedTaskAttemptCountMustBeBelow !== 2
      || resume.legacyCursorOrIdentityRestoreAllowed !== false;
  });
  if (badExecutionPolicies.length > 0) add("provider-execution-policy-incomplete", badExecutionPolicies.map((provider) => provider.id));
  const unresolvedApprovals = result.providerApprovalGates.filter((gate) =>
    gate.currentRealRequestLimit !== 0
    || gate.currentApprovedCapKRW !== 0
    || !["PO", "ProviderOps", "SO", "Finance"].every((role) => gate.nextApprovers.includes(role))
  );
  if (unresolvedApprovals.length > 0) add("provider-approval-gate-incomplete", unresolvedApprovals.map((gate) => gate.provider));

  const requiredMetricIds = [
    "coverage", "success-rate", "missing-rate", "logical-duplicate-rate", "companyId-collision",
    "freshness-compliance", "read-api-p95", "write-api-p95", "worker-throughput", "provider-cost",
    "provider-quota", "quota-exceeded", "denylist-access", "static-allowlist-violation"
  ];
  const metricsById = new Map((result.acceptanceMetrics || []).map((metric) => [metric.id, metric]));
  const missingMetrics = requiredMetricIds.filter((id) => !metricsById.has(id));
  if (missingMetrics.length > 0) add("acceptance-metric-missing", missingMetrics);
  const incompleteMetrics = (result.acceptanceMetrics || []).filter((metric) =>
    ["numerator", "denominator", "window", "warning", "stop"].some((field) =>
      !String(metric[field] ?? "").trim() || placeholder.test(String(metric[field]))
    )
    || !Number.isFinite(metric.minimumSample)
    || metric.minimumSample < 1
    || !Array.isArray(metric.approver)
    || metric.approver.length === 0
    || !/\d/.test(String(metric.warning))
    || !/\d/.test(String(metric.stop))
  );
  if (incompleteMetrics.length > 0) add("acceptance-metric-incomplete", incompleteMetrics.map((metric) => metric.id));
  for (const metricId of ["logical-duplicate-rate", "companyId-collision", "quota-exceeded", "denylist-access", "static-allowlist-violation"]) {
    if (metricsById.get(metricId)?.allowedCount !== 0) add("zero-tolerance-metric-open", metricId);
  }

  const allowlist = result.staticAssets?.allowlist || [];
  const quarantine = result.staticAssets?.quarantine || [];
  if (allowlist.length !== 1 || quarantine.length !== 2) {
    add("static-asset-list-count-mismatch", { allowlist: allowlist.length, quarantine: quarantine.length });
  }
  const badStaticAssets = [];
  for (const asset of allowlist) {
    const assetPath = path.join(ROOT, asset.path || "");
    try {
      if (!isCompleteStaticAssetAllowlistEntry(asset) || sha256File(assetPath) !== String(asset.checksum || "").toLowerCase()) {
        badStaticAssets.push(asset.id || asset.path);
      }
    } catch {
      badStaticAssets.push(asset.id || asset.path);
    }
  }
  if (badStaticAssets.length > 0) add("static-asset-verification-failed", badStaticAssets);

  const runtimeBlockedIdentifiers = new Set(DEFAULT_BLOCKED_SOURCE_IDENTIFIERS.map((value) => value.toLowerCase()));
  const uncoveredDenyIdentifiers = (result.legacyDataDenylist || [])
    .map((entry) => String(entry.identifier || "").toLowerCase())
    .filter((identifier) => !runtimeBlockedIdentifiers.has(identifier));
  if (uncoveredDenyIdentifiers.length > 0) add("denylist-identifier-not-runtime-enforced", [...new Set(uncoveredDenyIdentifiers)]);
  try {
    const guard = createIntegrationDataAccessGuard({
      projectRoot: ROOT,
      freshStoreRoot: path.join(ROOT, ".stage224-fresh-store-contract"),
      staticAssetAllowlist: allowlist,
      env: { NODE_ENV: "production" }
    });
    const freshPath = path.join(ROOT, ".stage224-fresh-store-contract", "probe.json");
    const allowedDenyIdentifiers = (result.legacyDataDenylist || [])
      .filter((entry) => guard.evaluate({ kind: "fresh-store", path: freshPath, sourceIdentifier: entry.identifier }).allowed)
      .map((entry) => entry.identifier);
    if (allowedDenyIdentifiers.length > 0) add("denylist-runtime-probe-allowed", allowedDenyIdentifiers);
  } catch (error) {
    add("runtime-data-guard-configuration-invalid", error.code || error.message);
  }
  if (result.runtimeAccessGuard?.expectedLegacyReadCount !== 0
    || result.runtimeAccessGuard?.expectedNonAllowlistedStaticReadCount !== 0) {
    add("runtime-access-zero-contract-open", result.runtimeAccessGuard);
  }

  const serverSource = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
  for (const marker of [
    "createIntegrationDataAccessGuard",
    "IS_PRODUCTION_RUNTIME",
    "V2_INTEGRATION_PREVIEW_PURPOSE",
    "V2_INTEGRATION_PREVIEW_FIXTURE_ROOT",
    "integrationPreviewFixtureAccessAllowed",
    "integrationPreviewRunCandidates",
    "integrationPreviewFixtureAccessAllowed([manifestPath]",
    "integrationPreviewFixtureAccessAllowed([filePath]",
    "availability: summarizeAvailabilityRows(rows)"
  ]) {
    if (!serverSource.includes(marker)) add("preview-fixture-guard-not-wired", marker);
  }
  const featureFlagSource = fs.readFileSync(path.join(ROOT, "scripts", "integration_feature_flags.cjs"), "utf8");
  if (!featureFlagSource.includes("env.RENDER") || !featureFlagSource.includes("env.RENDER_EXTERNAL_URL")) {
    add("preview-render-runtime-not-fail-closed", "integration_feature_flags.cjs");
  }
  for (const manifest of ["render.yaml", "render.persistent.yaml"]) {
    const manifestSource = fs.readFileSync(path.join(ROOT, manifest), "utf8");
    if (/^services\s*:/m.test(manifestSource) || !/^x-legacy-cluster-services\s*:/m.test(manifestSource)) {
      add("legacy-render-manifest-deployable", manifest);
    }
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (packageJson.name !== result.naming.packageName) add("package-name-mismatch", packageJson.name);
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  if (!readme.startsWith(`# ${result.naming.packageName}`)) add("readme-name-mismatch", readme.split(/\r?\n/, 1)[0]);

  const ledgerMarkdown = fs.existsSync(path.join(ROOT, "docs", "stage224_feature_ledger.md"))
    ? fs.readFileSync(path.join(ROOT, "docs", "stage224_feature_ledger.md"), "utf8")
    : "";
  if (!/Cluster는 port 60, defer 7,[\s\S]{0,30}exclude 10/.test(ledgerMarkdown) || !/31개 flag/.test(ledgerMarkdown)) {
    add("feature-ledger-markdown-stale", "curated decision or flag count marker mismatch");
  }
  const budgetMarkdown = fs.existsSync(path.join(ROOT, "docs", "stage224_fresh_collection_budget.md"))
    ? fs.readFileSync(path.join(ROOT, "docs", "stage224_fresh_collection_budget.md"), "utf8")
    : "";
  for (const marker of [
    "21,252", "275,402", "817.3분", "9,318.8분", "49,036초", "559,130초",
    "read API p95가 1,000ms 초과", "enqueue/write API p95가 1,500ms 초과",
    "static allowlist 항목: 1개"
  ]) {
    if (!budgetMarkdown.includes(marker)) add("fresh-budget-markdown-stale", marker);
  }
  return blockers;
}

function buildLedger() {
  for (const source of Object.values(SOURCE_REFS)) {
    runGit(source.repository, ["cat-file", "-e", `${source.commit}^{commit}`]);
  }
  const before = Object.fromEntries(Object.entries(SOURCE_REFS).map(([key, source]) => [key, {
    head: String(runGit(source.repository, ["rev-parse", "HEAD"])).trim(),
    status: String(runGit(source.repository, ["status", "--porcelain=v1"]))
  }]));

  const sourceTexts = {};
  for (const sourceKey of ["v2", "cluster"]) {
    sourceTexts[sourceKey] = Object.fromEntries(TEXT_SOURCE_FILES.map((sourcePath) => [
      sourcePath,
      String(readRef(SOURCE_REFS[sourceKey], sourcePath))
    ]));
  }
  const v3Inventory = JSON.parse(String(readRef(SOURCE_REFS.v3, "analysis/results/v3-001-source-inventory.json")));
  const featureRows = parseFeatureReview(String(readRef(SOURCE_REFS.v3, "docs/V3_SOURCE_FEATURE_REVIEW.md")));

  const evidence = {};
  const ledger = [];
  for (const sourceKey of ["v2", "cluster"]) {
    const combined = `${sourceTexts[sourceKey]["scripts/glamping_app_server.cjs"]}\n${sourceTexts[sourceKey]["web/app.js"]}`;
    const literalRoutes = collectStage221LiteralRoutes(combined);
    const canonicalLiterals = [...new Set(literalRoutes.map(normalizeRoute))].sort();
    const surveyRoutes = collectSurveyRoutes(combined);
    const expectedSurvey = v3Inventory.sources.find((source) => source.name === SOURCE_REFS[sourceKey].name)?.routes || [];
    const handlers = collectHandlerContracts(sourceTexts[sourceKey]["scripts/glamping_app_server.cjs"]);
    const dynamic = handlers.filter((contract) => contract.dynamic);
    evidence[sourceKey] = {
      stage221LiteralRawCount: literalRoutes.length,
      stage221LiteralCanonicalCount: canonicalLiterals.length,
      stage221TrailingSlashCollisionCount: literalRoutes.length - canonicalLiterals.length,
      v3SurveyCount: surveyRoutes.length,
      v3SurveyMatchesFrozenArtifact: JSON.stringify(surveyRoutes) === JSON.stringify(expectedSurvey),
      v3SurveyOnlyRoutes: surveyRoutes.filter((route) => !canonicalLiterals.includes(route)),
      handlerPathPatternCount: new Set(handlers.map((contract) => contract.path)).size,
      handlerMethodPathCount: handlers.length,
      dynamicRouteCount: dynamic.length,
      dynamicRoutes: dynamic.map((contract) => `${contract.method} ${contract.path}`)
    };

    literalRoutes.forEach((route, index) => ledger.push(ledgerRecord({
      id: `${sourceKey === "v2" ? "V2" : "CL"}-LIT-${String(index + 1).padStart(3, "0")}`,
      sourceKey,
      kind: "stage221-literal-route",
      value: route,
      sourcePath: sourcePathForRoute(sourceTexts[sourceKey], route),
      notes: "Raw quoted /api/ literal; may be a handler, client call, template, or sentinel."
    })));
    handlers.forEach((contract, index) => ledger.push(ledgerRecord({
      id: `${sourceKey === "v2" ? "V2" : "CL"}-HND-${String(index + 1).padStart(3, "0")}`,
      sourceKey,
      kind: contract.dynamic ? "dynamic-handler" : "handler-contract",
      value: contract.path,
      method: contract.method,
      sourcePath: `scripts/glamping_app_server.cjs:${contract.sourceLine}`,
      notes: contract.dynamic
        ? `Dynamic route normalized by Stage 224 scanner; ${contract.parameterInference}.`
        : "Executable method/path condition in the frozen server source."
    })));
    surveyRoutes.forEach((route, index) => ledger.push(ledgerRecord({
      id: `${sourceKey === "v2" ? "V2" : "CL"}-SUR-${String(index + 1).padStart(3, "0")}`,
      sourceKey,
      kind: route.startsWith("/api") ? "v3-survey-api-surface" : "v3-survey-screen-or-file-surface",
      value: route,
      sourcePath: sourcePathForRoute(sourceTexts[sourceKey], route),
      notes: "V3 survey-compatible normalized API/screen/file surface."
    })));
  }

  for (const row of featureRows) {
    const sourceKey = row.id.startsWith("V2-") ? "v2" : "cluster";
    const record = ledgerRecord({
      id: row.id,
      sourceKey,
      kind: "curated-business-feature",
      value: row.title,
      featureId: row.id,
      sourcePath: featureSourcePath(sourceKey, row.id),
      notes: `Source method: ${row.sourceMethod}; V3 review status: ${row.v3Status}; review application: ${row.v3Application}`
    });
    record.inventoryEvidence = {
      source: SOURCE_REFS.v3.name,
      commit: SOURCE_REFS.v3.commit,
      path: `docs/V3_SOURCE_FEATURE_REVIEW.md#${row.id}`
    };
    record.sourceReviewStatus = row.v3Status;
    record.sourceReviewApplication = row.v3Application;
    ledger.push(record);
  }

  const v2Records = ledger.filter((item) => item.source === SOURCE_REFS.v2.name);
  const v2RouteRecords = v2Records.filter((item) => item.inventoryKind !== "curated-business-feature");
  const v2RouteIds = new Map();
  const v2MethodRouteIds = new Map();
  for (const item of v2RouteRecords) {
    const routeKey = comparableRoutePattern(item.routeOrScreen.value);
    if (!v2RouteIds.has(routeKey)) v2RouteIds.set(routeKey, []);
    v2RouteIds.get(routeKey).push(item.id);
    if (item.routeOrScreen.method) {
      const methodKey = `${item.routeOrScreen.method} ${routeKey}`;
      if (!v2MethodRouteIds.has(methodKey)) v2MethodRouteIds.set(methodKey, []);
      v2MethodRouteIds.get(methodKey).push(item.id);
    }
  }
  const v2FeatureIdsByDomain = new Map();
  for (const item of v2Records.filter((entry) => entry.inventoryKind === "curated-business-feature")) {
    if (!v2FeatureIdsByDomain.has(item.domain)) v2FeatureIdsByDomain.set(item.domain, []);
    v2FeatureIdsByDomain.get(item.domain).push(item.id);
  }
  for (const item of ledger.filter((entry) => entry.source === SOURCE_REFS.cluster.name)) {
    let evidenceIds = [];
    let conflictType = "none";
    if (item.inventoryKind === "curated-business-feature") {
      evidenceIds = v2FeatureIdsByDomain.get(item.domain) || [];
      if (evidenceIds.length > 0) conflictType = "functional-domain";
    } else {
      const routeKey = comparableRoutePattern(item.routeOrScreen.value);
      const methodKey = item.routeOrScreen.method ? `${item.routeOrScreen.method} ${routeKey}` : "";
      evidenceIds = methodKey
        ? (v2MethodRouteIds.get(methodKey) || [])
        : (v2RouteIds.get(routeKey) || []);
      if (evidenceIds.length > 0) conflictType = item.routeOrScreen.method ? "exact-method-path" : "exact-path-surface";
    }
    item.v2Conflict = evidenceIds.length > 0;
    item.v2ConflictEvidence = { type: conflictType, v2Ids: [...new Set(evidenceIds)].sort() };
    item.v2PriorityReason = item.v2Conflict
      ? "A matching V2 route/surface or functional domain exists; V2 input, output, API, calculation and companyId behavior remains canonical."
      : "No matching V2 route/surface or curated domain was found; only bounded additive behavior may port behind its target-stage gate.";
  }
  ledger.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));

  const after = Object.fromEntries(Object.entries(SOURCE_REFS).map(([key, source]) => [key, {
    head: String(runGit(source.repository, ["rev-parse", "HEAD"])).trim(),
    status: String(runGit(source.repository, ["status", "--porcelain=v1"]))
  }]));
  const sourceIntegrity = Object.fromEntries(Object.keys(SOURCE_REFS).map((key) => [key, {
    headUnchanged: before[key].head === after[key].head,
    worktreeStatusUnchanged: before[key].status === after[key].status
  }]));

  const result = {
    schemaVersion: 1,
    stage: 224,
    frozenAt: "2026-07-29T00:00:00+09:00",
    mode: "read-only-fixed-git-object-inventory",
    sourceRefs: Object.fromEntries(Object.entries(SOURCE_REFS).map(([key, source]) => [key, {
      name: source.name,
      commit: source.commit,
      repositoryRole: key === "v2" ? "canonical-runtime" : (key === "cluster" ? "read-only-feature-reference" : "read-only-ui-and-inventory-reference")
    }])),
    sourceIntegrity,
    naming: {
      packageName: "glamping-datalab-v2",
      serviceName: "glamping-datalab-v2",
      displayName: "숙박업 데이터랩 beta",
      canonicalManifests: ["render.v2.yaml", "render.v2.persistent.yaml"],
      referenceOnlyManifests: ["render.yaml", "render.persistent.yaml"],
      compatibilityNamesUntilStage225: ["existing session cookie names", "existing localStorage keys", "existing PWA cache keys"]
    },
    dataPolicy: {
      integratedStoreInitialState: "empty",
      allowedPopulation: "fresh collection after provider approval only",
      migrationCount: 0,
      backfillCount: 0,
      dualWriteCount: 0,
      legacyRuntimeReadCount: 0,
      stage223PreviewRuntimeMigrationPath: false
    },
    inventoryReconciliation: {
      explanation: "Stage 221 counts raw quoted /api/ literals, while the V3 survey strips trailing slashes and also scans /outputs, /admin, /app, /b2b and /view surfaces. Handler counts are a third executable-contract view and include normalized dynamic routes.",
      v2: evidence.v2,
      cluster: evidence.cluster,
      frozenExpected: {
        v2: { ...FROZEN_INVENTORY_EXPECTED.v2 },
        cluster: { ...FROZEN_INVENTORY_EXPECTED.cluster }
      }
    },
    featureSummary: {
      curatedV2Features: featureRows.filter((row) => row.id.startsWith("V2-")).length,
      curatedClusterFeatures: featureRows.filter((row) => row.id.startsWith("CL-")).length,
      totalLedgerRecords: ledger.length,
      clusterUnclassifiedCount: ledger.filter((row) => row.source === SOURCE_REFS.cluster.name && !DECISIONS.has(row.decision)).length
    },
    requiredLedgerFields: REQUIRED_LEDGER_FIELDS,
    ledger,
    collectionBudget: {
      costFormula: "fixedFeeKRW + ceil((expectedCalls + retryReserve) / billingUnitRequests) * unitCostKRW",
      unknownPricePolicy: "approvedCapKRW=0 and realRequestLimit=0 until Finance and provider-owner approval",
      providers: collectionBudget()
    },
    acceptanceMetrics: acceptanceMetrics(),
    staticAssets: staticAssets(),
    legacyDataDenylist: legacyDataDenylist(),
    runtimeAccessGuard: {
      module: "scripts/integration_data_access_guard.cjs",
      test: "scripts/test_integration_data_access_guard.cjs",
      requiredForStage228Repositories: true,
      expectedLegacyReadCount: 0,
      expectedNonAllowlistedStaticReadCount: 0
    },
    featureFlags: featureFlags(),
    stageRaci: [
      { stage: 224, responsible: ["BE", "DE"], accountable: "PO", consulted: ["FE", "SE", "SO", "QA", "DGO", "Finance"], informed: ["SRE", "RM"] },
      { stage: 225, responsible: ["FE"], accountable: "PO", consulted: ["BE", "QA", "SE"], informed: ["SRE", "RM"] },
      { stage: 226, responsible: ["SE", "BE"], accountable: "SO", consulted: ["QA", "DGO"], informed: ["PO", "SRE", "RM"] },
      { stage: 227, responsible: ["FE", "BE"], accountable: "PO", consulted: ["QA", "SE", "DE"], informed: ["SRE", "RM"] },
      { stage: 228, responsible: ["DE", "BE"], accountable: "DGO", consulted: ["QA", "SE", "Finance"], informed: ["PO", "SRE", "RM"] },
      { stage: 229, responsible: ["DE", "FE"], accountable: "PO", consulted: ["DGO", "QA"], informed: ["SRE", "RM"] },
      { stage: 230, responsible: ["DE", "BE", "FE"], accountable: "PO", consulted: ["DGO", "QA"], informed: ["SRE", "RM"] },
      { stage: 231, responsible: ["DE", "PIE", "SPE", "SRE"], accountable: "DGO", consulted: ["ProviderOps", "SO", "Finance", "QA"], informed: ["PO", "RM"] },
      { stage: 232, responsible: ["BE", "SRE"], accountable: "SO", consulted: ["QA", "DGO"], informed: ["PO", "RM"] },
      { stage: 233, responsible: ["QA", "SRE"], accountable: "RM", consulted: ["PO", "SO", "DGO"], informed: ["BE", "DE", "FE"] },
      { stage: 234, responsible: ["SRE", "RM"], accountable: "PO", consulted: ["SO", "DGO", "QA"], informed: ["BE", "DE", "FE"] }
    ],
    roleGlossary: {
      PO: "Product Owner", BE: "Backend Engineer", DE: "Data Platform Engineer", FE: "Frontend Engineer", SE: "Security Engineer", SO: "Security & Compliance Owner", QA: "QA Lead", SRE: "Site Reliability Engineer", RM: "Release Manager", DGO: "Data Governance Engineer", APO: "API Platform Owner", PIE: "Provider Integration Engineer", SPE: "Signal Pipeline Engineer", ProviderOps: "Provider Operations Owner", Finance: "Finance Approver", Legal: "Legal Reviewer"
    },
    providerApprovalGates: providerApprovalGates(),
    blockers: null
  };
  result.blockers = calculateBlockers(result);
  return result;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const mode = process.argv.includes("--write") ? "write" : "verify";
  const result = buildLedger();
  const output = serialize(result);
  if (mode === "write") {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, output, "utf8");
    process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
    return;
  }
  if (!fs.existsSync(OUTPUT_PATH)) throw new Error(`Missing generated ledger: ${OUTPUT_PATH}`);
  const existing = fs.readFileSync(OUTPUT_PATH, "utf8");
  if (existing !== output) throw new Error("Stage 224 ledger is stale; run npm run stage224:inventory");
  process.stdout.write("Stage 224 inventory matches fixed source refs.\n");
}

if (require.main === module) main();

module.exports = {
  DECISIONS,
  FROZEN_CLUSTER_HANDLER_CONFLICTS,
  FROZEN_CURATED_FEATURE_IDS,
  FROZEN_INVENTORY_EXPECTED,
  OUTPUT_PATH,
  REQUIRED_LEDGER_FIELDS,
  SOURCE_REFS,
  buildLedger,
  calculateBlockers,
  collectHandlerContracts,
  collectStage221LiteralRoutes,
  collectSurveyRoutes,
  parseFeatureReview,
  serialize
};
