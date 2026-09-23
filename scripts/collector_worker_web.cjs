"use strict";

const http = require("node:http");
const { workerOptions, runWorker } = require("./collector_worker.cjs");

// Render Web Services require a listening port. This process exposes health only;
// it cannot accept collection jobs, browse retained artifacts, or administer the app.
async function startWorkerWeb({ env = process.env, port = env.PORT || 10000, host = "0.0.0.0",
  signal, workerOverrides = {}, run = runWorker, logger = () => {} } = {}) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) throw new Error("COLLECTOR_CONFIGURATION_INVALID");
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  signal?.addEventListener("abort", shutdown, { once: true });
  if (signal?.aborted) controller.abort();
  const options = workerOptions(env, { ...workerOverrides, signal: controller.signal, logger });
  const state = { status: options.enabled ? "starting" : "disarmed", healthy: true, errorCode: null };
  const server = http.createServer((req, res) => {
    const route = (req.url || "").split("?")[0];
    req.resume();
    if (!["GET", "HEAD"].includes(req.method) || !["/health", "/api/health"].includes(route)) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"error":"not_found"}');
      return;
    }
    res.writeHead(state.healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: state.healthy, service: "collector-worker", state: state.status }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(portNumber, host, resolve); });
  } catch (error) {
    signal?.removeEventListener("abort", shutdown);
    throw error;
  }
  const done = (async () => {
    if (!options.enabled) {
      await waitForAbort(controller.signal);
      return { enabled: false, stopped: true };
    }
    state.status = "polling";
    try {
      const result = await run(options);
      if (controller.signal.aborted || result.stopped) return result;
      if (result.halted) {
        state.status = "halted";
        state.errorCode = result.code;
        await waitForAbort(controller.signal);
        return result;
      }
      throw new Error("COLLECTOR_LOOP_STOPPED");
    } catch (error) {
      state.status = "failed";
      state.healthy = false;
      state.errorCode = /^[A-Z][A-Z0-9_]+$/.test(error.code || "") ? error.code : "COLLECTOR_LOOP_STOPPED";
      logger({ event: "collector_worker_stopped", code: state.errorCode });
      throw Object.assign(new Error(state.errorCode), { code: state.errorCode });
    }
  })();
  // Callers receive the rejection through done; attach immediately to avoid an
  // unhandled rejection between listen() and the caller installing its handler.
  done.catch(() => {});
  async function close() {
    shutdown();
    await done.catch(() => {});
    signal?.removeEventListener("abort", shutdown);
    state.healthy = false;
    state.status = "stopped";
    await new Promise(resolve => server.close(resolve));
  }
  return { server, done, close, state };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let runtime;
  try {
    runtime = await startWorkerWeb({ signal: controller.signal, logger: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
    await runtime.done;
  } finally {
    await runtime?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (require.main === module) main().catch(() => { process.stderr.write("collector_worker_stopped\n"); process.exitCode = 1; });
module.exports = { startWorkerWeb };
