'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/region-history.js');
test('chart keeps zero on baseline and breaks the line at unknown months',()=>{
  const html=view.chart([{month:'2026-07',value:0},{month:'2026-08',value:null},{month:'2026-09',value:30}],'방문자 <예시>','명');
  assert.equal((html.match(/<polyline/g)||[]).length,2);
  assert.equal((html.match(/<circle/g)||[]).length,2);
  assert.match(html,/cy="154"/);assert.match(html,/2개월 자료 있음/);
  assert.doesNotMatch(html,/<예시>/);assert.match(html,/&lt;예시&gt;/);
});
test('zero baseline is not a percentage and relative indices use arithmetic differences',()=>{
  assert.equal(view.delta({value:null,kind:'zero_baseline'}),'비교 불가 · 기준값 0');
  assert.equal(view.delta({value:2.5,kind:'index_difference'}),'+2.5 지수');
  assert.equal(view.delta({value:10,kind:'percent'}),'+10%');
});
test('population keeps total and actual annual vintage; incomplete month stays explicitly separate',()=>{
  const html=view.render({region:{label:'예시'},window:{start:'2025-10',end:'2026-09'},refreshAvailable:true,warnings:[],sources:[{label:'인구',provider:'KOSIS',period:'2024',rows:[{key:'total',label:'전체',value:100,unit:'명'},{key:'female',label:'여성',value:50,unit:'명'}]}],interim:{month:'2026-10',sources:[]}});
  assert.match(html,/실제 공표기간 2024/);assert.match(html,/전체 <strong>100<\/strong>/);
  assert.match(html,/이번 달 중간 현황 · 기준 집계에서 제외/);
});
