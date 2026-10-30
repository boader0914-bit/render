'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/collection.js'),'utf8');
function harness(){
  let now=Date.parse('2026-10-30T10:00:00Z'),expired=0;
  const window={},calls=[],timers=[],elements=new Map();
  const document={addEventListener(){},querySelector(selector){return elements.get(selector)||null;}};
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  vm.runInContext(source,vm.createContext({window,document,Date:ClockDate,setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){}}));
  const request=(path,data,options)=>new Promise((resolve,reject)=>calls.push({path,data,options,resolve,reject}));
  return {collection:window.InsightCollection,calls,timers,elements,request,
    context(scope='customer-one',ids=['a','b']){window.InsightCollection.setContext(scope,ids,()=>expired++);},
    expired:()=>expired,advance(ms){now+=ms;}};
}
function payload(id='a',month='2026-10',version='v1'){
  return {result:{companyId:id,runId:'run-'+version,version,products:[]},request:null,companyDetail:{companyId:id,basics:{companyId:id},integrated:{selectedMonth:month,status:'ready',snapshot:{analysis:{pickup:{status:'no_increase',intervals:[]}}}}},responseCache:{state:'cached',checkedAt:'2026-10-30T09:59:00Z',refreshing:false}};
}
const error=status=>Object.assign(new Error('read failed'),{status});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('saved access is inert on module load and only uses the existing GET without mounting or timers',async()=>{
  const h=harness();assert.equal(h.calls.length,0);assert.equal(h.timers.length,0);h.context();
  assert.equal(h.collection.peekSaved('a','2026-10'),null);
  const read=h.collection.readSaved('a',h.request,{month:'2026-10'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/companies/a/collection?month=2026-10');assert.equal(h.calls[0].data,undefined);assert.equal(h.calls[0].options.refresh,false);
  h.calls[0].resolve(payload());const result=await read;assert.equal(result.result.version,'v1');assert.equal(h.collection.peekSaved('a','2026-10').result.version,'v1');assert.equal(h.timers.length,0);
  result.result.version='outside';const peek=h.collection.peekSaved('a','2026-10');assert.equal(peek.result.version,'v1');peek.companyDetail.basics.companyId='outside';assert.equal(h.collection.peekSaved('a','2026-10').companyDetail.basics.companyId,'a');
});
test('same company/month reads share one pending GET and explicit refresh remains a GET',async()=>{
  const h=harness();h.context();const first=h.collection.readSaved('a',h.request,{month:'2026-10'}),second=h.collection.readSaved('a',h.request,{month:'2026-10'});
  assert.equal(h.calls.length,1);h.calls[0].resolve(payload());await Promise.all([first,second]);
  const fresh=h.collection.readSaved('a',h.request,{month:'2026-10',force:true});assert.equal(h.calls[1].options.refresh,true);assert.equal(h.calls[1].data,undefined);h.calls[1].resolve(payload('a','2026-10','fresh'));await fresh;
});
test('only an explicit permitted company and a valid month can start a read',async()=>{
  const h=harness();await assert.rejects(h.collection.readSaved('a',h.request),{code:'ACCESS_DENIED',status:403});h.context();
  await assert.rejects(h.collection.readSaved('other',h.request),{code:'ACCESS_DENIED'});
  for(const month of ['2026-99','2026-10&force=1',null])await assert.rejects(h.collection.readSaved('a',h.request,{month}),{code:'INVALID_COMPANY_MONTH'});
  assert.equal(h.calls.length,0);assert.equal(h.collection.peekSaved('other'),null);assert.equal(h.collection.peekSaved('a','2026-99'),null);
});
test('scope switch, invalidation and registration removal discard late responses without caching',async()=>{
  for(const change of [h=>h.context('customer-two'),h=>h.collection.invalidate('a'),h=>h.context('customer-one',['b'])]){
    const h=harness();h.context();const read=h.collection.readSaved('a',h.request,{month:'2026-10'});change(h);h.calls[0].resolve(payload());await assert.rejects(read,{code:'COMPANY_VIEW_INVALIDATED'});assert.equal(h.collection.peekSaved('a','2026-10'),null);
  }
});
test('wrong company/month responses never enter the saved cache',async()=>{
  for(const data of [payload('b'),payload('a','2026-09'),{result:{},companyDetail:{}}]){
    const h=harness();h.context();const read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[0].resolve(data);await assert.rejects(read,{code:'SOURCE_SCOPE_MISMATCH'});assert.equal(h.collection.peekSaved('a','2026-10'),null);
  }
});
test('preview responses preserve matching good data without extending its display lifetime',async()=>{
  const h=harness();h.context();let read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[0].resolve(payload());await read;
  const preview=payload('a','2026-10','preview');preview.result=null;preview.referenceLoading=true;preview.responseCache={state:'preview',checkedAt:'2026-10-30T10:05:00Z',refreshing:true};preview.companyDetail.integrated.snapshot=null;
  h.advance(6*60000);read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[1].resolve(preview);const result=await read;assert.equal(result.result.version,'v1');assert.equal(result.responseCache.preview,true);assert.equal(result.responseCache.refreshing,true);assert.equal(result.responseCache.checkedAt,'2026-10-30T09:59:00Z');assert.equal(h.collection.peekSaved('a','2026-10').result.version,'v1');
  h.advance(25*60000);assert.equal(h.collection.peekSaved('a','2026-10'),null,'a preview cannot renew the older complete result');
});
test('a preview with no good prior entry remains available as a preview and can later be replaced',async()=>{
  const h=harness();h.context();const preview=payload();preview.referenceLoading=true;preview.responseCache.state='preview';preview.responseCache.refreshing=true;
  let read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[0].resolve(preview);assert.equal((await read).responseCache.state,'preview');
  read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[1].resolve(payload('a','2026-10','complete'));assert.equal((await read).result.version,'complete');assert.equal(h.collection.peekSaved('a','2026-10').result.version,'complete');
});
for(const status of [401,403,404])test('HTTP '+status+' clears private saved access and applies existing denial handling',async()=>{
  const h=harness();h.context();let read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[0].resolve(payload());await read;
  read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[1].reject(error(status));await assert.rejects(read,{status});assert.equal(h.collection.peekSaved('a','2026-10'),null);assert.equal(h.expired(),status===401?1:0);
  await assert.rejects(h.collection.readSaved('a',h.request,{month:'2026-10'}),{code:'ACCESS_DENIED'});assert.equal(h.calls.length,2);assert.equal(h.timers.length,0);
});
test('transient failure retains good cached data and does not start retries or collectors',async()=>{
  const h=harness();h.context();let read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[0].resolve(payload());await read;
  read=h.collection.readSaved('a',h.request,{month:'2026-10'});h.calls[1].reject(error(503));await assert.rejects(read,{status:503});await flush();assert.equal(h.collection.peekSaved('a','2026-10').result.version,'v1');assert.equal(h.calls.length,2);assert.equal(h.timers.length,0);
});
