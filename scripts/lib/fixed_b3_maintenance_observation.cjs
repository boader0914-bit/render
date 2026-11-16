"use strict";
// One fixed B3 owner observation only. No liveness, retirement or release proof.
const fs=require("node:fs"),p=require("node:path").posix,c=require("node:crypto");
const ROOT="/var/data",GUARD=ROOT+"/keyword_monthly_incremental/prepared-conversion-lock.json";
const RUNNER=ROOT+"/operations/identity-auto-release-20261116-0e7fbd45-dbee-446c-817a-caebdd01b3ae/rebuild-reviewed-monthly-publish-v4.cjs";
const REQUEST=ROOT+"/operations/identity-auto-release-20261116-0e7fbd45-dbee-446c-817a-caebdd01b3ae/b3-request-stage.json";
const OPERATION="ea380222-d4db-46f4-a924-bc20bee7bdc6";
const PINS={runner:"9cc93912ed9402b3d46fe1af573a5aa33d9e3cb7bd8dcee74a2de87d2f55d43e",request:"81e38b057e5c164c9b3efad42d9eb722009c2cd50451b1bec1160d358ee48f54"};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const FIELDS=["schemaVersion","kind","token","pid","createdAt","operationId","mode","contextSha256"];
const hash=b=>c.createHash("sha256").update(b).digest("hex");
const need=(x,code)=>{if(!x)throw Object.assign(new Error(code),{code});};
const identity=s=>["dev","ino","size","mtimeNs","ctimeNs","nlink","mode","uid","gid"].map(k=>String(s[k])).join(":");
const directoryIdentity=s=>["dev","ino","mode","uid","gid"].map(k=>String(s[k])).join(":");
const exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const iso=x=>typeof x==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
function contextHash(x){
  need(exact(x,["bootId","pidNamespace","hostId"])&&UUID.test(x.bootId)&&/^pid:\[\d+\]$/.test(x.pidNamespace)&&SHA.test(x.hostId),"B3_CONTEXT_UNVERIFIED");
  return hash(JSON.stringify(x));
}
async function inspect(options={}){
  const fixtureOnly=options.fixtureOnly===true;
  need(fixtureOnly||Object.keys(options).length===0,"B3_FIXTURE_OPTIONS_REQUIRED");
  need(fixtureOnly||process.platform==="linux","B3_LINUX_REQUIRED");
  const io=fixtureOnly?options.fileSystem:fs,pins=fixtureOnly?options.pins:PINS;
  need(io&&pins&&SHA.test(pins.runner)&&SHA.test(pins.request),"B3_INPUTS_INVALID");
  const readContext=fixtureOnly?options.readContext:()=>require("/opt/render/project/src/scripts/lib/keyword_monthly_worker_lock.cjs").createLinuxProcessReader().context();
  need(typeof readContext==="function","B3_CONTEXT_UNVERIFIED");const parents=new Map();
  function checked(file,max){
    need([RUNNER,REQUEST,GUARD].includes(file),"B3_PATH");let at="/";
    for(const segment of file.slice(1).split("/").slice(0,-1)){
      at=p.join(at,segment);const s=io.lstatSync(at,{bigint:true}),mode=Number(s.mode)&0o7777;
      need(s.isDirectory()&&!s.isSymbolicLink()&&io.realpathSync(at)===at&&(Number(s.uid)===0||Number(s.uid)===1000),"B3_PARENT");
      const sharedMount=at==="/var/data"&&Number(s.uid)===0&&Number(s.gid)===1000&&mode===0o2775;
      need(!(mode&0o002)&&(!(mode&0o020)||sharedMount)&&!(mode&0o5000),"B3_PARENT_MODE");
      const before=parents.get(at);need(!before||before===directoryIdentity(s),"B3_PARENT_CHANGED");parents.set(at,directoryIdentity(s));
    }
    const s=io.lstatSync(file,{bigint:true}),size=Number(s.size);
    need(s.isFile()&&!s.isSymbolicLink()&&Number(s.nlink)===1&&Number(s.uid)===1000&&(Number(s.mode)&0o7777)===0o600&&io.realpathSync(file)===file,"B3_LEAF");
    need(Number.isSafeInteger(size)&&size>0&&size<=max,"B3_SIZE");return s;
  }
  function read(file,max){
    const before=checked(file,max),flags=io.constants.O_RDONLY|io.constants.O_NOFOLLOW;need(io.constants.O_NOFOLLOW>0,"B3_NOFOLLOW");
    const fd=io.openSync(file,flags),bytes=Buffer.alloc(Number(before.size)+1);let length=0;
    try{
      need(identity(io.fstatSync(fd,{bigint:true}))===identity(before),"B3_CHANGED");
      while(length<bytes.length){const n=io.readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
      need(length===Number(before.size)&&identity(io.fstatSync(fd,{bigint:true}))===identity(before),"B3_CHANGED");
    }finally{io.closeSync(fd);}
    need(identity(checked(file,max))===identity(before),"B3_CHANGED");
    const body=bytes.subarray(0,length);return {bytes:body,stat:before,sha256:hash(body)};
  }
  const runner=read(RUNNER,512*1024),request=read(REQUEST,16*1024);
  need(runner.sha256===pins.runner&&request.sha256===pins.request,"B3_INPUT_PIN");
  const guard=read(GUARD,16*1024);let value;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(guard.bytes));}catch{throw Object.assign(new Error("B3_GUARD_JSON"),{code:"B3_GUARD_JSON"});}
  need(exact(value,FIELDS)&&value.schemaVersion===1&&value.kind==="keyword_prepared_conversion_maintenance"&&UUID.test(value.token)
    &&UUID.test(value.operationId)&&Number.isSafeInteger(value.pid)&&value.pid>0&&iso(value.createdAt)
    &&["stage","publish"].includes(value.mode)&&SHA.test(value.contextSha256),"B3_GUARD_SCHEMA");
  const currentContext=contextHash(await readContext());
  for(const [file,saved,max]of [[RUNNER,runner,512*1024],[REQUEST,request,16*1024],[GUARD,guard,16*1024]]){
    const again=read(file,max);need(again.sha256===saved.sha256&&identity(again.stat)===identity(saved.stat),"B3_CHANGED");
  }
  need(contextHash(await readContext())===currentContext,"B3_CONTEXT_CHANGED");
  const s=guard.stat;
  return {verifiedInputs:{runner:true,request:true,fixtureOnly},exactExpectedOperationMatch:value.operationId===OPERATION,pid:value.pid,mode:value.mode,createdAt:value.createdAt,
    guardStat:{bytes:Number(s.size),dev:String(s.dev),ino:String(s.ino),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),nlink:Number(s.nlink),mode:Number(s.mode)&0o7777,uid:Number(s.uid),gid:Number(s.gid),sha256:guard.sha256},
    contextEqual:value.contextSha256===currentContext};
}
module.exports={inspect,GUARD,RUNNER,REQUEST,OPERATION,PINS};
if(require.main===module)inspect().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.log(JSON.stringify({verifiedInputs:false,code:/^B3_[A-Z0-9_]+$/.test(e.code||"")?e.code:"B3_UNVERIFIED"}));process.exitCode=1;});
