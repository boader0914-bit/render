"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { makeCompanyBootstrapMaster } = require("./company_bootstrap_fixture.cjs");

async function startCompanyBootstrapFixture({ master = makeCompanyBootstrapMaster(25, { evidenceRows: 20 }), dataDir = "" } = {}) {
  const root = path.resolve(__dirname, "../..");
  const owned = !dataDir;
  const directory = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), "company-bootstrap-api-"));
  await fs.mkdir(path.join(directory, "company_master"), { recursive: true });
  await fs.mkdir(path.join(directory, "history"), { recursive: true });
  if (!dataDir) {
    await fs.writeFile(path.join(directory, "company_master", "companies.json"), JSON.stringify(master));
    await fs.writeFile(path.join(directory, "history", "observations.jsonl"), "");
  }
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, preload = path.join(directory, "no-network.cjs");
  await fs.writeFile(preload, "global.fetch = async () => { throw new Error('External requests forbidden by bootstrap test'); };\n");
  let output = "";
  const started = performance.now();
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: directory, OUTPUTS_DIR: path.join(directory, "outputs"), CONFIG_DIR: path.join(directory, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "bootstrap-admin", GLAMPING_ADMIN_PASSWORD: "bootstrap-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "bootstrap-member", GLAMPING_B2B_PASSWORD: "bootstrap-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  let ready = false;
  try {
    for (let i = 0; i < 400; i += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Bootstrap fixture readiness timeout: " + output);
  } catch (error) { child.kill(); throw error; }
  async function request(route, { cookie = "", method = "GET", body, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, response, text, data: JSON.parse(text) };
  }
  async function login(username = "bootstrap-admin") {
    const result = await request("/api/login", { method: "POST", body: { username, password: "bootstrap-test-password" } });
    if (result.status !== 200) throw new Error("Fixture login failed");
    return result.response.headers.get("set-cookie").split(";")[0];
  }
  return { base, child, dataDir: directory, request, login, readinessMs: performance.now() - started,
    output: () => output,
    async stop({ preserve = false } = {}) {
      child.kill(); if (child.exitCode === null) await once(child, "exit");
      if (owned && !preserve) {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path");
        await fs.rm(directory, { recursive: true, force: true });
      }
    } };
}
module.exports = { startCompanyBootstrapFixture };
