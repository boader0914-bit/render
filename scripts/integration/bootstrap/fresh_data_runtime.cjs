"use strict";

const path = require("node:path");
const {
  createFreshIntegrationRepository,
  resolveFreshIntegrationDataDir
} = require("../repositories/fresh_store.cjs");

function assertFreshDataConfiguration(options = {}) {
  const env = options.env || process.env;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  return resolveFreshIntegrationDataDir({
    env,
    projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths
  });
}

function createFreshDataRuntime(options = {}) {
  const env = options.env || process.env;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  assertFreshDataConfiguration({
    env,
    projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths
  });
  const repository = createFreshIntegrationRepository({
    env,
    projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths,
    clock: options.clock,
    idFactory: options.idFactory
  });
  return Object.freeze({
    repository,
    initialize: () => repository.initialize(),
    diagnostics: () => repository.diagnostics(),
    contract: Object.freeze({
      stage: 228,
      provisional: false,
      source: "synthetic-fresh-integration",
      dataBoundary: "fresh-integration-only",
      providerCalls: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      processRestartRecovery: true
    })
  });
}

module.exports = {
  assertFreshDataConfiguration,
  createFreshDataRuntime
};
