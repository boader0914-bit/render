"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),p=require("node:path").posix;
const M=require("./lib/fixed_b3_maintenance_observation.cjs"),hash=x=>crypto.createHash("sha256").update(x).digest("hex");
const appSource=require("node:fs").readFileSync(require("node:path").join(__dirname,"glamping_app_server.cjs"),"utf8");
const CTX={bootId:"11111111-1111-4111-8111-111111111111",pidNamespace:"pid:[12345]",hostId:"a".repeat(64)},TOKEN="22222222-2222-4222-8222-222222222222";
function fixture({guard={},mutate=null}={}){
  const files=new Map(),opened=new Map(),calls={context:0,reads:[],writes:0};let ino=10;
  const stat=(directory,size,mode=directory?0o755:0o600,uid=directory?0:1000)=>({dev:1n,ino:BigInt(ino++),size:BigInt(size),mtimeNs:1n,ctimeNs:1n,nlink:1n,mode:BigInt(mode),uid:BigInt(uid),gid:1000n,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false});
  for(const file of [M.RUNNER,M.REQUEST,M.GUARD]){let dir=p.dirname(file);while(dir!=="/"){if(!files.has(dir))files.set(dir,{stat:stat(true,0,dir==="/var/data"?0o2775:0o755,0)});dir=p.dirname(dir);}}
  const value={schemaVersion:1,kind:"keyword_prepared_conversion_maintenance",token:TOKEN,pid:231,createdAt:"2026-11-16T03:32:20.163Z",operationId:M.OPERATION,mode:"stage",contextSha256:hash(JSON.stringify(CTX)),...guard};
  const put=(name,body)=>{const bytes=Buffer.from(body);files.set(name,{bytes,stat:stat(false,bytes.length)});};put(M.RUNNER,"synthetic fixed runner");put(M.REQUEST,"synthetic fixed request");put(M.GUARD,JSON.stringify(value));
  const pins={runner:hash(files.get(M.RUNNER).bytes),request:hash(files.get(M.REQUEST).bytes)};
  const io={constants:{O_RDONLY:0,O_NOFOLLOW:131072},lstatSync:file=>{const x=files.get(file);if(!x)throw Error("unexpected path");return {...x.stat};},realpathSync:file=>file,
    openSync:file=>{calls.reads.push(file);opened.set(file,files.get(file));return file;},fstatSync:fd=>({...opened.get(fd).stat}),
    readSync:(fd,target,offset,length,position)=>{const b=opened.get(fd).bytes,n=Math.min(length,Math.max(0,b.length-position));b.copy(target,offset,position,position+n);if(mutate)mutate({files,fd,position});return n;},closeSync:fd=>opened.delete(fd)};
  return {files,calls,pins,options:{fixtureOnly:true,fileSystem:io,pins,readContext:async()=>{calls.context++;return {...CTX};}}};
}
test("fixed inputs and M8 return only the safe owner projection; no token or context plaintext",async()=>{
  const f=fixture(),r=await M.inspect(f.options),out=JSON.stringify(r);assert.equal(r.exactExpectedOperationMatch,true);assert.equal(r.contextEqual,true);assert.equal(r.pid,231);assert.equal(r.mode,"stage");assert.equal(f.calls.context,2);assert.equal(r.verifiedInputs.fixtureOnly,true);
  assert.deepEqual(Object.keys(r),["verifiedInputs","exactExpectedOperationMatch","pid","mode","createdAt","guardStat","contextEqual"]);for(const x of [TOKEN,CTX.bootId,CTX.pidNamespace,CTX.hostId,M.OPERATION,"token","contextSha256"])assert.ok(!out.includes(x));
  assert.ok(f.calls.reads.every(x=>[M.RUNNER,M.REQUEST,M.GUARD].includes(x)));assert.equal(f.calls.writes,0);
});
test("another valid operation or context is reported as a mismatch, never as dead or releasable",async()=>{
  const f=fixture({guard:{operationId:"33333333-3333-4333-8333-333333333333",contextSha256:"b".repeat(64)}}),r=await M.inspect(f.options);
  assert.equal(r.exactExpectedOperationMatch,false);assert.equal(r.contextEqual,false);assert.ok(!Object.keys(r).some(x=>/dead|stale|release|retire|alive/i.test(x)));
});
test("non-exact M8 and guard above 16KiB fail closed",async()=>{
  for(const guard of [{extra:true},{kind:"other"},{token:"invalid"},{schemaVersion:2}])await assert.rejects(M.inspect(fixture({guard}).options),{code:"B3_GUARD_SCHEMA"});
  const f=fixture();f.files.get(M.GUARD).stat.size=16385n;await assert.rejects(M.inspect(f.options),{code:"B3_SIZE"});
});
test("symlink, hardlink, unsafe leaf modes and a broadened shared-parent exception are rejected",async()=>{
  for(const edit of [f=>f.files.get(M.GUARD).stat.isSymbolicLink=()=>true,f=>f.files.get(M.GUARD).stat.nlink=2n,f=>f.files.get(M.GUARD).stat.mode=0o640n,f=>f.files.get("/var/data/operations").stat.mode=0o2775n]){
    const f=fixture();edit(f);await assert.rejects(M.inspect(f.options),e=>["B3_LEAF","B3_PARENT_MODE"].includes(e.code));
  }
});
test("fixed-input mismatches and inode/context changes cannot produce an owner observation",async()=>{
  for(const key of ["runner","request"]){const f=fixture();f.pins[key]="0".repeat(64);await assert.rejects(M.inspect(f.options),{code:"B3_INPUT_PIN"});}
  const raced=fixture({mutate:({files,fd,position})=>{if(fd===M.GUARD&&position===0)files.get(fd).stat.ino++;}});await assert.rejects(M.inspect(raced.options),{code:"B3_CHANGED"});
  const shifted=fixture();shifted.options.readContext=async()=>({...CTX,pidNamespace:shifted.calls.context++?"pid:[54321]":CTX.pidNamespace});await assert.rejects(M.inspect(shifted.options),{code:"B3_CONTEXT_CHANGED"});
});

test("actual startup hook logs one safe read-only observation, never authorizes release, and cannot interrupt guarded readiness",async()=>{
  const begin=appSource.indexOf("// Fixed read-only B3 observation;"),end=appSource.indexOf("// Normal guarded readiness continues",begin);
  assert.ok(begin>0&&end>begin);const block=appSource.slice(begin,end),vm=require("node:vm");
  for(const mode of ["success","known_error","unknown_error","logger_error"]){
    let reads=0;const logs=[],context={inspectFixedB3Guard:async()=>{reads++;
      if(mode==="known_error"||mode==="unknown_error")throw Object.assign(new Error("private-source-fragment"),{code:mode==="known_error"?"B3_CHANGED":"PRIVATE_SECRET"});
      return {verifiedInputs:{runner:true,request:true,fixtureOnly:false},exactExpectedOperationMatch:true,pid:231,mode:"stage",createdAt:"2026-11-16T04:46:00.000Z",guardStat:{bytes:400},contextEqual:false,retirementAuthorized:true};},
      console:{info:(event,value)=>{if(mode==="logger_error")throw Error("private-logger-fragment");logs.push({event,...JSON.parse(value)});}}};
    assert.equal(await vm.runInNewContext("(async()=>{"+block+";return true})()",context),true);assert.equal(reads,1);
    if(mode!=="logger_error"){
      assert.equal(logs.length,1);assert.equal(logs[0].event,"application_startup_b3_observation");assert.equal(logs[0].readOnly,true);assert.equal(logs[0].retirementAuthorized,false);
      const text=JSON.stringify(logs);assert.ok(!text.includes("private-source-fragment")&&!text.includes("PRIVATE_SECRET"));
      if(mode!=="success")assert.equal(logs[0].code,mode==="known_error"?"B3_CHANGED":"B3_UNVERIFIED");
    }
  }
});
