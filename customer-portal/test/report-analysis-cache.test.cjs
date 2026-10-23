'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/analysis.js'),'utf8');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const DAY=86400000,base=Date.parse('2026-10-23T00:00:00Z');
function report(ownId='own',value=10,at=base){
 const summary={days:30,reservationRate:.5,publicBookings:value,phoneBookings:0,estimatedRevenue:null};
 return {mode:'current_briefing',published:false,ownId,generatedAt:new Date(at).toISOString(),period:{start:'2026-10-23',end:'2026-11-21',days:30},companies:ownId?[{companyId:ownId,kind:'own',name:'내 매장 '+ownId,rooms:16,summary}]:[],comparisons:[],regions:[],actions:[{title:'행동 확인',reason:'자료 근거',next:'조건 확인',check:'확보율',source:'업체DB'}],definitions:['실제 결제 매출이 아닌 추정입니다.'],responseCache:{state:'fresh',checkedAt:new Date(at).toISOString(),refreshing:false,refreshFailed:false}};
}
function saved(ownId='own',value=10,at=base-2*3600000){return {...report(ownId,value,at),responseCache:{state:'cached',checkedAt:new Date(at).toISOString(),persisted:true,validUntil:new Date(at+7*DAY).toISOString(),revalidationRequired:true,refreshing:false,refreshFailed:false}};}
function harness(){
 let now=base,html='',writes=0,nextTimer=0,expired=0,scope='customer:one',permission='revision1',ownIds=['own','other'],companyIds=['own','other','competitor'],regionKeys=['region'];
 const window={},calls=[],handlers={},timers=new Map(),notice={textContent:'',hidden:true,dataset:{}},button={disabled:false,isConnected:true},select={value:'own'};
 const form={querySelector:()=>button},slot={isConnected:true};Object.defineProperty(slot,'innerHTML',{get:()=>html,set(value){html=value;writes++;}});
 const document={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:s=>({'#analysis-output':slot,'#analysis-form':form,'#analysis-form select':select,'#analysis-freshness':notice}[s]||null)};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 vm.runInContext(source,vm.createContext({window,document,Date:Clock,FormData:class{constructor(){return [['ownId',select.value]];}},setTimeout(fn,ms){timers.set(++nextTimer,{fn,ms});return nextTimer;},clearTimeout(id){timers.delete(id);}}));
 const view=window.InsightAnalysis,request=(path,payload,options)=>new Promise((resolve,reject)=>calls.push({path,payload,options,resolve,reject}));
 const configure=(change={})=>{({scope,permission,ownIds,companyIds,regionKeys}={scope,permission,ownIds,companyIds,regionKeys,...change});view.configureCache({scope,regionKeys});view.configureReports({scope,ownIds,companyIds,regionKeys,permissionVersion:permission,onSessionExpired(){expired++;}});};
 configure();
 return {view,calls,notice,slot,button,select,handlers,timers,configure,html:()=>html,writes:()=>writes,expired:()=>expired,
 mount(ownId='own'){slot.isConnected=true;button.isConnected=true;slot.innerHTML='new page';view.mount('reports',request,{customer:{relations:[]},companies:[],regions:[]},null,ownId);},
 leave(){view.stop();slot.isConnected=false;},change(ownId){select.value=ownId;handlers.change({target:{closest:()=>true}});},advance(ms){now+=ms;},
 restore(data=saved(),ownId='own',restoredScope=scope){view.restoreReports([{ownId,period:data.period,data}],restoredScope);},
 async resolve(index,data){calls[index].resolve(data);await flush();},async reject(index,status,message='조회 실패'){calls[index].reject(Object.assign(Error(message),{status}));await flush();},
 async tick(){const [id,timer]=timers.entries().next().value||[];if(!timer)return;timers.delete(id);timer.fn();await flush();}
 };
}

test('returning to the same authorized report shows the previous report before a background GET resolves',async()=>{
 const h=harness();h.mount();assert.match(h.html(),/계산하고/);await h.resolve(0,report());h.leave();h.mount();
 assert.match(h.html(),/내 매장 own의 다음 판단/);assert.match(h.html(),/10실/);assert.match(h.notice.textContent,/이전 조회 리포트.*확인 중/);assert.equal(h.calls.length,2);assert.equal(h.calls[1].payload,undefined);
 await h.resolve(1,report('own',15));assert.match(h.html(),/15실/);assert.equal(h.notice.hidden,true);
});

test('authenticated restart bootstrap restores an older report with its original generated date before the first GET',async()=>{
 const h=harness(),data=saved();h.restore(data);h.mount();assert.match(h.html(),/내 매장 own의 다음 판단/);assert.match(h.notice.textContent,/이전 저장 리포트 표시.*마지막 확인/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.refresh,false);
 const date=new Date(data.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});assert.ok(h.html().includes(date));assert.match(h.html(),/산출 보류/);assert.doesNotMatch(h.html(),/0원/);
 await h.resolve(0,report('own',20));assert.match(h.html(),/20실/);assert.equal(h.notice.hidden,true);
});

test('identical report data preserves the view while a changed generatedAt updates its visible original check date',async()=>{
 const h=harness();h.mount();await h.resolve(0,report());h.leave();h.mount();const before=h.writes();await h.resolve(1,report());assert.equal(h.writes(),before);
 h.leave();h.mount();const next=report('own',10,base+1000);h.advance(1000);const writes=h.writes();await h.resolve(2,next);assert.equal(h.writes(),writes+1);assert.ok(h.html().includes(new Date(next.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})));
});

test('own-company selection is isolated and late responses cannot overwrite the new report',async()=>{
 const h=harness();h.mount();h.change('other');assert.match(h.html(),/계산하고/);await h.resolve(1,report('other',22));await h.resolve(0,report('own',11));assert.match(h.html(),/내 매장 other의 다음 판단/);assert.doesNotMatch(h.html(),/내 매장 own의 다음 판단/);
 h.leave();h.mount('own');assert.match(h.html(),/11실/);assert.match(h.calls[2].path,/ownId=own/);
});

test('a pending report GET is shared across route departure and return and never starts collection',async()=>{
 const h=harness();h.mount();h.leave();h.mount();assert.equal(h.calls.length,1);await h.resolve(0,report());assert.match(h.html(),/내 매장 own/);assert.ok(h.calls.every(call=>call.path.startsWith('/reports/briefing')&&call.payload===undefined));
});

test('transient refresh failure retains the last good report, unknown revenue and genuine zero counts',async()=>{
 const h=harness(),data=report('own',0);h.mount();await h.resolve(0,data);h.leave();h.mount();await h.reject(1,504);assert.match(h.html(),/0실/);assert.match(h.html(),/산출 보류/);assert.match(h.notice.textContent,/확인 지연.*이전 저장 자료/);
});

test('a server refresh failure keeps the original saved report with a truthful notice and no retry loop',async()=>{
 const h=harness(),data=saved();h.restore(data);h.mount();await h.resolve(0,{...data,responseCache:{...data.responseCache,refreshing:false,refreshFailed:true}});assert.match(h.html(),/내 매장 own/);assert.match(h.notice.textContent,/확인 지연/);assert.equal(h.timers.size,0);
});

test('401 expires the session, clears report state and prevents old bootstrap resurrection',async()=>{
 const h=harness();h.restore();h.mount();await h.reject(0,401);assert.equal(h.expired(),1);assert.match(h.html(),/로그인이 만료/);h.restore();h.mount();assert.doesNotMatch(h.html(),/내 매장 own의 다음 판단/);
});

for(const status of [403,404,409])test(`${status} purges prior reports and same-context restore cannot resurrect a denied report`,async()=>{
 const h=harness();h.restore();h.mount();await h.reject(0,status);assert.match(h.html(),/리포트 조회 권한/);h.restore();h.leave();h.mount();assert.match(h.html(),/계산하고/);assert.equal(h.calls[1].options.refresh,true);
 await h.resolve(1,report('own',44));h.leave();h.mount();assert.match(h.html(),/44실/);
});

test('a different account cannot restore or accept the prior account pending report',async()=>{
 const h=harness();h.restore();h.mount();h.configure({scope:'customer:two'});h.restore(saved(),'own','customer:one');h.mount();assert.match(h.html(),/계산하고/);await h.resolve(1,report('own',77));await h.reject(0,401);assert.match(h.html(),/77실/);assert.equal(h.expired(),0);
});

test('a competitor, region, company review or relation revision change invalidates all prior reports and requests',async()=>{
 for(const change of [{companyIds:['own','other']},{regionKeys:[]},{permission:'reviewed16'},{ownIds:['own']}]){
  const h=harness();h.restore();h.mount();h.configure(change);h.mount();assert.match(h.html(),/계산하고/);await h.resolve(0,report('own',999));assert.doesNotMatch(h.html(),/999실/);await h.resolve(1,report('own',8));assert.match(h.html(),/8실/);
 }
});

test('remove-then-restore registration cannot accept an earlier pending response',async()=>{
 const h=harness();h.mount();h.configure({ownIds:['other'],companyIds:['other']});h.configure({ownIds:['own','other'],companyIds:['own','other','competitor']});h.mount();await h.resolve(0,report('own',999));assert.doesNotMatch(h.html(),/999실/);await h.resolve(1,report('own',6));assert.match(h.html(),/6실/);
});

test('wrong own company, period, published report, unexpected company and unauthorized region never enter the cache',async()=>{
 const candidates=[report('other'),{...report(),period:{start:'2026-10-22',end:'2026-11-20',days:30}},{...report(),period:{...report().period,days:29}},{...report(),published:true},{...report(),mode:'monthly'},{...report(),companies:[...report().companies,{companyId:'secret',kind:'competitor',name:'비공개 업체',summary:{}}]},{...report(),regions:[{region:{id:'secret'},sources:[]}]}];
 for(const data of candidates){const h=harness();h.restore(data);h.mount();assert.match(h.html(),/계산하고/);await h.resolve(0,data);assert.doesNotMatch(h.html(),/내 매장 own의 다음 판단|비공개 업체/);assert.match(h.html(),/리포트가 다릅니다/);}
});

test('normal in-memory report retention expires after 30 minutes without extending repeated checkedAt',async()=>{
 const h=harness(),data=report();h.mount();await h.resolve(0,data);h.advance(29*60000);h.leave();h.mount();await h.resolve(1,data);h.advance(61000);h.leave();h.mount();assert.match(h.html(),/계산하고/);
});

test('persisted validity cannot be forged, expired or pushed into the future',async()=>{
 const baseSaved=saved();for(const metadata of [{validUntil:new Date(base-1).toISOString()},{validUntil:new Date(base+8*DAY).toISOString()},{checkedAt:new Date(base+61000).toISOString()},{revalidationRequired:false},{state:'fresh'}]){
  const h=harness(),data={...baseSaved,responseCache:{...baseSaved.responseCache,...metadata}};h.restore(data);h.mount();assert.match(h.html(),/계산하고/);
 }
});

test('small server clock skew is accepted without altering the original checkedAt or generatedAt',async()=>{
 const h=harness(),data=report('own',10,base+150);h.mount();await h.resolve(0,data);assert.match(h.html(),/내 매장 own의 다음 판단/);assert.ok(h.html().includes(new Date(data.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})));
});

test('Korea-day rollover never relabels yesterday rolling report as today and rejects an in-flight old period',async()=>{
 const h=harness();h.restore();h.mount();h.advance(15*3600000);h.leave();h.mount();assert.match(h.html(),/계산하고/);assert.equal(h.calls.length,2);await h.resolve(0,report('own',999));assert.doesNotMatch(h.html(),/999실/);
 const tomorrow={...report('own',5,base+15*3600000),period:{start:'2026-10-24',end:'2026-11-22',days:30}};await h.resolve(1,tomorrow);assert.match(h.html(),/2026-10-24 ~ 2026-11-22/);
});

test('a pending response crossing Korea midnight triggers the correct new-period GET instead of retaining an old report',async()=>{
 const h=harness();h.restore();h.mount();h.advance(15*3600000);await h.resolve(0,report('own',999));assert.equal(h.calls.length,2);assert.match(h.html(),/계산하고/);assert.doesNotMatch(h.html(),/999실/);
});

test('background report verification uses bounded GET polling and route departure clears its timers',async()=>{
 const h=harness(),data=saved();h.restore(data);h.mount();await h.resolve(0,data);
 for(const delay of [2000,4000,8000,16000]){assert.equal([...h.timers.values()][0].ms,delay);await h.tick();await h.resolve(h.calls.length-1,data);}
 assert.equal(h.calls.length,5);assert.equal(h.timers.size,0);assert.match(h.notice.textContent,/최신 확인에 시간이 걸려/);h.leave();h.mount();await h.resolve(5,data);assert.equal(h.timers.size,1);h.leave();assert.equal(h.timers.size,0);
});

test('explicit cache clearing prevents a previously pending private report from reappearing',async()=>{
 const h=harness();h.restore();h.mount();h.view.clearCache();h.leave();h.mount();assert.equal(h.calls.length,2);await h.resolve(0,report('own',999));assert.doesNotMatch(h.html(),/999실/);await h.resolve(1,report('own',9));assert.match(h.html(),/9실/);
});

test('unregistered customers can restore only their default planning report, not a registered own-company report',async()=>{
 const h=harness();h.configure({ownIds:[],companyIds:[]});h.restore(saved(null), '');h.mount('');assert.match(h.html(),/사업 준비의 다음 판단/);assert.equal(h.calls[0].path,'/reports/briefing');h.restore(saved('own'),'own');assert.doesNotMatch(h.html(),/내 매장 own/);
});

test('default and explicitly selected own report keys are never silently aliased',()=>{
 const h=harness();h.restore(saved(),'');h.mount('own');assert.match(h.html(),/계산하고/);assert.equal(h.calls[0].path,'/reports/briefing?ownId=own');
});

test('no browser storage or persistent authentication is used by report restoration',()=>{
 assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document\.cookie/);
});
