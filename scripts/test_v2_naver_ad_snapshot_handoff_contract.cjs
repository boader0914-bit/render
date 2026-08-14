"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  HASH_NONCE_NAME,
  HASH_ORIGIN_NAME,
  MESSAGE_TYPE,
  SEARCH_ORIGIN,
  SEARCH_PATH,
  createCaptureNonce,
  createCaptureSearchUrl,
  createHandoffMessage,
  normalizeReturnOrigin,
  validateHandoffMessage
} = require("./v2_naver_ad_snapshot_handoff_contract.cjs");

let assertions = 0;
function equal(actual, expected) {
  assert.equal(actual, expected);
  assertions += 1;
}
function match(actual, expected) {
  assert.match(actual, expected);
  assertions += 1;
}
function throws(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
  assertions += 1;
}

function main() {
  const nonce = "0123456789abcdef0123456789abcdef";
  const randomNonce = createCaptureNonce({
    getRandomValues(bytes) {
      bytes.set([...Array(16).keys()]);
      return bytes;
    }
  });
  equal(randomNonce, "000102030405060708090a0b0c0d0e0f");
  match(randomNonce, /^[a-f0-9]{32}$/u);

  const captureUrl = new URL(createCaptureSearchUrl({
    keyword: " 경남   글램핑 ",
    nonce,
    returnOrigin: "https://datalab.example"
  }));
  equal(captureUrl.origin, SEARCH_ORIGIN);
  equal(captureUrl.pathname, SEARCH_PATH);
  equal(captureUrl.searchParams.get("where"), "nexearch");
  equal(captureUrl.searchParams.get("query"), "경남 글램핑");
  const fragment = new URLSearchParams(captureUrl.hash.slice(1));
  equal(fragment.get(HASH_NONCE_NAME), nonce);
  equal(fragment.get(HASH_ORIGIN_NAME), "https://datalab.example");
  equal(normalizeReturnOrigin("http://127.0.0.1:4178"), "http://127.0.0.1:4178");
  equal(normalizeReturnOrigin("http://localhost:4178"), "http://localhost:4178");

  const capture = Object.freeze({ schemaVersion: "fixture", advertisements: [] });
  const message = createHandoffMessage(capture, nonce);
  equal(message.type, MESSAGE_TYPE);
  equal(message.nonce, nonce);
  equal(message.capture, capture);
  equal(validateHandoffMessage(message, { expectedNonce: nonce }), capture);

  throws(() => createCaptureNonce({}), "capture-handoff-crypto-unavailable");
  throws(() => createCaptureSearchUrl({ keyword: "<script>", nonce, returnOrigin: "https://datalab.example" }), "capture-handoff-query-invalid");
  throws(() => createCaptureSearchUrl({ keyword: "경남 글램핑", nonce: "short", returnOrigin: "https://datalab.example" }), "capture-handoff-nonce-invalid");
  throws(() => normalizeReturnOrigin("http://datalab.example"), "capture-handoff-origin-invalid");
  throws(() => normalizeReturnOrigin("https://datalab.example/path"), "capture-handoff-origin-invalid");
  throws(() => normalizeReturnOrigin("javascript:alert(1)"), "capture-handoff-origin-invalid");
  throws(() => validateHandoffMessage({ ...message, nonce: "f".repeat(32) }, { expectedNonce: nonce }), "capture-handoff-message-invalid");
  throws(() => validateHandoffMessage({ ...message, extra: true }, { expectedNonce: nonce }), "capture-handoff-message-invalid");
  throws(() => validateHandoffMessage({ ...message, capture: null }, { expectedNonce: nonce }), "capture-handoff-message-invalid");

  const browserSandbox = { URL, Uint8Array, document: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "v2_naver_visible_place_ad_contract.cjs"), "utf8"), browserSandbox);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "v2_naver_ad_snapshot_handoff_contract.cjs"), "utf8"), browserSandbox);
  equal(typeof browserSandbox.V2NaverVisiblePlaceAdContract?.validateVisibleAdCaptureEnvelope, "function");
  equal(typeof browserSandbox.V2NaverAdSnapshotHandoffContract?.createCaptureSearchUrl, "function");

  process.stdout.write(`${JSON.stringify({
    event: "v2_naver_ad_snapshot_handoff_contract_tests_complete",
    assertions,
    externalRequests: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: 0
  })}\n`);
}

main();
