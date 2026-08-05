"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  classifyNaverAccessResponse,
  parseSafeRetryAfter,
  sanitizeProviderFailureMeta
} = require("./naver_provider_resilience.cjs");
const {
  createCrawlFailure,
  serializeCollectorFailure
} = require("./crawl_failure_contract.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "NAVER access classifier fixtures" });

function main() {
  const now = "2026-08-05T09:00:00.000Z";
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");

  assert.deepEqual(classifyNaverAccessResponse({ status: 403, body: "" }, { now }), {
    blocked: true,
    code: "NAVER_ACCESS_BLOCKED",
    subtype: "http_403",
    httpStatus: 403,
    retryAfterSeconds: null
  });
  assert.deepEqual(classifyNaverAccessResponse({
    status: 429,
    headers: { "Retry-After": "900" },
    body: "rate limited"
  }, { now }), {
    blocked: true,
    code: "NAVER_ACCESS_BLOCKED",
    subtype: "http_429",
    httpStatus: 429,
    retryAfterSeconds: 900
  });

  const httpDate = new Date(Date.parse(now) + 90_000).toUTCString();
  assert.equal(parseSafeRetryAfter(httpDate, { now }), 90);
  assert.equal(parseSafeRetryAfter("999999999", { now }), 7200, "provider delays are capped at two hours");
  assert.equal(parseSafeRetryAfter("-1", { now }), null);
  assert.equal(parseSafeRetryAfter("tomorrow", { now }), null);
  assert.equal(parseSafeRetryAfter("Mon, 31 Feb 2026 09:00:00 GMT", { now }), null);
  assert.equal(parseSafeRetryAfter(new Date(Date.parse(now) - 1000).toUTCString(), { now }), 0);

  const challenge = classifyNaverAccessResponse({
    status: 200,
    body: "<html><title>보안 확인</title><div>자동입력 방지 CAPTCHA</div></html>"
  }, { now });
  assert.equal(challenge.blocked, true);
  assert.equal(challenge.subtype, "challenge_html");

  const normalJsonWithChallengeWords = classifyNaverAccessResponse({
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ productName: "CAPTCHA · 보안 확인 안내 체험" })
  }, { now });
  assert.equal(
    normalJsonWithChallengeWords.blocked,
    false,
    "normal GraphQL JSON text cannot be mistaken for a provider challenge page"
  );

  const healthyApollo = classifyNaverAccessResponse({
    status: 200,
    body: "<script>window.__APOLLO_STATE__ = {\"ROOT_QUERY\":{}}</script><div>보안 확인 안내</div>"
  }, { now });
  assert.equal(healthyApollo.blocked, false, "a normal Apollo marker prevents a challenge false positive");
  assert.equal(healthyApollo.subtype, null);

  const invalidApolloChallenge = classifyNaverAccessResponse({
    status: 200,
    body: "<html><body>CAPTCHA<script>window.__APOLLO_STATE__ = not-json;</script></body></html>",
    apolloStateValidated: false
  }, { now });
  assert.equal(invalidApolloChallenge.blocked, true, "an invalid Apollo assignment cannot suppress challenge classification");
  assert.equal(invalidApolloChallenge.subtype, "challenge_html");

  const longHealthyApollo = classifyNaverAccessResponse({
    status: 200,
    body: `<div>보안 확인 안내</div>${"x".repeat(25_000)}<script>window.__APOLLO_STATE__ = {"ROOT_QUERY":{}}</script>`
  }, { now });
  assert.equal(longHealthyApollo.blocked, false, "an Apollo marker beyond the initial HTML window still prevents a false positive");

  const explicitlyBlocked = classifyNaverAccessResponse({ status: 200, accessBlocked: true }, { now });
  assert.equal(explicitlyBlocked.subtype, "unknown_access_block");

  const safe = sanitizeProviderFailureMeta({
    subtype: "http_429",
    httpStatus: 429,
    retryAfterSeconds: 120,
    occurredAt: now,
    diagnosticId: "crawl-c6ddda12830f",
    rawBody: "secret response body",
    query: "private search term",
    url: "https://example.test/?key=secret",
    headers: { authorization: "secret" },
    userId: "private-user"
  });
  assert.deepEqual(Object.keys(safe).sort(), [
    "code",
    "diagnosticId",
    "httpStatus",
    "occurredAt",
    "providerId",
    "retryAfterSeconds",
    "subtype"
  ].sort());
  assert.equal(safe.providerId, "naver_place_search");
  assert.equal(safe.code, "NAVER_ACCESS_BLOCKED");
  assert.equal(safe.diagnosticId, "crawl-c6ddda12830f");
  assert.doesNotMatch(JSON.stringify(safe), /secret|private search|example\.test|authorization|userId/i);

  const unknown = sanitizeProviderFailureMeta({
    subtype: "invented",
    httpStatus: 500,
    diagnosticId: "unsafe-diagnostic-id",
    occurredAt: now
  });
  assert.equal(unknown.subtype, "unknown_access_block");
  assert.equal(unknown.httpStatus, 500, "safe internal metadata preserves the observed HTTP status");
  assert.equal(unknown.diagnosticId, null);

  const challengeMeta = sanitizeProviderFailureMeta({
    subtype: "challenge_html",
    httpStatus: 200,
    occurredAt: now
  });
  assert.equal(challengeMeta.httpStatus, 200, "challenge HTML preserves its safe internal HTTP 200 context");

  const legacyMarker = serializeCollectorFailure(createCrawlFailure(safe.code, {
    diagnosticId: safe.diagnosticId
  }));
  assert.match(legacyMarker, /^CRAWL_ERROR_V1:/, "the public code remains compatible with CRAWL_ERROR_V1");
  assert.match(
    server,
    /keyword: providerAccessFailure \? "" : \(plan\?\.keyword \|\| ""\)/,
    "blocked provider timing records must omit the search term"
  );
  assert.equal(networkGuard.blockedAttempts(), 0);

  console.log("NAVER access response classifier and safe failure metadata tests passed.");
}

try {
  main();
} finally {
  networkGuard.restore();
}
