"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLE_AGE_MS = 120 * DAY_MS;
const DEFAULT_RECENCY_HALF_LIFE_MS = 28 * DAY_MS;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function rankRangeCount(value) {
  const text = String(value || "").trim();
  if (!text || /^(none|skip|없음)$/i.test(text)) return 0;
  if (/^(all|전체)$/i.test(text)) return 100;
  const ranks = new Set();
  for (const token of text.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = token.match(/^(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?$/);
    if (!match) continue;
    const left = clamp(Math.floor(Number(match[1]) || 0), 1, 100);
    const right = clamp(Math.floor(Number(match[2] || match[1]) || 0), 1, 100);
    for (let rank = Math.min(left, right); rank <= Math.max(left, right); rank += 1) ranks.add(rank);
  }
  return ranks.size;
}

function timingWorkload(conditions = {}) {
  const rangeCount = positiveNumber(conditions.rankRangeCount)
    || rankRangeCount(conditions.detailRankRanges);
  const bookingRangeDays = clamp(Math.round(positiveNumber(conditions.bookingRangeDays) || 1), 1, 31);
  const bookingRangePlaceLimit = clamp(Math.round(positiveNumber(conditions.bookingRangePlaceLimit) || 0), 0, 20);
  const rangeUnits = bookingRangePlaceLimit > 0 ? bookingRangeDays * bookingRangePlaceLimit : 0;
  const units = 1
    + (rangeCount / 20) * 0.35
    + (rangeUnits / 140) * 1.65;
  return { rangeCount, bookingRangeDays, bookingRangePlaceLimit, rangeUnits, units };
}

function ratioSimilarity(left, right) {
  const a = Math.max(0, Number(left) || 0);
  const b = Math.max(0, Number(right) || 0);
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

function timingSimilarityScore(conditions = {}, entry = {}) {
  if (entry.success !== true || !positiveNumber(entry.durationSeconds)) return 0;
  const right = entry.conditions && typeof entry.conditions === "object" ? entry.conditions : {};
  const categoricalKeys = ["collectionMode", "collectionPurpose", "collectionProfile", "searchMode"];
  for (const key of categoricalKeys) {
    if (!conditions[key] || !right[key] || conditions[key] !== right[key]) return 0;
  }

  const leftWorkload = timingWorkload(conditions);
  const rightWorkload = timingWorkload(right);
  const weeklyRange = conditions.collectWeeklyRange === true && right.collectWeeklyRange === true;
  const dayScore = weeklyRange
    ? ratioSimilarity(leftWorkload.bookingRangeDays, rightWorkload.bookingRangeDays)
    : 1;
  const placeLimitScore = weeklyRange
    ? ratioSimilarity(leftWorkload.bookingRangePlaceLimit, rightWorkload.bookingRangePlaceLimit)
    : 1;
  const requestedSearchModeScore = !conditions.requestedSearchMode || !right.requestedSearchMode
    ? 0.5
    : Number(conditions.requestedSearchMode === right.requestedSearchMode);
  const productModeScore = !conditions.productMode || !right.productMode
    ? 0.5
    : Number(conditions.productMode === right.productMode);
  const regionScore = !conditions.regionKey || !right.regionKey
    ? 0.5
    : Number(conditions.regionKey === right.regionKey);
  return clamp(
    0.42
      + dayScore * 0.18
      + placeLimitScore * 0.14
      + ratioSimilarity(leftWorkload.rangeCount, rightWorkload.rangeCount) * 0.1
      + requestedSearchModeScore * 0.05
      + productModeScore * 0.03
      + regionScore * 0.08,
    0,
    1
  );
}

function weightedMedian(rows, valueKey = "value", weightKey = "weight") {
  const sorted = rows
    .filter((row) => Number.isFinite(Number(row[valueKey])) && positiveNumber(row[weightKey]))
    .slice()
    .sort((a, b) => Number(a[valueKey]) - Number(b[valueKey]));
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, row) => sum + Number(row[weightKey]), 0);
  let cursor = 0;
  for (const row of sorted) {
    cursor += Number(row[weightKey]);
    if (cursor >= totalWeight / 2) return Number(row[valueKey]);
  }
  return Number(sorted.at(-1)[valueKey]);
}

function robustLogCenter(rows = []) {
  if (!rows.length) return null;
  const median = weightedMedian(rows, "logRatio", "weight");
  if (!Number.isFinite(median)) return null;
  const deviations = rows.map((row) => ({
    ...row,
    deviation: Math.abs(row.logRatio - median)
  }));
  const mad = weightedMedian(deviations, "deviation", "weight") || 0;
  const sigma = mad * 1.4826;
  const outlierThreshold = Math.max(Math.log(1.5), sigma * 3);
  const kept = rows.filter((row) => Math.abs(row.logRatio - median) <= outlierThreshold);
  const winsorRadius = Math.max(Math.log(1.35), sigma * 2.5);
  const weighted = kept.reduce((acc, row) => {
    const value = clamp(row.logRatio, median - winsorRadius, median + winsorRadius);
    acc.weight += row.weight;
    acc.value += value * row.weight;
    acc.weightSquared += row.weight * row.weight;
    return acc;
  }, { weight: 0, value: 0, weightSquared: 0 });
  const logRatio = weighted.value / Math.max(Number.EPSILON, weighted.weight);
  const effectiveSampleSize = weighted.weightSquared > 0
    ? (weighted.weight * weighted.weight) / weighted.weightSquared
    : 0;
  return {
    logRatio,
    ratio: Math.exp(logRatio),
    median,
    mad,
    sigma,
    kept,
    outlierCount: rows.length - kept.length,
    effectiveSampleSize
  };
}

function stageRatioRows(sampleRows = []) {
  const byGroup = new Map();
  for (const sample of sampleRows) {
    const timings = Array.isArray(sample.entry.stageTimings) ? sample.entry.stageTimings : [];
    const groups = new Map();
    for (const timing of timings) {
      if (timing?.skipped || timing?.status !== "done") continue;
      const duration = Number(timing.durationSeconds);
      const estimated = positiveNumber(timing.estimatedSeconds);
      const group = String(timing.group || timing.key || "").trim();
      if (!group || !Number.isFinite(duration) || duration < 0 || !estimated) continue;
      const current = groups.get(group) || { duration: 0, estimated: 0 };
      current.duration += duration;
      current.estimated += estimated;
      groups.set(group, current);
    }
    for (const [group, totals] of groups) {
      if (totals.estimated <= 0) continue;
      const ratio = clamp(totals.duration / totals.estimated, MIN_RATIO, MAX_RATIO);
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push({
        entry: sample.entry,
        logRatio: Math.log(ratio),
        weight: sample.weight
      });
    }
  }
  return byGroup;
}

function calibratedStageFactors(sampleRows, overallRatio) {
  const stageFactors = {};
  const stageSamples = {};
  for (const [group, rows] of stageRatioRows(sampleRows)) {
    const center = robustLogCenter(rows);
    if (!center?.kept?.length) continue;
    const stageBlend = Math.min(0.7, 0.3 + center.effectiveSampleSize * 0.1);
    const factor = Math.exp(
      Math.log(overallRatio) * (1 - stageBlend)
      + center.logRatio * stageBlend
    );
    stageFactors[group] = Number(clamp(factor, MIN_RATIO, MAX_RATIO).toFixed(4));
    stageSamples[group] = {
      sampleCount: center.kept.length,
      outlierCount: center.outlierCount
    };
  }
  return { stageFactors, stageSamples };
}

function calibrateCrawlTiming({
  conditions = {},
  modelTotalSeconds = 0,
  entries = [],
  nowMs = Date.now(),
  maxSampleAgeMs = DEFAULT_MAX_SAMPLE_AGE_MS,
  recencyHalfLifeMs = DEFAULT_RECENCY_HALF_LIFE_MS
} = {}) {
  const model = Math.max(1, Math.round(positiveNumber(modelTotalSeconds) || 1));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const currentWorkload = timingWorkload(conditions);
  const candidates = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const similarity = timingSimilarityScore(conditions, entry);
    if (similarity <= 0) continue;
    const endedAtMs = Date.parse(entry.endedAt || entry.startedAt || "");
    if (!Number.isFinite(endedAtMs) || endedAtMs > now + 5 * 60 * 1000) continue;
    const ageMs = Math.max(0, now - endedAtMs);
    if (ageMs > maxSampleAgeMs) continue;
    const duration = positiveNumber(entry.durationSeconds);
    if (!duration || duration > 24 * 60 * 60) continue;

    const storedModel = positiveNumber(entry.modelTotalSeconds)
      || positiveNumber(entry.estimatedModelSeconds)
      || positiveNumber(entry.estimatedTotalSeconds);
    let comparableSeconds;
    if (storedModel) {
      comparableSeconds = model * (duration / storedModel);
    } else {
      const historicWorkload = timingWorkload(entry.conditions || {});
      comparableSeconds = duration * (currentWorkload.units / Math.max(0.1, historicWorkload.units));
    }
    const ratio = clamp(comparableSeconds / model, MIN_RATIO, MAX_RATIO);
    const recencyWeight = Math.pow(0.5, ageMs / Math.max(DAY_MS, recencyHalfLifeMs));
    const exactWorkload = currentWorkload.bookingRangeDays === timingWorkload(entry.conditions || {}).bookingRangeDays
      && currentWorkload.bookingRangePlaceLimit === timingWorkload(entry.conditions || {}).bookingRangePlaceLimit
      && currentWorkload.rangeCount === timingWorkload(entry.conditions || {}).rangeCount;
    const weight = Math.pow(similarity, 3) * recencyWeight * (exactWorkload ? 1.2 : 1);
    if (!positiveNumber(weight)) continue;
    candidates.push({
      entry,
      endedAtMs,
      ageMs,
      similarity,
      comparableSeconds,
      logRatio: Math.log(ratio),
      weight
    });
  }

  if (!candidates.length) {
    return {
      source: "model",
      label: "조건 모델",
      method: "condition_model_v2",
      sampleCount: 0,
      candidateCount: 0,
      outlierCount: 0,
      modelTotalSeconds: model,
      estimatedTotalSeconds: model,
      averageSeconds: null,
      calibratedSeconds: null,
      confidence: "model",
      confidenceLabel: "실측 표본 없음",
      uncertaintySeconds: null,
      stageFactors: {},
      stageSamples: {}
    };
  }

  const center = robustLogCenter(candidates);
  if (!center?.kept?.length) {
    return calibrateCrawlTiming({ conditions, modelTotalSeconds: model, entries: [], nowMs: now });
  }
  const rawRatio = clamp(center.ratio, MIN_RATIO, MAX_RATIO);
  const averageSimilarity = center.kept.reduce((sum, row) => sum + row.similarity * row.weight, 0)
    / Math.max(Number.EPSILON, center.kept.reduce((sum, row) => sum + row.weight, 0));
  const effective = center.effectiveSampleSize;
  const baseBlend = effective >= 6 ? 0.86 : effective >= 4 ? 0.8 : effective >= 3 ? 0.73 : effective >= 2 ? 0.6 : 0.44;
  const historyBlend = clamp(baseBlend * (0.86 + averageSimilarity * 0.14), 0.4, 0.88);
  const blendedRatio = 1 + (rawRatio - 1) * historyBlend;
  const estimatedTotalSeconds = Math.round(clamp(model * blendedRatio, model * 0.5, model * 2.3));
  const calibratedSeconds = Math.round(model * rawRatio);
  const weightedComparable = center.kept.reduce((acc, row) => {
    acc.weight += row.weight;
    acc.seconds += row.comparableSeconds * row.weight;
    return acc;
  }, { weight: 0, seconds: 0 });
  const averageSeconds = Math.round(weightedComparable.seconds / Math.max(Number.EPSILON, weightedComparable.weight));
  const dispersion = Math.max(center.sigma, effective < 2 ? Math.log(1.25) : Math.log(1.08));
  const uncertaintySeconds = Math.max(10, Math.round(estimatedTotalSeconds * (Math.exp(dispersion) - 1)));
  const confidence = effective >= 4 && averageSimilarity >= 0.82 && center.sigma <= Math.log(1.35)
    ? "high"
    : effective >= 2 && averageSimilarity >= 0.7
      ? "medium"
      : "low";
  const confidenceLabel = confidence === "high" ? "높음" : confidence === "medium" ? "보통" : "낮음";
  const { stageFactors, stageSamples } = calibratedStageFactors(center.kept, rawRatio);

  return {
    source: "measured",
    label: "최근 실측 보정",
    method: "robust_workload_normalized_v2",
    sampleCount: center.kept.length,
    candidateCount: candidates.length,
    outlierCount: center.outlierCount,
    modelTotalSeconds: model,
    estimatedTotalSeconds,
    averageSeconds,
    calibratedSeconds,
    confidence,
    confidenceLabel,
    uncertaintySeconds,
    historyBlend: Number(historyBlend.toFixed(4)),
    stageFactors,
    stageSamples,
    latestEndedAt: new Date(Math.max(...center.kept.map((row) => row.endedAtMs))).toISOString()
  };
}

module.exports = {
  DEFAULT_MAX_SAMPLE_AGE_MS,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  calibrateCrawlTiming,
  rankRangeCount,
  robustLogCenter,
  timingSimilarityScore,
  timingWorkload,
  weightedMedian
};
