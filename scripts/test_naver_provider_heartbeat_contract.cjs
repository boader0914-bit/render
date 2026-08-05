"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "NAVER provider heartbeat fixtures" });
const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(server);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = server.indexOf("(", match.index);
  let parameterDepth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < server.length; index += 1) {
    if (server[index] === "(") parameterDepth += 1;
    if (server[index] === ")") parameterDepth -= 1;
    if (parameterDepth === 0) {
      parameterClose = index;
      break;
    }
  }
  const bodyOpen = server.indexOf("{", parameterClose);
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

async function flushHeartbeat(timer, job) {
  const tick = timer.callback();
  const renewal = job.providerHeartbeatPromise;
  await renewal;
  await tick;
}

async function main() {
  const timers = [];
  const sandbox = vm.createContext({
    PROVIDER_ATTEMPT_HEARTBEAT_SECONDS: 60,
    PROVIDER_ATTEMPT_LEASE_SECONDS: 1800,
    activeCrawlChild: null,
    activeCrawlJob: null,
    clearTimeout: (timer) => { timer.cleared = true; },
    console: { warn: () => {} },
    createCrawlFailure: (code, options) => Object.assign(new Error(code), { code, ...options }),
    naverProviderHealthStore: {
      refreshAttempt: async ({ expectedWorkflowRevision }) => ({ workflowRevision: expectedWorkflowRevision + 1 })
    },
    setTimeout: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }
  });
  vm.runInContext(
    `${functionSource("stopNaverProviderAttemptHeartbeat")}\n${functionSource("startNaverProviderAttemptHeartbeat")}\n`
      + "this.stopHeartbeat = stopNaverProviderAttemptHeartbeat; this.startHeartbeat = startNaverProviderAttemptHeartbeat;",
    sandbox
  );

  const job = {
    status: "active",
    providerAttemptRevision: 3,
    providerHeartbeatStopped: true,
    providerHeartbeatTimer: null,
    providerHeartbeatPromise: null,
    providerHeartbeatFailure: null
  };
  sandbox.activeCrawlJob = job;
  sandbox.startHeartbeat(job);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, 60_000);
  await flushHeartbeat(timers[0], job);
  assert.equal(job.providerAttemptRevision, 4, "a successful heartbeat carries the latest workflow revision forward");
  assert.equal(timers.length, 2, "heartbeat ticks are sequentially rescheduled after completion");
  await sandbox.stopHeartbeat(job);
  assert.equal(job.providerHeartbeatStopped, true);
  assert.equal(timers[1].cleared, true, "completion clears the pending heartbeat timer");

  let killed = 0;
  const failedJob = {
    status: "active",
    providerAttemptRevision: 9,
    providerHeartbeatStopped: true,
    providerHeartbeatTimer: null,
    providerHeartbeatPromise: null,
    providerHeartbeatFailure: null
  };
  sandbox.activeCrawlJob = failedJob;
  sandbox.activeCrawlChild = { killed: false, kill: () => { killed += 1; } };
  sandbox.naverProviderHealthStore.refreshAttempt = async () => {
    const conflict = new Error("fixture revision conflict");
    conflict.code = "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT";
    throw conflict;
  };
  sandbox.startHeartbeat(failedJob);
  await flushHeartbeat(timers.at(-1), failedJob);
  assert.equal(failedJob.providerHeartbeatStopped, true);
  assert.equal(failedJob.providerHeartbeatFailure.code, "NAVER_PROVIDER_COOLDOWN_ACTIVE");
  assert.equal(failedJob.providerHeartbeatFailure.providerDecisionReason, "attempt_lease_lost");
  assert.equal(killed, 1, "a process that loses the durable lease cannot continue unfenced provider transport");

  const startJobSource = functionSource("startCrawlJob");
  assert.match(startJobSource, /await stopNaverProviderAttemptHeartbeat\(job\)/, "the outcome waits for an in-flight heartbeat");
  assert.match(
    startJobSource,
    /providerDecisionReason === "attempt_lease_lost"[\s\S]*naverProviderHealthStore\.read\(\)[\s\S]*else if \(failure\?\.code === "NAVER_ACCESS_BLOCKED"\)/,
    "a lost lease is observed fail-closed instead of being released as an ordinary collector error"
  );
  assert.equal(networkGuard.blockedAttempts(), 0);
  console.log("NAVER provider active-attempt heartbeat lifecycle fixtures passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  networkGuard.restore();
});
