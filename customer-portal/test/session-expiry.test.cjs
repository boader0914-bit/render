'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('an expired API response clears cached customer content, stops readers and records the safe return route',async()=>{
  const handlers={},elements=new Map(),remembered=[],events=[];
  const el=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',dataset:{},classList:{toggle(){},add(){},remove(){}},focus(){}});return elements.get(s);};
  const state={customer:{username:'review',settings:{},regions:[],relations:[],entitlements:{competitorLimit:3,interestRegionLimit:1}},companies:[],corrections:[],preparations:[],features:{}};
  const window={addEventListener(){},scrollTo(){},InsightSession:{remember:(admin,hash)=>remembered.push([admin,hash])},InsightAnalysis:{stop:()=>events.push('stop'),clearCache:()=>events.push('clear'),panel:()=>'',mount(){}},InsightAuth:{screen:()=>'<form>다시 로그인</form>'}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/connected.js'),'utf8'),{window,location:{pathname:'/',hash:'#competitors'},document:{querySelector:el,documentElement:{dataset:{}},body:el('body'),addEventListener:(key,fn)=>handlers[key]=fn},localStorage:{getItem:()=>null},setTimeout:()=>0,FormData:class{constructor(){return [['q','example']];}},fetch:async url=>url.includes('/catalog/')?{ok:false,status:401,json:async()=>({error:{message:'만료'}})}:{ok:true,status:200,json:async()=>url.endsWith('/config')?{}:state}});
  await new Promise(r=>setImmediate(r));assert.match(el('#main').innerHTML,/경쟁업체 추가/);
  const form={id:'search-form',dataset:{kind:'competitor'},querySelectorAll:()=>[],querySelector:()=>null};
  await handlers.submit({preventDefault(){},target:form});
  assert.match(el('#main').innerHTML,/로그인이 만료/);assert.match(el('#main').innerHTML,/다시 로그인/);assert.doesNotMatch(el('#main').innerHTML,/경쟁업체 추가/);
  assert.ok(events.includes('clear'));assert.deepEqual(remembered,[[false,'#competitors']]);assert.equal(el('#navigation').innerHTML,'');
});
