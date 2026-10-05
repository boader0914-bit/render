'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../web/home.js'), 'utf8');
const customer = () => ({customer:{relations:[{kind:'own',status:'active',companyId:'a'},{kind:'own',status:'active',companyId:'b'}],regions:[],settings:{}},companies:[{companyId:'a',name:'업체 A',rooms:16,regionKey:'ra'},{companyId:'b',name:'업체 B',rooms:20,regionKey:'rb'}]});
const report = id => ({companies:[{kind:'own',companyId:id,lastObservedAt:'2026-09-30T15:01:00Z',summary:{days:1,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0,reservationRate:0}}],period:{start:'2026-10-01',end:'2026-10-30',days:30},regions:[{region:{id:`r${id}`,label:`지역 ${id}`},sources:[]}],generatedAt:'2026-10-05T00:00:00Z'});
function runtime() {
  const slots = new Map(), handlers = {}, window = {};
  for (const name of ['#home-company','#home-operations','#home-region','[data-home-refresh]']) slots.set(name,{innerHTML:'',isConnected:true,disabled:false});
  const context = vm.createContext({window,document:{querySelector:s=>slots.get(s),addEventListener:(name,fn)=>handlers[name]=fn}});
  vm.runInContext(source,context);
  return {home:window.InsightHome,slots,handlers};
}
const tick = () => new Promise(resolve=>setImmediate(resolve));
test('fresh company capacity replaces bootstrap capacity without keeping an outdated evidence label', async () => {
  const {home,slots}=runtime(),state=customer(),latest=report('a');
  state.companies[0].rooms=17;state.companies[0].roomCountSource='오래된 관측값';latest.companies[0].rooms=16;
  await home.mount(async()=>latest,state);
  assert.match(slots.get('#home-company').innerHTML,/16실/);
  assert.doesNotMatch(slots.get('#home-company').innerHTML,/17실|오래된 관측값/);
  assert.match(slots.get('#home-company').innerHTML,/최신 업체DB 기준/);
  assert.equal(state.companies[0].rooms,17,'source bootstrap is not mutated');
});
test('home keeps registration visible on read failure and makes no collection request', async () => {
  const {home,slots}=runtime(),calls=[];
  await home.mount(async (...args)=>{calls.push(args);throw new Error('source unavailable');},customer());
  assert.match(slots.get('#home-company').innerHTML,/업체 A/);
  assert.match(slots.get('#home-operations').innerHTML,/불러오지 못/);
  assert.deepEqual(calls,[['/reports/briefing?ownId=a']]);
  assert.equal(slots.get('[data-home-refresh]').disabled,false);
});
test('company selection suppresses earlier responses and uses observation date instead of read date', async () => {
  const {home,slots,handlers}=runtime(),pending=[];
  const initial=home.mount(url=>new Promise(resolve=>pending.push({url,resolve})),customer());
  assert.match(slots.get('#home-company').innerHTML,/업체 A/);
  handlers.change({target:{matches:()=>true,value:'b'}});
  assert.match(slots.get('#home-company').innerHTML,/업체 B/);
  pending[1].resolve(report('b'));await tick();
  pending[0].resolve(report('a'));await initial;
  assert.match(slots.get('#home-company').innerHTML,/업체 B/);
  assert.match(slots.get('#home-company').innerHTML,/2026년 10월 1일/);
  assert.doesNotMatch(slots.get('#home-company').innerHTML,/10월 5일/);
  assert.match(slots.get('#home-region').innerHTML,/지역 b/);
  assert.doesNotMatch(slots.get('#home-region').innerHTML,/지역 a/);
});
test('leaving home suppresses late results; logout cache clearing prevents reuse across sessions', async () => {
  const {home,slots}=runtime();let finish;
  const initial=home.mount(()=>new Promise(resolve=>{finish=resolve;}),customer());
  home.stop();const before=slots.get('#home-region').innerHTML;
  finish(report('a'));await initial;
  assert.equal(slots.get('#home-region').innerHTML,before);
  home.clearCache();let calls=0;
  await home.mount(async()=>{calls++;return report('a');},customer());
  assert.equal(calls,1);
});
test('empty home reads nothing; preparing home reads registered region summary only', async () => {
  const {home,slots}=runtime();let calls=0;
  const state={customer:{businessStatus:'planning',relations:[],regions:[],settings:{}},companies:[]};
  await home.mount(async()=>{calls++;},state);assert.equal(calls,0);
  state.customer.regions=[{regionKey:'r1',status:'active'}];
  await home.mount(async(url)=>{calls++;assert.equal(url,'/reports/briefing');return {regions:[{region:{id:'r1',label:'관심 지역'},sources:[]}]};},state);
  assert.equal(calls,1);assert.equal(slots.get('#home-operations').innerHTML,'');
  assert.match(slots.get('#home-region').innerHTML,/관심 지역/);
});
