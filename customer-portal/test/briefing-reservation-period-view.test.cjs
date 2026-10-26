'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/analysis.js'),'utf8'),AT=Date.parse('2026-10-26T01:00:00Z'),DAY=86400000;
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const canonical=(stayMode='all_available',extra={})=>({stayMode,month:null,start:null,end:null,...extra});
function response(selection=canonical(),{name='가상 매장',amount=1000,refreshing=false,persisted=false}={}){
 const period=selection.stayMode==='all_available'?{start:'2026-09-28',end:'2026-10-04',days:7}:selection.stayMode==='month'?{start:selection.month+'-01',end:selection.month+'-'+(selection.month.endsWith('09')?'30':'31'),days:selection.month.endsWith('09')?30:31}:selection.stayMode==='custom'?{start:selection.start,end:selection.end,days:(Date.parse(selection.end)-Date.parse(selection.start))/DAY+1}:{start:'2026-10-26',end:'2026-11-24',days:30};
 const summary={days:1,observedDays:1,calendarDays:3,missingDays:2,sold:null,publicBookings:null,phoneBookings:null,knownSoldSubtotal:0,knownPublicBookingsSubtotal:0,knownPhoneBookingsSubtotal:0,reservationRate:null,estimatedRevenue:null,knownRevenueSubtotal:amount,revenuePartial:true};
 const rows=[{date:'2026-09-28',quantityStatus:'ready',missing:false,total:10,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0,knownRevenueSubtotal:0,revenuePartial:false,codes:[]},{date:'2026-09-29',quantityStatus:'unknown',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null,knownRevenueSubtotal:null,revenuePartial:true,codes:['QUANTITY_MISSING']},{date:'2026-09-30',quantityStatus:'ready',missing:false,total:10,sold:1,publicBookings:1,phoneBookings:0,estimatedRevenue:null,knownRevenueSubtotal:amount,revenuePartial:true,codes:[]}];
 return {mode:'current_briefing',published:false,ownId:'own',selection,asOf:'2026-10-26',period,availablePeriod:{start:'2026-09-28',end:'2026-10-04',months:['2026-09','2026-10'],scope:selection.stayMode==='all_available'?'all':'selection'},availableMonths:['2026-09','2026-10'],generatedAt:new Date(AT).toISOString(),companies:[{companyId:'own',name,kind:'own',relationStatus:'pending',rooms:10,summary,reservationPeriods:{period,asOf:'2026-10-26',months:[{month:'2026-09',period:{start:'2026-09-28',end:'2026-09-30',days:3},summary,weeks:[{weekStart:'2026-09-28',period:{start:'2026-09-28',end:'2026-09-30',days:3},summary,daily:rows}]}]}}],comparisons:[],regions:[],actions:[],definitions:['업체별 숙박일을 한 번씩 집계합니다.'],dataQuality:{status:'partial',issues:[]},responseCache:{state:'partial',partial:true,checkedAt:new Date(AT).toISOString(),refreshing,refreshFailed:false,calculationStatus:'complete',...(persisted?{persisted:true,revalidationRequired:true,validUntil:new Date(AT+7*DAY).toISOString()}:{})}};
}
function harness(href='https://insight.sabun.co.kr/?stayMode=upcoming30#reports'){
 const calls=[],handlers={},timers=new Map(),notice={dataset:{},hidden:true},button={isConnected:true,disabled:false},own={value:'own'},fields={ownId:'own',stayMode:'all_available',month:'2026-09',start:'2026-09-28',end:'2026-10-04'},slot={isConnected:true,innerHTML:'',querySelectorAll:()=>[]};let timer=0;
 const form={id:'analysis-form',querySelector:selector=>selector==='[name="stayMode"]'?{value:fields.stayMode}:button,querySelectorAll:()=>[]};
 const location=new URL(href),window={location,history:{replaceState(_state,_title,value){const next=new URL(value,location.href);location.href=next.href;}}};
 const document={addEventListener:(type,fn)=>handlers[type]=fn,querySelector:selector=>({'#analysis-output':slot,'#analysis-form':form,'#analysis-form select':own,'#analysis-freshness':notice}[selector]||null)};
 class Clock extends Date{constructor(...args){super(...args.length?args:[AT]);}static now(){return AT;}}
 vm.runInContext(source,vm.createContext({window,document,URL,Date:Clock,FormData:class{constructor(){return Object.entries({...fields,ownId:own.value});}},setTimeout(fn,ms){timers.set(++timer,{fn,ms});return timer;},clearTimeout(id){timers.delete(id);}}));
 const view=window.InsightAnalysis;view.configureCache({scope:'customer:one',regionKeys:[]});view.configureReports({scope:'customer:one',permissionVersion:'v1',ownIds:['own'],companyIds:['own','competitor'],regionKeys:[]});
 const request=(path,payload,options)=>new Promise((resolve,reject)=>calls.push({path,payload,options,resolve,reject}));
 const state={customer:{relations:[{companyId:'own',kind:'own',status:'pending'}]},companies:[{companyId:'own',name:'가상 매장'}],regions:[]};
 return {view,window,calls,slot,fields,notice,timers,html:()=>slot.innerHTML,panel:()=>view.panel('reports',state),mount(){slot.isConnected=true;view.mount('reports',request,state,null,'own');},leave(){view.stop();slot.isConnected=false;},change(values){Object.assign(fields,values);handlers.change({target:{closest:()=>form}});},restore(data){view.restoreReports([{ownId:'own',selection:data.selection,period:data.period,data}],'customer:one');},async resolve(index,data){calls[index].resolve(data);await flush();},async tick(){const [id,t]=timers.entries().next().value||[];if(t){timers.delete(id);t.fn();await flush();}}};
}
test('report controls default to all saved stay dates independently of the shared comparison query',()=>{const h=harness();assert.match(h.panel(),/value="all_available" selected/);h.mount();assert.match(h.calls[0].path,/stayMode=all_available/);assert.doesNotMatch(h.calls[0].path,/stayMode=upcoming30/);assert.equal(h.calls[0].payload,undefined);});
test('a report-specific URL restores a month without inheriting the shared comparison period',()=>{const h=harness('https://insight.sabun.co.kr/?stayMode=upcoming30&briefingStayMode=month&briefingMonth=2026-09#reports');assert.match(h.panel(),/value="month" selected/);assert.match(h.panel(),/name="month"[^>]*value="2026-09" required/);});
test('period selection writes only its prefixed URL fields and preserves unrelated comparison state',()=>{const h=harness();h.mount();h.change({stayMode:'month',month:'2026-09'});assert.match(h.calls[1].path,/stayMode=month&month=2026-09/);assert.equal(h.window.location.searchParams.get('stayMode'),'upcoming30');assert.equal(h.window.location.searchParams.get('briefingStayMode'),'month');assert.equal(h.window.location.searchParams.get('briefingMonth'),'2026-09');});
test('monthly totals remain visible while weekly rows start folded with a plus and daily evidence',()=>{const html=harness().view.reportView(response());assert.match(html,/2026年|2026년 09월 합계/);assert.match(html,/확인된 매출 소계/);assert.match(html,/1,000원/);assert.match(html,/<details class="briefing-reservation-week"[^>]*><summary>/);assert.doesNotMatch(html,/<details[^>]*class="briefing-reservation-week"[^>]* open/);assert.match(html,/펼치기<\/span>.*aria-hidden="true">\+<\/b>/);assert.match(html,/숙박일별 예약·매출/);assert.match(html,/업체 간 매출은 합산하지 않습니다/);});
test('normal zero, missing inventory, and partially known price are distinct in daily rows',()=>{const html=harness().view.reportView(response());assert.match(html,/2026-09-28[\s\S]*?0실[\s\S]*?0원[\s\S]*?정상 관측/);assert.match(html,/2026-09-29[\s\S]*?미확인[\s\S]*?관측 공백 · 미확인/);assert.match(html,/2026-09-30[\s\S]*?1실[\s\S]*?1,000원[\s\S]*?확인된 소계[\s\S]*?금액 미확인/);});
test('unconfirmed money is never manufactured as zero and company totals are not added together',()=>{const r=response(canonical(),{amount:null});r.companies[0].reservationPeriods.months[0].weeks[0].daily=[];r.companies.push({...r.companies[0],companyId:'competitor',kind:'competitor',name:'다른 업체'});const html=harness().view.reportView(r);assert.doesNotMatch(html,/0원/);assert.match(html,/추정매출<\/span><strong class="briefing-unknown">미확인/);assert.equal((html.match(/data-briefing-company=/g)||[]).length,2);});
test('duplicate day and month presentations are shown only once without recomputing the server totals',()=>{const r=response(),m=r.companies[0].reservationPeriods.months[0];m.weeks[0].daily.push({...m.weeks[0].daily[0]});r.companies[0].reservationPeriods.months.push({...m});const html=harness().view.reportView(r);assert.equal((html.match(/data-briefing-month="2026-09"/g)||[]).length,1);assert.equal((html.match(/<th>2026-09-28/g)||[]).length,1);assert.equal((html.match(/1,000원/g)||[]).length,3);});
test('cached all-date results show immediately and revalidation updates them without losing missingness',async()=>{const h=harness(),old=response(canonical(),{amount:1000,refreshing:true,persisted:true});h.restore(old);h.mount();assert.match(h.html(),/1,000원/);await h.resolve(0,old);assert.match(h.notice.textContent,/최신 자료 확인 중/);await h.tick();await h.resolve(1,response(canonical(),{amount:2000}));assert.match(h.html(),/2,000원/);assert.match(h.html(),/관측 공백 · 미확인/);assert.doesNotMatch(h.notice.textContent,/최신 자료 확인 중/);});
test('a slower former period cannot overwrite the newly selected month',async()=>{const h=harness();h.mount();h.change({stayMode:'month',month:'2026-09'});await h.resolve(1,response(canonical('month',{month:'2026-09'}),{name:'선택한 월',amount:2000}));await h.resolve(0,response(canonical(),{name:'이전 전체',amount:9999}));assert.match(h.html(),/선택한 월/);assert.doesNotMatch(h.html(),/이전 전체|9,999원/);});
test('wrong period selection responses and invalid custom dates never replace the selected result',async()=>{const h=harness();h.mount();await h.resolve(0,response(canonical('month',{month:'2026-09'}),{name:'조건 불일치'}));assert.doesNotMatch(h.html(),/조건 불일치/);assert.match(h.html(),/숙박기간과 리포트가 다릅니다/);const count=h.calls.length;h.change({stayMode:'custom',start:'2026-09-30',end:'2026-09-01'});assert.equal(h.calls.length,count);assert.match(h.notice.textContent,/시작일·종료일/);});
test('unobserved ranges retain a truthful empty state rather than a zero-sales month',()=>{const data=response();data.period={start:null,end:null,days:0};data.companies[0].reservationPeriods.months=[];const html=harness().view.reportView(data);assert.match(html,/저장된 관측기간이 없습니다/);assert.match(html,/관측된 자료가 없습니다/);assert.doesNotMatch(html,/>0원|>0실/);});
test('a page departure suppresses completed rendering without discarding the period-isolated cache',async()=>{const h=harness();h.mount();h.leave();await h.resolve(0,response());assert.doesNotMatch(h.html(),/월 합계/);h.mount();assert.match(h.html(),/2026년 09월 합계/);assert.equal(h.calls.length,2);});
test('partial product money stays separate from normal subtotals and leaves total quantities and money unknown',()=>{
 const r=response(),month=r.companies[0].reservationPeriods.months[0],week=month.weeks[0],day=week.daily[1];
 Object.assign(month.summary,{partialConfirmedRevenue:350,partialConfirmedDays:1});
 Object.assign(day,{partialConfirmedRevenue:350,missingReason:'partial_inventory',partialRevenueEvidence:{companyId:'own',runId:'stored_run_1',date:day.date,productType:'lodging',collectedAt:'2026-09-28T01:00:00Z',collectedDate:'2026-09-28',reason:'partial_inventory',amount:350}});
 const html=harness().view.reportView(r),daily=html.match(/<tr class="briefing-missing-day"><th>2026-09-29[\s\S]*?<\/tr>/)?.[0];
 assert.match(html,/확인된 매출 소계<\/span><strong class="briefing-unknown">1,000원/);
 assert.doesNotMatch(html,/1,350원/);
 assert.equal((html.match(/일부 상품 확인금액/g)||[]).length,3);
 assert.equal((html.match(/<strong>350원<\/strong>/g)||[]).length,3);
 assert.match(daily,/미확인<\/td><td>미확인<\/td><td>미확인<span class="briefing-partial-amount">/);
 assert.match(daily,/전체 금액 미확인/);assert.match(daily,/일부 상품 확인 · 전체 미확인/);
 assert.match(daily,/상품 재고 일부 미확인/);assert.match(daily,/전체 객실 수량 미확인/);assert.doesNotMatch(daily,/관측 자료 없음/);assert.match(daily,/저장 근거[\s\S]*수집 번호 stored_run_1/);
 assert.doesNotMatch(daily,/350원<small>확인된 소계|>0실|>0원/);
});
test('a genuine partial product zero is shown without manufacturing a zero total or zero bookings',()=>{
 const r=response(),m=r.companies[0].reservationPeriods.months[0],day=m.weeks[0].daily[1];
 Object.assign(m.summary,{partialConfirmedRevenue:0,partialConfirmedDays:1});
 Object.assign(day,{partialConfirmedRevenue:0,missingReason:'shared_dayuse_unverified'});
 const html=harness().view.reportView(r),row=html.match(/<tr class="briefing-missing-day"><th>2026-09-29[\s\S]*?<\/tr>/)?.[0];
 assert.equal((html.match(/<strong>0원<\/strong>/g)||[]).length,3);
 assert.match(row,/데이유즈 공유 수량 확인 부족/);assert.match(row,/전체 금액 미확인/);assert.doesNotMatch(row,/0실/);
});
test('normal ready days never duplicate their revenue as separate partial money',()=>{
 const r=response(),day=r.companies[0].reservationPeriods.months[0].weeks[0].daily[0];
 Object.assign(day,{partialConfirmedRevenue:900,partialRevenueEvidence:{date:day.date,amount:900,runId:'do_not_show'}});
 const row=harness().view.reportView(r).match(/<tr><th>2026-09-28[\s\S]*?<\/tr>/)?.[0];
 assert.match(row,/0원/);assert.doesNotMatch(row,/일부 상품 확인금액|900원|do_not_show|저장 근거/);
});
test('source issues outside selected stay dates are labelled as reference periods without changing their month',()=>{
 const r=response();r.dataQuality.issues=[{scope:'company',companyId:'own',month:'2026-08',period:{start:'2026-08-01',end:'2026-08-31'},reason:'자료 연결 확인 필요'},{scope:'company',companyId:'own',month:'2026-09',period:{start:'2026-09-28',end:'2026-09-30'},reason:'부분 자료'}];
 const html=harness().view.reportView(r);
 assert.match(html,/2026-08-01 ~ 2026-08-31<small class="briefing-reference-period">참고기간 · 선택 숙박일 범위 밖/);
 assert.equal((html.match(/참고기간 · 선택 숙박일 범위 밖/g)||[]).length,1);
 assert.match(html,/2026-09-28 ~ 2026-09-30<\/td>/);
});
test('unrecognized failure labels never echo server text into the displayed reason',()=>{
 const r=response(),day=r.companies[0].reservationPeriods.months[0].weeks[0].daily[1];
 day.missingReason='<img src=x onerror=alert(1)>';
 const html=harness().view.reportView(r);
 assert.doesNotMatch(html,/src=x|onerror/);assert.match(html,/관측 근거 확인 필요/);
});
