"use strict";

const RUN_RESULT_COUNT_KEYS = Object.freeze([
  "naverOverall",
  "naverAds",
  "naverRegional",
  "naverBookingStockSucceeded",
  "nolFirstPage",
  "ddnayo",
  "yeogiManual",
]);

function runResultSelectionProfile(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return {
      resultState: "unknown",
      hasCollectedResults: null,
      autoSelectable: true,
    };
  }

  const observedCounts = RUN_RESULT_COUNT_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(counts, key))
    .map((key) => Number(counts[key]))
    .filter(Number.isFinite);

  if (!observedCounts.length) {
    return {
      resultState: "unknown",
      hasCollectedResults: null,
      autoSelectable: true,
    };
  }

  const hasCollectedResults = observedCounts.some((value) => value > 0);
  return {
    resultState: hasCollectedResults ? "ready" : "empty",
    hasCollectedResults,
    autoSelectable: hasCollectedResults,
  };
}

module.exports = {
  RUN_RESULT_COUNT_KEYS,
  runResultSelectionProfile,
};
