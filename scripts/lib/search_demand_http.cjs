"use strict";

const BASE = "/api/search-demand";
const DAY = /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/;
const ANALYSIS_KEYS = ["keyword", "day", "month", "relatedKeyword", "page", "pageSize", "sort", "search"];
const invalid = () => Object.assign(new Error("SEARCH_DEMAND_INVALID_REQUEST"), { code: "SEARCH_DEMAND_INVALID_REQUEST", statusCode: 400 });

function parseSearchDemandQuery(params, { report = false } = {}) {
  const allowed = report ? [...ANALYSIS_KEYS, "cadence", "format"] : ANALYSIS_KEYS;
  const keys = [...params.keys()];
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw invalid();
  const input = Object.fromEntries(params);
  if (typeof input.keyword !== "string" || !input.keyword.trim() || input.keyword.length > 160 || /[\x00-\x1f\x7f]/.test(input.keyword)) throw invalid();
  if (input.relatedKeyword !== undefined && (!input.relatedKeyword.trim() || input.relatedKeyword.length > 160 || /[\x00-\x1f\x7f]/.test(input.relatedKeyword))) throw invalid();
  if (input.day !== undefined && (!DAY.test(input.day) || new Date(input.day + "T00:00:00Z").toISOString().slice(0, 10) !== input.day)) throw invalid();
  if (input.month !== undefined && !MONTH.test(input.month)) throw invalid();
  for (const [name, maximum] of [["page", 10000], ["pageSize", 200]]) {
    if (input[name] !== undefined) {
      if (!/^[1-9]\d{0,4}$/.test(input[name]) || Number(input[name]) > maximum) throw invalid();
      input[name] = Number(input[name]);
    }
  }
  if (input.search !== undefined && (input.search.length > 120 || /[\x00-\x1f\x7f]/.test(input.search))) throw invalid();
  if (input.sort !== undefined && !["searchVolumeDesc", "searchVolumeAsc", "keyword", "keywordAsc", "mobileDesc", "pcDesc"].includes(input.sort)) throw invalid();
  if (report) {
    input.cadence ||= "daily";
    input.format ||= "json";
    if (!["daily", "weekly", "monthly"].includes(input.cadence) || !["json", "csv"].includes(input.format)) throw invalid();
  }
  return input;
}

function createSearchDemandHttpHandler({ service, requireAdmin, send } = {}) {
  if (typeof service?.catalog !== "function" || typeof service?.analyze !== "function" || typeof service?.report !== "function" || typeof requireAdmin !== "function" || typeof send !== "function") throw new TypeError("Read-only search demand service and admin helpers are required");
  return async function handleSearchDemand(req, res, url, session) {
    if (url.pathname !== BASE && !url.pathname.startsWith(BASE + "/")) return false;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method !== "GET") {
        send(res, 405, { status: "needs_verification", code: "SEARCH_DEMAND_METHOD_NOT_ALLOWED", error: "저장된 검색 수요 조회만 지원합니다.", readOnly: true, networkAttempted: false });
        return true;
      }
      if (url.pathname === BASE + "/catalog") {
        if (url.searchParams.size) throw invalid();
        send(res, 200, await service.catalog());
        return true;
      }
      if (![BASE, BASE + "/analysis", BASE + "/report"].includes(url.pathname)) {
        send(res, 404, { code: "SEARCH_DEMAND_NOT_FOUND", readOnly: true, networkAttempted: false });
        return true;
      }
      const isReport = url.pathname.endsWith("/report");
      const input = parseSearchDemandQuery(url.searchParams, { report: isReport });
      const value = isReport ? await service.report(input) : await service.analyze(input);
      if (isReport && input.format === "csv") {
        if (typeof value.csv !== "string" || Buffer.byteLength(value.csv) > 16 * 1024 * 1024) throw Object.assign(new Error(), { code: "SEARCH_DEMAND_REPORT_BOUNDS" });
        res.setHeader("Content-Disposition", `attachment; filename="search-demand-${input.cadence}-${input.day || input.month || "saved"}.csv"`);
        send(res, 200, "\ufeff" + value.csv, "text/csv; charset=utf-8");
      } else {
        const status = value?.status === "needs_verification" ? 503 : 200;
        send(res, status, value);
      }
    } catch (error) {
      const status = error.statusCode === 400 || /INVALID_(?:REQUEST|DAY|MONTH|KEYWORD|PAGE|SORT)/.test(error.code || "") ? 400 : 503;
      send(res, status, { status: "needs_verification", code: /^SEARCH_DEMAND_[A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "SEARCH_DEMAND_UNAVAILABLE",
        error: status === 400 ? "정확한 키워드·관측일·전망 대상월·조회 조건을 확인해 주세요." : "저장된 검색 자료를 확인하지 못했습니다. 미확인 값을 0으로 바꾸지 않습니다.",
        readOnly: true, networkAttempted: false });
    }
    return true;
  };
}

module.exports = { createSearchDemandHttpHandler, parseSearchDemandQuery };
