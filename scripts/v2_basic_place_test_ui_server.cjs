"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const {
  APPROVAL_TOKEN,
  LIVE_ENV_NAMES,
  SCHEMA_VERSION: COLLECTOR_JOB_SCHEMA,
  executeBasicPlaceJob,
  sha256
} = require("./v2_live_basic_place_collector.cjs");
const { normalizeQuery } = require("./naver_place_apollo_parser.cjs");
const { createBasicPlaceDemoHtml } = require("./v2_basic_place_ui_demo_fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(ROOT, "web", "v2-basic-place-test");
const LOCAL_STATE_ROOT = path.join(ROOT, "outputs", "v2-basic-place-test-ui");
const RENDER_STATE_ROOT = "/var/data/v2-basic-place-test-ui";
const RESULT_SCHEMA_VERSION = "v2-basic-place-test-ui-result.v1";
const STATUS_SCHEMA_VERSION = "v2-basic-place-test-ui-status.v1";
const OPERATOR_TOKEN_HEADER = "x-v2-basic-operator-token";
const MAX_REQUEST_BODY_BYTES = 8 * 1024;
const MAX_DAILY_LIVE_REQUESTS = 20;
const ENV_NAMES = Object.freeze({
  expectedCommit: "V2_BASIC_UI_EXPECTED_DEPLOY_COMMIT",
  stateDir: "V2_BASIC_UI_STATE_DIR",
  runEnabled: "V2_BASIC_UI_RUN_ENABLED",
  dailyRequestBudget: "V2_BASIC_UI_DAILY_REQUEST_BUDGET",
  automaticRetry: "V2_BASIC_UI_AUTOMATIC_RETRY",
  fallback: "V2_BASIC_UI_FALLBACK",
  operationalWrites: "V2_BASIC_UI_OPERATIONAL_WRITES",
  operatorTokenSha256: "V2_BASIC_UI_OPERATOR_TOKEN_SHA256",
  demoPublic: "V2_BASIC_UI_DEMO_PUBLIC"
});

const STATIC_FILES = Object.freeze({
  "/": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/index.html": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/app.js": Object.freeze({ file: "app.js", type: "text/javascript; charset=utf-8" }),
  "/styles.css": Object.freeze({ file: "styles.css", type: "text/css; charset=utf-8" })
});

class V2BasicUiError extends Error {
  constructor(code, stage, message, statusCode = 400, evidence = {}) {
    super(message);
    this.name = "V2BasicUiError";
    this.code = code;
    this.stage = stage;
    this.statusCode = statusCode;
    this.retryable = false;
    this.evidence = evidence;
  }
}

function fail(code, stage, message, statusCode, evidence) {
  throw new V2BasicUiError(code, stage, message, statusCode, evidence);
}

function integer(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function isChildPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseConfig(env = process.env) {
  const render = Boolean(String(env.RENDER_SERVICE_ID || "").trim());
  const runEnabledRaw = String(env[ENV_NAMES.runEnabled] ?? "0");
  const dailyBudgetRaw = String(env[ENV_NAMES.dailyRequestBudget] ?? "0");
  const automaticRetry = String(env[ENV_NAMES.automaticRetry] ?? "0");
  const fallback = String(env[ENV_NAMES.fallback] ?? "0");
  const operationalWrites = String(env[ENV_NAMES.operationalWrites] ?? "0");
  if (!["0", "1"].includes(runEnabledRaw)) {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Run enabled must be zero or one", 500);
  }
  if (automaticRetry !== "0" || fallback !== "0" || operationalWrites !== "0") {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Safety gates must remain zero", 500);
  }
  const liveEnabled = runEnabledRaw === "1";
  const dailyRequestBudget = integer(dailyBudgetRaw);
  if (
    dailyRequestBudget === null
    || dailyRequestBudget < 0
    || dailyRequestBudget > MAX_DAILY_LIVE_REQUESTS
    || (liveEnabled && dailyRequestBudget < 1)
    || (!liveEnabled && dailyRequestBudget !== 0)
  ) fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Daily request budget is invalid", 500);

  const operatorTokenSha256 = String(env[ENV_NAMES.operatorTokenSha256] || "").trim().toLowerCase();
  if (operatorTokenSha256 && !/^[a-f0-9]{64}$/u.test(operatorTokenSha256)) {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Operator token digest is invalid", 500);
  }
  if (liveEnabled && !operatorTokenSha256) {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Live mode requires an operator token digest", 500);
  }

  const configuredState = String(env[ENV_NAMES.stateDir] || "").trim();
  const stateDir = configuredState || path.join(LOCAL_STATE_ROOT, "manual");
  if (!path.isAbsolute(stateDir)) fail("V2_BASIC_UI_CONFIG_INVALID", "config", "State directory must be absolute", 500);
  if (render && stateDir.replace(/\\/gu, "/") !== RENDER_STATE_ROOT) {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Render must use the dedicated UI disk", 500);
  }
  if (!render && !isChildPath(LOCAL_STATE_ROOT, stateDir)) {
    fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Local state must be isolated under the UI output root", 500);
  }

  const deployedCommit = String(env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  const expectedCommit = String(env[ENV_NAMES.expectedCommit] || "").trim().toLowerCase();
  if (render && (
    !/^[a-f0-9]{40}$/u.test(deployedCommit)
    || !/^[a-f0-9]{40}$/u.test(expectedCommit)
    || deployedCommit !== expectedCommit
  )) fail("V2_BASIC_UI_DEPLOY_COMMIT_MISMATCH", "config", "Deployed commit does not match the approved commit", 500);

  const port = integer(env.PORT, 10000);
  if (port < 1 || port > 65535) fail("V2_BASIC_UI_CONFIG_INVALID", "config", "Port is invalid", 500);
  const demoPublic = !render && String(env[ENV_NAMES.demoPublic] ?? "1") === "1";
  return Object.freeze({
    port,
    host: "0.0.0.0",
    render,
    stateDir: path.resolve(stateDir),
    liveEnabled,
    demoPublic,
    dailyRequestBudget,
    automaticRetry: false,
    fallback: false,
    operationalWrites: false,
    operatorTokenSha256,
    deployedCommit: deployedCommit || null
  });
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/u.test(String(left || "")) || !/^[a-f0-9]{64}$/u.test(String(right || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function authorized(request, mode, config) {
  if (mode === "demo" && config.demoPublic) return true;
  if (!config.operatorTokenSha256) return false;
  const token = String(request.headers[OPERATOR_TOKEN_HEADER] || "");
  if (token.length < 16 || token.length > 512) return false;
  return safeEqualHex(sha256(Buffer.from(token, "utf8")), config.operatorTokenSha256);
}

function normalizeCollectRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("V2_BASIC_UI_REQUEST_INVALID", "request", "Request body must be an object", 400);
  }
  const allowedKeys = new Set(["mode", "keyword", "idempotencyKey"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    fail("V2_BASIC_UI_REQUEST_INVALID", "request", "Request contains an unsupported field", 400);
  }
  const mode = String(value.mode || "");
  const keyword = normalizeQuery(value.keyword);
  const idempotencyKey = String(value.idempotencyKey || "");
  if (
    !["demo", "live"].includes(mode)
    || !keyword
    || keyword.length > 120
    || /[\u0000-\u001f\u007f]/u.test(keyword)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{15,119}$/u.test(idempotencyKey)
  ) fail("V2_BASIC_UI_REQUEST_INVALID", "request", "Request does not match the collection contract", 400);
  return Object.freeze({ mode, keyword, idempotencyKey });
}

function dateKey(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function statePaths(root, requestHash, now) {
  return Object.freeze({
    claimsRoot: path.join(root, "claims"),
    terminalsRoot: path.join(root, "terminals"),
    artifactsRoot: path.join(root, "artifacts"),
    usageRoot: path.join(root, "usage"),
    claim: path.join(root, "claims", `${requestHash}.json`),
    terminal: path.join(root, "terminals", `${requestHash}.json`),
    usage: path.join(root, "usage", `${dateKey(now)}.json`)
  });
}

async function initializeState(paths) {
  await Promise.all([
    fs.mkdir(paths.claimsRoot, { recursive: true }),
    fs.mkdir(paths.terminalsRoot, { recursive: true }),
    fs.mkdir(paths.artifactsRoot, { recursive: true }),
    fs.mkdir(paths.usageRoot, { recursive: true })
  ]);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("V2_BASIC_UI_STATE_UNCERTAIN", "state", "State could not be read", 503);
  }
}

async function writeExclusiveJson(filePath, value) {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close?.();
  }
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close?.();
  }
  await fs.rename(temporary, filePath);
}

function validateUsage(existing, config, now) {
  if (!existing) return Object.freeze({ consumed: 0, limit: config.dailyRequestBudget });
  const consumed = integer(existing.consumed);
  if (
    existing.schemaVersion !== "v2-basic-place-test-ui-usage.v1"
    || existing.date !== dateKey(now)
    || consumed === null
    || consumed < 0
    || consumed > config.dailyRequestBudget
    || integer(existing.limit) !== config.dailyRequestBudget
  ) fail("V2_BASIC_UI_STATE_UNCERTAIN", "budget", "Daily usage state is invalid", 503);
  return Object.freeze({ consumed, limit: config.dailyRequestBudget });
}

async function reserveLiveBudget(paths, config, now) {
  const existing = await readJsonIfPresent(paths.usage);
  const { consumed } = validateUsage(existing, config, now);
  if (consumed >= config.dailyRequestBudget) {
    fail("V2_BASIC_UI_DAILY_BUDGET_EXHAUSTED", "budget", "Daily live request budget is exhausted", 429, {
      consumed,
      limit: config.dailyRequestBudget
    });
  }
  const next = Object.freeze({
    schemaVersion: "v2-basic-place-test-ui-usage.v1",
    date: dateKey(now),
    consumed: consumed + 1,
    limit: config.dailyRequestBudget,
    updatedAt: now.toISOString()
  });
  await writeAtomicJson(paths.usage, next);
  return next;
}

async function readArtifacts(artifactDirectory) {
  const [organic, advertisements, diagnostics, manifest] = await Promise.all([
    fs.readFile(path.join(artifactDirectory, "organic.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(artifactDirectory, "advertisements.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(artifactDirectory, "provider-diagnostics.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(artifactDirectory, "manifest.json"), "utf8").then(JSON.parse)
  ]);
  if (!Array.isArray(organic) || !Array.isArray(advertisements) || !diagnostics || !manifest) {
    fail("V2_BASIC_UI_ARTIFACT_INVALID", "artifact", "Collector artifacts are invalid", 502);
  }
  return Object.freeze({ organic, advertisements, diagnostics, manifest });
}

function collectionJob(request, runId) {
  return Object.freeze({
    schemaVersion: COLLECTOR_JOB_SCHEMA,
    runId,
    mode: request.mode === "live" ? "live" : "offline",
    keyword: request.keyword,
    timeoutMs: 25000,
    responseSizeLimitBytes: 2097152
  });
}

function jobBytes(job) {
  return Buffer.from(`${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function defaultRunCollection({ request, requestHash, paths, config, fetchImpl }) {
  const runId = `ui-${request.mode}-${requestHash.slice(0, 24)}`;
  const job = collectionJob(request, runId);
  const bytes = jobBytes(job);
  const env = request.mode === "live" ? {
    [LIVE_ENV_NAMES.approved]: APPROVAL_TOKEN,
    [LIVE_ENV_NAMES.approvedJobDigest]: sha256(bytes),
    [LIVE_ENV_NAMES.requestBudget]: "1",
    [LIVE_ENV_NAMES.automaticRetry]: "0",
    [LIVE_ENV_NAMES.fallback]: "0",
    [LIVE_ENV_NAMES.operationalWrites]: "0"
  } : {};
  const fixtureFetch = async () => new Response(createBasicPlaceDemoHtml(request.keyword), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
  const startedAt = Date.now();
  const result = await executeBasicPlaceJob({
    jobBytes: bytes,
    outputRoot: paths.artifactsRoot,
    env,
    fetchImpl: request.mode === "live" ? fetchImpl : fixtureFetch
  });
  const expectedArtifactDirectory = path.join(paths.artifactsRoot, runId);
  if (path.resolve(result.artifactDirectory) !== path.resolve(expectedArtifactDirectory)) {
    fail("V2_BASIC_UI_ARTIFACT_INVALID", "artifact", "Collector artifact escaped the isolated directory", 502);
  }
  const artifacts = await readArtifacts(expectedArtifactDirectory);
  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    event: "v2_basic_place_test_ui_result",
    status: "completed",
    duplicate: false,
    mode: request.mode,
    runId,
    keyword: request.keyword,
    requestHash,
    collectedAt: artifacts.manifest.collectedAt,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    counts: artifacts.manifest.counts,
    organic: artifacts.organic.slice(0, 50),
    advertisements: artifacts.advertisements.slice(0, 100),
    diagnostics: artifacts.diagnostics,
    manifestDigest: result.manifestDigest,
    externalRequests: result.externalRequests,
    retryCount: 0,
    fallbackCount: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false
  });
}

function publicFailure(error, requestHash = null) {
  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    event: "v2_basic_place_test_ui_failed",
    status: "failed",
    duplicate: false,
    requestHash,
    code: String(error?.code || "V2_BASIC_UI_UNEXPECTED").slice(0, 120),
    stage: String(error?.stage || "unexpected").slice(0, 80),
    retryable: false,
    externalRequests: Number(error?.details?.externalRequests || error?.evidence?.externalRequests || 0),
    operationalWrites: 0
  });
}

function createCoordinator(options = {}) {
  const config = options.config || parseConfig(options.env || process.env);
  const now = options.now || (() => new Date());
  const runCollection = options.runCollection || defaultRunCollection;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let active = false;

  async function status() {
    const instant = now();
    const paths = statePaths(config.stateDir, "status", instant);
    await initializeState(paths);
    const usage = await readJsonIfPresent(paths.usage);
    const validatedUsage = validateUsage(usage, config, instant);
    return Object.freeze({
      schemaVersion: STATUS_SCHEMA_VERSION,
      status: "ready",
      mode: config.liveEnabled ? "live-enabled" : "demo-only",
      demoEnabled: true,
      liveEnabled: config.liveEnabled,
      authRequired: !config.demoPublic,
      active,
      dailyLiveRequestLimit: config.dailyRequestBudget,
      dailyLiveRequestsUsed: validatedUsage.consumed,
      automaticRetry: false,
      fallback: false,
      operationalWrites: false,
      rawProviderResponseStored: false,
      deployedCommit: config.deployedCommit
    });
  }

  async function collect(input) {
    const request = normalizeCollectRequest(input.body);
    if (!authorized(input.request, request.mode, config)) {
      fail("V2_BASIC_UI_UNAUTHORIZED", "authorization", "Operator authentication failed", 401);
    }
    if (request.mode === "live" && !config.liveEnabled) {
      fail("V2_BASIC_UI_LIVE_DISABLED", "live-gate", "Live collection is disabled", 403);
    }
    const requestHash = sha256(Buffer.from(`${request.mode}\0${request.idempotencyKey}`, "utf8"));
    const instant = now();
    const paths = statePaths(config.stateDir, requestHash, instant);
    await initializeState(paths);
    const terminal = await readJsonIfPresent(paths.terminal);
    if (terminal) return Object.freeze({ ...terminal, duplicate: true });
    if (await readJsonIfPresent(paths.claim)) {
      fail("V2_BASIC_UI_RESULT_UNCERTAIN", "claim", "A claim exists without a terminal result", 409);
    }
    if (active) fail("V2_BASIC_UI_BUSY", "concurrency", "Another collection is active", 409);

    active = true;
    try {
      if (request.mode === "live") await reserveLiveBudget(paths, config, instant);
      await writeExclusiveJson(paths.claim, Object.freeze({
        schemaVersion: "v2-basic-place-test-ui-claim.v1",
        requestHash,
        mode: request.mode,
        claimedAt: instant.toISOString(),
        externalRequestBudget: request.mode === "live" ? 1 : 0,
        retryCount: 0,
        fallbackCount: 0,
        operationalWrites: 0
      }));
      let result;
      try {
        result = await runCollection({ request, requestHash, paths, config, fetchImpl });
      } catch (error) {
        const failure = publicFailure(error, requestHash);
        await writeAtomicJson(paths.terminal, failure);
        throw error;
      }
      await writeAtomicJson(paths.terminal, result);
      return result;
    } finally {
      active = false;
    }
  }

  return Object.freeze({ collect, config, status });
}

function securityHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) fail("V2_BASIC_UI_REQUEST_TOO_LARGE", "request", "Request body is too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("V2_BASIC_UI_REQUEST_INVALID", "request", "Request JSON is invalid", 400);
  }
}

function assertSameOrigin(request) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin) return;
  const host = String(request.headers.host || "").trim();
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  if (forwardedProto) allowed.add(`${forwardedProto}://${host}`);
  if (!allowed.has(origin)) fail("V2_BASIC_UI_ORIGIN_BLOCKED", "authorization", "Cross-origin requests are blocked", 403);
}

function safeHttpFailure(error) {
  return Object.freeze({
    schemaVersion: "v2-basic-place-test-ui-error.v1",
    status: "failed",
    code: String(error?.code || "V2_BASIC_UI_UNEXPECTED").slice(0, 120),
    stage: String(error?.stage || "unexpected").slice(0, 80),
    retryable: false,
    externalRequests: Number(error?.details?.externalRequests || error?.evidence?.externalRequests || 0),
    operationalWrites: 0
  });
}

function createRequestHandler(options = {}) {
  const coordinator = options.coordinator || createCoordinator(options);
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, await coordinator.status());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/collect") {
        assertSameOrigin(request);
        if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
          fail("V2_BASIC_UI_CONTENT_TYPE_INVALID", "request", "JSON content type is required", 415);
        }
        const result = await coordinator.collect({ request, body: await readJsonBody(request) });
        sendJson(response, 200, result);
        return;
      }
      const asset = STATIC_FILES[url.pathname];
      if (request.method === "GET" && asset) {
        const bytes = await fs.readFile(path.join(WEB_ROOT, asset.file));
        response.writeHead(200, securityHeaders(asset.type));
        response.end(bytes);
        return;
      }
      sendJson(response, 404, { status: "failed", code: "V2_BASIC_UI_NOT_FOUND" });
    } catch (error) {
      const statusCode = error instanceof V2BasicUiError ? error.statusCode : 500;
      sendJson(response, statusCode, safeHttpFailure(error));
    }
  };
}

function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

async function startServer(env = process.env) {
  const config = parseConfig(env);
  const coordinator = createCoordinator({ config });
  const server = createServer({ coordinator });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(`${JSON.stringify({
    event: "v2_basic_place_test_ui_ready",
    status: "ready",
    port: config.port,
    mode: config.liveEnabled ? "live-enabled" : "demo-only",
    liveEnabled: config.liveEnabled,
    dailyLiveRequestLimit: config.dailyRequestBudget,
    automaticRetry: false,
    fallback: false,
    operationalWrites: false,
    rawProviderResponseStored: false,
    deployedCommit: config.deployedCommit
  })}\n`);
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    process.stdout.write(`${JSON.stringify(safeHttpFailure(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ENV_NAMES,
  LOCAL_STATE_ROOT,
  MAX_DAILY_LIVE_REQUESTS,
  OPERATOR_TOKEN_HEADER,
  RENDER_STATE_ROOT,
  RESULT_SCHEMA_VERSION,
  V2BasicUiError,
  authorized,
  createCoordinator,
  createRequestHandler,
  createServer,
  dateKey,
  defaultRunCollection,
  normalizeCollectRequest,
  parseConfig,
  publicFailure,
  safeHttpFailure,
  startServer
};
