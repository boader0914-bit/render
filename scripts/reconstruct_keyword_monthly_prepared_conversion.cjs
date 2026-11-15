"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), K = require("./lib/keyword_monthly_prepared_conversion.cjs");
const { kernelIsolation, installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
function args(values) {
  const out = {}; for (let n = 0; n < values.length; n += 2) { const key = values[n]?.replace(/^--/, ""); K.need(["input", "input-sha", "job-root", "code-root", "isolation-proof"].includes(key)
    && !Object.hasOwn(out, key) && values[n + 1], "KEYWORD_PREPARED_CONVERSION_ARGUMENTS"); out[key] = values[n + 1]; }
  for (const key of ["input", "job-root", "code-root", "isolation-proof"]) H.absolute(out[key]);
  K.need(H.SHA.test(out["input-sha"] || "") && path.dirname(out.input) === out["job-root"]
    && path.dirname(out["isolation-proof"]) === path.join(out["job-root"], "control"), "KEYWORD_PREPARED_CONVERSION_ARGUMENTS"); return out;
}
async function run(values) {
  const input = args(values), isolation = await kernelIsolation(input["isolation-proof"], input["job-root"]);
  const read = await H.read(input.input, K.LIMITS.inventoryBytes); K.need(read.sha256 === input["input-sha"], "KEYWORD_PREPARED_CONVERSION_INPUT_CHANGED");
  const job = read.value; K.need(job.jobDir === input["job-root"] && job.codeRoot === input["code-root"], "KEYWORD_PREPARED_CONVERSION_JOB_INVALID");
  const guards = installGuards(job.jobDir, { codeRoot: job.codeRoot, readOnlyRoots: [path.join(job.dataDir, "keyword_monthly_analysis/current.json"),
    path.join(job.dataDir, "keyword_monthly_analysis/generations", job.source.generation)] });
  const scratch = installScratchBudget(job.jobDir, K.LIMITS.scratchBytes);
  try {
    const result = await K.compile(job, { isolation });
    K.need(Object.values(guards.metrics).every(value => value === 0) && scratch.status().deniedOperations === 0, "KEYWORD_PREPARED_CONVERSION_SIDE_EFFECT_ATTEMPTED");
    return await K.writeNew(path.join(job.jobDir, "child-complete.json"), { ...result, guardMetrics: guards.metrics, scratch: scratch.status() });
  } catch (error) {
    try { await K.writeNew(path.join(job.jobDir, "child-failed.json"), { schemaVersion: 1, version: K.VERSION, status: "needs_verification",
      code: K.safeCode(error), sourceWrites: 0, providerCalls: 0, originalFreshnessVerified: false, guardMetrics: guards.metrics, scratch: scratch.status() }); } catch {}
    throw error;
  } finally { scratch.restore(); guards.restore(); }
}
if (require.main === module) run(process.argv.slice(2)).then(read => console.log(JSON.stringify({ status: "staged", sha256: read.sha256 }))).catch(error => {
  console.error(JSON.stringify({ code: K.safeCode(error) })); process.exitCode = 1;
});
module.exports = { args, run };
