'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {getScenario}=require('../review/comparison/fixtures.cjs');
const {createReviewServer}=require('../review/comparison/server.cjs');
test('same, cross and mixed review cases use the actual shared policy and remain synthetic for either own property',()=>{
  for(const ownId of ['own-sc','own-gp'])for(const scenario of ['same','cross','mixed']){
    const data=getScenario({scenario,ownId});assert.equal(data.fixture,true);assert.match(data.label,/가상/);
    assert.equal(data.comparisonSet.regionMode,scenario);assert.equal(data.comparisonSet.comparisons.length,3);
    assert.ok(data.comparisonSet.comparisons.every(c=>c.commonDays===29));
    assert.ok(data.comparisonSet.comparisons.filter(c=>c.regionRelation==='cross').every(c=>c.actionable===false));
    assert.equal(data.own.days[3].sold,0);assert.equal(data.own.days[8].sold,null);
    assert.deepEqual(data.competitors.map(c=>c.companyId),data.selectionContext.authorizedComparisonIdsByOwn[ownId]);
  }
});
test('historical September uses its cutoff while incomplete prices retain quantity comparisons',()=>{
  const data=getScenario({scenario:'mixed',start:'2026-09-01',end:'2026-09-30',asOf:'2026-09-30'});
  assert.equal(data.rules.mode,'historical');assert.equal(data.comparisonSet.comparisons[0].commonDays,29);
  const partial=data.comparisonSet.comparisons.find(c=>c.companyId==='sc-pool');assert.equal(partial.comparable,true);assert.equal(partial.quality.revenue.status,'partial');
  assert.ok(partial.competitor.knownRevenueSubtotal>0);assert.equal(partial.competitor.estimatedRevenue,null);
  assert.ok(data.own.days.every(d=>d.collectedAt.slice(0,10)<='2026-09-30'));
  for(const value of [{start:'2026-02-30'},{start:'2026-12-01',end:'2026-11-01'},{asOf:'2026-10-26'},{scenario:'__proto__'},{ownId:'other-customer'}])assert.throws(()=>getScenario(value));
});
test('local review serves a bounded allowlist and rejects writes, remote Host and collection routes',async t=>{
  const server=createReviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(pathname,method='GET',host='127.0.0.1')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:pathname,method,headers:{Host:host}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();});
  const page=await request('/');assert.equal(page.status,200);assert.match(page.body,/가상 자료/);assert.match(page.headers['content-security-policy'],/connect-src 'self'/);
  assert.equal((await request('/comparison-selection.js')).status,200);
  assert.equal((await request('/api/scenario?scenario=cross')).status,200);
  assert.equal((await request('/api/scenario?scenario=same&scenario=mixed')).status,400);
  assert.equal((await request('/api/scenario?token=secret')).status,400);
  assert.equal((await request('/api/scenario','POST')).status,405);
  assert.equal((await request('/','GET','attacker.invalid')).status,403);
  for(const pathname of ['/api/crawl','/api/customer/v1/commands','/../../scripts/glamping_app_server.cjs','/fixtures.cjs','/server.cjs'])assert.equal((await request(pathname)).status,404);
});
