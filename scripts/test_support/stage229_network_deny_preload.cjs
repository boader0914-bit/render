"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const GUARD_MARKER = Symbol.for("lodging-datalab.stage229.network-deny");
if (!globalThis[GUARD_MARKER]) {
  Object.defineProperty(globalThis, GUARD_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });

  const logPath = String(process.env.STAGE229_NETWORK_GUARD_LOG || "").trim();

  function safeTarget(input) {
    try {
      const candidate = input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : String(input?.href || input?.hostname || "unknown"));
      return `${candidate.protocol}//${candidate.hostname}${candidate.port ? `:${candidate.port}` : ""}`;
    } catch {
      return "unparseable-target";
    }
  }

  function record(channel, input) {
    if (!logPath) return;
    const row = {
      channel,
      target: safeTarget(input),
      pid: process.pid
    };
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, { encoding: "utf8", flag: "a" });
    } catch {
      // The denial must remain fail-closed even when the diagnostic path is unavailable.
    }
  }

  function denied(channel, input) {
    record(channel, input);
    const error = new Error(`Stage 229 outbound ${channel} request denied`);
    error.code = "STAGE229_OUTBOUND_NETWORK_FORBIDDEN";
    return error;
  }

  function install(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: false,
        writable: false
      });
    } catch {
      target[key] = value;
    }
  }

  install(globalThis, "fetch", function stage229DeniedFetch(input) {
    return Promise.reject(denied("fetch", input));
  });

  for (const [module, protocol] of [[http, "http"], [https, "https"]]) {
    install(module, "request", function stage229DeniedRequest(input) {
      throw denied(`${protocol}.request`, input);
    });
    install(module, "get", function stage229DeniedGet(input) {
      throw denied(`${protocol}.get`, input);
    });
  }
}
