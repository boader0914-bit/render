"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {readBundleFile}=require("./lib/keyword_monthly_bundle.cjs");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,"monthly-path-proof-")),directory=path.join(root,"one","two","three");await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,"fixture.json"),bytes=Buffer.from('{"fixture":true}');await fs.writeFile(file,bytes);
  t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),parent);assert.match(path.basename(root),/^monthly-path-proof-/);await fs.rm(root,{recursive:true,force:true});});return {root,directory,file,bytes};}
test("ancestor validation overlaps at most eight path operations and still reads identical bytes",async t=>{
  const f=await fixture(t),original={lstat:fs.lstat,realpath:fs.realpath};let active=0,maximum=0,calls=0;
  for(const method of ["lstat","realpath"])fs[method]=async function(file,...args){if(!String(file).startsWith(f.root))return original[method](file,...args);
    calls++;active++;maximum=Math.max(maximum,active);try{await tick();return await original[method](file,...args);}finally{active--;}};
  try{const results=await Promise.all([1,2,3].map(()=>readBundleFile(f.file,1024)));for(const result of results)assert.deepEqual(result.bytes,f.bytes);
    assert.ok(maximum>1,"independent ancestors actually overlap");assert.ok(maximum<=8,"all path validations share the same process-wide bound");assert.equal(active,0);assert.ok(calls>20);
  }finally{Object.assign(fs,original);}
});
test("an unsafe path failure drains every pending path check before rejecting and never opens a file",async t=>{
  const f=await fixture(t),original={lstat:fs.lstat,realpath:fs.realpath,open:fs.open};let active=0,settled=0,opens=0;
  fs.lstat=async function(file,...args){if(!String(file).startsWith(f.root))return original.lstat(file,...args);active++;
    try{await tick();if(String(file)===f.directory)throw Object.assign(Error("synthetic denied"),{code:"EACCES"});return await original.lstat(file,...args);}finally{active--;settled++;}};
  fs.realpath=async function(file,...args){if(!String(file).startsWith(f.root))return original.realpath(file,...args);active++;try{await tick();return await original.realpath(file,...args);}finally{active--;settled++;}};
  fs.open=async function(...args){opens++;return original.open(...args);};
  try{await assert.rejects(readBundleFile(f.file,1024),{code:"EACCES"});assert.equal(active,0);assert.equal(opens,0);const at=settled;await tick();assert.equal(settled,at,"no abandoned path callback outlives the failed read");
  }finally{Object.assign(fs,original);}
});
test("ancestor identity drift after open is rejected even when every file identity field is unchanged",async t=>{
  const f=await fixture(t),original={lstat:fs.lstat,open:fs.open};let readStarted=false;
  fs.open=async function(file,...args){const handle=await original.open(file,...args);if(String(file)===f.file){const read=handle.read.bind(handle);handle.read=async(...values)=>{const result=await read(...values);if(result.bytesRead)readStarted=true;return result;};}return handle;};
  fs.lstat=async function(file,...args){const stat=await original.lstat(file,...args);if(String(file)===f.directory&&readStarted)return new Proxy(stat,{get(target,key){if(key==="ino")return target.ino===0?1:0;const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});return stat;};
  try{await assert.rejects(readBundleFile(f.file,1024),{code:"KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"});assert.deepEqual(await fs.readFile(f.file),f.bytes);
  }finally{Object.assign(fs,original);}
});
test("final file drift and real hardlinks retain strict denial",async t=>{
  const f=await fixture(t),original=fs.open;let changed=false;
  fs.open=async function(file,...args){const handle=await original(file,...args);if(String(file)===f.file){const read=handle.read.bind(handle);handle.read=async(...values)=>{const result=await read(...values);if(result.bytesRead&&!changed){changed=true;const stat=await fs.stat(f.file);await fs.utimes(f.file,stat.atime,new Date(stat.mtimeMs+2000));}return result;};}return handle;};
  try{await assert.rejects(readBundleFile(f.file,1024),{code:"KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"});}finally{fs.open=original;}
  await fs.link(f.file,path.join(f.root,"hardlinked.json"));await assert.rejects(readBundleFile(f.file,1024),{code:"KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"});
});
test("symlink ancestors and final symlink targets are never opened",async t=>{
  const f=await fixture(t),linkedDir=path.join(f.root,"linked-directory"),linkedFile=path.join(f.root,"linked-file.json");
  try{await fs.symlink(f.directory,linkedDir,process.platform==="win32"?"junction":"dir");await fs.symlink(f.file,linkedFile,"file");}
  catch(error){if(["EPERM","EACCES","ENOTSUP"].includes(error.code)){t.skip("host does not grant symlink creation");return;}throw error;}
  const original=fs.open;let opens=0;fs.open=async function(...args){opens++;return original(...args);};
  try{await assert.rejects(readBundleFile(path.join(linkedDir,"fixture.json"),1024),{code:"KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"});await assert.rejects(readBundleFile(linkedFile,1024),{code:"KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"});assert.equal(opens,0);
  }finally{fs.open=original;}
});
test("injected symlink and canonical-path drift checks fail closed on hosts without symlink privileges too",async t=>{
  const f=await fixture(t),original={lstat:fs.lstat,realpath:fs.realpath,open:fs.open};let opens=0;
  fs.open=async function(...args){opens++;return original.open(...args);};
  try{
    for(const unsafe of [f.directory,f.file]){
      fs.lstat=async function(file,...args){const stat=await original.lstat(file,...args);if(String(file)===unsafe)return new Proxy(stat,{get(target,key){if(key==="isSymbolicLink")return ()=>true;const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});return stat;};
      await assert.rejects(readBundleFile(f.file,1024),{code:"KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"});
    }
    fs.lstat=original.lstat;fs.realpath=async function(file,...args){if(String(file)===f.directory)return path.join(f.root,"different-directory");return original.realpath(file,...args);};
    await assert.rejects(readBundleFile(f.file,1024),{code:"KEYWORD_MONTHLY_BUNDLE_UNSAFE_PATH"});assert.equal(opens,0);
  }finally{Object.assign(fs,original);}
});
