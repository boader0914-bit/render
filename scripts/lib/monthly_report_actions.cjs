"use strict";

const crypto = require("node:crypto");
const STATUSES = Object.freeze(["planned", "in_progress", "completed", "held"]);
const MAX_ITEMS = 20, MAX_REFS = 12, MAX_PLAN_BYTES = 65536, MAX_EVIDENCE = 512;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code, message) { return Object.assign(new Error(message), { code, statusCode: 400, status: 400 }); }
function exact(value, keys, code) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !keys.includes(key) || !Object.hasOwn(descriptor, "value"))) {
    throw fail(code, "행동계획의 입력 항목을 확인해 주세요.");
  }
}
function text(value, limit, field, required = false, multiline = false) {
  if (value === undefined) value = "";
  if (typeof value !== "string" || value.length > limit || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) {
    throw fail("invalid_action_plan", `${field}의 길이와 형식을 확인해 주세요.`);
  }
  value = value.trim();
  if (required && !value) throw fail("invalid_action_plan", `${field}을 입력해 주세요.`);
  return value;
}

// References are selected from this exact saved snapshot. Content-derived IDs
// prevent a rebuilt report from silently rebinding an old plan to new evidence.
function listMonthlyReportActionEvidence(snapshot = {}) {
  const result = [], seen = new Set();
  function add(kind, label, value) {
    if (!record(value) || result.length >= MAX_EVIDENCE) return;
    const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const id = `${kind}:${digest}`;
    if (!seen.has(id)) { seen.add(id); result.push({ id, label }); }
  }
  for (const [key, label] of [["lodging", "숙박 요약"], ["dayuse", "데이유즈 요약"]]) {
    if (record(snapshot.summary?.[key])) add(`summary-${key}`, label, { value: snapshot.summary[key], sourceDigest: snapshot.sources?.digest || null });
  }
  if (record(snapshot.quality)) add("quality", "자료 품질·누락 기준", snapshot.quality);
  if (record(snapshot.comparison)) add("comparison", "전월 공통 표본 비교", snapshot.comparison);
  for (const source of snapshot.context?.sources || []) {
    if (record(source)) add("regional", `지역 배경 · ${String(source.regionLabel || "")} ${String(source.label || source.key || "저장 지표")}`.trim(), source);
  }
  for (const entry of snapshot.industryBenchmarks?.entries || []) {
    if (record(entry)) add("industry", `업종 참고 · ${String(entry.regionLabel || "")} ${String(entry.industry?.label || "저장 집계")}`.trim(), entry);
  }
  for (const entry of snapshot.context?.outlookEvaluations?.regions || []) {
    if (record(entry)) add("outlook", `전망 검증 · ${String(entry.regionLabel || entry.regionKey || "저장 근거")}`, entry);
  }
  for (const entry of snapshot.context?.catchment?.entries || []) {
    if (record(entry)) add("catchment", `배후시장 · ${String(entry.companyLabel ? `${entry.companyLabel} · ${entry.regionLabel || entry.regionKey}` : entry.regionLabel || entry.regionKey || "저장 근거")}`, entry);
  }
  return result;
}

function normalizeMonthlyReportActionPlan(input, snapshot) {
  exact(input, ["schemaVersion", "summary", "items"], "invalid_action_plan");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1 || !Array.isArray(input.items) || input.items.length > MAX_ITEMS) {
    throw fail("invalid_action_plan", "행동계획은 최대 20개이며 지원되는 형식이어야 합니다.");
  }
  const allowed = new Set(listMonthlyReportActionEvidence(snapshot).map(row => row.id)), ids = new Set();
  const items = Array.from(input.items).map((item, index) => {
    exact(item, ["id", "title", "owner", "dueDate", "status", "evidenceRefs", "outcome"], "invalid_action_plan");
    const id = item.id === undefined ? `action-${index + 1}` : item.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || ids.has(id)) throw fail("invalid_action_plan", "행동 항목 번호가 잘못되었거나 중복되었습니다.");
    ids.add(id);
    const status = item.status === undefined ? "planned" : item.status;
    if (!STATUSES.includes(status)) throw fail("invalid_action_plan", "행동 항목의 진행 상태를 확인해 주세요.");
    let dueDate = item.dueDate === undefined || item.dueDate === "" ? null : item.dueDate;
    if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
      || !Number.isFinite(Date.parse(dueDate + "T00:00:00Z")) || new Date(dueDate + "T00:00:00Z").toISOString().slice(0, 10) !== dueDate)) {
      throw fail("invalid_action_plan", "실행 예정일은 유효한 YYYY-MM-DD 날짜여야 합니다.");
    }
    if (!Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length || item.evidenceRefs.length > MAX_REFS
      || new Set(item.evidenceRefs).size !== item.evidenceRefs.length || Array.from(item.evidenceRefs).some(ref => typeof ref !== "string" || !allowed.has(ref))) {
      throw fail("invalid_action_evidence", "이 보고서에 저장된 근거를 선택해 주세요. 재집계로 근거가 바뀌었다면 행동계획을 먼저 검토하거나 비워 주세요.");
    }
    return { id, title: text(item.title, 200, "행동 제목", true), owner: text(item.owner, 100, "담당자"), dueDate, status,
      evidenceRefs: [...item.evidenceRefs], outcome: text(item.outcome, 4000, "실행 결과 메모", false, true) };
  });
  const plan = { schemaVersion: 1, summary: text(input.summary, 4000, "관리자 의견", false, true), items };
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES) throw fail("invalid_action_plan", "행동계획의 전체 길이를 줄여 주세요.");
  return plan;
}

module.exports = { STATUSES, MAX_ITEMS, MAX_REFS, MAX_PLAN_BYTES, listMonthlyReportActionEvidence, normalizeMonthlyReportActionPlan };
