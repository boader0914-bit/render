"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "NAVER shared job quota fixtures" });
const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(server);
  assert.ok(match, `missing function ${name}`);
  const bodyOpen = server.indexOf("{", server.indexOf(")", match.index));
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyOpen; index < server.length; index += 1) {
    const character = server[index];
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
    if (depth === 0) return server.slice(match.index, index + 1);
  }
  assert.fail(`unbalanced function ${name}`);
}

try {
  const sandbox = vm.createContext({
    USER_ROLES: { b2b: "b2b" },
    crawlQueueClientRequestId: (value) => String(value || "").trim(),
    createCrawlFailure: (code, options) => Object.assign(new Error(code), { code, ...options }),
    normalizeLoginId: (value) => String(value || "").trim().toLowerCase()
  });
  const names = [
    "resolveCrawlJob",
    "b2bSearchResultReusedCollection",
    "mergeB2BSearchHistoryQuota",
    "b2bHistoryPayloadForSubscriber",
    "requestScopedNaverFailure",
    "b2bSubscriberFromPayload",
    "b2bSubscriberKey",
    "addB2BSubscriberToJob"
  ];
  vm.runInContext(
    `${names.map(functionSource).join("\n")}\n${names.map((name) => `this.${name} = ${name};`).join("\n")}`,
    sandbox
  );

  const job = { id: "job-1", signature: "sig-1", waiterCount: 2, b2bSubscribers: new Map() };
  const promiseResult = sandbox.resolveCrawlJob({ runId: "run-1" }, job, "shared");
  const leaderResult = sandbox.resolveCrawlJob(promiseResult, job, "completed");
  const followerResult = sandbox.resolveCrawlJob(promiseResult, job, "shared");
  assert.equal(sandbox.b2bSearchResultReusedCollection(leaderResult), false, "the leader represents the real provider attempt");
  assert.equal(sandbox.b2bSearchResultReusedCollection(followerResult), true, "a follower reuses the shared provider result");

  const leaderPayload = {
    clientRequestId: "request-1",
    b2bSubscriber: { clientRequestId: "request-1", memberId: "member-1", sessionHash: "session-1", quotaCounted: true }
  };
  const followerPayload = {
    clientRequestId: "request-1",
    b2bSubscriber: { clientRequestId: "request-1", memberId: "member-1", sessionHash: "session-1", quotaCounted: false }
  };
  sandbox.addB2BSubscriberToJob(job, leaderPayload);
  sandbox.addB2BSubscriberToJob(job, followerPayload);
  assert.equal(job.b2bSubscribers.size, 1);
  assert.equal(job.b2bSubscribers.values().next().value.quotaCounted, true, "a reused subscriber cannot erase the leader's quota decision");

  const reverseJob = { b2bSubscribers: new Map() };
  sandbox.addB2BSubscriberToJob(reverseJob, followerPayload);
  sandbox.addB2BSubscriberToJob(reverseJob, leaderPayload);
  assert.equal(reverseJob.b2bSubscribers.values().next().value.quotaCounted, true, "subscriber merge is order independent");

  const followerFirstQuota = sandbox.mergeB2BSearchHistoryQuota(false, true);
  assert.equal(followerFirstQuota.quotaCounted, true);
  assert.equal(followerFirstQuota.incrementNeeded, true, "a later real provider caller upgrades a reused history row exactly once");
  const alreadyCountedQuota = sandbox.mergeB2BSearchHistoryQuota(true, false);
  assert.equal(alreadyCountedQuota.quotaCounted, true, "a reused follower cannot downgrade a counted history row");
  assert.equal(alreadyCountedQuota.incrementNeeded, false);
  assert.equal(sandbox.mergeB2BSearchHistoryQuota(true, true).incrementNeeded, false, "an already counted row cannot increment twice");

  const memberAHistoryPayload = sandbox.b2bHistoryPayloadForSubscriber({ clientRequestId: "leader" }, { clientRequestId: "member-a" });
  const memberBHistoryPayload = sandbox.b2bHistoryPayloadForSubscriber({ clientRequestId: "leader" }, { clientRequestId: "member-b" });
  assert.equal(memberAHistoryPayload.clientRequestId, "member-a");
  assert.equal(memberBHistoryPayload.clientRequestId, "member-b", "shared-job history preserves each subscriber request identity");

  const sharedFailure = Object.assign(new Error("shared"), {
    code: "NAVER_PROVIDER_COOLDOWN_ACTIVE",
    diagnosticId: "crawl-c6ddda12830f",
    retryAfterSeconds: 900,
    retryAt: "2026-08-05T10:00:00.000Z",
    retryable: true,
    statusCode: 503
  });
  const memberAFailure = sandbox.requestScopedNaverFailure(sharedFailure);
  const memberBFailure = sandbox.requestScopedNaverFailure(sharedFailure);
  assert.notEqual(memberAFailure, sharedFailure);
  assert.notEqual(memberAFailure, memberBFailure, "each shared-job caller receives an independent failure envelope");
  memberBFailure.naverFallbackState = { fallbackRunId: "member-b-run" };
  memberAFailure.naverFallbackState = { fallbackRunId: "member-a-run" };
  assert.equal(memberAFailure.naverFallbackState.fallbackRunId, "member-a-run");
  assert.equal(memberBFailure.naverFallbackState.fallbackRunId, "member-b-run");
  assert.equal(Object.hasOwn(sharedFailure, "naverFallbackState"), false, "per-member fallback data cannot mutate the shared job error");

  assert.match(
    functionSource("runCrawler"),
    /resolveCrawlJob\(result, job, reservedJob\.shared \? "shared" : "completed"\)/,
    "runCrawler must return caller-specific leader/follower reuse metadata"
  );
  assert.match(
    functionSource("ensureB2BSearchHistory"),
    /clientRequestId[\s\S]*item\.searchSignature === entry\.searchSignature/,
    "missing client request IDs still deduplicate the same owner/run/search contract"
  );
  assert.match(
    functionSource("runB2BSearch"),
    /crawlReservationPromises\.has\(signature\)/,
    "a caller may join a pending identical reservation without being rejected by quota policy"
  );
  assert.match(
    functionSource("runB2BSearch"),
    /const requestError = requestScopedNaverFailure\(error\)[\s\S]*attachNaverFallbackToError\(requestError[\s\S]*throw requestError/,
    "B2B fallback attachment must use a request-scoped error"
  );
  assert.equal(guard.blockedAttempts(), 0);
  console.log("NAVER shared job leader/follower quota contract fixtures passed");
} finally {
  guard.restore();
}
