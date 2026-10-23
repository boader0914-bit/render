'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createUpstreamReader,routeLabel,retryDelay}=require('../upstream-request.cjs');
const {createConnectedServer}=require('../connected-server.cjs');
const response=(data,status=200,headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[name]??null},json:async()=>data});
const invalid=(status=200,headers={})=>({...response(null,status,headers),json:async()=>{throw SyntaxError('private HTML body with token-secret');}});
function reader(replies,{budget=20000}={}){
  const calls=[],logs=[],pauses=[];let tick=0;
  const read=createUpstreamReader({backend:'https://central.example',readTimeout:()=>budget,clock:()=>tick,now:()=>1770000000000,
    logger:entry=>logs.push(entry),sleep:async ms=>{pauses.push(ms);tick+=ms;},fetchImpl:async(url,options)=>{calls.push({url,options});const result=replies.shift();if(typeof result==='function')return result();if(result instanceof Error)throw result;return result;}});
  return {read,logs,calls,pauses};
}
const headers={Authorization:'Bearer token-secret','X-Insight-Session':'private-session'};
for(const status of [502,503,504])test(`safe GET recovers once after HTTP ${status} within the original timeout budget`,async()=>{
  const f=reader([response({error:{code:'UNAVAILABLE'}},status),response({customer:{id:'safe'}})]),reply=await f.read('/me','',headers,{stage:'identity',timing:{requestId:'qa-request-id',add(){},central(){}}});
  assert.equal(reply.status,200);assert.equal(f.calls.length,2);assert.deepEqual(f.pauses,[120]);
  assert.equal(f.calls[0].options.signal,f.calls[1].options.signal,'the retry must share the original deadline');
  assert.deepEqual(f.logs.map(log=>log.outcome),['retrying','recovered']);assert.ok(f.logs.every(log=>log.requestId==='qa-request-id'));
});
test('transient HTML and network failures are retried without logging their body or credentials',async()=>{
  for(const problem of [invalid(),invalid(503),new TypeError('private URL and token-secret')]){
    const f=reader([problem,response({ok:true})]);assert.equal((await f.read('/companies/cmp_private/collection','?month=2026-10&token=secret',headers)).status,200);
    assert.equal(f.calls.length,2);assert.doesNotMatch(JSON.stringify(f.logs),/cmp_private|token-secret|private-session|month|https:|secret/);
    assert.equal(f.logs[0].route,'/companies/:id/collection');assert.ok(['invalid_json','network_error'].includes(f.logs[0].errorClass));
  }
});
test('a second transient failure is returned and the retry remains bounded',async()=>{
  const f=reader([response({error:{code:'CENTRAL_UNAVAILABLE'}},503),response({error:{code:'CENTRAL_UNAVAILABLE'}},503)]),reply=await f.read('/me','',headers,{stage:'identity'});
  assert.equal(f.calls.length,2);assert.equal(reply.status,503);assert.equal(reply.data.error.code,'CENTRAL_UNAVAILABLE');assert.equal(f.logs.at(-1).outcome,'failed');
});
for(const status of [400,401,403,404,429,500])for(const nonJson of [false,true])test(`HTTP ${status}${nonJson?' non-JSON':''} never retries`,async()=>{
  const f=reader([nonJson?invalid(status):response({error:{code:'ORIGINAL_ERROR'}},status)]);
  if(nonJson&&![401,403,429].includes(status))await assert.rejects(f.read('/me','',headers));
  else{const reply=await f.read('/me','',headers);assert.equal(reply.status,status);if(!nonJson)assert.equal(reply.data.error.code,'ORIGINAL_ERROR');}
  assert.equal(f.calls.length,1);assert.equal(f.pauses.length,0);
});
for(const result of [response({error:{code:'UNAVAILABLE'}},503),invalid(503),new TypeError('network failed')])test('a command or login POST is never retried after an ambiguous failure',async()=>{
  const f=reader([result]);
  if(result instanceof Error||result.json.toString().includes('SyntaxError'))await assert.rejects(f.read('/commands','',headers,{method:'POST',body:'{"action":"collect"}',stage:null}));
  else assert.equal((await f.read('/commands','',headers,{method:'POST',body:'{}',stage:null})).status,503);
  assert.equal(f.calls.length,1);assert.deepEqual(f.pauses,[]);
});
test('Retry-After is obeyed for a short pause and suppresses automatic retries for a longer pause',async()=>{
  const short=reader([response({},503,{'retry-after':'0.5'}),response({ok:true})]);assert.equal((await short.read('/config','',headers)).status,200);assert.deepEqual(short.pauses,[500]);
  for(const value of ['1','30','not-a-date','-1','1x','2026-01-01']){const f=reader([response({},503,{'retry-after':value})]);assert.equal((await f.read('/config','',headers)).status,503);assert.equal(f.calls.length,1);}
  assert.equal(retryDelay(response({},503,{'retry-after':'0'}),0),0);
  assert.equal(retryDelay(response({},503,{'retry-after':'Mon, 02 Feb 2026 02:40:00 GMT'}),Date.parse('Mon, 02 Feb 2026 02:40:00 GMT')),0);
});
test('a retry that cannot fit within the original deadline is not started',async()=>{
  const f=reader([response({},503)],{budget:100});assert.equal((await f.read('/me','',headers)).status,503);assert.equal(f.calls.length,1);
});
for(const phase of ['headers','body'])test(`identity timeout during ${phase} preserves the timeout distinction and does not retry`,async()=>{
  const timeout=Object.assign(new Error('private timeout details'),{name:'TimeoutError'}),result=phase==='headers'?()=>{throw timeout;}:({...response({}),json:async()=>{throw timeout;}}),f=reader([result]);
  const reply=await f.read('/me','',headers,{stage:'identity'});assert.equal(reply.status,504);assert.equal(reply.data.error.stage,'identity');assert.equal(f.calls.length,1);
  assert.equal(f.logs[0].errorClass,'timeout');assert.doesNotMatch(JSON.stringify(f.logs),/private timeout/);
});
test('diagnostics use route templates and expose no request identity or query',()=>{
  assert.equal(routeLabel('/admin/customer-view/companies/cmp_private/collection'),'/admin/customer-view/companies/:id/collection');
  assert.equal(routeLabel('/regions/region-private/analysis'),'/regions/:id/analysis');assert.equal(routeLabel('/admin/customers/cus_private/commands'),'/admin/customers/:id/commands');
});
test('failed identity retries do not release an authorized prior snapshot and share the public correlation id',async t=>{
  let unavailable=false;const logs=[],identity={customer:{customerId:'fixture',accountStatus:'active',revision:1,relations:[{companyId:'cmp_fixture',kind:'own',status:'active'}]},companies:[{companyId:'cmp_fixture',rooms:10,version:1}],preparations:[]};
  const server=createConnectedServer({origin:'https://insight.example',backend:'https://central.example',serviceToken:'fixture-service-token-long-enough-for-tests',diagnosticsLogger:entry=>logs.push(entry),fetchImpl:async url=>url.endsWith('/me')?(unavailable?response({error:{code:'CENTRAL_UNAVAILABLE'}},503):response(identity)):response({result:{companyId:'cmp_fixture',version:1,quality:{status:'complete'},products:[]},companyDetail:{companyId:'cmp_fixture',integrated:{status:'ready',selectedMonth:'2026-10'},current:{daily:[]}},request:null})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const request=()=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/customer/v1/companies/cmp_fixture/collection',headers:{Host:'insight.example',Cookie:'__Host-sabun_insight_session=fixture-session'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)}));}).on('error',reject);});
  assert.equal((await request()).status,200);unavailable=true;const denied=await request();assert.equal(denied.status,503);assert.equal(denied.data.result,undefined);assert.equal(denied.headers['set-cookie'],undefined);
  assert.equal(logs.length,2);assert.ok(logs.every(entry=>entry.requestId===denied.headers['x-insight-request-id']));assert.ok(logs.every(entry=>entry.stage==='identity'));
});
test('public and administrator-preview config GETs expose safe timing and correlation headers',async t=>{
  const server=createConnectedServer({origin:'https://insight.example',backend:'https://central.example',serviceToken:'fixture-service-token-long-enough-for-tests',diagnosticsLogger(){},fetchImpl:async()=>response({signupEnabled:true},200,{'server-timing':'state_total;dur=8;desc="private"'})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  for(const requestPath of ['/api/customer/v1/config','/api/insight-admin/v1/customer-view/config']){
    const reply=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:requestPath,headers:{Host:'insight.example'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));}).on('error',reject);});
    assert.equal(reply.status,200);assert.match(reply.headers['x-insight-request-id'],/^[a-z0-9-]{36}$/);assert.match(reply.headers['server-timing'],/upstream_headers;dur=/);assert.match(reply.headers['server-timing'],/state_total;dur=8\.0/);assert.doesNotMatch(reply.headers['server-timing'],/private|desc=/);
  }
});
