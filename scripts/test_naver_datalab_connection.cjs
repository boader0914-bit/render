"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDatalabConnection } = require("./lib/naver_datalab_connection.cjs");

const both = { naverClientId: " legacy-id ", naverClientSecret: " legacy-secret ", ncpApihubClientId: " ncp-id ", ncpApihubClientSecret: " ncp-secret " };

test("omitted provider retains Developers compatibility and only its credential pair", () => {
  const connection = resolveDatalabConnection(both);
  assert.equal(connection.provider, "developers");
  assert.equal(connection.endpoint, "https://openapi.naver.com/v1/datalab/search");
  assert.equal(connection.configured, true);
  assert.deepEqual(connection.headers, { "Content-Type": "application/json", "X-Naver-Client-Id": "legacy-id", "X-Naver-Client-Secret": "legacy-secret" });
  assert.deepEqual(connection.credentialFields, ["naverClientId", "naverClientSecret"]);
  assert.deepEqual(connection, resolveDatalabConnection({ ...both, datalabProvider: "developers" }));
});

test("API HUB explicitly chooses its endpoint and separate credentials without legacy headers", () => {
  const connection = resolveDatalabConnection({ ...both, datalabProvider: "ncp_apihub" });
  assert.equal(connection.configured, true);
  assert.equal(connection.provider, "ncp_apihub");
  assert.equal(connection.endpoint, "https://naverapihub.apigw.ntruss.com/search-trend/v1/search");
  assert.deepEqual(connection.headers, { "Content-Type": "application/json", "X-NCP-APIGW-API-KEY-ID": "ncp-id", "X-NCP-APIGW-API-KEY": "ncp-secret" });
  assert.deepEqual(connection.credentialFields, ["ncpApihubClientId", "ncpApihubClientSecret"]);
});

test("unselected credentials never fill a missing selected pair", () => {
  const ncp = resolveDatalabConnection({ ...both, datalabProvider: "ncp_apihub", ncpApihubClientSecret: "" });
  assert.equal(ncp.configured, false); assert.equal(ncp.headers["X-NCP-APIGW-API-KEY"], "");
  const legacy = resolveDatalabConnection({ ...both, naverClientId: "" });
  assert.equal(legacy.configured, false); assert.equal(legacy.headers["X-Naver-Client-Id"], "");
});

test("unknown, blank and non-string explicit providers fail closed", () => {
  for (const datalabProvider of ["", "invalid", null, false, [], ["developers"], {}, "constructor", "__proto__"]) {
    assert.deepEqual(resolveDatalabConnection({ ...both, datalabProvider }), { provider: "invalid", endpoint: "", configured: false, headers: {}, credentialFields: [] });
  }
  assert.equal(resolveDatalabConnection(null).configured, false);
});

test("returned metadata cannot mutate subsequent resolution", () => {
  const first = resolveDatalabConnection(both);
  first.credentialFields[0] = "ncpApihubClientId"; first.headers["X-Naver-Client-Id"] = "changed";
  assert.equal(resolveDatalabConnection(both).headers["X-Naver-Client-Id"], "legacy-id");
  assert.equal(resolveDatalabConnection(both).credentialFields[0], "naverClientId");
});
