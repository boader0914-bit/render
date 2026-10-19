"use strict";

// Real local application processes reuse the same synthetic saved data even
// when a deployment replaces identical source files with new filesystem IDs.
// Neither a production file nor an outbound provider endpoint is accessible.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, ".."), dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-restart-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const historyFile = path.join(dataDir, "history", "observations.jsonl"), masterFile = path.join(dataDir, "company_master", "companies.json");
  const originalHistory = await fs.readFile(historyFile), originalMaster = await fs.readFile(masterFile);
  const monthFile = path.join(dataDir, "company_integrated", crypto.createHash("sha256").update(fixture.companyId).digest("hex"), "2026-08.json");
  const savedMonth = (companyId, month) => path.join(dataDir, "company_integrated", crypto.createHash("sha256").update(companyId).digest("hex"), month + ".json");
  const region = JSON.parse(await fs.readFile(path.join(root, "web/data/region_master.json"), "utf8")).units
    .find(unit => unit.name === "포천시" && unit.active && unit.selectable && unit.level === "local");
  assert.ok(region?.regionKey && region?.regionId, "fixture uses an actual registered region identity");
  const savedContextFiles = [];
  async function writeContext(relative, value) {
    const filename = path.join(dataDir, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(value)); savedContextFiles.push(filename);
  }
  // Calendar and KOSIS use real cache envelopes. The tourism context sentinel
  // exercises the conservative saved-response dependency index; it does not
  // manufacture a published tourism metric or make an outbound provider call.
  await writeContext("history/special_days/special-days-2026.json", { version: 1, year: 2026, categories: {} });
  await writeContext("history/kosis/" + crypto.createHash("sha256").update(region.regionId).digest("hex").slice(0, 24) + ".json",
    { version: 1, regionId: region.regionId, datasets: {} });
  await writeContext("tourism_data/cache/restart-context-202608.json", { snapshot: { regionKey: region.regionKey, yearMonth: "202608" } });
  const searchIdentity = { version: "region_glamping_exact_v1", regionKey: region.regionKey, month: "2026-08", keyword: "포천글램핑",
    startDate: "2025-09-01", endDate: "2026-08-31", timeUnit: "month", partialMonth: false };
  const searchHash = crypto.createHash("sha256").update(JSON.stringify(searchIdentity)).digest("hex"), searchStamp = "2026-09-01T00:00:00.000Z";
  const searchSeries = Array.from({ length: 12 }, (_, index) => ({ period: new Date(Date.UTC(2025, 8 + index, 1)).toISOString().slice(0, 10),
    ratio: 20 + index, value: 20 + index, status: "observed" }));
  await writeContext("regional_search_trends/cache/" + searchHash + ".json", { version: 1, identity: searchHash,
    snapshot: { ...searchIdentity, status: "ready", retrievedAt: searchStamp, series: searchSeries },
    lastAttempt: { at: searchStamp, status: "ready", errorCode: "" } });
  const sourceFiles = [masterFile, historyFile, ...fixture.runIds.map(id => path.join(dataDir, "outputs", id, "manifest.json")), ...savedContextFiles];
  const sourceBytes = new Map(await Promise.all(sourceFiles.map(async filename => [filename, await fs.readFile(filename)])));
  let activeChild;

  async function run(ordinal) {
    const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`, preload = path.join(dataDir, `local-preload-${ordinal}.cjs`), auditFile = path.join(dataDir, `local-audit-${ordinal}.json`);
    await fs.writeFile(preload, `
      const fs = require('node:fs');
      const audit = { companySourceReads: 0, companyRequests: [], externalRequests: 0, bootstrapCompleted: false, bootstrapErrorCode: null };
      const auditPath = ${JSON.stringify(auditFile)};
      let auditSequence = 0;
      const save = () => {
        const target = auditPath + '.' + String(++auditSequence).padStart(6, '0'), temporary = target + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(audit));
        fs.renameSync(temporary, target);
      };
      save();
      global.fetch = async () => { audit.externalRequests++; save(); throw new Error('External requests forbidden'); };
      const sourceModule = require(${JSON.stringify(path.join(root, "scripts/lib/monthly_report_sources.cjs"))});
      const originalSources = sourceModule.createMonthlyReportSources;
      sourceModule.createMonthlyReportSources = options => {
        const service = originalSources(options), original = service.loadSources;
        service.loadSources = (request, options) => {
          if (request.type === 'company') { audit.companySourceReads++; audit.companyRequests.push({ companyId: request.targetId, month: request.month }); save(); }
          return original(request, options);
        };
        return service;
      };
      const integrated = require(${JSON.stringify(path.join(root, "scripts/lib/company_integrated_db.cjs"))});
      const originalIntegrated = integrated.createCompanyIntegratedDb;
      integrated.createCompanyIntegratedDb = options => {
        const service = originalIntegrated(options), originalBootstrap = service.bootstrap;
        service.bootstrap = async () => {
          const snapshot = async () => { audit.coreStatus = await service.status(); save(); };
          const ticker = setInterval(() => snapshot().catch(() => {}), 25); ticker.unref();
          try { const result = await originalBootstrap(); audit.bootstrapCompleted = true; await snapshot(); return result; }
          catch (error) { audit.bootstrapErrorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'BOOTSTRAP_FAILED'; save(); throw error; }
        };
        return service;
      };
      // Isolate company bootstrap from unrelated industry startup maintenance.
      // The company bootstrap, revision reader and saved source scanner stay real.
      const industry = require(${JSON.stringify(path.join(root, "scripts/lib/industry_analysis.cjs"))});
      const originalIndustry = industry.createIndustryAnalysisService;
      industry.createIndustryAnalysisService = options => {
        const service = originalIndustry({...options,autoStart:false});
        service.bootstrap = async () => {};
        return service;
      };
    `);
    const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env,
        HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
        RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
        GLAMPING_ADMIN_USER: "restart-test-admin", GLAMPING_ADMIN_PASSWORD: "restart-test-password", GLAMPING_B2B_ENABLED: "0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: ""
      }
    });
    activeChild = child;
    const assertRunning = () => assert.equal(child.exitCode, null, `local app exited during run ${ordinal}`);
    let ready = false;
    for (let i = 0; i < 200; i++) {
      assertRunning();
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await sleep(50);
    }
    assert.equal(ready, true, `local readiness timed out during run ${ordinal}`);
    let state, bootstrapAudit;
    const readAudit = async () => {
      const prefix = path.basename(auditFile) + ".";
      const latest = (await fs.readdir(dataDir)).filter(name => name.startsWith(prefix)
        && /^\d{6}$/.test(name.slice(prefix.length))).sort().at(-1);
      return latest ? JSON.parse(await fs.readFile(path.join(dataDir, latest), "utf8")) : null;
    };
    for (let i = 0; i < 400; i++) {
      assertRunning();
      try { bootstrapAudit = await readAudit(); state = bootstrapAudit?.coreStatus; } catch {}
      assert.equal(bootstrapAudit?.bootstrapErrorCode || null, null, bootstrapAudit?.bootstrapErrorCode || "local bootstrap failed");
      assert.notEqual(state?.bootstrap?.status, "failed", state?.bootstrap?.errorCode || "local bootstrap failed");
      const jobs = Object.values(state?.jobs || {});
      assert.ok(!jobs.some(job => job.status === "failed"), "synthetic company bootstrap failed");
      if (bootstrapAudit?.bootstrapCompleted && state?.bootstrap?.status === "checked" && jobs.length && jobs.every(job => job.status === "idle")) break;
      await sleep(50);
    }
    assert.equal(state?.bootstrap?.status, "checked");
    assert.equal(bootstrapAudit?.bootstrapCompleted, true, "this process must complete its own fresh bootstrap inspection");
    assert.ok(Object.values(state.jobs).every(job => job.status === "idle"),
      "company bootstrap did not finish: " + JSON.stringify({ bootstrap: state.bootstrap, jobs: Object.values(state.jobs).map(job => ({
        companyId: job.companyId, status: job.status, errorCode: job.errorCode, months: job.months
      })), audit: bootstrapAudit }));
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "restart-test-admin", password: "restart-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(base + `/api/company-master/integrated?companyId=${fixture.companyId}&month=2026-08`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.status, "ready");
    assert.equal(view.roomBasis.capacity, 10);
    const audit = await readAudit();
    assert.equal(audit.externalRequests, 0);
    child.kill(); if (child.exitCode === null) await once(child, "exit"); activeChild = null;
    return { bootstrap: state.bootstrap, audit, view };
  }

  try {
    const first = await run(1);
    assert.ok(first.audit.companySourceReads > 0, "first startup must materialize actual saved observations");
    const before = await fs.readFile(monthFile), beforeStat = await fs.stat(monthFile, { bigint: true });
    const untouchedScopes = [[fixture.companyId, "2026-07"], ["cmp_place_monthly_b", "2026-08"]];
    const untouched = new Map(await Promise.all(untouchedScopes.map(async ([id, month]) => {
      const filename = savedMonth(id, month); return [filename, { bytes: await fs.readFile(filename), stat: await fs.stat(filename, { bigint: true }) }];
    })));
    // Materialize a new physical file for each identical input. Keeping the old
    // monthly files in place proves that reuse is based on source content,
    // rather than simply reusing unchanged inode/ctime metadata in one process.
    for (const filename of sourceFiles) {
      const previous = await fs.stat(filename, { bigint: true }), temporary = filename + ".same-bytes.tmp";
      await fs.writeFile(temporary, sourceBytes.get(filename), { flag: "wx" });
      await fs.rename(temporary, filename);
      const replaced = await fs.stat(filename, { bigint: true });
      assert.deepEqual(await fs.readFile(filename), sourceBytes.get(filename), "deployment replacement preserves source bytes");
      assert.ok(replaced.ino !== previous.ino || replaced.ctimeNs !== previous.ctimeNs,
        "fixture must actually replace source identity or creation metadata: " + path.relative(dataDir, filename));
    }
    const second = await run(2);
    const afterStat = await fs.stat(monthFile, { bigint: true });
    assert.equal(second.bootstrap.queued, 0, "unchanged companies are not requeued at restart");
    assert.ok(second.bootstrap.reused >= 3, "both companies and all existing closed months are reused");
    assert.equal(second.audit.companySourceReads, 0, "restart performs no heavy company loadSources reads");
    assert.deepEqual(await fs.readFile(monthFile), before);
    assert.deepEqual([afterStat.ino, afterStat.mtimeNs], [beforeStat.ino, beforeStat.mtimeNs], "reused monthly file is neither rewritten nor touched");
    assert.equal(second.view.calculatedAt, first.view.calculatedAt);
    assert.deepEqual(second.view.snapshot.summary, first.view.snapshot.summary);
    for (const [filename, value] of untouched) {
      const current = await fs.stat(filename, { bigint: true });
      assert.deepEqual(await fs.readFile(filename), value.bytes);
      assert.deepEqual([current.ino, current.mtimeNs], [value.stat.ino, value.stat.mtimeNs]);
    }
    assert.deepEqual(await fs.readFile(historyFile), originalHistory);
    assert.deepEqual(await fs.readFile(masterFile), originalMaster);
    // A true source edit still has to invalidate the affected company/month.
    // Update all equally recent copies of one day so canonical selection does
    // not depend on which same-time keyword observation wins the tie.
    let editedRows = 0;
    const changedHistory = originalHistory.toString("utf8").trimEnd().split("\n").map(line => {
      const row = JSON.parse(line);
      if (row.companyKey === fixture.companyId && row.stayDate === "2026-08-20" && row.collectedAt === "2026-08-15T00:00:00.000Z") {
        const price = row.publicRevenue / row.publicBookings;
        row.publicBookings++; row.sold++; row.available--; row.publicRevenue += price; row.estimatedRevenue += price; editedRows++;
      }
      return JSON.stringify(row);
    }).join("\n") + "\n";
    assert.ok(editedRows > 0, "fixture edits a real latest company observation");
    await fs.writeFile(historyFile, changedHistory);
    const third = await run(3);
    assert.equal(third.bootstrap.queued, 1, "only the company with changed observations is queued");
    assert.equal(third.bootstrap.refreshedMonths, 1, "only the affected observed month is recalculated");
    assert.deepEqual(third.audit.companyRequests, [
      { companyId: fixture.companyId, month: "2026-08" }, { companyId: fixture.companyId, month: "2026-07" }
    ], "heavy reads are limited to the changed month and its actual comparison source");
    assert.notDeepEqual(third.view.snapshot.summary, second.view.snapshot.summary, "the changed booking evidence reaches the saved result");
    for (const [filename, value] of untouched) {
      const current = await fs.stat(filename, { bigint: true });
      assert.deepEqual(await fs.readFile(filename), value.bytes, "unaffected saved month remains identical");
      assert.deepEqual([current.ino, current.mtimeNs], [value.stat.ino, value.stat.mtimeNs], "unaffected saved month is not rewritten");
    }
    for (const [filename, bytes] of sourceBytes) {
      assert.deepEqual(await fs.readFile(filename), filename === historyFile ? Buffer.from(changedHistory) : bytes,
        "application preserves every source except the explicit fixture edit");
    }
    console.log("Company restart API: identical-byte source replacement reuses all closed months with zero heavy reads; a real edit refreshes only its company/month; source bytes and unaffected monthly files preserved; zero external requests passed");
  } finally {
    if (activeChild) { activeChild.kill(); if (activeChild.exitCode === null) await once(activeChild, "exit"); }
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
