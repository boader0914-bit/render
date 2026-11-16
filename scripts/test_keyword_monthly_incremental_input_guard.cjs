"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const codeRoot = path.resolve(__dirname, "..");

async function strictCase(options) {
  const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
  const { metadataInventory, verifyInventory } = require(path.join(options.codeRoot, "scripts/lib/keyword_monthly_incremental_inputs.cjs"));
  const { installGuards } = require(path.join(options.codeRoot, "scripts/reconstruct_keyword_monthly_source_copy.cjs"));
  const { dataDir, namespace, kind } = options, outputDir = path.join(dataDir, "outputs/run"), before = await metadataInventory({ dataDir });
  const originalReaddir = fs.readdir, externalWrite = fs.writeFile;
  if (kind === "new-file") await fs.writeFile(path.join(outputDir, "traffic_metrics.json"), '{"fixture":true}');
  if (kind === "new-directory") await fs.mkdir(path.join(outputDir, "new-directory"));
  if (kind === "changed-file") await fs.writeFile(path.join(outputDir, "manifest.json"), '{"fixture":"changed"}');
  let mutation = false;
  if (kind === "changed-during-list") fs.readdir = async (directory, ...args) => {
    const entries = await originalReaddir(directory, ...args);
    // A saved pre-guard primitive simulates an independent writer in this
    // disposable fixture. The guarded application receives no write exemption.
    if (!mutation && directory === outputDir) { mutation = true; await externalWrite(path.join(directory, "during-list.json"), "{}"); }
    return entries;
  };
  const guard = installGuards(namespace, { codeRoot: options.codeRoot, originalOutputs: before.outputs,
    readOnlyRoots: ["company_integrated/capacity-bases.json", "history/special_days", "history/saved_product_recoveries"].map(name => path.join(dataDir, name)),
    metadataOnlyFiles: ["company_master/companies.json", "history/observations.jsonl"].map(name => path.join(dataDir, name)) });
  let outcome = "pass", verificationMetrics, denialCodes = [];
  try {
    // This is the actual filesystem guard, not a mock of its source text.
    await fs.readFile(path.join(options.codeRoot, "scripts/lib/keyword_monthly_historical_review.cjs"));
    try { await verifyInventory({ expected: before, dataDir }); } catch (error) { outcome = error.code; }
    verificationMetrics = { ...guard.metrics };
    if (kind === "unchanged") {
      for (const operation of [() => fs.readFile(path.join(dataDir, "history/observations.jsonl")),
        () => fs.readFile(path.join(dataDir, "config/unapproved.json")),
        () => fs.writeFile(path.join(outputDir, "manifest.json"), "changed"), () => fetch("https://example.invalid/")]) {
        try { await operation(); denialCodes.push("unexpected_success"); } catch (error) { denialCodes.push(error.code); }
      }
    }
  } finally { guard.restore(); fs.readdir = originalReaddir; }
  if (kind === "unchanged") assert.equal(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"), '{"fixture":"original"}');
  return { outcome, verificationMetrics, denialCodes, mutation, actualJavascriptGuard: true, kernelSeccompVerified: false };
}

async function runCase(t, kind) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-final-input-guard-")), dataDir = path.join(temporary, "source"), namespace = path.join(dataDir, "keyword_monthly_incremental");
  t.after(async () => { assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("monthly-final-input-guard-")); await fs.rm(temporary, { recursive: true, force: true }); });
  for (const name of ["company_master", "history", "outputs/run", "config", "keyword_monthly_incremental"]) await fs.mkdir(path.join(dataDir, name), { recursive: true });
  await fs.writeFile(path.join(dataDir, "company_master/companies.json"), '{"companies":{}}');
  await fs.writeFile(path.join(dataDir, "history/observations.jsonl"), "{}");
  await fs.writeFile(path.join(dataDir, "outputs/run/manifest.json"), '{"fixture":"original"}');
  await fs.writeFile(path.join(dataDir, "config/unapproved.json"), '{"fixture":"forbidden"}');
  const options = { kind, dataDir, namespace, codeRoot }, script = `(${strictCase.toString()})(${JSON.stringify(options)}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});`;
  const child = spawnSync(process.execPath, ["-e", script], { cwd: codeRoot, env: {}, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.stderr, "");
  return JSON.parse(child.stdout);
}

test("actual strict read guard permits unchanged final verification and the new fixed code file while retaining denials", async t => {
  const result = await runCase(t, "unchanged"); assert.equal(result.outcome, "pass");
  assert.ok(Object.values(result.verificationMetrics).every(value => value === 0));
  assert.deepEqual(result.denialCodes, ["KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED", "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED", "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED", "KEYWORD_RECONSTRUCT_NETWORK_DENIED"]);
});
for (const kind of ["new-file", "new-directory", "changed-during-list"]) test(`actual strict guard classifies ${kind} as changed inputs before an unknown-path read`, async t => {
  const result = await runCase(t, kind); assert.equal(result.outcome, "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  assert.equal(result.verificationMetrics.outsideReadAttempts, 0); assert.equal(result.verificationMetrics.outsideCopyWriteAttempts, 0);
  if (kind === "changed-during-list") assert.equal(result.mutation, true);
});
test("a captured output body change remains changed-input failure with the strict read guard installed", async t => {
  const result = await runCase(t, "changed-file"); assert.equal(result.outcome, "KEYWORD_INCREMENTAL_INPUTS_CHANGED"); assert.equal(result.verificationMetrics.outsideReadAttempts, 0);
});
