const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  assertV2PreviewRuntimeEnv,
  isRenderRuntime,
  isV2PreviewRuntime
} = require("./runtime_security.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "scripts", "glamping_app_server.cjs");

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

function spawnV2(envOverrides = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      RENDER_EXTERNAL_HOSTNAME: "",
      RENDER_SERVICE_NAME: "",
      V2_PREVIEW_DATA_ROOT: "",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return {
    child,
    output: () => ({ stdout, stderr })
  };
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child process did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForHealth(url, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before health check: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("health check timed out");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await waitForExit(child, 5000);
}

async function main() {
  const previewMarker = {
    RENDER: "true",
    RENDER_SERVICE_NAME: "lodging-datalab-preview",
    RENDER_EXTERNAL_HOSTNAME: "sa-labs-datalab-v4-preview.onrender.com"
  };
  assert.equal(isV2PreviewRuntime(previewMarker), true);
  assert.equal(isV2PreviewRuntime({ RENDER_SERVICE_NAME: "lodging-datalab-preview" }), true, "exact Preview service name is independently fail-closed");
  assert.equal(isV2PreviewRuntime({ RENDER_EXTERNAL_URL: "https://sa-labs-datalab-v4-preview.onrender.com" }), true, "exact Preview URL is independently fail-closed");
  assert.equal(isRenderRuntime({ RENDER: "false" }), false, "RENDER=false is not a Render runtime");
  assert.equal(isRenderRuntime({ RENDER: "0" }), false, "RENDER=0 is not a Render runtime");
  assert.equal(isV2PreviewRuntime({ RENDER: "false", RENDER_SERVICE_NAME: "lodging-datalab-preview" }), true, "exact Preview identity remains fail-closed even with a contradictory flag");
  assert.throws(() => assertV2PreviewRuntimeEnv(previewMarker), /requires V2_PREVIEW_DATA_ROOT/);
  assert.throws(() => assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/var/data",
    GLAMPING_ADMIN_USER: "preview-admin",
    GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
    GLAMPING_B2B_ENABLED: "0"
  }), /dedicated child/);
  assert.throws(() => assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/srv/preview-runtime",
    GLAMPING_ADMIN_USER: "preview-admin",
    GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
    GLAMPING_B2B_ENABLED: "0"
  }), /dedicated child/);
  assert.throws(() => assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime",
    GLAMPING_ADMIN_USER: "",
    GLAMPING_ADMIN_PASSWORD: "",
    GLAMPING_B2B_ENABLED: "0"
  }), /explicit GLAMPING_ADMIN_USER/);
  assert.throws(() => assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime",
    GLAMPING_ADMIN_USER: "preview-admin",
    GLAMPING_ADMIN_PASSWORD: "short",
    GLAMPING_B2B_ENABLED: "0"
  }), /12\+ character/);
  assert.throws(() => assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime",
    GLAMPING_ADMIN_USER: "preview-admin",
    GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
    GLAMPING_B2B_ENABLED: "1"
  }), /GLAMPING_B2B_ENABLED=0/);
  assert.deepEqual(assertV2PreviewRuntimeEnv({
    ...previewMarker,
    V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime",
    GLAMPING_ADMIN_USER: "preview-admin",
    GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
    GLAMPING_B2B_ENABLED: "0"
  }), { preview: true, dataRoot: "/var/data/v2-preview-runtime" });
  assert.deepEqual(assertV2PreviewRuntimeEnv({
    RENDER: "true",
    RENDER_SERVICE_NAME: "glamping-datalab-v2"
  }), { preview: false });
  assert.deepEqual(assertV2PreviewRuntimeEnv({ NODE_ENV: "test" }), { preview: false });

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "v2-preview-boundary-"));
  try {
    const serviceOnlyMissingRoot = spawnV2({
      RENDER_SERVICE_NAME: "lodging-datalab-preview"
    });
    assert.notEqual(await waitForExit(serviceOnlyMissingRoot.child), 0);
    assert.match(serviceOnlyMissingRoot.output().stderr, /requires V2_PREVIEW_DATA_ROOT/);

    const hostOnlyMissingRoot = spawnV2({
      RENDER_EXTERNAL_HOSTNAME: "sa-labs-datalab-v4-preview.onrender.com"
    });
    assert.notEqual(await waitForExit(hostOnlyMissingRoot.child), 0);
    assert.match(hostOnlyMissingRoot.output().stderr, /requires V2_PREVIEW_DATA_ROOT/);

    const previewShortSecret = spawnV2({
      RENDER_SERVICE_NAME: "lodging-datalab-preview",
      V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime",
      GLAMPING_ADMIN_USER: "preview-admin",
      GLAMPING_ADMIN_PASSWORD: "short",
      GLAMPING_B2B_ENABLED: "0"
    });
    assert.notEqual(await waitForExit(previewShortSecret.child), 0);
    assert.match(previewShortSecret.output().stderr, /12\+ character/);

    const relativeRoot = spawnV2({
      V2_PREVIEW_DATA_ROOT: "relative-preview-root",
      GLAMPING_ADMIN_USER: "preview-admin",
      GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
      GLAMPING_B2B_ENABLED: "0"
    });
    assert.notEqual(await waitForExit(relativeRoot.child), 0);
    assert.match(relativeRoot.output().stderr, /must be an absolute path/);

    const missingAdmin = spawnV2({
      V2_PREVIEW_DATA_ROOT: path.join(tempRoot, "missing-admin"),
      GLAMPING_ADMIN_USER: "",
      GLAMPING_ADMIN_PASSWORD: "",
      GLAMPING_B2B_ENABLED: "0"
    });
    assert.notEqual(await waitForExit(missingAdmin.child), 0);
    assert.match(missingAdmin.output().stderr, /requires explicit GLAMPING_ADMIN_USER/);

    const missingB2b = spawnV2({
      V2_PREVIEW_DATA_ROOT: path.join(tempRoot, "missing-b2b"),
      GLAMPING_ADMIN_USER: "preview-admin",
      GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
      GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "",
      GLAMPING_B2B_PASSWORD: ""
    });
    assert.notEqual(await waitForExit(missingB2b.child), 0);
    assert.match(missingB2b.output().stderr, /must disable B2B or configure explicit/);

    const isolatedRoot = path.join(tempRoot, "isolated-runtime");
    const ignoredDataDir = path.join(tempRoot, "must-not-be-used");
    const port = await availablePort();
    const healthy = spawnV2({
      PORT: String(port),
      V2_PREVIEW_DATA_ROOT: isolatedRoot,
      DATA_DIR: ignoredDataDir,
      OUTPUTS_DIR: path.join(ignoredDataDir, "outputs"),
      CONFIG_DIR: path.join(ignoredDataDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "1",
      GLAMPING_ADMIN_USER: "preview-admin",
      GLAMPING_ADMIN_PASSWORD: "PreviewOnlyTest!123",
      GLAMPING_B2B_ENABLED: "0"
    });
    try {
      const response = await waitForHealth(`http://127.0.0.1:${port}/api/health`, healthy.child);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.loginRequired, true);

      const loginResponse = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "preview-admin", password: "PreviewOnlyTest!123" })
      });
      assert.equal(loginResponse.status, 200);
      const sessionCookie = String(loginResponse.headers.get("set-cookie") || "").split(";")[0];
      assert.match(sessionCookie, /^glamping_datalab_session=/);

      const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
        headers: { cookie: sessionCookie }
      });
      assert.equal(sessionResponse.status, 200);
      assert.equal((await sessionResponse.json()).role, "admin");

      const runsResponse = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: { cookie: sessionCookie }
      });
      assert.equal(runsResponse.status, 200);
      assert.deepEqual((await runsResponse.json()).runs, []);

      const logoutResponse = await fetch(`http://127.0.0.1:${port}/api/logout`, {
        method: "POST",
        headers: { cookie: sessionCookie }
      });
      assert.equal(logoutResponse.status, 200);
      assert.equal(await fsp.stat(isolatedRoot).then((item) => item.isDirectory()), true);
      await assert.rejects(() => fsp.stat(ignoredDataDir), { code: "ENOENT" });
    } finally {
      await stopChild(healthy.child);
    }

    console.log("Preview V2 data and credential boundary tests passed");
  } finally {
    const resolvedTempRoot = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    const relative = path.relative(resolvedSystemTemp, resolvedTempRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected temp path: ${resolvedTempRoot}`);
    }
    await fsp.rm(resolvedTempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
