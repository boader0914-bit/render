"use strict";

const { types } = require("node:util");

const DEFAULT_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 32 * 1024 * 1024;
const fault = (code, message) => Object.assign(new Error(message), {
  code, statusCode: 503, retryAfterSeconds: 1
});
const tooLarge = () => fault("COMPANY_RESPONSE_TOO_LARGE", "응답 자료가 한 번에 전달할 수 있는 크기를 초과했습니다. 잠시 후 다시 조회해 주세요.");
const unavailable = res => !res || res.destroyed || res.closed || res.writableEnded || res.writableFinished || res.headersSent;

// Count JSON's escaped UTF-8 bytes without constructing an escaped copy of a
// possibly very large string. Lone surrogates use well-formed JSON escaping.
function stringBytes(value, remaining) {
  let bytes = 2;
  if (bytes > remaining) throw tooLarge();
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes += 1;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; }
      else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > remaining) throw tooLarge();
  }
  return bytes;
}

function boundedJsonBuffer(value, maxBytes = DEFAULT_RESPONSE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Invalid response byte limit");
  let bytes = 0, root = true;
  const holders = new WeakMap();
  const add = count => { bytes += count; if (bytes > maxBytes) throw tooLarge(); };
  const json = JSON.stringify(value, function (key, original) {
    // Native JSON invokes toJSON/getters with their original receiver before
    // this identity replacer. Match its boxed primitive conversion once, so a
    // user conversion cannot run a second time after byte accounting.
    let item = original;
    if (item && typeof item === "object") {
      if (types.isNumberObject(item)) item = +item;
      else if (types.isStringObject(item)) item = String(item);
      else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
      else if (types.isBigIntObject(item)) item = BigInt.prototype.valueOf.call(item);
    }
    const omitted = item === undefined || typeof item === "function" || typeof item === "symbol";
    const isRoot = root; root = false;
    if (!isRoot) {
      const state = holders.get(this);
      // Every native container is registered when its own replacer runs.
      if (!state) throw new TypeError("Missing JSON response holder");
      if (state.array || !omitted) {
        if (state.emitted++) add(1);
        if (!state.array) { add(stringBytes(key, maxBytes - bytes)); add(1); }
      }
    }
    if (omitted) { if (!isRoot && Array.isArray(this)) add(4); return item; }
    if (item === null) add(4);
    else if (typeof item === "string") add(stringBytes(item, maxBytes - bytes));
    else if (typeof item === "number") add(JSON.stringify(item).length);
    else if (typeof item === "boolean") add(item ? 4 : 5);
    else if (typeof JSON.isRawJSON === "function" && JSON.isRawJSON(item)) add(Buffer.byteLength(item.rawJSON));
    else if (typeof item === "object") { add(2); holders.set(item, { array: Array.isArray(item), emitted: 0 }); }
    // BigInt follows native JSON.stringify's error path without coercing it.
    return item;
  });
  if (json === undefined) return Buffer.alloc(0); // Existing res.end(undefined).
  if (Buffer.byteLength(json) !== bytes || bytes > maxBytes) throw tooLarge();
  return Buffer.from(json);
}

function createBoundedCompanyResponse({ maxResponseBytes = DEFAULT_RESPONSE_BYTES,
  maxReservedBytes = DEFAULT_TOTAL_BYTES, chunkBytes = 64 * 1024, timeoutMs = 120000,
  runWork = operation => operation(), headers = () => ({}) } = {}) {
  if (![maxResponseBytes, maxReservedBytes, chunkBytes, timeoutMs].every(v => Number.isSafeInteger(v) && v > 0)
    || maxResponseBytes > maxReservedBytes || typeof runWork !== "function" || typeof headers !== "function") throw new TypeError("Invalid response admission options");
  let reservedBytes = 0, activeResponses = 0;
  const status = () => ({ maxResponseBytes, maxReservedBytes, reservedBytes, activeResponses, chunkBytes, timeoutMs });

  async function send(response, prepare) {
    if (unavailable(response)) return false;
    if (typeof prepare !== "function") throw new TypeError("Response producer required");
    if (reservedBytes + maxResponseBytes > maxReservedBytes) throw fault("COMPANY_RESPONSE_BUSY", "자료 응답을 전달 중입니다. 잠시 후 다시 조회해 주세요.");
    reservedBytes += maxResponseBytes; activeResponses += 1;
    let released = false, stopped = false, completed = false, started = false;
    let payload = null, preparationPending = true, producer = prepare;
    prepare = null;
    let wake, wakeDrain;
    const done = new Promise(resolve => { wake = resolve; });
    const controller = new AbortController();
    const release = () => { if (!released) { released = true; reservedBytes -= maxResponseBytes; activeResponses -= 1; } };
    let timer;
    function detach() {
      clearTimeout(timer);
      if (response) {
        response.removeListener("finish", finish); response.removeListener("close", close);
        response.removeListener("error", error); response.removeListener("drain", drain);
      }
    }
    function stop(success = false) {
      if (stopped) return;
      stopped = true; completed = success;
      controller.abort();
      detach();
      wake(); wakeDrain?.(false); wakeDrain = null;
      payload = null;
    }
    function finish() { stop(true); }
    function close() { stop(); }
    function error() { const target = response; stop(); target?.destroy(); }
    function drain() { wakeDrain?.(true); wakeDrain = null; }
    response.on("finish", finish); response.on("close", close); response.on("error", error); response.on("drain", drain);
    timer = setTimeout(() => { const target = response; stop(); target?.destroy(); response = null; }, timeoutMs);
    timer.unref?.();
    // A timed-out/closed caller must not retain a response or start encoding
    // when a shared read eventually finishes. Do not cancel that shared read.
    const production = Promise.resolve().then(() => {
      if (stopped) return null;
      const invoke = producer; producer = null;
      return invoke();
    }).then(value => {
      preparationPending = false;
      if (stopped) { release(); return null; }
      return value;
    }, cause => {
      preparationPending = false;
      if (stopped) { release(); return null; }
      throw cause;
    });
    try {
      let prepared = await Promise.race([production, done.then(() => null)]);
      if (stopped) return false;
      if (!prepared || unavailable(response)) return false;
      if (Buffer.isBuffer(prepared.body)) payload = prepared.body;
      else if (typeof prepared.body === "string") {
        if (Buffer.byteLength(prepared.body) > maxResponseBytes) throw tooLarge();
        payload = Buffer.from(prepared.body);
      } else {
        const body = prepared.body;
        // Only CPU/allocation preparation uses the shared analytical lease.
        // Network backpressure is awaited strictly after this promise settles.
        payload = await runWork(() => stopped ? null : boundedJsonBuffer(body, maxResponseBytes), {
          kind: "company-response-json", priority: "foreground", signal: controller.signal
        });
      }
      if (stopped || unavailable(response) || !payload) return false;
      if (payload.length > maxResponseBytes) throw tooLarge();
      const statusCode = prepared.status ?? 200;
      const responseHeaders = { ...headers(), "Content-Type": prepared.contentType || "application/json; charset=utf-8",
        "Cache-Control": "no-store", ...prepared.extraHeaders };
      prepared = null;
      response.writeHead(statusCode, responseHeaders); started = true;
      let offset = 0;
      while (!stopped && offset < payload.length) {
        const end = Math.min(offset + chunkBytes, payload.length);
        const chunk = payload.subarray(offset, end); offset = end;
        const drained = new Promise(resolve => { wakeDrain = resolve; });
        const accepted = response.write(chunk);
        if (!accepted && !stopped) await drained;
        else wakeDrain = null;
      }
      if (!stopped) response.end();
      await done;
      return completed;
    } catch (cause) {
      if (stopped || started || response?.headersSent) {
        const target = response; stop(); target?.destroy(); return false;
      }
      throw cause;
    } finally {
      stop(); detach(); producer = null; payload = null; response = null;
      // If the request closes during shared preparation, keep its admission
      // reserved until that producer settles. Otherwise disconnected callers
      // could repeatedly release/re-enter and accumulate unbounded live reads.
      if (!preparationPending) release();
    }
  }
  return { send, status };
}

module.exports = { createBoundedCompanyResponse, boundedJsonBuffer, stringBytes, unavailable,
  DEFAULT_RESPONSE_BYTES, DEFAULT_TOTAL_BYTES };
