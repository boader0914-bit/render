"use strict";
// Thin pinned boot adapter. Retirement authority remains in the reviewed helper.
const fs=require("node:fs"),p=require("node:path").posix,c=require("node:crypto"),{execFile}=require("node:child_process");
const DATA="/var/data",CODE="/opt/render/project/src",BASE=CODE+"/scripts/lib";
const POLICY=CODE+"/config/reviewed-b3-maintenance-retirement-20261116.json";
const SELF=BASE+"/fixed_b3_maintenance_boot_shim.cjs",HELPER=BASE+"/archive-reviewed-b3-maintenance-boot.cjs",CONTEXT=BASE+"/keyword_monthly_worker_lock.cjs",RENAME=BASE+"/rename-reviewed-b3-noreplace.py";
const OP="ea380222-d4db-46f4-a924-bc20bee7bdc6",AUDIT=DATA+"/keyword_monthly_incremental/maintenance-retirements/"+OP,GIT="/usr/bin/git",SHA=/^[a-f0-9]{64}$/;
const hash=b=>c.createHash("sha256").update(b).digest("hex"),exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});},identity=s=>["dev","ino","size","mtimeNs","ctimeNs","nlink","uid","gid","mode"].map(k=>String(s[k])).join(":");
async function runFixedB3BootRetirement({dataDir,codeRoot,policyPath,policySha256}={},dependencies={}){
  const fixture=dependencies.fixture===true;
  need(fixture||Object.keys(dependencies).length===0,"B3_BOOT_FIXTURE_REQUIRED");
  need(dataDir===DATA&&codeRoot===CODE&&policyPath===POLICY&&SHA.test(policySha256||""),"B3_BOOT_FIXED_ARGUMENTS");
  need(fixture||process.platform==="linux"&&process.getuid?.()===1000&&p.resolve(__filename)===SELF,"B3_BOOT_RUNTIME_UNVERIFIED");
  const io=fixture?dependencies.fileSystem:fs,constants=fixture?dependencies.constants:fs.constants;
  const loadModule=fixture?dependencies.loadModule:()=>require(HELPER),execute=fixture?dependencies.execFile:execFile;
  need(io&&constants&&typeof loadModule==="function"&&typeof execute==="function","B3_BOOT_DEPENDENCIES");
  const parents=new Map();
  function checked(file,max){
    need([POLICY,SELF,HELPER,CONTEXT,RENAME,GIT].includes(file),"B3_BOOT_PATH");let at="/";
    for(const part of file.slice(1).split("/").slice(0,-1)){
      at=p.join(at,part);const s=io.lstatSync(at,{bigint:true}),mode=Number(s.mode)&0o7777;
      need(s.isDirectory()&&!s.isSymbolicLink()&&io.realpathSync(at)===at&&(Number(s.uid)===0||Number(s.uid)===1000),"B3_BOOT_PARENT");
      const shared=at===DATA&&Number(s.uid)===0&&Number(s.gid)===1000&&mode===0o2775;
      need(!(mode&0o002)&&(!(mode&0o020)||shared)&&!(mode&0o5000),"B3_BOOT_PARENT_MODE");
      const stamp=["dev","ino","uid","gid","mode"].map(k=>String(s[k])).join(":");need(!parents.has(at)||parents.get(at)===stamp,"B3_BOOT_PARENT_CHANGED");parents.set(at,stamp);
    }
    const s=io.lstatSync(file,{bigint:true}),size=Number(s.size),mode=Number(s.mode)&0o7777;
    need(s.isFile()&&!s.isSymbolicLink()&&Number(s.nlink)===1&&[0,1000].includes(Number(s.uid))&&!(mode&0o7022)&&io.realpathSync(file)===file,"B3_BOOT_LEAF");
    need(Number.isSafeInteger(size)&&size>0&&size<=max,"B3_BOOT_BOUND");return s;
  }
  function read(file,max){
    const before=checked(file,max);need(constants.O_NOFOLLOW>0,"B3_BOOT_NOFOLLOW");const fd=io.openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(Number(before.size)+1);let at=0;
    try{need(identity(io.fstatSync(fd,{bigint:true}))===identity(before),"B3_BOOT_CHANGED");while(at<bytes.length){const n=io.readSync(fd,bytes,at,bytes.length-at,at);if(!n)break;at+=n;}need(at===Number(before.size)&&identity(io.fstatSync(fd,{bigint:true}))===identity(before),"B3_BOOT_CHANGED");}
    finally{io.closeSync(fd);}need(identity(checked(file,max))===identity(before),"B3_BOOT_CHANGED");return {file,stat:before,bytes:bytes.subarray(0,at),sha256:hash(bytes.subarray(0,at)),max};
  }
  const policy=read(POLICY,65536);need(policy.sha256===policySha256,"B3_BOOT_POLICY_SHA");let review;
  try{review=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(policy.bytes));}catch{need(false,"B3_BOOT_POLICY_JSON");}
  need(review?.schemaVersion===2&&exact(review.codePins,["contextModuleSha256","retirementModuleSha256","renameHelperSha256","bootShim"])
    &&["contextModuleSha256","retirementModuleSha256","renameHelperSha256"].every(k=>SHA.test(review.codePins[k]||""))
    &&exact(review.codePins.bootShim,["path","sha256"])&&review.codePins.bootShim.path===SELF&&SHA.test(review.codePins.bootShim.sha256),"B3_BOOT_CODE_POLICY");
  // Context/Python/rename first-action pins are validated by the pinned helper;
  // already_retired and a different current guard must not recheck old baselines.
  const pins=[[HELPER,review.codePins.retirementModuleSha256],[SELF,review.codePins.bootShim.sha256]];
  const reads=[policy,...pins.map(([file,sha])=>{const value=read(file,262144);need(value.sha256===sha,"B3_BOOT_CODE_SHA");return value;})];
  const recheck=()=>{for(const old of reads){const value=read(old.file,old.max);need(value.sha256===old.sha256&&identity(value.stat)===identity(old.stat),"B3_BOOT_CODE_CHANGED");}};
  recheck();const helper=loadModule(HELPER);need(typeof helper?.retireReviewedB3MaintenanceAtBoot==="function","B3_BOOT_EXPORT");recheck();
  let audit={source:"git_metadata",available:false,commit:null};
  try{
    const before=checked(GIT,64*1048576);need(Number(before.uid)===0&&(Number(before.mode)&0o111)!==0,"B3_BOOT_GIT_UNTRUSTED");
    const commit=await new Promise(resolve=>{execute(GIT,["-C",CODE,"rev-parse","--verify","HEAD"],{encoding:"utf8",env:{},cwd:CODE,timeout:1500,maxBuffer:128,windowsHide:true},(error,stdout)=>resolve(!error&&typeof stdout==="string"&&/^[a-f0-9]{40}$/.test(stdout.trim())?stdout.trim():null));});
    need(identity(checked(GIT,64*1048576))===identity(before),"B3_BOOT_GIT_CHANGED");if(commit)audit={source:"git_metadata",available:true,commit};
  }catch{} // Git is audit only, never retirement authorization.
  recheck();
  const result=await helper.retireReviewedB3MaintenanceAtBoot({dataDir:DATA,codeRoot:CODE,policyPath:POLICY,policySha256,actualCommitRuntimeAudit:audit});
  need(result&&["archived","already_retired","not_target"].includes(result.status)&&result.fixture===fixture&&!Object.hasOwn(result,"mutationState")
    &&result.actionReplayAuthorized===false&&["sourceWrites","queueWrites","configurationWrites","originalWrites"].every(k=>result[k]===0),"B3_BOOT_RESULT_UNVERIFIED");
  need(result.status!=="archived"||result.oldMarkerArchived===true&&result.newGuardPresent===false&&result.noReplace===true&&SHA.test(result.completionReceiptSha256||""),"B3_BOOT_ARCHIVE_UNVERIFIED");
  need(result.status!=="already_retired"||result.oldMarkerArchived===true&&result.baselineFreshnessRevalidated===false&&SHA.test(result.completionReceiptSha256||""),"B3_BOOT_PRIOR_AUDIT_UNVERIFIED");
  need(result.status!=="not_target"||result.normalMaintenanceProtectionRequired===true&&result.currentGuardUntouched===true,"B3_BOOT_NORMAL_PROTECTION_REQUIRED");
  recheck();
  return {status:result.status,auditRoot:AUDIT,policySha256,completionReceiptSha256:result.status==="not_target"?null:result.completionReceiptSha256,actualCommitRuntimeAudit:audit,runtimeDeploymentId:null};
}
module.exports={runFixedB3BootRetirement,PATHS:Object.freeze({dataDir:DATA,codeRoot:CODE,policyPath:POLICY,self:SELF,helper:HELPER,context:CONTEXT,rename:RENAME,git:GIT,auditRoot:AUDIT})};
