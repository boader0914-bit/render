(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const sourceLabels={own_reservation:'내 매장 실제 예약 기록',coupon_log:'쿠폰 발급·사용 기록',operator_setting:'운영자가 정할 기준',saved_observation:'저장된 관측 자료'};
  const topicIds={leadtime:new Set(['leadtime-baseline','early-booking-coupon','last-minute-coupon']),price:new Set(['price-coupon-cost']),repeat:new Set(['repeat-guest-coupon']),review:new Set(['coupon-retrospective'])};
  let catalog=null;
  function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined&&text!==null)el.textContent=String(text);return el;}
  function list(values){const ul=node('ul');for(const text of Array.isArray(values)?values:[])ul.append(node('li','',text));return ul;}
  function section(title,content,cls=''){const box=node('section','block '+cls);box.append(node('h3','',title),content);return box;}
  function paragraph(value){return node('p','',value);}
  function metricList(values){const box=node('div','metric-list');for(const metric of Array.isArray(values)?values:[]){const row=node('article','metric');row.append(node('h4','',metric.label),paragraph(metric.definition));if(metric.unit)row.append(node('span','unit','단위: '+metric.unit));if(metric.comparison)row.append(node('p','muted','비교 기준: '+metric.comparison));box.append(row);}return box;}
  function parameters(values){const dl=node('dl','parameters');for(const p of Array.isArray(values)?values:[]){const row=node('div');row.append(node('dt','',p.label),node('dd','',p.value===null||p.value===undefined?'미정':String(p.value)));if(p.unit)row.append(node('span','muted',p.unit));dl.append(row);}return dl;}
  function dataList(values){const box=node('div','data-list');for(const item of Array.isArray(values)?values:[]){const row=node('article','data-row');row.append(node('strong','',item.label),node('span','muted',sourceLabels[item.source]||'자료 출처 확인 필요'),node('span','data-behavior',item.absence==='reference_only'?'없으면 참고 범위만 표시':'없으면 행동 판단 보류'));box.append(row);}return box;}
  function cardView(card,index){const details=node('details','judgment-card');details.dataset.cardId=card.id;
    const summary=node('summary','card-summary');const number=node('span','card-number',String(index+1).padStart(2,'0'));const text=node('div','card-title');text.append(node('h2','',card.title),node('p','',card.goal));const flags=node('div','card-flags');flags.append(node('span','pill draft','초안 · 전문가 검토 전'),node('span','basis',card.basis==='owner_direction'?'말씀하신 방향에서 정리':'적용 방법의 설계 초안'));summary.append(number,text,flags,node('b','plus','+'));details.append(summary);
    const body=node('div','card-body');const pair=node('div','pair');pair.append(section('언제 살펴볼까요',paragraph(card.situation)),section('가능한 해석',list(card.interpretations)));body.append(pair);
    body.append(section('판단 전에 필요한 자료',dataList(card.requiredData)));
    const questions=node('div','pair');questions.append(section('운영자가 답할 질문',list(card.questions)),section('아직 정해야 할 조건',parameters(card.parameters)));body.append(questions);
    body.append(section('검토할 행동',paragraph(card.action),'action'));
    const caution=node('div','pair');caution.append(section('적용에서 제외할 상황',list(card.exceptions)),section('멈추고 다시 볼 조건',list(card.stopConditions)));body.append(caution);
    const primary=metricList(card.measurement?.primary);body.append(section('결과를 볼 핵심 지표',primary));
    const measurement=node('details','subdetails');const ms=node('summary','', '함께 볼 지표와 부작용');ms.append(node('b','plus','+'));measurement.append(ms);const metrics=node('div','pair');metrics.append(section('흐름을 설명하는 지표',metricList(card.measurement?.drivers)),section('함께 확인할 부담·변화',metricList(card.measurement?.guardrails)));measurement.append(metrics);body.append(measurement);
    const next=node('div','pair');next.append(section('이후 결과 확인',list(card.followUp)),section('김정환님 검토가 필요한 결정',list(card.openDecisions)));body.append(next);
    const refs=(card.ownerStatementIds||[]).map(id=>(catalog.ownerStatements||[]).find(s=>s.id===id)).filter(Boolean);if(refs.length){const refsBox=node('div','source-refs');refsBox.append(node('strong','', '연결한 발언'));for(const ref of refs)refsBox.append(node('blockquote','',ref.quote));refsBox.append(node('p','muted','발언의 방향을 기록한 것이며, 이 카드의 세부 실행 조건을 확인받았다는 뜻은 아닙니다.'));body.append(refsBox);}
    details.append(body);return details;
  }
  function render(){const topic=$('topic').value,query=$('search').value.trim().toLocaleLowerCase('ko-KR');const cards=(catalog?.cards||[]).filter(c=>(topic==='all'||topicIds[topic]?.has(c.id))&&(!query||[c.title,c.goal,c.situation,...(c.questions||[])].join(' ').toLocaleLowerCase('ko-KR').includes(query)));$('cards').replaceChildren(...cards.map(cardView));$('count').textContent=cards.length+'개 카드';$('status').textContent=cards.length?'모든 카드는 세부 조건을 확인하기 전의 검토 초안입니다.':'선택한 조건에 맞는 카드가 없습니다.';}
  async function load(){try{$('error').hidden=true;const response=await fetch('/catalog.json',{cache:'no-store'});if(!response.ok)throw Error('CATALOG_UNAVAILABLE');const value=await response.json();if(value.schemaVersion!==1||!Array.isArray(value.cards)||value.policy?.reviewOnly!==true||value.policy?.automaticExecution!==false||value.policy?.collectionChanges!==false||value.cards.some(card=>card.review?.status!=='draft'||card.review.reviewedBy!==null||card.review.reviewedAt!==null||!Array.isArray(card.parameters)||card.parameters.some(parameter=>parameter.value!==null)))throw Error('REVIEW_POLICY_INVALID');catalog=value;$('version').textContent='판단 기준 초안 '+value.catalogVersion;const sources=(value.ownerStatements||[]).map(s=>{const box=node('article');box.append(node('p','muted',s.author+' · '+s.date),node('blockquote','',s.quote));return box;});$('owner-statements').replaceChildren(...sources);render();}catch{$('cards').replaceChildren();$('count').textContent='';$('status').textContent='초안 자료 연결 확인이 필요합니다.';$('error').hidden=false;}}
  $('topic').addEventListener('change',render);$('search').addEventListener('input',render);$('retry').addEventListener('click',load);
  $('theme').addEventListener('click',()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';$('theme').textContent=dark?'라이트 모드':'다크 모드';});
  load();
})();
