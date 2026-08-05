"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  REDACTED,
  LocationApiTransportError,
  createRequestDescriptor,
  redactBody,
  redactForLog,
  redactHeaders,
  redactUrl
} = require("./location_api_transport.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location API redaction fixtures" });

function assertNoSecrets(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `redacted output leaked ${secret}`);
}

const secrets = ["fixture-service-key", "fixture-client-secret", "fixture-signature", "fixture-customer"];
const url = redactUrl(
  `https://user:fixture-client-secret@apis.data.go.kr/path?serviceKey=${secrets[0]}&areaCode=31&signature=${secrets[2]}`
);
assertNoSecrets(url, secrets);
assert.equal(url.includes("areaCode=31"), true);
assert.equal(decodeURIComponent(url).includes(REDACTED), true);

const headers = redactHeaders({
  "content-type": "application/json",
  "x-naver-client-secret": secrets[1],
  "x-api-key": secrets[0],
  "x-customer": secrets[3],
  "x-signature": secrets[2]
});
assert.equal(headers["content-type"], "application/json");
assert.equal(headers["x-naver-client-secret"], REDACTED);
assert.equal(headers["x-api-key"], REDACTED);
assert.equal(headers["x-customer"], REDACTED);
assert.equal(headers["x-signature"], REDACTED);
assertNoSecrets(headers, secrets);

const body = redactBody({
  regionKey: "kr_gyeonggi_pocheon",
  nested: {
    apiKey: secrets[0],
    clientSecret: secrets[1],
    ordinaryValue: 7
  },
  credentialEnvNames: ["NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"]
});
assert.equal(body.nested.apiKey, REDACTED);
assert.equal(body.nested.clientSecret, REDACTED);
assert.equal(body.nested.ordinaryValue, 7);
assert.deepEqual(body.credentialEnvNames, ["NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"]);
assertNoSecrets(body, secrets);

const text = redactForLog({
  message: `Authorization: Bearer ${secrets[0]} request=https://example.test/?api_key=${secrets[1]}`,
  opaque: `prefix-${secrets[2]}-suffix`
}, { secretValues: [secrets[2]] });
assertNoSecrets(text, secrets);
assert.equal(text.message.includes(REDACTED), true);
assert.equal(text.opaque.includes(REDACTED), true);

const circular = { password: secrets[0] };
circular.self = circular;
const circularRedacted = redactForLog(circular);
assert.equal(circularRedacted.password, REDACTED);
assert.equal(circularRedacted.self, "[CIRCULAR]");

assert.throws(
  () => createRequestDescriptor({
    sourceId: "unsafe",
    operation: "unsafe",
    url: `https://apis.data.go.kr/path?serviceKey=${secrets[0]}`
  }),
  (error) => {
    assert.ok(error instanceof LocationApiTransportError);
    assert.equal(error.code, "CREDENTIAL_MATERIAL_FORBIDDEN");
    assertNoSecrets(error.details, secrets);
    return true;
  }
);

assert.equal(networkGuard.blockedAttempts(), 0);
networkGuard.restore();
console.log("Location API redaction tests passed.");
