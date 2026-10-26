"use strict";

// This reviewed cohort is independent of the mutable weekly job pointer. It
// contains only public statistics receipts; it grants no general hold override.
const fs = require("node:fs/promises"), { constants } = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const BASELINE = Object.freeze({ jobId: "bd14458a-0e4c-44ea-a665-b00df766f239", sha256: "536a96a69ea3cc855ecfd77209e44664396f921aac6ec033a289671382d59015" });
const REVIEW_SHA = "8f634b047e79eec212950d1ec2653ae0b223aff8beddf7762cf9777725caddf4";
const REGION = "kr_admin_1274000000", KEYS = Object.freeze(["establishments", "employment", "manufacturing_establishments", "manufacturing_employment"]);
const FROZEN = Object.freeze({
  "baseline-weekly-job.json": [17441, BASELINE.sha256],
  "held-original-attempt.json": [904, "c30b1d08cd50503476c293215fa879edd90d0cc0221df2601b15f767053442a6"],
  "held-original-cache.json": [2683, "a8c6c1af46820ce88c6ec31ed5c233cb49a16e19578674044c23d14cbb4b2597"],
  "initial-budget.json": [32, "87178250255227fbebe41680cb5ada4547fe83ff2fc18855f86f95699b7f77a1"],
  "initial-weekly-policy.json": [310, "477e2416006675b7d81ba527d4834bb002e573f39f6be66c35399452884072fc"],
  "held-review.json": [1351, REVIEW_SHA]
});
const fault = () => Object.assign(Error("REGIONAL_MARKET_BOOTSTRAP_INPUT_INVALID"), { code: "REGIONAL_MARKET_BOOTSTRAP_INPUT_INVALID" });
const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
function createRegionalMarketBootstrapInputs({ dataDir }) {
  const base = path.resolve(dataDir), directory = path.join(base, "operations", "region-market-bootstrap-20261026");
  async function parents() {
    const checks = [];
    for (const name of [base, path.join(base, "operations"), directory]) {
      const s = await fs.lstat(name);
      if (!s.isDirectory() || s.isSymbolicLink() || !samePath(await fs.realpath(name), name)) throw fault();
      checks.push(`${s.dev}:${s.ino}`);
    }
    return checks.join("|");
  }
  async function read(name) {
    if (!Object.hasOwn(FROZEN, name)) throw fault();
    const beforeParents = await parents(), file = path.join(directory, name), stat = await fs.lstat(file), [size, sha] = FROZEN[name];
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size || !samePath(await fs.realpath(file), file)) throw fault();
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (identity(await handle.stat()) !== identity(stat)) throw fault();
      const bytes = Buffer.alloc(size + 1); let count = 0;
      while (count < bytes.length) { const r = await handle.read(bytes, count, bytes.length - count, count); if (!r.bytesRead) break; count += r.bytesRead; }
      const value = bytes.subarray(0, count);
      if (count !== size || hash(value) !== sha || identity(await handle.stat()) !== identity(stat) || identity(await fs.lstat(file)) !== identity(stat) || await parents() !== beforeParents) throw fault();
      return Buffer.from(value);
    } finally { await handle.close(); }
  }
  async function readHeldReview() {
    const values = {};
    for (const name of Object.keys(FROZEN)) values[name] = JSON.parse((await read(name)).toString("utf8"));
    const job = values["baseline-weekly-job.json"].job, attempt = values["held-original-attempt.json"], cache = values["held-original-cache.json"], budget = values["initial-budget.json"], review = values["held-review.json"];
    const held = job.regions.find(item => item.regionKey === REGION);
    if (job.id !== BASELINE.jobId || job.status !== "blocked" || job.stopReason !== "QUOTA_EXCEEDED" || job.regions.filter(item => item.status === "not_checked").length !== 86
      || attempt.regionId !== REGION || !attempt.finishedAt || cache.regionId !== REGION || budget.day !== "2026-10-26" || budget.count !== 100
      || held.summary.attemptedDatasetKeys.join() !== "population,households" || held.summary.collectedDatasetKeys.join() !== "population,households"
      || held.summary.remaining.map(item => item.datasetKey).join() !== KEYS.join() || Object.keys(cache.datasets).sort().join() !== "households,population"
      || KEYS.some(key => attempt.outcomes[key]?.error?.code !== "QUOTA_EXCEEDED" || attempt.outcomes[key]?.localBudgetDay !== undefined)
      || review.earliestKstDay !== "2026-10-27" || review.datasetKeys.join() !== KEYS.join()) throw fault();
    return { schemaVersion: 1, status: "reviewed", baselineJobId: BASELINE.jobId, baselineSha256: BASELINE.sha256, regionKey: REGION, datasetKeys: [...KEYS], reviewReceiptSha256: REVIEW_SHA,
      budgetResumeReview: { schemaVersion: 1, kind: "diagnosed_local_budget", regionKey: REGION, attemptSha256: FROZEN["held-original-attempt.json"][1], cacheSha256: FROZEN["held-original-cache.json"][1],
        datasetKeys: [...KEYS], earliestKstDay: "2026-10-27", sourceJobId: BASELINE.jobId, sourceJobSha256: BASELINE.sha256, reviewReceiptSha256: REVIEW_SHA } };
  }
  return { async readBaseline() { return { schemaVersion: 1, bytes: await read("baseline-weekly-job.json") }; }, readHeldReview };
}
module.exports = { createRegionalMarketBootstrapInputs, BASELINE, FROZEN, REVIEW_SHA };
