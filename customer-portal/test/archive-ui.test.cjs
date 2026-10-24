'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/archive.js'),'utf8');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const daily=()=>({id:'daily-review-opaque',kind:'daily-review',createdAt:'2026-10-24T01:00:00Z',period:{start:'2026-10-01',end:'2026-10-31'},identity:{companyId:'cmp_one',calculationVersion:'integrated-v3',runIds:['run_one']},metadata:{reviewStatus:'partial',title:'내 매장 검수'},payload:{companyId:'cmp_one',review:{status:'partial'},summary:{publicBookings:0,phoneBookings:null,estimatedRevenue:null},provenance:{companyId:'cmp_one',calculationVersion:'integrated-v3',runIds:['run_one']},daily:[{date:'2026-10-01',publicBookings:0,phoneBookings:0,estimatedRevenue:0,sourceObservation:{runId:'run_one'}},{date:'2026-10-02',missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}]}});
function harness(){
  const window={},handlers={},calls=[],button={disabled:true,isConnected:true},reviewButton={disabled:true,isConnected:true};let expired=0,root,requestKeys=0;
  const list={innerHTML:'',isConnected:true},detail={innerHTML:'',isConnected:true},notice={textContent:'',isConnected:true},filter={value:'',id:'archive-kind',isConnected:true};
  const form={id:'archive-publish-form',isConnected:true,values:[['reportType','weekly'],['anchorDate','2026-10-24'],['ownId','cmp_one']],querySelector:()=>button};
  const reviewForm={id:'archive-review-form',isConnected:true,values:[['companyId','cmp_one'],['month','2026-09']],querySelector:()=>reviewButton};
  const makeRoot=()=>({innerHTML:'',isConnected:true,querySelector:selector=>({'#archive-list':list,'#archive-detail':detail,'#archive-notice':notice,'#archive-kind':filter,'#archive-publish-form':form,'#archive-review-form':reviewForm}[selector]||null),contains:element=>element?.owner===root});
  const document={addEventListener:(kind,fn)=>(handlers[kind]||=[]).push(fn),querySelector:()=>root};
  const context=vm.createContext({window,document,crypto:{randomUUID:()=> 'request-uuid-'+(++requestKeys)},FormData:class{constructor(target){return target.values;}}});
  vm.runInContext(source,context);
  const request=(path,payload)=>new Promise((resolve,reject)=>calls.push({path,payload,resolve,reject}));
  const event=(kind,target)=>{const e={target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};for(const handler of handlers[kind]||[]){handler(e);if(e.stopped)break;}return e;};
  return {view:window.InsightArchives,calls,button,reviewButton,list,detail,notice,filter,form,reviewForm,expired:()=>expired,
    mount(){if(root)root.isConnected=false;root=makeRoot();list.innerHTML='';detail.innerHTML='';notice.textContent='';button.disabled=true;window.InsightArchives.mount(request,{onSessionExpired(){expired++;}});},
    leave(){window.InsightArchives.stop();},
    open(id){return event('click',{owner:root,dataset:{archiveOpen:id},closest(){return this;}});},
    page(offset,disabled=false){return event('click',{owner:root,disabled,dataset:{archivePage:String(offset)},closest(){return this;}});},
    submit(){return event('submit',form);},capture(){return event('submit',reviewForm);},change(value){filter.value=value;return event('change',filter);},
    async resolve(index,data){calls[index].resolve(data);await flush();},async reject(index,status,message='연결 실패'){calls[index].reject(Object.assign(Error(message),{status}));await flush();}
  };
}

test('archive panel is separate from current briefing and publishes only a period selection',()=>{
  const h=harness(),html=h.view.panel({customer:{relations:[{kind:'own',status:'active',companyId:'cmp_one'}]},companies:[{companyId:'cmp_one',name:'내 매장 <script>'}]});
  assert.match(html,/보관한 자료/);assert.match(html,/선택 숙박기간의 보관된 검수 자료/);assert.match(html,/name="reportType"/);assert.match(html,/name="anchorDate"/);assert.match(html,/발행본 보관/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/수집하기|name="estimatedRevenue"|name="summary"/);
});

test('mount only reads immutable archive metadata and enables publishing after enabled confirmation',async()=>{
  const h=harness();h.mount();assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/archives');assert.equal(h.calls[0].payload,undefined);assert.equal(h.button.disabled,true);
  await h.resolve(0,{enabled:true,records:[daily()]});assert.equal(h.button.disabled,false);assert.match(h.list.innerHTML,/내 매장 검수/);assert.match(h.list.innerHTML,/2026-10-01 ~ 2026-10-31/);assert.match(h.list.innerHTML,/일부 자료/);assert.match(h.list.innerHTML,/cmp_one/);assert.match(h.list.innerHTML,/run_one/);assert.match(h.list.innerHTML,/integrated-v3/);
});

test('an unconfigured archive never offers a POST or fabricates an empty valid archive',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:false,records:[]});assert.equal(h.button.disabled,true);assert.match(h.list.innerHTML,/저장소 연결/);h.submit();await flush();assert.equal(h.calls.length,1);
});

test('filter uses the strict hyphenated archive kind and never collects',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});const event=h.change('daily-review');assert.equal(event.stopped,true);assert.equal(h.calls[1].path,'/archives?kind=daily-review');assert.equal(h.calls[1].payload,undefined);
  await h.resolve(1,{enabled:true,records:[]});assert.match(h.list.innerHTML,/아직 보관한 자료/);
});

test('record read displays a frozen table with real zeros distinct from missing rows and includes source linkage',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[daily()]});h.open('opaque/id');assert.equal(h.calls[1].path,'/archives/opaque%2Fid');await h.resolve(1,{record:daily()});
  assert.match(h.detail.innerHTML,/보관 당시의 고정 자료/);assert.match(h.detail.innerHTML,/2026-10-01/);assert.match(h.detail.innerHTML,/>0원</);assert.match(h.detail.innerHTML,/2026-10-02/);assert.match(h.detail.innerHTML,/미확인/);assert.match(h.detail.innerHTML,/run_one/);assert.match(h.detail.innerHTML,/integrated-v3/);
  const unknown=h.detail.innerHTML.slice(h.detail.innerHTML.lastIndexOf('<tr>'));assert.doesNotMatch(unknown,/>0원</);
});

test('two selected records cannot overwrite the latest selected detail out of order',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[daily()]});h.open('one');h.open('two');await h.resolve(2,{record:{...daily(),metadata:{title:'두번째 결과'}}});await h.resolve(1,{record:{...daily(),metadata:{title:'과거 요청'}}});assert.match(h.detail.innerHTML,/두번째 결과/);assert.doesNotMatch(h.detail.innerHTML,/과거 요청/);
});

test('explicit publication submits only allowlisted scope fields with a new request key and labels partial results',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});h.form.values.push(['estimatedRevenue','99999'],['summary','forged']);const event=h.submit();assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(h.button.disabled,true);
  assert.equal(h.calls[1].path,'/archives/reports');assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].payload)),{reportType:'weekly',anchorDate:'2026-10-24',requestKey:'request-uuid-1',ownId:'cmp_one'});
  h.submit();assert.equal(h.calls.length,2,'a second click cannot start a duplicate request');
  await h.resolve(1,{created:true,record:{...daily(),kind:'published-report',payload:{mode:'archived_period_report',companies:[daily().payload],quality:{status:'partial'}}}});assert.match(h.notice.textContent,/일부 자료 발행본/);assert.match(h.detail.innerHTML,/일부 자료/);assert.equal(h.button.disabled,false);assert.equal(h.calls[2].path,'/archives');
});

test('unknown write completion tells the customer to verify the list and never retries a POST automatically',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});h.submit();await h.reject(1,504);assert.match(h.notice.textContent,/완료 여부를 확인하지 못했습니다.*목록/);assert.equal(h.calls.length,2);assert.equal(h.button.disabled,false);
});

test('navigation and account remount discard pending archive records and obsolete authentication failures',async()=>{
  const h=harness();h.mount();h.leave();h.mount();await h.resolve(1,{enabled:true,records:[{...daily(),metadata:{title:'새 계정'}}]});await h.resolve(0,{enabled:true,records:[{...daily(),metadata:{title:'이전 계정 비공개'}}]});assert.match(h.list.innerHTML,/새 계정/);assert.doesNotMatch(h.list.innerHTML,/이전 계정/);
  h.change('daily-review');h.leave();h.mount();await h.resolve(3,{enabled:true,records:[]});await h.reject(2,401);assert.equal(h.expired(),0);assert.match(h.list.innerHTML,/아직 보관한 자료/);
});

test('a current 401 expires the session and removes private archive references',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[daily()]});h.open('one');await h.reject(1,401);assert.equal(h.expired(),1);h.submit();assert.equal(h.calls.length,2);
});

test('untrusted names, error messages and source references are escaped rather than executed',async()=>{
  const h=harness(),record=daily();record.metadata.title='<img onerror=alert(1)>';record.identity.runIds=['<script>'];record.payload.daily[0].sourceObservation.runId='<svg onload=evil>';
  const list=h.view.listView([record]),detail=h.view.detailView(record);assert.match(list,/&lt;img/);assert.match(list,/&lt;script&gt;/);assert.doesNotMatch(list,/<img|<script>/);assert.match(detail,/&lt;svg/);assert.doesNotMatch(detail,/<svg/);
  h.mount();await h.reject(0,503,'<script>bad</script>');assert.match(h.list.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.list.innerHTML,/<script>/);
});

test('publication metadata and company payload arrays show exact central versions separately from the publication version',()=>{
  const h=harness(),link={companyId:'cmp_one',month:'2026-09',calculationVersion:'central-v7',runIds:['central-run-1','central-run-2']};
  const record={...daily(),kind:'published-report',identity:{companyIds:['cmp_one'],calculationVersion:'insight-period-publication-v1',sourceLinks:[link],sourceArchives:[{id:'source-archive-1'}]},payload:{companies:[{companyId:'cmp_one',name:'내 매장',provenance:[link],summary:{partial:true,knownSold:4,knownEstimatedRevenue:350000,observedDays:2,expectedDays:7},daily:[]}],quality:{status:'partial'}}};
  for(const html of [h.view.listView([record]),h.view.detailView(record)]){assert.match(html,/중앙 계산 버전/);assert.match(html,/central-v7/);assert.match(html,/central-run-1, central-run-2/);assert.match(html,/insight-period-publication-v1/);assert.match(html,/source-archive-1/);assert.match(html,/2026-09/);}
  const html=h.view.detailView(record);assert.match(html,/확인된 일부 자료: 예약 4실/);assert.match(html,/350,000원/);assert.match(html,/확보 2 \/ 7일/);
});

test('metadata-only publish success loads the frozen record instead of presenting an empty result as a completed report',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});h.submit();const {payload,...metadata}=daily();await h.resolve(1,{created:true,record:{...metadata,kind:'published-report'}});
  assert.equal(h.calls[2].path,'/archives/daily-review-opaque');assert.equal(h.calls[3].path,'/archives');assert.match(h.detail.innerHTML,/불러오고 있습니다/);assert.doesNotMatch(h.detail.innerHTML,/보관된 날짜별 자료가 없습니다/);
  await h.resolve(2,{record:{...daily(),kind:'published-report'}});assert.match(h.detail.innerHTML,/2026-10-01/);assert.match(h.detail.innerHTML,/run_one/);
});

test('review capture is an explicit company-month saved-data request, allows competitor choices and opens metadata-only success',async()=>{
  const h=harness(),html=h.view.panel({customer:{relations:[{kind:'own',status:'active',companyId:'cmp_one'},{kind:'competitor',status:'pending',companyId:'cmp_two'}]},companies:[{companyId:'cmp_one',name:'내 매장'},{companyId:'cmp_two',name:'경쟁업체'}]});assert.match(html,/업체·월 검수 결과 보관/);assert.match(html,/name="companyId"/);assert.match(html,/name="month"/);assert.match(html,/cmp_two/);
  h.mount();await h.resolve(0,{enabled:true,records:[]});assert.equal(h.reviewButton.disabled,false);h.reviewForm.values.push(['force','true'],['estimatedRevenue','999999']);h.capture();assert.equal(h.reviewButton.disabled,true);assert.equal(h.button.disabled,true);assert.equal(h.calls[1].path,'/archives/reviews');assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].payload)),{companyId:'cmp_one',month:'2026-09'});
  const {payload,...record}=daily();await h.resolve(1,{status:'stored',record,created:true});assert.equal(h.calls[2].path,'/archives/daily-review-opaque');assert.equal(h.calls[3].path,'/archives');assert.match(h.notice.textContent,/일부 검수 결과/);await h.resolve(2,{record:daily()});assert.match(h.detail.innerHTML,/run_one/);assert.equal(h.reviewButton.disabled,false);
});

test('pending or unreviewable saved data is not reported as a successful daily archive',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});h.capture();await h.resolve(1,{status:'needs_review',reason:'ARCHIVE_SOURCE_NOT_REVIEWABLE'});assert.match(h.notice.textContent,/정상 검수 자료가 아직 준비되지/);assert.equal(h.calls.length,2);assert.doesNotMatch(h.notice.textContent,/보관했습니다/);assert.equal(h.reviewButton.disabled,false);
});

test('same-intent retry after unknown completion reuses its request key, success or intent change creates a new key',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,records:[]});h.submit();await h.reject(1,503);const key=h.calls[1].payload.requestKey;h.submit();assert.equal(h.calls[2].payload.requestKey,key);assert.equal(h.calls.length,3,'there is no automatic retry');
  await h.resolve(2,{created:false,record:daily()});h.submit();assert.notEqual(h.calls[4].payload.requestKey,key);await h.reject(4,504);const previous=h.calls[4].payload.requestKey;h.form.values[1][1]='2026-10-25';h.submit();assert.notEqual(h.calls[5].payload.requestKey,previous);
});

test('a stored row that failed quantity or revenue validation is never presented as a valid zero',()=>{
  const h=harness(),record=daily();record.payload.daily=[{date:'2026-10-01',publicBookings:0,phoneBookings:0,estimatedRevenue:0,review:{quantityReviewed:false,revenueReviewed:false,reason:'SOURCE_LINK_MISSING'}}];
  const html=h.view.detailView(record),row=html.slice(html.lastIndexOf('<tr>'));assert.match(row,/원본 연결 미확인/);assert.match(row,/미확인/);assert.doesNotMatch(row,/>0원</);assert.doesNotMatch(row,/>0</);
});

test('bounded pagination exposes records beyond the first hundred and preserves the selected kind',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,total:205,records:[daily()]});assert.match(h.list.innerHTML,/data-archive-page="100"/);assert.match(h.list.innerHTML,/205건/);
  h.change('daily-review');await h.resolve(1,{enabled:true,total:205,records:[daily()]});h.page(100);assert.equal(h.calls[2].path,'/archives?kind=daily-review&limit=100&offset=100');await h.resolve(2,{enabled:true,total:205,records:[{...daily(),metadata:{title:'오래된 자료'}}]});assert.match(h.list.innerHTML,/오래된 자료/);
  h.page(200);assert.equal(h.calls[3].path,'/archives?kind=daily-review&limit=100&offset=200');await h.resolve(3,{enabled:true,total:205,records:[daily()]});assert.match(h.list.innerHTML,/data-archive-page="300" disabled/);
  h.page(100);assert.equal(h.calls[4].path,'/archives?kind=daily-review&limit=100&offset=100');
  h.change('published-report');assert.equal(h.calls[5].path,'/archives?kind=published-report');await h.resolve(5,{enabled:true,total:1,records:[{...daily(),metadata:{title:'새 종류'}}]});await h.resolve(4,{enabled:true,total:205,records:[{...daily(),metadata:{title:'이전 종류 비공개'}}]});assert.match(h.list.innerHTML,/새 종류/);assert.doesNotMatch(h.list.innerHTML,/이전 종류/);
});

test('pagination ignores invalid, outside-range and disabled offsets without issuing another request',async()=>{
  const h=harness();h.mount();await h.resolve(0,{enabled:true,total:205,records:[daily()]});for(const [offset,disabled]of [[-100,false],[1,false],[300,false],['NaN',false],[100,true]])h.page(offset,disabled);assert.equal(h.calls.length,1);
});

test('an enabled but unavailable archive disables both writes and shows storage errors instead of a valid empty list',async()=>{
  for(const code of ['ARCHIVE_LOW_SPACE','ARCHIVE_UNSAFE_PATH']){
    const h=harness();h.mount();await h.resolve(0,{enabled:true,total:0,records:[],status:{available:false,lastError:code}});assert.equal(h.button.disabled,true);assert.equal(h.reviewButton.disabled,true);assert.match(h.list.innerHTML,/디스크/);assert.ok(h.list.innerHTML.includes(code));assert.doesNotMatch(h.list.innerHTML,/아직 보관한 자료가 없습니다/);h.submit();h.capture();assert.equal(h.calls.length,1);
  }
});
