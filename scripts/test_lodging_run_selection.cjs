"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { runResultSelectionProfile } = require("./lodging_run_selection.cjs");

const ROOT = path.resolve(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");

assert.deepEqual(runResultSelectionProfile({
  naverOverall: 44,
  naverAds: 0,
  naverRegional: 0,
}), {
  resultState: "ready",
  hasCollectedResults: true,
  autoSelectable: true,
});

assert.deepEqual(runResultSelectionProfile({
  naverOverall: 0,
  naverAds: 0,
  naverRegional: 0,
  naverBookingStockSucceeded: 0,
  nolFirstPage: 0,
  ddnayo: 0,
}), {
  resultState: "empty",
  hasCollectedResults: false,
  autoSelectable: false,
});

assert.deepEqual(runResultSelectionProfile({ legacyUnknownCount: 0 }), {
  resultState: "unknown",
  hasCollectedResults: null,
  autoSelectable: true,
}, "legacy runs without recognized counts must remain auto-selectable");

assert.deepEqual(runResultSelectionProfile({
  naverOverall: 0,
  naverAds: 0,
  naverRegional: 0,
  yeogiManual: 1,
}), {
  resultState: "ready",
  hasCollectedResults: true,
  autoSelectable: true,
}, "a manual platform supplement must keep the run usable");

function browserFunction(name) {
  const match = APP_SOURCE.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert.ok(match, `${name} must exist in app.js`);
  return vm.runInNewContext(`(${match[0]})`);
}

const preferredRunForAutoSelection = browserFunction("preferredRunForAutoSelection");
const runOptionLabel = browserFunction("runOptionLabel");
const emptyLatest = { id: "empty-latest", label: "산천 글램핑 · 2026-08-01", autoSelectable: false, resultState: "empty" };
const usableOlder = { id: "usable-older", label: "포천 글램핑 · 2026-08-01", autoSelectable: true, resultState: "ready" };

assert.equal(preferredRunForAutoSelection([emptyLatest, usableOlder]).id, "usable-older", "latest empty run must not replace a usable run on automatic selection");
assert.equal(preferredRunForAutoSelection([emptyLatest]).id, "empty-latest", "an empty run remains inspectable when no usable run exists");
assert.equal(preferredRunForAutoSelection([{ id: "legacy" }, usableOlder]).id, "legacy", "legacy run compatibility must remain non-destructive");
assert.equal(runOptionLabel(emptyLatest), "산천 글램핑 · 2026-08-01 · 수집 표본 없음");
assert.equal(runOptionLabel(usableOlder), "포천 글램핑 · 2026-08-01");

assert.match(SERVER_SOURCE, /\.\.\.resultSelection/);
assert.match(APP_SOURCE, /state\.activeRunId = preferredRunForAutoSelection\(state\.runs\)\?\.id \|\| state\.runs\[0\]\.id;/);
assert.match(APP_SOURCE, /state\.activeRunId = result\.runId \|\| state\.runs\[0\]\?\.id;[\s\S]*?await loadRuns\(false\);/, "an explicitly completed crawl must remain selected even when it has no samples");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("fixture server health timeout");
}

async function writeRun(outputsDir, id, manifest, mtime) {
  const dir = path.join(outputsDir, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "report.md"), "# isolated run fixture\n", "utf8");
  if (manifest) {
    await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      keyword: manifest.keyword,
      fileRoles: { report: "report.md" },
      files: ["report.md"],
      counts: manifest.counts,
    }), "utf8");
  }
  await fsp.utimes(dir, mtime, mtime);
}

async function integrationCheck() {
  const runtimeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lodging-run-selection-"));
  const outputsDir = path.join(runtimeRoot, "outputs");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  try {
    await writeRun(outputsDir, "empty_glamping_20260802_120000", {
      keyword: "산천 글램핑",
      counts: { naverOverall: 0, naverAds: 0, naverRegional: 0, naverBookingStockSucceeded: 0, nolFirstPage: 0, ddnayo: 0 },
    }, new Date("2026-08-02T03:00:00.000Z"));
    await writeRun(outputsDir, "pocheon_glamping_20260801_143532", {
      keyword: "포천 글램핑",
      counts: { naverOverall: 44, naverAds: 0, naverRegional: 0 },
    }, new Date("2026-08-01T05:35:32.000Z"));
    await writeRun(outputsDir, "legacy_glamping_20260731_100000", null, new Date("2026-07-31T01:00:00.000Z"));

    child = spawn(process.execPath, [path.join(ROOT, "scripts", "glamping_app_server.cjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        RENDER: "",
        RENDER_SERVICE_NAME: "",
        RENDER_EXTERNAL_URL: "",
        RENDER_EXTERNAL_HOSTNAME: "",
        V2_PREVIEW_DATA_ROOT: runtimeRoot,
        SEED_OUTPUTS_FROM_REPO: "0",
        GLAMPING_ADMIN_USER: "run-selection-admin",
        GLAMPING_ADMIN_PASSWORD: "RunSelectionTest!123",
        GLAMPING_B2B_ENABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForHealth(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "run-selection-admin", password: "RunSelectionTest!123" }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    const response = await fetch(`${baseUrl}/api/runs`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.runs.map((run) => run.id), [
      "empty_glamping_20260802_120000",
      "pocheon_glamping_20260801_143532",
      "legacy_glamping_20260731_100000",
    ], "server ordering must remain newest-first without deleting empty runs");
    assert.deepEqual(payload.runs.map((run) => [run.resultState, run.autoSelectable]), [
      ["empty", false],
      ["ready", true],
      ["unknown", true],
    ]);
    const emptyRun = await fetch(`${baseUrl}/api/runs/empty_glamping_20260802_120000`, { headers: { cookie } });
    assert.equal(emptyRun.status, 200, "known-empty runs must remain explicitly inspectable");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  }
}

integrationCheck()
  .then(() => console.log("Lodging run automatic selection checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
