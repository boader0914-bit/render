"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { collectNaverPlaceSnapshot } = require("./naver_collector_strategy.cjs");
const {
  fixtureProviderReservation,
  staticFixtureTransport
} = require("./naver_collector_fixture_factory.cjs");

const ROOT = path.resolve(__dirname, "..");
const contract = Object.freeze({ keyword: "Boundary fixture", searchMode: "keyword", rankStart: 1, rankEnd: 20 });

async function capture(input) {
  try {
    await collectNaverPlaceSnapshot(input);
    assert.fail("expected fixture collection to fail");
  } catch (error) {
    return error;
  }
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "NAVER collector strategy boundary fixtures" });
  try {
    const serverSource = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
    const crawlerSource = fs.readFileSync(path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs"), "utf8");
    const webSource = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
    assert.doesNotMatch(serverSource, /require\(["']\.\/naver_collector_strategy\.cjs["']\)/);
    assert.match(crawlerSource, /NAVER_LEGACY_LIMITED_ACTIVATION/);
    assert.match(crawlerSource, /NAVER_COLLECTOR_STRATEGY/);
    assert.doesNotMatch(crawlerSource, /collectNaverPlaceSnapshot/, "the fixture-only adapter must not enter the live crawler");
    assert.match(crawlerSource, /createNaverLegacyCanaryLiveTransport/);
    assert.match(crawlerSource, /NAVER_PROVIDER_CALL_BUDGET === 1/);
    assert.doesNotMatch(webSource, /legacy_candidate|NAVER_COLLECTOR_STRATEGY/);
    assert.equal((serverSource.match(/runCrawlerLegacySingleFlight\s*\(/g) || []).length, 1, "legacy single-flight is defined but never called");

    for (const fixture of [
      {
        response: { status: 403, headers: { "content-type": "text/html" }, body: "<html>denied</html>" },
        subtype: "http_403"
      },
      {
        response: { status: 429, headers: { "retry-after": "120", "content-type": "text/html" }, body: "<html>retry</html>" },
        subtype: "http_429",
        retryAfterSeconds: 120
      },
      {
        response: { status: 200, headers: { "content-type": "text/html" }, body: "<!doctype html><html><body>CAPTCHA security check</body></html>" },
        subtype: "challenge_html"
      },
      {
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<!doctype html><html><body>CAPTCHA __APOLLO_STATE__ label without an assignment marker</body></html>"
        },
        subtype: "challenge_html"
      },
      {
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<!doctype html><html><body>CAPTCHA<script>window.__APOLLO_STATE__ = not-json;</script></body></html>"
        },
        subtype: "challenge_html"
      },
      {
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<!doctype html><html><body>CAPTCHA<script>window.__APOLLO_STATE__ = {\"ROOT_QUERY\":{}};</script></body></html>"
        },
        subtype: "challenge_html"
      }
    ]) {
      const transport = staticFixtureTransport(fixture.response);
      const error = await capture({
        contract,
        fixtureMode: true,
        providerReservation: fixtureProviderReservation(),
        transport
      });
      assert.equal(transport.fixtureCallCount(), 1);
      assert.equal(error.code, "NAVER_ACCESS_BLOCKED");
      assert.equal(error.providerFailureSubtype, fixture.subtype);
      if (fixture.retryAfterSeconds) assert.equal(error.retryAfterSeconds, fixture.retryAfterSeconds);
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      assert.doesNotMatch(serialized, /<html>|Boundary fixture|retry-after|content-type/i);
    }

    const jsonCaptcha = await capture({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "CAPTCHA is a normal fixture label" })
      })
    });
    assert.equal(jsonCaptcha.code, "NAVER_APOLLO_STATE_MISSING");

    const sensitiveTransportError = new Error("secret query=https://provider.invalid?q=Boundary fixture cookie=private");
    const sanitizedFailure = await capture({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport(sensitiveTransportError)
    });
    assert.equal(sanitizedFailure.code, "NAVER_COLLECTOR_FIXTURE_TRANSPORT_FAILED");
    assert.doesNotMatch(sanitizedFailure.message, /secret|Boundary|https?:|cookie|query=/i);

    let untrustedCalls = 0;
    const untrusted = await capture({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: async () => {
        untrustedCalls += 1;
        return { status: 200, body: "" };
      }
    });
    assert.equal(untrusted.code, "NAVER_FIXTURE_TRANSPORT_UNTRUSTED");
    assert.equal(untrustedCalls, 0, "an arbitrary injected function cannot execute as a fixture transport");

    let fixtureSideEffects = 0;
    const objectBody = {
      toString() {
        fixtureSideEffects += 1;
        return "unsafe";
      }
    };
    assert.throws(
      () => staticFixtureTransport({ status: 200, body: objectBody }),
      (error) => error.code === "NAVER_FIXTURE_RESPONSE_INVALID"
    );
    assert.throws(
      () => staticFixtureTransport({ status: objectBody, body: "" }),
      (error) => error.code === "NAVER_FIXTURE_RESPONSE_INVALID"
    );
    const accessorResponse = { status: 200 };
    Object.defineProperty(accessorResponse, "body", {
      enumerable: true,
      get() {
        fixtureSideEffects += 1;
        return "unsafe";
      }
    });
    assert.throws(
      () => staticFixtureTransport(accessorResponse),
      (error) => error.code === "NAVER_FIXTURE_RESPONSE_INVALID"
    );
    const accessorHeaders = {};
    Object.defineProperty(accessorHeaders, "content-type", {
      enumerable: true,
      get() {
        fixtureSideEffects += 1;
        return "text/html";
      }
    });
    assert.throws(
      () => staticFixtureTransport({ status: 200, headers: accessorHeaders, body: "" }),
      (error) => error.code === "NAVER_FIXTURE_RESPONSE_INVALID"
    );
    assert.equal(fixtureSideEffects, 0, "static fixture registration cannot execute body or header accessors");

    const missingReservationTransport = staticFixtureTransport({ status: 200, body: "" });
    const missingReservation = await capture({
      contract,
      fixtureMode: true,
      transport: missingReservationTransport
    });
    assert.equal(missingReservation.code, "NAVER_PROVIDER_RESERVATION_REQUIRED");
    assert.equal(missingReservationTransport.fixtureCallCount(), 0);

    const invalidSearchModeTransport = staticFixtureTransport({ status: 200, body: "" });
    const invalidSearchMode = await capture({
      contract: { ...contract, searchMode: "unexpected-mode" },
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: invalidSearchModeTransport
    });
    assert.equal(invalidSearchMode.code, "NAVER_COLLECTOR_CONTRACT_INVALID");
    assert.equal(invalidSearchModeTransport.fixtureCallCount(), 0);

    const controller = new AbortController();
    controller.abort();
    const abortedTransport = staticFixtureTransport({ status: 200, body: "" });
    const aborted = await capture({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      signal: controller.signal,
      transport: abortedTransport
    });
    assert.equal(aborted.code, "NAVER_COLLECTOR_FIXTURE_ABORTED");
    assert.equal(abortedTransport.fixtureCallCount(), 0, "an aborted fixture must not invoke its transport");

    const transportAbort = new Error("private parser timeout detail");
    transportAbort.name = "AbortError";
    const transportAborted = await capture({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport(transportAbort)
    });
    assert.equal(transportAborted.code, "NAVER_COLLECTOR_FIXTURE_ABORTED");
    assert.doesNotMatch(transportAborted.message, /private|timeout/i);
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("NAVER collector strategy boundary fixture tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
