"use strict";

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function hostFromTarget(target, fallbackProtocol = "http:") {
  if (target instanceof URL) return target.hostname;
  if (typeof target === "string") {
    try {
      return new URL(target, `${fallbackProtocol}//localhost`).hostname;
    } catch {
      return "";
    }
  }
  if (target && typeof target === "object") {
    return String(target.hostname || target.host || "").replace(/^\[|\]$/g, "").split(":")[0];
  }
  return "";
}

function installFixtureNetworkGuard({ allowLocalhost = false, label = "fixture" } = {}) {
  let blockedAttempts = 0;
  const original = {
    fetch: globalThis.fetch,
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect
  };

  function assertAllowed(target, protocol) {
    const host = hostFromTarget(target, protocol);
    if (allowLocalhost && LOCAL_HOSTS.has(host)) return;
    blockedAttempts += 1;
    throw new Error(`External network is forbidden in ${label}: ${host || "unknown target"}`);
  }

  if (typeof original.fetch === "function") {
    globalThis.fetch = function guardedFetch(target, ...args) {
      assertAllowed(target, "http:");
      return original.fetch.call(this, target, ...args);
    };
  }

  function wrap(originalFunction, protocol) {
    return function guardedRequest(target, ...args) {
      assertAllowed(target, protocol);
      return originalFunction.call(this, target, ...args);
    };
  }

  http.get = wrap(original.httpGet, "http:");
  http.request = wrap(original.httpRequest, "http:");
  https.get = wrap(original.httpsGet, "https:");
  https.request = wrap(original.httpsRequest, "https:");
  net.connect = wrap(original.netConnect, "tcp:");
  net.createConnection = wrap(original.netCreateConnection, "tcp:");
  tls.connect = wrap(original.tlsConnect, "tls:");

  return Object.freeze({
    blockedAttempts: () => blockedAttempts,
    restore() {
      globalThis.fetch = original.fetch;
      http.get = original.httpGet;
      http.request = original.httpRequest;
      https.get = original.httpsGet;
      https.request = original.httpsRequest;
      net.connect = original.netConnect;
      net.createConnection = original.netCreateConnection;
      tls.connect = original.tlsConnect;
    }
  });
}

module.exports = { LOCAL_HOSTS, installFixtureNetworkGuard };
