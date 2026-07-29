"use strict";

const { createAuthRepository } = require("../repositories/auth_store.cjs");
const { createAuthService } = require("../services/auth_service.cjs");
const { createAuthHttpHandler } = require("../http/auth_http.cjs");

function createIntegrationAuthRuntime(options = {}) {
  const env = options.env || process.env;
  const repository = createAuthRepository({
    filePath: env.V2_INTEGRATION_AUTH_STORE_PATH,
    clock: options.clock
  });
  const service = createAuthService({ repository, env, clock: options.clock });
  const http = createAuthHttpHandler({
    service,
    send: options.send,
    parseBody: options.parseBody,
    redirectPathForRole: options.redirectPathForRole,
    isProduction: options.isProduction,
    env
  });
  return Object.freeze({
    repository,
    service,
    http,
    initialize: () => service.initialize()
  });
}

module.exports = { createIntegrationAuthRuntime };
