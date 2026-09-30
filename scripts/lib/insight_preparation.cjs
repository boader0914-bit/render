'use strict';
const { fields, fault } = require('./insight_store.cjs');
function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value; }
function createInsightPreparation({ store, catalog, collectorRequests, verifyStored, now = () => Date.now() }) {
  const running = new Map();
  async function dispatch(customerId, payload, actor) {
    fields(payload, ['requestId','checkIn','bookingRangeDays']);
    const today = new Date(now() + 9*3600000).toISOString().slice(0,10);
    if (!date(payload.checkIn) || payload.checkIn < today || !Number.isInteger(payload.bookingRangeDays) || payload.bookingRangeDays < 1 || payload.bookingRangeDays > 31) throw fault('INVALID_COLLECTION_RANGE','숙박 시작일과 1~31일의 조회 기간을 확인해 주세요.');
    const request = store.requests(customerId).find(row => row.requestId === payload.requestId);
    const company = (await catalog()).companies.find(row => row.companyId === request?.companyId);
    if (!request || !company) throw fault('NOT_FOUND','등록된 업체와 준비 요청을 확인해 주세요.',404);
    if (company.placeIds?.length !== 1) throw fault('PLACE_REVIEW_REQUIRED','단일 플레이스 식별자를 먼저 검수해 주세요.',409);
    const scope = { checkIn:payload.checkIn, checkOut:new Date(Date.parse(`${payload.checkIn}T00:00:00Z`)+86400000).toISOString().slice(0,10), bookingRangeDays:payload.bookingRangeDays,
      adults:2, searchMode:'company', collectionMode:'precision', collectionPurpose:'revenue_detail', productMode:'all', dayUseMode:'inspect', detailRankRanges:'1-1', schemaVersion:1 };
    const {job,start} = store.reservePreparation(customerId,payload.requestId,company,scope,actor);
    if (!start) { await refreshJob(job); return; }
    // Durable job ID precedes dispatch. Any ambiguous failure is inspected, never blindly resubmitted.
    running.set(job.jobId,true);
    try {
      await collectorRequests.submit({ ...scope, keyword:company.name, workerKey:'scheduled', clientRequestId:job.jobId, sourceRole:'admin', collectionSource:'admin_search', trigger:'manual', scheduledCollection:false, searchRegion:'', searchScope:'', bookingRangePlaceLimit:0 });
      store.updatePreparationJob(job.jobId,'queued','AWS worker에 자료 준비를 접수했습니다.');
    } catch (error) { store.updatePreparationJob(job.jobId,'needs_review','작업 접수 여부를 확인해야 합니다. 자동으로 다시 실행하지 않습니다.',{errorCode:/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'DISPATCH_UNCONFIRMED'}); }
    finally { running.delete(job.jobId); }
  }
  async function refreshJob(job) {
    if (running.has(job.jobId) || ['ready','partial','blocked','failed'].includes(job.status)) return;
    let receipt;
    try { receipt = await collectorRequests.get(job.jobId); }
    catch { if (job.status === 'dispatching') store.updatePreparationJob(job.jobId,'needs_review','서버 재시작 후 접수 기록을 확인해야 합니다. 자동 재수집하지 않습니다.'); return; }
    if (receipt.status === 'pending') { store.updatePreparationJob(job.jobId,'collecting','자료 수집 또는 결과 검증이 진행 중입니다.'); return; }
    if (['complete','reused'].includes(receipt.status) && receipt.result?.collectionQuality?.status === 'complete' && receipt.result.runId) {
      let verified = false;
      try { verified = await verifyStored(job,receipt.result.runId); } catch { /* Missing storage is a review state, never a successful customer result. */ }
      store.updatePreparationJob(job.jobId,verified?'ready':'needs_review',verified?'요청 업체의 결과 저장과 DB 반영을 확인했습니다.':'수집 결과의 업체 또는 조회 범위가 일치하는지 확인이 필요합니다.',{runId:receipt.result.runId});
    } else {
      const status=['partial','blocked','failed'].includes(receipt.status)?receipt.status:'needs_review';
      const messages={partial:'일부 자료를 확보하지 못했습니다. 관리자 확인이 필요합니다.',blocked:'접근 제한으로 중단되었습니다. 다른 수집기로 자동 재시도하지 않습니다.',failed:'자료 준비를 완료하지 못했습니다. 실패 원인을 확인 중입니다.',needs_review:'실행 기록과 보존 자료를 확인해야 합니다.'};
      store.updatePreparationJob(job.jobId,status,messages[status],{errorCode:receipt.errorCode || null});
    }
  }
  async function refresh(customerId) {
    const ids = new Set(store.requests(customerId).map(row=>row.jobId).filter(Boolean));
    for (const job of store.preparationJobs()) if (ids.has(job.jobId)) await refreshJob(job);
  }
  return { dispatch,refresh };
}
module.exports = { createInsightPreparation };
