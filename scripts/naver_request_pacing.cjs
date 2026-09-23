"use strict";

// The observation parser is dependency-free. Reuse its standalone challenge
// recognition so OTA and the process-wide guard agree without an import cycle.
const { parseNaverPlaceHtmlObservation } = require("./naver_place_ota_observation.cjs");

const DEFAULT_MIN_INTERVAL_MS = 500;

function isNaverBookingRateLimit(data) {
  return Array.isArray(data?.errors) && data.errors.some(error =>
    [error?.extensions?.code, error?.extensions?.message, error?.message].some(value =>
      typeof value === "string" && /\bBookingAPITooManyRequests\b/.test(value)));
}

// Detect a challenge response, not an ordinary page that merely links to a
// captcha library. Never log the provider body or attempt challenge bypass.
function isNaverCaptchaResponse(body) {
  const text = String(body || "");
  return /<title\b[^>]*>[^<]*(?:captcha|자동입력\s*방지|보안\s*확인|비정상적인\s*접근)[^<]*<\/title>/i.test(text)
    || /<(?:form|input|img)\b[^>]*(?:captcha|자동입력)/i.test(text)
    || /(?:자동입력\s*방지\s*문자|보안\s*문자.{0,40}입력|비정상적인\s*접근.{0,40}(?:감지|차단)|자동화된\s*요청.{0,40}(?:감지|차단))/i.test(text)
    || /"(?:code|errorCode)"\s*:\s*"(?:CaptchaRequired|CAPTCHA_REQUIRED)"/i.test(text)
    || parseNaverPlaceHtmlObservation(text).status === "blocked";
}

function isNaverRequest(input) {
  try {
    const url = new URL(typeof input === "object" && input !== null && "url" in input ? input.url : String(input));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return ["naver.com", "naver.net"].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function intervalMilliseconds(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError("Naver request interval must be a nonnegative number.");
  return Math.round(parsed);
}

function concurrencyLimit(value) {
  if (value === null || value === undefined || value === "") return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2) throw new TypeError("Naver request concurrency must be 1 or 2.");
  return parsed;
}

function stoppedError(reason) {
  if (reason instanceof Error || Object.prototype.toString.call(reason) === "[object Error]") return reason;
  const error = new Error(String(reason || "Naver request gate stopped."));
  error.code = "NAVER_REQUEST_GATE_STOPPED";
  return error;
}

function signalFor(input, init) {
  return init?.signal || (typeof input === "object" && input !== null ? input.signal : null);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  throw error;
}

function createNaverRequestGate(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const enabled = options.enabled !== false;
  // The guard can remain active without a global speed limit. `enabled: false`
  // deliberately retains the original, transparent passthrough contract.
  const pacingEnabled = enabled && options.pacingEnabled !== false;
  const guardOnly = enabled && !pacingEnabled;
  const minIntervalMs = guardOnly ? 0 : intervalMilliseconds(options.minIntervalMs);
  const maxConcurrency = guardOnly ? Infinity : concurrencyLimit(options.maxConcurrency);
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const onResponse = typeof options.onResponse === "function" ? options.onResponse : null;
  const onRequestStart = typeof options.onRequestStart === "function" ? options.onRequestStart : null;
  let lastStartedAt = null;
  let stopReason = null;
  let inFlight = 0;
  let pumping = false;
  const queue = [];
  const metrics = { requestCount: 0, failedRequests: 0, cancelledBeforeStart: 0, totalWaitMs: 0, maxInFlight: 0, minObservedStartIntervalMs: null };

  function stop(reason) {
    if (!stopReason) stopReason = stoppedError(reason);
    while (queue.length) {
      metrics.cancelledBeforeStart++;
      queue.shift().reject(stopReason);
    }
  }

  function diagnostics() {
    return {
      enabled: pacingEnabled, guardEnabled: enabled, pacingEnabled,
      minIntervalMs, maxConcurrentRequests: guardOnly ? null : maxConcurrency, ...metrics,
      totalWaitMs: Math.round(metrics.totalWaitMs),
      minObservedStartIntervalMs: metrics.minObservedStartIntervalMs === null ? null : Math.round(metrics.minObservedStartIntervalMs),
      queued: queue.length, inFlight, stopped: Boolean(stopReason),
    };
  }

  async function execute(job) {
    try {
      if (onRequestStart) onRequestStart(job.input, job.init);
      const response = await fetchImpl(job.input, job.init);
      let bufferedBody;
      const readBody = () => bufferedBody ||= response.clone().arrayBuffer();
      // Status-based stops take effect as soon as headers arrive, before a slow
      // body could permit more queued requests to start.
      if (onResponse) await onResponse(response, {
        stop,
        readJson: async () => JSON.parse(new TextDecoder().decode(await readBody())),
        readText: async () => new TextDecoder().decode(await readBody()),
      });
      // Fetch resolves when headers arrive. Track the full body download (and,
      // when paced, retain its slot), but return the original Response with its
      // URL, headers, status and unread text()/json() body unchanged.
      if (response?.body !== null && typeof response?.clone === "function") await readBody();
      job.resolve(response);
    } catch (error) {
      metrics.failedRequests++;
      job.reject(error);
    } finally {
      inFlight--;
      void pump();
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && inFlight < maxConcurrency) {
        const job = queue[0];
        try {
          if (stopReason) throw stopReason;
          throwIfAborted(signalFor(job.input, job.init));
          // One pump owns all starts. In paced mode its interval applies across
          // the whole process; guard-only mode neither waits nor limits slots.
          while (pacingEnabled && lastStartedAt !== null && now() - lastStartedAt < minIntervalMs) {
            await sleep(Math.max(1, minIntervalMs - (now() - lastStartedAt)));
            if (stopReason) throw stopReason;
            throwIfAborted(signalFor(job.input, job.init));
          }
          if (stopReason) throw stopReason;
          queue.shift();
          const startedAt = now();
          if (pacingEnabled) metrics.totalWaitMs += Math.max(0, startedAt - job.enqueuedAt);
          if (lastStartedAt !== null) {
            const elapsed = Math.max(0, startedAt - lastStartedAt);
            metrics.minObservedStartIntervalMs = metrics.minObservedStartIntervalMs === null ? elapsed : Math.min(metrics.minObservedStartIntervalMs, elapsed);
          }
          lastStartedAt = startedAt;
          inFlight++;
          metrics.requestCount++;
          metrics.maxInFlight = Math.max(metrics.maxInFlight, inFlight);
          void execute(job);
        } catch (error) {
          // stop() already rejects and drains the queue. Other preflight
          // failures affect only the request at its head, without retrying it.
          if (queue[0] === job) {
            queue.shift();
            metrics.cancelledBeforeStart++;
            job.reject(error);
          }
        }
      }
    } finally {
      pumping = false;
      if (queue.length && inFlight < maxConcurrency) void pump();
    }
  }

  function pacedFetch(input, init) {
    if (!enabled || !isNaverRequest(input)) return fetchImpl(input, init);
    if (stopReason) {
      metrics.cancelledBeforeStart++;
      return Promise.reject(stopReason);
    }
    return new Promise((resolve, reject) => {
      queue.push({ input, init, resolve, reject, enqueuedAt: now() });
      void pump();
    });
  }

  return { fetch: pacedFetch, stop, diagnostics };
}

module.exports = { DEFAULT_MIN_INTERVAL_MS, isNaverRequest, isNaverBookingRateLimit, isNaverCaptchaResponse, createNaverRequestGate };
