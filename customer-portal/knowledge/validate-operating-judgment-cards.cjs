'use strict';

// Validates the review-only draft catalog. It does not approve, personalize,
// publish, collect, issue coupons, or change prices or schedules.
const sources=new Set(['own_reservation','coupon_log','operator_setting','saved_observation']);
const text=value=>typeof value==='string'&&value.trim().length>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>text(value)&&/^[a-z][a-z0-9_-]{1,79}$/.test(value);
function validateDraftCatalog(catalog){
  const errors=[];
  const requireValue=(condition,code)=>{if(!condition)errors.push(code);};
  if(!object(catalog))return {ok:false,errors:['CATALOG_REQUIRED']};
  requireValue(catalog.schemaVersion===1,'SCHEMA_VERSION');
  requireValue(text(catalog.catalogVersion),'CATALOG_VERSION');
  requireValue(catalog.audience==='operating_lodging_owner','AUDIENCE');
  requireValue(catalog.policy?.reviewOnly===true&&catalog.policy?.automaticExecution===false&&catalog.policy?.collectionChanges===false,'REVIEW_ONLY_POLICY');
  const statements=Array.isArray(catalog.ownerStatements)?catalog.ownerStatements:[];
  const statementIds=new Set();
  requireValue(statements.length>0,'OWNER_DIRECTIONS_REQUIRED');
  for(const statement of statements){
    requireValue(id(statement?.id)&&!statementIds.has(statement.id),'OWNER_DIRECTION_ID');
    if(id(statement?.id))statementIds.add(statement.id);
    requireValue(text(statement?.author)&&text(statement?.quote)&&/^20\d{2}-\d{2}-\d{2}$/.test(statement?.date||''),'OWNER_DIRECTION_SOURCE');
  }
  const cards=Array.isArray(catalog.cards)?catalog.cards:[];
  requireValue(cards.length>0,'CARDS_REQUIRED');
  const cardIds=new Set();
  const listOfText=value=>Array.isArray(value)&&value.length>0&&value.every(text);
  for(const card of cards){
    if(!object(card)){errors.push('CARD_REQUIRED');continue;}
    const prefix=id(card.id)?card.id:'invalid-card';
    const check=(condition,code)=>requireValue(condition,prefix+':'+code);
    check(id(card.id)&&!cardIds.has(card.id),'UNIQUE_ID');
    if(id(card.id))cardIds.add(card.id);
    for(const field of ['title','goal','situation','action'])check(text(card[field]),field.toUpperCase());
    check(['owner_direction','design_extension'].includes(card.basis),'BASIS');
    check(Array.isArray(card.ownerStatementIds)&&card.ownerStatementIds.length>0&&card.ownerStatementIds.every(value=>statementIds.has(value)),'DIRECTION_REFERENCE');
    check(card.review?.status==='draft'&&card.review?.reviewedBy===null&&card.review?.reviewedAt===null,'UNAPPROVED_DRAFT');
    for(const field of ['interpretations','questions','exceptions','stopConditions','followUp','openDecisions'])check(listOfText(card[field]),field.toUpperCase());
    check(Array.isArray(card.requiredData)&&card.requiredData.length>0&&card.requiredData.every(row=>id(row?.key)&&text(row.label)&&sources.has(row.source)&&['hold','reference_only'].includes(row.absence)),'DATA_REQUIREMENTS');
    check(Array.isArray(card.parameters)&&card.parameters.length>0&&card.parameters.every(row=>id(row?.key)&&text(row.label)&&text(row.unit)&&row.value===null),'UNSET_PARAMETERS');
    for(const field of ['primary','drivers','guardrails']){
      const rows=card.measurement?.[field];
      check(Array.isArray(rows)&&rows.length>0&&rows.length<=(field==='primary'?3:2)&&rows.every(row=>id(row?.key)&&text(row.label)&&text(row.definition)&&text(row.unit)&&text(row.comparison)),'MEASUREMENT_'+field.toUpperCase());
    }
  }
  return {ok:errors.length===0,errors};
}
function draftSummary(catalog){
  const result=validateDraftCatalog(catalog);
  return {...result,catalogVersion:catalog?.catalogVersion??null,cards:Array.isArray(catalog?.cards)?catalog.cards.length:0,executionAllowed:false,personalizedRecommendationAllowed:false};
}
module.exports={validateDraftCatalog,draftSummary};
if(require.main===module){
  const path=require('node:path'),fs=require('node:fs');
  try{
    const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'operating-judgment-cards.v1.json'),'utf8'));
    const result=draftSummary(catalog);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
  }catch{console.error('JUDGMENT_CATALOG_READ_FAILED');process.exitCode=1;}
}
