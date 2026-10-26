'use strict';
// Customer projection: one identified company, one stored run. Never expose raw files or other companies.
const { hash, fault } = require('./insight_store.cjs');
const { projectCompanyDetail } = require('./insight_company_detail.cjs');
const { createScheduledSingleFlight } = require('./scheduled_single_flight.cjs');
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const text = (value, limit = 180) => String(value || '').slice(0, limit);
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
const failed = row => row.collectionFailed === true || row.missing === true || Boolean(row.collectionErrorCode) || Number(row.responseStatus) >= 400;
function productRows(rows = [], fallbackDate, mode) {
  const products = new Map();
  for (const { observation: o, source: raw } of rows) {
    if (!o) continue;
    const key = text(o.key), type = ['lodging','dayuse'].includes(o.productType) ? o.productType : 'unknown';
    const identity = `${type}:${key}`;
    if (!products.has(identity)) products.set(identity, { key: identity, bizItemId: text(o.bizItemId), name: text(o.name), productType: type, days: [] });
    const notRequested = type === 'dayuse' && mode !== 'detail';
    const status = failed(raw) ? 'error' : notRequested ? 'not_requested' : raw.scheduleObserved === false || [o.total,o.available,o.bookingCount].every(v=>number(v)===null) ? 'missing' : 'observed';
    const valid = status === 'observed';
    const entry = { date: day(raw.date || raw.stayDate || fallbackDate), status,
      errorCode: status === 'error' ? text(raw.collectionErrorCode || (Number(raw.responseStatus) >= 400 ? `HTTP_${raw.responseStatus}` : 'MISSING_RESPONSE'), 80) : null,
      total: valid ? number(o.total) : null, available: valid ? number(o.available) : null,
      publicBookings: valid ? number(o.bookingCount) : null,
      price: valid ? number(o.price) : null,
      saleStatus: raw.open === false || raw.isSaleDay === false || raw.isBusinessDay === false ? 'closure_unconfirmed' : 'unknown' };
    const product = products.get(identity), previous = product.days.findIndex(row => row.date === entry.date);
    // Prefer the dated schedule over a generic item-detail row; failures remain visible.
    if (previous < 0) product.days.push(entry);
    else if (raw.date || raw.stayDate) product.days[previous] = entry;
  }
  return [...products.values()].map(p => ({ ...p, days: p.days.sort((a,b) => String(a.date).localeCompare(String(b.date))) }));
}
function projectCollection(company, evidence) {
  if (!evidence) return null;
  const { run, snapshot = {}, originalSnapshot = {}, rows = [], originalRows = [], issues = [] } = evidence;
  const products = productRows(rows, run.checkIn, run.dayUseMode);
  const original = productRows(originalRows, run.checkIn, run.dayUseMode);
  const days = (snapshot.daily || []).map(row => {
    const missing = row.missing === true || (row.productType==='dayuse' && run.dayUseMode!=='detail'), partial = row.partial === true || row.inventoryConflict === true;
    return { date: day(row.date), productType: text(row.productType), status: missing ? 'missing' : partial ? 'partial' : 'observed',
      total: number(row.total), available: missing ? null : number(row.available),
      publicBookings: missing ? null : number(row.publicBookings), estimatedBlocked: missing ? null : number(row.phoneBookings),
      publicRevenue: missing ? null : number(row.publicRevenue), estimatedRevenue: missing ? null : number(row.phoneRevenue),
      sharedDayUseExcluded: missing ? null : number(row.sharedDayUseExcluded), sharingStatus: text(row.sharedRoomsStatus || row.dayUseSharingStatus || 'unknown') };
  });
  const result = { companyId: company.companyId, runId: text(run.id), collectedAt: run.collectedAt || null,
    range: { start: run.checkIn || null, days: number(run.bookingRangeDays), end: snapshot.dateRange?.end || null },
    dayUse: {presence:['present','absent'].includes(evidence.dayUsePresence)?evidence.dayUsePresence:products.some(p=>p.productType==='dayuse')?'present':'unknown',sharing:text(evidence.dayUseSharingStatus || 'unknown')},
    dayUseMode: run.dayUseMode || 'unknown', quality: { status: text(run.collectionQuality?.status || 'unknown'), reason: text(evidence.reasonLabel || '자료 품질 확인 필요') },
    rooms: number(company.rooms), roomCountSource: text(company.roomCountSource),
    capacityWarning: snapshot.capacityReview?.required ? text(snapshot.capacityReview.message,1500) : null,
    originalRooms: number(originalSnapshot.capacityBasis?.currentObservedMaximum),
    productCount: products.length, products: products.map(p => ({ ...p, original: original.find(o => o.key === p.key)?.days || [] })), days,
    issues: issues.map(row => ({ code: text(row.code,80), label: text(row.label), productName: text(row.productName), dates: (row.dates || []).filter(day) })),
    truncated: snapshot.summary?.productTruncated === true,
    actualRevenueAvailable: false };
  return { ...result, version: hash(JSON.stringify([company.version, result])) };
}
function createCollectionResults({ catalog, readEvidence, readCompanyDetail, readIntegrated, readIntegratedMonths, runWork = operation => operation() }) {
  if (typeof runWork !== 'function') throw TypeError('Collection reads require analytical ownership');
  // A pending group carries no load promise until its caller owns the lease.
  // A nested owner must never await an outer request queued behind that owner.
  const detailFlight = createScheduledSingleFlight({runWork,kind:'insight-company-view-detail'});
  const resultFlight = createScheduledSingleFlight({runWork,kind:'insight-company-view-result'});
  const viewFlight = createScheduledSingleFlight({runWork,kind:'insight-company-view'});
  const readingSources = new Map();
  const readingMonthLists = new Map();
  async function sourceDetail(companyId) {
    if (readingSources.has(companyId)) return readingSources.get(companyId);
    const pending = Promise.resolve().then(() => readCompanyDetail(companyId));
    readingSources.set(companyId,pending);
    try { return await pending; } finally { if(readingSources.get(companyId)===pending)readingSources.delete(companyId); }
  }
  async function readOwned(companyId, runId) {
    const company = (await catalog()).companies.find(row => row.companyId === companyId);
    if (!company) return null;
    return projectCollection(company, await readEvidence(companyId, { runId }));
  }
  function read(companyId, runId = null) {
    return resultFlight.run(JSON.stringify([companyId,runId]),()=>readOwned(companyId,runId));
  }
  async function reusable(companyId, scope, observationDay) {
    const evidence = await readEvidence(companyId, { scope, observationDay });
    return evidence?.run?.id || null;
  }
  function companyDetail(companyId, { month } = {}) {
    if (!readCompanyDetail) return Promise.resolve(null);
    return detailFlight.run(JSON.stringify([companyId,month||'']),async()=>{
      const company=(await catalog()).companies.find(c=>c.companyId===companyId);
      if (!company) return null;
      let integrated;
      if (readIntegrated) {
        try { integrated = await readIntegrated(companyId, { month, knownMonthsOnly:true }); }
        catch (error) {
          if (['MONTH_NOT_OBSERVED','month_not_observed'].includes(error.code)) throw fault('MONTH_NOT_OBSERVED','수집 이력이 있는 숙박월 또는 이번 달을 선택해 주세요.',400);
          throw error;
        }
      }
      const detail = await sourceDetail(companyId);
      if (!readIntegrated) integrated=detail?.integrated;
      return projectCompanyDetail(company, detail, { integrated, month, integrationConnected: Boolean(readIntegrated) });
    });
  }
  function readView(companyId, { month } = {}) {
    return viewFlight.run(JSON.stringify([companyId,month||'']),async()=>{
      const detail=await companyDetail(companyId,{month});
      const result=await read(companyId);
      return {companyDetail:detail,result};
    });
  }
  function companyMonths(companyId) {
    if(!readIntegratedMonths)return Promise.resolve(null); // Legacy readers enumerate from their projected detail.
    if(readingMonthLists.has(companyId))return readingMonthLists.get(companyId);
    // Index-only discovery must not wait for the heavyweight analytical lease.
    const pending=Promise.resolve().then(async()=>{
      if(!(await catalog()).companies.some(row=>row.companyId===companyId))return [];
      const value=await readIntegratedMonths(companyId);
      if(!Array.isArray(value)||value.length>122||value.some(row=>!/^20\d{2}-(0[1-9]|1[0-2])$/.test(row?.month||'')))throw fault('COMPANY_MONTHS_UNAVAILABLE','업체의 저장된 숙박월 목록을 확인하지 못했습니다.',503);
      return [...new Map(value.map(row=>[row.month,{month:row.month,status:text(row.status,40)}])).values()].sort((a,b)=>a.month.localeCompare(b.month));
    });
    readingMonthLists.set(companyId,pending);
    void pending.finally(()=>{if(readingMonthLists.get(companyId)===pending)readingMonthLists.delete(companyId);}).catch(()=>{});
    return pending;
  }
  return { read, reusable, companyDetail, companyMonths, readView };
}
module.exports = { createCollectionResults, projectCollection, productRows };
