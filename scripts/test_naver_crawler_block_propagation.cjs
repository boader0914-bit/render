"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createCrawlFailure } = require("./crawl_failure_contract.cjs");
const { classifyNaverAccessResponse } = require("./naver_provider_resilience.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "NAVER crawler block propagation fixtures" });
const crawler = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(crawler);
  assert.ok(match, `missing function ${name}`);
  const bodyOpen = crawler.indexOf("{", crawler.indexOf(")", match.index));
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyOpen; index < crawler.length; index += 1) {
    const character = crawler[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return crawler.slice(match.index, index + 1);
  }
  assert.fail(`unbalanced function ${name}`);
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
        return key ? headers[key] : null;
      }
    },
    text: async () => body
  };
}

function fixture(functionNames, context = {}) {
  const sandbox = vm.createContext({
    classifyNaverAccessResponse,
    createCrawlFailure,
    headers: {},
    naverBookingBusinessQuery: "query fixture",
    delay: async () => {},
    ...context
  });
  vm.runInContext(
    `let naverAccessFailure = null;\n${functionNames.map(functionSource).join("\n")}\n${functionNames.map((name) => `this.${name} = ${name};`).join("\n")}`,
    sandbox
  );
  return sandbox;
}

async function assertBusinessBlock({ status, body, headers, subtype }) {
  let calls = 0;
  const api = fixture([
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked",
    "getNaverBookingBusiness"
  ], {
    fetch: async () => {
      calls += 1;
      return response(status, body, headers);
    }
  });
  await assert.rejects(
    () => api.getNaverBookingBusiness("fixture-place"),
    (error) => error.code === "NAVER_ACCESS_BLOCKED" && error.providerFailureSubtype === subtype
  );
  assert.equal(calls, 1, `${subtype} must stop the retry loop after its first blocked response`);
  await assert.rejects(() => api.getNaverBookingBusiness("fixture-place-2"), { code: "NAVER_ACCESS_BLOCKED" });
  assert.equal(calls, 1, `${subtype} must prevent later NAVER transport calls in the child process`);
}

async function main() {
  await assertBusinessBlock({ status: 403, body: "forbidden", subtype: "http_403" });
  await assertBusinessBlock({ status: 429, body: "limited", headers: { "Retry-After": "900" }, subtype: "http_429" });
  await assertBusinessBlock({ status: 200, body: "<html><h1>보안 확인</h1><p>자동입력 방지</p></html>", subtype: "challenge_html" });

  const invalidContractGuard = fixture([
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked"
  ]);
  assert.throws(
    () => invalidContractGuard.throwIfNaverAccessBlocked({
      status: 200,
      body: '<html>CAPTCHA<script>window.__APOLLO_STATE__ = {"ROOT_QUERY":{}};</script></html>',
      apolloStateValidated: false
    }),
    (error) => error.code === "NAVER_ACCESS_BLOCKED" && error.providerFailureSubtype === "challenge_html"
  );

  let placeCalls = 0;
  const placePage = fixture([
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked",
    "getNaverBookingBusinessFromPlacePage"
  ], {
    NAVER_BOOKING_ID_FALLBACK: true,
    fetchText: async () => {
      placeCalls += 1;
      return { res: response(403, ""), text: "forbidden" };
    }
  });
  await assert.rejects(() => placePage.getNaverBookingBusinessFromPlacePage("fixture-place"), { code: "NAVER_ACCESS_BLOCKED" });
  assert.equal(placeCalls, 1, "Place HTML fallback must not advance to its remaining routes after a block");

  let graphqlCalls = 0;
  const bookingGraphql = fixture([
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked",
    "postNaverBookingGraphql"
  ], {
    ADULTS: 2,
    CHECK_IN: "2026-08-05",
    NAVER_BOOKING_GRAPHQL_URL: "https://fixture.invalid/graphql",
    addDays: () => "2026-08-06",
    fetch: async () => {
      graphqlCalls += 1;
      return response(429, "rate limited", { "Retry-After": "60" });
    }
  });
  await assert.rejects(
    () => bookingGraphql.postNaverBookingGraphql("fixture", "query fixture", {}, "business-1"),
    { code: "NAVER_ACCESS_BLOCKED" }
  );
  assert.equal(graphqlCalls, 1);

  let couponCalls = 0;
  const coupon = fixture([
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked",
    "getNaverBookingPageCouponSignal"
  ], {
    CHECK_IN: "2026-08-05",
    NAVER_COUPON_PAGE_FALLBACK: true,
    naverBookingSearchUrl: () => "https://fixture.invalid/booking",
    fetchText: async () => {
      couponCalls += 1;
      return { res: response(200, ""), text: "<html>CAPTCHA 보안 확인</html>" };
    }
  });
  await assert.rejects(() => coupon.getNaverBookingPageCouponSignal("business-1"), { code: "NAVER_ACCESS_BLOCKED" });
  assert.equal(couponCalls, 1, "coupon best-effort handling must not swallow a provider block");

  assert.match(functionSource("getNaverState"), /throwIfNaverAccessBlocked/);
  assert.match(functionSource("getNaverState"), /apolloStateValidated:\s*false/);
  assert.match(functionSource("collectNaverMain"), /apolloStateValidated:\s*false/);
  assert.match(functionSource("collectNaverRegional"), /apolloStateValidated:\s*false/);
  assert.match(functionSource("postNaverBookingGraphql"), /throwIfNaverAccessBlocked/);
  assert.match(functionSource("getNaverBookingBusinessFromPlacePage"), /assertNaverTransportAvailable\(\);[\s\S]*fetchText/);
  assert.match(functionSource("getNaverBookingPageCouponSignal"), /assertNaverTransportAvailable\(\);[\s\S]*fetchText/);
  assert.match(functionSource("enrichNaverRowsWithBookingAvailability"), /catch \(error\) \{\s*if \(error\?\.code === "NAVER_ACCESS_BLOCKED"\) throw error;/);
  assert.equal(guard.blockedAttempts(), 0, "fixtures must not perform any network request");
  console.log("NAVER secondary transport block propagation fixtures passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => guard.restore());
