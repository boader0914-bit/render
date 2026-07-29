"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createCoreRepository } = require("../repositories/core_store.cjs");
const { createCoreService } = require("../services/core_service.cjs");
const { createCoreHttpHandler } = require("../http/core_http.cjs");

function enabled(value) {
  return /^(1|true|on|yes)$/i.test(String(value || "").trim());
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Stage 227 fixture path must stay inside test/fixtures/stage227");
  }
}

function assertSyntheticFixtureStrings(value, keyPath = "fixture") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSyntheticFixtureStrings(item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertSyntheticFixtureStrings(item, `${keyPath}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  const text = value.trim();
  if (/^(?:[A-Za-z]:[\\/]|\/var\/|\/tmp\/|\/home\/|\\\\)/.test(text)) {
    throw new Error(`Stage 227 fixture contains a filesystem path at ${keyPath}`);
  }
  for (const match of text.matchAll(/https?:\/\/([^/\s]+)/gi)) {
    if (!String(match[1] || "").toLowerCase().endsWith(".invalid")) {
      throw new Error(`Stage 227 fixture URL must use example.invalid at ${keyPath}`);
    }
  }
}

function loadFixture(options = {}) {
  const env = options.env || process.env;
  if (String(env.NODE_ENV || "").trim().toLowerCase() !== "test" || !enabled(env.V2_STAGE227_FIXTURE_MODE)) {
    return null;
  }
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  const fixtureRoot = path.join(projectRoot, "test", "fixtures", "stage227");
  const fixturePath = path.resolve(env.V2_STAGE227_FIXTURE_PATH || path.join(fixtureRoot, "fresh_collection.json"));
  assertInside(fixtureRoot, fixturePath);
  if (path.extname(fixturePath).toLowerCase() !== ".json") throw new Error("Stage 227 fixture must be JSON");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8").replace(/^\uFEFF/, ""));
  if (fixture.synthetic !== true || fixture.source !== "synthetic-fresh-collection") {
    throw new Error("Stage 227 fixture must declare synthetic fresh-collection provenance");
  }
  if (!Array.isArray(fixture.companies) || fixture.companies.some((company) => !/^syn_[a-z0-9_-]+$/i.test(company.companyId || ""))) {
    throw new Error("Stage 227 fixture company IDs must use the syn_ namespace");
  }
  assertSyntheticFixtureStrings(fixture);
  return fixture;
}

function createIntegrationCoreRuntime(options = {}) {
  const env = options.env || process.env;
  if (!options.authRuntime?.service || !options.authRuntime?.http) {
    throw new Error("Stage 227 platform core requires the Stage 226 auth runtime");
  }
  const fixture = loadFixture({ env, projectRoot: options.projectRoot });
  const repository = createCoreRepository({ fixture });
  const service = createCoreService({
    repository,
    authService: options.authRuntime.service,
    freshDataService: options.freshRuntime?.service || null,
    insightsService: options.insightsRuntime?.service || null,
    clock: options.clock,
    idFactory: options.idFactory
  });
  const http = createCoreHttpHandler({
    service,
    authService: options.authRuntime.service,
    authHttp: options.authRuntime.http,
    send: options.send,
    parseBody: options.parseBody
  });
  return Object.freeze({
    repository,
    service,
    http,
    fixtureMode: Boolean(fixture),
    initialize() {
      return { ok: true, metadata: service.metadata() };
    }
  });
}

module.exports = {
  assertSyntheticFixtureStrings,
  createIntegrationCoreRuntime,
  loadFixture
};
