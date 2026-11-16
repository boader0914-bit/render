"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const I = require("./lib/fixed_b3_maintenance_details.cjs"), hash = value => crypto.createHash("sha256").update(value).digest("hex");
const CONTEXT = { bootId: "synthetic_context_not_printable", pidNamespace: "synthetic_namespace_not_printable", hostId: "synthetic_host_not_printable" }, TOKEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const appSource = require("node:fs").readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const KNOWN_GUARD = "c12d01111b959d1c54a22a04b46c2f12602d557039eb3d8d60b836c42cf0ced8";
async function fixture(t, sameContext = false) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspect-b3-readonly-")), codeRoot = path.join(dataDir, "synthetic-code"), release = path.join(dataDir, "operations", I.EXPECTED_B3.release), incremental = path.join(dataDir, "keyword_monthly_incremental");
  for (const directory of [codeRoot, release, incremental, path.join(dataDir, "keyword_monthly_analysis")]) await fs.mkdir(directory, { recursive: true });
  t.after(async () => { assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith("inspect-b3-readonly-")); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = { operationId: I.EXPECTED_B3.operation, dataDir, codeRoot: path.join(release, "code"), fixedClock: "2026-11-16T04:46:00.000Z", expectedPointerSha256: "1".repeat(64) }, requestBytes = Buffer.from(JSON.stringify(request)), runner = Buffer.from("synthetic frozen runner");
  const marker = { schemaVersion: 1, kind: "keyword_prepared_conversion_maintenance", token: TOKEN, pid: 42, createdAt: request.fixedClock, operationId: I.EXPECTED_B3.operation, mode: "stage", contextSha256: sameContext ? hash(JSON.stringify(CONTEXT)) : "9".repeat(64) };
  await fs.writeFile(path.join(release, "b3-request-stage.json"), requestBytes); await fs.writeFile(path.join(release, "rebuild-reviewed-monthly-publish-v4.cjs"), runner);
  const markerFile = path.join(incremental, "prepared-conversion-lock.json"); await fs.writeFile(markerFile, JSON.stringify(marker), { mode: 0o600 });
  await fs.writeFile(path.join(incremental, "source-current.json"), JSON.stringify({ stateSha256: "2".repeat(64) })); await fs.writeFile(path.join(dataDir, "keyword_monthly_analysis/current.json"), JSON.stringify({ generation: "3".repeat(32) }));
  const procRoot = path.join(dataDir, "synthetic-proc"), deps = { fixture: true, requestSha256: hash(requestBytes), runnerSha256: hash(runner), contextReader: async () => CONTEXT, ownershipPolicySatisfied: true, procRoot };
  return { dataDir, codeRoot, release, marker, markerFile, deps, procRoot };
}
test("exact B3 marker before operation/job directory creation is inspectable without touching different-context PIDs", async t => {
  const f = await fixture(t), before = await fs.readFile(f.markerFile), value = await I.inspectB3Maintenance(f, f.deps);
  assert.equal(value.exactOpMatch, true); assert.equal(value.fixedRequestShaMatch, true); assert.equal(value.fixedRunnerShaMatch, true); assert.equal(value.marker.schemaValidity, true);
  assert.equal(value.currentContextSha256, hash(JSON.stringify(CONTEXT))); assert.equal(value.contextDiffers, true); assert.equal(value.ownerProcess, "not_read_context_differs");
  assert.equal(value.operationDirectoryPresent, false); assert.equal(value.jobDirectoryPresent, false); assert.equal(value.files.preparationComplete.present, false);
  assert.equal(value.bindings.frozenRequestOperation, true); assert.equal(value.exactOperationAdmission, true);
  assert.equal(value.retirementAuthorized, false); assert.equal(value.cmdlineRead, false); assert.equal(value.environmentRead, false); assert.equal(value.pointersReadTwiceStable, true);
  assert.equal((await fs.readFile(f.markerFile)).equals(before), true);
  const text = JSON.stringify(value); for (const secret of [TOKEN, ...Object.values(CONTEXT)]) assert.equal(text.includes(secret), false);
});
test("foreign operation cannot inspect owner or optional job proof metadata", async t => {
  const f = await fixture(t, true); await fs.writeFile(f.markerFile, JSON.stringify({ ...f.marker, operationId: TOKEN }));
  const job = path.join(f.dataDir, "keyword_monthly_incremental/jobs/refresh-job-" + I.EXPECTED_B3.operation); await fs.mkdir(job, { recursive: true }); await fs.writeFile(path.join(job, "job-input.json"), Buffer.alloc(I.LIMITS.jobInput + 1));
  const value = await I.inspectB3Maintenance(f, f.deps); assert.equal(value.status, "held"); assert.equal(value.exactOperationAdmission, false);
  assert.equal(value.ownerProcess, "not_read_exact_operation_unverified"); assert.equal(value.contextDiffers, null); assert.equal(Object.hasOwn(value.marker, "pid"), false);
  assert.equal(Object.hasOwn(value.marker, "mode"), false); assert.equal(Object.hasOwn(value.marker, "createdAt"), false); assert.equal(value.files.jobInput.contentRead, false);
});
test("frozen pin mismatch cannot inspect owner or optional proof metadata", async t => {
  const f = await fixture(t, true); await fs.appendFile(path.join(f.release, "rebuild-reviewed-monthly-publish-v4.cjs"), "changed");
  const value = await I.inspectB3Maintenance(f, f.deps); assert.equal(value.fixedRunnerShaMatch, false); assert.equal(value.exactOperationAdmission, false);
  assert.equal(value.ownerProcess, "not_read_exact_operation_unverified"); assert.equal(value.childProcess, "not_read_exact_operation_unverified"); assert.equal(Object.hasOwn(value.marker, "pid"), false);
});
test("same-context owner inspection reads only fixed PID stat comm start ticks and emits known kind/hash", async t => {
  const f = await fixture(t, true), directory = path.join(f.procRoot, "42"), fields = Array(20).fill("0"); fields[0] = "S"; fields[1] = "1"; fields[19] = "123456";
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "stat"), "42 (node) " + fields.join(" ")); await fs.writeFile(path.join(directory, "comm"), "node\n");
  const value = await I.inspectB3Maintenance(f, f.deps); assert.equal(value.contextDiffers, false); assert.equal(value.ownerProcess.state, "present_current_namespace_only");
  assert.equal(value.ownerProcess.startTicks, "123456"); assert.equal(value.ownerProcess.knownKind, "node"); assert.equal(value.ownerProcess.commSha256, hash("node"));
  assert.equal(value.ownerProcess.ownerIdentityProven, false); assert.equal(value.argumentMatching, "not_performed_privacy_hold");
});
test("same-context missing PID is namespace-limited evidence and never retirement authorization", async t => {
  const f = await fixture(t, true), value = await I.inspectB3Maintenance(f, f.deps);
  assert.equal(value.ownerProcess.state, "absent_current_namespace_only"); assert.equal(value.ownershipOrLivenessProven, false); assert.equal(value.retirementAuthorized, false);
});
test("large preparation receipts remain metadata-only holds while marker and frozen pins remain visible", async t => {
  const f = await fixture(t), directory = path.join(f.dataDir, "keyword_monthly_incremental/jobs/refresh-job-" + I.EXPECTED_B3.operation); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "preparation-complete.json"), Buffer.alloc(I.LIMITS.receipt + 1, 0x20));
  const value = await I.inspectB3Maintenance(f, f.deps); assert.equal(value.status, "held"); assert.equal(value.exactOpMatch, true);
  assert.equal(value.files.preparationComplete.tooLarge, true); assert.equal(value.files.preparationComplete.contentRead, false); assert.equal(value.files.preparationComplete.sha256, null);
});
test("marker mutation during inspection fails closed and a context hash with a newline is distinct", async t => {
  const f = await fixture(t), marker = { ...f.marker, contextSha256: hash(JSON.stringify(CONTEXT) + "\n") }; await fs.writeFile(f.markerFile, JSON.stringify(marker));
  assert.equal((await I.inspectB3Maintenance(f, f.deps)).contextDiffers, true);
  await assert.rejects(I.inspectB3Maintenance(f, { ...f.deps, beforeFinalCheck: async () => fs.appendFile(f.markerFile, " ") }), { code: "B3_INSPECT_FILE_CHANGED" });
});

function actualHook(observation,inspectDetails,logger){
  const begin=appSource.indexOf("// Fixed read-only B3 details;"),end=appSource.indexOf("// End fixed read-only B3 details;",begin);assert.ok(begin>0&&end>begin);
  const context={fixedB3Observation:observation,inspectFixedB3Details:inspectDetails,DATA_DIR:"/synthetic/data",ROOT:"/synthetic/caller-code",console:{info:logger}};
  return require("node:vm").runInNewContext("(async()=>{"+appSource.slice(begin,end)+";return true})()",context);
}
const admitted=()=>({verifiedInputs:{runner:true,request:true,fixtureOnly:false},exactExpectedOperationMatch:true,contextEqual:false,guardStat:{sha256:KNOWN_GUARD}});

test("actual phase2 hook skips missing, fixture, pin, operation, context and guard mismatches before any detailed read",async()=>{
  const values=[null];for(const edit of [v=>{v.verifiedInputs.runner=false;},v=>{v.verifiedInputs.request=false;},v=>{v.verifiedInputs.fixtureOnly=true;},v=>{v.exactExpectedOperationMatch=false;},v=>{v.contextEqual=true;},v=>{v.contextEqual=null;},v=>{v.guardStat.sha256="0".repeat(64);}]){const value=admitted();edit(value);values.push(value);}
  for(const value of values){let reads=0,logs=0;assert.equal(await actualHook(value,async()=>{reads++;},()=>{logs++;}),true);assert.equal(reads,0);assert.equal(logs,0);}
});

test("actual phase2 hook reads only the admitted fixed guard and forces read-only non-retirement envelope",async()=>{
  let reads=0;const logs=[];assert.equal(await actualHook(admitted(),async input=>{reads++;assert.deepEqual(JSON.parse(JSON.stringify(input)),{dataDir:"/synthetic/data",codeRoot:"/synthetic/caller-code"});return {status:"inspected",marker:{sha256:KNOWN_GUARD},readOnly:false,retirementAuthorized:true,ownershipOrLivenessProven:false};},(event,text)=>logs.push({event,...JSON.parse(text)})),true);
  assert.equal(reads,1);assert.equal(logs.length,1);assert.equal(logs[0].event,"application_startup_b3_details");assert.equal(logs[0].readOnly,true);assert.equal(logs[0].retirementAuthorized,false);assert.equal(logs[0].ownershipOrLivenessProven,false);
});

test("actual phase2 diagnostic failures and logger failures cannot interrupt normal guarded readiness or leak error text",async()=>{
  for(const mode of ["known","unknown","logger"]){let reads=0;const logs=[];assert.equal(await actualHook(admitted(),async()=>{reads++;if(mode!=="logger")throw Object.assign(new Error("private error /path token"),{code:mode==="known"?"B3_INSPECT_FILE_CHANGED":"PRIVATE_AUTH_VALUE"});return {marker:{sha256:KNOWN_GUARD}};},(event,text)=>{if(mode==="logger")throw Error("private logger");logs.push({event,...JSON.parse(text)});}),true);
    assert.equal(reads,1);if(mode==="logger"){assert.equal(logs.length,0);continue;}assert.equal(logs.length,1);assert.equal(logs[0].code,mode==="known"?"B3_INSPECT_FILE_CHANGED":"B3_INSPECT_UNAVAILABLE");assert.equal(logs[0].readOnly,true);assert.equal(logs[0].retirementAuthorized,false);assert.ok(!JSON.stringify(logs).includes("private")&&!JSON.stringify(logs).includes("PRIVATE_AUTH_VALUE"));}
});

test("actual phase2 hook closes a guard change between mini observation and detailed inspection",async()=>{
  const logs=[];assert.equal(await actualHook(admitted(),async()=>({marker:{sha256:"0".repeat(64)},privateProof:"must not be logged"}),(event,text)=>logs.push({event,...JSON.parse(text)})),true);
  assert.equal(logs[0].code,"B3_INSPECT_KNOWN_GUARD_CHANGED");assert.equal(logs[0].status,"held");assert.equal(logs[0].retirementAuthorized,false);assert.ok(!JSON.stringify(logs).includes("must not be logged"));
});
