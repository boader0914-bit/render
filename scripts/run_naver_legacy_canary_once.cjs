"use strict";

const {
  TARGET_PREVIEW_RUNTIME_ROOT,
  inspectNaverLegacyCanaryOnce,
  runNaverLegacyCanaryOnce,
  safeCanaryErrorResult
} = require("./naver_legacy_canary_once.cjs");

const MAX_STDIN_BYTES = 16 * 1024;

function cliError(code) {
  const error = new Error("NAVER legacy canary CLI input is invalid");
  error.code = code;
  error.statusCode = 400;
  error.externalAttemptCount = 0;
  return error;
}

async function readBoundedStdin(stream, maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunkValue of stream) {
    const chunk = Buffer.from(chunkValue);
    total += chunk.length;
    if (total > maxBytes) throw cliError("NAVER_LEGACY_CANARY_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  let source = Buffer.concat(chunks, total).toString("utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  source = source.trim();
  if (!source) throw cliError("NAVER_LEGACY_CANARY_INPUT_REQUIRED");
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid envelope");
    return value;
  } catch (error) {
    if (error?.code) throw error;
    throw cliError("NAVER_LEGACY_CANARY_INPUT_INVALID");
  }
}

function assertEnvelopeKeys(envelope, expected) {
  const actual = Object.keys(envelope).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw cliError("NAVER_LEGACY_CANARY_INPUT_INVALID");
  }
}

async function runCliAction(action, envelope, options = {}) {
  const fixtureMode = options.fixtureMode === true;
  const environment = fixtureMode ? (options.environment || {}) : process.env;
  const runtimeRoot = options.runtimeRoot || environment.V2_PREVIEW_DATA_ROOT || TARGET_PREVIEW_RUNTIME_ROOT;
  if (action === "plan") {
    assertEnvelopeKeys(envelope, ["contract", "targetCommit"]);
    return inspectNaverLegacyCanaryOnce({
      contract: envelope.contract,
      targetCommit: envelope.targetCommit,
      environment,
      runtimeRoot,
      fixtureMode,
      providerStore: options.providerStore,
      runtimeIdentityValidator: options.runtimeIdentityValidator,
      now: options.now,
      store: options.store
    });
  }
  if (action === "execute") {
    assertEnvelopeKeys(envelope, ["approval", "contract"]);
    return runNaverLegacyCanaryOnce({
      approval: envelope.approval,
      contract: envelope.contract,
      environment,
      runtimeRoot,
      fixtureMode,
      providerStore: options.providerStore,
      runtimeIdentityValidator: options.runtimeIdentityValidator,
      fetchImpl: options.fetchImpl,
      transport: options.transport,
      signal: options.signal,
      now: options.now,
      completedAt: options.completedAt,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      store: options.store
    });
  }
  throw cliError("NAVER_LEGACY_CANARY_ACTION_INVALID");
}

async function runCliMain(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  let result;
  let exitCode = 0;
  try {
    if (!Array.isArray(argv) || argv.length !== 1) {
      throw cliError("NAVER_LEGACY_CANARY_ACTION_INVALID");
    }
    const action = String(argv[0] || "").trim().toLowerCase();
    if (!["plan", "execute"].includes(action)) {
      throw cliError("NAVER_LEGACY_CANARY_ACTION_INVALID");
    }
    if (stdin?.isTTY === true) {
      throw cliError("NAVER_LEGACY_CANARY_STDIN_REQUIRED");
    }
    const envelope = await readBoundedStdin(stdin);
    result = await runCliAction(action, envelope, options);
  } catch (error) {
    result = safeCanaryErrorResult(error);
    exitCode = 1;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return exitCode;
}

async function main(options = {}) {
  return runCliMain(options);
}

if (require.main === module) {
  runCliMain().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_STDIN_BYTES,
  main,
  readBoundedStdin,
  runCliAction,
  runCliMain
};
