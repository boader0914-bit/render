'use strict';
const {createHash}=require('node:crypto');
const {allocationKeys,schemas:inventoryPolicySchemas,policyEvidence}=require('./inventory-policy-evidence.cjs');

// This is an Insight-process cache, not a second source of company data. The
// caller supplies an opaque host/mode/session scope and both central GETs.
function createCompanyReadCache({now=Date.now,ttlMs=600000,refreshMs=30000,savedReadTimeoutMs=3000,maxEntries=64,maxBytes=16*1024*1024,maxPerScope=8,maxScopes=maxEntries*2,persistenceDirectory,namespace,persistentStore,onVerifiedSource}={}) {
  const entries=new Map(),states=new Map(),pendingSources=new Map(),pendingSaved=new Map(),invalidatedScopes=new Set();
  let bytes=0;
  const clock=()=>Number(now());
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const failure=(status,code,message)=>({status,ok:false,data:{error:{code,message}}});
  const unavailable=()=>failure(503,'CONNECTION_UNAVAILABLE','자료 연결을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.');
  const invalidated=()=>failure(409,'COMPANY_VIEW_INVALIDATED','등록 상태가 변경되었습니다. 다시 조회해 주세요.');
  const notFound=()=>failure(404,'NOT_FOUND','등록한 업체의 결과를 찾을 수 없습니다.');
  const active=request=>['dispatching','queued','collecting'].includes(request?.status);
  const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
  const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
  const meta=(state,checkedAt,refreshing=false,refreshFailed=false,entry)=>({state,checkedAt:new Date(checkedAt).toISOString(),refreshing,refreshFailed,...(entry?.persisted?{persisted:true,validUntil:new Date(entry.validUntil).toISOString(),revalidationRequired:true}:{})});
  // Durable cores use an allow-list at every depth. Never persist current
  // identity, quota, requests, account corrections, credentials or raw evidence.
  const fields=keys=>Object.fromEntries(keys.split(' ').map(key=>[key,true]));
  const metric=fields('supply sold publicBookings phoneBookings publicRevenue phoneRevenue estimatedRevenue reservationRate sharedDayUseExcluded coveredCompanyDays expectedCompanyDays missingCompanyDays revenueCoveredCompanyDays sameDayObservedCompanyDays staleDays maxObservationLeadTimeDays knownPartialRevenue partial revenuePartial containsPartialRun rangeStart rangeEnd calendarDays observedDays missingDays rateObservedDays revenueObservedDays quantityPartial');
  const sourceObservation=fields('companyId runId date productType collectedAt collectedDate runQuality');
  const daily={...metric,...fields('date collectedAt collectedDate total missing inventoryConflict observationLeadTimeDays latestAttemptAt latestAttemptStatus collectionPartial')};
  const productDay=fields('date status errorCode total available publicBookings price saleStatus');
  const product={...fields('key bizItemId name productType'),days:[productDay],original:[productDay]};
  const point=fields('observedDate status observedDays validDays freshDays calendarDays comparisonDays publicBookings phoneBookings publicRevenue phoneRevenue estimatedRevenue reservationRate');
  const resultSchema={...fields('companyId runId collectedAt dayUseMode rooms roomCountSource capacityWarning originalRooms productCount truncated actualRevenueAvailable version'),range:fields('start days end'),dayUse:fields('presence sharing'),quality:fields('status reason'),products:[product],days:[fields('date productType status total available publicBookings estimatedBlocked publicRevenue estimatedRevenue sharedDayUseExcluded sharingStatus')],issues:[{...fields('code label productName'),dates:[true]}]};
  const detailSchema={...fields('companyId source legacyObservationView'),basics:{...fields('companyId name address rooms roomCountSource facilities firstObservedAt lastObservedAt runCount'),lodgingTypes:[true]},channels:[fields('key label status statusLabel checkedAt url')],current:{summary:metric,daily:[daily]},history:{observationFlow:{...fields('basis reviewBasis'),periods:[{...fields('month start end calendarDays completeMonth'),comparisonDates:[true],points:[point]}]},months:[{month:true,summary:metric,daily:[daily]}],ranks:[{...fields('keyword keywordKey scope layer'),points:[fields('collectedAt rank delta')]}],performance:[fields('collectedAt checkIn observedDays reservationRate estimatedRevenue partial')],leadTime:fields('status label averageDays medianDays averageMinDays averageMaxDays pickupCount collectedDateCount actualBookingLeadTime')},integrated:{...fields('schemaVersion source companyId status calculatedAt calculationVersion selectedMonth'),months:[fields('month status')],roomBasis:fields('count source label reviewRequired'),snapshot:{period:fields('start end days cutoffDate monthClosed'),summary:metric,daily:[daily],analysis:{collectionDateCount:true,pickup:{...fields('increase decrease net comparableIntervals status actualBookingLeadTime'),leadTime:fields('averageDays medianDays averageMinDays averageMaxDays'),intervals:[fields('date previousCollectedAt collectedAt previousLeadDays currentLeadDays publicChange blockedChange netChange')]},weekdays:[{...metric,...fields('dayOfWeek label')}],pace:[{...metric,leadDays:true}],pricing:fields('estimatedPerSoldUnit estimatedPerSupplyUnit pricedCompanyDays priceCoverageRate')}}}};
  function projectValue(value,schema){
    if(value===null)return null;
    if(schema===true)return typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)?value:undefined;
    if(Array.isArray(schema))return Array.isArray(value)?value.map(item=>projectValue(item,schema[0])).filter(item=>item!==undefined):undefined;
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    return Object.fromEntries(Object.keys(schema).filter(key=>Object.hasOwn(value,key)).map(key=>[key,projectValue(value[key],schema[key])]).filter(([,item])=>item!==undefined));
  }
  function projectedCore(data){
    const core={result:projectValue(data?.result,resultSchema)??null,companyDetail:projectValue(data?.companyDetail,detailSchema)??null};
    if(!core.result&&!core.companyDetail)return null;
    if(['pending','updating','failed'].includes(core.companyDetail?.integrated?.status))return null;
    const ids=[core.result?.companyId,core.companyDetail?.companyId,core.companyDetail?.basics?.companyId].filter(Boolean);
    if(!ids.length||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id)||id!==ids[0]))return null;
    return core;
  }
  const projectionVersion=hash([resultSchema,detailSchema,projectValue.toString(),projectedCore.toString()]);
  // Optional source evidence extends this projection without changing the
  // deployed display contract. Preserve its fingerprint so existing safe
  // snapshots still render immediately; absence of evidence never authorizes
  // archival, which only receives newly verified source responses below.
  // Keep optional evidence outside the deployed fingerprint. It does not
  // change an old display snapshot into a newly verified source response.
  const recoveryFields=fields('kind companyId runId date productType collectedAt originalRunQuality receiptId sourceDigest rowDigest');
  sourceObservation.sourceRecovery=recoveryFields;
  const priceEvidenceKeys=['phoneMissingPriceBookings','phoneFallbackBookings','phoneFallbackRevenue',...allocationKeys];
  for(const schema of [metric,daily,detailSchema.integrated.snapshot.analysis.weekdays[0],detailSchema.integrated.snapshot.analysis.pace[0]])Object.assign(schema,fields(priceEvidenceKeys.join(' ')));
  Object.assign(daily,inventoryPolicySchemas);
  Object.assign(sourceObservation,inventoryPolicySchemas);
  detailSchema.integrated.sourceRevision=true;
  const priceDiagnosticKeys=['priceUnknownCauses','priceUnknownCauseCoverage'];
  for(const schema of [metric,detailSchema.integrated.snapshot.analysis.weekdays[0],detailSchema.integrated.snapshot.analysis.pace[0]]){
    schema.productCapacityEvidence=inventoryPolicySchemas.productCapacityEvidence;
    for(const key of priceDiagnosticKeys)schema[key]=inventoryPolicySchemas[key];
  }
  daily.sourceObservation=sourceObservation;
  detailSchema.integrated.snapshot.provenance={...fields('source companyId calculationVersion sourceRevision linkageStatus sourceDigest'),runIds:[true],selectedRunIds:[true],observations:[sourceObservation]};
  const validDay=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const reference=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value);
  function sourceProof(row,companyId,month){
    const proof=row?.sourceRecovery,at=typeof row?.collectedAt==='string'?Date.parse(row.collectedAt):NaN;
    const dayAt=validDay(row?.collectedDate)?Date.parse(row.collectedDate+'T00:00:00Z')-9*3600000:NaN;
    if(!proof||typeof companyId!=='string'||typeof month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||row.companyId!==companyId||!reference(row.runId)||!validDay(row.date)||!row.date.startsWith(month+'-')||row.productType!=='lodging'
      ||!Number.isFinite(at)||!Number.isFinite(dayAt)||at<dayAt||at>=dayAt+86400000||row.collectedDate>row.date||row.runQuality!=='unknown'
      ||proof.kind!=='saved_product_recovery_v1'||proof.originalRunQuality!=='unknown'||proof.companyId!==row.companyId||proof.runId!==row.runId
      ||proof.date!==row.date||proof.productType!==row.productType||proof.collectedAt!==row.collectedAt
      ||![proof.receiptId,proof.sourceDigest,proof.rowDigest].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))return null;
    return projectValue(proof,recoveryFields);
  }
  function sanitizeEvidenceCore(data){
    const core=clone(data),detail=core?.companyDetail,integrated=detail?.integrated,companyId=detail?.companyId,month=integrated?.selectedMonth;
    const metricEvidence=row=>{
      if(!row||typeof row!=='object'||Array.isArray(row))return;
      for(const key of priceEvidenceKeys)if(Object.hasOwn(row,key)&&row[key]!==null&&!(typeof row[key]==='number'&&Number.isFinite(row[key])&&row[key]>=0&&(!key.endsWith('Bookings')||Number.isSafeInteger(row[key]))))delete row[key];
      const evidence=policyEvidence(row),products=evidence.productCapacityEvidence;delete row.productCapacityEvidence;if(products)row.productCapacityEvidence=products;
      for(const key of priceDiagnosticKeys){delete row[key];if(Object.hasOwn(evidence,key))row[key]=evidence[key];}
    };
    const observationEvidence=(row,selectedMonth)=>{
      if(!row||typeof row!=='object'||Array.isArray(row))return;
      const proof=sourceProof(row,companyId,selectedMonth);delete row.sourceRecovery;if(proof)row.sourceRecovery=proof;
      const evidence=policyEvidence(row);for(const key of Object.keys(inventoryPolicySchemas))delete row[key];Object.assign(row,evidence);
    };
    const dailyEvidence=(rows,selectedMonth)=>{if(Array.isArray(rows))for(const row of rows){metricEvidence(row);const evidence=policyEvidence(row);for(const key of Object.keys(inventoryPolicySchemas))delete row[key];Object.assign(row,evidence);observationEvidence(row?.sourceObservation,selectedMonth);}};
    metricEvidence(detail?.current?.summary);dailyEvidence(detail?.current?.daily,month);
    if(Array.isArray(detail?.history?.months))for(const value of detail.history.months){metricEvidence(value?.summary);dailyEvidence(value?.daily,value?.month);}
    const snapshot=integrated?.snapshot;metricEvidence(snapshot?.summary);dailyEvidence(snapshot?.daily,month);
    for(const rows of [snapshot?.analysis?.weekdays,snapshot?.analysis?.pace])if(Array.isArray(rows))for(const row of rows)metricEvidence(row);
    const provenance=snapshot?.provenance,scopeValid=integrated?.companyId===companyId&&provenance?.companyId===companyId&&provenance?.calculationVersion===integrated?.calculationVersion;
    for(const value of [integrated,provenance])if(value&&Object.hasOwn(value,'sourceRevision')&&!reference(value.sourceRevision))delete value.sourceRevision;
    if(Array.isArray(provenance?.observations))for(const row of provenance.observations)observationEvidence(row,scopeValid?month:null);
    return core;
  }
  const projectedEvidenceCore=data=>{const core=projectedCore(data);return core?sanitizeEvidenceCore(core):null;};
  const previewMarker=data=>data?.calculation?.mode==='saved_only'||data?.responseCache?.preview===true||data?.responseCache?.state==='preview';
  function previewCore(data,companyId,month){
    const selected=data?.companyDetail?.integrated?.selectedMonth;
    if(data?.calculation?.mode!=='saved_only'||data.calculation.status!=='pending'||data.result!==null||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(selected||'')||selected!==(month||kst(clock()).slice(0,7)))return null;
    const core=projectedEvidenceCore(data);
    if(!core||!sourceScope(core,companyId,month)||core.companyDetail?.integrated?.status!=='ready'||core.companyDetail.integrated.calculationVersion!=='company-integrated-v4-product-max-room-reuse')return null;
    if([...(core.companyDetail.current?.daily||[]),...(core.companyDetail.integrated.snapshot?.daily||[])].some(row=>typeof row.date!=='string'||!row.date.startsWith(selected+'-')))return null;
    return {...core,calculation:{mode:'saved_only',status:'pending'},referenceLoading:true};
  }
  const disk=persistentStore||(persistenceDirectory&&namespace?require('./company-snapshot-store.cjs').createCompanySnapshotStore({directory:persistenceDirectory,namespace,version:projectionVersion,now,project:projectedEvidenceCore}):null);
  const ready=async()=>{if(disk)try{await disk.ready();}catch{}};
  const stableFingerprint=identity=>hash([identity.customer.customerId,identity.customer.revision,identity.relation,identity.company,identity.request]);
  const durableSlot=(identity,audience,isDefault)=>typeof audience==='string'&&audience&&audience.length<4096?hash([namespace,audience,identity.customer.customerId,identity.customer.revision,identity.relation,identity.company,identity.request,isDefault]):null;
  const keyFor=(scope,route,companyId,period)=>JSON.stringify([scope,route,companyId,period]);
  const expiry=entry=>entry.validUntil??entry.checkedAt+ttlMs;
  function syncIdentity(state,data){
    for(const [key,mark] of state.fingerprints){
      let parts;try{parts=JSON.parse(key);}catch{continue;}
      const checked=validatedIdentity(data,parts[2]);
      if(!checked||fingerprint(checked)!==mark){state.fingerprints.delete(key);state.bindings.delete(key);state.denied.delete(key);remove(key);pendingSources.delete(key);}
    }
    for(const [companyId,denial] of state.blockedCompanies){const checked=validatedIdentity(data,companyId);if(!checked||stableFingerprint(checked)!==denial.mark)state.blockedCompanies.delete(companyId);}
  }
  function hydrate(key,state,mark,identity,month,period,audience,stored){
    if(!disk||entries.has(key)||state.revoked||state.blockedCompanies.has(identity.company.companyId)||invalidatedScopes.has(state.scope)||active(identity.request))return;
    const slotKey=durableSlot(identity,audience,period.startsWith('default:'));if(!slotKey)return;
    let saved;try{saved=stored||disk.get(slotKey,period.replace('default:',''));}catch{return;}
    if(!saved||saved.slotKey!==slotKey||saved.month!==period.replace('default:','')||!Number.isFinite(saved.checkedAt)||saved.checkedAt>clock()||!Number.isFinite(saved.validUntil)||saved.validUntil<=clock()||saved.validUntil>saved.checkedAt+7*86400000)return;
    const core=projectedEvidenceCore(saved.core);if(!core||!sourceScope(core,identity.company.companyId,month)||!cacheable(core,identity))return;
    remember(key,state,mark,core,{checkedAt:saved.checkedAt,validUntil:saved.validUntil,persisted:true});
  }
  function remove(key) {const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}}
  function clearEntries(scope) {for(const [key,entry] of entries)if(entry.scope===scope)remove(key);}
  function invalidate(scope) {
    const state=states.get(scope);if(state)state.epoch++;
    clearEntries(scope);states.delete(scope);invalidatedScopes.delete(scope);invalidatedScopes.add(scope);while(invalidatedScopes.size>maxScopes)invalidatedScopes.delete(invalidatedScopes.values().next().value);
    for(const map of [pendingSources,pendingSaved])for(const [key,pending] of map)if(pending.scope===scope)map.delete(key);
  }
  function scopeState(scope) {
    let state=states.get(scope);
    if(!state){state={scope,epoch:0,permissionVersion:0,identity:null,fingerprints:new Map(),bindings:new Map(),blockedCompanies:new Map(),denied:new Map(),revoked:null};states.set(scope,state);}
    else{states.delete(scope);states.set(scope,state);}
    while(states.size>maxScopes)invalidate(states.keys().next().value);
    return state;
  }
  function current(state,epoch,key,fingerprint,binding) {
    return states.get(state.scope)===state&&state.epoch===epoch&&(!key||state.fingerprints.get(key)===fingerprint&&(!binding||state.bindings.get(key)===binding));
  }
  function revoke(state,reply) {
    state.epoch++;state.revoked={reply,at:clock()};state.denied.clear();state.fingerprints.clear();state.bindings.clear();state.blockedCompanies.clear();clearEntries(state.scope);
    for(const map of [pendingSources,pendingSaved])for(const [key,pending] of map)if(pending.scope===state.scope)map.delete(key);
  }
  async function safeRead(read) {
    try {
      const reply=await read();
      if(!reply||!Number.isInteger(reply.status)||!reply.data||typeof reply.data!=='object')return unavailable();
      return {status:reply.status,ok:reply.ok===true&&reply.status>=200&&reply.status<300,data:reply.data};
    }catch{return unavailable();}
  }
  function identityRead(state,readIdentity) {
    // Share only a simultaneously pending permission check, never a settled
    // permission result or a time-based authentication cache.
    if(!state.identity){
      const promise=safeRead(readIdentity);state.identity=promise;
      promise.finally(()=>{if(state.identity===promise)state.identity=null;});
    }
    return state.identity;
  }
  function validatedIdentity(data,companyId) {
    const customer=data?.customer;
    if(!customer||typeof customer.customerId!=='string'||!customer.customerId||customer.accountStatus!=='active'||!Array.isArray(customer.relations)||!Array.isArray(data.companies))return null;
    const relation=customer.relations.find(row=>row?.companyId===companyId&&['active','pending'].includes(row.status));
    const company=data.companies.find(row=>row?.companyId===companyId);
    if(!relation||!company)return null;
    const request=(Array.isArray(data.preparations)?data.preparations:[]).find(row=>row?.companyId===companyId)||null;
    return {data,customer,company,relation,request};
  }
  function fingerprint(identity) {
    return hash({customerId:identity.customer.customerId,revision:identity.customer.revision,relation:identity.relation,company:identity.company,request:identity.request,day:kst(clock())});
  }
  function sourceScope(data,companyId,month) {
    const selected=data.companyDetail?.integrated?.selectedMonth;
    return (!data.result?.companyId||data.result.companyId===companyId)&&(!data.companyDetail?.companyId||data.companyDetail.companyId===companyId)&&(!data.companyDetail?.basics?.companyId||data.companyDetail.basics.companyId===companyId)&&(!data.companyDetail?.integrated?.companyId||data.companyDetail.integrated.companyId===companyId)&&(!month||!selected||selected===month);
  }
  function cacheable(data,identity) {
    return Boolean(data.result||data.companyDetail)&&!active(identity.request)&&!active(data.request)&&!['pending','updating'].includes(data.companyDetail?.integrated?.status);
  }
  function remember(key,state,mark,data,{checkedAt=clock(),validUntil=checkedAt+ttlMs,persisted=false,preview=false}={}) {
    let core;try{core=JSON.stringify({result:data.result??null,companyDetail:data.companyDetail??null,...(preview?{calculation:{mode:'saved_only',status:'pending'},referenceLoading:true}:{})});}catch{return;}
    const size=Buffer.byteLength(core,'utf8');if(size>maxBytes||maxEntries<1||maxPerScope<1)return;
    remove(key);
    entries.set(key,{scope:state.scope,fingerprint:mark,core,bytes:size,checkedAt,validUntil,persisted,preview,needsRevalidation:persisted,lastAttempt:checkedAt,refreshFailed:false});bytes+=size;
    let scoped=[...entries].filter(([,entry])=>entry.scope===state.scope);
    while(scoped.length>maxPerScope){remove(scoped[0][0]);scoped.shift();}
    while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);
  }
  function compose(entry,identity,refreshing) {
    const core=JSON.parse(entry.core),request=clone(identity.request);
    if(entry.preview&&entry.refreshFailed&&!refreshing){core.referenceLoading=false;core.referenceError=true;core.calculation.status='failed';}
    return {status:200,ok:true,data:{...core,request,collectionAllowance:clone(identity.data.collectionAllowance),previousResult:Boolean(core.result&&request&&core.result.runId!==request.runId),responseCache:{...meta(entry.preview?'preview':'cached',entry.checkedAt,refreshing,entry.refreshFailed,entry),...(entry.preview?{preview:true,calculationStatus:entry.refreshFailed&&!refreshing?'failed':'pending'}:{})}}};
  }
  async function snapshot({scope,identity,maxViews=4,audience}={}) {
    // Only the BFF may call this while handling a successful, freshly verified
    // central /me (or administrator /start) response. It is not a replacement
    // for read(), never validates a browser-supplied identity, and never starts
    // an identity/source request or permits later GETs to skip their guard.
    if(typeof scope!=='string'||!scope||!identity||typeof identity!=='object')return [];
    const state=states.get(scope)||(disk&&validatedIdentity(identity,identity.companies?.[0]?.companyId)?scopeState(scope):null),limit=Number.isFinite(maxViews)?Math.min(4,Math.max(0,Math.floor(maxViews))):4;
    if(!state)return [];
    state.permissionVersion++;state.identity=null;syncIdentity(state,identity);
    if(state.revoked||!limit)return [];
    const epoch=state.epoch,permissionVersion=state.permissionVersion;
    await ready();if(!current(state,epoch)||state.permissionVersion!==permissionVersion)return [];
    const currentDefault=`default:${kst(clock()).slice(0,7)}`,candidates=[];
    if(disk&&!invalidatedScopes.has(scope))for(const company of identity.companies||[]){
      const checked=validatedIdentity(identity,company?.companyId);if(!checked||active(checked.request)||state.blockedCompanies.has(company.companyId))continue;
      const defaultSlot=durableSlot(checked,audience,true),explicitSlot=durableSlot(checked,audience,false),slots=[defaultSlot,explicitSlot].filter(Boolean);let stored=[];
      try{stored=disk.list(slots,{limit:maxPerScope,preferMonth:kst(clock()).slice(0,7)});}catch{}
      for(const saved of stored){
        const isDefault=saved.slotKey===defaultSlot,period=isDefault?'default:'+saved.month:saved.month;
        if(isDefault&&period!==currentDefault)continue;
        const key=keyFor(scope,'',company.companyId,period),mark=fingerprint(checked);
        if(state.fingerprints.get(key)!==mark){state.fingerprints.set(key,mark);state.bindings.set(key,{});}
        hydrate(key,state,mark,checked,isDefault?'':saved.month,period,audience,saved);
      }
    }
    while(state.fingerprints.size>maxPerScope*2){const oldest=state.fingerprints.keys().next().value;state.fingerprints.delete(oldest);state.bindings.delete(oldest);remove(oldest);pendingSources.delete(oldest);}

    for(const [key,entry] of entries){
      if(entry.scope!==scope||entry.preview)continue;
      const age=clock()-entry.checkedAt;
      if(age<0||clock()>=expiry(entry)){remove(key);continue;}
      let parts;try{parts=JSON.parse(key);}catch{continue;}
      const [storedScope,,companyId,period]=parts;
      if(storedScope!==scope||typeof companyId!=='string'||typeof period!=='string')continue;
      const isDefault=period.startsWith('default:'),month=isDefault?'':period;
      if(isDefault&&period!==currentDefault||!isDefault&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))continue;
      const checked=validatedIdentity(identity,companyId),mark=checked?fingerprint(checked):null;
      if(!checked||mark!==entry.fingerprint){
        remove(key);
        if(state.fingerprints.get(key)===entry.fingerprint)state.fingerprints.delete(key);
        state.bindings.delete(key);pendingSources.delete(key);continue;
      }
      if(state.denied.has(key))continue;
      const core=JSON.parse(entry.core);
      if(!cacheable(core,checked)||!sourceScope(core,companyId,month))continue;
      candidates.push({key,entry,checked,companyId,month,isDefault});
    }
    // Prefer a current default view. Otherwise return the newest explicit
    // month, keeping that requested month so the client cannot mislabel it.
    candidates.reverse();candidates.sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||b.entry.checkedAt-a.entry.checkedAt);
    const views=[],selected=new Set();let payloadBytes=2;
    for(const candidate of candidates){
      const {key,entry,checked,companyId,month}=candidate;
      if(selected.has(companyId))continue;
      const pending=pendingSources.get(key),refreshing=Boolean(pending&&pending.state===state&&pending.epoch===state.epoch&&pending.mark===entry.fingerprint);
      const view={companyId,month,data:compose(entry,checked,refreshing).data};
      const size=Buffer.byteLength(JSON.stringify(view),'utf8')+(views.length?1:0);
      if(payloadBytes+size>maxBytes)continue;
      payloadBytes+=size;views.push(view);selected.add(companyId);
      entries.delete(key);entries.set(key,entry);
      if(views.length>=limit)break;
    }
    return views;
  }
  function sourceRead({key,state,epoch,mark,binding,companyId,month,period,audience,identity,readSource}) {
    const former=pendingSources.get(key);
    if(former&&former.state===state&&former.epoch===epoch&&former.mark===mark&&former.binding===binding)return former.promise;
    const entry=entries.get(key);if(entry){entry.lastAttempt=clock();entry.needsRevalidation=false;}
    const slotKey=durableSlot(identity,audience,period.startsWith('default:')),savedMonth=period.replace('default:','');
    let ticket;try{if(slotKey)ticket=disk?.begin(slotKey,savedMonth);}catch{}
    const pending={scope:state.scope,state,epoch,mark,binding,promise:null};
    pending.promise=safeRead(readSource).then(async reply=>{
      if(!current(state,epoch,key,mark,binding))return invalidated();
      if(!reply.ok){
        if([401,403].includes(reply.status))revoke(state,reply);
        else if(reply.status===404){for(const [storedKey] of state.fingerprints){if(JSON.parse(storedKey)[2]===companyId){remove(storedKey);state.bindings.delete(storedKey);}}state.blockedCompanies.set(companyId,{mark:stableFingerprint(identity),reply});state.denied.set(key,{reply,mark,at:clock()});}
        else{const previous=entries.get(key);if(previous&&previous.fingerprint===mark)previous.refreshFailed=true;}
        return reply;
      }
      if(previewMarker(reply.data)||!sourceScope(reply.data,companyId,month)){
        const previous=entries.get(key);if(previous)previous.refreshFailed=true;
        return unavailable();
      }
      reply={...reply,data:sanitizeEvidenceCore(reply.data)};
      state.revoked=null;state.denied.delete(key);state.blockedCompanies.delete(companyId);
      const checkedAt=clock();
      if(cacheable(reply.data,identity)){
        const core=projectedEvidenceCore(reply.data);
        if(disk&&slotKey&&core)try{await disk.put({slotKey,month:savedMonth,checkedAt,core,ticket,guard:()=>current(state,epoch,key,mark,binding)});}catch{}
        if(!current(state,epoch,key,mark,binding))return invalidated();
        if(core&&reply.data.responseCache?.state!=='preview'&&reply.data.responseCache?.preview!==true&&reply.data.calculation?.mode!=='saved_only'&&typeof onVerifiedSource==='function')try{await onVerifiedSource({identity:identity.data,audience,companyId,month:savedMonth,data:core,checkedAt});}catch{/* A failed archive never replaces the good read; its storage status records the failure. */}
        if(!current(state,epoch,key,mark,binding))return invalidated();
        invalidatedScopes.delete(state.scope);remember(key,state,mark,reply.data,{checkedAt});
      }else remove(key);
      return {...reply,checkedAt};
    }).finally(()=>{if(pendingSources.get(key)===pending)pendingSources.delete(key);});
    pendingSources.set(key,pending);return pending.promise;
  }
  function savedPreviewRead({key,state,epoch,mark,binding,companyId,month,readSavedSource}){
    const former=pendingSaved.get(key);
    if(former&&former.state===state&&former.epoch===epoch&&former.mark===mark&&former.binding===binding)return former.promise;
    const pending={scope:state.scope,state,epoch,mark,binding,promise:null};
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable()),Math.max(1,savedReadTimeoutMs));});
    pending.promise=Promise.race([safeRead(readSavedSource),timeout]).then(reply=>{
      if(!current(state,epoch,key,mark,binding))return invalidated();
      if(!reply.ok){if([401,403].includes(reply.status)){revoke(state,reply);return reply;}return {unsupported:true};}
      const core=previewCore(reply.data,companyId,month);
      if(!core)return {unsupported:true};
      const final=entries.get(key);
      if(final&&final.fingerprint===mark&&!final.preview&&clock()<expiry(final))return {status:200,ok:true,entry:final};
      // A preview is display-only. It must never enter the durable normal
      // snapshot store or the verified daily-review archive.
      remember(key,state,mark,core,{preview:true});
      const entry=entries.get(key);return entry?{status:200,ok:true,entry}:{unsupported:true};
    }).finally(()=>{clearTimeout(timer);if(pendingSaved.get(key)===pending)pendingSaved.delete(key);});
    pendingSaved.set(key,pending);return pending.promise;
  }
  async function read({scope,route='',companyId,month='',audience,readIdentity,readSource,readSavedSource,force=false}) {
    if(typeof scope!=='string'||!scope||typeof readIdentity!=='function'||typeof readSource!=='function')return unavailable();
    if(!/^[a-zA-Z0-9_-]+$/.test(companyId||'')||typeof month!=='string'||month&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))return failure(400,'INVALID_COMPANY_MONTH','업체와 숙박월을 확인해 주세요.');
    const state=scopeState(scope),epoch=state.epoch,permissionVersion=state.permissionVersion;
    const checked=await identityRead(state,readIdentity);
    if(!current(state,epoch)||state.permissionVersion!==permissionVersion)return invalidated();
    if(!checked.ok){if([401,403].includes(checked.status))revoke(state,checked);return checked;}
    syncIdentity(state,checked.data);const identity=validatedIdentity(checked.data,companyId);
    if(!identity){state.epoch++;state.fingerprints.clear();state.bindings.clear();state.denied.clear();clearEntries(scope);return notFound();}
    const day=kst(clock()),period=month||`default:${day.slice(0,7)}`,key=keyFor(scope,route,companyId,period),mark=fingerprint(identity);
    const previousMark=state.fingerprints.get(key);
    if(previousMark&&previousMark!==mark){remove(key);state.bindings.delete(key);state.denied.delete(key);}
    state.fingerprints.delete(key);state.fingerprints.set(key,mark);
    const binding=state.bindings.get(key)||{};state.bindings.set(key,binding);
    // Bound metadata as well as payloads; evicted in-flight reads may finish but
    // no longer have the matching fingerprint needed to insert an old result.
    while(state.fingerprints.size>maxPerScope*2){const oldest=state.fingerprints.keys().next().value;state.fingerprints.delete(oldest);state.bindings.delete(oldest);state.denied.delete(oldest);remove(oldest);}
    if(!disk&&state.revoked&&clock()-state.revoked.at>ttlMs)state.revoked=null;
    if(state.revoked&&!force)return state.revoked.reply;
    const blocked=state.blockedCompanies.get(companyId);if(blocked&&!force)return blocked.reply;
    const denied=state.denied.get(key);
    if(denied&&(denied.mark!==mark||!disk&&clock()-denied.at>ttlMs))state.denied.delete(key);
    else if(denied&&!force)return denied.reply;
    await ready();if(!current(state,epoch,key,mark,binding)||state.permissionVersion!==permissionVersion)return invalidated();
    for(const [entryKey,entry] of entries)if(clock()<entry.checkedAt||clock()>=expiry(entry))remove(entryKey);
    const previewEnabled=typeof readSavedSource==='function';
    if(!force||previewEnabled)hydrate(key,state,mark,identity,month,period,audience);
    const entry=entries.get(key);
    const context={key,state,epoch,mark,binding,companyId,month,period,audience,identity,readSource};
    if(entry&&entry.fingerprint===mark&&!force&&!active(identity.request)){
      entries.delete(key);entries.set(key,entry);
      let refreshing=pendingSources.has(key);
      if(!refreshing&&(force||entry.needsRevalidation||entry.preview&&!entry.refreshFailed||clock()-entry.lastAttempt>=refreshMs)){void sourceRead(context);refreshing=true;}
      return compose(entry,identity,refreshing);
    }
    if(previewEnabled&&!active(identity.request)){
      const saved=await savedPreviewRead({...context,readSavedSource});
      if(!saved.ok&&!saved.unsupported)return saved;
      if(!current(state,epoch,key,mark,binding))return invalidated();
      if(saved.entry){void sourceRead(context);return compose(saved.entry,identity,true);}
    }
    const reply=await sourceRead(context);
    if(!reply.ok)return reply;
    if(!current(state,epoch,key,mark,binding))return invalidated();
    if(!sourceScope(reply.data,companyId,month))return unavailable();
    return {...reply,data:{...clone(reply.data),responseCache:meta('fresh',reply.checkedAt??clock())}};
  }
  const flushPersistence=()=>disk?disk.flush():Promise.resolve();
  return {read,invalidate,snapshot,ready,flush:flushPersistence,flushPersistence,persistenceStatus:()=>disk?disk.status():{enabled:false}};
}
module.exports={createCompanyReadCache};
