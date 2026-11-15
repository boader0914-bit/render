"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { createKeywordMonthlyQueryLifecycle } = require("./lib/keyword_monthly_query_lifecycle.cjs");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return { promise,resolve,reject }; }
function fakeClock() {
  let at=0,id=0; const timers=new Map();
  return { now:()=>at, setTimeoutImpl:(fn,ms)=>{ const timer={id:++id,unref(){}};timers.set(timer,{fn,at:at+ms});return timer; },
    clearTimeoutImpl:timer=>timers.delete(timer), size:()=>timers.size,
    advance(ms){at+=ms;for(const [timer,row] of [...timers])if(row.at<=at){timers.delete(timer);row.fn();}} };
}
function fixture(options={}) { const clock=fakeClock();return {clock,pool:createKeywordMonthlyQueryLifecycle({...clock,...options})}; }

test("same unfinished read is shared; completed results are not retained as a cache", async()=>{
  const {pool,clock}=fixture(), gate=deferred();let calls=0;
  const a=pool.run("same",()=>{calls++;return gate.promise;}),b=pool.run("same",()=>assert.fail("duplicate operation"));
  await tick();assert.equal(calls,1);assert.equal(pool.status().waitingCallers,2);
  const value={snapshot:{sold:2}};gate.resolve(value);assert.equal(await a,value);assert.equal(await b,value);
  assert.equal(pool.status().inFlight,0);assert.equal(clock.size(),0);
  assert.equal(await pool.run("same",()=>++calls),2);
});

test("one caller disconnect releases its waiter and cannot cancel a surviving reader",async()=>{
  const {pool,clock}=fixture(),gate=deferred(),controller=new AbortController();
  const a=pool.run("same",()=>gate.promise,{signal:controller.signal}),b=pool.run("same",()=>assert.fail("duplicate"));
  const rejection=assert.rejects(a,e=>e.code==="KEYWORD_MONTHLY_QUERY_ABORTED");controller.abort();await rejection;
  assert.equal(pool.status().waitingCallers,1);assert.equal(clock.size(),1);
  gate.resolve(9);assert.equal(await b,9);assert.equal(pool.status().inFlight,0);
});

test("all abandoned callers leave one bounded in-flight identity, preventing timeout duplication",async()=>{
  const {pool,clock}=fixture({timeoutMs:5}),gate=deferred();let calls=0;
  const a=pool.run("same",()=>{calls++;return gate.promise;}),r=assert.rejects(a,e=>e.code==="KEYWORD_MONTHLY_QUERY_TIMEOUT");
  clock.advance(5);await r;await tick();assert.equal(pool.status().abandonedInFlight,1);assert.equal(clock.size(),0);
  const b=pool.run("same",()=>assert.fail("timed-out work duplicated"));assert.equal(calls,1);
  gate.resolve(10);assert.equal(await b,10);assert.equal(pool.status().inFlight,0);
});

test("different reads and waiters have explicit bounds without dropping their original owner",async()=>{
  const {pool}=fixture({maxInFlight:1,maxWaiters:2}),gate=deferred();
  const a=pool.run("a",()=>gate.promise),b=pool.run("a",()=>assert.fail("duplicate"));
  await assert.rejects(pool.run("b",()=>assert.fail("over capacity")),e=>e.code==="KEYWORD_MONTHLY_QUERY_BUSY");
  await assert.rejects(pool.run("a",()=>assert.fail("over waiters")),e=>e.code==="KEYWORD_MONTHLY_QUERY_BUSY");
  assert.equal(pool.status().rejectedBusy,undefined);assert.equal(pool.status().counters.rejectedBusy,2);
  gate.resolve(1);assert.deepEqual(await Promise.all([a,b]),[1,1]);
});

test("rejections including falsy reasons preserve promise semantics and release the registry",async()=>{
  const {pool,clock}=fixture();
  for(const reason of [undefined,null,false,0,new Error("private source detail")]){
    let rejected=false;await pool.run("read",()=>Promise.reject(reason)).then(()=>assert.fail("rejection became success"),e=>{rejected=true;assert.equal(e,reason);});assert.equal(rejected,true);
    assert.equal(pool.status().inFlight,0);assert.equal(clock.size(),0);
  }
  assert.equal(pool.status().counters.failed,5);assert.ok(!JSON.stringify(pool.status()).includes("private source detail"));
});

test("close rejects waiters but does not abort already-owned analytical work",async()=>{
  const {pool,clock}=fixture(),gate=deferred();let completed=false;
  const a=pool.run("private condition",()=>gate.promise.then(()=>{completed=true;return 1;}));await tick();
  const rejection=assert.rejects(a,e=>e.code==="KEYWORD_MONTHLY_QUERY_CLOSED");pool.close();await rejection;
  assert.equal(completed,false);assert.equal(clock.size(),0);assert.equal(pool.status().abandonedInFlight,1);
  await assert.rejects(pool.run("next",()=>assert.fail("closed")),e=>e.code==="KEYWORD_MONTHLY_QUERY_CLOSED");
  gate.resolve();await tick();assert.equal(completed,true);assert.equal(pool.status().inFlight,0);
  assert.ok(!JSON.stringify(pool.status()).includes("private condition"));
});

test("already-aborted callers cannot create work and setup failure cannot leak a flight",async()=>{
  const {pool}=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(pool.run("x",()=>assert.fail("aborted"),{signal:controller.signal}),e=>e.code==="KEYWORD_MONTHLY_QUERY_ABORTED");
  const bad=createKeywordMonthlyQueryLifecycle({setTimeoutImpl(){throw Error("timer unavailable");}});
  await assert.rejects(bad.run("x",()=>assert.fail("setup failed")),/timer unavailable/);assert.equal(bad.status().inFlight,0);
  await assert.rejects(pool.run("x".repeat(8193),()=>{}),TypeError);
});

function httpFixture(service,opts={}){
  const {pool,clock}=fixture(opts),make=()=>{const req=new EventEmitter();req.method="GET";const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;return {req,res};};
  const handler=createKeywordMonthlyHttpHandler({service,queryLifecycle:pool,requireAdmin:s=>s?.admin===true,
    readRefreshStatus:async()=>({status:"complete"}),send:(res,status,body)=>{res.status=status;res.body=body;res.writableEnded=true;}});
  return {pool,clock,make,handle:(pair,url,admin=true)=>handler(pair.req,pair.res,new URL(url,"https://example.test"),{admin})};
}
test("HTTP sharing canonicalizes parameter order and auth denial never enters the read pool",async()=>{
  const gate=deferred();let calls=0;const f=httpFixture({options:async()=>({keywords:[]}),analyze:()=>{calls++;return gate.promise;}}),a=f.make(),b=f.make(),denied=f.make();
  const pa=f.handle(a,"/api/keyword-monthly?keyword=test&month=2026-09"),pb=f.handle(b,"/api/keyword-monthly?month=2026-09&keyword=test");
  await f.handle(denied,"/api/keyword-monthly?keyword=test&month=2026-09",false);await tick();assert.equal(calls,1);
  gate.resolve({status:"available",snapshot:{sold:4}});await Promise.all([pa,pb]);assert.equal(a.res.body,b.res.body);assert.equal(a.res.status,200);assert.equal(denied.res.status,undefined);
  for(const {req,res} of [a,b]){assert.equal(req.listenerCount("aborted"),0);assert.equal(res.listenerCount("close"),0);}
});
test("ordinary request close is not a disconnect; aborted response never receives a late payload",async()=>{
  const gate=deferred();const f=httpFixture({options:()=>gate.promise,analyze:()=>({})}),a=f.make(),b=f.make();
  const pa=f.handle(a,"/api/keyword-monthly/options"),pb=f.handle(b,"/api/keyword-monthly/options");a.req.emit("close");
  b.res.destroyed=true;b.res.emit("close");await pb;assert.equal(b.res.body,undefined);assert.equal(f.pool.status().waitingCallers,1);
  gate.resolve({status:"available",keywords:[]});await pa;assert.equal(a.res.status,200);assert.equal(b.res.body,undefined);
});
test("HTTP timeout gives a safe structured 503 while status reads stay independent of a full pool",async()=>{
  const gate=deferred();const f=httpFixture({options:()=>gate.promise,analyze:()=>({})},{timeoutMs:5,maxInFlight:1}),a=f.make(),status=f.make();
  const pa=f.handle(a,"/api/keyword-monthly/options");await tick();
  await f.handle(status,"/api/keyword-monthly/refresh-status");assert.equal(status.res.status,200);assert.equal(status.res.body.queryDiagnostics.inFlight,1);
  f.clock.advance(5);await pa;assert.equal(a.res.status,503);assert.equal(a.res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(a.res.body.snapshot,null);
  assert.equal(a.req.listenerCount("aborted"),0);assert.equal(a.res.listenerCount("close"),0);gate.resolve({status:"available",keywords:[]});await tick();assert.equal(f.pool.status().inFlight,0);
});

test("options deadline includes a stalled refresh status and a disconnect cannot retain its response",async()=>{
  const {pool,clock}=fixture({timeoutMs:5}),status=deferred(),req=new EventEmitter(),res=new EventEmitter();
  req.method="GET";res.setHeader=()=>{};
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({status:"available",keywords:[]}),analyze:async()=>({})},queryLifecycle:pool,
    requireAdmin:()=>true,readRefreshStatus:()=>status.promise,send:(_res,http,body)=>{res.status=http;res.body=body;}});
  const running=handler(req,res,new URL("https://example.test/api/keyword-monthly/options"),{});await tick();
  clock.advance(5);await running;assert.equal(res.status,503);assert.equal(res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");
  assert.equal(res.listenerCount("close"),0);assert.equal(req.listenerCount("aborted"),0);assert.equal(pool.status().abandonedInFlight,1);
  status.resolve({status:"complete"});await tick();assert.equal(pool.status().inFlight,0);
});

test("standalone refresh status has an independent bounded deadline",async()=>{
  const {pool,clock}=fixture({timeoutMs:5}),status=deferred(),req=new EventEmitter(),res=new EventEmitter();req.method="GET";res.setHeader=()=>{};
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({}),analyze:async()=>({})},statusLifecycle:pool,
    requireAdmin:()=>true,readRefreshStatus:()=>status.promise,send:(_res,http,body)=>{res.status=http;res.body=body;}});
  const running=handler(req,res,new URL("https://example.test/api/keyword-monthly/refresh-status"),{});await tick();clock.advance(5);await running;
  assert.equal(res.status,503);assert.equal(res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");status.resolve({status:"complete"});await tick();
});
