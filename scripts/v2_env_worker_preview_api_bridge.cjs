"use strict";

const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_SERVICE_ID,
  V2_ENV_WORKER_STRATEGY
} = require("./v2_env_worker_contract.cjs");

const V2_ENV_WORKER_STATUS_PATH = "/api/admin/collection-worker/v2-env-canary/status";
const V2_ENV_WORKER_OPERATOR_PATH = "/admin/collection-worker/v2-env-canary";

const PRESERVED_PREVIEW_ENDPOINTS = Object.freeze([
  "POST /api/crawl-estimate",
  "POST /api/crawl",
  "GET /api/crawl-status",
  "POST /api/crawl/cancel",
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/member/runs/:id"
]);

function projectV2EnvWorkerStatus(orchestratorStatus = {}) {
  return Object.freeze({
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    targetServiceId: V2_ENV_WORKER_SERVICE_ID,
    targetCommit: /^[a-f0-9]{40}$/u.test(String(orchestratorStatus.targetWorkerCommit || ""))
      ? orchestratorStatus.targetWorkerCommit
      : null,
    enabled: orchestratorStatus.enabled === true,
    actualCallsEnabled: false,
    externalCallApproved: false,
    saveResult: false,
    maxProviderAttempts: 1,
    executedCallCount: 0,
    automaticRetry: false,
    automaticFallback: false,
    blocker: orchestratorStatus.enabled === true ? "one_shot_internal_dispatch_required" : "worker_canary_disabled"
  });
}

function safeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function projectV2EnvWorkerPrepared(result = {}) {
  return Object.freeze({
    status: result.status === "queued" ? "queued" : "blocked",
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    jobId: /^job-canary-[a-f0-9]{16}$/u.test(String(result.jobId || "")) ? result.jobId : null,
    providerState: ["closed", "open", "probe_allowed"].includes(result.providerState)
      ? result.providerState
      : null,
    maxProviderAttempts: 1,
    saveResult: false,
    automaticRetry: false,
    automaticFallback: false
  });
}

function v2EnvWorkerOperatorPage(input = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(String(input.date || "")) ? String(input.date) : "";
  const result = input.result ? projectV2EnvWorkerPrepared(input.result) : null;
  const safeError = /^[A-Z][A-Z0-9_]{2,127}$/u.test(String(input.errorCode || ""))
    ? String(input.errorCode)
    : "";
  const outcome = result
    ? `<section aria-live="polite"><h2>준비 완료</h2><p>${safeHtml(result.strategy)} · ${safeHtml(result.phase)}</p><p>상태 ${safeHtml(result.status)} · 최대 외부 요청 1건 · 결과 저장 안 함</p></section>`
    : safeError
      ? `<section role="alert"><h2>준비 중단</h2><p>${safeHtml(safeError)}</p><p>외부 요청은 시작되지 않았습니다.</p></section>`
      : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V2 환경 Worker 무저장 Canary</title><style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;background:#0b1220;color:#f8fafc}main,section{display:grid;gap:1rem}form{display:grid;gap:.8rem;padding:1.25rem;border:1px solid #64748b;border-radius:1rem}label{display:grid;gap:.35rem}input,button{font:inherit;padding:.75rem;border-radius:.6rem}button{font-weight:700}a{color:#93c5fd}</style></head><body><main><h1>V2 환경 Worker 무저장 Canary</h1><p>첫 NAVER Place 요청만 1회 준비합니다. run·업체·상품·history는 저장하지 않습니다.</p>${outcome}<form method="post" action="${V2_ENV_WORKER_OPERATOR_PATH}"><label>검색어<input name="keyword" maxlength="120" required autocomplete="off"></label><label>단일 숙박일<input type="date" name="date" value="${safeHtml(date)}" required></label><button type="submit">무저장 Canary 1회 준비</button></form><a href="/admin">관리자 콘솔로 돌아가기</a></main></body></html>`;
}

module.exports = {
  PRESERVED_PREVIEW_ENDPOINTS,
  V2_ENV_WORKER_OPERATOR_PATH,
  V2_ENV_WORKER_STATUS_PATH,
  projectV2EnvWorkerPrepared,
  v2EnvWorkerOperatorPage,
  projectV2EnvWorkerStatus
};
