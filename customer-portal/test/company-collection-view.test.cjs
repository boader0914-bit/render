'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve('../web/'+file),'utf8');
function ui() {
  const elements=new Map(['#collection-allowance','#collection-progress','#collection-result','[data-collect] button[type=submit]'].map(k=>[k,{innerHTML:'',textContent:'',disabled:false,dataset:{ready:'true'},append(){}}]));
  const window={},context=vm.createContext({window,document:{querySelector:s=>elements.get(s)||null},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('company-view.js'),context);vm.runInContext(read('collection.js'),context);
  return {window,elements};
}
const quota=allowed=>({limit:1,canRequest:allowed,resetsAt:'2026-10-02T15:00:00Z'});
test('collection view waits for allowance, keeps the fixed range and disables another submission after server refresh',async()=>{
  const {window:w,elements}=ui();
  assert.match(w.InsightCollection.panel({companyId:'a',name:'가상 업체'},true,null,null),/type="submit"[^>]+disabled/);
  const panel=w.InsightCollection.panel({companyId:'a',name:'가상 업체'},true,null,quota(true));
  assert.match(panel,/name="bookingRangeDays" value="30"/);assert.match(panel,/유무 확인/);assert.match(panel,/계정 전체 하루 1회/);
  let response={collectionAllowance:quota(false),request:null,result:null,companyDetail:null};
  w.InsightCollection.mount('a',async()=>response);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
  assert.match(elements.get('#collection-allowance').textContent,/1\/1회 사용/);
  response.collectionAllowance=quota(true);await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,false);
  response.request={status:'collecting',submittedAt:'2026-10-02T01:00:00Z'};await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
});
test('A-D view preserves quality warnings and distinguishes unknown from observed zero',()=>{
  const {window:w}=ui();
  const r={rooms:null,roomCountSource:'확인 전',productCount:0,range:{start:'2026-10-02',end:'2026-10-31',days:30},dayUse:{},days:[],issues:[],quality:{status:'partial',reason:'날짜 누락'},truncated:true};
  const detail={basics:{name:'가상 <업체>',lodgingTypes:[]},channels:[],current:{summary:null,daily:[{date:'2026-10-02',publicBookings:0,phoneBookings:null,estimatedRevenue:null,partial:true}]},history:{leadTime:{},ranks:[],performance:[],months:[]}};
  const html=w.InsightCompanyView.render({result:r,companyDetail:detail,previousResult:true},'');
  for(const label of ['업체 기본정보','예약 채널','최근 운영 관측','누적 이력·관리','이번 요청의 완료 결과가 아닙니다','일부 완료','날짜 누락','보존된 상품 목록','공개 0실','방막기 확인 전','산출 보류'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/확인 전실|가상 <업체>/);assert.match(html,/가상 &lt;업체&gt;/);
});
