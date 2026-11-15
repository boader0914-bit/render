"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createKeywordMonthlyResponseBudget}=require("./lib/keyword_monthly_response_budget.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
class Response extends EventEmitter{constructor(){super();this.headers={};}setHeader(k,v){this.headers[k]=v;}writeHead(status,headers){this.status=status;this.headersSent=true;Object.assign(this.headers,headers);}end(body){this.body=body;this.writableEnded=true;}destroy(){this.destroyed=true;this.emit("close");}}

test("response admission is reserved before reads and kept until slow sockets finish",async()=>{
  const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:10,maxReservedBytes:20}),a=new Response(),b=new Response(),c=new Response();let prepared=0;
  const work=async()=>{prepared++;},pa=budget.run(a,work),pb=budget.run(b,work);await flush();
  assert.equal(budget.status().reservedBytes,20);await assert.rejects(budget.run(c,()=>assert.fail("unreserved read")),e=>e.code==="KEYWORD_MONTHLY_RESPONSE_BUSY");
  assert.equal(prepared,2);a.emit("finish");assert.equal(await pa,true);assert.equal(budget.status().reservedBytes,10);
  b.emit("close");assert.equal(await pb,false);assert.equal(budget.status().reservedBytes,0);assert.equal(a.listenerCount("finish"),0);
});
test("disconnection does not recycle a reservation while ignored preparation is still live",async()=>{
  const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:10,maxReservedBytes:10}),res=new Response(),gate=deferred();let signal;
  const work=budget.run(res,ctx=>{signal=ctx.signal;return gate.promise;});await flush();res.emit("close");assert.equal(await work,false);assert.equal(signal.aborted,true);
  assert.equal(budget.status().reservedBytes,10);await assert.rejects(budget.run(new Response(),()=>{}),e=>e.code==="KEYWORD_MONTHLY_RESPONSE_BUSY");
  gate.resolve();await flush();assert.equal(budget.status().reservedBytes,0);
});
test("a transmission deadline destroys only its own response and cleans listeners",async()=>{
  let expire;const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:10,maxReservedBytes:10,setTimeoutImpl:fn=>{expire=fn;return {unref(){}};},clearTimeoutImpl(){}}),res=new Response();
  const work=budget.run(res,()=>{});await flush();expire();assert.equal(await work,false);assert.equal(res.destroyed,true);assert.equal(budget.status().activeResponses,0);assert.equal(res.listenerCount("close"),0);
});
test("timer setup failure cannot strand response admission",async()=>{
  const budget=createKeywordMonthlyResponseBudget({setTimeoutImpl(){throw Error("timer failed");}}),res=new Response();
  await assert.rejects(budget.run(res,()=>assert.fail("setup")),/timer failed/);assert.equal(budget.status().reservedBytes,0);assert.equal(res.listenerCount("finish"),0);
});
test("HTTP response serialization is bounded before send and preserves existing security headers",async()=>{
  const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:512,maxReservedBytes:512});let calls=0;
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({status:"available",keywords:[]}),analyze:async()=>({status:"available",snapshot:{privateBody:"x".repeat(2000)}})},responseBudget:budget,
    requireAdmin:()=>true,send:(res,http,body)=>{calls++;res.writeHead(http,{"X-Content-Type-Options":"nosniff"});res.end(body);res.emit("finish");}});
  const req=new EventEmitter();req.method="GET";const res=new Response();await handler(req,res,new URL("https://example.test/api/keyword-monthly?keyword=test&month=2026-09"),{});
  assert.equal(calls,1);assert.equal(res.status,503);assert.equal(res.body.code,"KEYWORD_MONTHLY_RESPONSE_TOO_LARGE");assert.equal(res.headers["X-Content-Type-Options"],"nosniff");assert.equal(budget.status().reservedBytes,0);
});
test("successful native HTTP sends a bounded JSON buffer and retains finish ownership",async()=>{
  const budget=createKeywordMonthlyResponseBudget(),res=new Response(),req=new EventEmitter();req.method="GET";
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({status:"available",keywords:[]}),analyze:async()=>({status:"available",snapshot:{sold:3}})},responseBudget:budget,
    requireAdmin:()=>true,send:(r,status,body)=>{r.writeHead(status,{"X-Content-Type-Options":"nosniff"});r.end(body);}});
  const pending=handler(req,res,new URL("https://example.test/api/keyword-monthly?keyword=test&month=2026-09"),{});await flush();
  assert.equal(res.status,200);assert.ok(Buffer.isBuffer(res.body));assert.equal(JSON.parse(res.body).snapshot.sold,3);assert.equal(budget.status().activeResponses,1);
  res.emit("finish");await pending;assert.equal(budget.status().activeResponses,0);assert.equal(res.headers["X-Content-Type-Options"],"nosniff");
});
