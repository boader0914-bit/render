"use strict";

const {
  runCollectionWorkerNaverCanary,
  safeFatalResult
} = require("./collection_worker_naver_canary.cjs");
const {
  projectV2EnvWorkerNoStoreResult
} = require("./v2_env_worker_no_store_canary.cjs");

async function main() {
  let result;
  try {
    result = await runCollectionWorkerNaverCanary();
    if (
      result.status !== "ready"
      || result.organicCount !== 50
      || result.artifactDecision !== "validated_no_store"
      || result.jobState !== "validated_no_store"
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    result = safeFatalResult(error);
    process.exitCode = 1;
  }
  result = projectV2EnvWorkerNoStoreResult(result);
  // Exactly one sanitized JSON line is the entire one-off job output.
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main();
}

module.exports = { main };
