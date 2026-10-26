"use strict";

const { fault } = require("./regional_catchment.cjs");
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
function readBoundedJson(req, maxBytes = MAX_IMPORT_BYTES) {
  if (Number(req.headers?.["content-length"]) > maxBytes) { req.resume?.(); return Promise.reject(fault("CATCHMENT_IMPORT_TOO_LARGE", 413)); }
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], done = false;
    const fail = error => { if (!done) { done = true; chunks = []; reject(error); } };
    req.on("data", chunk => {
      if (done) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) { fail(fault("CATCHMENT_IMPORT_TOO_LARGE", 413)); return; }
      chunks.push(buffer);
    });
    req.on("error", () => fail(fault("CATCHMENT_INVALID_JSON")));
    req.on("aborted", () => fail(fault("CATCHMENT_INVALID_JSON")));
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.includes("\uFFFD")) throw new Error("Invalid UTF8");
        resolve(JSON.parse(text));
      } catch { reject(fault("CATCHMENT_INVALID_JSON")); }
      chunks = [];
    });
  });
}
function sameOrigin(req) {
  if (!req.headers?.origin) return true;
  try {
    const url = new URL(req.headers.origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.host === req.headers.host && !["null", ""].includes(req.headers.origin);
  } catch { return false; }
}
function createRegionalCatchmentHttpHandler({ service, requireAdmin, parseJsonBody, send, rateLimit = () => {}, readAddressTargets = async () => ({ addresses: [] }) } = {}) {
  if (!service || typeof requireAdmin !== "function" || typeof parseJsonBody !== "function" || typeof send !== "function" || typeof readAddressTargets !== "function") throw new TypeError("Catchment service and HTTP helpers are required");
  const base = "/api/regional-catchment", paths = new Set([base, `${base}/addresses`, `${base}/configure`, `${base}/datasets`, `${base}/refresh`]);
  // Keep simultaneous large request bodies from multiplying parse/normalize
  // memory. Saved-result GETs and small configure/refresh requests remain free.
  let importing = false;
  return async function handle(req, res, url, session) {
    if (!paths.has(url.pathname)) return false;
    if (!requireAdmin(session, req, res)) return true;
    let importHeld = false;
    try {
      if (req.method === "GET" && [base, `${base}/addresses`].includes(url.pathname)) {
        const keys = [...url.searchParams.keys()];
        const addressList = url.pathname.endsWith("/addresses"), allowed = addressList ? ["regionKey"] : ["regionKey", "companyId"];
        if (!url.searchParams.get("regionKey") || keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length
          || (keys.includes("companyId") && !url.searchParams.get("companyId"))) throw fault("CATCHMENT_INVALID_REQUEST");
        if (addressList) {
          const result = await readAddressTargets(url.searchParams.get("regionKey"));
          if (!Array.isArray(result?.addresses) || result.addresses.some(target => !target || typeof target.companyId !== "string" || !target.companyId || typeof target.label !== "string"
            || !["ready", "missing", "ambiguous"].includes(target.status) || (target.status === "ready" && (typeof target.address !== "string" || !target.address.trim())))) throw fault("CATCHMENT_ADDRESS_TARGETS_UNAVAILABLE", 503);
          send(res, 200, { addresses: result.addresses.map(({ companyId, label, address, status }) => ({ companyId, label, address: status === "ready" ? address : "", status })) });
        }
        else send(res, 200, await service.get({ regionKey: url.searchParams.get("regionKey"), ...(keys.includes("companyId") ? { companyId: url.searchParams.get("companyId") } : {}) }));
        return true;
      }
      if (req.method !== "POST" || [base, `${base}/addresses`].includes(url.pathname)) { send(res, 405, { error: "지원하지 않는 요청입니다.", code: "CATCHMENT_METHOD_NOT_ALLOWED" }); return true; }
      if (url.searchParams.size) throw fault("CATCHMENT_INVALID_REQUEST");
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.["content-type"] || ""))) throw fault("CATCHMENT_JSON_REQUIRED", 415);
      if (!sameOrigin(req)) throw fault("CATCHMENT_ORIGIN_MISMATCH", 403);
      rateLimit(req, session);
      if (url.pathname.endsWith("/datasets")) {
        if (importing) { req.resume?.(); throw fault("CATCHMENT_IMPORT_BUSY", 429); }
        importing = true; importHeld = true;
      }
      let payload;
      try { payload = url.pathname.endsWith("/datasets") ? await readBoundedJson(req) : await parseJsonBody(req); }
      catch (error) { if (error.statusCode === 413) throw error; throw fault("CATCHMENT_INVALID_JSON"); }
      const actor = session?.username || "administrator";
      if (url.pathname.endsWith("/configure")) send(res, 200, await service.configure(payload, actor));
      else if (url.pathname.endsWith("/datasets")) {
        const result = await service.importDataset(payload, actor); send(res, result.reused ? 200 : 201, result);
      } else {
        const result = await service.request(payload); send(res, ["queued", "running"].includes(result.job?.status) ? 202 : 200, result);
      }
    } catch (error) {
      const statusCode = [400, 403, 404, 409, 413, 415, 429, 503].includes(error.statusCode) ? error.statusCode : 500;
      const code = /^CATCHMENT_[A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "CATCHMENT_OPERATION_FAILED";
      send(res, statusCode, { code, error: code === "CATCHMENT_ADDRESS_REQUIRED" ? "기준주소와 같은 위치로 확인한 좌표·출처를 먼저 저장하세요. 주소 확인 전에는 새 계산을 할 수 없습니다."
        : code === "CATCHMENT_ADDRESS_MISMATCH" ? "기준주소가 현재 업체 등록주소와 다릅니다. 업체 주소를 다시 확인하고 기준점을 저장하세요."
          : code === "CATCHMENT_COMPANY_ADDRESS_REQUIRED" ? "현재 업체의 상세주소가 한 개로 확정되어야 합니다. 업체정보의 주소를 먼저 확인하세요."
            : ["CATCHMENT_ADDRESS_TARGETS_UNAVAILABLE", "CATCHMENT_ADDRESS_SOURCE_UNAVAILABLE"].includes(code) ? "등록된 업체 주소를 읽지 못했습니다. 주소 없음으로 판단하지 말고 다시 확인하세요."
              : statusCode === 413 ? "가져오기 JSON은 UTF-8 기준 16MiB 이하여야 합니다. 격자는 최대 50,000개입니다."
        : statusCode === 403 ? "현재 관리자 서비스 화면에서 요청해 주세요." : code === "CATCHMENT_IMPORT_BUSY" ? "다른 공간자료를 반입하고 있습니다. 완료 후 다시 시도해 주세요." : statusCode === 429 ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
          : statusCode === 409 ? "등록한 자료 ID와 기준점을 확인해 주세요. 기존 자료는 덮어쓰지 않습니다."
            : statusCode >= 500 ? "배후시장 저장 결과를 처리하지 못했습니다. 이전 결과를 유지합니다."
              : "지역·기준점·격자 자료 형식과 출처를 확인해 주세요." });
    } finally { if (importHeld) importing = false; }
    return true;
  };
}

module.exports = { createRegionalCatchmentHttpHandler, MAX_IMPORT_BYTES, readBoundedJson };
