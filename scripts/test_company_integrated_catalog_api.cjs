"use strict";

// Real local app processes and the real saved-source/calculation engines.
// Process one creates durable fixture results; process two gates unrelated
// background startup work so its first cached GET can be measured separately.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const COUNTERS = ["fullCatalogCalls", "targetCatalogCalls", "capacityPrepareCalls", "historyStreams", "historyFileReads", "historyFileHandleOpens", "companySourceReads", "externalRequests"];

async function main() {
  const deadline = Date.now() + 45000;
  const repo = path.resolve(__dirname, ".."), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-catalog-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
  const originalMaster = await fs.readFile(masterFile), originalHistory = await fs.readFile(historyFile);
  const monthFile = path.join(dataDir, "company_integrated", crypto.createHash("sha256").update(fixture.companyId).digest("hex"), "2026-08.json");
  const queueFile = path.join(dataDir, "company_integrated", "queue.json");
  let activeChild, preserveFailure = false;

  async function start(ordinal, gateBootstrap) {
    const listener = net.createServer().listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`, auditFile = path.join(dataDir, `catalog-audit-${ordinal}.json`),
      releaseFile = path.join(dataDir, `catalog-release-${ordinal}.flag`), preloadFile = path.join(dataDir, `catalog-preload-${ordinal}.cjs`);
    await fs.writeFile(preloadFile, `
      const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
      const audit = { fullCatalogCalls:0, targetCatalogCalls:0, capacityPrepareCalls:0, historyStreams:0, historyFileReads:0, historyFileHandleOpens:0,
        companySourceReads:0, externalRequests:0, catalogPrewarmLogs:0, bootstrapEntered:false, bootstrapCompleted:false, bootstrapErrorCode:null };
      const write = fs.writeFileSync.bind(fs), auditPath = ${JSON.stringify(auditFile)};
      let auditSequence = 0;
      const save = () => {
        const target = auditPath + '.' + String(++auditSequence).padStart(6, '0');
        const temporary = target + '.tmp';
        write(temporary, JSON.stringify(audit));
        fs.renameSync(temporary, target);
      };
      save();
      const isHistory = file => typeof file === 'string' && path.resolve(file) === ${JSON.stringify(path.resolve(historyFile))};
      const stream = fs.createReadStream;
      fs.createReadStream = function(file,...args) { if(isHistory(file)) { audit.historyStreams++; save(); } return stream.call(this,file,...args); };
      const read = fsp.readFile;
      fsp.readFile = function(file,...args) { if(isHistory(file)) { audit.historyFileReads++; save(); } return read.call(this,file,...args); };
      const open = fsp.open;
      fsp.open = function(file,...args) { if(isHistory(file)) { audit.historyFileHandleOpens++; save(); } return open.call(this,file,...args); };
      const readSync = fs.readFileSync;
      fs.readFileSync = function(file,...args) { if(isHistory(file)) { audit.historyFileReads++; save(); } return readSync.call(this,file,...args); };
      global.fetch = async () => { audit.externalRequests++; save(); throw new Error('External requests forbidden'); };
      const log = console.log;
      console.log = function(...args) { if(args[0] === 'company_integrated_catalog_prepared') { audit.catalogPrewarmLogs++; save(); } return log.apply(this,args); };
      const capacity = require(${JSON.stringify(path.join(repo, "scripts/lib/company_capacity_registry.cjs"))});
      const originalCapacity = capacity.createCompanyCapacityRegistry;
      capacity.createCompanyCapacityRegistry = options => {
        const service = originalCapacity(options), prepare = service.prepareCompanies;
        service.prepareCompanies = (...args) => { audit.capacityPrepareCalls++; save(); return prepare(...args); };
        return service;
      };
      const sources = require(${JSON.stringify(path.join(repo, "scripts/lib/monthly_report_sources.cjs"))});
      const originalSources = sources.createMonthlyReportSources;
      sources.createMonthlyReportSources = options => {
        const service = originalSources(options), catalog = service.catalog, targets = service.targetCatalog, load = service.loadSources;
        service.catalog = (...args) => { audit.fullCatalogCalls++; save(); return catalog(...args); };
        service.targetCatalog = (...args) => { audit.targetCatalogCalls++; save(); return targets(...args); };
        service.loadSources = (request,...args) => { if(request.type === 'company') { audit.companySourceReads++; save(); } return load(request,...args); };
        return service;
      };
      const integrated = require(${JSON.stringify(path.join(repo, "scripts/lib/company_integrated_db.cjs"))});
      const originalIntegrated = integrated.createCompanyIntegratedDb;
      integrated.createCompanyIntegratedDb = options => {
        const service = originalIntegrated(options), bootstrap = service.bootstrap;
        process.on('message', message => { if(message?.type === 'company-catalog-fixture-status') service.status()
          .then(status => process.send?.({type:'company-catalog-fixture-status',status}))
          .catch(error => process.send?.({type:'company-catalog-fixture-status',errorCode:error.code || 'STATUS_FAILED'})); });
        service.bootstrap = async () => {
          audit.bootstrapEntered = true; save();
          if(${JSON.stringify(gateBootstrap)}) while(!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise(resolve=>setTimeout(resolve,10));
          try { const result = await bootstrap(); audit.bootstrapCompleted = true; save(); return result; }
          catch(error) { audit.bootstrapErrorCode = /^[A-Za-z0-9_:-]+$/.test(error.code || '') ? error.code : 'BOOTSTRAP_FAILED'; save(); throw error; }
        };
        return service;
      };
      // Independent industry startup can use the same source reader. Gate it
      // out of this company-API experiment; no company result/source is stubbed.
      const industry = require(${JSON.stringify(path.join(repo, "scripts/lib/industry_analysis.cjs"))});
      const originalIndustry = industry.createIndustryAnalysisService;
      industry.createIndustryAnalysisService = options => {
        const service = originalIndustry({...options,autoStart:false}); service.bootstrap = async () => {}; return service;
      };
    `);
    const child = spawn(process.execPath, ["--require", preloadFile, path.join(repo, "scripts/glamping_app_server.cjs")], {
      cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
        RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
        GLAMPING_ADMIN_USER: "catalog-fixture-admin", GLAMPING_ADMIN_PASSWORD: "catalog-fixture-password", GLAMPING_B2B_ENABLED: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: ""
      }
    });
    let childOutput = "";
    const captureOutput = bytes => { childOutput = (childOutput + bytes.toString("utf8")).slice(-32768); };
    child.stdout.on("data", captureOutput); child.stderr.on("data", captureOutput);
    activeChild = child;
    const running = () => {
      assert.ok(Date.now() < deadline, "compact-catalog API experiment exceeded its bounded deadline");
      assert.equal(child.exitCode, null, `local app exited in process ${ordinal}`);
      assert.equal(child.signalCode, null, `local app stopped in process ${ordinal}`);
    };
    const audit = async () => {
      const prefix = path.basename(auditFile) + ".";
      const latest = (await fs.readdir(dataDir)).filter(name => name.startsWith(prefix)
        && /^\d{6}$/.test(name.slice(prefix.length))).sort().at(-1);
      assert.ok(latest, "the local audit must publish a complete immutable snapshot");
      return JSON.parse(await fs.readFile(path.join(dataDir, latest), "utf8"));
    };
    const serviceStatus = () => new Promise(resolve => {
      const listener = message => { if (message?.type === "company-catalog-fixture-status") { clearTimeout(timer); child.off("message", listener); resolve(message); } };
      const timer = setTimeout(() => { child.off("message", listener); resolve({ diagnosticError: "STATUS_IPC_TIMEOUT" }); }, 1000);
      child.on("message", listener); child.send({ type: "company-catalog-fixture-status" });
    });
    async function ready() {
      for (let i = 0; i < 200; i++) {
        running();
        try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1500) })).ok) return; } catch {}
        await pause(25);
      }
      assert.fail(`readiness timed out in process ${ordinal}`);
    }
    async function idle() {
      let state, lastStatus;
      for (let i = 0; i < 400; i++) {
        running();
        const counters = await audit(); assert.equal(counters.bootstrapErrorCode, null);
        // Poll the real in-memory service over fixture-only IPC. Opening the
        // destination queue file every 25ms can reject the app's atomic rename
        // with EPERM on Windows, turning this observer into a write fault.
        lastStatus = await serviceStatus(); const status = lastStatus.status;
        assert.ok(status, "fixture service status unavailable: " + JSON.stringify(lastStatus));
        assert.equal(status.errorCode, null); assert.notEqual(status.bootstrap?.status, "failed", status.bootstrap?.errorCode || "bootstrap failed");
        assert.ok(!status.jobs.some(job => job.status === "failed"),
          "company job errors: " + JSON.stringify(status.jobs.filter(job => job.status === "failed")
            .map(job => ({ companyId: job.companyId, errorCode: job.errorCode, months: job.months }))));
        if (counters.bootstrapCompleted && !status.active && status.bootstrap?.status === "checked" && status.jobs.every(job => job.status === "idle")) {
          // Independently inspect durable state only after every writer has
          // finished. Do not replace the saved-file parity proof with IPC.
          state = JSON.parse(await fs.readFile(queueFile, "utf8"));
          assert.deepEqual(state.bootstrap, status.bootstrap);
          assert.deepEqual(Object.values(state.jobs).map(job => [job.companyId, job.status, job.generation]).sort(), status.jobs.map(job => [job.companyId, job.status, job.generation]).sort());
          return state;
        }
        await pause(25);
      }
      preserveFailure = true;
      let analytical = null;
      try {
        const cookie = await login(), response = await fetch(base + "/api/analytical-work", { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) });
        if (response.ok) analytical = await response.json();
      } catch (error) { analytical = { diagnosticError: error.code || error.name || "unavailable" }; }
      const integratedStatus = await serviceStatus();
      try { state = JSON.parse(await fs.readFile(queueFile, "utf8")); } catch {}
      const failure = { at: new Date().toISOString(), process: ordinal, state, audit: await audit(), analytical, integratedStatus, childOutput,
        isolation: "Local synthetic fixture only; no production calls or real user credentials", dataDir };
      await fs.writeFile(path.join(dataDir, "idle-timeout-diagnostics.json"), JSON.stringify(failure, null, 2), { flag: "wx" });
      console.error("COMPANY_CATALOG_IDLE_DIAGNOSTICS=" + JSON.stringify(failure));
      assert.fail(`company work did not finish in process ${ordinal}; isolated diagnostics retained at ${dataDir}`);
    }
    async function login() {
      running();
      const response = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json", Origin: base },
        body: JSON.stringify({ username: "catalog-fixture-admin", password: "catalog-fixture-password" }), signal: AbortSignal.timeout(2500) });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    }
    async function get(cookie) {
      running();
      const began = performance.now(), response = await fetch(base + `/api/company-master/integrated?companyId=${fixture.companyId}&month=2026-08`,
        { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2500) });
      assert.equal(response.status, 200);
      return { view: await response.json(), elapsedMs: performance.now() - began };
    }
    async function stop() { child.kill(); if (child.exitCode === null) await once(child, "exit"); activeChild = null; }
    return { ready, idle, login, get, audit, stop, release: () => fs.writeFile(releaseFile, "release", { flag: "wx" }) };
  }

  try {
    // Setup is itself a real app boot, not a hand-built result or fake source.
    const first = await start(1, false); await first.ready(); await first.idle();
    const initialAudit = await first.audit();
    assert.ok(initialAudit.fullCatalogCalls > 0 && initialAudit.capacityPrepareCalls > 0
      && initialAudit.historyStreams + initialAudit.historyFileReads + initialAudit.historyFileHandleOpens > 0,
      "first build must inspect real original history through its stream or indexed file-handle path");
    assert.equal(initialAudit.catalogPrewarmLogs, 1, "catalog preparation must run before readiness");
    const baseline = await first.get(await first.login());
    assert.equal(baseline.view.status, "ready"); assert.equal(baseline.view.roomBasis.capacity, 10);
    assert.ok(baseline.view.snapshot.sources.selectedObservationCount > 0, "use actual observed saved rows, not an empty monthly cache");
    assert.equal((await first.audit()).externalRequests, 0);
    const savedMonth = await fs.readFile(monthFile), savedStat = await fs.stat(monthFile, { bigint: true });
    await first.stop();

    const second = await start(2, true); await second.ready();
    const cookie = await second.login(), before = await second.audit();
    assert.equal(before.catalogPrewarmLogs, 1);
    assert.equal(before.bootstrapCompleted, false, "background company work is still gated");
    for (const counter of COUNTERS) assert.equal(before[counter], 0, `persisted compact prewarm must avoid ${counter}`);
    // This is process two's first company GET immediately after health/login.
    const measured = await second.get(cookie), after = await second.audit();
    assert.equal(measured.view.status, "ready");
    assert.equal(measured.view.roomBasis.capacity, 10);
    assert.equal(measured.view.calculatedAt, baseline.view.calculatedAt);
    assert.deepEqual(measured.view.snapshot.summary, baseline.view.snapshot.summary);
    assert.deepEqual(measured.view.snapshot.sources.observations, baseline.view.snapshot.sources.observations);
    assert.deepEqual(measured.view.keywords, baseline.view.keywords);
    assert.equal(measured.view.snapshot.quality.status, baseline.view.snapshot.quality.status);
    for (const counter of COUNTERS) assert.equal(after[counter], before[counter], `first company GET must not add ${counter}`);
    assert.ok(measured.elapsedMs <= 2000, "a ready compact fixture GET must not wait on gated source work");
    assert.deepEqual(await fs.readFile(monthFile), savedMonth);
    const afterGetStat = await fs.stat(monthFile, { bigint: true });
    assert.deepEqual([afterGetStat.ino, afterGetStat.mtimeNs], [savedStat.ino, savedStat.mtimeNs]);

    // Release the barrier and let the actual startup/core verify and resume.
    await second.release(); const state = await second.idle(), finalAudit = await second.audit();
    assert.equal(state.bootstrap.queued, 0); assert.ok(state.bootstrap.reused >= 3);
    assert.ok(finalAudit.targetCatalogCalls > after.targetCatalogCalls, "real lightweight target discovery still runs after release");
    assert.equal(finalAudit.companySourceReads, 0, "closed unchanged months remain reusable");
    assert.equal(finalAudit.externalRequests, 0);
    assert.deepEqual(await fs.readFile(monthFile), savedMonth);
    assert.deepEqual(await fs.readFile(masterFile), originalMaster);
    assert.deepEqual(await fs.readFile(historyFile), originalHistory);
    await second.stop();
    console.log("COMPANY_CATALOG_API_TIMING=" + JSON.stringify({
      environment: "isolated local fixture", firstProcessReadyGetMs: Number(baseline.elapsedMs.toFixed(3)),
      restartedFirstReadyGetMs: Number(measured.elapsedMs.toFixed(3)),
      firstGetCounterDelta: Object.fromEntries(COUNTERS.map(counter => [counter, after[counter] - before[counter]])),
      sourceParity: true, savedMonthUntouched: true, browserTiming: false
    }));
    console.log("Company compact catalog API: real two-process saved-cache reuse; first GET adds zero full catalogs/capacity prepares/history/source reads; observed-month parity, unchanged sources and normal bootstrap recovery passed");
  } finally {
    if (activeChild) { activeChild.kill(); if (activeChild.exitCode === null) await once(activeChild, "exit"); }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    if (!preserveFailure) await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
