"use strict";

const crypto = require("node:crypto");

const STRATEGY_STAGE = 230;
const STRATEGY_SCHEMA_VERSION = 1;
const STRATEGY_STORE_KIND = "glamping-datalab-v2-stage230-strategy-store";
const STRATEGY_RULE_VERSION = "v2-stage230-deterministic-strategy-v1";
const STRATEGY_API_BASE = "/api/integration/strategy";

const STRATEGY_DOMAINS = Object.freeze(["price", "channel", "product", "content", "leadtime"]);
const PLAN_STATUSES = Object.freeze(["draft", "active", "completed", "cancelled"]);
const ITEM_STATUSES = Object.freeze(["planned", "in-progress", "blocked", "done", "cancelled"]);
const KPI_DIRECTIONS = Object.freeze(["increase", "decrease", "maintain"]);
const CANDIDATE_TYPES = Object.freeze(["carryover", "repeat", "new"]);
const BOARD_DUE_FILTERS = Object.freeze(["all", "overdue", "this-week"]);

const STRATEGY_PLAN_ENTITLEMENTS = Object.freeze({
  free: Object.freeze({
    plan: "free",
    maxStrategyCardsPerMonth: 5,
    maxPlansPerMonth: 1,
    maxItemsPerPlan: 5,
    maxKpisPerItem: 2
  }),
  basic: Object.freeze({
    plan: "basic",
    maxStrategyCardsPerMonth: 5,
    maxPlansPerMonth: 2,
    maxItemsPerPlan: 15,
    maxKpisPerItem: 4
  }),
  pro: Object.freeze({
    plan: "pro",
    maxStrategyCardsPerMonth: 5,
    maxPlansPerMonth: 5,
    maxItemsPerPlan: 50,
    maxKpisPerItem: 8
  })
});

function strategyError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanText(value, maximum = 240) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanId(value, label = "id", maximum = 160) {
  const id = cleanText(value, maximum);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) {
    throw strategyError(`${label} must be a URL-safe identifier`, "STRATEGY_ID_INVALID");
  }
  return id;
}

function requiredMonth(value, label = "month") {
  const month = cleanText(value, 12);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw strategyError(`${label} must use YYYY-MM`, "STRATEGY_MONTH_INVALID");
  }
  return month;
}

function requiredDate(value, label = "date") {
  const date = cleanText(value, 10);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== date
  ) {
    throw strategyError(`${label} must use a valid YYYY-MM-DD date`, "STRATEGY_DATE_INVALID");
  }
  return date;
}

function requiredIso(value, label = "timestamp") {
  const timestamp = cleanText(value, 48);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
    throw strategyError(`${label} must be an ISO timestamp`, "STRATEGY_TIMESTAMP_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value, length = 32) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex").slice(0, length);
}

function round(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function nextMonth(value) {
  const month = requiredMonth(value);
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

function entitlementsForStrategy(plan) {
  const key = Object.hasOwn(STRATEGY_PLAN_ENTITLEMENTS, plan) ? plan : "free";
  return { ...STRATEGY_PLAN_ENTITLEMENTS[key] };
}

function assertBusinessSafe(value, keyPath = "value") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertBusinessSafe(entry, `${keyPath}[${index}]`));
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(raw|rawPath|filePath|filesystemPath|internalFormula|internalError|credential|secret|token)$/i.test(key)) {
        throw strategyError(`Business projection contains a forbidden field at ${keyPath}.${key}`, "STRATEGY_BUSINESS_SAFE_VIOLATION");
      }
      assertBusinessSafe(entry, `${keyPath}.${key}`);
    }
    return value;
  }
  if (typeof value === "string" && (
    /(?:^|\s)[A-Za-z]:\\/.test(value)
    || /file:\/\//i.test(value)
    || /\/(?:outputs?|runtime|customer_db|data)\//i.test(value)
    || /\.(?:jsonl|sqlite|db)(?:\s|$)/i.test(value)
  )) {
    throw strategyError(`Business projection contains a filesystem or raw-data reference at ${keyPath}`, "STRATEGY_BUSINESS_SAFE_VIOLATION");
  }
  return value;
}

function confidenceOf(report) {
  return cleanText(report?.readiness?.confidence || report?.forecast?.confidence, 32).toLowerCase();
}

function reportGate(report) {
  if (!report || report.lifecycle !== "published") {
    return {
      eligible: false,
      state: "not-published-report",
      reason: "공개된 월간 리포트가 필요합니다.",
      reportId: cleanText(report?.reportId, 160),
      confidence: "insufficient"
    };
  }
  const scopes = Array.isArray(report.scopes) ? report.scopes : [];
  const confidence = confidenceOf(report);
  const scopeNames = new Set(scopes.map((scope) => scope.scope));
  const intervalLow = Number(report.forecast?.interval?.low);
  const intervalHigh = Number(report.forecast?.interval?.high);
  const ready = report.state === "ready"
    && report.resultAvailable === true
    && report.readiness?.state === "ready"
    && Number.isFinite(Date.parse(report.publishedAt || ""))
    && report.forecast?.state === "ready"
    && Number(report.forecast?.sampleCount || 0) >= Number(report.forecast?.minimumSampleCount || 1)
    && Number.isFinite(intervalLow)
    && Number.isFinite(intervalHigh)
    && intervalLow <= intervalHigh
    && scopes.length === 4
    && ["national", "region", "own", "anonymous-cohort"].every((scope) => scopeNames.has(scope))
    && scopes.every((scope) => scope.state === "ready" && scope.metrics)
    && ["medium", "high"].includes(confidence);
  return {
    eligible: ready,
    state: ready ? "ready" : "insufficient-confidence",
    reason: ready ? "" : "표본·freshness·신뢰도 조건을 충족한 공개 리포트가 필요합니다.",
    reportId: cleanText(report.reportId, 160),
    confidence
  };
}

function assertEligiblePublishedReport(report) {
  const gate = reportGate(report);
  if (gate.state === "not-published-report") {
    throw strategyError(gate.reason, "STRATEGY_REPORT_NOT_PUBLISHED", 409);
  }
  if (!gate.eligible) {
    throw strategyError(gate.reason, "STRATEGY_REPORT_CONFIDENCE_REQUIRED", 409);
  }
  return report;
}

function metric(scope, key) {
  const value = Number(scope?.metrics?.[key]);
  return Number.isFinite(value) ? value : null;
}

function percentageGap(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return 0;
  return round(((value - baseline) / Math.abs(baseline)) * 100, 1);
}

function evidence(scope, metricKey, label, unit) {
  const value = metric(scope, metricKey);
  return {
    scope: cleanText(scope?.scope, 48),
    metricKey,
    label,
    value,
    unit,
    sampleCount: Math.max(0, Number(scope?.sampleCount || 0))
  };
}

function strategyTemplate(input) {
  const report = input.report;
  const companyId = cleanId(input.companyId || report.companyId, "companyId");
  const month = requiredMonth(report.month);
  const domain = cleanText(input.domain, 32);
  if (!STRATEGY_DOMAINS.includes(domain)) throw strategyError("Unsupported strategy domain", "STRATEGY_DOMAIN_INVALID");
  const strategyId = `strategy_${stableHash(`${companyId}|${report.reportId}|${domain}|${STRATEGY_RULE_VERSION}`, 28)}`;
  const generatedAt = requiredIso(input.generatedAt || new Date().toISOString(), "generatedAt");
  const card = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    strategyId,
    companyId,
    month,
    reportId: cleanId(report.reportId, "reportId"),
    domain,
    ruleVersion: STRATEGY_RULE_VERSION,
    title: cleanText(input.title, 160),
    summary: cleanText(input.summary, 600),
    confidence: {
      level: confidenceOf(report),
      reasons: [
        `공개 리포트 ${report.month}`,
        `리포트 신뢰도 ${confidenceOf(report)}`,
        `전략 규칙 ${STRATEGY_RULE_VERSION}`
      ]
    },
    difficulty: ["low", "medium", "high"].includes(input.difficulty) ? input.difficulty : "medium",
    expectedEffect: {
      metricKey: cleanText(input.expectedEffect.metricKey, 80),
      label: cleanText(input.expectedEffect.label, 120),
      direction: KPI_DIRECTIONS.includes(input.expectedEffect.direction) ? input.expectedEffect.direction : "increase",
      minimum: round(input.expectedEffect.minimum, 1),
      maximum: round(input.expectedEffect.maximum, 1),
      unit: cleanText(input.expectedEffect.unit, 32)
    },
    executionTiming: {
      startDate: requiredDate(input.executionTiming.startDate, "startDate"),
      dueDate: requiredDate(input.executionTiming.dueDate, "dueDate"),
      label: cleanText(input.executionTiming.label, 120)
    },
    evidence: clone(input.evidence || []),
    checklist: (input.checklist || []).map((label, index) => ({
      checklistId: `check_${domain}_${index + 1}`,
      label: cleanText(label, 180),
      required: true
    })),
    kpiTemplate: {
      metricKey: cleanText(input.kpiTemplate.metricKey, 80),
      label: cleanText(input.kpiTemplate.label, 120),
      unit: cleanText(input.kpiTemplate.unit, 32),
      direction: KPI_DIRECTIONS.includes(input.kpiTemplate.direction) ? input.kpiTemplate.direction : "increase",
      targetValue: round(input.kpiTemplate.targetValue, 1)
    },
    lineage: {
      sourceReportId: cleanId(report.reportId, "reportId"),
      sourceReportMonth: month,
      sourceReportVersion: Math.max(1, Number(report.version || 1)),
      sourceReportPublishedAt: requiredIso(report.publishedAt, "sourceReportPublishedAt"),
      sourceAlgorithmVersion: cleanText(report.algorithmVersion, 120),
      ruleVersion: STRATEGY_RULE_VERSION,
      evidenceKeys: (input.evidence || []).map((row) => `${row.scope}.${row.metricKey}`),
      generatedAt,
      generatedBy: cleanText(input.generatedBy || "system", 120)
    },
    createdAt: generatedAt
  };
  assertBusinessSafe(card);
  return card;
}

function deriveStrategyCards(reportInput = {}, options = {}) {
  const report = assertEligiblePublishedReport(clone(reportInput));
  const scopes = Object.fromEntries(report.scopes.map((scope) => [scope.scope, scope]));
  const own = scopes.own;
  const cohort = scopes["anonymous-cohort"];
  const region = scopes.region;
  const national = scopes.national;
  const month = requiredMonth(report.month);
  const generatedAt = requiredIso(options.generatedAt || new Date().toISOString(), "generatedAt");
  const companyId = cleanId(options.companyId || report.companyId, "companyId");
  const common = { report, companyId, generatedAt, generatedBy: options.generatedBy || "system" };
  const ownPrice = metric(own, "averagePrice");
  const cohortPrice = metric(cohort, "averagePrice");
  const priceGap = percentageGap(ownPrice, cohortPrice);
  const ownOta = metric(own, "otaExposureRate");
  const cohortOta = metric(cohort, "otaExposureRate");
  const ownSold = metric(own, "soldRate");
  const cohortSold = metric(cohort, "soldRate");
  const regionalSold = metric(region, "soldRate");
  const nationalSold = metric(national, "soldRate");
  const forecastValue = Number(report.forecast?.value);
  const forecast = Number.isFinite(forecastValue) ? forecastValue : ownSold;
  const date = (day) => `${month}-${String(day).padStart(2, "0")}`;

  return [
    strategyTemplate({
      ...common,
      domain: "price",
      title: priceGap > 10 ? "비교군 대비 가격 차등폭 정비" : priceGap < -10 ? "가격 경쟁력 기반 기준가 정비" : "비교군 정합 가격 유지",
      summary: `내 숙소 평균 가격과 익명 비교군의 격차 ${priceGap}%를 기준으로 다음 달 공개 가격표를 정비합니다.`,
      difficulty: "medium",
      expectedEffect: { metricKey: "soldRate", label: "판매율", direction: "increase", minimum: 2, maximum: 6, unit: "%p" },
      executionTiming: { startDate: date(1), dueDate: date(7), label: "월초 가격표 반영" },
      evidence: [evidence(own, "averagePrice", "내 숙소 평균 가격", "원"), evidence(cohort, "averagePrice", "익명 비교군 평균 가격", "원")],
      checklist: ["공개 채널별 기준가를 확인합니다.", "주중·주말 가격 차등을 반영합니다.", "변경 후 판매율 KPI를 기록합니다."],
      kpiTemplate: { metricKey: "soldRate", label: "판매율", unit: "%", direction: "increase", targetValue: Math.max(0, round(cohortSold, 1) || 0) }
    }),
    strategyTemplate({
      ...common,
      domain: "channel",
      title: ownOta < cohortOta ? "OTA 노출 채널 보강" : "성과 채널 운영 일관성 유지",
      summary: `내 숙소 OTA 노출률 ${round(ownOta, 1)}%와 익명 비교군 ${round(cohortOta, 1)}%를 기준으로 공개 채널 상태를 점검합니다.`,
      difficulty: "medium",
      expectedEffect: { metricKey: "otaExposureRate", label: "OTA 노출률", direction: "increase", minimum: 5, maximum: 15, unit: "%p" },
      executionTiming: { startDate: date(1), dueDate: date(10), label: "예약 채널 노출 점검" },
      evidence: [evidence(own, "otaExposureRate", "내 숙소 OTA 노출률", "%"), evidence(cohort, "otaExposureRate", "익명 비교군 OTA 노출률", "%")],
      checklist: ["채널별 판매 가능 상태를 확인합니다.", "객실·가격 노출 누락을 정비합니다.", "노출률 KPI를 입력합니다."],
      kpiTemplate: { metricKey: "otaExposureRate", label: "OTA 노출률", unit: "%", direction: "increase", targetValue: Math.max(0, round(cohortOta, 1) || 0) }
    }),
    strategyTemplate({
      ...common,
      domain: "product",
      title: ownSold < cohortSold ? "판매율 보강 상품 구성" : "상위 판매 상품 구성 유지",
      summary: `내 숙소 판매율 ${round(ownSold, 1)}%와 익명 비교군 ${round(cohortSold, 1)}%를 기준으로 판매 상품 구성을 정비합니다.`,
      difficulty: "high",
      expectedEffect: { metricKey: "soldRate", label: "판매율", direction: "increase", minimum: 3, maximum: 8, unit: "%p" },
      executionTiming: { startDate: date(3), dueDate: date(14), label: "월 중순 전 상품 구성 반영" },
      evidence: [evidence(own, "soldRate", "내 숙소 판매율", "%"), evidence(cohort, "soldRate", "익명 비교군 판매율", "%")],
      checklist: ["판매율이 낮은 상품을 식별합니다.", "혜택과 제한 조건을 명확히 작성합니다.", "상품별 판매율을 기록합니다."],
      kpiTemplate: { metricKey: "soldRate", label: "판매율", unit: "%", direction: "increase", targetValue: Math.max(0, round(cohortSold, 1) || 0) }
    }),
    strategyTemplate({
      ...common,
      domain: "content",
      title: ownSold < regionalSold ? "지역 수요 연계 콘텐츠 정비" : "지역 강점 콘텐츠 유지",
      summary: `지역 판매율 ${round(regionalSold, 1)}%와 전국 판매율 ${round(nationalSold, 1)}%를 근거로 숙소의 공개 콘텐츠 우선순위를 정비합니다.`,
      difficulty: "low",
      expectedEffect: { metricKey: "contentCompletionRate", label: "핵심 콘텐츠 완성률", direction: "increase", minimum: 10, maximum: 25, unit: "%p" },
      executionTiming: { startDate: date(1), dueDate: date(12), label: "예약 검토 전 콘텐츠 반영" },
      evidence: [evidence(region, "soldRate", "지역 판매율", "%"), evidence(national, "soldRate", "전국 판매율", "%")],
      checklist: ["지역 접근성과 핵심 체험을 설명합니다.", "대표 이미지와 객실 정보를 최신화합니다.", "핵심 콘텐츠 완성률을 입력합니다."],
      kpiTemplate: { metricKey: "contentCompletionRate", label: "핵심 콘텐츠 완성률", unit: "%", direction: "increase", targetValue: 100 }
    }),
    strategyTemplate({
      ...common,
      domain: "leadtime",
      title: "리드타임 구간별 재고 점검",
      summary: `다음 달 예측값 ${round(forecast, 1)}와 D-14·D-7·D-1 반복 관측을 기준으로 재고 확인 시점을 고정합니다.`,
      difficulty: "low",
      expectedEffect: { metricKey: "leadtimeCheckRate", label: "리드타임 점검 이행률", direction: "increase", minimum: 20, maximum: 40, unit: "%p" },
      executionTiming: { startDate: date(1), dueDate: date(20), label: "D-14·D-7·D-1 순차 점검" },
      evidence: [{ scope: "forecast", metricKey: "forecastValue", label: "다음 달 예측값", value: round(forecast, 1), unit: "%", sampleCount: Number(report.forecast?.sampleCount || 0) }],
      checklist: ["D-14 재고와 판매 상태를 확인합니다.", "D-7 변동을 기록합니다.", "D-1 최종 상태를 기록합니다."],
      kpiTemplate: { metricKey: "leadtimeCheckRate", label: "리드타임 점검 이행률", unit: "%", direction: "increase", targetValue: 100 }
    })
  ];
}

function achievedForKpi(kpi = {}) {
  if (kpi.inputState !== "entered" || !Number.isFinite(Number(kpi.currentValue)) || !Number.isFinite(Number(kpi.targetValue))) return false;
  if (kpi.direction === "decrease") return Number(kpi.currentValue) <= Number(kpi.targetValue);
  if (kpi.direction === "maintain") return Math.abs(Number(kpi.currentValue) - Number(kpi.targetValue)) < 0.000001;
  return Number(kpi.currentValue) >= Number(kpi.targetValue);
}

function normalizeChecklist(rows = []) {
  if (!Array.isArray(rows)) throw strategyError("checklist must be an array", "STRATEGY_CHECKLIST_INVALID");
  return rows.slice(0, 40).map((row, index) => {
    const value = typeof row === "string" ? { label: row } : row || {};
    return {
      checklistId: cleanId(value.checklistId || `check_${index + 1}`, "checklistId"),
      label: cleanText(value.label, 180),
      required: value.required !== false,
      completed: Boolean(value.completed),
      completedAt: value.completedAt ? requiredIso(value.completedAt, "completedAt") : ""
    };
  });
}

function normalizeKpi(value = {}) {
  const direction = cleanText(value.direction || "increase", 24);
  if (!KPI_DIRECTIONS.includes(direction)) throw strategyError("Unsupported KPI direction", "STRATEGY_KPI_DIRECTION_INVALID");
  const targetValue = Number(value.targetValue);
  if (!Number.isFinite(targetValue)) throw strategyError("KPI targetValue must be numeric", "STRATEGY_KPI_TARGET_INVALID");
  const hasCurrent = value.currentValue !== undefined && value.currentValue !== null && value.currentValue !== "";
  const currentValue = hasCurrent ? Number(value.currentValue) : null;
  if (hasCurrent && !Number.isFinite(currentValue)) throw strategyError("KPI currentValue must be numeric", "STRATEGY_KPI_VALUE_INVALID");
  const kpi = {
    metricKey: cleanId(value.metricKey, "metricKey", 80),
    label: cleanText(value.label, 120),
    unit: cleanText(value.unit, 32),
    direction,
    targetValue: round(targetValue, 2),
    currentValue: hasCurrent ? round(currentValue, 2) : null,
    inputState: hasCurrent ? "entered" : "missing"
  };
  kpi.achieved = achievedForKpi(kpi);
  return kpi;
}

module.exports = {
  BOARD_DUE_FILTERS,
  CANDIDATE_TYPES,
  ITEM_STATUSES,
  KPI_DIRECTIONS,
  PLAN_STATUSES,
  STRATEGY_API_BASE,
  STRATEGY_DOMAINS,
  STRATEGY_PLAN_ENTITLEMENTS,
  STRATEGY_RULE_VERSION,
  STRATEGY_SCHEMA_VERSION,
  STRATEGY_STAGE,
  STRATEGY_STORE_KIND,
  achievedForKpi,
  assertBusinessSafe,
  assertEligiblePublishedReport,
  canonicalJson,
  clamp,
  cleanId,
  cleanText,
  clone,
  deriveStrategyCards,
  entitlementsForStrategy,
  nextMonth,
  normalizeChecklist,
  normalizeKpi,
  reportGate,
  requiredDate,
  requiredIso,
  requiredMonth,
  round,
  stableHash,
  strategyError
};
