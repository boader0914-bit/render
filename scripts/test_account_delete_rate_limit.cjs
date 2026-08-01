"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(__dirname, "glamping_app_server.cjs");

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startServer(port, runtimeRoot) {
  const child = spawn(process.execPath, [SERVER_PATH], {
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
      GLAMPING_ADMIN_USER: "rate-limit-test-admin",
      GLAMPING_ADMIN_PASSWORD: "RateLimitTestOnly!123",
      GLAMPING_B2B_ENABLED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-4000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-4000); });
  return { child, output: () => output };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("server health timeout");
}

function postJsonFrom(baseUrl, pathname, payload, localAddress) {
  const url = new URL(pathname, baseUrl);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      localAddress,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "isolated-rate-limit-test"
      }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function deletePayload(username, contact) {
  return {
    username,
    contact,
    requestType: "account_delete",
    detail: "isolated rate-limit fixture",
    confirmRequest: "1"
  };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "account-delete-rate-limit-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port, tempRoot);
  try {
    await waitForHealth(baseUrl, server.child);

    let usernameLimited;
    for (let index = 0; index < 11; index += 1) {
      usernameLimited = await postJsonFrom(
        baseUrl,
        "/api/account-delete-request",
        deletePayload("same-anonymous-user", `different-${index}@example.invalid`),
        `127.0.1.${index + 2}`
      );
    }
    assert.equal(usernameLimited.status, 429, "same normalized username is limited even when contact and source address vary");

    const contactVariants = [
      "010-5555-0000",
      "010 5555 0000",
      "(010) 5555-0000",
      "010.5555.0000"
    ];
    let contactLimited;
    for (let index = 0; index < 11; index += 1) {
      contactLimited = await postJsonFrom(
        baseUrl,
        "/api/account-delete-request",
        deletePayload(`different-user-${index}`, contactVariants[index % contactVariants.length]),
        `127.0.2.${index + 2}`
      );
    }
    assert.equal(contactLimited.status, 429, "same canonical contact is limited even when username and source address vary");

    const persistedPath = path.join(tempRoot, "customer_db", "account_delete_requests.json");
    const persisted = await fsp.readFile(persistedPath, "utf8");
    assert.doesNotMatch(persisted, /127\.0\./, "raw client addresses must never be persisted");
    const rows = JSON.parse(persisted).requests;
    assert.equal(rows.length, 20, "only accepted requests are persisted");
    assert.equal(rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.ipHash || ""))), true, "persisted client identity is hash-only");

    console.log("Independent account deletion identity and IP rate-limit checks passed");
  } catch (error) {
    error.message += `\nserver output=${server.output()}`;
    throw error;
  } finally {
    await stopChild(server.child).catch(() => {});
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unsafe temp path: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
