"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { seedMonthlyReportFixture } = require("./fixtures/monthly_report_fixture.cjs");
const { seedMonthlyReportOutlookEvaluation } = require("./fixtures/monthly_report_outlook_evaluation_fixture.cjs");

async function savedTree(directory) {
  const files = {};
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files[path.relative(directory, file)] = await fs.readFile(file, "utf8");
    }
  }
  await walk(directory);
  return files;
}

function assertEvaluation(context, saved, actualValue = 0) {
  assert.ok(context, "monthly reports must include their saved forecast-evaluation context");
  assert.equal(context.schemaVersion, 1);
  assert.equal(context.reportMonth, "2026-08");
  assert.equal(context.cutoffDate, "2026-08-31");
  assert.equal(context.temporalBasis, "saved_evaluation_at_report_creation");
  assert.equal(context.selectionBasis, "target_month");
  assert.equal(context.networkAttempted, false);
  assert.ok(Number.isFinite(Date.parse(context.asOfAt)), "evaluation verification time is separate from the August reservation cutoff");
  assert.equal(context.regions.length, 1);
  const region = context.regions[0];
  assert.equal(region.regionKey, saved.scope.regionKey);
  assert.equal(region.source.resultId, saved.resultId);
  assert.equal(region.source.generatedAt, saved.generatedAt);
  assert.equal(region.source.evaluatedThrough, saved.evaluatedThrough);
  assert.equal(region.source.evaluationScopeMonth, saved.scope.month);
  assert.deepEqual(region.summaryCounts, { total: 4, compared: 2, pending: 1, excluded: 1 });
  assert.equal(region.rows.length, 4);
  assert.ok(region.rows.every(row => row.targetPeriod === "2026-08"), "report selection uses forecast target month, not issue month");
  assert.deepEqual(region.rows.filter(row => row.status === "compared").map(row => row.issueMonth).sort(), ["2026-07", "2026-08"]);
  for (const row of region.rows.filter(row => row.status === "compared")) {
    assert.equal(row.actualValue, actualValue, "normal official zero remains a real numeric outcome");
    assert.ok(Number.isFinite(row.absoluteError));
    if (actualValue === 0) assert.equal(row.errorPct, null, "a zero denominator is not a zero-percent error");
  }
  for (const row of region.rows.filter(row => row.status !== "compared")) {
    assert.equal(row.actualValue, null, "pending or rejected source zero must remain unknown");
    assert.equal(row.absoluteError, null);
    assert.ok(row.reasonLabel);
  }
  assert.ok(region.reasonCounts.some(reason => reason.code === "OFFICIAL_PUBLICATION_PENDING" && reason.count === 1 && reason.label));
  assert.ok(region.reasonCounts.some(reason => reason.code === "UNIT_MISMATCH" && reason.count === 1 && reason.label));
  assert.equal(region.truncated, false);
}

function previewOptions(args) {
  const options = { preview: false, artifactDir: "" };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--preview") options.preview = true;
    else if (args[index] === "--artifact-dir") {
      const value = args[++index];
      if (!value || !path.isAbsolute(value)) throw new Error("--artifact-dir requires an absolute output directory");
      options.artifactDir = path.resolve(value);
    } else throw new Error(`Unknown test option: ${args[index]}`);
  }
  return options;
}

async function waitForPreviewStop(child) {
  // Keep a plain Windows pipe session controllable without a visible console.
  // SIGINT/SIGTERM and a piped "exit"/"stop" line all return through finally,
  // which stops this isolated child before removing its temporary fixture.
  await new Promise((resolve, reject) => {
    const finish = error => {
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
      process.stdin.off("data", onInput); process.stdin.pause(); child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onSignal = () => finish();
    const onInput = chunk => { if (/^(?:exit|stop)\s*$/i.test(String(chunk)) || String(chunk).includes("\u0003")) finish(); };
    const onExit = () => finish(new Error("Synthetic preview server exited before preview was stopped"));
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    process.stdin.on("data", onInput); process.stdin.resume(); child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function main() {
  const options = previewOptions(process.argv.slice(2));
  const root = path.resolve(__dirname, "..");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-api-"));
  const fixture = await seedMonthlyReportFixture(dataDir, { includePreviousMonth: true });
  const socket = net.createServer().listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const preload = path.join(dataDir, "no-network.cjs");
  const networkMarker = path.join(dataDir, "provider-request-attempted.txt");
  await fs.writeFile(preload, `global.fetch = async () => { require('node:fs').appendFileSync(${JSON.stringify(networkMarker)}, 'attempt\\n'); throw new Error('Provider requests forbidden during report validation'); };\n`);
  let output = "";
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "scripts/glamping_app_server.cjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, OUTPUTS_DIR: path.join(dataDir, "outputs"), CONFIG_DIR: path.join(dataDir, "config"),
      RENDER: "", RENDER_EXTERNAL_URL: "", SEED_OUTPUTS_FROM_REPO: "0", MASTER_DB_WRITE_MODE: "off", COLLECTOR_EXECUTION_MODE: "local",
      GLAMPING_ADMIN_USER: "monthly-admin", GLAMPING_ADMIN_PASSWORD: "monthly-test-password", GLAMPING_B2B_ENABLED: "1",
      GLAMPING_B2B_USER: "monthly-member", GLAMPING_B2B_PASSWORD: "monthly-test-password",
      TOURISM_VISITOR_MONTHLY_SYNC_ENABLED: "0", TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED: "0", KOSIS_API_KEY: "" }
  });
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  async function request(route, cookie = "", method = "GET", body, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("content-type")?.includes("application/pdf")) return { status: response.status, response, data: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, response, data: await response.json() };
  }
  const login = async username => { const result = await request("/api/login", "", "POST", { username, password: "monthly-test-password" }); assert.equal(result.status, 200); return result.response.headers.get("set-cookie").split(";")[0]; };
  try {
    let ready = false;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw new Error("Server did not start: " + output);
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const endpoint = "/api/monthly-reports";
    assert.equal((await request(endpoint)).status, 401);
    const member = await login("monthly-member");
    assert.equal((await request(endpoint + "/options", member)).status, 403);
    assert.equal((await request(endpoint, member, "POST", {})).status, 403);
    const admin = await login("monthly-admin");
    const opts = await request(endpoint + "/options", admin);
    assert.equal(opts.status, 200); assert.ok(opts.data.months.includes("2026-08"));
    const regionKey = opts.data.companies.find(company => company.id === fixture.companyId)?.regionKey;
    assert.ok(regionKey, "fixture company must resolve to an actual catalog region");
    const condition = { type: "company", targetId: fixture.companyId, month: "2026-08", cutoffDate: "2026-08-31" };
    assert.equal((await request(endpoint + "/preview", admin, "POST", condition, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await request(endpoint + "/preview", admin, "POST", condition, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await request(endpoint + "/preview", admin, "POST", { ...condition, month: "2026-13" })).status, 400);
    const missingEvaluation = await request(endpoint + "/preview", admin, "POST", condition);
    assert.equal(missingEvaluation.status, 200);
    assert.equal(missingEvaluation.data.context.outlookEvaluations.regions[0].summaryCounts, null, "a missing saved evaluation is not zero evaluated forecasts");
    assert.ok(missingEvaluation.data.context.outlookEvaluations.regions[0].reasonLabel);
    const savedEvaluation = await seedMonthlyReportOutlookEvaluation(dataDir, regionKey);
    const evaluationDirectory = path.join(dataDir, "regional_outlook_evaluation");
    const evaluationFiles = await savedTree(evaluationDirectory);
    const preview = await request(endpoint + "/preview", admin, "POST", condition);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.summary.lodging.coveredCompanyDays, 31, JSON.stringify(preview.data.quality));
    assert.equal(preview.data.summary.lodging.supply, 310);
    assert.ok(preview.data.previewToken);
    assert.equal(preview.data.comparison.previousMonth, "2026-07");
    assert.equal(preview.data.comparison.common.companyCount, 1);
    assert.equal(preview.data.comparison.common.matched.deltas.sold, 31);
    assertEvaluation(preview.data.context.outlookEvaluations, savedEvaluation);
    const keywordPreview = await request(endpoint + "/preview", admin, "POST", { ...condition, type: "keyword", targetId: "포천글램핑" });
    assert.equal(keywordPreview.status, 200);
    assert.equal(keywordPreview.data.comparison.all.current.companyCount, 2);
    assert.equal(keywordPreview.data.comparison.all.previous.companyCount, 1);
    assert.deepEqual(keywordPreview.data.comparison.newlyObservedCompanyIds, ["cmp_place_monthly_b"]);
    assert.equal(keywordPreview.data.comparison.common.matched.deltas.sold, 31, "new company's sales never inflate common-company movement");
    assert.equal(keywordPreview.data.insights.overview.totalRooms, 18, "physical room basis is not the monthly room-night total");
    assert.equal(keywordPreview.data.insights.overview.collectionDateCount, 2);
    assert.equal(keywordPreview.data.insights.pricing.lodging.companyDistribution.companyCount, 2);
    assert.equal(keywordPreview.data.insights.pickup.lodging.public.increase, 34);
    assert.equal(keywordPreview.data.insights.rankVisibility.rows[0].observedDays, 2, "31 stay dates do not become 31 search observations");
    assert.equal(keywordPreview.data.insights.calendarGroups.status, "unavailable", "missing holiday cache is not ordinary-weekday evidence");
    assertEvaluation(keywordPreview.data.context.outlookEvaluations, savedEvaluation);
    const regionPreview = await request(endpoint + "/preview", admin, "POST", { ...condition, type: "region", targetId: regionKey });
    assert.equal(regionPreview.status, 200);
    assertEvaluation(regionPreview.data.context.outlookEvaluations, savedEvaluation);
    const nonTargetMonth = await request(endpoint + "/preview", admin, "POST", { ...condition, month: "2026-07", cutoffDate: "2026-07-31" });
    assert.equal(nonTargetMonth.status, 200);
    assert.deepEqual(nonTargetMonth.data.context.outlookEvaluations.regions[0].summaryCounts, { total: 0, compared: 0, pending: 0, excluded: 0 }, "a valid saved evaluation with no matching target month has no report samples");
    assert.equal(nonTargetMonth.data.context.outlookEvaluations.regions[0].reasonCode, "NO_TARGET_MONTH_FORECAST");
    assert.equal(nonTargetMonth.data.context.outlookEvaluations.regions[0].rows.length, 0);
    assert.ok(nonTargetMonth.data.context.outlookEvaluations.regions[0].reasonLabel);
    assert.deepEqual(await savedTree(evaluationDirectory), evaluationFiles, "report previews only read saved evaluation files; they cannot queue or recalculate evaluations");
    const create = await request(endpoint, admin, "POST", { ...condition, previewToken: preview.data.previewToken, title: "[모의] 8월 월간 리포트", notes: "검수용 가상 자료입니다." });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    assert.deepEqual(create.data.snapshot.context.outlookEvaluations, preview.data.context.outlookEvaluations, "saving a preview preserves the preview's evaluation evidence exactly");
    const reportUrl = endpoint + "/" + create.data.id;
    assert.equal((await request(reportUrl + "/pdf", admin)).status, 409);
    assert.equal((await request(reportUrl + "/publish", admin, "POST", { revision: 1, acknowledgeQuality: true })).status, 409);
    const review = await request(reportUrl, admin, "PATCH", { revision: 1, status: "review" });
    assert.equal(review.status, 200);
    assert.equal((await request(reportUrl, admin, "PATCH", { revision: 1, notes: "stale" })).status, 409);
    const published = await request(reportUrl + "/publish", admin, "POST", { revision: review.data.revision, acknowledgeQuality: true });
    assert.equal(published.status, 200); assert.equal(published.data.status, "published");
    assertEvaluation(published.data.snapshot.context.outlookEvaluations, savedEvaluation);
    assert.equal((await request(reportUrl, admin, "PATCH", { revision: published.data.revision, notes: "overwrite" })).status, 409);
    const pdf = await request(reportUrl + "/pdf", admin);
    assert.equal(pdf.status, 200, String(pdf.data)); assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.response.headers.get("content-disposition").includes("attachment"));
    assert.deepEqual((await request(reportUrl + "/pdf", admin)).data, pdf.data, "issued PDF bytes stay fixed");
    const correctedEvaluation = await seedMonthlyReportOutlookEvaluation(dataDir, regionKey, { actualValue: 120 });
    assert.notEqual(correctedEvaluation.resultId, savedEvaluation.resultId);
    assert.deepEqual((await request(reportUrl, admin)).data.snapshot, published.data.snapshot, "new official evaluation evidence never mutates an issued report");
    assert.deepEqual((await request(reportUrl + "/pdf", admin)).data, pdf.data, "source changes never regenerate an issued PDF");
    const revision = await request(reportUrl + "/revise", admin, "POST", { revision: published.data.revision });
    assert.equal(revision.status, 201); assert.equal(revision.data.version, 2); assert.notEqual(revision.data.id, create.data.id);
    assert.deepEqual(revision.data.snapshot.context.outlookEvaluations, published.data.snapshot.context.outlookEvaluations, "a revision starts with the issued evidence until explicitly rebuilt");
    const rebuilt = await request(endpoint + "/" + revision.data.id + "/rebuild", admin, "POST", { revision: revision.data.revision });
    assert.equal(rebuilt.status, 200); assert.equal(rebuilt.data.status, "draft");
    assertEvaluation(rebuilt.data.snapshot.context.outlookEvaluations, correctedEvaluation, 120);
    assert.deepEqual((await request(reportUrl, admin)).data.snapshot, published.data.snapshot);
    const list = await request(endpoint, admin);
    assert.equal(list.data.reports.length, 2);
    assert.equal((await request(endpoint + "/not-an-id", admin)).status, 400);
    assert.equal((await request(reportUrl + "/pdf", member)).status, 403);
    assert.equal(await fs.stat(networkMarker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false, "monthly-report creation, evaluation read and PDF rendering never attempted a provider fetch");
    console.log("Monthly reports API: authorization, source adapter, saved target-month evaluations, true zero versus pending, preview/draft/review/publication, conflicts, unchanged source files, immutable PDF and updated revised draft passed");
    if (options.artifactDir) {
      await fs.mkdir(options.artifactDir, { recursive: true });
      await fs.writeFile(path.join(options.artifactDir, "monthly-report-evaluation.json"), JSON.stringify({
        synthetic: true, artifactPurpose: "Local monthly report evaluation QA using synthetic fixtures only", ...published.data
      }, null, 2) + "\n");
      await fs.writeFile(path.join(options.artifactDir, "monthly-report-evaluation.pdf"), pdf.data);
    }
    if (options.preview) {
      console.log(`LOCAL_PREVIEW_URL=${base}/admin`);
      console.log("SYNTHETIC_LOCAL_LOGIN=monthly-admin / monthly-test-password");
      console.log("SYNTHETIC_DATA_ONLY=true; stop with SIGINT/SIGTERM or a piped exit line");
      await waitForPreviewStop(child);
      assert.equal(await fs.stat(networkMarker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false, "local browser QA must not attempt a provider fetch");
    }
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, "exit");
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
