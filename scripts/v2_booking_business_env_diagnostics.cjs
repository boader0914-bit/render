"use strict";

const crypto = require("node:crypto");
const diagnosticsChannel = require("node:diagnostics_channel");
const dns = require("node:dns");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GRAPHQL_DOCUMENTS } = require("./naver_bounded_inventory_live_transport.cjs");
const { verifyBaseline, verifyCommitLineage, sha256, stableJson } = require("./v2_booking_business_harness.cjs");

const ROOT = path.resolve(__dirname, "..");
const D1_COMMIT = "2daecbb40f351d3916cf30f95bf4435cf58920eb";
const V2_COLLECTOR_BLOB = "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3";
const REFERENCE_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const LOCKFILE_SHA256 = "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2";
const APPLICATION_ENVELOPE_SHA256 = "2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d";
const EVIDENCE_PATH = path.join(ROOT, "docs", "v2_booking_business_environment_evidence.json");
const OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase3-d2");
const RUN_ID = "rebuild-phase3-booking-business-environment-offline-001";
const RESULT_SCHEMA_VERSION = "v2-booking-business-environment-diagnostics.v1";
const RUNTIME_SCHEMA_VERSION = "v2-booking-business-runtime-fingerprint.v1";
const CONTROLLED_GRAPHQL_HEADER_NAMES = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
  "origin",
  "referer",
  "user-agent"
]);
const PROXY_ENV_NAMES = Object.freeze([
  "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "all_proxy", "https_proxy", "http_proxy", "no_proxy"
]);
const CA_ENV_NAMES = Object.freeze([
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_DIR", "SSL_CERT_FILE"
]);
const NETWORK_RUNTIME_ENV_NAMES = Object.freeze([
  "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "UV_THREADPOOL_SIZE"
]);
const LOCALE_ENV_NAMES = Object.freeze(["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"]);

class V2BookingBusinessEnvironmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2BookingBusinessEnvironmentError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2BookingBusinessEnvironmentError(code, message);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function gitBlob(relative) {
  return git(["hash-object", `--path=${relative}`, relative]);
}

function presentNames(env, names) {
  return [...new Set(names.filter((name) => Object.prototype.hasOwnProperty.call(env, name)))].sort();
}

function safeExecArgvNames(argv = process.execArgv) {
  return [...new Set(argv
    .map((entry) => String(entry).match(/^--[a-z0-9-]+/iu)?.[0] || "")
    .filter(Boolean))].sort();
}

function runtimeFingerprint(env = process.env) {
  const resolvedLocale = Intl.DateTimeFormat().resolvedOptions();
  const renderNames = Object.keys(env).filter((name) => /^RENDER(?:_|$)/u.test(name)).sort();
  const value = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runtime: {
      nodeVersion: process.version,
      undiciVersion: process.versions.undici || null,
      opensslVersion: process.versions.openssl || null,
      icuVersion: process.versions.icu || null,
      platform: process.platform,
      architecture: process.arch,
      endianness: os.endianness()
    },
    locale: {
      defaultLocale: resolvedLocale.locale || null,
      timeZone: resolvedLocale.timeZone || null
    },
    dns: {
      defaultResultOrder: typeof dns.getDefaultResultOrder === "function" ? dns.getDefaultResultOrder() : "unknown",
      resolvedAddressesStored: false
    },
    process: {
      executableName: path.basename(process.execPath),
      execArgvOptionNames: safeExecArgvNames(),
      cwdStored: false,
      argvValuesStored: false
    },
    environmentPresence: {
      proxyNames: presentNames(env, PROXY_ENV_NAMES),
      caNames: presentNames(env, CA_ENV_NAMES),
      networkRuntimeNames: presentNames(env, NETWORK_RUNTIME_ENV_NAMES),
      localeNames: presentNames(env, LOCALE_ENV_NAMES),
      renderNames
    },
    capabilities: {
      globalFetch: typeof globalThis.fetch === "function",
      diagnosticsChannel: typeof diagnosticsChannel.subscribe === "function"
    },
    privacy: {
      environmentValuesStored: false,
      hostNameStored: false,
      ipAddressesStored: false,
      absolutePathsStored: false
    }
  };
  return Object.freeze({ ...value, fingerprintSha256: sha256(stableJson(value)) });
}

function headerNamesFromUndici(value) {
  if (Buffer.isBuffer(value)) return headerNamesFromUndici(value.toString("latin1"));
  if (Array.isArray(value)) {
    const names = [];
    for (let index = 0; index < value.length; index += 2) {
      if (value[index] !== undefined) names.push(String(value[index]).toLowerCase());
    }
    return [...new Set(names)].sort();
  }
  return [...new Set(String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.match(/^([^:\s]+)\s*:/u)?.[1]?.toLowerCase() || "")
    .filter(Boolean))].sort();
}

function createTransportRecorder() {
  const started = process.hrtime.bigint();
  const events = [];
  const subscriptions = [];
  const subscribe = (name, project) => {
    const listener = (message) => {
      try {
        events.push(Object.freeze({
          name,
          elapsedMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          ...project(message || {})
        }));
      } catch {
        events.push(Object.freeze({ name, elapsedMs: null, projectionFailed: true }));
      }
    };
    diagnosticsChannel.subscribe(name, listener);
    subscriptions.push([name, listener]);
  };
  subscribe("undici:request:create", (message) => ({
    method: String(message.request?.method || ""),
    protocol: String(message.request?.protocol || ""),
    contentLength: Number.isInteger(message.request?.contentLength) ? message.request.contentLength : null,
        undiciHeaderNamesBeforeDispatch: headerNamesFromUndici(message.request?.headers),
    requestTargetStored: false,
    headerValuesStored: false
  }));
  subscribe("undici:client:beforeConnect", (message) => ({
    protocol: String(message.connectParams?.protocol || ""),
    ipAddressStored: false,
    serverNameStored: false
  }));
  subscribe("undici:client:connected", (message) => ({
    encrypted: Boolean(message.socket?.encrypted),
    addressFamily: message.socket?.remoteFamily || null,
    alpnProtocol: message.socket?.alpnProtocol || null,
    tlsProtocol: message.socket?.getProtocol?.() || null,
    cipherName: message.socket?.getCipher?.()?.name || null,
    tlsAuthorized: typeof message.socket?.authorized === "boolean" ? message.socket.authorized : null,
    ipAddressStored: false,
    serverNameStored: false
  }));
  for (const name of ["undici:request:headers", "undici:request:trailers", "undici:request:error"]) {
    subscribe(name, () => ({ responseValuesStored: false, errorMessageStored: false }));
  }
  return Object.freeze({
    snapshot() {
      const counts = Object.fromEntries([...new Set(events.map((entry) => entry.name))].sort().map((name) => [
        name,
        events.filter((entry) => entry.name === name).length
      ]));
      return Object.freeze({
        schemaVersion: "v2-booking-business-transport-events.v1",
        counts,
        events: events.map((entry) => ({ ...entry })),
        rawHeadersStored: false,
        headerValuesStored: false,
        requestTargetsStored: false,
        ipAddressesStored: false
      });
    },
    close() {
      for (const [name, listener] of subscriptions) diagnosticsChannel.unsubscribe(name, listener);
    }
  });
}

function expectedGraphqlRequest(placeId = "1001") {
  const body = {
    operationName: "naverBookingBusiness",
    query: GRAPHQL_DOCUMENTS.naver_booking_business,
    variables: { id: placeId, isNx: false }
  };
  const bodyText = JSON.stringify(body);
  return Object.freeze({
    bodyText,
    bodySha256: sha256(bodyText),
    headers: Object.freeze({
      accept: "*/*",
      "accept-language": "ko-KR,ko;q=0.9",
      "content-type": "application/json",
      origin: "https://pcmap.place.naver.com",
      referer: `https://pcmap.place.naver.com/accommodation/${placeId}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    })
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function safeRequestObservation(request, body, controlledHeaders) {
  const namesInOrder = request.rawHeaders.filter((value, index) => index % 2 === 0).map((name) => String(name).toLowerCase());
  const names = [...new Set(namesInOrder)].sort();
  const controlledNames = Object.keys(controlledHeaders).sort();
  return Object.freeze({
    method: request.method,
    pathClass: request.url?.startsWith("/graphql") ? "graphql" : "main-place",
    httpVersion: request.httpVersion,
    headerNames: names,
    headerOrder: namesInOrder,
    controlledHeaderNames: controlledNames,
    implicitHeaderNames: names.filter((name) => !controlledNames.includes(name)),
    controlledHeaderValuesMatch: Object.fromEntries(controlledNames.map((name) => [
      name,
      String(request.headers[name] || "") === String(controlledHeaders[name])
    ])),
    cookieHeaderPresent: Object.prototype.hasOwnProperty.call(request.headers, "cookie"),
    bodyBytes: body.length,
    bodySha256: sha256(body),
    rawHeaderValuesStored: false,
    rawBodyStored: false,
    fullPathStored: false
  });
}

async function startCaptureServer(responseHeaders = {}) {
  let resolveObservation;
  const observation = new Promise((resolve) => { resolveObservation = resolve; });
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    resolveObservation({ request, body });
    response.writeHead(200, { "content-type": "application/json", ...responseHeaders });
    response.end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return Object.freeze({
    url(pathname) {
      return `http://127.0.0.1:${address.port}${pathname}`;
    },
    observation,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

async function executeGraphqlLoopback(server, requestShape) {
  const response = await fetch(server.url("/graphql"), {
    method: "POST",
    headers: requestShape.headers,
    redirect: "manual",
    body: requestShape.bodyText
  });
  await response.arrayBuffer();
  const captured = await server.observation;
  return safeRequestObservation(captured.request, captured.body, requestShape.headers);
}

async function standaloneLoopbackProbe(requestShape) {
  const server = await startCaptureServer();
  try {
    return await executeGraphqlLoopback(server, requestShape);
  } finally {
    await server.close();
  }
}

async function sequenceLoopbackProbe(requestShape) {
  const mainHeaders = Object.freeze({
    "accept-language": requestShape.headers["accept-language"],
    "user-agent": requestShape.headers["user-agent"]
  });
  const mainServer = await startCaptureServer({
    "set-cookie": "v2_fixture_session=not-persisted; Path=/; HttpOnly"
  });
  const graphqlServer = await startCaptureServer();
  try {
    const mainResponse = await fetch(mainServer.url("/accommodation/list?query=fixture"), {
      method: "GET",
      headers: mainHeaders,
      redirect: "manual"
    });
    await mainResponse.arrayBuffer();
    const mainCaptured = await mainServer.observation;
    const graphql = await executeGraphqlLoopback(graphqlServer, requestShape);
    return Object.freeze({
      mainPlace: safeRequestObservation(mainCaptured.request, mainCaptured.body, mainHeaders),
      graphql,
      setCookieIssuedByMainFixture: true,
      cookieAutomaticallyForwarded: graphql.cookieHeaderPresent,
      sameProcess: true,
      separateOrigins: true
    });
  } finally {
    await Promise.all([mainServer.close(), graphqlServer.close()]);
  }
}

async function sourceSessionInspection() {
  const files = [
    "scripts/gyeongnam_glamping_crawl.cjs",
    "scripts/naver_legacy_canary_live_transport.cjs",
    "scripts/naver_bounded_inventory_live_transport.cjs"
  ];
  const contents = await Promise.all(files.map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const collector = contents[0];
  const sessionPattern = /(?:set-cookie|cookiejar|cookie-jar|tough-cookie|\bcookie\b)/giu;
  const directFetchPattern = /fetchImpl:\s*\(\.\.\.args\)\s*=>\s*fetch\(\.\.\.args\)/gu;
  return Object.freeze({
    inspectedFiles: files,
    explicitCookieStateTokenMatches: contents.reduce((total, text) => total + (text.match(sessionPattern)?.length || 0), 0),
    directGlobalFetchAdapters: collector.match(directFetchPattern)?.length || 0,
    mainPlaceBeforeBookingEnrichment: collector.indexOf("const naver = await collectNaverMain();") >= 0
      && collector.indexOf("const naver = await collectNaverMain();") < collector.indexOf("const naverBookingStock = await enrichNaverRowsWithBookingAvailability(["),
    sourceContentsStored: false
  });
}

async function readEnvironmentEvidence() {
  const value = JSON.parse(await fs.readFile(EVIDENCE_PATH, "utf8"));
  const expectedIds = [
    "render-v2-full-path-success",
    "n3-local-original-standalone",
    "n3-local-copied-standalone",
    "n3-d1-local-copied-copy-only"
  ];
  if (
    value.schemaVersion !== "v2-booking-business-environment-evidence.v1"
    || value.baseline?.diagnosticsCommit !== D1_COMMIT
    || value.baseline?.v2CollectorBlob !== V2_COLLECTOR_BLOB
    || value.baseline?.referenceCollectorBlob !== REFERENCE_COLLECTOR_BLOB
    || value.baseline?.lockfileSha256 !== LOCKFILE_SHA256
    || value.baseline?.applicationEnvelopeSha256 !== APPLICATION_ENVELOPE_SHA256
    || stableJson(value.observations?.map((entry) => entry.id)) !== stableJson(expectedIds)
    || value.evidenceSources?.phase1ReportGitBlob !== git(["rev-parse", "HEAD:docs/datalab_rebuild_phase1_report.md"])
    || value.evidenceSources?.phase3ReportGitBlob !== git(["rev-parse", "HEAD:docs/datalab_rebuild_phase3_report.md"])
    || value.evidenceSources?.phase3D1ReportGitBlob !== git(["rev-parse", "HEAD:docs/datalab_rebuild_phase3_d1_report.md"])
    || value.evidenceSources?.n3LiveManifestGitBlob !== git(["rev-parse", "HEAD:docs/v2_booking_business_n3_live_evidence_manifest.json"])
    || Object.values(value.privacy || {}).some((entry) => entry !== false)
  ) fail("V2_BOOKING_BUSINESS_ENV_EVIDENCE_INVALID", "environment evidence contract changed");
  return Object.freeze({ value, canonicalSha256: sha256(stableJson(value)), gitBlob: gitBlob("docs/v2_booking_business_environment_evidence.json") });
}

function hypothesisMatrix({ evidence, sourceInspection, sequence }) {
  const observations = Object.fromEntries(evidence.observations.map((entry) => [entry.id, entry]));
  const delayedCopy = observations["n3-d1-local-copied-copy-only"];
  const original = observations["n3-local-original-standalone"];
  return Object.freeze([
    {
      hypothesis: "hash-copied collector or GraphQL query differs",
      classification: "evidence-against",
      basis: "source closure, function digest, query digest, and application envelope are fixed"
    },
    {
      hypothesis: "rapid consecutive requests are the sole cause",
      classification: delayedCopy.execution.precedingEvidenceDeltaMs >= 7_200_000 ? "evidence-against-as-sole-cause" : "unknown",
      basis: "a copied-only request remained challenge-blocked more than two hours later"
    },
    {
      hypothesis: "main Place fetch automatically supplies a cookie session",
      classification: sourceInspection.explicitCookieStateTokenMatches === 0 && sequence.cookieAutomaticallyForwarded === false
        ? "evidence-against"
        : "unknown",
      basis: "no cookie state code was found and Node fetch did not forward a loopback Set-Cookie"
    },
    {
      hypothesis: "main Place must precede every successful booking-business request",
      classification: original.outcome.providerStatus === 200 && original.execution.mainPlaceRequests === 0
        ? "not-required-for-the-observed-original-success"
        : "unknown",
      basis: "the N3 standalone original succeeded without a Place request"
    },
    {
      hypothesis: "OS, TLS, DNS, outbound egress, or Provider-side state explains the mismatch",
      classification: "unresolved-requires-separately-approved-render-one-shot",
      basis: "historical live runs did not capture a comparable wire/TLS/egress fingerprint"
    }
  ]);
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

function outputPath() {
  return path.join(OUTPUT_ROOT, RUN_ID, "environment-diagnostics.json");
}

async function runDiagnostics({ writeEvidence = true } = {}) {
  const runRoot = path.dirname(outputPath());
  if (writeEvidence && fsSync.existsSync(runRoot)) {
    fail("V2_BOOKING_BUSINESS_ENV_RUN_EXISTS", "D2 evidence run already exists");
  }
  const baseline = await verifyBaseline();
  verifyCommitLineage({
    baselineCommit: D1_COMMIT,
    expectedHead: String(process.env.V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT || "").trim().toLowerCase() || null,
    expectedParent: "9fd55f96834d060fb73fe658c6690f57de8a6738",
    protectedTreeEntryCount: 322,
    protectedTreeSha256: "33c33aa6298a69eeb6223731c001a0221d6f392b9d87fd74f240585a01ab89c4",
    mismatchCode: "V2_BOOKING_BUSINESS_ENV_BASELINE_MISMATCH",
    label: "D1 diagnostics commit"
  });
  if (
    baseline.collectorBlob !== V2_COLLECTOR_BLOB
    || gitBlob("scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs") !== REFERENCE_COLLECTOR_BLOB
    || baseline.lockfileSha256 !== LOCKFILE_SHA256
  ) fail("V2_BOOKING_BUSINESS_ENV_BASELINE_MISMATCH", "collector or lockfile integrity changed");

  const [evidence, sourceInspection] = await Promise.all([
    readEnvironmentEvidence(),
    sourceSessionInspection()
  ]);
  const runtime = runtimeFingerprint();
  if (
    runtime.runtime.nodeVersion !== "v26.5.0"
    || runtime.runtime.undiciVersion !== "8.7.0"
    || runtime.runtime.opensslVersion !== "3.5.7"
  ) fail("V2_BOOKING_BUSINESS_ENV_RUNTIME_MISMATCH", "Node, Undici, or OpenSSL differs from the approved runtime");

  const requestShape = expectedGraphqlRequest();
  const recorder = createTransportRecorder();
  let standalone;
  let sequence;
  let transport;
  try {
    standalone = await standaloneLoopbackProbe(requestShape);
    sequence = await sequenceLoopbackProbe(requestShape);
    transport = recorder.snapshot();
  } finally {
    recorder.close();
  }
  const standaloneAndSequenceGraphqlMatch = stableJson({
    method: standalone.method,
    httpVersion: standalone.httpVersion,
    headerNames: standalone.headerNames,
    headerOrder: standalone.headerOrder,
    implicitHeaderNames: standalone.implicitHeaderNames,
    controlledHeaderValuesMatch: standalone.controlledHeaderValuesMatch,
    cookieHeaderPresent: standalone.cookieHeaderPresent,
    bodyBytes: standalone.bodyBytes,
    bodySha256: standalone.bodySha256
  }) === stableJson({
    method: sequence.graphql.method,
    httpVersion: sequence.graphql.httpVersion,
    headerNames: sequence.graphql.headerNames,
    headerOrder: sequence.graphql.headerOrder,
    implicitHeaderNames: sequence.graphql.implicitHeaderNames,
    controlledHeaderValuesMatch: sequence.graphql.controlledHeaderValuesMatch,
    cookieHeaderPresent: sequence.graphql.cookieHeaderPresent,
    bodyBytes: sequence.graphql.bodyBytes,
    bodySha256: sequence.graphql.bodySha256
  });
  const result = Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    status: "passed",
    runId: RUN_ID,
    integrity: {
      d1Commit: D1_COMMIT,
      head: baseline.head,
      v2CollectorBlob: baseline.collectorBlob,
      referenceCollectorBlob: REFERENCE_COLLECTOR_BLOB,
      lockfileSha256: baseline.lockfileSha256,
      sourceManifestDigest: baseline.sourceManifestDigest,
      sourceFileCount: baseline.sourceFileCount
    },
    historicalEvidence: {
      canonicalSha256: evidence.canonicalSha256,
      gitBlob: evidence.gitBlob,
      observations: evidence.value.observations,
      providerRawValuesStored: false
    },
    runtime,
    sourceInspection,
    loopback: {
      standalone,
      sequence,
      standaloneAndSequenceGraphqlMatch,
      requests: 3
    },
    transport,
    hypotheses: hypothesisMatrix({ evidence: evidence.value, sourceInspection, sequence }),
    isolation: {
      providerExternalRequests: 0,
      loopbackRequests: 3,
      operationalWrites: 0,
      retries: 0,
      fallbacks: 0,
      renderChanges: 0,
      rawProviderResponsesStored: false,
      secretValuesStored: false
    },
    unknowns: [
      "historical implicit wire headers",
      "historical DNS answers and address family",
      "historical TLS protocol, cipher, ALPN, and connection reuse",
      "Render outbound egress identity and Provider reputation state",
      "Provider-side reason and duration for the HTML challenge"
    ],
    nextApproval: "N3-D2-Commit"
  });
  if (writeEvidence) await atomicJson(outputPath(), result);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "offline") {
    fail("V2_BOOKING_BUSINESS_ENV_COMMAND_INVALID", "usage: offline");
  }
  process.stdout.write(`${JSON.stringify(await runDiagnostics())}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-booking-business-environment-error.v1",
      status: "failed",
      code: String(error?.code || "V2_BOOKING_BUSINESS_ENV_FAILED"),
      retryable: false
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPLICATION_ENVELOPE_SHA256,
  CONTROLLED_GRAPHQL_HEADER_NAMES,
  D1_COMMIT,
  LOCKFILE_SHA256,
  REFERENCE_COLLECTOR_BLOB,
  RESULT_SCHEMA_VERSION,
  RUN_ID,
  V2_COLLECTOR_BLOB,
  createTransportRecorder,
  expectedGraphqlRequest,
  headerNamesFromUndici,
  hypothesisMatrix,
  outputPath,
  readEnvironmentEvidence,
  runDiagnostics,
  runtimeFingerprint,
  safeExecArgvNames,
  sequenceLoopbackProbe,
  sourceSessionInspection,
  standaloneLoopbackProbe
};
