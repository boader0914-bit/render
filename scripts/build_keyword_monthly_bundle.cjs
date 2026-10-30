"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { publishKeywordMonthlyBundle, readBundleFile, KEYWORD_MONTHLY_BUNDLE_LIMITS } = require("./lib/keyword_monthly_bundle.cjs");
const USAGE = "node scripts/build_keyword_monthly_bundle.cjs (--input <absolute prepared directory> [--input ...] | --plan <absolute JSON>) --output <absolute bundle directory> --now <fixed ISO> [--expected-current-sha <64hex|absent>] [--max-total-bytes <integer>]";
function fail(code) { throw Object.assign(new Error(code), { code }); }
function args(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  const result = { inputs: [] }, allowed = new Set(["input", "plan", "output", "now", "expected-current-sha", "max-total-bytes"]);
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.slice(2), value = values[i + 1];
    if (!values[i]?.startsWith("--") || !allowed.has(key) || !value || value.startsWith("--") || key !== "input" && Object.hasOwn(result, key)) fail("KEYWORD_MONTHLY_BUNDLE_CLI_ARGUMENTS");
    if (key === "input") result.inputs.push({ directory: value }); else result[key] = value;
  }
  if ((!result.inputs.length && !result.plan) || result.inputs.length && result.plan || !result.output || !result.now) fail("KEYWORD_MONTHLY_BUNDLE_CLI_REQUIRED_ARGUMENTS");
  if ([result.output, result.plan, ...result.inputs.map(row => row.directory)].filter(Boolean).some(value => !path.isAbsolute(value))) fail("KEYWORD_MONTHLY_BUNDLE_CLI_ABSOLUTE_PATH_REQUIRED");
  if (!/^20\d{2}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result.now) || !Number.isFinite(Date.parse(result.now))
    || new Date(`${result.now.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== result.now.slice(0, 10)) fail("KEYWORD_MONTHLY_BUNDLE_CLI_FIXED_CLOCK_REQUIRED");
  if (result["expected-current-sha"] && result["expected-current-sha"] !== "absent" && !/^[a-f0-9]{64}$/.test(result["expected-current-sha"])) fail("KEYWORD_MONTHLY_BUNDLE_CLI_EXPECTED_POINTER");
  if (result["max-total-bytes"] && (!/^\d+$/.test(result["max-total-bytes"]) || !Number.isSafeInteger(Number(result["max-total-bytes"])))) fail("KEYWORD_MONTHLY_BUNDLE_CLI_TOTAL_BOUND");
  return result;
}
function networkGuard() {
  let attempts = 0; const restores = [];
  const patch = (object, key) => { const old = object[key]; if (typeof old !== "function") return; object[key] = () => { attempts++; fail("KEYWORD_MONTHLY_BUNDLE_CLI_NETWORK_BLOCKED"); }; restores.push(() => { object[key] = old; }); };
  patch(globalThis, "fetch"); patch(globalThis, "WebSocket");
  for (const name of ["node:http", "node:https"]) for (const key of ["get", "request"]) patch(require(name), key);
  for (const key of ["connect", "createConnection"]) patch(require("node:net"), key); patch(require("node:net").Socket.prototype, "connect"); patch(require("node:tls"), "connect");
  for (const key of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) patch(require("node:child_process"), key);
  return { count: () => attempts, restore() { for (const fn of restores.reverse()) fn(); } };
}
async function run(values) {
  const input = args(values); if (input.help) { console.log(USAGE); return null; }
  const guard = networkGuard(); let planRead;
  try {
    let inputs = input.inputs;
    if (input.plan) {
      planRead = await readBundleFile(input.plan, KEYWORD_MONTHLY_BUNDLE_LIMITS.catalogBytes); const plan = JSON.parse(planRead.bytes.toString("utf8"));
      if (!plan || plan.schemaVersion !== 1 || Object.keys(plan).some(key => !["schemaVersion", "inputs"].includes(key)) || !Array.isArray(plan.inputs)) fail("KEYWORD_MONTHLY_BUNDLE_CLI_PLAN"); inputs = plan.inputs;
    }
    const receipt = await publishKeywordMonthlyBundle({ inputs, outputDir: path.resolve(input.output), now: input.now,
      expectedCurrentSha256: input["expected-current-sha"] && input["expected-current-sha"] !== "absent" ? input["expected-current-sha"] : null,
      maxTotalBytes: input["max-total-bytes"] === undefined ? KEYWORD_MONTHLY_BUNDLE_LIMITS.defaultTotalBytes : Number(input["max-total-bytes"]),
      beforePromote: async () => {
        if (guard.count()) fail("KEYWORD_MONTHLY_BUNDLE_CLI_NETWORK_BLOCKED");
        if (planRead && (await readBundleFile(input.plan, KEYWORD_MONTHLY_BUNDLE_LIMITS.catalogBytes)).sha256 !== planRead.sha256) fail("KEYWORD_MONTHLY_BUNDLE_CLI_PLAN_CHANGED");
      } });
    console.log(JSON.stringify({ status: receipt.status, bundleDir: receipt.bundleDir, generation: receipt.generation, pointerSha256: receipt.pointerSha256, catalogSha256: receipt.catalogSha256,
      partitionCount: receipt.partitionCount, scopeCount: receipt.scopeCount, totalStoredBytes: receipt.totalStoredBytes, networkAttempts: guard.count(), providerCalls: 0,
      receipt: path.join(receipt.bundleDir, "generations", receipt.generation, "publication-receipt.json") })); return receipt;
  } finally { guard.restore(); }
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ code: /^KEYWORD_MONTHLY_[A-Z0-9_]+$/.test(error.code || "") ? error.code : "KEYWORD_MONTHLY_BUNDLE_CLI_FAILED",
  ...(error.publicationState ? { publicationState: error.publicationState, generation: error.generation, pointerSha256: error.pointerSha256 } : {}),
  ...(error.scope ? { scope: error.scope, inputStatus: error.inputStatus, diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics.filter(value => typeof value === "string" && /^[A-Z0-9_]+$/.test(value)) : [] } : {}) })); process.exitCode = 1; });
module.exports = { args, run, USAGE };
