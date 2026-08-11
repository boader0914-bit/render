const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const crypto = require("node:crypto");

const CANARY_PROVIDER = "naver-local-search";
const CANARY_HOSTNAME = "openapi.naver.com";
const REQUEST_BUDGET = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
];

class CanaryNetworkError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CanaryNetworkError";
    this.code = code;
    this.stage = "network";
    this.retryable = false;
    this.details = details;
  }
}

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
]) blockedAddresses.addSubnet(network, prefix, "ipv6");

function boundedInteger(value, fallback, min, max, name) {
  const source = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(source) || source < min || source > max) {
    throw new CanaryNetworkError("CANARY_NETWORK_CONFIG_INVALID", `${name} is outside its allowed range.`);
  }
  return source;
}

function assertProxyEnvironmentBlocked(env = process.env) {
  const present = PROXY_ENV_NAMES.filter((name) => String(env[name] || "").trim());
  if (present.length) {
    throw new CanaryNetworkError(
      "CANARY_PROXY_ENV_FORBIDDEN",
      `Proxy environment variables are forbidden: ${present.sort().join(", ")}.`
    );
  }
}

function validateTargetUrl(value, allowedHostname = CANARY_HOSTNAME) {
  let target;
  try {
    target = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new CanaryNetworkError("CANARY_URL_INVALID", "Canary target URL is invalid.");
  }
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:") {
    throw new CanaryNetworkError("CANARY_HTTPS_REQUIRED", "Canary requests require HTTPS.");
  }
  if (target.username || target.password) {
    throw new CanaryNetworkError("CANARY_URL_CREDENTIALS_FORBIDDEN", "URL credentials are forbidden.");
  }
  if (target.port && target.port !== "443") {
    throw new CanaryNetworkError("CANARY_PORT_FORBIDDEN", "Only the default HTTPS port is allowed.");
  }
  if (net.isIP(hostname)) {
    throw new CanaryNetworkError("CANARY_DIRECT_IP_FORBIDDEN", "Direct IP targets are forbidden.");
  }
  if (hostname !== String(allowedHostname).toLowerCase()) {
    throw new CanaryNetworkError("CANARY_HOSTNAME_FORBIDDEN", "Canary target hostname is not approved.");
  }
  if (target.hash) {
    throw new CanaryNetworkError("CANARY_URL_FRAGMENT_FORBIDDEN", "URL fragments are forbidden.");
  }
  return target;
}

function normalizeDnsRecords(value) {
  const records = Array.isArray(value) ? value : [value];
  if (!records.length) {
    throw new CanaryNetworkError("CANARY_DNS_EMPTY", "Approved hostname did not resolve to an address.");
  }
  return records.map((record) => {
    const address = typeof record === "string" ? record : record?.address;
    const family = Number(typeof record === "string" ? net.isIP(record) : record?.family || net.isIP(address));
    if (!address || ![4, 6].includes(family) || net.isIP(address) !== family) {
      throw new CanaryNetworkError("CANARY_DNS_INVALID", "Approved hostname returned an invalid DNS record.");
    }
    if (family === 6 && /^::ffff:/i.test(address)) {
      throw new CanaryNetworkError("CANARY_DNS_ADDRESS_FORBIDDEN", "IPv4-mapped DNS addresses are forbidden.");
    }
    if (blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")) {
      throw new CanaryNetworkError("CANARY_DNS_ADDRESS_FORBIDDEN", "Approved hostname resolved to a non-public address.");
    }
    return { address, family };
  });
}

async function resolveApprovedHostname(target, lookupFn = dns.lookup) {
  let records;
  try {
    records = await lookupFn(target.hostname, { all: true, verbatim: true });
  } catch {
    throw new CanaryNetworkError("CANARY_DNS_FAILED", "Approved hostname could not be resolved.");
  }
  return normalizeDnsRecords(records);
}

function pinnedLookup(expectedHostname, records) {
  let index = 0;
  return (hostname, options, callback) => {
    if (String(hostname).toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(new CanaryNetworkError("CANARY_DNS_REBIND_BLOCKED", "Unexpected hostname lookup was blocked."));
      return;
    }
    if (options?.all) {
      callback(null, records.map((record) => ({ ...record })));
      return;
    }
    const selected = records[index % records.length];
    index += 1;
    callback(null, selected.address, selected.family);
  };
}

function defaultRequestImpl({ target, headers, lookup, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(target, {
      method: "GET",
      agent: false,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": "datalab-v4-canary/1.0",
        ...headers
      },
      lookup
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          response.destroy(new CanaryNetworkError(
            "CANARY_RESPONSE_TOO_LARGE",
            "Provider response exceeded the configured byte limit."
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: Number(response.statusCode || 0),
          headers: response.headers || {},
          body: Buffer.concat(chunks)
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new CanaryNetworkError("CANARY_REQUEST_TIMEOUT", "Provider request exceeded its timeout."));
    });
    request.once("error", fail);
    request.end();
  });
}

function createCanaryTransport(options = {}) {
  const env = options.env || process.env;
  const allowedHostname = options.allowedHostname || CANARY_HOSTNAME;
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? env.V4_CANARY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1000,
    15000,
    "V4_CANARY_TIMEOUT_MS"
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? env.V4_CANARY_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    1024 * 1024,
    "V4_CANARY_MAX_RESPONSE_BYTES"
  );
  const lookupFn = options.lookupFn || dns.lookup;
  const requestImpl = options.requestImpl || defaultRequestImpl;
  let requestCount = 0;

  return {
    get requestCount() {
      return requestCount;
    },
    async requestJson({ url, headers = {} }) {
      if (requestCount >= REQUEST_BUDGET) {
        throw new CanaryNetworkError("CANARY_REQUEST_BUDGET_EXCEEDED", "Canary request budget is exhausted.");
      }
      requestCount += 1;
      assertProxyEnvironmentBlocked(env);
      const target = validateTargetUrl(url, allowedHostname);
      const records = await resolveApprovedHostname(target, lookupFn);
      let response;
      try {
        response = await requestImpl({
          target,
          headers,
          lookup: pinnedLookup(target.hostname, records),
          timeoutMs,
          maxResponseBytes
        });
      } catch (error) {
        if (error instanceof CanaryNetworkError) throw error;
        throw new CanaryNetworkError("CANARY_REQUEST_FAILED", "Provider request failed before a valid response was received.");
      }
      const statusCode = Number(response?.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400) {
        throw new CanaryNetworkError("CANARY_REDIRECT_BLOCKED", "Provider redirect responses are forbidden.", { statusCode });
      }
      const body = Buffer.isBuffer(response?.body) ? response.body : Buffer.from(String(response?.body || ""), "utf8");
      if (body.length > maxResponseBytes) {
        throw new CanaryNetworkError("CANARY_RESPONSE_TOO_LARGE", "Provider response exceeded the configured byte limit.");
      }
      if (statusCode < 200 || statusCode >= 300) {
        throw new CanaryNetworkError("CANARY_PROVIDER_HTTP_ERROR", "Provider returned a non-success HTTP status.", { statusCode });
      }
      let data;
      try {
        data = JSON.parse(body.toString("utf8"));
      } catch {
        throw new CanaryNetworkError("CANARY_PROVIDER_JSON_INVALID", "Provider response was not valid JSON.");
      }
      return {
        statusCode,
        data,
        responseBytes: body.length,
        responseDigest: crypto.createHash("sha256").update(body).digest("hex"),
        requestCount
      };
    }
  };
}

module.exports = {
  CANARY_HOSTNAME,
  CANARY_PROVIDER,
  CanaryNetworkError,
  PROXY_ENV_NAMES,
  REQUEST_BUDGET,
  assertProxyEnvironmentBlocked,
  createCanaryTransport,
  normalizeDnsRecords,
  resolveApprovedHostname,
  validateTargetUrl
};
