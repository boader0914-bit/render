"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fault = code => Object.assign(new Error(code), {code, statusCode:409});
async function exists(file) { try {await fs.lstat(file); return true;} catch(e) {if(e.code === "ENOENT") return false; throw e;} }
async function regular(file, directory = false) {
  const s = await fs.lstat(file);
  if(s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw fault("COLLECTOR_ARTIFACT_INVALID");
  return s;
}

// No collection execution or network access. Only the known empty-region
// mismatch is eligible, and original files and execution receipts are retained.
async function recoverRetainedWebResult({base,destinationRoot,request,expected,retainedJobDirectory,manifestSha256,validateOutputs,checkedTree,assertIdle}) {
  if(!/^job-[a-zA-Z0-9]{6}$/.test(retainedJobDirectory || "") || !/^[a-f0-9]{64}$/.test(manifestSha256 || "")) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  if(request.workerKey !== "web" || request.trigger !== "manual" || !(request.status === "failed" && request.errorCode === "COLLECTOR_SCOPE_MISMATCH"
    || request.status === "complete" && request.recovery?.originalErrorCode === "COLLECTOR_SCOPE_MISMATCH")) throw fault("COLLECTOR_RECOVERY_NOT_ELIGIBLE");
  const required = ["keyword","checkIn","checkOut","adults","searchMode","searchIntent","searchRegion","searchScope","collectionMode","collectionPurpose","productMode","dayUseMode","bookingRangeDays","bookingRangePlaceLimit","detailRankRanges","sourceRole","collectionSource","workerKey","trigger","scheduledCollection"];
  if(required.some(k => expected[k] === undefined) || expected.keyword !== request.keyword || expected.workerKey !== "web" || expected.trigger !== "manual"
    || expected.scheduledCollection !== false || expected.sourceRole !== "admin" || expected.collectionSource !== "admin_search"
    || expected.searchMode !== "keyword" || expected.searchIntent !== "keyword" || expected.searchScope !== "keyword" || expected.searchRegion !== "") throw fault("COLLECTOR_RECOVERY_SCOPE_REQUIRED");
  const sourceRoot = path.join(base, retainedJobDirectory), sourceOutputs = path.join(sourceRoot, "outputs");
  await regular(base,true); await regular(sourceRoot,true); await regular(sourceOutputs,true);
  const entries = await fs.readdir(sourceOutputs);
  if(entries.length !== 1 || !/^[a-z0-9][a-z0-9_-]*_glamping_\d{8}_\d{6}$/.test(entries[0])) throw fault("COLLECTOR_ARTIFACT_INVALID");
  const runId = entries[0], directory = path.join(sourceOutputs,runId), manifestFile = path.join(directory,"manifest.json");
  await regular(directory,true);
  if((await regular(manifestFile)).size > 1024*1024) throw fault("COLLECTOR_INVALID_MANIFEST");
  const originalBytes = await fs.readFile(manifestFile);
  if(hash(originalBytes) !== manifestSha256) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  const source = JSON.parse(originalBytes);
  const stripped = expected.keyword.replace(/\s+/g,"").replace(/(오토캠핑장|카라반캠핑장|글램핑장|캠핑장|야영장|풀빌라|카라반|글램핑|펜션|리조트|호텔|모텔|캠핑|스테이|숙박|숙소)$/u,"");
  if(!stripped || stripped === expected.keyword.replace(/\s+/g,"") || source.searchRegion !== stripped
    || !/^[a-p]{24}$/.test(source.collectorRunToken || "") || !/^[a-zA-Z0-9_-]{1,160}$/.test(source.jobId || "")) throw fault("COLLECTOR_SCOPE_MISMATCH");
  const finished = request.recovery?.originalFinishedAt || request.finishedAt;
  if(!Number.isFinite(Date.parse(source.collectedAt)) || Date.parse(source.collectedAt) < Date.parse(request.createdAt)
    || Date.parse(source.collectedAt) > Date.parse(finished) + 1000) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  const env = {RUN_STAMP:runId.slice(-15),COLLECTOR_TRIGGER:"manual",DETAIL_RANK_RANGES:expected.detailRankRanges};
  const validated = await validateOutputs(sourceOutputs,expected.keyword,env,expected,source.jobId,source.collectorRunToken,0,true);
  if(validated.quality.status !== "complete" || source.collectionFailed || source.requestPacing.stopped) throw fault("COLLECTOR_RECOVERY_QUALITY_HOLD");
  const descriptors = [];
  for(const f of validated.files) descriptors.push({path:f.name,size:f.size,sha256:hash(await fs.readFile(path.join(directory,f.name)))});
  const recoveryRoot = path.join(base,"recovery");
  await fs.mkdir(recoveryRoot,{recursive:true,mode:0o700}); await regular(recoveryRoot,true);
  const receiptRoot = path.join(recoveryRoot,request.requestId);
  await fs.mkdir(receiptRoot,{recursive:true,mode:0o700}); await regular(receiptRoot,true);
  const sourceReceipt = {version:1,requestId:request.requestId,jobId:source.jobId,originalErrorCode:"COLLECTOR_SCOPE_MISMATCH",originalFinishedAt:finished,
    retainedJobDirectory,manifestSha256,files:descriptors,expected};
  const receiptFile = path.join(receiptRoot,"source.json");
  if(await exists(receiptFile)) {
    await regular(receiptFile);
    if(!isDeepStrictEqual(JSON.parse(await fs.readFile(receiptFile,"utf8")),sourceReceipt)) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  } else await fs.writeFile(receiptFile,JSON.stringify(sourceReceipt,null,2),{flag:"wx",mode:0o600});
  const outputDir = path.join(destinationRoot,runId);
  let manifest = {...source,searchRegion:"",outputDir,collectionQuality:validated.quality};
  await fs.mkdir(destinationRoot,{recursive:true}); await regular(destinationRoot,true);
  if(await exists(outputDir)) {
    await regular(outputDir,true); await regular(path.join(outputDir,"manifest.json"));
    const old = JSON.parse(await fs.readFile(path.join(outputDir,"manifest.json"),"utf8"));
    if(old.recovery?.requestId !== request.requestId || old.recovery?.originalManifestSha256 !== manifestSha256) throw fault("COLLECTOR_RUN_ALREADY_EXISTS");
    manifest.recovery = old.recovery;
    if(!isDeepStrictEqual(old,manifest)) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  } else {
    const disk = await fs.statfs(base);
    if(Number(disk.bavail)*Number(disk.bsize) <= descriptors.reduce((s,f)=>s+f.size,0)+200*1024*1024) throw fault("COLLECTOR_DISK_LOW");
    manifest.recovery = {version:1,requestId:request.requestId,jobId:source.jobId,recoveredAt:new Date().toISOString(),method:"reviewed-empty-search-region",
      originalManifestSha256:manifestSha256,originalSearchRegion:source.searchRegion,requestedSearchRegion:"",originalErrorCode:"COLLECTOR_SCOPE_MISMATCH"};
    const candidate = await fs.mkdtemp(path.join(receiptRoot,"candidate-"));
    for(const f of descriptors) {
      const target = path.join(candidate,f.path); await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(directory,f.path),target,constants.COPYFILE_EXCL);
      if(hash(await fs.readFile(target)) !== f.sha256) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
    }
    await fs.writeFile(path.join(candidate,"manifest.json"),JSON.stringify(manifest,null,2));
    // Recheck source bytes before atomic publication. Never move the source evidence.
    for(const f of descriptors) if(hash(await fs.readFile(path.join(directory,f.path))) !== f.sha256) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
    assertIdle();
    if(await exists(outputDir)) throw fault("COLLECTOR_RUN_ALREADY_EXISTS");
    await fs.rename(candidate,outputDir);
  }
  const publishedFiles = await checkedTree(outputDir);
  if(publishedFiles.length !== descriptors.length) throw fault("COLLECTOR_FILE_SET_MISMATCH");
  for(const f of descriptors.filter(f=>f.path !== "manifest.json")) {
    if(hash(await fs.readFile(path.join(outputDir,f.path))) !== f.sha256) throw fault("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
  }
  return {runId,outputDir,manifest,collectionQuality:validated.quality,recovery:manifest.recovery};
}
module.exports = {recoverRetainedWebResult};
