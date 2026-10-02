'use strict';
// Explicit customer-facing fields from the same read model used by DataLab's company DB.
const num = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const text = v => typeof v === 'string' ? v.slice(0,500) : '';
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
function channelUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password
    && ['naver.com','naver.me','ddnayo.com','yanolja.com','nol.yanolja.com','nol.com','yeogi.com','goodchoice.kr'].some(h => u.hostname === h || u.hostname.endsWith('.'+h)) ? u.href : null; } catch { return null; }
}
function summary(s) {
  if (!s) return null;
  return { rangeStart:date(s.rangeStart),rangeEnd:date(s.rangeEnd),partial:s.partial === true,revenuePartial:s.revenuePartial === true,
    ...Object.fromEntries(['calendarDays','observedDays','missingDays','rateObservedDays','revenueObservedDays','supply','sold','reservationRate','estimatedRevenue','publicBookings','phoneBookings','publicRevenue','phoneRevenue','sharedDayUseExcluded'].map(k => [k,num(s[k])])) };
}
function daily(d) {
  return {date:date(d.date),collectedAt:stamp(d.collectedAt),missing:d.missing === true,partial:d.partial === true,
    ...Object.fromEntries(['total','sold','reservationRate','estimatedRevenue','publicBookings','phoneBookings','publicRevenue','phoneRevenue','sharedDayUseExcluded'].map(k=>[k,num(d[k])]))};
}
function projectCompanyDetail(company, detail) {
  if (!detail || detail.company?.companyId !== company.companyId) return null;
  const c = detail.company, naver = c.naverChannelObservation || {};
  const channels = [{key:'naver',label:'네이버',status:text(naver.status || 'unknown'),statusLabel:text(naver.statusLabel || '관측 기록 없음'),checkedAt:stamp(naver.observedAt),url:channelUrl(naver.evidenceUrl)
    || (company.placeIds?.length === 1 && /^\d+$/.test(company.placeIds[0]) ? `https://pcmap.place.naver.com/accommodation/${company.placeIds[0]}` : null)}];
  for (const [key,label] of [['tteonayo','떠나요'],['yanolja','NOL'],['yeogi','여기어때']]) {
    const e=c.channelExposures?.[key];
    if (!e || e.status !== 'directly_verified' || e.appliedToSummary !== true) continue;
    channels.push({key,label,status:'directly_verified',statusLabel:'직접 확인',checkedAt:stamp(e.checkedAt || e.observedAt),url:channelUrl(e.url)});
  }
  const history = detail.salesHistory || {};
  const rank = detail.rankTrend || {}, lead=detail.leadTime || {};
  return {companyId:company.companyId,source:'company_db',basics:{name:company.name,address:company.address,rooms:num(company.rooms),roomCountSource:company.roomCountSource,
      facilities:company.facilities,lodgingTypes:(c.lodgingTypes || []).map(text),firstObservedAt:stamp(c.firstSeenAt),lastObservedAt:stamp(c.lastSeenAt),runCount:num(c.runCount)},
    channels,
    current:{summary:summary(history.current?.summary),daily:(history.current?.daily || []).map(daily)},
    history:{months:(history.past?.years || []).flatMap(y=>(y.months || []).map(m=>({month:text(m.key),summary:summary(m.summary),daily:(m.weeks || []).flatMap(w=>(w.daily || []).map(daily))}))),
      ranks:(rank.availableKeywords || []).map(k=>({keyword:text(k.keyword),keywordKey:text(k.keywordKey),scope:text(k.searchScopeLabel),layer:text(k.layer),
        points:(k.points || []).map(p=>({collectedAt:stamp(p.collectedAt),rank:num(p.rank),delta:num(p.delta)}))})),
      performance:(detail.performanceTrend?.points || []).map(p=>({collectedAt:stamp(p.collectedAt),checkIn:date(p.checkIn),observedDays:num(p.observedDays),reservationRate:num(p.reservationRate),estimatedRevenue:num(p.estimatedRevenue),partial:p.partial===true})),
      leadTime:{status:text(lead.status || 'insufficient_observations'),label:text(lead.statusLabel || '동일 숙박일 2회 이상 관측 필요'),averageDays:num(lead.averageDays),medianDays:num(lead.medianDays),pickupCount:num(lead.pickupCount),collectedDateCount:num(lead.collectedDateCount),actualBookingLeadTime:false}}
  };
}
module.exports={projectCompanyDetail};
