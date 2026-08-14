"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  JOB_RUN_ID,
  LIVE_APPROVAL_TOKEN,
  LOCAL_STATE_ROOT,
  OUTER_ENV_NAMES,
  V2BasicRenderError,
  executeLive,
  readJobIdentity,
  readiness,
  verifyFileIdentities
} = require("./v2_live_basic_place_render_worker.cjs");

function baseEnv(stateDir) {
  return {
    [OUTER_ENV_NAMES.stateDir]: stateDir,
    [OUTER_ENV_NAMES.runEnabled]: "0",
    [OUTER_ENV_NAMES.requestBudget]: "0",
    [OUTER_ENV_NAMES.automaticRetry]: "0",
    [OUTER_ENV_NAMES.fallback]: "0",
    [OUTER_ENV_NAMES.operationalWrites]: "0"
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof V2BasicRenderError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    return true;
  });
}

async function main() {
  const stateDir = path.join(LOCAL_STATE_ROOT, `test-${process.pid}`);
  await fs.rm(stateDir, { recursive: true, force: true });
  try {
    const job = await readJobIdentity();
    assert.equal(job.job.runId, JOB_RUN_ID);
    assert.match(job.digest, /^[a-f0-9]{64}$/u);
    const identities = await verifyFileIdentities();
    assert.equal(Object.keys(identities).length, 6);

    const ready = await readiness(baseEnv(stateDir));
    assert.equal(ready.event, "v2_live_basic_place_render_ready");
    assert.equal(ready.status, "ready");
    assert.equal(ready.mode, "readiness-only");
    assert.equal(ready.runEnabled, false);
    assert.equal(ready.requestBudget, 0);
    assert.equal(ready.externalRequests, 0);
    assert.equal(ready.collectorInvocations, 0);
    assert.equal(ready.operationalWrites, 0);

    await expectCode(() => readiness({
      ...baseEnv(stateDir),
      [OUTER_ENV_NAMES.liveApproved]: LIVE_APPROVAL_TOKEN
    }), "V2_BASIC_RENDER_READINESS_GATE_INVALID");

    const liveEnv = {
      ...baseEnv(stateDir),
      [OUTER_ENV_NAMES.runEnabled]: "1",
      [OUTER_ENV_NAMES.requestBudget]: "1",
      [OUTER_ENV_NAMES.liveApproved]: LIVE_APPROVAL_TOKEN,
      [OUTER_ENV_NAMES.approvedJobDigest]: job.digest,
      SECRET_SENTINEL: "must-not-enter-child"
    };
    let childCalls = 0;
    const terminal = await executeLive(liveEnv, {
      childRunner: async ({ jobDigest, childEnv }) => {
        childCalls += 1;
        assert.equal(jobDigest, job.digest);
        assert.equal(childEnv.SECRET_SENTINEL, undefined);
        assert.equal(childEnv.V2_BASIC_PLACE_REQUEST_BUDGET, "1");
        return {
          exitCode: 0,
          signal: null,
          stderrPresent: false,
          result: {
            event: "v2_live_basic_place_complete",
            status: "completed",
            mode: "live",
            runId: JOB_RUN_ID,
            keyword: "경남 글램핑",
            organicRows: 50,
            advertisementRows: 18,
            externalRequests: 1,
            retryCount: 0,
            fallbackCount: 0,
            operationalWrites: 0,
            rawProviderResponseStored: false,
            manifestDigest: "a".repeat(64)
          }
        };
      }
    });
    assert.equal(childCalls, 1);
    assert.equal(terminal.event, "v2_live_basic_place_render_terminal");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.externalRequests, 1);
    assert.equal(terminal.collectorInvocations, 1);
    assert.equal(terminal.operationalWrites, 0);

    const duplicate = await executeLive(liveEnv, {
      childRunner: async () => {
        childCalls += 1;
        throw new Error("duplicate must not execute child");
      }
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.externalRequests, 0);
    assert.equal(duplicate.collectorInvocations, 0);
    assert.equal(childCalls, 1);

    await expectCode(() => executeLive({
      ...liveEnv,
      [OUTER_ENV_NAMES.approvedJobDigest]: "0".repeat(64)
    }, { childRunner: async () => { throw new Error("must not run"); } }), "V2_BASIC_RENDER_LIVE_GATE_INVALID");

    await expectCode(() => readiness({
      ...baseEnv(stateDir),
      [OUTER_ENV_NAMES.stateDir]: LOCAL_STATE_ROOT
    }), "V2_BASIC_RENDER_STATE_INVALID");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ event: "v2_live_basic_place_render_tests_complete", assertions: 34, externalRequests: 0, operationalWrites: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
