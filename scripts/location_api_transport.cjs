"use strict";

const crypto = require("node:crypto");

const REDACTED = "[REDACTED]";
const APPROVAL_SCOPE = "location_api_live_execution";
const TRANSIENT_STATUS_CODES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = Object.freeze([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT"
]);

const DEFAULT_POLICY = deepFreeze({
  allowedHosts: [],
  allowedMethods: ["GET", "POST"],
  credentialEnvNames: [],
  timeoutMs: 15_000,
  maxResponseBytes: 5 * 1024 * 1024,
  maxPages: 25,
  retry: {
    maxAttempts: 3,
    retryableStatusCodes: [...TRANSIENT_STATUS_CODES],
    retryableErrorCodes: [...TRANSIENT_ERROR_CODES],
    baseBackoffMs: 500,
    maxBackoffMs: 30_000,
    backoffByStatus: {},
    honorRetryAfter: true,
    retryAfterRequiredFor429: false
  },
  rateLimit: {
    minIntervalMs: 0,
    requestsPerMinute: null,
    maxCellsPerRequest: null,
    maxConcurrency: 1
  }
});

class LocationApiTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LocationApiTransportError";
    this.code = code;
    this.statusCode = transportStatusCode(code);
    this.details = deepFreeze(redactForLog(details));
  }
}

function transportStatusCode(code) {
  if (/^(LIVE_CALLS_DISABLED|APPROVAL_|TRANSPORT_NOT_INJECTED)/.test(String(code))) return 403;
  if (/^(TIMEOUT|REQUEST_FAILED|UPSTREAM_)/.test(String(code))) return 502;
  if (code === "RESPONSE_TOO_LARGE") return 502;
  return 400;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return value;
}

function cloneValue(value, seen = new WeakMap()) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) output[key] = cloneValue(item, seen);
  return output;
}

function integerWithin(value, fallback, { minimum, maximum, name }) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", `${name} is outside the permitted range`, { name });
  }
  return number;
}

function normalizeHost(value) {
  const text = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!text || text.includes("/") || text.includes("@") || text.includes("*") || text.includes(":")) {
    throw new LocationApiTransportError("INVALID_ALLOWED_HOST", "allowedHosts must contain exact hostnames", { host: text });
  }
  try {
    return new URL(`https://${text}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new LocationApiTransportError("INVALID_ALLOWED_HOST", "allowedHosts contains an invalid hostname");
  }
}

function uniqueStrings(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizePolicy(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "transport policy must be an object");
  }
  const pagination = input.paginationPolicy || {};
  const timeout = input.timeoutPolicy || {};
  const retry = input.retry || input.retryPolicy || {};
  const rateLimit = input.rateLimit || input.rateLimitPolicy || {};
  const allowedMethods = uniqueStrings(input.allowedMethods, DEFAULT_POLICY.allowedMethods).map((method) => method.toUpperCase());
  if (!allowedMethods.length || allowedMethods.some((method) => !/^[A-Z]+$/.test(method))) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "allowedMethods must contain HTTP methods");
  }
  const credentialEnvNames = uniqueStrings(input.credentialEnvNames ?? input.allowedCredentialEnvNames);
  if (credentialEnvNames.some((name) => !/^[A-Z][A-Z0-9_]{1,127}$/.test(name))) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "credentialEnvNames must contain environment variable names only");
  }

  const configuredRequestsPerMinute = rateLimit.requestsPerMinute ?? rateLimit.callsPerMinute;
  const requestsPerMinute = configuredRequestsPerMinute === null || configuredRequestsPerMinute === undefined
    ? DEFAULT_POLICY.rateLimit.requestsPerMinute
    : integerWithin(configuredRequestsPerMinute, null, {
      minimum: 1,
      maximum: 60_000,
      name: "rateLimit.requestsPerMinute"
    });
  const explicitInterval = integerWithin(rateLimit.minIntervalMs, DEFAULT_POLICY.rateLimit.minIntervalMs, {
    minimum: 0,
    maximum: 3_600_000,
    name: "rateLimit.minIntervalMs"
  });
  const calculatedInterval = requestsPerMinute ? Math.ceil(60_000 / requestsPerMinute) : 0;
  const backoffByStatus = {};
  for (const [status, milliseconds] of Object.entries(retry.backoffByStatus || {})) {
    if (!/^\d{3}$/.test(status)) {
      throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "retry backoff status must be a three-digit code");
    }
    backoffByStatus[status] = integerWithin(milliseconds, 0, {
      minimum: 0,
      maximum: 3_600_000,
      name: `retry.backoffByStatus.${status}`
    });
  }

  const policy = {
    allowedHosts: uniqueStrings(input.allowedHosts).map(normalizeHost),
    allowedMethods,
    credentialEnvNames,
    timeoutMs: integerWithin(input.timeoutMs ?? timeout.timeoutMs ?? timeout.responseMs, DEFAULT_POLICY.timeoutMs, {
      minimum: 1,
      maximum: 120_000,
      name: "timeoutMs"
    }),
    maxResponseBytes: integerWithin(
      input.maxResponseBytes ?? input.maximumResponseBytes?.bytes ?? input.maximumResponseBytes,
      DEFAULT_POLICY.maxResponseBytes,
      { minimum: 1, maximum: 100 * 1024 * 1024, name: "maxResponseBytes" }
    ),
    maxPages: integerWithin(input.maxPages ?? pagination.maxPages ?? pagination.maximumPages, DEFAULT_POLICY.maxPages, {
      minimum: 1,
      maximum: 1_000,
      name: "maxPages"
    }),
    retry: {
      maxAttempts: integerWithin(retry.maxAttempts ?? retry.maximumAttempts, DEFAULT_POLICY.retry.maxAttempts, {
        minimum: 1,
        maximum: 10,
        name: "retry.maxAttempts"
      }),
      retryableStatusCodes: uniqueStatusCodes(
        retry.retryableStatusCodes ?? retry.retryableStatuses,
        DEFAULT_POLICY.retry.retryableStatusCodes
      ),
      retryableErrorCodes: uniqueStrings(retry.retryableErrorCodes, DEFAULT_POLICY.retry.retryableErrorCodes),
      baseBackoffMs: integerWithin(retry.baseBackoffMs, DEFAULT_POLICY.retry.baseBackoffMs, {
        minimum: 0,
        maximum: 3_600_000,
        name: "retry.baseBackoffMs"
      }),
      maxBackoffMs: integerWithin(retry.maxBackoffMs, DEFAULT_POLICY.retry.maxBackoffMs, {
        minimum: 0,
        maximum: 3_600_000,
        name: "retry.maxBackoffMs"
      }),
      backoffByStatus,
      honorRetryAfter: retry.honorRetryAfter !== false,
      retryAfterRequiredFor429: retry.retryAfterRequiredFor429 === true
    },
    rateLimit: {
      minIntervalMs: Math.max(explicitInterval, calculatedInterval),
      requestsPerMinute,
      maxCellsPerRequest: (rateLimit.maxCellsPerRequest ?? pagination.maximumCellsPerRequest) === null ||
          (rateLimit.maxCellsPerRequest ?? pagination.maximumCellsPerRequest) === undefined
        ? DEFAULT_POLICY.rateLimit.maxCellsPerRequest
        : integerWithin(rateLimit.maxCellsPerRequest ?? pagination.maximumCellsPerRequest, null, {
          minimum: 1,
          maximum: 10_000_000,
          name: "rateLimit.maxCellsPerRequest"
        }),
      maxConcurrency: integerWithin(
        rateLimit.maxConcurrency ?? rateLimit.maximumConcurrency,
        DEFAULT_POLICY.rateLimit.maxConcurrency,
        { minimum: 1, maximum: 20, name: "rateLimit.maxConcurrency" }
      )
    }
  };
  if (policy.retry.maxBackoffMs < policy.retry.baseBackoffMs) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "maxBackoffMs must be at least baseBackoffMs");
  }
  return deepFreeze(policy);
}

function uniqueStatusCodes(value, fallback) {
  const input = Array.isArray(value) ? value : fallback;
  const output = [...new Set(input.map(Number))];
  if (output.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "retryableStatusCodes contains an invalid status");
  }
  return output;
}

function normalizedSensitiveKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(value) {
  const key = normalizedSensitiveKey(value);
  if (!key) return false;
  if (["authref", "credentialref", "credentialenvname", "credentialenvnames", "servicekeyparam"].includes(key)) return false;
  return key === "authorization" ||
    key === "proxyauthorization" ||
    key === "cookie" ||
    key === "setcookie" ||
    key === "key" ||
    key.includes("password") ||
    key.includes("passwd") ||
    key.includes("secret") ||
    key.includes("signature") ||
    key.includes("servicekey") ||
    key.includes("apikey") ||
    key.includes("accesstoken") ||
    key.includes("refreshtoken") ||
    key.includes("clientid") ||
    key.includes("customerid") ||
    key === "xcustomer" ||
    key === "token" ||
    key === "credential" ||
    key === "credentials";
}

function redactUrl(value) {
  const text = String(value || "");
  let url;
  try {
    url = new URL(text);
  } catch {
    return text.replace(
      /([?&](?:service[_-]?key|api[_-]?key|client[_-]?secret|access[_-]?token|signature|customer[_-]?id)=)[^&]*/gi,
      `$1${REDACTED}`
    );
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
  }
  return url.toString();
}

function redactText(value, options = {}) {
  let text = String(value ?? "");
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.stringify(redactForLog(JSON.parse(trimmed), options));
    } catch {
      // Continue with conservative string redaction.
    }
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => redactUrl(candidate));
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`);
  text = text.replace(
    /\b(authorization|proxy-authorization|service[_-]?key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|signature|customer[_-]?id|password)\b\s*[:=]\s*([^\s,;&]+)/gi,
    (_match, key) => `${key}=${REDACTED}`
  );
  for (const secret of uniqueStrings(options.secretValues || [])) {
    if (secret.length >= 4) text = text.split(secret).join(REDACTED);
  }
  return text;
}

function redactForLog(value, options = {}, seen = new WeakMap()) {
  if (typeof value === "string") return redactText(value, options);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[BINARY:${value.byteLength} bytes]`;
  if (seen.has(value)) return "[CIRCULAR]";
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (value instanceof Error) {
    output.name = value.name;
    output.code = value.code;
    output.message = redactText(value.message, options);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactForLog(item, options, seen);
  }
  return output;
}

function redactHeaders(headers = {}, options = {}) {
  const output = {};
  for (const [key, value] of headerEntries(headers)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactText(value, options);
  }
  return output;
}

function redactBody(body, options = {}) {
  if (body === null || body === undefined) return body;
  if (typeof body === "string") return redactText(body, options);
  return redactForLog(body, options);
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function") return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

function normalizeHeaders(headers = {}) {
  const output = {};
  for (const [rawKey, rawValue] of headerEntries(headers)) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)) {
      throw new LocationApiTransportError("INVALID_REQUEST_HEADERS", "request contains an invalid header name");
    }
    if (Array.isArray(rawValue) || (rawValue && typeof rawValue === "object")) {
      throw new LocationApiTransportError("INVALID_REQUEST_HEADERS", "request header values must be scalar", { header: key });
    }
    output[key] = String(rawValue ?? "");
  }
  return output;
}

function containsSensitiveObjectKey(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => isSensitiveKey(key) || containsSensitiveObjectKey(item, seen));
}

function bodyContainsCredentialMaterial(body) {
  if (body === null || body === undefined) return false;
  if (typeof body === "object") return containsSensitiveObjectKey(body);
  const text = String(body).trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (containsSensitiveObjectKey(parsed)) return true;
  } catch {
    // It may be form-encoded or plain text.
  }
  return /(?:^|[?&;\s{,])(authorization|service[_-]?key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|signature|customer[_-]?id|password)\s*[:=]/i.test(text) ||
    /\b(?:Bearer|Basic)\s+\S+/i.test(text);
}

function assertNoCredentialMaterial({ url, headers, body, metadata }) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new LocationApiTransportError("CREDENTIAL_MATERIAL_FORBIDDEN", "request descriptors cannot contain URL credentials");
  }
  const sensitiveQueryKeys = [...parsed.searchParams.keys()].filter(isSensitiveKey);
  const sensitiveHeaderKeys = Object.keys(headers || {}).filter(isSensitiveKey);
  if (sensitiveQueryKeys.length || sensitiveHeaderKeys.length || bodyContainsCredentialMaterial(body) || containsSensitiveObjectKey(metadata)) {
    throw new LocationApiTransportError(
      "CREDENTIAL_MATERIAL_FORBIDDEN",
      "request descriptors may contain credential references, never credential material",
      { queryKeys: sensitiveQueryKeys, headerKeys: sensitiveHeaderKeys }
    );
  }
}

function normalizeAuthRef(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", "authRef must be an object containing names only");
  }
  const allowedKeys = new Set(["profile", "credentialEnvNames", "credentialParameterEnvNames"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", "authRef contains unsupported fields", {
      fields: unknownKeys
    });
  }
  const output = {};
  if (value.profile !== undefined) {
    const profile = String(value.profile || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(profile)) {
      throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", "authRef profile is invalid");
    }
    output.profile = profile;
  }
  for (const field of ["credentialEnvNames", "credentialParameterEnvNames"]) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", `${field} must be a non-empty array of environment variable names`);
    }
    const names = [...new Set(value[field].map((item) => String(item || "").trim()))];
    if (names.some((name) => !/^[A-Z][A-Z0-9_]{1,127}$/.test(name))) {
      throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", `${field} contains an invalid environment variable name`);
    }
    output[field] = names;
  }
  if (!Object.keys(output).length) {
    throw new LocationApiTransportError("INVALID_AUTH_REFERENCE", "authRef must contain a profile or credential name reference");
  }
  return output;
}

function createRequestDescriptor(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocationApiTransportError("INVALID_REQUEST_DESCRIPTOR", "request descriptor must be an object");
  }
  const sourceId = String(input.sourceId || "").trim();
  const operation = String(input.operation || "").trim();
  const method = String(input.method || "GET").trim().toUpperCase();
  if (!sourceId || !operation || !/^[A-Z]+$/.test(method)) {
    throw new LocationApiTransportError("INVALID_REQUEST_DESCRIPTOR", "sourceId, operation, and method are required");
  }
  let url;
  try {
    url = new URL(String(input.url || ""));
  } catch {
    throw new LocationApiTransportError("INVALID_REQUEST_URL", "request descriptor URL must be absolute");
  }
  if (url.hash) {
    throw new LocationApiTransportError("INVALID_REQUEST_URL", "request descriptor URL cannot contain a fragment");
  }
  if (url.toString().length > 8192) {
    throw new LocationApiTransportError("INVALID_REQUEST_URL", "request descriptor URL is too long");
  }
  const headers = normalizeHeaders(input.headers || {});
  const body = cloneValue(input.body ?? null);
  const metadata = cloneValue(input.metadata || {});
  const authRef = normalizeAuthRef(input.authRef ?? null);
  assertNoCredentialMaterial({ url: url.toString(), headers, body, metadata: { metadata, authRef } });
  const descriptor = {
    sourceId,
    operation,
    method,
    url: url.toString(),
    headers,
    body,
    retrySafe: input.retrySafe === true,
    estimatedCells: input.estimatedCells === undefined || input.estimatedCells === null
      ? null
      : integerWithin(input.estimatedCells, null, { minimum: 0, maximum: 100_000_000, name: "estimatedCells" }),
    authRef,
    metadata
  };
  return deepFreeze(descriptor);
}

function validateRequestDescriptor(descriptor, policyInput = {}) {
  const policy = isNormalizedPolicy(policyInput) ? policyInput : normalizePolicy(policyInput);
  const normalized = createRequestDescriptor(descriptor);
  const url = new URL(normalized.url);
  if (url.protocol !== "https:") {
    throw new LocationApiTransportError("HTTPS_REQUIRED", "external API requests require HTTPS", { protocol: url.protocol });
  }
  if (url.port && url.port !== "443") {
    throw new LocationApiTransportError("PORT_NOT_ALLOWED", "external API requests require the default HTTPS port", { host: url.hostname });
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!policy.allowedHosts.includes(hostname)) {
    throw new LocationApiTransportError("HOST_NOT_ALLOWED", "request host is not on the exact allowlist", { host: hostname });
  }
  if (!policy.allowedMethods.includes(normalized.method)) {
    throw new LocationApiTransportError("METHOD_NOT_ALLOWED", "request method is not permitted", { method: normalized.method });
  }
  if (["GET", "HEAD"].includes(normalized.method) && normalized.body !== null) {
    throw new LocationApiTransportError("BODY_NOT_ALLOWED", `${normalized.method} request descriptors cannot contain a body`);
  }
  const referencedCredentialNames = normalized.authRef
    ? ["credentialEnvNames", "credentialParameterEnvNames"].flatMap((field) => normalized.authRef[field] || [])
    : [];
  if (referencedCredentialNames.some((name) => !policy.credentialEnvNames.includes(name))) {
    throw new LocationApiTransportError(
      "AUTH_REFERENCE_NOT_ALLOWED",
      "request authRef contains a credential name outside the source policy allowlist"
    );
  }
  if (policy.rateLimit.maxCellsPerRequest !== null &&
      normalized.estimatedCells !== null &&
      normalized.estimatedCells > policy.rateLimit.maxCellsPerRequest) {
    throw new LocationApiTransportError("REQUEST_SIZE_POLICY_EXCEEDED", "estimated response cells exceed provider policy", {
      estimatedCells: normalized.estimatedCells,
      maxCellsPerRequest: policy.rateLimit.maxCellsPerRequest
    });
  }
  return normalized;
}

function isNormalizedPolicy(value) {
  return Boolean(value && Object.isFrozen(value) && value.retry && value.rateLimit && Array.isArray(value.allowedHosts));
}

function receiptTime(value, field) {
  const milliseconds = Date.parse(String(value || ""));
  if (!Number.isFinite(milliseconds)) {
    throw new LocationApiTransportError("APPROVAL_INVALID", `approval receipt ${field} is invalid`);
  }
  return milliseconds;
}

function toNowMs(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function assertExecutionApproved({ descriptor, actualCallsEnabled = false, approvalReceipt = null, now = Date.now } = {}) {
  if (actualCallsEnabled !== true) {
    throw new LocationApiTransportError("LIVE_CALLS_DISABLED", "live external API calls are disabled");
  }
  if (!approvalReceipt || typeof approvalReceipt !== "object") {
    throw new LocationApiTransportError("APPROVAL_REQUIRED", "a scoped approval receipt is required");
  }
  if (approvalReceipt.approved !== true || approvalReceipt.allowExternalNetwork !== true) {
    throw new LocationApiTransportError("APPROVAL_REQUIRED", "approval receipt does not permit external network access");
  }
  if (approvalReceipt.scope !== APPROVAL_SCOPE || !String(approvalReceipt.approvalId || "").trim()) {
    throw new LocationApiTransportError("APPROVAL_INVALID", "approval receipt scope or identifier is invalid");
  }
  const issuedAt = receiptTime(approvalReceipt.issuedAt, "issuedAt");
  const expiresAt = receiptTime(approvalReceipt.expiresAt, "expiresAt");
  const currentTime = toNowMs(now);
  if (issuedAt > currentTime + 5 * 60 * 1000 || expiresAt <= currentTime || expiresAt <= issuedAt) {
    throw new LocationApiTransportError("APPROVAL_EXPIRED", "approval receipt is not currently valid");
  }
  const normalized = createRequestDescriptor(descriptor);
  const host = new URL(normalized.url).hostname.toLowerCase().replace(/\.$/, "");
  const sourceIds = uniqueStrings(approvalReceipt.sourceIds);
  const allowedHosts = uniqueStrings(approvalReceipt.allowedHosts).map(normalizeHost);
  if (!sourceIds.includes(normalized.sourceId)) {
    throw new LocationApiTransportError("APPROVAL_SOURCE_MISMATCH", "approval receipt does not include the requested source");
  }
  if (!allowedHosts.includes(host)) {
    throw new LocationApiTransportError("APPROVAL_HOST_MISMATCH", "approval receipt does not include the requested host", { host });
  }
  const approvedDescriptorHashes = uniqueStrings(
    approvalReceipt.descriptorHashes,
    approvalReceipt.descriptorHash ? [approvalReceipt.descriptorHash] : []
  );
  if (!approvedDescriptorHashes.includes(createApprovalDescriptorHash(normalized))) {
    throw new LocationApiTransportError(
      "APPROVAL_DESCRIPTOR_MISMATCH",
      "approval receipt does not include the exact sanitized request descriptor"
    );
  }
  return true;
}

function serializeBody(body) {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}

function normalizeExecutableRequest(input, descriptor) {
  const candidate = input || descriptor;
  let url;
  try {
    url = new URL(String(candidate.url || ""));
  } catch {
    throw new LocationApiTransportError("INVALID_AUTHORIZED_REQUEST", "authorized request URL must be absolute");
  }
  const method = String(candidate.method || descriptor.method).toUpperCase();
  return {
    url: url.toString(),
    method,
    headers: normalizeHeaders(candidate.headers || {}),
    body: candidate.body ?? null
  };
}

function sortedNonSensitiveQueryEntries(url) {
  return [...url.searchParams.entries()]
    .filter(([key]) => !isSensitiveKey(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
}

function stableSerialize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString("base64") });
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new LocationApiTransportError("INVALID_REQUEST_DESCRIPTOR", "request descriptor contains an unsupported or circular value");
  }
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  } else {
    output = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return output;
}

function createApprovalDescriptorHash(inputDescriptor) {
  const descriptor = createRequestDescriptor(inputDescriptor);
  const url = new URL(descriptor.url);
  const ordinaryHeaders = Object.fromEntries(
    Object.entries(descriptor.headers || {})
      .filter(([key]) => !isSensitiveKey(key))
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const approvalTarget = {
    sourceId: descriptor.sourceId,
    operation: descriptor.operation,
    method: descriptor.method,
    origin: url.origin,
    pathname: url.pathname,
    query: sortedNonSensitiveQueryEntries(url),
    headers: ordinaryHeaders,
    body: descriptor.body,
    retrySafe: descriptor.retrySafe,
    estimatedCells: descriptor.estimatedCells,
    authRef: descriptor.authRef,
    metadata: descriptor.metadata
  };
  return crypto.createHash("sha256").update(stableSerialize(approvalTarget)).digest("hex");
}

function bodyFingerprint(body) {
  if (body === null || body === undefined) return "null";
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return `bytes:${Buffer.from(body).toString("base64")}`;
  }
  if (typeof body === "string") return `string:${body}`;
  try {
    return `json:${stableSerialize(body)}`;
  } catch {
    throw new LocationApiTransportError("INVALID_AUTHORIZED_REQUEST", "authorized request body must be serializable");
  }
}

function validateExecutableRequest(request, descriptor, policy) {
  const url = new URL(request.url);
  const descriptorUrl = new URL(descriptor.url);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new LocationApiTransportError("HTTPS_REQUIRED", "authorized request must retain HTTPS on the default port");
  }
  if (url.hash) {
    throw new LocationApiTransportError("AUTHORIZED_REQUEST_SCOPE_MISMATCH", "authorization cannot add a URL fragment");
  }
  if (!policy.allowedHosts.includes(hostname) || hostname !== descriptorUrl.hostname.toLowerCase().replace(/\.$/, "")) {
    throw new LocationApiTransportError("HOST_NOT_ALLOWED", "authorization cannot change the approved request host", { host: hostname });
  }
  if (request.method !== descriptor.method) {
    throw new LocationApiTransportError("METHOD_NOT_ALLOWED", "authorization cannot change the approved request method");
  }
  if (url.pathname !== descriptorUrl.pathname ||
      JSON.stringify(sortedNonSensitiveQueryEntries(url)) !== JSON.stringify(sortedNonSensitiveQueryEntries(descriptorUrl))) {
    throw new LocationApiTransportError(
      "AUTHORIZED_REQUEST_SCOPE_MISMATCH",
      "authorization may add credential query parameters but cannot change the approved path or ordinary query"
    );
  }
  const descriptorHeaders = normalizeHeaders(descriptor.headers || {});
  const executableHeaders = normalizeHeaders(request.headers || {});
  const ordinaryDescriptorHeaders = Object.entries(descriptorHeaders)
    .filter(([key]) => !isSensitiveKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const ordinaryExecutableHeaders = Object.entries(executableHeaders)
    .filter(([key]) => !isSensitiveKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(ordinaryExecutableHeaders) !== JSON.stringify(ordinaryDescriptorHeaders)) {
    throw new LocationApiTransportError(
      "AUTHORIZED_REQUEST_SCOPE_MISMATCH",
      "authorization may add credential headers but cannot change ordinary headers"
    );
  }
  if (bodyFingerprint(request.body) !== bodyFingerprint(descriptor.body)) {
    throw new LocationApiTransportError(
      "AUTHORIZED_REQUEST_SCOPE_MISMATCH",
      "authorization cannot change the approved request body"
    );
  }
  return request;
}

function retrySafe(descriptor) {
  return ["GET", "HEAD", "OPTIONS"].includes(descriptor.method) || descriptor.retrySafe === true;
}

function responseHeader(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") return String(response.headers.get(name) || "");
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1] || "") : "";
}

function retryAfterMs(response, nowMs) {
  const value = responseHeader(response, "retry-after").trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function computeBackoffMs({ attempt, status = null, response = null, policy, nowMs = Date.now() }) {
  const statusFloor = status === null ? 0 : Number(policy.retry.backoffByStatus[String(status)] || 0);
  const exponential = Math.min(
    policy.retry.maxBackoffMs,
    policy.retry.baseBackoffMs * (2 ** Math.max(0, attempt - 1))
  );
  const retryAfter = policy.retry.honorRetryAfter ? retryAfterMs(response, nowMs) : null;
  return Math.min(policy.retry.maxBackoffMs, Math.max(statusFloor, exponential, retryAfter || 0));
}

function transientError(error, policy) {
  if (error instanceof LocationApiTransportError) return error.code === "TIMEOUT";
  if (error?.name === "AbortError") return true;
  return policy.retry.retryableErrorCodes.includes(String(error?.code || ""));
}

async function readResponseBody(response, maxResponseBytes) {
  const contentLength = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new LocationApiTransportError("RESPONSE_TOO_LARGE", "upstream response exceeds the byte limit", {
      responseBytes: contentLength,
      maxResponseBytes
    });
  }
  const chunks = [];
  let bytes = 0;
  const append = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxResponseBytes) {
      throw new LocationApiTransportError("RESPONSE_TOO_LARGE", "upstream response exceeds the byte limit", {
        responseBytes: bytes,
        maxResponseBytes
      });
    }
    chunks.push(buffer);
  };

  if (typeof response?.body === "string" || Buffer.isBuffer(response?.body) || response?.body instanceof Uint8Array) {
    append(response.body);
  } else if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      if (error instanceof LocationApiTransportError && typeof reader.cancel === "function") await reader.cancel();
      throw error;
    }
  } else if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const chunk of response.body) append(chunk);
  } else if (typeof response?.arrayBuffer === "function") {
    append(new Uint8Array(await response.arrayBuffer()));
  } else if (typeof response?.text === "function") {
    append(await response.text());
  } else if (response?.body !== null && response?.body !== undefined) {
    append(JSON.stringify(response.body));
  }
  return { bodyText: Buffer.concat(chunks).toString("utf8"), bodyBytes: bytes };
}

function normalizedResponseHeaders(headers) {
  return redactHeaders(headers || {});
}

function responseStatus(response) {
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new LocationApiTransportError("UPSTREAM_RESPONSE_INVALID", "transport returned an invalid HTTP status");
  }
  return status;
}

async function invokeWithTimeout(invoke, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LocationApiTransportError("TIMEOUT", "external API request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => invoke(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function createTransport({
  mode,
  invoke,
  authorizeRequest = null,
  policy: policyInput = {},
  sourcePolicies = {},
  actualCallsEnabled = false,
  approvalReceipt = null,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  classifyResponse = null,
  classifyError = null
}) {
  if (!new Set(["fixture", "live"]).has(mode)) {
    throw new LocationApiTransportError("INVALID_TRANSPORT_MODE", "transport mode must be fixture or live");
  }
  if (mode === "fixture" && typeof invoke !== "function") {
    throw new LocationApiTransportError("FIXTURE_RESPONDER_REQUIRED", "fixture transport requires an injected responder");
  }
  const basePolicy = normalizePolicy(policyInput);
  const normalizedSourcePolicies = new Map();
  for (const [sourceId, override] of Object.entries(sourcePolicies || {})) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new LocationApiTransportError("INVALID_TRANSPORT_POLICY", "source policy must be an object", { sourceId });
    }
    const overrideRetry = override.retry || override.retryPolicy || {};
    const overrideRateLimit = override.rateLimit || override.rateLimitPolicy || {};
    normalizedSourcePolicies.set(sourceId, normalizePolicy({
      ...basePolicy,
      ...override,
      retry: { ...basePolicy.retry, ...overrideRetry },
      rateLimit: { ...basePolicy.rateLimit, ...overrideRateLimit }
    }));
  }
  const lastDispatchByHost = new Map();
  const concurrencyByHost = new Map();

  function policyFor(sourceId) {
    return normalizedSourcePolicies.get(sourceId) || basePolicy;
  }

  async function waitForRateLimit(host, policy) {
    const currentTime = toNowMs(now);
    const previous = lastDispatchByHost.get(host);
    if (previous !== undefined) {
      const remaining = policy.rateLimit.minIntervalMs - (currentTime - previous);
      if (remaining > 0) await sleep(remaining);
    }
    lastDispatchByHost.set(host, toNowMs(now));
  }

  async function acquireConcurrency(host, maximum) {
    const state = concurrencyByHost.get(host) || { active: 0, queue: [] };
    concurrencyByHost.set(host, state);
    await new Promise((resolve) => {
      const acquire = () => {
        if (state.active < maximum) {
          state.active += 1;
          resolve();
          return;
        }
        state.queue.push(acquire);
      };
      acquire();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      const next = state.queue.shift();
      if (next) next();
    };
  }

  async function execute(inputDescriptor) {
    const provisional = createRequestDescriptor(inputDescriptor);
    const policy = policyFor(provisional.sourceId);
    const descriptor = validateRequestDescriptor(provisional, policy);
    if (mode === "live") {
      assertExecutionApproved({ descriptor, actualCallsEnabled, approvalReceipt, now });
      if (typeof invoke !== "function") {
        throw new LocationApiTransportError("TRANSPORT_NOT_INJECTED", "live transport requires an explicitly injected executor");
      }
    }
    const host = new URL(descriptor.url).hostname.toLowerCase().replace(/\.$/, "");
    let lastError = null;

    for (let attempt = 1; attempt <= policy.retry.maxAttempts; attempt += 1) {
      const releaseConcurrency = await acquireConcurrency(host, policy.rateLimit.maxConcurrency);
      try {
        await waitForRateLimit(host, policy);
        let executable = {
          url: descriptor.url,
          method: descriptor.method,
          headers: descriptor.headers,
          body: descriptor.body
        };
        if (mode === "live" && typeof authorizeRequest === "function") {
          executable = normalizeExecutableRequest(await authorizeRequest(cloneValue(descriptor)), descriptor);
        } else {
          executable = normalizeExecutableRequest(executable, descriptor);
        }
        validateExecutableRequest(executable, descriptor, policy);
        const response = await invokeWithTimeout(
          (signal) => invoke({
            descriptor,
            request: {
              url: executable.url,
              options: {
                method: executable.method,
                headers: executable.headers,
                body: serializeBody(executable.body),
                redirect: "error",
                signal
              }
            },
            attempt,
            signal
          }),
          policy.timeoutMs
        );
        const status = responseStatus(response);
        const payload = await readResponseBody(response, policy.maxResponseBytes);
        const classification = typeof classifyResponse === "function"
          ? await classifyResponse({ descriptor, response: { status, ...payload }, attempt }) || {}
          : {};
        const statusRetryable = policy.retry.retryableStatusCodes.includes(status);
        const requiredRetryAfterMissing = status === 429 &&
          policy.retry.retryAfterRequiredFor429 &&
          retryAfterMs(response, toNowMs(now)) === null;
        const retryable = classification.retryable === false
          ? false
          : statusRetryable && !requiredRetryAfterMissing;
        if (retryable && retrySafe(descriptor) && attempt < policy.retry.maxAttempts) {
          const backoffMs = classification.backoffMs === undefined
            ? computeBackoffMs({ attempt, status, response, policy, nowMs: toNowMs(now) })
            : Math.min(policy.retry.maxBackoffMs, Math.max(0, Number(classification.backoffMs) || 0));
          if (backoffMs) await sleep(backoffMs);
          continue;
        }
        return deepFreeze({
          ok: status >= 200 && status < 300,
          status,
          headers: normalizedResponseHeaders(response.headers),
          ...payload,
          attempts: attempt,
          executionMode: mode,
          request: redactForLog({
            sourceId: descriptor.sourceId,
            operation: descriptor.operation,
            method: executable.method,
            url: executable.url,
            headers: executable.headers,
            body: executable.body
          }),
          classification: redactForLog(classification)
        });
      } catch (error) {
        lastError = error;
        const classification = typeof classifyError === "function"
          ? await classifyError({ descriptor, error, attempt }) || {}
          : {};
        const retryable = classification.retryable === false ? false : transientError(error, policy);
        if (retryable && retrySafe(descriptor) && attempt < policy.retry.maxAttempts) {
          const backoffMs = classification.backoffMs === undefined
            ? computeBackoffMs({ attempt, policy, nowMs: toNowMs(now) })
            : Math.min(policy.retry.maxBackoffMs, Math.max(0, Number(classification.backoffMs) || 0));
          if (backoffMs) await sleep(backoffMs);
          continue;
        }
        if (error instanceof LocationApiTransportError) throw error;
        throw new LocationApiTransportError("REQUEST_FAILED", "injected transport failed", {
          cause: error,
          sourceId: descriptor.sourceId,
          operation: descriptor.operation
        });
      } finally {
        releaseConcurrency();
      }
    }
    throw new LocationApiTransportError("REQUEST_FAILED", "injected transport exhausted retry attempts", { cause: lastError });
  }

  async function executePaginated({ initialDescriptor, getNextDescriptor, maxPages = null } = {}) {
    if (typeof getNextDescriptor !== "function") {
      throw new LocationApiTransportError("INVALID_PAGINATION", "getNextDescriptor must be injected");
    }
    const first = createRequestDescriptor(initialDescriptor);
    const policy = policyFor(first.sourceId);
    const limit = maxPages === null
      ? policy.maxPages
      : integerWithin(maxPages, policy.maxPages, { minimum: 1, maximum: policy.maxPages, name: "maxPages" });
    const pages = [];
    const fingerprints = new Set();
    let descriptor = first;
    while (descriptor) {
      const fingerprint = `${descriptor.method} ${descriptor.url}`;
      if (fingerprints.has(fingerprint)) {
        throw new LocationApiTransportError("PAGINATION_LOOP", "pagination returned a repeated request descriptor");
      }
      fingerprints.add(fingerprint);
      if (pages.length >= limit) {
        throw new LocationApiTransportError("PAGE_LIMIT_EXCEEDED", "pagination exceeded the configured page limit", { maxPages: limit });
      }
      const response = await execute(descriptor);
      pages.push(response);
      const next = await getNextDescriptor({ descriptor, response, pageIndex: pages.length - 1 });
      descriptor = next ? createRequestDescriptor(next) : null;
      if (descriptor && descriptor.sourceId !== first.sourceId) {
        throw new LocationApiTransportError("PAGINATION_SOURCE_MISMATCH", "pagination cannot change sourceId");
      }
    }
    return deepFreeze({ pages, pageCount: pages.length, executionMode: mode });
  }

  return Object.freeze({
    mode,
    actualCallsEnabled: mode === "live" && actualCallsEnabled === true,
    approvalRequired: mode === "live",
    policy: basePolicy,
    execute,
    executePaginated
  });
}

function createFixtureTransport({ responder, ...options } = {}) {
  return createTransport({ ...options, mode: "fixture", invoke: responder });
}

function createLiveTransport({ executor, fetchImpl, ...options } = {}) {
  if (fetchImpl !== undefined) {
    throw new LocationApiTransportError(
      "TRANSPORT_INTERFACE_INVALID",
      "inject an executor explicitly; this module never wraps or falls back to fetch"
    );
  }
  return createTransport({ ...options, mode: "live", invoke: executor });
}

module.exports = {
  APPROVAL_SCOPE,
  DEFAULT_POLICY,
  REDACTED,
  TRANSIENT_ERROR_CODES,
  TRANSIENT_STATUS_CODES,
  LocationApiTransportError,
  assertExecutionApproved,
  computeBackoffMs,
  createApprovalDescriptorHash,
  createFixtureTransport,
  createLiveTransport,
  createRequestDescriptor,
  isSensitiveKey,
  normalizePolicy,
  redactBody,
  redactForLog,
  redactHeaders,
  redactUrl,
  validateRequestDescriptor
};
