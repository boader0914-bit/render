'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const fixture=require('./fixtures/report-period-fixture.cjs');

function reportView({strategy=true}={}){
  const scope={window:{},document:{addEventListener(){},querySelector(){return null;}},Date,URL,Set,Map,Number,JSON,String,Object,Array};
  scope.fetch=()=>assert.fail('presentation must not access the network');
  scope.localStorage={setItem(){assert.fail('presentation must not write browser storage');}};
  vm.createContext(scope);
  const files=['comparison-readiness.js','comparison-readiness-view.js'];
  if(strategy)files.push('operating-strategy.js','operating-strategy-view.js');
  files.push('analysis.js');
  for(const file of files)vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),scope);
  return scope.window.InsightAnalysis.reportView;
}

test('current briefing renders one source-backed strategy section without replaying generic server actions',()=>{
  const r=fixture.report({stayMode:'all_available'}),before=JSON.stringify(r);
  r.actions=[{title:'OLD_GENERIC_ACTION',reason:'old',next:'old',check:'old',source:'old'}];
  const input=JSON.stringify(r),html=reportView()(r);
  assert.equal((html.match(/data-operating-strategy(?:\s|>)/g)||[]).length,1);
  assert.match(html,/운영 전략과 다음 행동/);
  assert.doesNotMatch(html,/OLD_GENERIC_ACTION/);
  assert.match(html,/2026-09-29/);
  assert.match(html,/수량 미확인|미확인|관측/);
  assert.equal(JSON.stringify(r),input);
  assert.notEqual(before,input,'only the test fixture setup changed');
});

test('a legacy client without the new assets retains its existing action list and safe quantities',()=>{
  const r=fixture.report();
  r.actions=[{title:'기존 검토 항목',reason:'관측 공백',next:'저장 근거 확인',check:'유효 관측일',source:'업체DB'}];
  const html=reportView({strategy:false})(r);
  assert.match(html,/기존 검토 항목/);
  assert.doesNotMatch(html,/data-operating-strategy/);
  assert.match(html,/미확인/);
});

test('published archive rendering remains separate from current strategy calculation',()=>{
  const source=fs.readFileSync(require.resolve('../web/archive.js'),'utf8');
  assert.doesNotMatch(source,/InsightOperatingStrategy|operating-strategy/);
  assert.match(source,/보관 당시의 고정 자료/);
});

function cacheHarness(){
  const pending=[],timers=new Map(),button={disabled:false,isConnected:true},select={value:'own'},notice={textContent:'',hidden:true,dataset:{}},slot={innerHTML:'',isConnected:true};
  const form={id:'analysis-form',querySelector:()=>button},handlers={};let timerId=0;
  class Clock extends Date{constructor(...args){super(...(args.length?args:[fixture.NOW]));}static now(){return fixture.NOW;}}
  const scope={window:{location:{href:'http://127.0.0.1/?briefingStayMode=all_available#reports'}},document:{addEventListener:(name,fn)=>handlers[name]=fn,querySelector:selector=>({'#analysis-output':slot,'#analysis-form':form,'#analysis-form select':select,'#analysis-freshness':notice}[selector]||null)},Date:Clock,URL,Set,Map,Number,JSON,String,Object,Array,FormData:class{constructor(){return [['ownId','own'],['stayMode','all_available']];}},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}};
  vm.createContext(scope);
  for(const file of ['comparison-readiness.js','operating-strategy.js','operating-strategy-view.js','analysis.js'])vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),scope);
  const view=scope.window.InsightAnalysis,request=(route,payload,options)=>new Promise((resolve,reject)=>pending.push({route,payload,options,resolve,reject}));
  view.configureReports({scope:'customer:test',ownIds:['own'],companyIds:['own'],regionKeys:[]});
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
  return {view,slot,notice,pending,mount(){slot.isConnected=true;view.mount('reports',request,{customer:{relations:[]},companies:[],regions:[]});},leave(){view.stop();},async resolve(i,value){pending[i].resolve(value);await flush();},async reject(i){pending[i].reject(Object.assign(Error('transport unavailable'),{status:503}));await flush();},async tick(){const [id,fn]=timers.entries().next().value||[];assert.ok(fn,'expected a scheduled read-only check');timers.delete(id);fn();await flush();},submit(){handlers.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});}};
}
const cachedReport=extra=>({...fixture.report(),responseCache:{state:'cached',checkedAt:new Date(fixture.NOW).toISOString(),refreshing:false,refreshFailed:false,...extra}});

test('refresh state alone redraws strategy status while the same saved facts remain visible',async()=>{
  const h=cacheHarness();h.mount();await h.resolve(0,cachedReport({refreshing:true}));
  assert.match(h.slot.innerHTML,/최신 근거 확인 중/);assert.match(h.slot.innerHTML,/2026-09-29/);
  await h.tick();await h.resolve(1,cachedReport({refreshFailed:true}));
  assert.match(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  assert.doesNotMatch(h.slot.innerHTML,/최신 근거 확인 중/);
  assert.match(h.slot.innerHTML,/2026-09-29/);
  h.submit();await h.resolve(2,cachedReport({refreshFailed:true,refreshing:true}));
  assert.match(h.slot.innerHTML,/최신 근거 확인 중/,'an active retry supersedes a historical failure notice');
  assert.doesNotMatch(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  await h.tick();await h.resolve(3,cachedReport({}));
  assert.doesNotMatch(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  assert.match(h.slot.innerHTML,/저장된 관측 근거 기준/);
});

test('a transport failure marks visible strategies for review without changing the cached normal report',async()=>{
  const h=cacheHarness(),normal=cachedReport({});h.mount();await h.resolve(0,normal);h.leave();h.mount();await h.reject(1);
  assert.match(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  assert.match(h.slot.innerHTML,/2026-09-29/);
  assert.equal(normal.responseCache.refreshFailed,false,'the response input remains unchanged');
  h.leave();h.mount();
  assert.doesNotMatch(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/,'the stored normal report was not replaced with the failed presentation');
  await h.resolve(2,cachedReport({}));
  assert.doesNotMatch(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  assert.ok(h.pending.every(r=>r.route.startsWith('/reports/briefing')&&r.payload===undefined),'checks never call collection or settings mutations');
});

test('a pending or failed newer preview updates strategy state while completed facts and their original timestamp survive',async()=>{
  const h=cacheHarness(),normal=cachedReport({});h.mount();await h.resolve(0,normal);h.submit();
  const pending={...cachedReport({state:'preview',preview:true,refreshing:true,refreshFailed:false,calculationStatus:'pending'}),calculation:{mode:'saved_only',status:'pending'}};
  await h.resolve(1,pending);
  assert.match(h.slot.innerHTML,/최신 근거 확인 중/);
  assert.doesNotMatch(h.slot.innerHTML,/저장 자료 미리보기 · 계산 확인 중 · 제안 보류/,'completed facts are not relabeled as a preview');
  assert.match(h.slot.innerHTML,/2026-09-29/);
  await h.tick();
  const code='REPORT_CALCULATION_TIMEOUT',message='최신 리포트 계산이 지연되고 있습니다. 저장 자료를 유지합니다. 다시 확인해 주세요.';
  const failed={...pending,calculation:{mode:'saved_only',status:'failed',errorCode:code,errorMessage:message},responseCache:{...pending.responseCache,refreshing:false,refreshFailed:true,calculationStatus:'failed',refreshErrorCode:code,refreshErrorMessage:message}};
  await h.resolve(2,failed);assert.match(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
  assert.match(h.slot.innerHTML,/2026-09-29/);
  assert.equal(normal.responseCache.refreshFailed,false);
  h.submit();await h.resolve(3,cachedReport({}));
  assert.doesNotMatch(h.slot.innerHTML,/최신 확인 지연 · 저장된 근거 기준/);
});

test('new model, view and styles are versioned public assets and do not call DataLab',async t=>{
  const {createConnectedServer}=require('../connected-server.cjs');
  const server=createConnectedServer({origin:'http://127.0.0.1:58058',backend:'https://saved-source.invalid',serviceToken:'local-test-service-token',fetchImpl:async()=>assert.fail('static assets must not call DataLab')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const read=route=>new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port:server.address().port,path:route,headers:{Host:'127.0.0.1:58058'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);
  });
  const page=await read('/');assert.equal(page.status,200);
  for(const name of ['operating-strategy.js','operating-strategy-view.js','operating-strategy.css']){
    const match=page.body.match(new RegExp('(?:src|href)="(/'+name.replaceAll('.','\\.')+'\\?v=[a-f0-9]{64})"'));
    assert.ok(match,'versioned asset: '+name);
    const asset=await read(match[1]);assert.equal(asset.status,200);assert.match(asset.headers['cache-control'],/immutable/);
  }
  assert.ok(page.body.indexOf('/comparison-readiness.js')<page.body.indexOf('/operating-strategy.js'));
  assert.ok(page.body.indexOf('/operating-strategy.js')<page.body.indexOf('/operating-strategy-view.js'));
  assert.ok(page.body.indexOf('/operating-strategy-view.js')<page.body.indexOf('/analysis.js'));
});
