'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ui=require('../web/monthly-reports.js'),customer=require('../customer-portal/web/reports.js');
function fixture(status='draft') {
  const snapshot={actionEvidence:[{id:'summary-lodging:'+ 'a'.repeat(64),label:'숙박 요약'}],request:{month:'2026-09',cutoffDate:'2026-09-30'},target:{label:'검수 업체'},period:{},summary:{},quality:{status:'complete'},sources:{},definitions:{}};
  let report={id:'mr_fixture',status,revision:1,title:'검수 월간',notes:'',version:1,snapshot},calls=[],failed=false;
  const container={innerHTML:'',addEventListener(){},querySelector(){return null;}};
  const api=async(url,method='GET',body)=>{
    calls.push({url,method,body:structuredClone(body)});
    if(url==='/mr_fixture'&&method==='GET')return structuredClone(report);
    if(url===''&&method==='GET')return {reports:[report]};
    if(method==='PATCH'){report={...report,status:body.status,revision:report.revision+1,snapshot:{...snapshot,actionPlan:structuredClone(body.actionPlan)}};return structuredClone(report);}
    if(url.endsWith('/delivery'))return {enabled:true,customers:[{customerId:'cus_a',username:'A'}]};
    if(url.endsWith('/assign')){if(!failed){failed=true;throw Error('응답 확인 필요');}return {created:false};}
    if(url.endsWith('/publish'))return {...report,status:'published'};
    throw Error('Unexpected '+url);
  };
  return {controller:ui.createController(container,api),container,calls,snapshot};
}
test('action editor submits the chosen saved evidence, owner and date without replacing numeric snapshot',async()=>{
  const f=fixture();await f.controller.action('open','mr_fixture');await f.controller.action('add-plan');
  f.controller.input('actionTitle_0','주말 판매 구성 점검');f.controller.input('actionOwner_0','운영자');f.controller.input('actionDueDate_0','2026-10-31');
  f.controller.input('actionRefs_0',[f.snapshot.actionEvidence[0].id]);await f.controller.action('review');
  const p=f.calls.find(x=>x.method==='PATCH').body;
  assert.equal(p.actionPlan.items[0].owner,'운영자');assert.equal(p.actionPlan.items[0].dueDate,'2026-10-31');assert.equal(p.snapshot,undefined);
  assert.deepEqual(p.actionPlan.items[0].evidenceRefs,[f.snapshot.actionEvidence[0].id]);
});
test('row removal and subsequent addition keep unique IDs and the 20 item bound',async()=>{
  const f=fixture();await f.controller.action('open','mr_fixture');
  for(let i=0;i<3;i++)await f.controller.action('add-plan');await f.controller.action('remove-plan','1');await f.controller.action('add-plan');
  assert.equal(new Set(f.controller.state.actionPlan.items.map(i=>i.id)).size,3);
  for(let i=0;i<30;i++)await f.controller.action('add-plan');assert.equal(f.controller.state.actionPlan.items.length,20);
});
test('unsaved plan changes block publication even after a previous quality approval',async()=>{
  const f=fixture('review');await f.controller.action('open','mr_fixture');f.controller.input('qualityAck',true);f.controller.input('actionSummary','새 의견');
  await f.controller.action('publish');assert.equal(f.calls.some(c=>c.url.endsWith('/publish')),false);assert.equal(f.controller.state.acknowledged,false);
});
test('explicit customer assignment reuses its exact intent key after an ambiguous response',async()=>{
  const f=fixture('published');await f.controller.action('open','mr_fixture');await f.controller.action('delivery-options');f.controller.input('deliveryCustomer','cus_a');
  await f.controller.action('assign-report');await f.controller.action('assign-report');
  const posts=f.calls.filter(c=>c.url.endsWith('/assign'));assert.equal(posts.length,2);assert.equal(posts[0].body.requestKey,posts[1].body.requestKey);
  assert.equal(posts[0].body.customerId,'cus_a');assert.match(f.container.innerHTML,/같은 발행본 배정/);
});
test('customer view distinguishes issued reports, missing data and zero and escapes authored action text',()=>{
  const html=customer.detailView({id:'mr_a',version:1,title:'<script>unsafe</script>',month:'2026-09',snapshot:{period:{cutoffDate:'2026-09-30'},summary:{lodging:{publicBookings:0,phoneBookings:null,estimatedRevenue:null}},actionPlan:{summary:'<img>',items:[{title:'<script>',status:'held',owner:'운영자',outcome:'작성자 기록'}]}}},'/api/customer/v1');
  assert.ok(!html.includes('<script>'));assert.match(html,/0 실·박/);assert.match(html,/미확인 실·박/);assert.match(html,/원/);assert.match(html,/\/reports\/mr_a\/pdf/);assert.match(customer.panel(false),/제공 연결을 준비/);assert.match(html,/관측 마감 2026-09-30/);
});
test('opening issued report library defers current briefing calculation until explicit form submission',()=>{
  const listeners={},slot={innerHTML:'',isConnected:true},button={disabled:false,isConnected:true},form={id:'analysis-form',querySelector:()=>button};let calls=0;
  const document={addEventListener:(event,listener)=>{listeners[event]=listener;},querySelector:q=>q==='#analysis-form'?form:slot};
  const context={window:{},document,FormData:class{* [Symbol.iterator](){}},Date,URLSearchParams,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../customer-portal/web/analysis.js'),'utf8'),context);
  context.window.InsightAnalysis.mount('reports',()=>{calls++;return new Promise(()=>{});},{regions:[]},null,{autoLoad:false});
  assert.equal(calls,0);assert.match(slot.innerHTML,/발행본 열람은 새 분석 계산을 시작하지 않습니다/);
  listeners.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});assert.equal(calls,1);
});
