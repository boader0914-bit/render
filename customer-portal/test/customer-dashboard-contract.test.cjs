'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createCustomerOperatingReview}=require('../review/customer-operating/server.cjs');

test('customer dashboard assets load in dependency order and retain existing read-only customer routes',async t=>{
  const server=createCustomerOperatingReview({port:58021,scenario:'mixed'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const read=route=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'GET',headers:{Host:'127.0.0.1:58021'}},res=>{
      let body='';res.on('data',value=>body+=value);res.on('end',()=>resolve({status:res.statusCode,body}));
    });req.on('error',reject);req.end();
  });
  const page=await read('/');assert.equal(page.status,200);
  const model=page.body.indexOf('/comparison-dashboard.js?v=');
  const pair=page.body.indexOf('/comparison-company-pair.js?v=');
  const view=page.body.indexOf('/comparison-dashboard-view.js?v=');
  const workspace=page.body.indexOf('/comparison-view.js?v=');
  assert.ok(model>0&&pair>model&&view>pair&&workspace>view,'dashboard and pair models must be loaded before the view and competition workspace');
  assert.match(page.body,/\/comparison-dashboard\.css\?v=/);
  for(const asset of ['comparison-dashboard.js','comparison-company-pair.js','comparison-dashboard-view.js','comparison-dashboard.css']){
    const result=await read('/'+asset);assert.equal(result.status,200,asset+' is served by the existing Insight static asset boundary');
  }
  const identity=JSON.parse((await read('/api/customer/v1/me')).body);
  const owner=identity.customer.relations.find(row=>row.kind==='own').companyId;
  const selected=identity.customer.relations.filter(row=>row.kind==='competitor').map(row=>row.companyId);
  const response=await read('/api/customer/v1/reports/briefing?ownId='+owner);assert.equal(response.status,200);
  const report=JSON.parse(response.body);
  assert.equal(report.ownId,owner);
  assert.deepEqual(report.companies.map(row=>row.companyId).sort(),[owner,...selected].sort());
  assert.ok(server.reviewCalls.every(row=>row.method==='GET'),'dashboard review must not submit collection or settings commands');
  assert.ok(server.reviewCalls.every(row=>['/api/insight/v1/me','/api/insight/v1/reports/briefing'].includes(row.path)),'dashboard uses only the existing identity and saved briefing reads');
});
