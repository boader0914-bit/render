"use strict";
// Only a bounded, already-saved public keyword receipt is copied. No application
// bootstrap, credentials, original lodging rows, providers or KOSIS are loaded.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createSearchDemandStore } = require("./lib/search_demand_store.cjs");
const { normalizeSearchAdSnapshot, dayFromIso } = require("./lib/search_demand_model.cjs");
const { createSearchDemandService } = require("./lib/search_demand_service.cjs");
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
const need = (v, code) => { if (!v) throw Object.assign(new Error(code), { code }); };
const identity = s => [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(":");
async function readReceipt(file) {
  const resolved = path.resolve(file), parsed = path.parse(resolved); let at=parsed.root;
  for(const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean).slice(0,-1)) { at=path.join(at,part);const s=await fs.lstat(at);need(s.isDirectory()&&!s.isSymbolicLink()&&await fs.realpath(at)===path.resolve(at),"COPY_SOURCE_UNSAFE_PARENT"); }
  const before=await fs.lstat(resolved);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=65536,"COPY_SOURCE_BOUNDS");
  const handle=await fs.open(resolved,native.constants.O_RDONLY|(native.constants.O_NOFOLLOW||0));let bytes;
  try { need(identity(before)===identity(await handle.stat()),"COPY_SOURCE_CHANGED");bytes=await handle.readFile();need(bytes.length<=65536&&identity(before)===identity(await handle.stat()),"COPY_SOURCE_CHANGED"); }finally{await handle.close();}
  need(identity(before)===identity(await fs.lstat(resolved)),"COPY_SOURCE_CHANGED");
  const r=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  need(r.status==="verified"&&r.httpStatus===200&&r.exactMatchCount===1&&r.result?.exactMatch===true&&r.keyword===r.result.keyword&&r.result.returnedKeyword===r.keyword,"COPY_RECEIPT_NOT_EXACT_VERIFIED");
  const pc=r.result.monthlyPc,mobile=r.result.monthlyMobile,total=r.result.totalSearchVolume;
  need(pc?.state==="reported_number"&&mobile?.state==="reported_number"&&[pc.value,mobile.value,total?.value].every(v=>Number.isSafeInteger(v)&&v>=0)&&pc.value+mobile.value===total.value,"COPY_RECEIPT_COUNTS_UNVERIFIED");
  need(typeof r.responseObservedAt==="string"&&Number.isFinite(Date.parse(r.responseObservedAt))&&/^20\d{2}/.test(r.responseObservedAt),"COPY_RECEIPT_TIME_UNVERIFIED");
  return { receiptBytes:bytes.length,receiptSha256:hash(bytes),keyword:r.keyword,observedAt:r.responseObservedAt,
    pc:pc.value,mobile:mobile.value,total:total.value,originalReturnedRows:r.returnedKeywordCount,
    sourceResponseSha256:r.responseSha256,requestCount:r.requestCount };
}
async function tree(directory) {
  const rows={};
  async function walk(dir){let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==="ENOENT")return;throw e;}
    for(const item of entries){const file=path.join(dir,item.name);if(item.isDirectory())await walk(file);else{const s=await fs.stat(file);rows[path.relative(directory,file)]=[s.size,s.mtimeMs,hash(await fs.readFile(file))];}}}
  await walk(directory);return rows;
}
async function validateRealcopy({receiptPath,outputDir}) {
  const source=await readReceipt(receiptPath), output=path.resolve(outputDir);
  need(output!==path.parse(output).root&&output!==path.resolve(__dirname,"..")&&output.length>15,"COPY_OUTPUT_UNSAFE");
  try{await fs.lstat(output);throw Object.assign(new Error(),{code:"COPY_OUTPUT_EXISTS"});}catch(e){if(e.code!=="ENOENT")throw e;}
  await fs.mkdir(output,{recursive:true});
  const clock=()=>Date.parse(source.observedAt)+1000;
  const store=createSearchDemandStore({rootDir:path.join(output,"store"),clock});
  const snapshot=normalizeSearchAdSnapshot({keyword:source.keyword,observedAt:source.observedAt,scopeId:"saved-public-receipt-copy",keywordList:[{relKeyword:source.keyword,monthlyPcQcCnt:source.pc,monthlyMobileQcCnt:source.mobile}]});
  const first=await store.saveSnapshot(snapshot), repeated=await store.saveSnapshot(snapshot);
  const service=createSearchDemandService({store,clock,readRegisteredKeywords:async()=>[source.keyword]});
  const day=dayFromIso(source.observedAt), input={keyword:source.keyword,day,month:day.slice(0,7)};
  const before=await tree(path.join(output,"store"));
  const analysis=await service.analyze(input), report=await service.report({...input,cadence:"daily"}), monthly=await service.report({...input,cadence:"monthly"}), csv=await service.report({...input,cadence:"daily",format:"csv"});
  const after=await tree(path.join(output,"store"));
  const checks={exactKeyword:analysis.selection.keyword===source.keyword,pc:analysis.searchVolume.anchor.monthlyPc.value===source.pc,mobile:analysis.searchVolume.anchor.monthlyMobile.value===source.mobile,total:analysis.searchVolume.anchor.total.value===source.total,
    originalTime:analysis.searchVolume.observedAt===source.observedAt,repeatedSnapshotReused:repeated.reused===true,oneObservation:analysis.related.total===1,
    missingTrend:analysis.trend.status==="missing",forecastHeld:analysis.forecast.value===null,missingChanges:analysis.comparisons.day.percent===null,
    dailyReportMatches:report.rows.length===1&&report.rows[0].total.value===source.total,monthlyRepresentativeMatches:monthly.summary.representative?.total.value===source.total,
    noObservationDaySum:monthly.scope.noSummationAcrossObservationDays===true,csvMatches:csv.csv.includes(String(source.total)),readOnlyFootprint:JSON.stringify(before)===JSON.stringify(after),providerCallsZero:analysis.networkAttempted===false&&report.networkAttempted===false};
  need(Object.values(checks).every(Boolean),"COPY_VALIDATION_FAILED");
  const provenance={kind:"saved_exact_keyword_receipt_subset",sourceReceiptSha256:source.receiptSha256,sourceReceiptBytes:source.receiptBytes,sourceResponseSha256:source.sourceResponseSha256,
    sourceObservedAt:source.observedAt,sourceProviderReturnedRows:source.originalReturnedRows,copiedNormalizedRows:1,fullRelatedListPreserved:false,fullRelatedRealcopyVerified:false,
    limitations:["앞선 실제 경남글램핑 정확 키워드 한 행의 사본만 대조했습니다.","원 응답의 861행 목록이 보관되지 않아 실제 연관어 전체 명세·중복 수는 검증하지 않았습니다.","전체 연관어·트렌드·장애 처리는 별도 모의 응답 테스트로 검증하며 실제 12개월 전망 수치를 만들지 않았습니다."]};
  const proof={schemaVersion:1,status:"verified_exact_row_copy",keyword:source.keyword,day,checks,scope:provenance,operations:{providerCalls:0,productionReads:0,productionWrites:0,credentialsOrEnvironmentReads:0,kosisReads:0},snapshotId:first.snapshotId};
  for(const [name,value]of [["analysis.json",analysis],["daily-report.json",report],["monthly-report.json",monthly],["provenance.json",provenance],["validation.json",proof]])await fs.writeFile(path.join(output,name),JSON.stringify(value,null,2),{flag:"wx"});
  await fs.writeFile(path.join(output,"daily-report.csv"),"\ufeff"+csv.csv,{flag:"wx"});
  return proof;
}
if(require.main===module){const args=process.argv.slice(2);if(args.length!==4||args[0]!=="--receipt"||args[2]!=="--output")throw Error("Usage: --receipt <saved-safe-receipt> --output <new-copy-directory>");validateRealcopy({receiptPath:args[1],outputDir:args[3]}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.code||"COPY_VALIDATION_UNAVAILABLE");process.exitCode=1;});}
module.exports={validateRealcopy,readReceipt};
