"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  BASELINE_COMMIT,
  D4_READINESS_BLOB,
  DUPLICATE_EVENT,
  ERROR_SCHEMA_VERSION,
  FAILURE_SCHEMA_VERSION,
  INNER_GATE_NAMES,
  LIVE_APPROVAL_NAME,
  LIVE_GATE_NAMES,
  LOCAL_STATE_ROOT,
  REPLAY_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  SUCCESS_SCHEMA_VERSION,
  TERMINAL_EVENT,
  TERMINAL_RECORD_SCHEMA_VERSION,
  TERMINAL_SCHEMA_VERSION,
  V2N5RenderLiveAdapterError,
  assertLiveGates,
  innerLiveEnvironment,
  liveStateRoot,
  main,
  runLiveOnce,
  safeErrorProjection,
  sha256,
  stableJson,
  statePaths,
  validateTerminalRecord,
  verifyD4ReadinessIdentity,
  verifyLiveIntegrity
} = require("./v2_naver_place_room_provider_marker_render_live_adapter.cjs");
const {
  JOB_CANONICAL_SHA256,
  JOB_RUN_ID,
  RENDER_STATE_ROOT
} = require("./v2_naver_place_room_provider_marker_render_readiness.cjs");
const { LIVE_APPROVAL_NAME: INNER_LIVE_APPROVAL_NAME } = require("./v2_naver_place_room_provider_marker_live_one_shot.cjs");

const ROOT = path.resolve(__dirname, "..");
const INHERITED_CHILD_ENV_PREFIXES = Object.freeze([
  "RENDER_",
  "V2_N5_RENDER_",
  "V2_NAVER_ROOM_MARKER_"
]);
const SESSION_ROOT = path.join(LOCAL_STATE_ROOT, `test-${process.pid}`);
const POSITIVE_HTML = fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "v2_naver_place_room_provider_marker_positive.sanitized.html"),
  "utf8"
);
let assertions = 0;

function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function throws(fn, validator) {
  assertions += 1;
  assert.throws(fn, validator);
}

async function rejects(fn, validator) {
  assertions += 1;
  await assert.rejects(fn, validator);
}

async function rejection(fn) {
  let captured = null;
  try {
    await fn();
  } catch (error) {
    captured = error;
  }
  ok(captured, "Expected rejection");
  return captured;
}

function assertSessionPath(target) {
  const root = path.resolve(SESSION_ROOT);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if ((!relative && resolved !== root) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to mutate a path outside the isolated N5-D5 test root");
  }
  return resolved;
}

function resetSessionRoot() {
  const target = assertSessionPath(SESSION_ROOT);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function cleanupSessionRoot() {
  fs.rmSync(assertSessionPath(SESSION_ROOT), { recursive: true, force: true });
}

function stateDir(name) {
  return path.join(SESSION_ROOT, name);
}

function liveEnv(name, overrides = {}) {
  return {
    V2_N5_RENDER_RUN_ENABLED: "1",
    V2_N5_RENDER_REQUEST_BUDGET: "1",
    V2_N5_RENDER_AUTOMATIC_RETRY: "0",
    V2_N5_RENDER_FALLBACK: "0",
    V2_N5_RENDER_OPERATIONAL_WRITES: "0",
    V2_N5_RENDER_LIVE_APPROVED: LIVE_APPROVAL_NAME,
    V2_N5_RENDER_APPROVED_JOB_SHA256: JOB_CANONICAL_SHA256,
    V2_N5_RENDER_STATE_DIR: stateDir(name),
    ...overrides
  };
}

function isolatedChildEnv(overrides, inherited = process.env) {
  const childEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    const normalizedName = name.toUpperCase();
    if (INHERITED_CHILD_ENV_PREFIXES.some((prefix) => normalizedName.startsWith(prefix))) continue;
    childEnv[name] = value;
  }
  return { ...childEnv, ...overrides };
}

function fixtureTransport(body, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if (options.error) throw options.error;
    const response = new Response(body, {
      status: options.status ?? 200,
      headers: {
        "content-type": options.contentType ?? "text/html; charset=utf-8",
        ...(options.headers || {})
      }
    });
    Object.defineProperty(response, "url", {
      value: "https://pcmap.place.naver.com/accommodation/35644668/home"
    });
    return response;
  };
  return { calls, fetchImpl };
}

function allFileText(root) {
  if (!fs.existsSync(root)) return "";
  const chunks = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else chunks.push(fs.readFileSync(target, "utf8"));
    }
  };
  visit(root);
  return chunks.join("\n");
}

function exerciseDuplicateProcess(env) {
  return new Promise((resolve, reject) => {
    const runner = path.join(__dirname, "v2_naver_place_room_provider_marker_render_live_adapter.cjs");
    const preload = path.join(__dirname, "fixture_network_guard_preload.cjs");
    const child = spawn(process.execPath, ["--require", preload, runner, "live-and-hold"], {
      cwd: ROOT,
      env: isolatedChildEnv({
        ...env,
        V2_NAVER_ROOM_MARKER_LIVE_APPROVED: "",
        V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "",
        V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: ""
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let observed = null;
    let survived = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("duplicate live-and-hold process timed out"));
      }
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.trim().split(/\r?\n/gu)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === DUPLICATE_EVENT && !observed) {
            observed = parsed;
            setTimeout(() => {
              survived = child.exitCode === null;
              child.kill("SIGTERM");
            }, 1_000);
          }
        } catch {
          // Framing is asserted after process exit.
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr, observed, survived });
    });
  });
}

(async () => {
  resetSessionRoot();
  const guard = installFixtureNetworkGuard({ label: "N5-D5 Render live adapter tests" });
  try {
    equal(process.version, "v26.5.0");
    equal(BASELINE_COMMIT, "583c873bb5ec41e8334ecd910db5393c5991de72");
    equal(D4_READINESS_BLOB, "1c97c51b3d5dfd99c0a68733252127a4b582fdbe");
    equal(JOB_RUN_ID, "n5-room-marker-render-live-20260814-001");
    equal(JOB_CANONICAL_SHA256, "bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7");
    equal(LIVE_APPROVAL_NAME, "N5-D5-Live");
    equal(INNER_LIVE_APPROVAL_NAME, "N5-D3-Live");
    deepEqual(LIVE_GATE_NAMES, ["V2_N5_RENDER_LIVE_APPROVED", "V2_N5_RENDER_APPROVED_JOB_SHA256"]);
    deepEqual(INNER_GATE_NAMES, [
      "V2_NAVER_ROOM_MARKER_LIVE_APPROVED",
      "V2_NAVER_ROOM_MARKER_REQUEST_BUDGET",
      "V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256"
    ]);
    equal(await verifyD4ReadinessIdentity(), D4_READINESS_BLOB);

    const inheritedChildEnv = {
      PATH: "fixture-path",
      RENDER_SERVICE_ID: "srv-inherited-render-parent",
      RENDER_GIT_COMMIT: "a".repeat(40),
      V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT: "a".repeat(40),
      V2_N5_RENDER_RUN_ENABLED: "0",
      V2_N5_RENDER_LIVE_APPROVED: "parent-live-gate",
      V2_NAVER_ROOM_MARKER_LIVE_APPROVED: "parent-inner-gate"
    };
    const isolatedLiveEnv = isolatedChildEnv(liveEnv("child-env-isolation"), inheritedChildEnv);
    equal(isolatedLiveEnv.PATH, "fixture-path");
    equal(isolatedLiveEnv.RENDER_SERVICE_ID, undefined);
    equal(isolatedLiveEnv.RENDER_GIT_COMMIT, undefined);
    equal(isolatedLiveEnv.V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT, undefined);
    equal(isolatedLiveEnv.V2_N5_RENDER_RUN_ENABLED, "1");
    equal(isolatedLiveEnv.V2_N5_RENDER_LIVE_APPROVED, LIVE_APPROVAL_NAME);
    equal(isolatedLiveEnv.V2_NAVER_ROOM_MARKER_LIVE_APPROVED, undefined);
    equal(isolatedLiveEnv.V2_N5_RENDER_STATE_DIR, stateDir("child-env-isolation"));

    const integrity = await verifyLiveIntegrity(liveEnv("integrity"));
    equal(integrity.liveAdapterBaselineCommit, BASELINE_COMMIT);
    equal(integrity.d4ReadinessBlob, D4_READINESS_BLOB);
    equal(integrity.jobRunId, JOB_RUN_ID);
    equal(integrity.jobCanonicalSha256, JOB_CANONICAL_SHA256);
    equal(integrity.frozenCollectorBlob, "bcbe229998da3afa6f31ee04375fb0766019e56f");
    equal(integrity.currentCollectorBlob, "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3");
    equal(integrity.packageLockSha256, "d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e");

    const validEnv = liveEnv("gate-valid");
    equal(assertLiveGates(validEnv), true);
    equal(liveStateRoot(validEnv), path.resolve(stateDir("gate-valid")));
    const inner = innerLiveEnvironment();
    deepEqual(inner, {
      V2_NAVER_ROOM_MARKER_LIVE_APPROVED: "N5-D3-Live",
      V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "1",
      V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: JOB_CANONICAL_SHA256
    });
    for (const name of [
      "V2_N5_RENDER_RUN_ENABLED",
      "V2_N5_RENDER_REQUEST_BUDGET",
      "V2_N5_RENDER_AUTOMATIC_RETRY",
      "V2_N5_RENDER_FALLBACK",
      "V2_N5_RENDER_OPERATIONAL_WRITES",
      "V2_N5_RENDER_LIVE_APPROVED",
      "V2_N5_RENDER_APPROVED_JOB_SHA256"
    ]) {
      const invalid = { ...validEnv };
      delete invalid[name];
      throws(() => assertLiveGates(invalid), (error) => error?.code === "V2_N5_RENDER_LIVE_GATE_INVALID");
    }
    for (const name of INNER_GATE_NAMES) {
      throws(
        () => assertLiveGates({ ...validEnv, [name]: "direct-gate-forbidden" }),
        (error) => error?.code === "V2_N5_RENDER_LIVE_GATE_INVALID"
      );
    }
    throws(
      () => liveStateRoot({ ...validEnv, V2_N5_RENDER_STATE_DIR: LOCAL_STATE_ROOT }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    throws(
      () => liveStateRoot({ ...validEnv, V2_N5_RENDER_STATE_DIR: path.resolve(ROOT, "outside-n5-d5") }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    throws(
      () => liveStateRoot({ ...validEnv, V2_N5_RENDER_STATE_DIR: "relative-state" }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    equal(liveStateRoot({
      ...validEnv,
      RENDER_SERVICE_ID: "srv-n5-d5-fixture",
      V2_N5_RENDER_STATE_DIR: RENDER_STATE_ROOT
    }), RENDER_STATE_ROOT);
    throws(
      () => liveStateRoot({
        ...validEnv,
        RENDER_SERVICE_ID: "srv-n5-d5-fixture",
        V2_N5_RENDER_STATE_DIR: "/var/data/not-approved"
      }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );

    const gateBlockedPath = stateDir("gate-blocked-before-state");
    await rejects(
      () => runLiveOnce({
        env: liveEnv("gate-blocked-before-state", { V2_N5_RENDER_RUN_ENABLED: "0" }),
        fetchImpl: async () => {
          throw new Error("must not execute");
        }
      }),
      (error) => error?.code === "V2_N5_RENDER_LIVE_GATE_INVALID"
    );
    equal(fs.existsSync(gateBlockedPath), false);

    const successTransport = fixtureTransport(POSITIVE_HTML);
    const success = await runLiveOnce({
      env: liveEnv("success"),
      fetchImpl: successTransport.fetchImpl,
      nowFn: () => new Date("2026-08-14T00:00:00.000Z")
    });
    equal(success.schemaVersion, RESULT_SCHEMA_VERSION);
    equal(success.event, "n5_room_provider_marker_render_terminal_committed");
    equal(success.status, "terminal-committed");
    equal(success.runId, JOB_RUN_ID);
    equal(success.jobCanonicalSha256, JOB_CANONICAL_SHA256);
    equal(success.terminalStatus, "succeeded");
    equal(success.terminal.schemaVersion, TERMINAL_SCHEMA_VERSION);
    equal(success.terminal.event, TERMINAL_EVENT);
    equal(success.terminal.status, "succeeded");
    equal(success.terminal.result.schemaVersion, SUCCESS_SCHEMA_VERSION);
    equal(success.terminal.result.placeId, "35644668");
    equal(success.terminal.result.roomCount, 6);
    equal(success.terminal.result.providerMarker.standardChannelId, "campingtalk");
    equal(success.terminal.result.evidence.level, "high");
    equal(success.terminal.error, null);
    equal(success.currentInvocation.externalRequestAttempts, 1);
    equal(success.currentInvocation.collectorInvocations, 1);
    equal(success.currentInvocation.diagnosticStateWrites, 2);
    equal(success.currentInvocation.operationalWrites, 0);
    equal(successTransport.calls.length, 1);
    equal(successTransport.calls[0].input, "https://pcmap.place.naver.com/accommodation/35644668/home");
    equal(successTransport.calls[0].init.method, "GET");
    equal(successTransport.calls[0].init.redirect, "manual");

    const successPaths = statePaths(stateDir("success"));
    equal(fs.existsSync(successPaths.claimPath), true);
    equal(fs.existsSync(successPaths.terminalPath), true);
    const claim = JSON.parse(fs.readFileSync(successPaths.claimPath, "utf8"));
    equal(claim.schemaVersion, "v2-naver-room-provider-marker-render-claim.v1");
    equal(claim.runId, JOB_RUN_ID);
    equal(claim.jobCanonicalSha256, JOB_CANONICAL_SHA256);
    equal(claim.requestBudget, 1);
    equal(claim.claimedAt, "2026-08-14T00:00:00.000Z");
    equal(claim.operationalWrites, 0);
    equal(claim.rawProviderResponseStored, false);
    equal(claim.liveAdapterBaselineCommit, BASELINE_COMMIT);
    equal(claim.frozenCollectorBlob, "bcbe229998da3afa6f31ee04375fb0766019e56f");
    equal(claim.runnerBlob, "70eb4024b8c623569d13666a0757738c447df214");
    equal(claim.contractBlob, "0098a89d940fb4436ac7fa9810e7e6582870d7c2");
    equal(claim.packageLockSha256, "d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e");
    const storedSuccess = JSON.parse(fs.readFileSync(successPaths.terminalPath, "utf8"));
    equal(storedSuccess.schemaVersion, TERMINAL_RECORD_SCHEMA_VERSION);
    equal(validateTerminalRecord(storedSuccess), true);
    equal(storedSuccess.terminalSha256, success.terminalSha256);
    equal(storedSuccess.terminalSha256, sha256(stableJson(storedSuccess.terminal)));

    let replayFetches = 0;
    const replay = await runLiveOnce({
      env: liveEnv("success"),
      fetchImpl: async () => {
        replayFetches += 1;
        throw new Error("duplicate must not call transport");
      }
    });
    equal(replay.schemaVersion, REPLAY_SCHEMA_VERSION);
    equal(replay.event, DUPLICATE_EVENT);
    equal(replay.status, "duplicate-replayed");
    equal(replay.terminalStatus, "succeeded");
    equal(replay.terminalSha256, success.terminalSha256);
    deepEqual(replay.terminal, success.terminal);
    equal(replay.currentInvocation.externalRequestAttempts, 0);
    equal(replay.currentInvocation.collectorInvocations, 0);
    equal(replay.currentInvocation.diagnosticStateWrites, 0);
    equal(replay.currentInvocation.operationalWrites, 0);
    equal(replayFetches, 0);

    const duplicateProcess = await exerciseDuplicateProcess(liveEnv("success"));
    ok(duplicateProcess.observed, "live-and-hold must emit the persisted duplicate terminal");
    equal(duplicateProcess.observed.status, "duplicate-replayed");
    equal(duplicateProcess.observed.terminalSha256, success.terminalSha256);
    equal(duplicateProcess.observed.currentInvocation.externalRequestAttempts, 0);
    equal(duplicateProcess.observed.currentInvocation.collectorInvocations, 0);
    equal(duplicateProcess.survived, true);
    equal(duplicateProcess.code === 0 || duplicateProcess.signal === "SIGTERM", true);
    equal(duplicateProcess.stderr, "");
    equal(duplicateProcess.stdout.trim().split(/\r?\n/gu).length, 1);

    const secret = "n5-d5-secret-sentinel-must-not-leak";
    const blockedBody = `<html><body>captcha ${secret}</body></html>`;
    const blockedTransport = fixtureTransport(blockedBody, {
      status: 403,
      headers: { "set-cookie": `session=${secret}`, "x-secret": secret }
    });
    const blocked = await runLiveOnce({ env: liveEnv("blocked-403"), fetchImpl: blockedTransport.fetchImpl });
    equal(blocked.terminalStatus, "failed");
    equal(blocked.terminal.result, null);
    equal(blocked.terminal.error.schemaVersion, FAILURE_SCHEMA_VERSION);
    equal(blocked.terminal.error.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(blocked.terminal.error.retryable, false);
    equal(blocked.terminal.error.diagnostic.blockSubtype, "http_403");
    equal(blocked.terminal.error.diagnostic.actualExternalRequests, 1);
    equal(blocked.terminal.externalRequestAttempts, 1);
    equal(blocked.terminal.collectorInvocations, 1);
    equal(blocked.terminal.operationalWrites, 0);
    equal(blockedTransport.calls.length, 1);
    equal(JSON.stringify(blocked).includes(secret), false);
    equal(allFileText(stateDir("blocked-403")).includes(secret), false);
    equal(allFileText(stateDir("blocked-403")).includes("set-cookie"), false);

    const blockedReplay = await runLiveOnce({
      env: liveEnv("blocked-403"),
      fetchImpl: async () => {
        throw new Error("failed terminal replay must not call transport");
      }
    });
    equal(blockedReplay.status, "duplicate-replayed");
    equal(blockedReplay.terminalStatus, "failed");
    equal(blockedReplay.terminalSha256, blocked.terminalSha256);
    equal(blockedReplay.currentInvocation.externalRequestAttempts, 0);

    const rateLimited = await runLiveOnce({
      env: liveEnv("blocked-429"),
      fetchImpl: fixtureTransport("<html><body>limited</body></html>", {
        status: 429,
        headers: { "retry-after": "120" }
      }).fetchImpl
    });
    equal(rateLimited.terminalStatus, "failed");
    equal(rateLimited.terminal.error.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(rateLimited.terminal.error.diagnostic.blockSubtype, "http_429");
    equal(rateLimited.terminal.error.diagnostic.retryAfterPresent, true);
    equal(JSON.stringify(rateLimited).includes("120"), false);

    const challenged = await runLiveOnce({
      env: liveEnv("challenge"),
      fetchImpl: fixtureTransport("<!doctype html><html><body>captcha verification</body></html>").fetchImpl
    });
    equal(challenged.terminalStatus, "failed");
    equal(challenged.terminal.error.code, "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED");
    equal(challenged.terminal.error.diagnostic.blockSubtype, "challenge_html");

    const abortError = new Error("timeout details must not persist");
    abortError.name = "AbortError";
    const timeout = await runLiveOnce({
      env: liveEnv("timeout"),
      fetchImpl: fixtureTransport("", { error: abortError }).fetchImpl
    });
    equal(timeout.terminalStatus, "failed");
    equal(timeout.terminal.error.code, "V2_NAVER_ROOM_MARKER_TIMEOUT");
    equal(timeout.terminal.error.diagnostic, null);
    equal(timeout.terminal.automaticRetry, false);

    const poisonedError = new Error(secret);
    poisonedError.code = secret;
    const genericFailure = await runLiveOnce({
      env: liveEnv("generic-failure"),
      fetchImpl: fixtureTransport("", { error: poisonedError }).fetchImpl
    });
    equal(genericFailure.terminalStatus, "failed");
    equal(genericFailure.terminal.error.code, "V2_NAVER_ROOM_MARKER_LIVE_FAILED");
    equal(JSON.stringify(genericFailure).includes(secret), false);
    equal(allFileText(stateDir("generic-failure")).includes(secret), false);

    const partialTransport = fixtureTransport(POSITIVE_HTML);
    const partialError = await rejection(() => runLiveOnce({
      env: liveEnv("partial-terminal"),
      fetchImpl: partialTransport.fetchImpl,
      terminalWriter: async () => {
        throw new Error(secret);
      }
    }));
    equal(partialError.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(partialError.stage, "terminal-commit");
    equal(partialError.externalRequestAttempts, 1);
    equal(partialError.collectorInvocations, 1);
    equal(partialError.diagnosticStateWrites, 1);
    equal(partialTransport.calls.length, 1);
    const partialPaths = statePaths(stateDir("partial-terminal"));
    equal(fs.existsSync(partialPaths.claimPath), true);
    equal(fs.existsSync(partialPaths.terminalPath), false);

    let uncertainReplayFetches = 0;
    const uncertainReplay = await rejection(() => runLiveOnce({
      env: liveEnv("partial-terminal"),
      fetchImpl: async () => {
        uncertainReplayFetches += 1;
        return new Response(POSITIVE_HTML);
      }
    }));
    equal(uncertainReplay.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(uncertainReplay.stage, "duplicate-replay");
    equal(uncertainReplay.externalRequestAttempts, 0);
    equal(uncertainReplay.collectorInvocations, 0);
    equal(uncertainReplayFetches, 0);
    const uncertainProjection = safeErrorProjection(uncertainReplay);
    equal(uncertainProjection.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(uncertainProjection.event, "n5_room_provider_marker_render_result_uncertain");
    equal(uncertainProjection.status, "result-uncertain");
    equal(uncertainProjection.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(uncertainProjection.externalRequestAttempts, 0);
    equal(uncertainProjection.automaticRetry, false);
    equal(uncertainProjection.operationalWrites, 0);
    equal(JSON.stringify(uncertainProjection).includes(secret), false);

    const corruptTransport = fixtureTransport(POSITIVE_HTML);
    await runLiveOnce({ env: liveEnv("corrupt-terminal"), fetchImpl: corruptTransport.fetchImpl });
    const corruptPaths = statePaths(stateDir("corrupt-terminal"));
    const corrupt = JSON.parse(fs.readFileSync(corruptPaths.terminalPath, "utf8"));
    corrupt.terminal.operationalWrites = 1;
    fs.writeFileSync(corruptPaths.terminalPath, `${JSON.stringify(corrupt)}\n`, "utf8");
    let corruptReplayFetches = 0;
    const corruptError = await rejection(() => runLiveOnce({
      env: liveEnv("corrupt-terminal"),
      fetchImpl: async () => {
        corruptReplayFetches += 1;
        return new Response(POSITIVE_HTML);
      }
    }));
    equal(corruptError.code, "V2_N5_RENDER_TERMINAL_INVALID");
    equal(corruptReplayFetches, 0);

    const orphanPaths = statePaths(stateDir("orphan-terminal"));
    fs.mkdirSync(orphanPaths.terminalsRoot, { recursive: true });
    fs.writeFileSync(orphanPaths.terminalPath, `${JSON.stringify(storedSuccess)}\n`, "utf8");
    let orphanFetches = 0;
    const orphanError = await rejection(() => runLiveOnce({
      env: liveEnv("orphan-terminal"),
      fetchImpl: async () => {
        orphanFetches += 1;
        return new Response(POSITIVE_HTML);
      }
    }));
    equal(orphanError.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(orphanError.stage, "terminal-precondition");
    equal(orphanError.externalRequestAttempts, 0);
    equal(orphanError.collectorInvocations, 0);
    equal(orphanFetches, 0);

    let releaseConcurrent;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const release = new Promise((resolve) => { releaseConcurrent = resolve; });
    let concurrentFetches = 0;
    const concurrentFetch = async () => {
      concurrentFetches += 1;
      markStarted();
      await release;
      const response = new Response(POSITIVE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "https://pcmap.place.naver.com/accommodation/35644668/home" });
      return response;
    };
    const firstConcurrent = runLiveOnce({ env: liveEnv("concurrent"), fetchImpl: concurrentFetch });
    await started;
    const secondConcurrentError = await rejection(() => runLiveOnce({
      env: liveEnv("concurrent"),
      fetchImpl: async () => {
        concurrentFetches += 1;
        return new Response(POSITIVE_HTML);
      }
    }));
    equal(secondConcurrentError.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(secondConcurrentError.externalRequestAttempts, 0);
    releaseConcurrent();
    const firstConcurrentResult = await firstConcurrent;
    equal(firstConcurrentResult.terminalStatus, "succeeded");
    equal(concurrentFetches, 1);
    const afterConcurrent = await runLiveOnce({
      env: liveEnv("concurrent"),
      fetchImpl: async () => {
        concurrentFetches += 1;
        return new Response(POSITIVE_HTML);
      }
    });
    equal(afterConcurrent.status, "duplicate-replayed");
    equal(afterConcurrent.currentInvocation.externalRequestAttempts, 0);
    equal(concurrentFetches, 1);

    const safeUnknown = safeErrorProjection(new Error(secret));
    equal(safeUnknown.code, "V2_N5_RENDER_STORAGE_FAILED");
    equal(safeUnknown.externalRequestAttempts, 0);
    equal(JSON.stringify(safeUnknown).includes(secret), false);
    const explicit = safeErrorProjection(new V2N5RenderLiveAdapterError(
      "V2_N5_RENDER_RESULT_UNCERTAIN",
      secret,
      { stage: "terminal-commit", externalRequestAttempts: 1, collectorInvocations: 1, diagnosticStateWrites: 1 }
    ));
    equal(explicit.code, "V2_N5_RENDER_RESULT_UNCERTAIN");
    equal(explicit.externalRequestAttempts, 1);
    equal(explicit.collectorInvocations, 1);
    equal(explicit.diagnosticStateWrites, 1);
    equal(JSON.stringify(explicit).includes(secret), false);
    const poisonedStage = safeErrorProjection(new V2N5RenderLiveAdapterError(
      "V2_N5_RENDER_RESULT_UNCERTAIN",
      "safe",
      { stage: secret }
    ));
    equal(poisonedStage.stage, "adapter");
    equal(JSON.stringify(poisonedStage).includes(secret), false);

    const framed = [];
    let held = 0;
    const simulatedTerminal = Object.freeze({ event: "simulated_safe_terminal", status: "terminal-committed" });
    const mainResult = await main(["live-and-hold"], {
      runLiveOnceFn: async () => simulatedTerminal,
      writeOutput: (value) => framed.push(JSON.stringify(value)),
      holdFn: async () => { held += 1; }
    });
    deepEqual(mainResult, simulatedTerminal);
    deepEqual(framed, [JSON.stringify(simulatedTerminal)]);
    equal(held, 1);

    const framedErrors = [];
    let errorHeld = 0;
    const mainFailure = await main(["live-and-hold"], {
      runLiveOnceFn: async () => {
        throw new V2N5RenderLiveAdapterError("V2_N5_RENDER_RESULT_UNCERTAIN", secret, {
          stage: "duplicate-replay",
          diagnosticStateWrites: 1
        });
      },
      writeOutput: (value) => framedErrors.push(JSON.stringify(value)),
      holdFn: async () => { errorHeld += 1; }
    });
    equal(mainFailure.status, "result-uncertain");
    equal(framedErrors.length, 1);
    equal(framedErrors[0].includes(secret), false);
    equal(errorHeld, 1);

    const source = fs.readFileSync(
      path.join(__dirname, "v2_naver_place_room_provider_marker_render_live_adapter.cjs"),
      "utf8"
    );
    equal((source.match(/await runner\(/gu) || []).length, 1);
    equal(/automaticRetry:\s*true/gu.test(source), false);
    equal(/operationalWrites:\s*[1-9]/gu.test(source), false);
    equal(/rawProviderResponseStored:\s*true/gu.test(source), false);
    equal(allFileText(SESSION_ROOT).includes(secret), false);
    equal(guard.blockedAttempts(), 0);

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-naver-room-provider-marker-render-live-adapter-test.v1",
      status: "passed",
      assertions,
      mockCollectorInvocations: 9,
      duplicateReplays: 4,
      uncertainReplays: 3,
      actualExternalRequests: 0,
      automaticRetries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: 0
    })}\n`);
  } finally {
    guard.restore();
    cleanupSessionRoot();
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
