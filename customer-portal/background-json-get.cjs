'use strict';
const http=require('node:http'),https=require('node:https');
// Only the authenticated central company revalidation path selects this
// transport. Its absolute AbortSignal deadline also covers response headers;
// native fetch's shorter headers deadline must not cut a queued read off.
function backgroundJsonGet(url,{method='GET',headers,signal,maxBytes=16*1024*1024}={}){
  if(method!=='GET')return Promise.reject(new TypeError('Background reads require GET'));
  const target=new URL(url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)return Promise.reject(new TypeError('Invalid background origin'));
  return new Promise((resolve,reject)=>{
    let responseStarted=false,settledBody=false,resolveBody,rejectBody;
    const body=new Promise((done,fail)=>{resolveBody=done;rejectBody=fail;});body.catch(()=>{});
    const fail=error=>{if(!responseStarted)reject(error);if(!settledBody){settledBody=true;rejectBody(error);}};
    const request=(target.protocol==='https:'?https:http).request(target,{method,headers,signal,timeout:0},response=>{
      if(response.statusCode>=300&&response.statusCode<400){response.resume();request.destroy(new TypeError('Background redirects are not allowed'));return;}
      responseStarted=true;let size=0;const chunks=[];
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>maxBytes){const error=Object.assign(new Error('Background response exceeds the size limit'),{code:'RESPONSE_TOO_LARGE'});response.destroy(error);request.destroy(error);return;}
        chunks.push(chunk);
      });
      response.on('error',fail);response.on('aborted',()=>fail(Object.assign(new Error('Background response was interrupted'),{code:'ECONNRESET'})));
      response.on('end',()=>{if(!settledBody){settledBody=true;resolveBody(Buffer.concat(chunks).toString('utf8'));}});
      resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,headers:{get(name){const value=response.headers[String(name).toLowerCase()];return Array.isArray(value)?value.join(', '):value??null;}},json:async()=>JSON.parse(await body)});
    });
    request.on('error',fail);request.end();
  });
}
module.exports={backgroundJsonGet};
