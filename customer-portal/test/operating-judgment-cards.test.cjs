'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const catalog=require('../knowledge/operating-judgment-cards.v1.json');
const {validateDraftCatalog,draftSummary}=require('../knowledge/validate-operating-judgment-cards.cjs');
const copy=()=>JSON.parse(JSON.stringify(catalog));

test('all six experience cards are review-only drafts, with no personalized or execution authority',()=>{
  assert.deepEqual(catalog.cards.map(card=>card.id),['leadtime-baseline','early-booking-coupon','last-minute-coupon','price-coupon-cost','repeat-guest-coupon','coupon-retrospective']);
  assert.equal(validateDraftCatalog(catalog).ok,true);
  assert.deepEqual(draftSummary(catalog),{ok:true,errors:[],catalogVersion:catalog.catalogVersion,cards:6,executionAllowed:false,personalizedRecommendationAllowed:false});
});
test('confirmed direction provenance retains only the words actually supplied by the owner',()=>{
  assert.deepEqual(catalog.ownerStatements.map(row=>row.quote),['예약 리드타임과 가격을 분석하여 할인쿠폰으로 리드타임조절','재방문고객의 할인쿠폰']);
  for(const card of catalog.cards){assert.equal(card.review.reviewedBy,null);assert.equal(card.review.reviewedAt,null);}
  for(const key of ['early-booking-coupon','last-minute-coupon','price-coupon-cost','coupon-retrospective'])assert.equal(catalog.cards.find(card=>card.id===key).basis,'design_extension');
});
test('room quantities keep the customer-facing room unit and specify the stay-date aggregation grain',()=>{
  const metric=catalog.cards.find(card=>card.id==='last-minute-coupon').measurement.primary[0];
  assert.equal(metric.unit,'실');assert.match(metric.definition,/숙박일별/);
  for(const key of ['leadtime-baseline','early-booking-coupon','last-minute-coupon'])assert.ok(catalog.cards.find(card=>card.id===key).interpretations.some(text=>/숙박 시작일에서 예약 접수일을 뺀 달력 일수/.test(text)));
});
test('missing parameters remain unknown rather than becoming numeric zero defaults',()=>{
  const before=JSON.stringify(catalog);assert.ok(catalog.cards.every(card=>card.parameters.every(parameter=>parameter.value===null)));
  const modified=copy();modified.cards[0].parameters[0].value=0;
  assert.ok(validateDraftCatalog(modified).errors.includes('leadtime-baseline:UNSET_PARAMETERS'));
  assert.equal(JSON.stringify(catalog),before);
});
test('a draft cannot claim expert approval without a later implemented review workflow',()=>{
  const modified=copy();modified.cards[0].review={status:'approved',reviewedBy:'김정환',reviewedAt:'2026-10-30T00:00:00Z'};
  assert.ok(validateDraftCatalog(modified).errors.includes('leadtime-baseline:UNAPPROVED_DRAFT'));
  assert.equal(draftSummary(modified).executionAllowed,false);
});
test('execution or collection policy changes are rejected even for otherwise valid cards',()=>{
  for(const key of ['automaticExecution','collectionChanges']){const modified=copy();modified.policy[key]=true;assert.ok(validateDraftCatalog(modified).errors.includes('REVIEW_ONLY_POLICY'));}
});
test('duplicate cards and dangling owner references cannot silently replace the intended evidence',()=>{
  const duplicate=copy();duplicate.cards[1].id=duplicate.cards[0].id;
  assert.ok(validateDraftCatalog(duplicate).errors.some(code=>code.endsWith(':UNIQUE_ID')));
  const dangling=copy();dangling.cards[0].ownerStatementIds=['unknown_statement'];
  assert.ok(validateDraftCatalog(dangling).errors.includes('leadtime-baseline:DIRECTION_REFERENCE'));
});
test('local review serves the validated catalog but cannot execute write commands or expose source files',async()=>{
  const {createReviewServer}=require('../review/judgment-cards/server.cjs');
  const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
  const file=path.join(__dirname,'../knowledge/operating-judgment-cards.v1.json');
  const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before=digest(),server=createReviewServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal(server.address().address,'127.0.0.1');
    const response=await fetch(base+'/catalog.json');assert.equal(response.status,200);
    const result=await response.json();assert.equal(validateDraftCatalog(result).ok,true);
    assert.equal(result.cards.length,6);
    for(const route of ['/catalog.json','/api/crawl','/api/collection-schedule'])assert.equal((await fetch(base+route,{method:'POST',body:'{}'})).status,405);
    for(const route of ['/server.cjs','/../../knowledge/operating-judgment-cards.v1.json','/api/collection-schedule'])assert.equal((await fetch(base+route)).status,404);
    assert.equal(digest(),before);
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
