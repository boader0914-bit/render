"use strict";

const {
  runCollectionWorkerV2Top20,
  safeFatalResult
} = require("./collection_worker_v2_top20_worker.cjs");

async function main() {
  let result;
  try {
    result = await runCollectionWorkerV2Top20();
    if (
      result.status !== "ready"
      || result.jobState !== "committed"
      || result.resultStored !== true
      || result.providerAttemptCount !== 1
      || result.executedCallCount < 21
      || result.executedCallCount > 201
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    result = safeFatalResult(error);
    process.exitCode = 1;
  }
  // A one-shot Worker emits exactly one sanitized receipt line. Provider
  // payloads, keywords, URLs, headers, credentials, and artifacts stay out.
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main();
}

module.exports = { main };
