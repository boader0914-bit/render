'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('session resume stays within allowed hash routes, separates roles and consumes the return once',()=>{
  const map=new Map(),window={};vm.runInNewContext(fs.readFileSync(require.resolve('../web/session-nav.js'),'utf8'),{window,sessionStorage:{setItem:(k,v)=>map.set(k,v),getItem:k=>map.get(k),removeItem:k=>map.delete(k)}});
  const s=window.InsightSession;s.remember(true,'#company=cmp_place_123');s.remember(false,'#reports');
  assert.equal(s.consume(true),'#company=cmp_place_123');assert.equal(s.consume(true),'#home');assert.equal(s.consume(false),'#reports');
  for(const url of ['https://evil.test','//evil.test','#javascript:alert(1)','#company=../../../admin','#home?token=x']){assert.equal(s.safe(url),false);s.remember(true,url);assert.equal(s.consume(true),'#home');}
});
