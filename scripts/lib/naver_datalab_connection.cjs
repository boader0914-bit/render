"use strict";

// Connection selection only. This module never reads configuration or performs I/O.
const CONNECTIONS = Object.freeze({
  developers: Object.freeze({
    endpoint: "https://openapi.naver.com/v1/datalab/search",
    credentialFields: Object.freeze(["naverClientId", "naverClientSecret"]),
    headerFields: Object.freeze(["X-Naver-Client-Id", "X-Naver-Client-Secret"])
  }),
  ncp_apihub: Object.freeze({
    endpoint: "https://naverapihub.apigw.ntruss.com/search-trend/v1/search",
    credentialFields: Object.freeze(["ncpApihubClientId", "ncpApihubClientSecret"]),
    headerFields: Object.freeze(["X-NCP-APIGW-API-KEY-ID", "X-NCP-APIGW-API-KEY"])
  })
});

function resolveDatalabConnection(keys = {}) {
  const provider = keys?.datalabProvider === undefined ? "developers" : keys.datalabProvider;
  const connection = typeof provider === "string" && Object.hasOwn(CONNECTIONS, provider) ? CONNECTIONS[provider] : null;
  if (!connection) return { provider: "invalid", endpoint: "", configured: false, headers: {}, credentialFields: [] };
  const values = connection.credentialFields.map(field => typeof keys?.[field] === "string" ? keys[field].trim() : "");
  return {
    provider,
    endpoint: connection.endpoint,
    configured: values.every(Boolean),
    headers: { "Content-Type": "application/json", ...Object.fromEntries(connection.headerFields.map((field, index) => [field, values[index]])) },
    credentialFields: [...connection.credentialFields]
  };
}

module.exports = { resolveDatalabConnection };
