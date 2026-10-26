'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {backgroundJsonGet}=require('../background-json-get.cjs');
const {createUpstreamReader}=require('../upstream-request.cjs');
async function fixture(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});return 'http://127.0.0.1:'+server.address().port;}
test('bounded background GET preserves status and numeric zero/null while waiting for body',async t=>{
 const base=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json','Server-Timing':'state_total;dur=3'});res.write('{"zero":0,');setTimeout(()=>res.end('"unknown":null}'),20);});
 const reply=await backgroundJsonGet(base,{signal:AbortSignal.timeout(1000)});assert.equal(reply.status,200);assert.equal(reply.headers.get('SERVER-TIMING'),'state_total;dur=3');assert.deepEqual(await reply.json(),{zero:0,unknown:null});
});
for(const headersSent of [false,true])test('absolute abort covers pending '+(headersSent?'body':'headers'),async t=>{
 const base=await fixture(t,(_req,res)=>{if(headersSent){res.writeHead(200);res.write('{');}}),signal=AbortSignal.timeout(35);
 if(headersSent){const reply=await backgroundJsonGet(base,{signal});await assert.rejects(reply.json());}else await assert.rejects(backgroundJsonGet(base,{signal}));
 assert.equal(signal.aborted,true);
});
test('response size is bounded and malformed JSON remains a failure',async t=>{
 const base=await fixture(t,(req,res)=>res.end(req.url==='/large'?'x'.repeat(1024):'not json'));
 const large=await backgroundJsonGet(base+'/large',{maxBytes:32});await assert.rejects(large.json());
 const invalid=await backgroundJsonGet(base+'/invalid');await assert.rejects(invalid.json(),SyntaxError);
});
test('redirects are never followed and only GET is accepted',async t=>{
 let calls=0;const base=await fixture(t,(_req,res)=>{calls++;res.writeHead(302,{Location:'/private'});res.end();});
 await assert.rejects(backgroundJsonGet(base));assert.equal(calls,1);await assert.rejects(backgroundJsonGet(base,{method:'POST'}));assert.equal(calls,1);
});
test('production reader selects native background transport, preserves 401 and never retries it',async t=>{
 let calls=0,userAgent;const base=await fixture(t,(req,res)=>{calls++;userAgent=req.headers['user-agent'];res.writeHead(401,{'Content-Type':'text/html'});res.end('authentication required');});
 const budgets=[],read=createUpstreamReader({backend:base,readTimeout:(_method,_route,context)=>{budgets.push(context);return 1000;},logger(){}});
 const reply=await read('/companies/a/collection','?month=2026-09',{}, {stage:'source',background:true});
 assert.equal(reply.status,401);assert.equal(reply.data.error.code,'AUTHENTICATION_REQUIRED');assert.equal(calls,1);assert.equal(userAgent,undefined);assert.equal(budgets[0].background,true);
});
test('background privilege cannot extend identity, reports, saved probes or writes',async()=>{
 const contexts=[],read=createUpstreamReader({backend:'https://central.example',readTimeout:(_method,_route,context)=>{contexts.push(context);return 1000;},fetchImpl:async()=>({status:200,ok:true,headers:{get(){return null;}},json:async()=>({ok:true})})});
 for(const [route,options] of [['/me',{}],['/reports/briefing',{}],['/companies/a/collection',{stage:'saved_preview'}],['/companies/a/collection',{method:'POST'}]])await read(route,'',{}, {background:true,...options});
 assert.ok(contexts.every(value=>value.background===false));await read('/companies/a/collection','',{}, {background:true});assert.equal(contexts.at(-1).background,true);
});
