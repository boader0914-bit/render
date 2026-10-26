'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fault, fields, hash, active } = require('./insight_store.cjs');
const {readableRegionIds}=require('./insight_analysis.cjs');
const {comparisonRegionBindings}=require('./insight_region_summary.cjs');
const csrf = token => crypto.createHmac('sha256', token).update('insight-csrf-v1').digest('base64url');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a || '')), Buffer.from(hash(b || '')));
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fault('JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw fault('BODY_TOO_LARGE', '입력 내용이 너무 큽니다.', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('INVALID_JSON', '입력 내용을 확인해 주세요.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_JSON', '객체 형식으로 요청해 주세요.');
  return value;
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function createInsightHttp({ store, serviceToken, authenticateMember, memberActive, registerMember, checkUsername, catalog, stateCatalog = catalog, requireAdmin, preparationBridge = null,
  signup = { enabled: false }, policies = {}, supportEmail = '', adminStore = null, collectionResults = null, savedCollectionResults = null, analysis = null, reportDelivery = null, renderReportPdf = null, recurringCollection = null,
  identityDiagnostics = entry => console.warn('insight_identity',JSON.stringify(entry)), identityClock = () => performance.now(),
  companyDiagnostics = entry => console.warn('insight_company_http',JSON.stringify(entry)), companyClock = () => performance.now() }) {
  if (typeof serviceToken !== 'string' || serviceToken.length < 32) throw new Error('Insight service credential must contain at least 32 characters');
  // Receipt verification reads saved results only. Bootstrap must not wait for
  // it, and simultaneous bootstrap/poll requests must share the same refresh.
  const preparationRefreshes = new Map();
  const companyRequests = new WeakMap();
  function companyTiming(month) {
    const requestId=crypto.randomUUID(),started=companyClock(),requestedMonth=month||'default';
    const emit=(stage,outcome,stageStarted=started,status)=>{
      const at=companyClock(),entry={requestId,requestedMonth,stage,outcome,elapsedMs:Math.max(0,Math.round(at-stageStarted)),totalMs:Math.max(0,Math.round(at-started)),
        ...(Number.isInteger(status)?{status}:{})};
      // Seven bounded, controlled records at most. No company/account ID,
      // user-supplied request ID, token, payload or exception enters the log.
      try{companyDiagnostics(entry);}catch{}
    };
    const begin=stage=>{const at=companyClock();emit(stage,'started',at);return at;};
    const end=(stage,at,outcome='complete')=>emit(stage,outcome,at);
    return {requestId,begin,end,responded:status=>emit('responded',status<400?'complete':'failed',started,status),
      async stage(stage,read){const at=begin(stage);try{const value=await read();end(stage,at);return value;}catch(error){end(stage,at,'failed');throw error;}}};
  }
  async function identityStage(stage,requestId,read) {
    const started=identityClock();let outcome='complete';
    try{return await read();}catch(error){outcome='failed';throw error;}
    finally{
      const elapsedMs=Math.max(0,Math.round(identityClock()-started));
      // Only fixed stage names and random correlation IDs enter these bounded
      // diagnostics. Account IDs, cookies, sessions and source errors never do.
      if(elapsedMs>=1000)try{identityDiagnostics({requestId,route:'state',stage,outcome,elapsedMs});}catch{}
    }
  }
  function refreshPreparation(customerId, deferred = false) {
    if (!preparationBridge) return Promise.resolve();
    if (preparationRefreshes.has(customerId)) return preparationRefreshes.get(customerId);
    const pending = new Promise((resolve, reject) => {
      const start = () => Promise.resolve().then(() => preparationBridge.refresh(customerId)).then(resolve, reject);
      if (deferred) setImmediate(start); else start();
    });
    preparationRefreshes.set(customerId, pending);
    const clear = () => { if (preparationRefreshes.get(customerId) === pending) preparationRefreshes.delete(customerId); };
    // Handle rejection even when only a background bootstrap is observing it;
    // callers that explicitly await verification still receive that failure.
    pending.then(clear, clear);
    return pending;
  }
  function currentCustomer(token, customerId) {
    const current = store.authenticate(token);
    if (current.customerId !== customerId) throw fault('LOGIN_REQUIRED', '다시 로그인해 주세요.', 401);
    return current;
  }
  function customerScope(token, customerId) {
    let memberId;
    return { async verify() {
      memberId = currentCustomer(token, customerId).memberId;
      if (!await memberActive(memberId)) {
        store.logout(token);
        throw fault('ACCOUNT_DISABLED', '이용자 계정이 중지되었습니다.', 403);
      }
    }, current() {
      const current = currentCustomer(token, customerId);
      if (current.memberId !== memberId) throw fault('LOGIN_REQUIRED', '다시 로그인해 주세요.', 401);
      return current;
    } };
  }
  function currentAdminCustomer(token, customerId, preview = false) {
    const admin = adminStore.authenticate(token);
    const customer = store.get(customerId);
    if (preview && customer.memberId !== 'insight-admin:' + admin.adminId) throw fault('CUSTOMER_VIEW_REQUIRED', '고객 화면을 다시 열어 주세요.', 409);
    if (preview && customer.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '고객 체험 계정의 이용이 중지되었습니다.', 403);
    return customer;
  }
  function state(customer, data) {
    const allowed = new Set(customer.relations.filter(active).map(row => row.companyId));
    const companies = data.companies.filter(row => allowed.has(row.companyId));
    const regionKeys = readableRegionIds(customer,data);
    const unlimited=customer.accountKind==='admin_preview';
    return { customer, companies, regions: data.regions.filter(row => regionKeys.has(row.id)), comparisonRegionBindings:comparisonRegionBindings(customer,data), corrections: store.corrections(customer.customerId),
      registrationAllowance:{ownLimit:unlimited?null:1,competitorLimit:unlimited?null:customer.entitlements.competitorLimit,interestRegionLimit:unlimited?null:customer.entitlements.interestRegionLimit},
      preparations: store.requests(customer.customerId), collectionAllowance:store.collectionAllowance(customer.customerId),
      recurringCollections: recurringCollection ? recurringCollection.forCustomer(customer.customerId).filter(row=>allowed.has(row.companyId)&&companies.some(company=>company.companyId===row.companyId)) : [],
      features: { weeklyReports: false, reportDelivery: Boolean(reportDelivery), directCollection: Boolean(preparationBridge && collectionResults), dataPreparationRequests: true, recurringCollectionRequests:Boolean(recurringCollection) } };
  }
  function recurringAdminState() {
    const value=recurringCollection.adminState();
    return {recurringCollections:recurringCollection.adminList(),defaults:{time:value.defaults.time,bookingRangeDays:value.defaults.bookingRangeDays,timezone:value.defaults.timezone}};
  }
  async function sendState(res, customer, scope, extra = {}, { awaitPreparation = false } = {}) {
    const started = performance.now(),requestId=crypto.randomUUID();
    // Mutations retain their existing verified receipt transition. Only state
    // bootstrap reads are allowed to leave this work in the background.
    if (awaitPreparation && preparationBridge) await refreshPreparation(customer.customerId);
    const catalogStarted = performance.now();
    const data = await identityStage('catalog',requestId,()=>stateCatalog());
    const catalogDuration = performance.now() - catalogStarted;
    if (scope?.verify) await identityStage('member',requestId,()=>scope.verify());
    // There is deliberately no await between the final session/relationship
    // read and JSON serialization, including after asynchronous member checks.
    const current = scope?.current ? scope.current() : store.get(customer.customerId);
    if (!current) return;
    const value = state(current, data);
    if (typeof res.setHeader === 'function') res.setHeader('Server-Timing', `state_catalog;dur=${Math.max(0, catalogDuration).toFixed(1)}, state_total;dur=${Math.max(0, performance.now() - started).toFixed(1)}`);
    json(res, 200, { ...value, ...extra });
    // Schedule after ending the response. No dispatch/retry is performed here,
    // and the returned state retains the last genuinely verified job status.
    if (!awaitPreparation) refreshPreparation(value.customer.customerId, true);
  }
  async function companyCollection(c, companyId, month, { savedOnly = false, timing = null } = {}) {
    if (!store.hasCompany(c,companyId) || !(savedOnly ? savedCollectionResults : collectionResults)) throw fault('NOT_FOUND','등록한 업체의 결과를 찾을 수 없습니다.',404);
    // Polling remains available (10-second interval), but changing an arbitrary
    // month cannot issue unbounded expensive source reads for a customer.
    store.throttle(`company-read:${c.customerId}`,240);
    if (savedOnly) {
      // This preview reads one verified, already saved month only. In particular,
      // do not refresh collection receipts or enter the normal evidence/detail
      // readers merely to show the last successful calculation.
      const company = (await catalog()).companies.find(row => row.companyId === companyId);
      if (!company) throw fault('NOT_FOUND','등록한 업체의 자료를 찾을 수 없습니다.',404);
      const detail = await savedCollectionResults.companyDetail(companyId, { month, company });
      return { request: null, result: null,
        companyDetail: { ...detail, source:'company_db_integrated_saved', basics: { name:company.name,address:company.address,
          rooms:detail.integrated.roomBasis?.count ?? company.rooms,roomCountSource:detail.integrated.roomBasis?.label || company.roomCountSource,
          facilities:company.facilities,lodgingTypes:[] } },
        previousResult:false,referenceLoading:true,
        calculation:{mode:'saved_only',status:'pending'},responseCache:{state:'preview',preview:true,refreshing:true} };
    }
    const stage=(name,read)=>timing?timing.stage(name,read):read();
    await stage('preparation_wait',async()=>{if(preparationBridge)await refreshPreparation(c.customerId);});
    const request = store.requests(c.customerId).find(row => row.companyId===companyId) || null;
    // A customer's previous request must not pin the shared company DB to an old run.
    const {companyDetail,result}=await stage('view_read',async()=>{
      const view=typeof collectionResults.readView==='function'?await collectionResults.readView(companyId,{month}):null;
      return view||{companyDetail:await collectionResults.companyDetail?.(companyId,{month})||null,result:await collectionResults.read(companyId)};
    });
    return {request,result,companyDetail,collectionAllowance:store.collectionAllowance(c.customerId),previousResult:Boolean(result && request && result.runId!==request.runId)};
  }
  async function customerRequest(req, res, url, tail, c, token, context = {}, scope = customerScope(token, c.customerId)) {
      if (req.method === 'GET' && tail === '/me') await sendState(res, c, scope, { csrfToken: csrf(token), ...context });
      else if(['GET','POST'].includes(req.method)&&/^\/companies\/[a-zA-Z0-9_-]+\/recurring-collection$/.test(tail)) {
        if(!recurringCollection)throw fault('RECURRING_COLLECTION_NOT_READY','정기수집 요청 연결을 준비 중입니다.',503);
        if(url.search)throw fault('INVALID_FIELDS','등록한 업체의 정기수집 요청만 지정해 주세요.');
        const companyId=tail.split('/')[2];let payload;
        if(req.method==='POST'){payload=await body(req);fields(payload,['requestKey']);store.throttle(`recurring-request:${c.customerId}`,30);}
        if(scope?.verify)await scope.verify();
        const current=scope?.current?scope.current():store.get(c.customerId);
        if(!store.hasCompany(current,companyId))throw fault('NOT_FOUND','등록한 업체의 정기수집 요청을 찾을 수 없습니다.',404);
        const record=req.method==='POST'?await recurringCollection.request(current.customerId,companyId,payload):recurringCollection.get(current.customerId,companyId);
        if(scope?.verify)await scope.verify();
        const latest=scope?.current?scope.current():store.get(c.customerId);
        if(!store.hasCompany(latest,companyId))throw fault('NOT_FOUND','등록한 업체의 정기수집 요청을 찾을 수 없습니다.',404);
        json(res,200,{recurringCollection:record,recurringCollections:recurringCollection.forCustomer(latest.customerId).filter(row=>store.hasCompany(latest,row.companyId))});
      }
      else if(['GET','POST'].includes(req.method)&&/^\/regions\/[a-zA-Z0-9_-]+\/preparation$/.test(tail)) {
        if(!analysis)throw fault('REGION_NOT_READY','지역 자료 연결을 준비 중입니다.',503);
        let month;
        if(req.method==='POST') {
          if(url.search)throw fault('INVALID_FIELDS','기준월만 지정해 주세요.');
          const p=await body(req);fields(p,['month']);month=p.month;
          store.throttle(`region-preparation:${c.customerId}`,6);
        } else {
          if([...url.searchParams.keys()].some(k=>k!=='month')||url.searchParams.getAll('month').length!==1)throw fault('INVALID_FIELDS','기준월만 지정해 주세요.');
          month=url.searchParams.get('month');
        }
        const result=await analysis.preparation(c,tail.split('/')[2],month,req.method==='POST');
        json(res,req.method==='POST'&&['queued','running'].includes(result.job?.status)?202:200,result);
      }
      else if(req.method==='GET' && tail==='/regions/comparison-summary') {
        if(!analysis?.comparisonRegionSelection||!analysis?.comparisonRegionSummary)throw fault('REGION_NOT_READY','지역 자료 연결을 준비 중입니다.',503);
        if([...url.searchParams.keys()].some(key=>!['ownId','month'].includes(key))||url.searchParams.getAll('ownId').length>1||url.searchParams.getAll('month').length>1
          ||url.searchParams.has('ownId')&&!/^[a-zA-Z0-9_-]{1,200}$/.test(url.searchParams.get('ownId'))||url.searchParams.has('month')&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('month')))throw fault('INVALID_FIELDS','등록한 내 매장과 마감월만 선택해 주세요.');
        const ownId=url.searchParams.get('ownId')||null,month=url.searchParams.get('month')||undefined;
        if(scope?.verify)await scope.verify();
        const data=await catalog(),current=scope?.current?scope.current():store.get(c.customerId);
        const selection=analysis.comparisonRegionSelection(current,ownId,month,data),value=await analysis.comparisonRegionSummary(selection,data);
        // The catalog and membership can both change while saved indicators
        // are loading. Re-derive the entire registration/mapping boundary, then
        // serialize in the same turn as the final fresh session/customer check.
        const latestData=await catalog();
        if(scope?.verify)await scope.verify();
        const latest=scope?.current?scope.current():store.get(c.customerId),checked=analysis.comparisonRegionSelection(latest,ownId,month,latestData);
        if(selection.fingerprint!==checked.fingerprint)throw fault('REGION_SUMMARY_SCOPE_CHANGED','등록 업체 또는 지역 연결이 변경되었습니다. 다시 조회해 주세요.',409);
        json(res,200,value);
      }
      else if(req.method==='GET' && /^\/regions\/[a-zA-Z0-9_-]+\/analysis$/.test(tail)) {
        if(!analysis)throw fault('REGION_NOT_READY','지역 자료 연결을 준비 중입니다.',503);
        if([...url.searchParams.keys()].some(k=>k!=='month')||url.searchParams.getAll('month').length>1)throw fault('INVALID_FIELDS','조회할 기준월만 지정해 주세요.');
        json(res,200,await analysis.region(c,tail.split('/')[2],url.searchParams.get('month')||undefined));
      }
      else if (req.method === 'GET' && (tail === '/reports' || /^\/reports\/mr_[a-zA-Z0-9_-]+(?:\/pdf)?$/.test(tail))) {
        if (!reportDelivery) throw fault('REPORT_NOT_READY', '발행 리포트 제공을 준비 중입니다.', 409);
        if (url.search) throw fault('INVALID_FIELDS', '발행된 리포트 번호만 지정해 주세요.');
        const verifyAccess = async () => { if (scope?.verify) await scope.verify(); return scope.current(); };
        if (tail === '/reports') json(res, 200, await reportDelivery.list(c.customerId, { verifyAccess }));
        else if (!tail.endsWith('/pdf')) json(res, 200, await reportDelivery.detail(c.customerId, tail.split('/')[2], { verifyAccess }));
        else {
          if (typeof renderReportPdf !== 'function') throw fault('REPORT_NOT_READY', 'PDF 제공을 준비 중입니다.', 409);
          const id = tail.split('/')[2], report = await reportDelivery.authorizedReport(c.customerId, id, { verifyAccess });
          const buffer = await renderReportPdf(report);
          await reportDelivery.authorizedReport(c.customerId, id, { verifyAccess });
          if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024 || buffer.subarray(0, 5).toString() !== '%PDF-') throw fault('REPORT_UNAVAILABLE', 'PDF를 확인하지 못했습니다.', 503);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length,
            'Content-Disposition': `attachment; filename="monthly-report-${report.month}-v${report.version}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(buffer);
        }
      }
      else if(req.method==='GET' && tail==='/reports/briefing') {
        if(!analysis)throw fault('REPORT_NOT_READY','리포트 연결을 준비 중입니다.',503);
        const allowed=['ownId','savedOnly','stayMode','month','start','end'];
        if([...url.searchParams.keys()].some(k=>!allowed.includes(k))||allowed.some(key=>url.searchParams.getAll(key).length>1)||url.searchParams.has('savedOnly')&&url.searchParams.get('savedOnly')!=='1')throw fault('INVALID_FIELDS','등록한 내 매장과 숙박기간, 저장 자료 조회 방식만 선택해 주세요.');
        const selection=Object.fromEntries(['stayMode','month','start','end'].filter(key=>url.searchParams.has(key)).map(key=>[key,url.searchParams.get(key)]));
        json(res,200,await analysis.briefing(c,url.searchParams.get('ownId')||undefined,{...selection,savedOnly:url.searchParams.get('savedOnly')==='1'}));
      }
      else if (req.method === 'GET' && /^\/companies\/[a-zA-Z0-9_-]+\/collection$/.test(tail)) {
        if ([...url.searchParams.keys()].some(key => !['month','savedOnly'].includes(key)) || url.searchParams.getAll('month').length > 1
          || url.searchParams.getAll('savedOnly').length > 1 || url.searchParams.has('savedOnly') && url.searchParams.get('savedOnly') !== '1') throw fault('INVALID_FIELDS','조회할 숙박월과 저장 자료 조회 방식만 지정해 주세요.');
        const month = url.searchParams.get('month') || undefined;
        if (url.searchParams.has('month') && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month || '')) throw fault('INVALID_MONTH','숙박월 형식을 확인해 주세요.');
        const savedOnly = url.searchParams.get('savedOnly') === '1';
        if (savedOnly && !month) throw fault('INVALID_MONTH','저장 자료를 조회할 숙박월을 선택해 주세요.');
        const timing=savedOnly?null:companyTiming(month);
        if(timing){companyRequests.set(req,timing);if(typeof res.setHeader==='function')res.setHeader('X-Insight-Company-Request-Id',timing.requestId);}
        const companyId=tail.split('/')[2],value=await companyCollection(c,companyId,month,{savedOnly,timing});
        const permissionStarted=timing?.begin('permission_verify');
        try{
          if(scope?.verify)await scope.verify();
          // Keep the final fresh session/relationship check and serialization
          // in the same turn, including after asynchronous full-data reads.
          const current=scope?.current?scope.current():store.get(c.customerId);
          if(!store.hasCompany(current,companyId))throw fault('NOT_FOUND','등록한 업체의 결과를 찾을 수 없습니다.',404);
          value.request=store.requests(current.customerId).find(row=>row.companyId===companyId)||null;
          value.collectionAllowance=store.collectionAllowance(current.customerId);
          if(!savedOnly)value.previousResult=Boolean(value.result&&value.request&&value.result.runId!==value.request.runId);
          timing?.end('permission_verify',permissionStarted);
        }catch(error){timing?.end('permission_verify',permissionStarted,'failed');throw error;}
        json(res,200,value);
        timing?.responded(200);
      }
      else if (!context.view && req.method === 'POST' && tail === '/auth/logout') { store.logout(token); json(res, 200, { ok: true }); }
      else if (req.method === 'GET' && ['/catalog/companies', '/catalog/regions'].includes(tail)) {
        const query = (url.searchParams.get('q') || '').normalize('NFKC').trim().toLowerCase();
        if (query.length < 2 || query.length > 120) throw fault('SEARCH_QUERY', '두 글자 이상으로 검색해 주세요.');
        const data = await catalog();
        const rows = tail.endsWith('/companies') ? data.companies : data.regions.filter(row => row.level === 'local');
        const results = rows.filter(row => [row.name, row.address, row.label, ...(row.placeIds || [])].filter(Boolean).join(' ').toLowerCase().includes(query)).sort((a,b) => String(a.name || a.label).localeCompare(String(b.name || b.label), 'ko')).slice(0, 30);
        // Registration candidates intentionally contain no private notes, analysis or raw observations.
        json(res, 200, { results: results.map(row => tail.endsWith('/companies') ? { companyId: row.companyId, name: row.name, address: row.address, placeIds: row.placeIds, regionLabel: row.regionLabel } : row) });
      } else if (req.method === 'POST' && tail === '/commands') {
        store.throttle(`changes:${c.customerId}`, 120);
        const command = await body(req); const data = await catalog();
        const company = data.companies.find(row => row.companyId === command.payload?.companyId);
        let result;
        if (command.action === 'collect') {
          if (!preparationBridge || !collectionResults) throw fault('COLLECTION_NOT_READY','수집 연결을 준비 중입니다.',409);
          const p=command.payload; fields(p,['companyId','checkIn','bookingRangeDays','dayUseMode']);
          if (p.bookingRangeDays !== 30) throw fault('INVALID_COLLECTION_RANGE','예약·추정매출 수집 기간은 30일입니다.');
          const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
          const stamp=Date.parse(`${p.checkIn}T00:00:00Z`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(p.checkIn||'') || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10)!==p.checkIn || p.checkIn<today || p.checkIn>new Date(Date.now()+366*86400000).toISOString().slice(0,10) || !Number.isInteger(p.bookingRangeDays) || p.bookingRangeDays<1 || p.bookingRangeDays>31 || !['inspect','lodging_only','detail'].includes(p.dayUseMode)) throw fault('INVALID_COLLECTION_RANGE','숙박 시작일과 데이유즈 범위를 확인해 주세요.');
          if (!company || !store.hasCompany(c,company.companyId)) throw fault('NOT_FOUND','등록한 업체를 찾을 수 없습니다.',404);
          if (company.placeIds?.length!==1) throw fault('PLACE_REVIEW_REQUIRED','업체 고유번호 확인이 필요합니다.',409);
          store.throttle(`collection:${c.customerId}`,20);
          result=store.preparation(c.customerId,command,company);
          const request=store.requests(c.customerId).find(row=>row.observationDay===today && row.companyId===company.companyId && JSON.stringify(row.intent)===JSON.stringify({checkIn:p.checkIn,bookingRangeDays:p.bookingRangeDays,dayUseMode:p.dayUseMode}));
          await preparationBridge.dispatch(c.customerId,{requestId:request.requestId,checkIn:p.checkIn,bookingRangeDays:p.bookingRangeDays,dayUseMode:p.dayUseMode},c.customerId);
        }
        else if (command.action === 'product-correction') {
          const view=await companyCollection(c,company?.companyId);
          result=store.correct(c.customerId,command,company,view.result);
        }
        else if (['correction', 'withdraw-correction'].includes(command.action)) result = store.correct(c.customerId, command, company);
        else if (command.action === 'prepare-data') result = store.preparation(c.customerId, command, company);
        else result = store.update(c.customerId, command, data);
        await sendState(res, result, scope, { csrfToken: csrf(token), ...context }, { awaitPreparation: true });
      } else throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
  }
  const policyUrl = (value, kind) => {
    if (value === `/${kind}`) return policies[kind]?.version === signup[`${kind}Version`];
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  };
  const signupReady = signup.enabled === true && registerMember && signup.termsVersion && signup.privacyVersion && policyUrl(signup.termsUrl, 'terms') && policyUrl(signup.privacyUrl, 'privacy');
  async function internal(req, res, url) {
    const base = '/api/insight/v1';
    if (!url.pathname.startsWith(base + '/')) return false;
    try {
      if (!equal(req.headers.authorization, `Bearer ${serviceToken}`)) throw fault('SERVICE_UNAUTHORIZED', '서비스 연결 인증이 필요합니다.', 401);
      const tail = url.pathname.slice(base.length);
      if (!['GET', 'POST'].includes(req.method)) throw fault('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405);
      if (tail.startsWith('/admin/')) {
        if (!adminStore) throw fault('NOT_FOUND', '관리자 로그인을 준비 중입니다.', 404);
        if (tail === '/admin/auth/login' && req.method === 'POST') {
          const p = await body(req); fields(p, ['username', 'password']);
          const result = await adminStore.login(p.username, p.password);
          json(res, 200, { ...result, csrfToken: csrf(result.token) }); return true;
        }
        const token = req.headers['x-insight-admin-session'];
        const admin = adminStore.authenticate(token);
        if (req.method === 'POST' && !equal(req.headers['x-csrf-token'], csrf(token))) throw fault('CSRF_INVALID', '관리자 화면을 새로 열어 주세요.', 403);
        if (tail.startsWith('/admin/customer-view/')) {
          const route = tail.slice('/admin/customer-view'.length);
          const context = { view: { mode: 'admin_customer', adminUsername: admin.username } };
          if (route === '/config' && req.method === 'GET') {
            json(res, 200, { signupEnabled: false, supportEmail, usernameCheckEnabled: false }); return true;
          }
          if (req.method === 'GET' && ['/policies/terms', '/policies/privacy'].includes(route)) {
            const doc = policies[route.split('/').pop()];
            if (!doc) throw fault('NOT_FOUND', '안내 문서를 준비 중입니다.', 404);
            json(res, 200, doc); return true;
          }
          const memberId = 'insight-admin:' + admin.adminId;
          let customer;
          if (route === '/start' && req.method === 'POST') {
            fields(await body(req), []);
            customer = store.ensure({ memberId, username: admin.username, role: 'b2b', status: 'active', accountKind: 'admin_preview' });
          } else customer = store.findMember(memberId);
          if (!customer) throw fault('CUSTOMER_VIEW_REQUIRED', '고객 화면을 다시 열어 주세요.', 409);
          if (customer.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '고객 체험 계정의 이용이 중지되었습니다.', 403);
          const scope = { current: () => currentAdminCustomer(token, customer.customerId, true) };
          if (route === '/start' && req.method === 'POST') await sendState(res, customer, scope, { csrfToken: csrf(token), ...context });
          else await customerRequest(req, res, url, route, customer, token, context, scope);
          return true;
        }
        if (tail === '/admin/me' && req.method === 'GET') json(res, 200, { admin, csrfToken: csrf(token) });
        else if(tail==='/admin/recurring-collections'&&req.method==='GET') {
          if(!recurringCollection)throw fault('RECURRING_COLLECTION_NOT_READY','정기수집 요청 연결을 준비 중입니다.',503);
          if(url.search)throw fault('INVALID_FIELDS','정기수집 요청 목록만 조회해 주세요.');
          json(res,200,recurringAdminState());
        }
        else if(tail==='/admin/recurring-collections/review'&&req.method==='POST') {
          if(!recurringCollection)throw fault('RECURRING_COLLECTION_NOT_READY','정기수집 요청 연결을 준비 중입니다.',503);
          if(url.search)throw fault('INVALID_FIELDS','정기수집 심사 내용만 지정해 주세요.');
          const payload=await body(req);fields(payload,['companyId','decision','reason','time','requestKey']);
          const currentAdmin=adminStore.authenticate(token);store.throttle(`recurring-review:${currentAdmin.adminId}`,120);
          const record=await recurringCollection.review(payload,currentAdmin.adminId);
          adminStore.authenticate(token);json(res,200,{recurringCollection:record,...recurringAdminState()});
        }
        else if (tail === '/admin/auth/logout' && req.method === 'POST') { adminStore.logout(token); json(res, 200, { ok: true }); }
        else if (tail === '/admin/customers' && req.method === 'GET') json(res, 200, { customers: store.list().map(c => ({ customerId: c.customerId, username: c.username, accountKind: c.accountKind || 'customer', accountStatus: c.accountStatus, businessStatus: c.businessStatus, projectName: c.projectName, entitlements: c.entitlements, relations: c.relations.filter(active) })) });
        else {
          const match = /^\/admin\/customers\/(cus_[a-zA-Z0-9-]+)(\/commands)?$/.exec(tail);
          if (!match) throw fault('NOT_FOUND', '지원하지 않는 관리자 기능입니다.', 404);
          if (req.method === 'GET' && !match[2]) await sendState(res, store.get(match[1]), { current: () => currentAdminCustomer(token, match[1]) }, { history: store.history(match[1]) });
          else if (req.method === 'POST' && match[2]) {
            store.throttle(`admin-changes:${admin.adminId}`, 120);
            store.adminUpdate(match[1], await body(req), admin.adminId, await catalog());
            await sendState(res, store.get(match[1]), { current: () => currentAdminCustomer(token, match[1]) }, {}, { awaitPreparation: true });
          } else throw fault('NOT_FOUND', '지원하지 않는 관리자 기능입니다.', 404);
        }
        return true;
      }
      if (tail === '/config' && req.method === 'GET') { json(res, 200, { signupEnabled: Boolean(signupReady), signupMessage: signupReady ? '' : '현재 신규 가입을 준비하고 있습니다. 이용 문의를 남겨 주세요.', termsVersion: signup.termsVersion || null, privacyVersion: signup.privacyVersion || null, termsUrl: signup.termsUrl || null, privacyUrl: signup.privacyUrl || null, supportEmail, usernameCheckEnabled: Boolean(checkUsername) }); return true; }
      if (req.method === 'GET' && ['/policies/terms', '/policies/privacy'].includes(tail)) {
        const doc = policies[tail.split('/').pop()];
        if (!doc) throw fault('NOT_FOUND', '안내 문서를 준비 중입니다.', 404);
        json(res, 200, doc); return true;
      }
      if (req.method === 'GET' && tail === '/auth/username') {
        if (!signupReady || !checkUsername) throw fault('SIGNUP_NOT_READY', '현재 신규 가입을 받지 않습니다.', 403);
        store.throttle('signup-username-check', 120);
        json(res, 200, await checkUsername(url.searchParams.get('username') || '')); return true;
      }
      if ((tail === '/auth/login' || tail === '/auth/signup') && req.method === 'POST') {
        const p = await body(req);
        fields(p, ['username', 'password', 'passwordConfirm', 'phone', 'email', 'agreeTerms', 'agreePrivacy', 'confirmAge', 'termsVersion', 'privacyVersion', 'businessStatus', 'projectName']);
        if (typeof p.username !== 'string' || p.username.length > 120 || typeof p.password !== 'string' || p.password.length > 256) throw fault('INVALID_LOGIN', '아이디와 비밀번호를 확인해 주세요.');
        store.throttle(`auth:${p.username.trim().toLowerCase()}`, 10);
        store.throttle('auth-service-total', 100);
        let member;
        if (tail === '/auth/signup') {
          if (!signupReady) throw fault('SIGNUP_NOT_READY', '회원가입 준비 중입니다. 관리자에게 문의해 주세요.', 503);
          if (p.termsVersion !== signup.termsVersion || p.privacyVersion !== signup.privacyVersion || p.agreeTerms !== true || p.agreePrivacy !== true || p.confirmAge !== true) throw fault('CONSENT_REQUIRED', '최신 약관과 개인정보 안내를 확인해 주세요.');
          if (p.businessStatus !== undefined && !['owned', 'planning'].includes(p.businessStatus)) throw fault('INVALID_INPUT', '운영 중 또는 준비 중을 선택해 주세요.');
          if (p.projectName !== undefined && (typeof p.projectName !== 'string' || p.projectName.length > 100)) throw fault('INVALID_INPUT', '매장·프로젝트 이름은 100자 이내로 입력해 주세요.');
          if (typeof p.phone !== 'string' || !/^\+?[0-9 ()-]{7,30}$/.test(p.phone) || p.phone.replace(/\D/g, '').length < 7 || typeof p.email !== 'string' || p.email.length > 120) throw fault('INVALID_INPUT', '연락처와 이메일 형식을 확인해 주세요.');
          const { businessStatus, projectName, ...registration } = p;
          member = await registerMember({ ...registration, ownershipStatus: businessStatus || 'planning', companyName: projectName || '' }, { termsVersion: signup.termsVersion, privacyVersion: signup.privacyVersion, termsUrl: signup.termsUrl, privacyUrl: signup.privacyUrl });
        } else member = await authenticateMember(p.username, p.password);
        if (!member || member.role !== 'b2b' || !member.memberId || member.status === 'disabled') throw fault('INVALID_LOGIN', '아이디 또는 비밀번호가 올바르지 않습니다.', 401);
        let c = store.ensure(member);
        if (tail === '/auth/signup') {
          c = store.recordConsent(c.customerId, { termsVersion: signup.termsVersion, privacyVersion: signup.privacyVersion, termsUrl: signup.termsUrl, privacyUrl: signup.privacyUrl, ageConfirmed: true });
          c = store.update(c.customerId, { revision: c.revision, requestKey: crypto.randomUUID(), action: 'onboarding', payload: { businessStatus: p.businessStatus || 'planning', projectName: p.projectName || '' } }, { companies: [], regions: [] });
        }
        if (c.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '이용이 중지된 계정입니다.', 403);
        const token = store.session(c.customerId);
        await sendState(res, c, customerScope(token, c.customerId), { token, csrfToken: csrf(token) }); return true;
      }
      const token = req.headers['x-insight-session'];
      const c = store.authenticate(token);
      if (!await memberActive(c.memberId)) { store.logout(token); throw fault('ACCOUNT_DISABLED', '이용자 계정이 중지되었습니다.', 403); }
      if (req.method === 'POST' && !equal(req.headers['x-csrf-token'], csrf(token))) throw fault('CSRF_INVALID', '화면을 새로 열고 다시 요청해 주세요.', 403);
      await customerRequest(req, res, url, tail, c, token);
    } catch (error) { const safe = Number.isInteger(error.statusCode) && error.statusCode < 500,status=safe?error.statusCode:503;
      json(res,status,{ error: { code: safe ? error.code || 'REQUEST_FAILED' : 'SERVICE_UNAVAILABLE', message: safe ? error.message : '자료 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' } });
      companyRequests.get(req)?.responded(status);
    }
    return true;
  }
  async function admin(req, res, url, session) {
    const base = '/api/admin/insight-customers';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      const tail = url.pathname.slice(base.length).split('/').filter(Boolean);
      if(tail[0]==='recurring-collections') {
        if(!recurringCollection)throw fault('RECURRING_COLLECTION_NOT_READY','정기수집 요청 연결을 준비 중입니다.',503);
        if(url.search)throw fault('INVALID_FIELDS','정기수집 요청 또는 심사 내용만 지정해 주세요.');
        if(req.method==='GET'&&tail.length===1){json(res,200,recurringAdminState());return true;}
        if(req.method!=='POST'||tail.length!==2||tail[1]!=='review')throw fault('METHOD_NOT_ALLOWED','지원하지 않는 요청입니다.',405);
        let origin;try{origin=new URL(req.headers.origin);}catch{}
        if(!origin||origin.host!==req.headers.host)throw fault('ORIGIN_REQUIRED','현재 데이터랩 화면에서 요청해 주세요.',403);
        const payload=await body(req);fields(payload,['companyId','decision','reason','time','requestKey']);
        if(!requireAdmin(session,req,res))return true;
        const actor=session.memberId||session.username;store.throttle(`recurring-review:${actor}`,120);
        const record=await recurringCollection.review(payload,actor);
        if(!requireAdmin(session,req,res))return true;
        json(res,200,{recurringCollection:record,...recurringAdminState()});return true;
      }
      if (req.method === 'GET' && !tail.length) { json(res, 200, { customers: store.list().map(c => ({ customerId: c.customerId, memberId: c.memberId, username: c.username, accountKind: c.accountKind || 'customer', accountStatus: c.accountStatus, businessStatus: c.businessStatus, relations: c.relations.filter(active), entitlements: c.entitlements, revision: c.revision })) }); return true; }
      const verify = customerId => { if (!requireAdmin(session, req, res)) return null; return store.get(customerId); };
      if (req.method === 'GET' && tail.length === 1) { const c = store.get(tail[0]); await sendState(res, c, { current: () => verify(c.customerId) }, { history: store.history(c.customerId) }); return true; }
      if (req.method !== 'POST' || tail.length !== 2) throw fault('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405);
      let origin; try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || origin.host !== req.headers.host) throw fault('ORIGIN_REQUIRED', '현재 데이터랩 화면에서 요청해 주세요.', 403);
      const p = await body(req); const actor = session.memberId || session.username;
      if (tail[1] === 'commands') store.adminUpdate(tail[0], p, actor, await catalog());
      else if (tail[1] === 'preparation-dispatch' && preparationBridge) await preparationBridge.dispatch(tail[0],p,actor);
      else if (tail[1] === 'correction-review') {
        fields(p, ['requestId', 'decision', 'reason']);
        const correction = store.corrections(tail[0]).find(row => row.requestId === p.requestId);
        if (!correction) throw fault('NOT_FOUND', '검수 요청을 찾을 수 없습니다.', 404);
        const company = (await catalog()).companies.find(row => row.companyId === correction.companyId);
        const collection=correction.kind==='product' && collectionResults ? await collectionResults.read(correction.companyId,correction.target.runId) : null;
        store.reviewCorrection(p.requestId, p.decision, p.reason, actor, company, collection);
      } else throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
      await sendState(res, store.get(tail[0]), { current: () => verify(tail[0]) }, {}, { awaitPreparation: true });
    } catch (error) { json(res, error.statusCode || 503, { error: { code: error.code || 'SERVICE_UNAVAILABLE', message: error.statusCode ? error.message : '고객 자료 처리 상태를 확인해 주세요.' } }); }
    return true;
  }
  return { internal, admin };
}
module.exports = { createInsightHttp, body, json, csrf, equal };
