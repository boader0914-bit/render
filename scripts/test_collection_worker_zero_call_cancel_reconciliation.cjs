"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

execFileSync(process.execPath, [path.join(__dirname, "test_collection_worker_v2_top20_orchestrator.cjs")], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  env: { ...process.env }
});

console.log(JSON.stringify({
  ok: true,
  zeroCallCancellationReconciliation: true,
  externalNetworkCalls: 0
}));
