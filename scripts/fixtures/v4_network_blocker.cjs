const NETWORK_ERROR_CODE = "V4_OFFLINE_NETWORK_BLOCKED";

function networkBlocked() {
  const error = new Error("Outbound network access is disabled in V4 shadow fixture mode.");
  error.code = NETWORK_ERROR_CODE;
  throw error;
}

function replace(moduleName, methods) {
  const target = require(moduleName);
  for (const method of methods) {
    if (typeof target[method] === "function") target[method] = networkBlocked;
  }
}

replace("node:http", ["request", "get"]);
replace("node:https", ["request", "get"]);
replace("node:http2", ["connect"]);
replace("node:net", ["connect", "createConnection"]);
replace("node:tls", ["connect"]);
replace("node:dgram", ["createSocket"]);
replace("node:dns", [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
]);
replace("node:dns/promises", [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
]);

globalThis.fetch = networkBlocked;
if (typeof globalThis.WebSocket === "function") globalThis.WebSocket = networkBlocked;
if (typeof globalThis.EventSource === "function") globalThis.EventSource = networkBlocked;
Object.defineProperty(globalThis, "__DATALAB_V4_NETWORK_BLOCKED__", {
  value: true,
  configurable: false,
  enumerable: false,
  writable: false
});

module.exports = { NETWORK_ERROR_CODE };
