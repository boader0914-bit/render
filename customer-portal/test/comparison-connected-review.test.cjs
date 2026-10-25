'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createReviewConnectedServer}=require('../review/comparison/connected.cjs');
test('actual connected UI review is visibly synthetic, serves the new versioned assets and cannot collect or save',async t=>{
  const server=createReviewConnectedServer({port:58055});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const read=(route,method='GET')=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:'127.0.0.1:58055'}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
  const html=await read('/');assert.equal(html.status,200);assert.match(html.body,/개발 검수용 가상 자료/);assert.match(html.body,/comparison-view\.js\?v=/);
  for(const file of ['/comparison-selection.js','/comparison-view.js','/comparison.css'])assert.equal((await read(file)).status,200);
  const report=await read('/api/customer/v1/reports/briefing?ownId=own-sc');assert.equal(report.status,200);const data=JSON.parse(report.body);assert.equal(data.ownId,'own-sc');assert.equal(data.companies[0].reservationSeries.points.length,30);
  const detail=await read('/api/customer/v1/companies/own-sc/collection');assert.equal(detail.status,200);assert.equal(JSON.parse(detail.body).companyDetail.basics.name,'내 매장 · 산청');
  assert.equal((await read('/api/customer/v1/commands','POST')).status,403);
  const foreign=await read('/api/customer/v1/companies/no-such-fixture/collection');assert.equal(foreign.status,404);
});
