'use strict';
// An immutable historical review bundle. This module never calls DataLab or changes a collection.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const PREFIX='/saved-keyword-comparison';
const csp="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const fault=(code,message,statusCode)=>Object.assign(new Error(message),{code,statusCode});
function matches(pathname){return pathname===PREFIX||pathname.startsWith(PREFIX+'/');}
function frameHeaders(res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Content-Security-Policy',csp);
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
}
function denied(req,res,status){
  const html=req.url?.split('?')[0]===PREFIX||req.url?.split('?')[0]===PREFIX+'/'||req.url?.split('?')[0]===PREFIX+'/index.html';
  const message=status===401?'인사이트 관리자 로그인이 필요합니다.':'저장 키워드 비교는 관리자만 확인할 수 있습니다.';
  const value=html?`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>저장 자료 접근 안내</title><body><h1>${message}</h1><p><a href="/admin" target="_top">관리자 로그인으로 이동</a></p></body></html>`:JSON.stringify({error:{code:status===401?'ADMIN_LOGIN_REQUIRED':'ADMIN_ONLY',message}});
  const data=Buffer.from(value);
  res.writeHead(status,{'Content-Type':html?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Length':data.length});
  res.end(req.method==='HEAD'?undefined:data);
}
function createSavedKeywordComparison({directory=path.join(__dirname,'..','assets','saved-keyword-comparison')}={}){
  const root=path.resolve(directory);
  let current=null;
  async function sha(file){const digest=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))digest.update(bytes);return digest.digest('hex');}
  async function bundle(){
    try{
      const manifestFile=path.join(root,'bundle.json'),manifestStat=await fs.promises.stat(manifestFile);
      if(current&&current.manifestMtime===manifestStat.mtimeMs&&current.manifestSize===manifestStat.size){
        const unchanged=await Promise.all(current.files.map(async file=>{const stat=await fs.promises.stat(file.file);return stat.size===file.bytes&&stat.mtimeMs===file.mtime;}));
        if(unchanged.every(Boolean))return current;
      }
      const metadata=JSON.parse(await fs.promises.readFile(manifestFile,'utf8'));
      if(metadata.schemaVersion!==1||metadata.kind!=='historical_admin_review'||metadata.liveDataConnection!==false||metadata.collectionEnabled!==false)throw Error('INVALID_BUNDLE_POLICY');
      const index=metadata.html,snapshot=metadata.snapshot;
      if(index?.path!=='index.html'||!/^snapshot\.[a-f0-9]{64}\.json$/.test(snapshot?.path||'')||snapshot.path!==`snapshot.${snapshot.sha256}.json`)throw Error('INVALID_BUNDLE_PATH');
      const files=[];
      for(const [source,limit,type]of[[index,5*1024*1024,'text/html; charset=utf-8'],[snapshot,40*1024*1024,'application/json; charset=utf-8']]){
        if(!/^[a-f0-9]{64}$/.test(source.sha256||'')||!Number.isSafeInteger(source.bytes)||source.bytes<1||source.bytes>limit)throw Error('INVALID_BUNDLE_DIGEST');
        const file=path.join(root,source.path),stat=await fs.promises.stat(file);
        if(!stat.isFile()||stat.size!==source.bytes||await sha(file)!==source.sha256)throw Error('BUNDLE_DIGEST_MISMATCH');
        files.push({...source,type,file,mtime:stat.mtimeMs});
      }
      current={files,manifestMtime:manifestStat.mtimeMs,manifestSize:manifestStat.size};
      return current;
    }catch{current=null;throw fault('SAVED_COMPARISON_UNAVAILABLE','저장된 비교 화면을 준비하지 못했습니다. 잠시 후 다시 열어 주세요.',503);}
  }
  async function serve(req,res,pathname){
    const name=pathname===PREFIX||pathname===PREFIX+'/'?'index.html':pathname.slice((PREFIX+'/').length);
    if(name!=='index.html'&&!/^snapshot\.[a-f0-9]{64}\.json$/.test(name))throw fault('NOT_FOUND','저장 비교 파일을 찾을 수 없습니다.',404);
    const verified=await bundle(),file=verified.files.find(item=>item.path===name);
    if(!file)throw fault('NOT_FOUND','저장 비교 파일을 찾을 수 없습니다.',404);
    if(pathname===PREFIX){res.writeHead(302,{Location:PREFIX+'/'});res.end();return;}
    res.writeHead(200,{'Content-Type':file.type,'Content-Length':file.bytes,'ETag':'"'+file.sha256+'"','X-Insight-Saved-Bundle':'gyeongnam-20260920-22-v1'});
    if(req.method==='HEAD'){res.end();return;}
    await pipeline(fs.createReadStream(file.file),res);
  }
  return {matches,frameHeaders,denied,serve};
}
module.exports={createSavedKeywordComparison,PREFIX};
