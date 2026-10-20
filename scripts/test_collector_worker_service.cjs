"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), { spawn } = require("node:child_process"), { test } = require("node:test");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const scenario of ["invalid-config", "disabled"]) test("real worker main remains alive in " + scenario + " quarantine and shuts down without a restart loop", async () => {
  const root = path.resolve(__dirname, ".."), allowed = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [path.join(__dirname, "collector_worker.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...allowed, COLLECTOR_WORKER_ENABLED: scenario === "disabled" ? "0" : "1", COLLECTOR_SERVER_URL: "private-invalid-url-that-must-not-be-logged",
      COLLECTOR_WORKER_TOKEN: "synthetic-sensitive-token-never-print-1234567890", COLLECTOR_WORKER_ID: "synthetic-main" } });
  let output = "", exited = false, code = null, signal = null;
  const exit = new Promise(resolve => child.once("exit", (value, reason) => { exited = true; code = value; signal = reason; resolve(); }));
  child.stdout.on("data", value => { output = (output + value).slice(-16000); }); child.stderr.on("data", value => { output = (output + value).slice(-16000); });
  try {
    for (let i = 0; i < 300 && !output.includes("collector_worker_quarantined") && !exited; i++) await pause(10);
    assert.equal(exited, false, output); assert.match(output, /collector_worker_quarantined/);
    const row = output.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.event === "collector_worker_quarantined");
    assert.equal(row.code, scenario === "disabled" ? "COLLECTOR_WORKER_DISABLED" : "COLLECTOR_CONFIGURATION_INVALID"); assert.equal(row.requiresOperator, true);
    await pause(120); assert.equal(exited, false, "a quarantined worker must keep its process alive");
    assert.equal(output.includes("private-invalid-url"), false); assert.equal(output.includes("synthetic-sensitive-token"), false);
    assert.equal(output.includes("collector_worker_stopped"), false);
    child.kill("SIGTERM"); let timeout;
    try { await Promise.race([exit, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error("shutdown timeout")), 3000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(exited, true);
    assert.ok(code === 0 || signal === "SIGTERM", "only the explicit shutdown ends this fixture");
  } finally { if (!exited) { child.kill("SIGKILL"); await exit; } }
});
