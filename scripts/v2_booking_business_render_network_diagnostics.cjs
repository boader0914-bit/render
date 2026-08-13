"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");

const EVENT_NAMES = Object.freeze([
  "undici:request:create",
  "undici:client:beforeConnect",
  "undici:client:connected",
  "undici:request:headers",
  "undici:request:trailers",
  "undici:request:error"
]);

function headerNames(value) {
  if (Buffer.isBuffer(value)) return headerNames(value.toString("latin1"));
  if (Array.isArray(value)) {
    const names = [];
    for (let index = 0; index < value.length; index += 2) {
      if (value[index] !== undefined) names.push(String(value[index]).toLowerCase());
    }
    return [...new Set(names)].sort();
  }
  return [...new Set(String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.match(/^([^:\s]+)\s*:/u)?.[1]?.toLowerCase() || "")
    .filter(Boolean))].sort();
}

function safeNetworkFailureClass(error) {
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "timeout";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "tls";
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return "connection";
  return error ? "network" : null;
}

function safeSocketProjection(socket) {
  return Object.freeze({
    encrypted: Boolean(socket?.encrypted),
    addressFamily: ["IPv4", "IPv6"].includes(socket?.remoteFamily) ? socket.remoteFamily : null,
    alpnProtocol: typeof socket?.alpnProtocol === "string" && socket.alpnProtocol ? socket.alpnProtocol : null,
    tlsProtocol: typeof socket?.getProtocol === "function" ? socket.getProtocol() || null : null,
    cipherName: typeof socket?.getCipher === "function" ? socket.getCipher()?.name || null : null,
    tlsAuthorized: typeof socket?.authorized === "boolean" ? socket.authorized : null,
    connectionReused: typeof socket?.reusedSocket === "boolean" ? socket.reusedSocket : null,
    hostStored: false,
    serverNameStored: false,
    ipAddressStored: false,
    certificateStored: false
  });
}

function projectEvent(name, message = {}) {
  if (name === "undici:request:create") {
    return Object.freeze({
      name,
      method: String(message.request?.method || ""),
      protocol: String(message.request?.protocol || ""),
      contentLength: Number.isInteger(message.request?.contentLength) ? message.request.contentLength : null,
      headerNames: headerNames(message.request?.headers),
      requestTargetStored: false,
      headerValuesStored: false,
      requestBodyStored: false
    });
  }
  if (name === "undici:client:beforeConnect") {
    return Object.freeze({
      name,
      protocol: String(message.connectParams?.protocol || ""),
      hostStored: false,
      serverNameStored: false,
      ipAddressStored: false
    });
  }
  if (name === "undici:client:connected") return Object.freeze({ name, ...safeSocketProjection(message.socket) });
  if (name === "undici:request:headers") {
    return Object.freeze({
      name,
      statusCode: Number.isInteger(message.response?.statusCode) ? message.response.statusCode : null,
      responseHeaderNames: headerNames(message.response?.headers),
      responseHeaderValuesStored: false,
      responseBodyStored: false
    });
  }
  if (name === "undici:request:error") {
    return Object.freeze({
      name,
      failureClass: safeNetworkFailureClass(message.error),
      errorMessageStored: false,
      errorStackStored: false
    });
  }
  return Object.freeze({ name, responseHeaderValuesStored: false, responseBodyStored: false });
}

function createRenderNetworkRecorder({ maximumEvents = 24 } = {}) {
  if (!Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 64) {
    throw new TypeError("maximumEvents must be an integer from 1 through 64");
  }
  const events = [];
  const subscriptions = [];
  const subscribe = (name) => {
    const listener = (message) => {
      if (events.length < maximumEvents) events.push(projectEvent(name, message));
    };
    diagnosticsChannel.subscribe(name, listener);
    subscriptions.push([name, listener]);
  };
  for (const name of EVENT_NAMES) subscribe(name);
  let closed = false;
  return Object.freeze({
    snapshot() {
      const counts = Object.fromEntries(EVENT_NAMES.map((name) => [name, events.filter((entry) => entry.name === name).length]));
      return Object.freeze({
        schemaVersion: "v2-booking-business-render-network-diagnostics.v1",
        counts,
        events: events.map((entry) => ({ ...entry })),
        truncated: events.length >= maximumEvents,
        dnsAnswersStored: false,
        hostNamesStored: false,
        ipAddressesStored: false,
        requestTargetsStored: false,
        headerValuesStored: false,
        requestBodiesStored: false,
        responseBodiesStored: false,
        certificatesStored: false
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [name, listener] of subscriptions) diagnosticsChannel.unsubscribe(name, listener);
    }
  });
}

function installRenderNetworkRecorderFromEnvironment(env = process.env) {
  if (env.V2_BOOKING_BUSINESS_NETWORK_DIAGNOSTICS !== "1") return null;
  if (globalThis.__V2_BOOKING_BUSINESS_RENDER_NETWORK_RECORDER__) {
    return globalThis.__V2_BOOKING_BUSINESS_RENDER_NETWORK_RECORDER__;
  }
  const recorder = createRenderNetworkRecorder();
  Object.defineProperty(globalThis, "__V2_BOOKING_BUSINESS_RENDER_NETWORK_RECORDER__", {
    value: recorder,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return recorder;
}

installRenderNetworkRecorderFromEnvironment();

module.exports = {
  EVENT_NAMES,
  createRenderNetworkRecorder,
  headerNames,
  projectEvent,
  installRenderNetworkRecorderFromEnvironment,
  safeNetworkFailureClass,
  safeSocketProjection
};
