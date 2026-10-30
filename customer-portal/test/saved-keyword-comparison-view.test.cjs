'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync(require.resolve('../web/saved-keyword-comparison.js'),'utf8');
function presentation(){
  const scope={window:{},fetch:()=>assert.fail('the launcher cannot request data'),document:{querySelector:()=>assert.fail('the launcher cannot start a frame or loading operation')}};
  vm.createContext(scope);vm.runInContext(code,scope);return scope.window.InsightSavedKeywordComparison;
}
test('ordinary customers receive no sample entry, iframe or protected-data link',()=>{
  const view=presentation();assert.equal(view.entry({adminView:false}),'');const panel=view.panel({adminView:false});assert.match(panel,/관리자 전용/);assert.doesNotMatch(panel,/<iframe|saved-keyword-comparison\//);
});
test('the admin competition entry opens the authenticated same-origin full screen directly',()=>{
  const html=presentation().entry({adminView:true});assert.match(html,/href="\/saved-keyword-comparison\/" target="_blank" rel="noopener"/);assert.match(html,/비교 화면 열기/);assert.doesNotMatch(html,/#saved-keyword-comparison|<iframe|loading/);
});
test('the old hash route is a finite launcher with the archive identity and a return path',()=>{
  const view=presentation(),html=view.panel({adminView:true});assert.match(html,/2026년 9월 20~22일/);assert.match(html,/현재 선택한 고객의 내 매장 자료와는 별도/);assert.match(html,/데이터랩 실시간 조회·수집·정기수집 설정은 연결하지 않습니다/);assert.match(html,/href="\/saved-keyword-comparison\/" target="_blank" rel="noopener"/);assert.match(html,/#competitors/);assert.doesNotMatch(html,/<iframe|준비 중|is-loading/);assert.deepEqual(Object.keys(view).sort(),['entry','panel']);
});
test('the saved hash returns before registered comparison reads and never mounts a frame',()=>{
  const source=fs.readFileSync(require.resolve('../web/connected.js'),'utf8');assert.match(source,/route\(\)==='saved-keyword-comparison'\?'competitors'/);
  const start=source.indexOf("if (route() === 'saved-keyword-comparison')"),end=source.indexOf("const c = state.customer",start);assert.ok(start>source.indexOf('if (!state) { auth(); return; }'));
  const branch=source.slice(start,end);assert.match(branch,/panel\(\{adminView\}\)/);assert.match(branch,/return;/);assert.doesNotMatch(branch,/mount|fetch|\.api|startRecurringPoll|InsightComparisonView/);
  const html=fs.readFileSync(require.resolve('../web/connected.html'),'utf8');assert.match(html,/saved-keyword-comparison\.css/);assert.ok(html.indexOf('saved-keyword-comparison.js')<html.indexOf('src="/connected.js"'));
});
test('direct launcher reload narrows early bootstrap to the existing identity-only bucket',async()=>{
  const calls=[],scope={window:{},location:{pathname:'/customer-view',href:'https://insight.sabun.co.kr/customer-view#saved-keyword-comparison',hash:'#saved-keyword-comparison'},document:{documentElement:{setAttribute(){}}},URL,Set,Map,Number,Object,AbortController,performance:{mark:()=>({startTime:1})},fetch:async(url,options)=>{calls.push({url,options});return {ok:true};}};
  vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../web/bootstrap-read.js'),'utf8'),scope);
  const headers=scope.window.InsightBootstrapReads.headers();assert.equal(headers['X-Insight-Bootstrap-View'],'settings');assert.equal(calls.length,2);assert.ok(calls.every(c=>/\/(me|config)$/.test(c.url)));assert.equal(calls.find(c=>c.url.endsWith('/me')).options.headers['X-Insight-Bootstrap-View'],'settings');
  const {selection}=require('../bootstrap-snapshots.cjs');const selected=selection({'x-insight-bootstrap-view':headers['X-Insight-Bootstrap-View']},{customer:{relations:[]}});assert.equal(selected.company,false);assert.equal(selected.region,false);assert.equal(selected.report,false);
  assert.match(fs.readFileSync(require.resolve('../web/connected.js'),'utf8'),/const view=current==='saved-keyword-comparison'\?'settings'/);
});
