(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = value => numeric(value) ? value.toLocaleString('ko-KR', {maximumFractionDigits:1}) : '미확인';
  const quantity = value => numeric(value) ? `${number(value)}실` : '미확인';
  const money = value => numeric(value) ? `${number(value / 10000)}만원` : '미확인';
  const observedDate = value => Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', year:'numeric', month:'long', day:'numeric'}) : '확인 전';
  const ownRelations = state => (state.customer.relations || []).filter(r => r.kind === 'own' && ['active','pending'].includes(r.status));
  const initialCompany = state => (ownRelations(state).find(r => r.status === 'active') || ownRelations(state)[0])?.companyId || '';
  const interests = state => (state.customer.regions || []).filter(r => r.status === 'active');
  const regionMetrics = [
    ['tourism_visitors','averageDailyVisitors','일평균 방문자'],
    ['tourism_stay_spend','stayOverall','체류 지수'],
    ['tourism_stay_spend','spendOverall','소비 지수'],
    ['naver_search_trend','interest','검색 관심도'],
  ];
  function companyCard(company, relation, settings = {}, observedAt) {
    if (!company) return '<section class="card home-company"><span class="status-pill pending">업체 연결 확인 필요</span><h2>등록 업체의 자료를 확인하고 있습니다.</h2><p class="muted">등록 내역은 유지되어 있습니다.</p><a class="button" href="#property">내 매장 등록정보 보기</a></section>';
    const pending = relation?.status !== 'active';
    return `<section class="card home-company"><div class="home-company-heading"><div><span class="status-pill ${pending?'pending':''}">${pending?'매장 연결 확인 대기':'등록 완료'}</span><h2>${esc(settings.nickname || company.name)}</h2><p class="muted">${esc(company.address || '주소 확인 전')}</p>${settings.nickname && settings.nickname !== company.name?`<small class="muted">등록명 ${esc(company.name)}</small>`:''}</div><div class="home-room-total"><span>객실 총량</span><strong>${quantity(company.rooms)}</strong><small>${esc(company.roomCountSource || '저장 자료 기준')}</small></div></div><div class="home-company-footer"><span class="muted">최근 관측 ${esc(observedDate(observedAt || company.observedAt))}</span><div class="connected-actions"><a class="button primary" href="#company=${encodeURIComponent(company.companyId)}">업체 자료 보기</a><a class="button" href="#property">등록정보 관리</a></div></div></section>`;
  }
  function emptyCompany(state) {
    const planning = state.customer.businessStatus === 'planning';
    return `<section class="card home-empty"><span class="eyebrow">${planning?'매장 준비 중':'내 매장 시작하기'}</span><h2>${planning?`${esc(state.customer.projectName || '새로운 매장')}의 입지를 살펴보세요.`:'내 매장을 등록해 주세요.'}</h2><p>${planning?'관심지역과 경쟁업체를 먼저 살펴보고, 매장이 정해지면 연결할 수 있습니다.':'매장을 등록하면 객실 정보와 예약·매출, 지역 흐름을 함께 볼 수 있습니다.'}</p><div class="connected-actions"><a class="button primary" href="#property">내 매장 등록</a>${planning?'<a class="button" href="#regions">관심지역 보기</a>':'<a class="button" href="#settings">매장 준비 중으로 시작</a>'}</div></section>`;
  }
  function operations(report, companyId) {
    const company = (report?.companies || []).find(c => c.companyId === companyId && c.kind === 'own');
    const s = company?.summary;
    if (!s || company.unavailable || !numeric(s.days) || s.days === 0) return `<section class="card home-operations"><h2>예약·매출 요약</h2><p class="muted">${company?.unavailable?'예약·매출 자료를 불러오지 못했습니다.':'저장된 예약·매출 자료가 없습니다.'}</p><a class="text-link" href="#company=${encodeURIComponent(companyId)}">업체 자료 확인 →</a></section>`;
    const sold = numeric(s.sold) ? s.sold : numeric(s.publicBookings) && numeric(s.phoneBookings) ? s.publicBookings + s.phoneBookings : null;
    return `<section class="card home-operations"><div class="home-section-heading"><h2>예약·매출 요약</h2><span class="home-period">숙박일 ${esc(report.period?.start || '확인 전')} ~ ${esc(report.period?.end || '확인 전')}</span></div><div class="home-operating-metrics"><article><span>예약 합계</span><strong>${quantity(sold)}</strong><small>네이버 ${quantity(s.publicBookings)} · 타채널·전화 ${quantity(s.phoneBookings)}</small></article><article><span>추정매출</span><strong>${money(s.estimatedRevenue)}</strong><small>확보한 숙박일의 합계</small></article><article><span>예약률</span><strong>${numeric(s.reservationRate)?`${number(s.reservationRate * 100)}%`:'미확인'}</strong><small>수량 확인 ${number(s.days)} / ${number(report.period?.days || 30)}일</small></article></div></section>`;
  }
  function selectRegion(report, state, companyId) {
    const available = report?.regions || [];
    const own = ownRelations(state).find(r => r.companyId === companyId);
    const company = (state.companies || []).find(c => c.companyId === companyId);
    const local = own?.status === 'active' && available.find(r => r.region?.id === company?.regionKey);
    if (local) return {region:local, label:'매장 소재지'};
    for (const interest of interests(state)) {
      const region = available.find(r => r.region?.id === interest.regionKey);
      if (region) return {region, label:'관심지역'};
    }
    return null;
  }
  function changeText(change) {
    if (!Number.isFinite(change?.value)) return change?.kind === 'zero_baseline' ? '비교 기준값 0' : '비교 자료 없음';
    return `${change.value > 0 ? '+' : ''}${change.value.toLocaleString('ko-KR', {maximumFractionDigits:1})}${change.kind === 'percent' ? '%' : 'p'}`;
  }
  function regionSummary(region, label) {
    const metrics = regionMetrics.map(([source,key,name]) => ({name,metric:(region.sources || []).find(s => s.key === source)?.metrics?.find(m => m.key === key)}));
    const described = metrics.filter(({metric:m}) => numeric(m?.latest?.value) && /^\d{4}-\d{2}$/.test(m.latest.month) && Number.isFinite(m.mom?.value)).slice(0,2).map(({name,metric:m}) => `${m.latest.month} ${name}는 전월 대비 ${changeText(m.mom)}입니다.`);
    return `<section class="card home-region"><div class="home-section-heading"><div><span class="eyebrow">${esc(label)}</span><h2>최근 지역 분석 · ${esc(region.region?.label || '지역 확인 전')}</h2></div><a class="text-link" href="#regions=${encodeURIComponent(region.region?.id || '')}">지역 분석 보기 →</a></div><div class="home-regional-metrics">${metrics.map(({name,metric:m}) => {const valid = numeric(m?.latest?.value) && /^\d{4}-\d{2}$/.test(m.latest.month); return `<article><span>${name}</span><strong>${valid?number(m.latest.value):'미확인'}${valid?` <small>${esc(m.unit)}</small>`:''}</strong><p class="home-metric-period">${valid?`기준 ${esc(m.latest.month)}`:'저장 자료 없음'}</p><small>전월 ${valid?esc(changeText(m.mom)):'비교 자료 없음'}</small></article>`;}).join('')}</div>${described.length?`<p class="home-region-brief">${esc(described.join(' '))}</p>`:''}<p class="muted home-region-basis">각 지표의 마지막 확보월 기준입니다.</p></section>`;
  }
  function missingRegion(state, companyId) {
    const relation = ownRelations(state).find(r => r.companyId === companyId);
    const registered = interests(state).length > 0 || relation?.status === 'active';
    return `<section class="card home-region"><h2>최근 지역 분석</h2><p class="muted">${registered?'연결된 지역의 저장 자료를 아직 확인하지 못했습니다.':relation?.status === 'pending'?'매장 연결 확인 후 소재지 분석이 표시됩니다. 관심지역을 먼저 등록할 수도 있습니다.':'관심지역을 등록하면 최근 지역 흐름을 볼 수 있습니다.'}</p><a class="button" href="#regions">${registered?'지역 분석 보기':'관심지역 등록'}</a></section>`;
  }
  function identity(state, id, observedAt, latest) {
    const relation = ownRelations(state).find(r => r.companyId === id);
    let company = (state.companies || []).find(c => c.companyId === id);
    if (company && latest && !latest.unavailable && Object.hasOwn(latest, 'rooms') && (latest.rooms === null || numeric(latest.rooms)) && company.rooms !== latest.rooms) {
      company = {...company, rooms:latest.rooms, roomCountSource:'최신 업체DB 기준'};
    }
    return relation ? companyCard(company, relation, state.customer.settings?.[id], observedAt) : emptyCompany(state);
  }
  function panel(state) {
    const own = ownRelations(state), id = initialCompany(state), hasData = own.length || interests(state).length;
    return `<div class="home-dashboard"><div class="home-toolbar">${own.length > 1?`<label class="field"><span>내 매장 선택</span><select data-home-company>${own.map(r => {const c=(state.companies || []).find(c => c.companyId === r.companyId);return `<option value="${esc(r.companyId)}" ${r.companyId===id?'selected':''}>${esc(state.customer.settings?.[r.companyId]?.nickname || c?.name || '업체 연결 확인 필요')}</option>`;}).join('')}</select></label>`:'<span class="home-toolbar-label">내 매장과 지역의 최근 흐름</span>'}${hasData?'<button class="button small" type="button" data-home-refresh>저장 자료 다시 확인</button>':''}</div><div id="home-company">${identity(state,id)}</div><div id="home-operations" aria-live="polite">${own.length?'<p class="home-loading" role="status">저장된 예약·매출을 확인하고 있습니다.</p>':''}</div><div id="home-region" aria-live="polite">${hasData?'<p class="home-loading" role="status">최근 지역 자료를 확인하고 있습니다.</p>':missingRegion(state,id)}</div><div class="home-shortcuts"><a class="card" href="#reports"><span>기간별로 정리하기</span><strong>리포트 보기 <b aria-hidden="true">↗</b></strong><small>내 매장·경쟁업체·지역을 함께 확인합니다.</small></a><a class="card" href="#competitors"><span>주변 업체와 비교하기</span><strong>경쟁 분석 <b aria-hidden="true">↗</b></strong><small>등록한 경쟁업체의 예약 흐름을 살펴봅니다.</small></a></div></div>`;
  }

  let sequence = 0, state = null, request = null, selectedId = '';
  const cache = new Map();
  const $ = selector => document.querySelector(selector);
  async function read(url, force) {
    const old = cache.get(url);
    if (!force && old && Date.now() - old.at < 60000) return old.promise;
    const promise = request(url);
    cache.set(url, {promise, at:Date.now()});
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    try { return await promise; } catch (e) { if (cache.get(url)?.promise === promise) cache.delete(url); throw e; }
  }
  async function load(force = false) {
    const serial = ++sequence, currentState = state, companyId = selectedId;
    const companySlot = $('#home-company'), operationsSlot = $('#home-operations'), regionSlot = $('#home-region'), button = $('[data-home-refresh]');
    if (!currentState || !companySlot || !regionSlot) return;
    companySlot.innerHTML = identity(currentState, companyId);
    if (!ownRelations(currentState).length && !interests(currentState).length) return;
    if (button) button.disabled = true;
    operationsSlot.innerHTML = companyId ? '<p class="home-loading" role="status">저장된 예약·매출을 확인하고 있습니다.</p>' : '';
    regionSlot.innerHTML = '<p class="home-loading" role="status">최근 지역 자료를 확인하고 있습니다.</p>';
    try {
      const report = await read(`/reports/briefing${companyId?'?ownId='+encodeURIComponent(companyId):''}`, force);
      if (serial !== sequence || !companySlot.isConnected) return;
      const company = (report.companies || []).find(c => c.companyId === companyId && c.kind === 'own');
      companySlot.innerHTML = identity(currentState, companyId, company?.lastObservedAt || company?.lastObservedDay, company);
      operationsSlot.innerHTML = companyId ? operations(report, companyId) : '';
      const selected = selectRegion(report, currentState, companyId);
      regionSlot.innerHTML = selected ? regionSummary(selected.region, selected.label) : missingRegion(currentState, companyId);
    } catch (e) {
      if (serial !== sequence || !companySlot.isConnected) return;
      const note = '<p class="collection-warning" role="alert">저장 자료를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>';
      operationsSlot.innerHTML = companyId ? note : '';
      regionSlot.innerHTML = companyId ? missingRegion(currentState, companyId) : note + missingRegion(currentState, companyId);
    } finally { if (serial === sequence && button?.isConnected) button.disabled = false; }
  }
  const api = {panel, companyCard, operations, selectRegion, regionSummary,
    mount(fetchSaved, initialState) { state = initialState; request = fetchSaved; selectedId = initialCompany(state); return load(); },
    stop() { sequence++; state = null; request = null; },
    clearCache() { cache.clear(); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    document.addEventListener('change', e => { if (state && e.target.matches?.('[data-home-company]') && ownRelations(state).some(r => r.companyId === e.target.value)) { selectedId = e.target.value; void load(); } });
    document.addEventListener('click', e => { if (state && e.target.closest?.('[data-home-refresh]')) void load(true); });
    window.InsightHome = api;
  }
})();
