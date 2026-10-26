'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../web/insight-customers.js'),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(rows=[]){
  const handlers={},calls=[],feedback={textContent:''},root={innerHTML:'',addEventListener:(event,fn)=>handlers[event]=fn,querySelector:()=>feedback};
  let fail=false;
  const context={document:{getElementById:()=>root},Intl,Date,crypto,FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key];}},IntersectionObserver:class{constructor(fn){this.fn=fn;}observe(){this.fn([{isIntersecting:true}]);}},fetch:async(url,options)=>{
    calls.push({url,options});
    if(options.method==='POST')return {ok:!fail,json:async()=>fail?{error:{message:'연결 확인 필요'}}:{recurringCollection:rows[0]}};
    return {ok:true,json:async()=>url.endsWith('/recurring-collections')?{recurringCollections:rows}:{customers:[]}};
  }};
  vm.runInNewContext(source,context);
  return {root,handlers,calls,feedback,setFail:value=>fail=value};
}
test('admin sees shared company requests, a truthful uncollected date and escaped names',async()=>{
  const f=fixture([{companyId:'cmp_test',companyName:'<img src=x onerror=alert(1)>',status:'pending',requestCount:2,requesters:[{username:'고객',requestedAt:'2026-10-26T00:00:00Z'}],lastCollectedAt:null,nextRunAt:null}]);
  await settle();
  assert.match(f.root.innerHTML,/검토 대기 1곳/);assert.match(f.root.innerHTML,/요청 2명/);assert.match(f.root.innerHTML,/아직 없음/);assert.match(f.root.innerHTML,/&lt;img/);assert.doesNotMatch(f.root.innerHTML,/<img src=x/);
  assert.equal(f.calls.filter(row=>row.options.method==='POST').length,0,'opening admin must never approve or dispatch');
});
test('review posts fixed policy intent, preserves an ambiguous retry key and rekeys changed decisions',async()=>{
  const f=fixture([{companyId:'cmp_test',status:'pending'}]);await settle();
  const buttons=[{disabled:false}],form={dataset:{insightRecurring:'cmp_test'},values:{reason:'운영 검수',time:'14:00'},querySelectorAll:()=>buttons};
  const event={preventDefault(){},target:form,submitter:{value:'approve'}};
  f.setFail(true);await f.handlers.submit(event);assert.equal(buttons[0].disabled,false);assert.equal(f.feedback.textContent,'연결 확인 필요');
  await f.handlers.submit(event);
  let posts=f.calls.filter(row=>row.options.method==='POST').map(row=>JSON.parse(row.options.body));
  assert.equal(posts[0].requestKey,posts[1].requestKey);assert.equal(posts[0].companyId,'cmp_test');assert.equal(posts[0].decision,'approve');assert.equal(posts[0].time,'14:00');assert.equal(posts[0].workerKey,undefined);assert.equal(posts[0].bookingRangeDays,undefined);
  await f.handlers.submit({...event,submitter:{value:'reject'}});
  posts=f.calls.filter(row=>row.options.method==='POST').map(row=>JSON.parse(row.options.body));assert.notEqual(posts[2].requestKey,posts[1].requestKey);assert.equal(posts[2].time,undefined);
  f.setFail(false);await f.handlers.submit(event);assert.equal(form.dataset.recurringRequestKey,undefined);assert.equal(buttons[0].disabled,false);
});
