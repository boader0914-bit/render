'use strict';
const crypto=require('node:crypto');
const {createArchiveStore}=require('./archive-store.cjs');
const {projectDailyReview,publicationSourceLinks}=require('./archive-provenance.cjs');
const DAY=86400000,hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day=value=>typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
const reference=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,180}$/.test(value);
const fault=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,message,statusCode});
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
// Price-incomplete days can retain their evidenced amount, but cannot turn an
// unreviewed inventory row or an unpriced booking into confirmed revenue.
function partialPriceSubtotal(row){
  if(row.review?.quantityReviewed!==true||row.review?.revenueReviewed!==false||row.revenuePartial!==true
    ||row.missing===true||row.inventoryConflict===true||row.partial===true||row.collectionPartial===true
    ||![row.estimatedRevenue,row.publicRevenue,row.phoneRevenue].every(nonnegative)
    ||Math.abs(row.estimatedRevenue-row.publicRevenue-row.phoneRevenue)>=1
    ||(row.publicBookings===0&&row.publicRevenue>0)||(row.phoneBookings===0&&row.phoneRevenue>0)
    ||(row.sold>0&&row.estimatedRevenue===0))return null;
  return row.estimatedRevenue;
}
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fault('ARCHIVE_INVALID_FIELDS','보관 요청 항목을 확인해 주세요.');}
function access(identity,audience){
  const customer=identity?.customer;
  if(!reference(customer?.customerId)||customer.accountStatus!=='active'||typeof audience!=='string'||!audience)throw fault('LOGIN_REQUIRED','다시 로그인해 주세요.',401);
  const catalog=new Map((identity.companies||[]).filter(row=>reference(row.companyId)).map(row=>[row.companyId,row]));
  const companies=new Map((customer.relations||[]).filter(row=>['active','pending'].includes(row.status)&&['own','competitor'].includes(row.kind)&&catalog.has(row.companyId)).map(row=>[row.companyId,{companyId:row.companyId,name:String(catalog.get(row.companyId).name||'').slice(0,180),role:row.kind}]));
  return {ownerId:customer.customerId,audience,companies};
}
function publicationPeriod(reportType,anchorDate){
  if(!day(anchorDate)||!['weekly','monthly'].includes(reportType))throw fault('ARCHIVE_INVALID_PERIOD','주간·월간 구분과 기준일을 확인해 주세요.');
  const date=new Date(anchorDate+'T00:00:00Z');let start,end;
  if(reportType==='weekly'){start=new Date(date.getTime()-((date.getUTCDay()+6)%7)*DAY);end=new Date(start.getTime()+6*DAY);}
  else{start=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1));end=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0));}
  return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10),days:Math.round((end-start)/DAY)+1};
}
function createArchiveService({directory=null,namespace,clock=Date.now,store=createArchiveStore({directory,namespace,clock})}={}){
  const pending=new Map();
  const scope=(identity,audience)=>access(identity,audience);
  const allowed=(record,context)=>{const ids=record.identity?.companyIds||(record.identity?.companyId?[record.identity.companyId]:[]);return ids.length>0&&ids.every(id=>context.companies.has(id));};
  async function records(context,kind){
    const all=[];for(let offset=0;offset<100000;offset+=1000){const page=await store.list({...context,kind,offset,limit:1000});all.push(...page);if(page.length<1000)return all;}
    throw fault('ARCHIVE_SEARCH_LIMIT','보관 자료의 조회 범위를 줄여 주세요.',409);
  }
  async function capture({identity,audience,companyId,month,data,checkedAt=clock()}={}){
    const context=scope(identity,audience);if(!context.companies.has(companyId))throw fault('NOT_FOUND','등록한 업체의 자료를 찾을 수 없습니다.',404);
    if(!store.status().enabled)return {status:'disabled'};
    const payload=projectDailyReview({companyId,month:month||data?.companyDetail?.integrated?.selectedMonth,data,reviewedAt:new Date(checkedAt).toISOString()});
    if(!payload)return {status:'needs_review',reason:'ARCHIVE_SOURCE_NOT_REVIEWABLE'};
    const reviewedOn=kst(checkedAt),{reviewedAt,...stablePayload}=payload;
    const sourceKey=hash([reviewedOn,stablePayload]);
    const key=hash([context.ownerId,audience,sourceKey]);
    if(pending.has(key))return pending.get(key);
    const operation=(async()=>{
      const previous=(await records(context,'daily-review')).find(row=>row.metadata?.sourceKey===sourceKey);
      if(previous)return {status:'stored',record:previous,created:false,recordId:previous.id,reviewStatus:previous.metadata.reviewStatus};
      const args={...context,kind:'daily-review',period:{start:payload.period.start,end:payload.period.end},identity:{companyId,calculationVersion:payload.calculationVersion,runIds:payload.provenance.runIds,sourceDigest:payload.provenance.sourceDigest},payload,
        metadata:{sourceKey,reviewedOn,month:payload.month,reviewStatus:payload.review.status,reviewBasis:payload.review.basis,title:context.companies.get(companyId).name,normalDays:payload.review.normalDays,unresolvedDays:payload.review.unresolvedDays},idempotencyKey:'daily/'+sourceKey};
      let saved;try{saved=await store.put(args);}catch(error){if(error.code!=='ARCHIVE_IDEMPOTENCY_CONFLICT')throw error;const concurrent=(await records(context,'daily-review')).find(row=>row.metadata?.sourceKey===sourceKey);if(!concurrent)throw error;saved={record:concurrent,created:false};}
      return {...saved,status:'stored',recordId:saved.record.id,reviewStatus:payload.review.status};
    })().finally(()=>pending.delete(key));pending.set(key,operation);return operation;
  }
  async function list({identity,audience,kind,limit=100,offset=0}={}){
    const context=scope(identity,audience);if(kind!==undefined&&!['daily-review','published-report'].includes(kind))throw fault('ARCHIVE_INVALID_KIND','보관 자료 종류를 확인해 주세요.');
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw fault('ARCHIVE_INVALID_RANGE','목록 범위를 확인해 주세요.');
    await store.ready();const all=(await records(context,kind)).filter(row=>allowed(row,context));return {enabled:store.status().enabled,records:all.slice(offset,offset+limit),total:all.length,status:store.status()};
  }
  async function get({identity,audience,id}={}){const context=scope(identity,audience);const record=await store.get({...context,id});if(!record||!allowed(record,context))throw fault('NOT_FOUND','열람할 수 있는 보관 자료를 찾지 못했습니다.',404);return {record};}
  async function publish({identity,audience,input}={}){
    fields(input,['reportType','anchorDate','requestKey','ownId']);
    const context=scope(identity,audience),period=publicationPeriod(input.reportType,input.anchorDate);
    if(!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestKey||''))throw fault('ARCHIVE_REQUEST_KEY_REQUIRED','발행 요청 번호가 필요합니다.');
    const own=input.ownId||[...context.companies.values()].find(row=>row.role==='own')?.companyId;
    if(!own||context.companies.get(own)?.role!=='own')throw fault('NOT_FOUND','등록한 내 매장을 선택해 주세요.',404);
    const selected=[context.companies.get(own),...[...context.companies.values()].filter(row=>row.role==='competitor')];
    if(selected.length>24)throw fault('ARCHIVE_TOO_MANY_COMPANIES','발행 대상 업체 범위를 줄여 주세요.',409);
    const requestKeyHash=hash(input.requestKey),intent=hash([input.reportType,input.anchorDate,own]),lock=hash([context.ownerId,audience,'publish',requestKeyHash]);
    if(pending.has(lock)){
      const running=pending.get(lock);if(running.intent!==intent)throw fault('ARCHIVE_IDEMPOTENCY_CONFLICT','같은 발행 요청 번호의 조건이 다릅니다.',409);
      const result=await running.promise;if(!allowed(result.record,context))throw fault('NOT_FOUND','현재 등록한 업체의 발행본을 확인해 주세요.',404);return result;
    }
    const operation=(async()=>{
      const previous=(await records(context,'published-report')).find(row=>row.metadata?.requestKeyHash===requestKeyHash);
      if(previous){if(previous.metadata.requestIntent!==intent)throw fault('ARCHIVE_IDEMPOTENCY_CONFLICT','같은 발행 요청 번호의 조건이 다릅니다.',409);if(!allowed(previous,context))throw fault('NOT_FOUND','현재 등록한 업체의 발행본을 확인해 주세요.',404);return {record:previous,created:false};}
      const available=await records(context,'daily-review'),dates=[];for(let value=Date.parse(period.start+'T00:00:00Z');value<=Date.parse(period.end+'T00:00:00Z');value+=DAY)dates.push(new Date(value).toISOString().slice(0,10));
      const companies=[],sourceArchives=[];
      for(const company of selected){
        const latest=new Map();for(const row of available)if(row.identity.companyId===company.companyId&&!latest.has(row.metadata.month)&&dates.some(date=>date.startsWith(row.metadata.month+'-')))latest.set(row.metadata.month,row);
        const days=new Map(),links=[];let reviewRequired=false;
        for(const row of latest.values()){
          const saved=await store.get({...context,id:row.id});if(!saved)continue;
          const provenance=publicationSourceLinks([saved.payload]);if(!provenance.length)continue;
          if(saved.payload.roomBasis?.reviewRequired||saved.payload.provenance?.linkageStatus!=='complete')reviewRequired=true;
          sourceArchives.push({id:saved.id,checksum:saved.checksum,companyId:company.companyId,month:saved.payload.month});links.push(...provenance);
          for(const value of saved.payload.daily)if(dates.includes(value.date))days.set(value.date,value);
        }
        const daily=dates.map(date=>days.get(date)||{date,missing:true,sold:null,publicBookings:null,phoneBookings:null,publicRevenue:null,phoneRevenue:null,estimatedRevenue:null,total:null,review:{status:'unresolved',quantityReviewed:false,revenueReviewed:false,reason:'ARCHIVE_OBSERVATION_MISSING'}});
        const quantity=daily.filter(row=>row.review?.quantityReviewed===true),revenue=quantity.filter(row=>row.review?.revenueReviewed===true),complete=quantity.length===dates.length,priced=revenue.length===dates.length;
        const sum=(rows,key)=>rows.every(row=>typeof row[key]==='number'&&Number.isFinite(row[key]))?rows.reduce((total,row)=>total+row[key],0):null;
        const partialPrices=quantity.map(row=>({row,amount:partialPriceSubtotal(row)})).filter(value=>value.amount!==null);
        const knownAmounts=[...revenue.map(row=>row.estimatedRevenue),...partialPrices.map(value=>value.amount)];
        const uncertainty={
          quantityUnconfirmedDates:daily.filter(row=>row.review?.quantityReviewed!==true).map(row=>({date:row.date,reason:row.review?.reason||'QUANTITY_NOT_REVIEWABLE'})),
          priceUnconfirmedDates:quantity.filter(row=>row.review?.revenueReviewed!==true).map(row=>({date:row.date,reason:row.review?.reason||'REVENUE_NOT_REVIEWABLE',
            knownRevenueSubtotal:partialPriceSubtotal(row),phoneMissingPriceBookings:Number.isSafeInteger(row.phoneMissingPriceBookings)&&row.phoneMissingPriceBookings>=0?row.phoneMissingPriceBookings:null,unconfirmedAmount:null})),
          unconfirmedAmount:complete&&priced?0:null
        };
        const summary={expectedDays:dates.length,observedDays:quantity.length,revenueObservedDays:revenue.length,missingDays:dates.length-quantity.length,partial:!complete,revenuePartial:!priced,
          sold:complete?sum(quantity,'sold'):null,publicBookings:complete?sum(quantity,'publicBookings'):null,phoneBookings:complete?sum(quantity,'phoneBookings'):null,
          estimatedRevenue:priced?sum(revenue,'estimatedRevenue'):null,publicRevenue:priced?sum(revenue,'publicRevenue'):null,phoneRevenue:priced?sum(revenue,'phoneRevenue'):null,
          knownSold:quantity.length?sum(quantity,'sold'):null,knownEstimatedRevenue:revenue.length?sum(revenue,'estimatedRevenue'):null,
          knownRevenueSubtotal:knownAmounts.length&&knownAmounts.every(nonnegative)?knownAmounts.reduce((total,value)=>total+value,0):null,
          partialPriceKnownRevenue:partialPrices.length?partialPrices.reduce((total,value)=>total+value.amount,0):null};
        companies.push({...company,summary,uncertainty,daily,provenance:links,review:{status:complete&&priced&&!reviewRequired?'reviewed':'partial',basis:'automatic_validation',roomOrSourceReviewRequired:reviewRequired}});
      }
      if(!sourceArchives.length||companies.every(row=>row.summary.observedDays===0))throw fault('ARCHIVE_SOURCES_NOT_READY','선택 기간의 업체 검수 자료를 먼저 보관해 주세요.',409);
      const quality={status:companies.every(row=>row.review.status==='reviewed')?'complete':'partial',missingCompanies:companies.filter(row=>!row.provenance.length).map(row=>row.companyId)};
      const generatedAt=new Date(clock()).toISOString(),payload={schemaVersion:1,mode:'archived_period_report',published:true,reportType:input.reportType,period,generatedAt,ownId:own,companies,quality,sourceArchives,
        calculationVersion:'insight-period-publication-v2-price-evidence',definitions:['숙박일별 중앙 업체 DB의 검수 결과를 한 번씩 사용합니다. 수집 회차를 더하지 않습니다.','정상 0과 미확인 null을 구분합니다. 공개 예약과 타채널 추정은 분리합니다.','knownEstimatedRevenue는 가격이 완전히 확인된 날짜의 소계입니다. knownRevenueSubtotal은 여기에 수량 검수를 통과한 가격 일부 확인 날짜의 근거 있는 금액을 더한 소계이며, 월 전체 매출이나 실제 결제액이 아닙니다.','관측 미확인 날짜와 가격 미확인 날짜를 구분합니다. 미확인 금액은 산정하지 않으며 0원으로 합산하지 않습니다.','원본과 계산 기준이 바뀌어도 이 발행본은 변경하지 않습니다. 새 요청은 별도 발행본으로 보관합니다.']};
      const identityLinks={companyIds:selected.map(row=>row.companyId),sourceArchives,calculationVersion:payload.calculationVersion,sourceLinks:companies.flatMap(row=>row.provenance.map(link=>({companyId:row.companyId,month:link.month,calculationVersion:link.calculationVersion,runIds:link.runIds,sourceDigest:link.sourceDigest})))};
      return store.put({...context,kind:'published-report',period,identity:identityLinks,payload,metadata:{requestKeyHash,requestIntent:intent,reportType:input.reportType,title:(input.reportType==='weekly'?'주간':'월간')+' 리포트',reviewStatus:quality.status==='complete'?'reviewed':'partial',sourceVersion:hash(identityLinks)},idempotencyKey:'publish/'+requestKeyHash});
    })().finally(()=>pending.delete(lock));pending.set(lock,{intent,promise:operation});return operation;
  }
  return {capture,list,get,publish,ready:()=>store.ready(),flush:()=>store.flush(),status:()=>store.status(),scope};
}
module.exports={createArchiveService,publicationPeriod};
