"use strict";
// Host-only loopback reads. Credentials and the session cookie never leave
// process memory, enter child environments, diagnostics or durable receipts.
const http = require("node:http");
const fault = code => Object.assign(new Error(code), { code });
const need = (value, code) => { if (!value) throw fault(code); };
const PATHS = new Set(["/api/login", "/api/analytical-work", "/api/collector-status", "/api/collection-postprocess"]);
function loopbackRequest({ pathname, method = "GET", body, cookie, timeoutMs = 3000 }) {
  need(PATHS.has(pathname) && (method === "GET" && pathname !== "/api/login" || method === "POST" && pathname === "/api/login")
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3000, "KEYWORD_PREPARED_CONVERSION_LOCAL_REQUEST_INVALID");
  return new Promise((resolve, reject) => {
    let done = false, bytes = 0, chunks = [];
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (payload && payload.length > 16384) { reject(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_REQUEST_INVALID")); return; }
    const request = http.request({ hostname: "127.0.0.1", port: 10000, path: pathname, method, agent: false,
      headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      response.on("data", part => { bytes += part.length; if (bytes > 1024 * 1024) { request.destroy(); finish(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_RESPONSE_BOUND")); } else chunks.push(part); });
      response.once("end", () => {
        if (done) return; let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_RESPONSE_INVALID")); return; }
        chunks = []; finish(null, { statusCode: response.statusCode, headers: response.headers, json });
      });
      response.once("error", () => finish(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_CONNECTION_FAILED")));
    });
    const timer = setTimeout(() => { request.destroy(); finish(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_TIMEOUT")); }, timeoutMs);
    request.once("error", () => finish(fault("KEYWORD_PREPARED_CONVERSION_LOCAL_CONNECTION_FAILED")));
    request.end(payload);
  });
}
function statusSnapshot(analysis, collectors, postprocess) {
  const work = analysis?.work;
  need(work && typeof work.closed === "boolean" && typeof work.active === "boolean" && typeof work.sampling === "boolean" && Object.hasOwn(work, "activeCheckpointReadKind")
    && (work.activeCheckpointReadKind === null || typeof work.activeCheckpointReadKind === "string") && work.maintenance?.enabled === true
    && typeof work.maintenance.checking === "boolean" && typeof work.maintenance.paused === "boolean"
    && Number.isSafeInteger(work.queuedForeground) && work.queuedForeground >= 0 && Number.isSafeInteger(work.queuedBackground) && work.queuedBackground >= 0,
  "KEYWORD_PREPARED_CONVERSION_MAINTENANCE_UNVERIFIED");
  need(Array.isArray(collectors?.workers) && collectors.workers.length === 3
    && ["manual", "scheduled", "web"].every(key => collectors.workers.filter(row => row.workerKey === key).length === 1)
    && collectors.workers.every(row => (row.activeJobId === null || row.activeJobId === undefined || typeof row.activeJobId === "string" && row.activeJobId.length > 0 && row.activeJobId.length <= 300)
      && (row.queued === undefined || Number.isSafeInteger(row.queued) && row.queued >= 0)
      && row.crawl && typeof row.crawl.active === "boolean" && Number.isSafeInteger(row.crawl.queueLength) && row.crawl.queueLength >= 0
      && !/STATE_UNKNOWN|STATE_LOST|RESTART_INTERRUPTED|WORKER_TIMEOUT/.test(row.errorCode || "")), "KEYWORD_PREPARED_CONVERSION_COLLECTOR_STATE_UNKNOWN");
  need(postprocess && typeof postprocess.active === "boolean" && postprocess.counts && typeof postprocess.counts === "object"
    && !Array.isArray(postprocess.counts) && !postprocess.errorCode && Object.values(postprocess.counts).every(value => Number.isSafeInteger(value) && value >= 0),
  "KEYWORD_PREPARED_CONVERSION_POSTPROCESS_STATE_UNKNOWN");
  const queuedPostprocess = Object.entries(postprocess.counts).filter(([state]) => !["complete", "failed", "held"].includes(state)).reduce((sum, [, count]) => sum + count, 0);
  return { idle: !work.closed && !work.active && !work.activeCheckpointReadKind && !work.sampling && !work.maintenance.checking
      && collectors.workers.every(row => !row.activeJobId && !row.queued && row.crawl.active === false && row.crawl.queueLength === 0)
      && postprocess.active === false && queuedPostprocess === 0,
    analyticalActive: work.active, checkpointActive: Boolean(work.activeCheckpointReadKind), sampling: work.sampling, admissionChecking: work.maintenance.checking,
    heldForeground: work.queuedForeground, heldBackground: work.queuedBackground, collectorActive: collectors.workers.filter(row => row.activeJobId || row.crawl.active).length,
    collectorQueued: collectors.workers.reduce((sum, row) => sum + (row.queued || 0) + row.crawl.queueLength, 0), postprocessActive: postprocess.active, queuedPostprocess };
}
async function waitForConversionIdle({ transport = loopbackRequest, environment = process.env, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), timeoutMs = 60000 } = {}) {
  need(typeof transport === "function" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, "KEYWORD_PREPARED_CONVERSION_LOCAL_REQUEST_INVALID");
  let username = String(environment.GLAMPING_ADMIN_USER || environment.ADMIN_USER || "").trim(), password = String(environment.GLAMPING_ADMIN_PASSWORD || environment.ADMIN_PASSWORD || "").trim();
  need(username && password, "KEYWORD_PREPARED_CONVERSION_LOCAL_AUTH_REQUIRED"); const began = Number(now());
  const login = await transport({ pathname: "/api/login", method: "POST", body: { username, password }, timeoutMs: Math.min(3000, timeoutMs) }); username = null; password = null;
  need(login.statusCode === 200 && login.json?.ok === true && login.json.role === "admin", "KEYWORD_PREPARED_CONVERSION_LOCAL_AUTH_REQUIRED");
  const cookies = login.headers?.["set-cookie"], cookieParts = Array.isArray(cookies) ? cookies : typeof cookies === "string" ? [cookies] : [];
  let cookie = cookieParts.map(value => value.split(";")[0]).join("; ");
  need(cookie.length > 0 && cookie.length <= 8192 && !/[\r\n\x00]/.test(cookie), "KEYWORD_PREPARED_CONVERSION_LOCAL_AUTH_REQUIRED");
  let polls = 0;
  try {
    while (Number(now()) - began < timeoutMs) {
      const remaining = timeoutMs - (Number(now()) - began), perRequest = Math.min(3000, Math.max(1, remaining));
      const results = await Promise.all(["/api/analytical-work", "/api/collector-status", "/api/collection-postprocess"].map(pathname => transport({ pathname, cookie, timeoutMs: perRequest })));
      need(results.every(result => result.statusCode === 200), "KEYWORD_PREPARED_CONVERSION_LOCAL_STATE_UNAVAILABLE"); polls++;
      const snapshot = statusSnapshot(...results.map(result => result.json));
      if (snapshot.idle) return { ...snapshot, polls, elapsedMs: Number(now()) - began, authenticatedLoopbackOnly: true };
      const left = timeoutMs - (Number(now()) - began); if (left <= 0) break; await sleep(Math.min(1000, left));
    }
    throw fault("KEYWORD_PREPARED_CONVERSION_BUSY_TIMEOUT");
  } finally { cookie = null; }
}
module.exports = { loopbackRequest, statusSnapshot, waitForConversionIdle };
