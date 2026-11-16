"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),c=require("node:crypto"),p=require("node:path").posix;
const M=require("./lib/fixed_b3_maintenance_boot_shim.cjs"),P=M.PATHS,hash=b=>c.createHash("sha256").update(b).digest("hex");
function fixture({status="archived",git=true,resultChange={},helperError=null}={}){
  const files=new Map(),opened=new Map(),calls={load:0,invoke:0,git:0};let ino=1;
  const stat=(dir,size,uid=1000,mode=dir?0o755:0o644)=>({dev:1n,ino:BigInt(ino++),size:BigInt(size),mtimeNs:1n,ctimeNs:1n,nlink:1n,uid:BigInt(uid),gid:1000n,mode:BigInt(mode),isDirectory:()=>dir,isFile:()=>!dir,isSymbolicLink:()=>false});
  for(const file of [P.policyPath,P.self,P.helper,P.context,P.rename,P.git]){let dir=p.dirname(file);while(dir!=="/"){if(!files.has(dir))files.set(dir,{stat:stat(true,0,0,dir==="/var/data"?0o2775:0o755)});dir=p.dirname(dir);}const b=Buffer.from("synthetic "+file);files.set(file,{bytes:b,stat:stat(false,b.length,file===P.git?0:1000,file===P.git?0o755:0o644)});}
  files.get("/opt").stat.gid=0n;
  Object.assign(files.get("/opt/render").stat,{uid:1000n,gid:1000n,mode:0o1777n});
  for(const [file,value] of files)if(value.stat.isDirectory()&&(file==="/opt/render/project"||file.startsWith("/opt/render/project/")))Object.assign(value.stat,{uid:1000n,gid:1000n,mode:0o755n});
  const review={schemaVersion:2,codePins:{contextModuleSha256:hash(files.get(P.context).bytes),retirementModuleSha256:hash(files.get(P.helper).bytes),renameHelperSha256:hash(files.get(P.rename).bytes),bootShim:{path:P.self,sha256:hash(files.get(P.self).bytes)}}},bytes=Buffer.from(JSON.stringify(review));files.set(P.policyPath,{bytes,stat:stat(false,bytes.length)});
  const opts={dataDir:P.dataDir,codeRoot:P.codeRoot,policyPath:P.policyPath,policySha256:hash(bytes)};
  const fileSystem={lstatSync:file=>({...files.get(file).stat}),realpathSync:file=>file,openSync:file=>{opened.set(file,files.get(file));return file;},fstatSync:fd=>({...opened.get(fd).stat}),
    readSync:(fd,target,offset,length,position)=>{const b=opened.get(fd).bytes,n=Math.min(length,Math.max(0,b.length-position));b.copy(target,offset,position,position+n);return n;},closeSync:fd=>opened.delete(fd)};
  const deps={fixture:true,fileSystem,constants:{O_RDONLY:0,O_NOFOLLOW:131072},loadModule:file=>{calls.load++;assert.equal(file,P.helper);return {retireReviewedB3MaintenanceAtBoot:async args=>{
    calls.invoke++;assert.equal(args.dataDir,P.dataDir);assert.equal(args.codeRoot,P.codeRoot);assert.equal(args.policyPath,P.policyPath);assert.equal(args.policySha256,opts.policySha256);if(helperError)throw helperError;
    return {status,fixture:true,oldMarkerArchived:true,newGuardPresent:false,noReplace:true,completionReceiptSha256:"a".repeat(64),baselineFreshnessRevalidated:false,normalMaintenanceProtectionRequired:true,currentGuardUntouched:true,actionReplayAuthorized:false,sourceWrites:0,queueWrites:0,configurationWrites:0,originalWrites:0,rawSecret:"NEVER_RETURN",runtimeDeploymentId:"UNTRUSTED",...resultChange};
  }};},execFile:(file,args,options,done)=>{calls.git++;assert.equal(file,P.git);assert.deepEqual(args,["-C",P.codeRoot,"rev-parse","--verify","HEAD"]);assert.deepEqual(options.env,{});assert.equal(options.timeout,1500);done(git?null:Error("audit unavailable"),git?"1".repeat(40)+"\n":"");}};
  return {files,opts,deps,calls};
}
test("wrong policy SHA is rejected before requiring or invoking retirement code",async()=>{const f=fixture();await assert.rejects(M.runFixedB3BootRetirement({...f.opts,policySha256:"0".repeat(64)},f.deps),{code:"B3_BOOT_POLICY_SHA"});assert.equal(f.calls.load,0);assert.equal(f.calls.invoke,0);});
test("unsafe paths, symlinks, hardlinks and group-writable policy never enter the helper",async()=>{
  const wrong=fixture();await assert.rejects(M.runFixedB3BootRetirement({...wrong.opts,policyPath:"/tmp/other.json"},wrong.deps),{code:"B3_BOOT_FIXED_ARGUMENTS"});
  for(const mutate of [f=>f.files.get(P.policyPath).stat.isSymbolicLink=()=>true,f=>f.files.get(P.policyPath).stat.nlink=2n,f=>f.files.get(P.policyPath).stat.mode=0o664n]){const f=fixture();mutate(f);await assert.rejects(M.runFixedB3BootRetirement(f.opts,f.deps),{code:"B3_BOOT_LEAF"});assert.equal(f.calls.load,0);}
});
test("helper and self are pinned before static require; old context and rename pins are delegated for idempotent statuses",async()=>{
  for(const file of [P.helper,P.self]){const f=fixture();f.files.get(file).bytes[0]^=1;await assert.rejects(M.runFixedB3BootRetirement(f.opts,f.deps),{code:"B3_BOOT_CODE_SHA"});assert.equal(f.calls.load,0);assert.equal(f.calls.invoke,0);}
  for(const status of ["not_target","already_retired"]){const f=fixture({status});f.files.get(P.context).bytes[0]^=1;f.files.get(P.rename).bytes[0]^=1;assert.equal((await M.runFixedB3BootRetirement(f.opts,f.deps)).status,status);}
});
test("only fixed invocation and a safe projection are returned for all three approved statuses",async()=>{
  for(const status of ["archived","already_retired","not_target"]){const f=fixture({status}),r=await M.runFixedB3BootRetirement(f.opts,f.deps);assert.equal(f.calls.load,1);assert.equal(f.calls.invoke,1);assert.equal(f.calls.git,1);assert.equal(r.status,status);assert.equal(r.auditRoot,P.auditRoot);assert.equal(r.actualCommitRuntimeAudit.commit,"1".repeat(40));assert.equal(r.runtimeDeploymentId,null);assert.equal(r.completionReceiptSha256,status==="not_target"?null:"a".repeat(64));assert.ok(!JSON.stringify(r).includes("NEVER_RETURN")&&!JSON.stringify(r).includes("UNTRUSTED"));}
});
test("partial or non-success outcomes and NEEDS_READBACK throw; unavailable Git remains audit-only null",async()=>{
  const error=Object.assign(new Error("safe held"),{code:"B3_ARCHIVE_NEEDS_READBACK",mutationState:"rename_attempted_uncertain"}),held=fixture({helperError:error});await assert.rejects(M.runFixedB3BootRetirement(held.opts,held.deps),e=>e===error);
  for(const resultChange of [{status:"held"},{status:"archived",mutationState:"uncertain"},{status:"already_retired",baselineFreshnessRevalidated:true}]){const f=fixture({resultChange});await assert.rejects(M.runFixedB3BootRetirement(f.opts,f.deps),e=>/^B3_BOOT_/.test(e.code));}
  const f=fixture({git:false}),r=await M.runFixedB3BootRetirement(f.opts,f.deps);assert.deepEqual(r.actualCommitRuntimeAudit,{source:"git_metadata",available:false,commit:null});assert.equal(r.runtimeDeploymentId,null);assert.equal(f.calls.invoke,1);
});
test("the exact observed Render sticky chain reaches only the pinned helper",async()=>{
  const f=fixture();for(const [file,uid,gid,mode] of [["/opt",0n,0n,0o755n],["/opt/render",1000n,1000n,0o1777n],["/opt/render/project",1000n,1000n,0o755n]]){const s=f.files.get(file).stat;assert.equal(s.uid,uid);assert.equal(s.gid,gid);assert.equal(s.mode,mode);assert.equal(M.parentModeAllowed(file,s),true);}
  const r=await M.runFixedB3BootRetirement(f.opts,f.deps);assert.equal(r.status,"archived");assert.equal(f.calls.load,1);assert.equal(f.calls.invoke,1);
});
test("the sticky exception never extends to another path, owner, group or mode",async()=>{
  const f=fixture(),original=f.files.get("/opt/render").stat;
  for(const at of ["/opt/renderer","/opt/render-other","/tmp","/opt/render/project/other"])assert.equal(M.parentModeAllowed(at,original),false,at);
  for(const change of [{uid:0n},{uid:1001n},{gid:0n},{gid:1001n},...[0o777n,0o1775n,0o2777n,0o3777n,0o5777n].map(mode=>({mode}))]){
    const x=fixture();Object.assign(x.files.get("/opt/render").stat,change);await assert.rejects(M.runFixedB3BootRetirement(x.opts,x.deps),e=>["B3_BOOT_PARENT_MODE","B3_BOOT_PARENT"].includes(e.code));assert.equal(x.calls.load,0);assert.equal(x.calls.invoke,0);
  }
});
test("the reviewed root-owned ancestor and protected immediate child stay exact",async()=>{
  for(const [file,change] of [["/opt",{uid:1000n}],["/opt",{gid:1000n}],["/opt",{mode:0o775n}],["/opt/render/project",{uid:0n}],["/opt/render/project",{uid:1001n}],["/opt/render/project",{gid:0n}],["/opt/render/project",{mode:0o775n}],["/opt/render/project",{mode:0o1777n}],["/opt/render/project/src",{mode:0o775n}]]){
    const f=fixture();Object.assign(f.files.get(file).stat,change);await assert.rejects(M.runFixedB3BootRetirement(f.opts,f.deps),e=>["B3_BOOT_PARENT_MODE","B3_BOOT_PARENT"].includes(e.code));assert.equal(f.calls.load,0);assert.equal(f.calls.invoke,0);
  }
});
test("the sticky parent and protected child still reject symlinks and noncanonical paths",async()=>{
  for(const file of ["/opt/render","/opt/render/project"]){
    const symlink=fixture();symlink.files.get(file).stat.isSymbolicLink=()=>true;await assert.rejects(M.runFixedB3BootRetirement(symlink.opts,symlink.deps),{code:"B3_BOOT_PARENT"});assert.equal(symlink.calls.load,0);
    const moved=fixture();moved.deps.fileSystem.realpathSync=at=>at===file?at+"-other":at;await assert.rejects(M.runFixedB3BootRetirement(moved.opts,moved.deps),{code:"B3_BOOT_PARENT"});assert.equal(moved.calls.load,0);
  }
});
test("parent inode and timestamp changes after module load hold before any helper action",async()=>{
  for(const file of ["/opt/render","/opt/render/project","/opt/render/project/src/scripts/lib"])for(const key of ["ino","mtimeNs","ctimeNs"]){
    const f=fixture(),load=f.deps.loadModule;f.deps.loadModule=at=>{const result=load(at);f.files.get(file).stat[key]++;return result;};
    await assert.rejects(M.runFixedB3BootRetirement(f.opts,f.deps),{code:"B3_BOOT_PARENT_CHANGED"});assert.equal(f.calls.load,1);assert.equal(f.calls.invoke,0);
  }
});
