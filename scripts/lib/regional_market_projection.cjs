"use strict";
const { SPECS, validateRegionalMarketSnapshot } = require("./regional_market.cjs");
const fault = () => Object.assign(Error("CACHE_PROJECTION_FAILED"), { code: "CACHE_PROJECTION_FAILED" });
function createSavedRegionalMarketProjector({ analysisStore, marketService }) {
  return async function project(regionKey, summary) {
    // Rebuilding is cache-only. A successful queue entry alone is insufficient:
    // read the exact persisted result through the strict administrative reader.
    await analysisStore.request({ regionKey, months: 13 }, { collectMissing: false, reason: "source_changed" });
    await analysisStore.waitForIdle();
    const projected = await analysisStore.get({ regionKey, months: 13 });
    if (!projected.snapshot || projected.storage?.errorCode || ["failed", "interrupted", "queued", "running"].includes(projected.job?.status)) throw fault();
    const saved = await marketService.get({ regionKey });
    validateRegionalMarketSnapshot(saved, { regionKey });
    if (saved.scope.regionKey !== regionKey || saved.scope.months !== 13 || projected.snapshot.scope?.regionKey !== regionKey || projected.snapshot.scope?.months !== 13 || saved.scope.month !== projected.snapshot.scope?.month
      || saved.source.resultId !== projected.snapshot.resultId || saved.source.sourceFingerprint !== projected.snapshot.sourceFingerprint
      || saved.networkAttempted !== false || saved.status === "needs_verification" || !Array.isArray(summary.remaining)) throw fault();
    const required = SPECS.filter(spec => !summary.remaining.some(item => item.datasetKey === spec.datasetKey));
    for (const spec of required) {
      const metric = saved.metrics.find(item => item.key === spec.key);
      if (!metric || metric.status !== "observed" || !Number.isSafeInteger(metric.value) || metric.value < 0 || !metric.source.storedProvenance) throw fault();
    }
    return { verified: true, resultId: saved.source.resultId, availableDatasetKeys: required.map(spec => spec.datasetKey) };
  };
}
module.exports = { createSavedRegionalMarketProjector };
