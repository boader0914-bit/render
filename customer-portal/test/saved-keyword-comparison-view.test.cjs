'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync(require.resolve('../web/saved-keyword-comparison.js'),'utf8');
function harness(){
  const requests=[],handlers={},frame={hidden:true,src:undefined,addEventListener:(name,fn)=>handlers[name]=fn},loading={hidden:false,text:'',classList:{remove(){}},replaceChildren(){this.text='';},append(node){this.text+=node.textContent;}},slot={isConnected:true,querySelector:selector=>selector==='[data-saved-keyword-frame]'?frame:loading};
  const scope={window:{},document:{querySelector:selector=>selector==='#saved-keyword-frame-slot'?slot:null,createElement:()=>({textContent:''})},fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),AbortController};
  vm.createContext(scope);vm.runInContext(code,scope);
  return {view:scope.window.InsightSavedKeywordComparison,requests,frame,loading,slot,handlers};
}
test('ordinary customers receive no sample entry, iframe or requests',async()=>{
  const h=harness();assert.equal(h.view.entry({adminView:false}),'');assert.doesNotMatch(h.view.panel({adminView:false}),/<iframe|src=/);assert.match(h.view.panel({adminView:false}),/관리자 전용/);await h.view.mount({adminView:false});assert.equal(h.requests.length,0);
});
test('admin sample has a separate route and explicit preserved-source identity',()=>{
  const h=harness(),entry=h.view.entry({adminView:true}),panel=h.view.panel({adminView:true});
  assert.match(entry,/#saved-keyword-comparison/);assert.match(panel,/2026년 9월 20~22일/);assert.match(panel,/현재 선택한 고객의 내 매장 자료와는 별도/);assert.match(panel,/데이터랩 실시간 조회·수집·정기수집 설정은 연결하지 않습니다/);assert.match(panel,/<iframe[^>]+title=/);assert.doesNotMatch(panel,/<iframe[^>]+\ssrc=/);
});
test('admin mount verifies the same-origin protected asset before loading the frame',async()=>{
  const h=harness(),pending=h.view.mount({adminView:true});assert.equal(h.requests.length,1);const r=h.requests[0];assert.equal(r.url,'/saved-keyword-comparison/');assert.equal(r.options.method,'HEAD');assert.equal(r.options.credentials,'same-origin');assert.equal(h.frame.src,undefined);r.resolve({ok:true,status:200});await pending;assert.equal(h.frame.src,'/saved-keyword-comparison/');h.handlers.load();assert.equal(h.loading.hidden,true);assert.equal(h.frame.hidden,false);
});
test('forbidden admin asset leaves no frame source and explains permission',async()=>{
  const h=harness(),pending=h.view.mount({adminView:true});h.requests[0].resolve({ok:false,status:403});await pending;assert.equal(h.frame.src,undefined);assert.match(h.loading.text,/관리자 권한/);
});
test('expired session is handed back to existing portal authentication without retry or collection',async()=>{
  const h=harness();let expired=0;const pending=h.view.mount({adminView:true,onSessionExpired:()=>expired++});h.requests[0].resolve({ok:false,status:401});await pending;assert.equal(expired,1);assert.equal(h.frame.src,undefined);assert.equal(h.requests.length,1);
});
test('leaving the view invalidates late authorization and cannot mount stale sample content',async()=>{
  const h=harness(),pending=h.view.mount({adminView:true});h.view.stop();h.requests[0].resolve({ok:true,status:200});await pending;assert.equal(h.frame.src,undefined);assert.equal(h.requests[0].options.signal.aborted,true);
});
test('portal mounts the saved view before registered comparison data reads and retains the same competition menu',()=>{
  const source=fs.readFileSync(require.resolve('../web/connected.js'),'utf8');
  assert.match(source,/route\(\)==='saved-keyword-comparison'\?'competitors'/);
  const start=source.indexOf("if (route() === 'saved-keyword-comparison')"),end=source.indexOf("const c = state.customer",start);
  assert.ok(start>source.indexOf('if (!state) { auth(); return; }'));
  const branch=source.slice(start,end);assert.match(branch,/panel\(\{adminView\}\)/);assert.match(branch,/mount\(\{adminView,onSessionExpired:sessionExpired\}\)/);assert.match(branch,/return;/);assert.doesNotMatch(branch,/\.api|startRecurringPoll|InsightComparisonView/);
  const html=fs.readFileSync(require.resolve('../web/connected.html'),'utf8');assert.match(html,/saved-keyword-comparison\.css/);assert.ok(html.indexOf('saved-keyword-comparison.js')<html.indexOf('src="/connected.js"'));
});
