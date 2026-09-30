(() => {
  'use strict';
  const $ = (query, scope = document) => scope.querySelector(query);
  const $$ = (query, scope = document) => [...scope.querySelectorAll(query)];
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value) => finite(value) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value) : '미확보';
  const percent = (value) => finite(value) ? `${number(value)}%` : '미확보';
  const money = (value) => finite(value) ? `${number(Math.round(value / 10000))}<small>만원</small>` : '<span class="metric-placeholder">미확보</span>';
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1z"/>',
    property: '<path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M9 9h.01M15 9h.01M9 12h.01M15 12h.01"/>',
    competitors: '<path d="M4 20V9h4v11M10 20V4h4v16M16 20v-7h4v7M2 20h20"/>',
    regions: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16"/>',
    reports: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
    settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
    moon: '<path d="M20.5 13.8A9 9 0 0 1 10.2 3.5 9 9 0 1 0 20.5 13.8z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    leaf: '<path d="M5 19C-1 9 8 3 21 3c0 12-4 20-14 15M5 21 17 8"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M15 8H9v4h6v4H9M12 6v2M12 16v2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    print: '<path d="M6 9V3h12v6M6 18H3V9h18v9h-3M6 14h12v7H6zM17 11h1"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  const navigation = [['home', '홈'], ['property', '내 매장'], ['competitors', '경쟁 분석'], ['regions', '지역 분석'], ['reports', '리포트'], ['settings', '설정']];
  let state = null;
  let profile = 'owner';
  let route = 'home';
  let reportFilter = 'all';
  let selectedRegion = null;
  let modal = null;
  let focusBeforeModal = null;
  let busy = false;
  let toastTimer;
  let loadCounter = 0;

  const companyById = (id) => state?.companies.find((company) => company.id === id);
  const owned = () => state?.customer.businessStage === 'owned' ? companyById(state.customer.ownedCompanyId) : null;
  const competitors = () => (state?.competitorIds || []).map(companyById).filter(Boolean);
  const regionByCode = (code) => state?.regions.find((region) => region.code === code);
  const regions = () => [...new Set([owned()?.regionCode, ...(state?.interestRegionCodes || [])].filter(Boolean))].map(regionByCode).filter(Boolean);
  const bookingRate = (metrics) => metrics && finite(metrics.publicBookings) && finite(metrics.inferredBookings) && finite(metrics.supply) && metrics.supply > 0 ? Math.round((metrics.publicBookings + metrics.inferredBookings) / metrics.supply * 1000) / 10 : null;
  const publicRate = (metrics) => metrics && finite(metrics.publicBookings) && finite(metrics.supply) && metrics.supply > 0 ? Math.max(0, Math.min(100, metrics.publicBookings / metrics.supply * 100)) : 0;
  const inferredRate = (metrics) => metrics && finite(metrics.inferredBookings) && finite(metrics.supply) && metrics.supply > 0 ? Math.max(0, Math.min(100 - publicRate(metrics), metrics.inferredBookings / metrics.supply * 100)) : 0;
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
  }
  function getTheme() {
    try { return localStorage.getItem('sabun-insight-preview-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    $('#theme-toggle').setAttribute('aria-label', `${theme === 'dark' ? '라이트' : '다크'} 모드로 전환`);
    try { localStorage.setItem('sabun-insight-preview-theme', theme); } catch { /* The page remains usable without browser storage. */ }
  }
  function setMenu(open) {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    $('#sidebar').classList.toggle('open', open);
    $('#sidebar').inert = mobile && !open;
    if (mobile && !open) $('#sidebar').setAttribute('aria-hidden', 'true');
    else $('#sidebar').removeAttribute('aria-hidden');
    $('.nav-backdrop').hidden = !open || !mobile;
    $('.mobile-menu').setAttribute('aria-expanded', String(open));
    $('.mobile-menu').setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  }
  async function load(nextProfile = profile) {
    const serial = ++loadCounter;
    try {
      const response = await fetch(`/api/preview/state?profile=${encodeURIComponent(nextProfile)}`, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || data.mode !== 'preview') throw new Error(data.error?.message || '예시 자료를 불러오지 못했습니다.');
      if (serial !== loadCounter) return false;
      profile = nextProfile;
      state = data;
      selectedRegion = null;
      $('#preview-profile').value = profile;
      render();
      return true;
    } catch (error) {
      if (serial !== loadCounter) return false;
      $('#main').innerHTML = `<div class="error-layout"><span class="eyebrow">PREVIEW WORKSPACE</span><h1>검수 자료를 불러오지 못했습니다.</h1><p>${escape(error.message)}</p><button class="button primary" data-action="reload">다시 불러오기 ${icon('arrow')}</button></div>`;
      return false;
    }
  }
  async function save(action, payload) {
    if (busy) return null;
    busy = true;
    const saveButtons = $$('[data-save]');
    saveButtons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/preview/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ profile, revision: state.revision, action, payload }) });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error?.message || '설정을 저장하지 못했습니다.');
        error.code = data.error?.code;
        error.details = data.error?.details;
        throw error;
      }
      state = data;
      render();
      return data;
    } catch (error) {
      if (error.code === 'stale_revision') {
        await load();
        closeModal();
        toast('다른 화면에서 설정이 변경되어 최신 자료를 불러왔습니다. 변경할 항목을 다시 선택해 주세요.');
      } else {
        showFormError(error.message);
      }
      return null;
    } finally {
      busy = false;
      saveButtons.forEach((button) => { if (button.isConnected) button.disabled = false; });
    }
  }
  function showFormError(message) {
    const element = $('#modal-error');
    if (element) { element.textContent = message; element.focus(); } else toast(message);
  }
  const periodChip = () => `<span class="period-chip">${icon('calendar')}2026. 09. 01 — 09. 30 <span class="tag neutral">예시</span></span>`;
  function heading(eyebrow, title, description, actions = periodChip()) {
    return `<section class="page-heading"><div><span class="eyebrow">${escape(eyebrow)}</span><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="heading-actions">${actions}</div></section>`;
  }
  function stat(label, value, unit, note, name = 'competitors', tone = '') {
    return `<article class="stat-card ${tone}"><div class="stat-label"><span>${escape(label)}</span>${icon(name)}</div><div class="stat-value">${value}${unit ? `<small>${escape(unit)}</small>` : ''}</div><div class="stat-note">${tone ? `<span class="dot ${tone === 'purple' ? 'purple' : ''}"></span>` : ''}${escape(note)}</div></article>`;
  }
  function metricCards(metrics) {
    return `<div class="stat-grid">${stat('공개 예약', number(metrics?.publicBookings), finite(metrics?.publicBookings) ? '실·박' : '', '정상 응답에서 확인한 예약', 'calendar', 'green')}${stat('방막기 추정', number(metrics?.inferredBookings), finite(metrics?.inferredBookings) ? '실·박' : '', '별도 구분한 추정 예약', 'clock', 'purple')}${stat('예약률 · 추정 포함', percent(bookingRate(metrics)), '', '기간 내 공급 객실·박 기준', 'competitors')}${stat('추정 매출', money(metrics?.estimatedRevenue), '', '공개 예약과 방막기 추정 포함', 'coin')}</div>`;
  }
  function chart() {
    return `<svg class="chart" viewBox="0 0 600 222" role="img" aria-label="9월 공개 예약과 방막기 추정 흐름의 화면 구성용 예시 차트. 실제 관측 추이가 아닙니다."><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#83a18a" stop-opacity=".24"/><stop offset="100%" stop-color="#83a18a" stop-opacity=".015"/></linearGradient></defs><path class="chart-grid" d="M34 25H585M34 73H585M34 121H585M34 169H585"/><text x="5" y="29">20</text><text x="5" y="77">15</text><text x="5" y="125">10</text><text x="12" y="173">5</text><path d="M35 149L55 157L75 134L95 145L115 130L135 79L155 55L175 133L195 145L215 126L235 141L255 113L275 61L295 37L315 127L335 141L355 116L375 128L395 98L415 45L435 25L455 101L475 111L495 92L515 112L535 74L555 33L575 45V188H35Z" fill="url(#chart-fill)"/><path class="chart-public" d="M35 149L55 157L75 134L95 145L115 130L135 79L155 55L175 133L195 145L215 126L235 141L255 113L275 61L295 37L315 127L335 141L355 116L375 128L395 98L415 45L435 25L455 101L475 111L495 92L515 112L535 74L555 33L575 45"/><path class="chart-inferred" d="M35 175L55 179L75 174L95 176L115 171L135 152L155 146L175 170L195 179L215 171L235 177L255 166L275 148L295 139L315 170L335 176L355 169L375 175L395 161L415 141L435 134L455 163L475 172L495 160L515 169L535 154L555 133L575 142"/><text x="34" y="213">9/1</text><text x="155" y="213">9/7</text><text x="292" y="213">9/14</text><text x="429" y="213">9/21</text><text x="561" y="213">9/28</text></svg>`;
  }
  const legend = () => '<div class="legend"><span><i class="dot"></i>공개 예약</span><span><i class="dot purple"></i>방막기 추정</span></div>';
  function trendCard(company = owned()) {
    const count = company?.metrics && finite(company.metrics.publicBookings) && finite(company.metrics.inferredBookings) ? company.metrics.publicBookings + company.metrics.inferredBookings : null;
    return `<section class="card"><div class="card-header"><div><h2 class="card-title">숙박일별 예약 흐름</h2><p class="card-subtitle">공개 예약과 방막기 추정을 나누어 살펴봅니다.</p></div><span class="tag neutral">화면 예시</span></div><div class="chart-topline"><div class="chart-total">${company ? `<strong>${number(count)}</strong> ${finite(count) ? '실·박 · 추정 포함' : ''}` : '<strong>9월</strong> 지역 흐름 살펴보기'}</div>${legend()}</div>${chart()}<div class="chart-note">${icon('info')}차트는 화면 구성용 예시이며, 위 합계에서 계산한 실제 일별 관측값이 아닙니다.</div></section>`;
  }
  function mapIllustration() {
    return '<svg viewBox="0 0 110 95" aria-hidden="true"><path d="m21 10 20 2 10-6 16 9 18-3 10 15-7 14 6 18-17 11-6 17-24-3-11-11-19-5 4-20L9 32z"/><path d="m41 12-2 18 15 11 19-4 14 4M20 48l18 1 11 14-2 21M54 41l-5 22 22 7" fill="none" opacity=".45"/><circle class="map-dot" cx="51" cy="48" r="5"/></svg>';
  }
  function regionCard(region = regions()[0]) {
    return `<section class="card region-card"><div class="card-header"><div><h2 class="card-title">${region ? escape(region.name) : '관심지역'}의 흐름</h2><p class="card-subtitle">${owned() && region?.code === owned().regionCode ? '내 매장 소재 지역 · 기본 제공' : '선택한 관심지역 · 예시 지표'}</p></div><a class="text-link" href="#regions">지역 분석 ↗</a></div>${region ? `<div class="region-top"><span class="region-name">${escape(region.name.split(' ').at(-1))}</span><div class="mini-region-map">${mapIllustration()}</div></div><div class="region-measures"><div class="region-measure"><span>관광 방문 지표</span><strong>${number(finite(region.metrics.visitors) ? region.metrics.visitors / 10000 : null)}<small>${finite(region.metrics.visitors) ? '만 명' : ''}</small></strong></div><div class="region-measure"><span>검색 관심 지수</span><strong>${number(region.metrics.searchIndex)}<small>${finite(region.metrics.searchIndex) ? '/ 100' : ''}</small></strong></div><div class="region-measure"><span>지역 인구</span><strong>${number(finite(region.metrics.population) ? region.metrics.population / 10000 : null)}<small>${finite(region.metrics.population) ? '만 명' : ''}</small></strong></div></div><div class="chart-note">방문·검색: 2026년 9월 예시 / 인구: 2025년 예시</div>` : empty('아직 선택한 지역이 없습니다.', '관심지역을 선택하면 지역 분석 화면을 체험할 수 있습니다.', 'targets-regions', '관심지역 선택') }</section>`;
  }
  function companyTable(items, compact = false) {
    if (!items.length) return empty('비교업체를 선택해 주세요.', `현재 경쟁업체를 ${state.limits.competitorLimit}곳까지 선택할 수 있습니다.`, 'targets-competitors', '경쟁업체 선택');
    return `<div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">업체</th><th scope="col">객실 수</th><th scope="col">예약률 · 추정 포함</th>${compact ? '' : '<th scope="col">공개 / 추정 예약</th>'}<th scope="col">추정 매출</th></tr></thead><tbody>${items.map((company) => `<tr><td class="company-cell"><strong>${escape(company.name)}${company.id === owned()?.id ? ' <span class="tag">내 매장</span>' : ''}</strong><small>${escape(regionByCode(company.regionCode)?.name || company.address)}</small></td><td>${number(company.rooms)}${finite(company.rooms) ? '실' : ''}</td><td>${percent(bookingRate(company.metrics))}<span class="booking-bar"><i style="width:${publicRate(company.metrics)}%"></i><i class="purple" style="width:${inferredRate(company.metrics)}%"></i></span></td>${compact ? '' : `<td>${number(company.metrics.publicBookings)} / <span style="color:var(--purple)">${number(company.metrics.inferredBookings)}</span> 실·박</td>`}<td>${finite(company.metrics.estimatedRevenue) ? `${number(Math.round(company.metrics.estimatedRevenue / 10000))}만 원` : '미확보'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function reportPreviews() {
    return state.reports.slice(0, 2).map((report) => `<article class="report-preview"><div class="report-cover ${report.type === 'weekly' ? 'weekly' : ''}" aria-hidden="true"><small>SABUN</small><strong>${report.type === 'monthly' ? 'M' : 'W'}</strong><span>INSIGHT REPORT</span></div><div><span class="tag neutral">${report.type === 'monthly' ? '월간 리포트' : '주간 리포트'}</span><h3>${escape(report.title)}</h3><p>${escape(report.period)} · 예시 발행본</p><button class="text-link" data-action="report" data-id="${escape(report.id)}">리포트 열기 <span aria-hidden="true">↗</span></button></div></article>`).join('');
  }
  function empty(title, description, action, label) {
    return `<div class="empty-state">${icon('leaf')}<h3>${escape(title)}</h3><p>${escape(description)}</p>${action ? `<button class="button" data-action="${escape(action)}">${escape(label)} ${icon('arrow')}</button>` : ''}</div>`;
  }
  function homePage() {
    const own = owned();
    const isPlanning = state.customer.businessStage === 'planning';
    return heading('A PERSPECTIVE FOR YOUR STAY', isPlanning ? '머무름을 준비하는 시간' : '내 매장의 흐름을 읽다', isPlanning ? '관심지역과 비교업체를 살펴보며 나만의 운영 방향을 준비하세요.' : '예약의 변화와 지역의 움직임을 한곳에서 살펴보세요.') +
      `<section class="welcome-banner"><div><h2>${isPlanning ? '좋은 시작은,<br>지역을 이해하는 것부터.' : `${escape(own?.name || '내 매장')},<br>다음 운영의 방향을 찾아보세요.`}</h2><p>${isPlanning ? '준비가 끝나면 실제 매장을 연결하세요. 쌓인 리포트는 그대로 이어집니다.' : '공개된 예약과 추정값을 구분하고, 같은 기간의 경쟁업체와 비교합니다.'}</p></div><svg class="welcome-symbol" viewBox="0 0 240 210" aria-hidden="true"><ellipse cx="120" cy="83" rx="83" ry="65"/><ellipse cx="120" cy="108" rx="83" ry="65"/><ellipse cx="120" cy="133" rx="83" ry="65"/></svg><div class="welcome-side"><span>${isPlanning ? '함께 살펴보는 지역' : '내 매장 객실 기준'}</span><strong>${isPlanning ? regions().length : number(own?.rooms)}<small style="font:12px var(--font);margin-left:7px">${isPlanning ? '곳' : '실'}</small></strong><span>${isPlanning ? '관심지역 설정 기준' : '검수용 예시 객실 수'}</span></div></section>` +
      (isPlanning ? `<div class="stat-grid">${stat('관심지역', number(state.interestRegionCodes.length), '곳', `설정 가능 ${state.limits.interestRegionLimit}곳`, 'regions')}${stat('비교업체', number(state.competitorIds.length), '곳', `설정 가능 ${state.limits.competitorLimit}곳`, 'competitors')}${stat('받은 리포트', number(state.reports.length), '건', '주간·월간 예시 발행본', 'reports')}${stat('내 매장 지표', '<span class="metric-placeholder">매장 준비 중</span>', '', '매장 연결 후 제공됩니다.', 'property')}</div>` : metricCards(own?.metrics)) +
      `<div class="main-grid">${trendCard(own)}${regionCard()}</div><div class="lower-grid"><section class="card"><div class="card-header"><div><h2 class="card-title">함께 살펴보는 경쟁업체</h2><p class="card-subtitle">${state.competitorIds.length} / ${state.limits.competitorLimit}곳 · 9월 숙박일 기준 예시</p></div><a class="text-link" href="#competitors">전체 보기 ↗</a></div>${companyTable(competitors(), true)}</section><section class="card"><div class="card-header"><div><h2 class="card-title">새로 도착한 리포트</h2><p class="card-subtitle">기간별 흐름을 차분하게 정리합니다.</p></div><a class="text-link" href="#reports">보관함 ↗</a></div>${reportPreviews()}</section></div><div class="info-strip">${icon('info')}모든 업체와 수치는 가상의 예시입니다. 실제 매출 확정값이 아니며, 고객 인증·운영 DB·리포트 배정은 다음 단계에서 연결합니다.</div>`;
  }
  function propertyPage() {
    const own = owned();
    if (!own) return heading('YOUR NEXT CHAPTER', '나의 매장 준비', '실제 매장을 연결하기 전에도 지역과 경쟁업체의 흐름을 살펴볼 수 있습니다.', '<button class="button primary" data-action="onboard">내 매장 등록 '+icon('arrow')+'</button>') + `<section class="card property-hero"><div><span class="tag">매장 준비 중</span><h2>${escape(state.customer.projectName || '나의 스테이 준비')}</h2><p>지역을 찾고, 운영의 방향을 구체화하는 단계입니다.</p><div class="property-meta"><span>관심지역<strong>${state.interestRegionCodes.length}곳</strong></span><span>비교업체<strong>${state.competitorIds.length}곳</strong></span><span>내 매장 실적<strong>아직 연결 전</strong></span></div></div><div class="property-icon">${icon('leaf')}</div></section><div class="section-grid two"><section class="card"><div class="card-header"><h2 class="card-title">한 단계씩 준비해 보세요</h2></div><div class="project-milestones"><div class="milestone active"><small>01 · EXPLORE</small>관심지역 살펴보기</div><div class="milestone ${competitors().length ? 'active' : ''}"><small>02 · COMPARE</small>비교업체 관찰하기</div><div class="milestone"><small>03 · CONNECT</small>내 매장 연결하기</div></div><div class="info-strip">${icon('info')}준비 중에서 매장 등록으로 바꾸어도 같은 예시 고객의 경쟁업체·관심지역·기존 리포트가 이어집니다.</div></section>${regionCard()}</div>`;
    return heading('YOUR PROPERTY', '내 매장', '객실 기준과 예약의 성격을 함께 확인합니다.', '<button class="button" data-action="onboard">매장 설정 변경 '+icon('settings')+'</button>') + `<section class="card property-hero"><div><div class="inline-tags"><span class="tag">예시 매장 연결</span><span class="tag neutral">${escape(own.category)}</span></div><h2>${escape(own.name)}</h2><p>${escape(own.address)}</p><div class="property-meta"><span>객실 기준<strong>${number(own.rooms)}실</strong></span><span>자료 충족률<strong>${percent(finite(own.metrics.coverage) ? own.metrics.coverage * 100 : null)}</strong></span><span>숙박일<strong>2026년 9월 예시</strong></span></div>${editSummary(own)}</div><div class="property-icon">${icon('property')}</div></section>${metricCards(own.metrics)}<div class="main-grid">${trendCard()}<section class="card"><div class="card-header"><div><h2 class="card-title">예약을 읽는 기준</h2><p class="card-subtitle">성격이 다른 수치는 나누어 표시합니다.</p></div></div><ul class="plain-list"><li><span><i class="dot"></i> 공개 예약</span><strong>${number(own.metrics.publicBookings)} 실·박</strong></li><li><span><i class="dot purple"></i> 방막기 추정</span><strong style="color:var(--purple)">${number(own.metrics.inferredBookings)} 실·박</strong></li><li><span>기간 내 공급 객실·박</span><strong>${number(own.metrics.supply)} 실·박</strong></li><li><span>실제 객실 기준</span><strong>${number(own.rooms)}실 · 예시</strong></li></ul><details class="detail-disclosure"><summary>단위와 계산 기준 보기</summary><p>객실 수는 시설의 객실 기준입니다. 실·박은 기간 내 객실 수와 숙박 일수를 함께 나타냅니다. 예약률은 공개 예약과 방막기 추정을 합한 뒤 기간 내 공급 객실·박으로 나눈 값입니다. 미확보 자료는 0과 구분합니다. 방막기 추정은 실제 판매를 확정하지 않습니다.</p></details></section></div>`;
  }
  const editLabels = { name: '매장명', address: '주소', category: '업종', rooms: '전체 객실 수', dayUse: '데이유즈 운영', facilities: '시설·편의정보' };
  const dayUseLabels = { unknown: '확인 전', none: '운영하지 않음', separate: '숙박과 별도 객실 사용', shared: '숙박과 같은 객실 사용' };
  const correctionStatusLabels = { pending: '검수 대기', superseded: '새 요청으로 변경', withdrawn: '요청 철회' };
  const pendingCorrection = (id) => state.correctionRequests?.findLast((item) => item.companyId === id && item.status === 'pending');
  function editSummary(company) {
    const settings = state.companySettings?.[company.id];
    return `<div class="company-edit-summary">${settings?.nickname ? `<span class="tag neutral">내 별칭 · ${escape(settings.nickname)}</span>` : ''}${pendingCorrection(company.id) ? '<span class="tag neutral">정보 수정 · 검수 대기</span>' : ''}<button class="text-link" data-action="edit-company" data-id="${escape(company.id)}">정보 수정 ${icon('settings')}</button></div>`;
  }
  function companyEditContent(company) {
    const settings = state.companySettings?.[company.id] || {};
    const pending = pendingCorrection(company.id);
    const current = { ...company, dayUse: company.dayUse || 'unknown', facilities: company.facilities || '' };
    const draft = { ...current, ...pending?.proposed };
    const valueLabel = (key, value) => key === 'dayUse' ? dayUseLabels[value] : key === 'rooms' ? `${value}실` : value || '확인 전';
    const history = (state.correctionRequests || []).filter((item) => item.companyId === company.id).slice().reverse();
    return `<div class="info-strip edit-policy">${icon('info')}별칭·메모는 내 계정에 저장합니다. 매장 정보는 검수 후 공통 분석 기준에 반영하며, 기존 발행 리포트는 유지합니다.</div>
      <h3 class="edit-section-title">내 계정의 개인 설정</h3>
      <div class="field"><label class="form-label" for="edit-nickname">내가 사용할 별칭</label><input id="edit-nickname" maxlength="80" value="${escape(settings.nickname || '')}" placeholder="예: 가까운 비교 매장"><small class="form-help">공식 매장명과 업체 고유번호는 바뀌지 않습니다.</small></div>
      <div class="field"><label class="form-label" for="edit-note">나만의 메모</label><textarea id="edit-note" maxlength="1000" rows="3">${escape(settings.note || '')}</textarea><small class="form-help">검수용 예시 메모만 입력해 주세요.</small></div>
      <h3 class="edit-section-title">매장 정보 수정 요청 ${pending ? '<span class="tag neutral">검수 대기</span>' : ''}</h3>
      <p class="form-help">검수 전에는 현재 객실 기준·예약률·매출이 유지됩니다.</p>
      <div class="field-grid">${Object.entries(editLabels).map(([key, label]) => `<div class="field ${['name', 'address', 'facilities'].includes(key) ? 'edit-full' : ''}"><label class="form-label" for="edit-${key}">${label}</label>${key === 'dayUse' ? `<select id="edit-dayUse">${Object.entries(dayUseLabels).map(([value, text]) => `<option value="${value}" ${draft.dayUse === value ? 'selected' : ''}>${text}</option>`).join('')}</select>` : key === 'facilities' ? `<textarea id="edit-facilities" maxlength="1000" rows="3">${escape(draft.facilities)}</textarea>` : `<input id="edit-${key}" ${key === 'rooms' ? 'type="number" min="1" step="1"' : `maxlength="${key === 'name' ? 120 : key === 'address' ? 300 : 60}"`} value="${escape(draft[key])}">`}<small class="form-help">현재 기준: ${escape(valueLabel(key, current[key]))}</small></div>`).join('')}</div>
      <div class="field"><label class="form-label" for="edit-reason">수정 근거</label><textarea id="edit-reason" maxlength="1000" rows="3" placeholder="예: 객실 안내에서 확인한 수량과 확인 날짜">${escape(pending?.reason || '')}</textarea><small class="form-help">매장 정보를 변경할 때 필수입니다. 이전 요청과 다른 내용으로 저장하면 변경 이력을 남깁니다. 모든 항목을 현재 기준으로 되돌려 저장하면 대기 요청을 철회합니다.</small></div>
      ${pending ? `<button class="button" data-action="withdraw-company-correction" data-id="${escape(pending.id)}" data-save>대기 중인 수정 요청 철회</button>` : ''}
      <details class="detail-disclosure"><summary>수정 요청 이력 ${history.length}건</summary>${history.length ? `<ol class="edit-history">${history.map((item) => `<li><strong>${escape(correctionStatusLabels[item.status] || item.status)}</strong><time>${escape(new Date(item.submittedAt).toLocaleString('ko-KR'))}</time><p>${Object.entries(item.proposed).map(([key, value]) => `${escape(editLabels[key])}: ${escape(valueLabel(key, item.baseValues[key]))} → ${escape(valueLabel(key, value))}`).join('<br>')}</p><p>근거: ${escape(item.reason)}</p></li>`).join('')}</ol>` : '<p class="form-help">아직 수정 요청이 없습니다.</p>'}</details>`;
  }
  async function saveCompanyInfo() {
    const proposed = Object.fromEntries(Object.keys(editLabels).map((key) => [key, key === 'rooms' ? Number($('#edit-rooms').value) : $(`#edit-${key}`).value]));
    const saved = await save('edit-company', { companyId: modal.id, nickname: $('#edit-nickname').value, note: $('#edit-note').value, proposed, reason: $('#edit-reason').value });
    if (saved) { closeModal(); toast(saved.audit.at(-1).message); }
  }
  function competitorsPage() {
    const selected = competitors();
    const items = [owned(), ...selected].filter(Boolean);
    return heading('A SHARED PERSPECTIVE', '경쟁 분석', '같은 숙박 기간, 같은 계산 기준으로 차이를 살펴봅니다.', `<button class="button primary" data-action="targets-competitors">경쟁업체 관리 <span>${state.competitorIds.length}/${state.limits.competitorLimit}</span> ${icon('plus')}</button>`) + `<div class="section-grid">${selected.map((company) => `<article class="card company-card"><div class="company-card-top"><span class="company-monogram">${escape(company.name.charAt(0))}</span><div><h2>${escape(company.name)}</h2><span class="tag neutral">${escape(company.category)}</span></div></div><p class="address">${escape(company.address)}</p><div class="card-metric"><span class="card-metric-label">예약률 · 방막기 추정 포함</span>${percent(bookingRate(company.metrics))}</div>${legend()}<div class="booking-bar" style="width:100%;height:7px;margin:11px 0 20px"><i style="width:${publicRate(company.metrics)}%"></i><i class="purple" style="width:${inferredRate(company.metrics)}%"></i></div><div class="company-card-bottom"><span>예시 객실 기준 ${number(company.rooms)}실</span><button class="text-link" data-action="company-detail" data-id="${escape(company.id)}">상세 보기 ↗</button></div>${editSummary(company)}</article>`).join('')}<button class="card add-card" data-action="targets-competitors">${icon('plus')}<strong>${selected.length >= state.limits.competitorLimit ? '경쟁업체 관리' : '새로운 비교업체 추가'}</strong><span>${selected.length} / ${state.limits.competitorLimit}곳 사용 중</span><span>${state.limits.competitorLimit === 0 ? '현재 활성 등록 가능 수량은 0곳입니다.' : '설정한 범위 안에서 대상을 변경할 수 있습니다.'}</span></button></div><section class="card section-space"><div class="card-header"><div><h2 class="card-title">한눈에 비교하기</h2><p class="card-subtitle">2026년 9월 · 모든 수치는 검수용 예시입니다.</p></div>${legend()}</div>${companyTable(items)}</section><div class="info-strip">${icon('info')}다른 규모의 업체는 총매출과 예약률을 함께 보세요. 대상 교체 이전의 리포트는 발행 당시의 업체와 수치로 보관됩니다.</div>`;
  }
  function regionPage() {
    const items = regions();
    const selected = items.find((region) => region.code === selectedRegion) || items[0];
    selectedRegion = selected?.code || null;
    return heading('PLACE & POSSIBILITIES', '지역 분석', '내 매장 주변의 수요와 다음 관심지역을 함께 읽습니다.', `<button class="button" data-action="targets-regions">관심지역 관리 ${state.interestRegionCodes.length}/${state.limits.interestRegionLimit} ${icon('plus')}</button>`) + (selected ? `<div class="toolbar"><div class="tabs" role="tablist" aria-label="분석 지역">${items.map((region) => `<button class="tab ${region.code === selected.code ? 'active' : ''}" role="tab" aria-selected="${region.code === selected.code}" data-action="select-region" data-code="${escape(region.code)}">${escape(region.name)}${owned()?.regionCode === region.code ? ' · 내 매장' : ''}</button>`).join('')}</div><span class="tag neutral">연결 전 · 예시 지표</span></div><section class="card region-intro"><div><span class="eyebrow">REGIONAL INSIGHT</span><h2>${escape(selected.name)}</h2><p>${owned()?.regionCode === selected.code ? '내 매장 소재 지역입니다. 관심지역 한도를 사용하지 않습니다.' : '내가 선택한 관심지역입니다. 고객별 설정 범위로 관리합니다.'}</p></div><div class="mini-region-map">${mapIllustration()}</div></section><div class="stat-grid">${stat('관광 방문 지표', number(finite(selected.metrics.visitors) ? selected.metrics.visitors / 10000 : null), finite(selected.metrics.visitors) ? '만 명' : '', '2026년 9월 · 예시', 'people')}${stat('검색 관심 지수', number(selected.metrics.searchIndex), finite(selected.metrics.searchIndex) ? '/ 100' : '', '동일 조회 범위 내 상대지수 예시', 'search')}${stat('지역 인구', number(selected.metrics.population), finite(selected.metrics.population) ? '명' : '', '2025년 · 예시', 'regions')}${stat('산업 구성', '<span class="metric-placeholder">자료 준비 중</span>', '', '미확보 값을 0으로 표시하지 않습니다.', 'competitors')}</div><div class="section-grid two"><section class="card"><div class="card-header"><div><h2 class="card-title">지역을 함께 읽는 관점</h2><p class="card-subtitle">방문·관심·생활 배경을 연결해 살펴봅니다.</p></div></div><ul class="plain-list"><li><span>방문 지표</span><strong>수요의 계절성</strong></li><li><span>검색 관심</span><strong>여행 준비 흐름</strong></li><li><span>인구·산업</span><strong>지역의 생활 기반</strong></li><li><span>예약 흐름</span><strong>관측된 숙박 수요</strong></li></ul><p class="region-detail-note section-space">서로 다른 지표의 기준기간은 각각 표시합니다. 검색지수는 실제 검색 건수가 아니며, 다른 조회 범위의 지수를 그대로 합산하지 않습니다.</p></section><section class="card"><div class="card-header"><div><h2 class="card-title">지역 리포트로 이어보기</h2><p class="card-subtitle">발행된 내용을 기간별로 살펴보세요.</p></div><a class="text-link" href="#reports">리포트 ↗</a></div>${reportPreviews()}</section></div>` : empty('분석할 관심지역을 선택해 주세요.', `준비 중 회원은 첫 지역부터 관심지역 한도를 사용합니다. 현재 한도는 ${state.limits.interestRegionLimit}곳입니다.`, 'targets-regions', '관심지역 선택'));
  }
  function reportsPage() {
    const items = state.reports.filter((report) => reportFilter === 'all' || report.type === reportFilter);
    return heading('YOUR REPORT LIBRARY', '리포트', '한 주의 변화와 한 달의 흐름을 차곡차곡 보관합니다.', '<span class="tag neutral">검수용 예시 발행본</span>') + `<div class="toolbar"><div class="tabs" role="tablist" aria-label="리포트 유형">${[['all', '전체'], ['weekly', '주간 리포트'], ['monthly', '월간 리포트']].map(([type, label]) => `<button class="tab ${reportFilter === type ? 'active' : ''}" role="tab" aria-selected="${reportFilter === type}" data-action="filter-reports" data-filter="${type}">${label}</button>`).join('')}</div><label class="search-field report-filter">${icon('search')}<span class="sr-only">리포트 제목 또는 기간 검색</span><input id="report-search" placeholder="제목 또는 기간 검색" type="search"></label></div><div class="report-grid">${items.map((report) => `<article class="card report-tile" data-search-report="${escape(`${report.title} ${report.period}`.toLowerCase())}"><div class="report-art ${report.type === 'weekly' ? 'weekly' : ''}"><span>SABUN INSIGHT REPORT</span><strong>${report.type === 'monthly' ? '한 달의 흐름을 읽다' : '한 주의 변화를 담다'}</strong><small>${escape(report.period)}</small></div><div class="report-body"><div class="inline-tags"><span class="tag">${report.type === 'monthly' ? '월간' : '주간'}</span><span class="tag neutral">예시 발행 · v${escape(report.version)}</span></div><h2>${escape(report.title)}</h2><p>${escape(report.summary)}</p><button class="button" data-action="report" data-id="${escape(report.id)}">리포트 열기 ${icon('arrow')}</button></div></article>`).join('')}</div><div id="report-search-empty" class="empty-state section-space" hidden><h3>검색 결과가 없습니다.</h3><p>리포트 제목이나 2026-08처럼 기간을 입력해 보세요.</p></div><div class="info-strip">${icon('info')}발행본은 당시 대상과 수치로 보관됩니다. 현재 설정을 변경해도 과거 발행본은 바뀌지 않습니다. 상세 화면에서 인쇄하거나 PDF로 저장할 수 있습니다.</div>`;
  }
  function usageCard(title, count, limit, action) {
    return `<section class="card"><div class="card-header"><h2 class="card-title">${escape(title)}</h2><span class="tag neutral">고객별 제공 범위</span></div><div class="usage-value">${count}<small> / ${limit}곳</small></div><div class="usage-track"><span style="width:${limit > 0 ? Math.min(100, count / limit * 100) : 0}%"></span></div><p class="card-subtitle">${limit === 0 ? '현재 등록 가능 수량이 0곳입니다.' : `현재 ${Math.max(0, limit - count)}곳을 더 등록할 수 있습니다.`}</p><button class="button section-space" data-action="${action}">등록 대상 관리 ${icon('arrow')}</button></section>`;
  }
  function settingsPage() {
    return heading('YOUR WORKSPACE', '설정', '매장 유형과 분석 대상을 내 상황에 맞게 관리합니다.', '<button class="button" data-action="auth">회원가입 흐름 체험 '+icon('arrow')+'</button>') + `<section class="card"><div class="settings-row"><div><h3>현재 회원 유형</h3><p>${state.customer.businessStage === 'owned' ? '내 매장 등록 · 가상 업체 연결' : '매장 준비 중 · 실제 매장 연결 전'}</p></div><button class="button" data-action="onboard">유형·매장 변경</button></div><div class="settings-row"><div><h3>${owned() ? '연결된 내 매장' : '준비 프로젝트'}</h3><p>${escape(owned()?.name || state.customer.projectName)}</p></div><span class="tag neutral">예시 회원</span></div><div class="settings-row"><div><h3>화면 모드</h3><p>현재 기기에 라이트·다크 화면 선택만 저장합니다.</p></div><button class="button" data-action="theme">화면 모드 전환</button></div></section><div class="section-grid two section-space">${usageCard('경쟁업체', state.competitorIds.length, state.limits.competitorLimit, 'targets-competitors')}${usageCard('관심지역', state.interestRegionCodes.length, state.limits.interestRegionLimit, 'targets-regions')}</div><section class="card section-space"><div class="card-header"><div><h2 class="card-title">등록 이력과 리포트</h2><p class="card-subtitle">대상 변경과 한도 축소 후에도 과거 기록은 남깁니다.</p></div></div><ul class="plain-list"><li><span>비활성 보관 경쟁업체</span><strong>${state.archived.competitorIds.length}곳</strong></li><li><span>비활성 보관 관심지역</span><strong>${state.archived.interestRegionCodes.length}곳</strong></li><li><span>기존 예시 발행본</span><strong>${state.reports.length}건</strong></li></ul><div class="info-strip">${icon('info')}이 페이지의 설정은 예시 회원의 검수용 상태에만 적용됩니다. 실제 가입, 소유·운영 확인, 고객별 인증과 연결하지 않습니다.</div></section>`;
  }
  function render() {
    if (!state) return;
    route = location.hash.slice(1).split('?')[0] || 'home';
    if (!navigation.some(([key]) => key === route)) route = 'home';
    const label = navigation.find(([key]) => key === route)[1];
    $('#navigation').innerHTML = navigation.map(([key, title]) => `<a href="#${key}" class="nav-link ${route === key ? 'active' : ''}" ${route === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${title}</span></a>`).join('');
    $('#breadcrumb-current').textContent = label;
    $('#sidebar-profile').innerHTML = `${state.customer.businessStage === 'owned' ? '운영 중 예시 회원' : '준비 중 예시 회원'}<small>${escape(owned()?.name || state.customer.projectName)}</small>`;
    document.title = `사분 인사이트 · ${label}`;
    $('#main').innerHTML = ({ home: homePage, property: propertyPage, competitors: competitorsPage, regions: regionPage, reports: reportsPage, settings: settingsPage })[route]();
  }

  function openModal(type, data = {}) {
    focusBeforeModal ||= document.activeElement;
    modal = { type, ...data };
    renderModal();
    document.body.classList.add('modal-open');
  }
  function closeModal() {
    modal = null;
    $('#modal-root').innerHTML = '';
    document.body.classList.remove('modal-open');
    if (focusBeforeModal?.isConnected) focusBeforeModal.focus();
    else $('#main').focus({ preventScroll: true });
    focusBeforeModal = null;
  }
  function modalShell(kicker, title, description, content, footer = '', wide = false) {
    return `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description"><header class="modal-header"><div><span class="eyebrow">${escape(kicker)}</span><h2 id="modal-title">${escape(title)}</h2><p id="modal-description">${escape(description)}</p></div><button class="icon-button" data-action="close-modal" aria-label="창 닫기">${icon('close')}</button></header><div class="modal-content"><div id="modal-error" class="form-error" role="alert" tabindex="-1"></div>${content}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  }
  function selectorCompanies(selectedIds, name, { ownSelection = false, activeOnly = false, searchId = 'company-search' } = {}) {
    const list = activeOnly ? competitors() : state.companies;
    return `${activeOnly ? '' : `<label class="search-field">${icon('search')}<span class="sr-only">매장명 또는 주소 검색</span><input id="${searchId}" type="search" placeholder="매장명 또는 주소 검색" autocomplete="off" data-search="companies"></label>`}<div class="selection-list" data-selection-list="${name}">${list.map((company) => {
      const disabled = !ownSelection && company.id === owned()?.id;
      return `<label class="selection-row ${disabled ? 'disabled' : ''}" data-company-search="${escape(`${company.name} ${company.address} ${company.category}`.toLowerCase())}"><input type="${ownSelection ? 'radio' : 'checkbox'}" name="${name}" value="${escape(company.id)}" ${selectedIds.includes(company.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${escape(company.name)}</strong><small>${escape(company.address)}</small></span><span class="tag ${disabled ? '' : 'neutral'}">${disabled ? '내 매장' : `${escape(company.category)} · ${number(company.rooms)}실`}</span></label>`;
    }).join('')}</div><p class="filter-empty" data-company-empty hidden>이름 또는 주소와 일치하는 예시 업체가 없습니다.</p>`;
  }
  function selectorRegions(selectedCodes, name, activeOnly = false) {
    return `<div class="selection-list" data-selection-list="${name}">${(activeOnly ? state.regions.filter((region) => state.interestRegionCodes.includes(region.code)) : state.regions).map((region) => {
      const base = owned()?.regionCode === region.code;
      return `<label class="selection-row ${base ? 'disabled' : ''}"><input type="checkbox" name="${name}" value="${escape(region.code)}" ${selectedCodes.includes(region.code) ? 'checked' : ''} ${base ? 'disabled' : ''}><span><strong>${escape(region.name)}</strong><small>${base ? '내 매장 소재 지역은 기본 제공됩니다.' : '시군구 단위 관심지역'}</small></span>${base ? '<span class="tag">한도 제외</span>' : ''}</label>`;
    }).join('')}</div>`;
  }
  function targetsContent(mode) {
    return `${mode !== 'regions' ? `<div class="selection-heading" style="margin-top:0"><h3>경쟁업체 선택</h3><span id="competitor-selection-count">${modal.competitorIds.length} / ${state.limits.competitorLimit}곳</span></div>${selectorCompanies(modal.competitorIds, 'competitorIds')}${state.limits.competitorLimit === 0 ? '<p class="form-help">현재 등록 가능 수량은 0곳입니다. 관리자 미리보기에서 한도를 조정할 수 있습니다.</p>' : ''}` : ''}${mode !== 'competitors' ? `<div class="selection-heading"><h3>관심지역 선택</h3><span id="region-selection-count">${modal.interestRegionCodes.length} / ${state.limits.interestRegionLimit}곳</span></div>${selectorRegions(modal.interestRegionCodes, 'interestRegionCodes')}<p class="form-help">${owned() ? '내 매장 소재 지역은 기본 제공하며 관심지역 한도에서 제외합니다.' : '준비 중 회원은 처음 선택한 지역부터 관심지역 한도를 사용합니다.'}</p>` : ''}`;
  }
  function onboardingContent() {
    const step = modal.step || 1;
    const stepper = `<div class="stepper" aria-label="등록 진행 단계">${[['1', '매장 유형'], ['2', '분석 대상'], ['3', '설정 확인']].map(([value, label]) => `<span class="${step === Number(value) ? 'active' : ''}" ${step === Number(value) ? 'aria-current="step"' : ''}><b>${value}</b>${label}</span>`).join('')}</div>`;
    if (step === 1) return stepper + `<div class="select-cards"><button class="choice-card ${modal.businessStage === 'owned' ? 'active' : ''}" data-action="stage" data-stage="owned" aria-pressed="${modal.businessStage === 'owned'}">${icon('property')}<strong>내 매장 등록</strong><small>운영하거나 보유한 매장을<br>분석 대상으로 연결합니다.</small></button><button class="choice-card ${modal.businessStage === 'planning' ? 'active' : ''}" data-action="stage" data-stage="planning" aria-pressed="${modal.businessStage === 'planning'}">${icon('leaf')}<strong>매장 준비 중</strong><small>실제 매장 없이 지역과<br>비교업체부터 살펴봅니다.</small></button></div>${modal.businessStage === 'owned' ? `<div class="field"><label class="form-label" for="own-company-search">내 매장 찾기</label>${selectorCompanies(modal.ownedCompanyId ? [modal.ownedCompanyId] : [], 'ownedCompanyId', { ownSelection: true, searchId: 'own-company-search' })}<p class="form-help">검수용 가상 업체만 제공됩니다. 실제 서비스에서는 등록 요청 후 소유·운영 확인을 별도로 진행합니다.</p></div>` : `<div class="field"><label class="form-label" for="project-name">준비 프로젝트 이름</label><input id="project-name" maxlength="80" value="${escape(modal.projectName || '나의 스테이 준비')}" autocomplete="off"><p class="form-help">검수용 가칭만 입력하세요. 실제 성명·전화번호·주소 등의 개인정보는 입력하지 않습니다.</p></div><div class="info-strip">${icon('info')}실제 매장을 연결할 때 기존 고객번호, 경쟁업체, 관심지역, 발행 리포트가 이어집니다.</div>`}`;
    if (step === 2) return stepper + targetsContent('all');
    return stepper + `<div class="empty-state" style="border:0;padding:18px 5px">${icon('check')}<h3>나만의 분석 공간이 준비되었습니다.</h3><p>아래 설정은 예시 회원에게만 적용되었습니다.</p></div><ul class="plain-list"><li><span>매장 유형</span><strong>${state.customer.businessStage === 'owned' ? '내 매장 등록' : '매장 준비 중'}</strong></li><li><span>${owned() ? '연결 매장' : '준비 프로젝트'}</span><strong>${escape(owned()?.name || state.customer.projectName)}</strong></li><li><span>경쟁업체</span><strong>${state.competitorIds.length} / ${state.limits.competitorLimit}곳</strong></li><li><span>관심지역</span><strong>${state.interestRegionCodes.length} / ${state.limits.interestRegionLimit}곳</strong></li></ul><p class="form-help">${owned() ? '내 매장 소재 지역은 기본 제공됩니다. 실제 소유·운영 확인은 이 검수본에서 진행하지 않습니다.' : '준비 중에도 지역·경쟁 분석과 기존 리포트를 이용할 수 있습니다.'}</p>`;
  }
  function adminContent() {
    const limits = modal.limits;
    return `<div class="admin-note">고객관리 화면의 동작을 확인하는 검수 패널입니다. 실제 관리자 권한·운영 DB와 연결하지 않으며, 현재 예시 회원에게만 적용됩니다.</div><div class="field-grid"><div class="field"><label class="form-label" for="competitor-limit">경쟁업체 허용 수량</label><div class="admin-number"><input id="competitor-limit" type="number" min="0" max="1000" step="1" value="${limits.competitorLimit}"><span>곳</span></div><p class="form-help">현재 활성 ${state.competitorIds.length}곳</p></div><div class="field"><label class="form-label" for="region-limit">관심지역 허용 수량</label><div class="admin-number"><input id="region-limit" type="number" min="0" max="1000" step="1" value="${limits.interestRegionLimit}"><span>곳</span></div><p class="form-help">현재 활성 ${state.interestRegionCodes.length}곳 · 내 매장 소재 지역 제외</p></div></div><div id="admin-limit-selection">${adminSelection()}</div><p class="form-help">0은 활성 등록 허용 없음입니다. 제외하는 대상은 비활성 보관하며 기존 발행 리포트는 유지합니다.</p><details class="detail-disclosure"><summary>예시 고객 변경 이력 ${state.audit.length}건</summary><ul class="audit-list">${state.audit.slice(-8).reverse().map((entry) => `<li>${escape(entry.message || entry.action)}</li>`).join('')}</ul></details>`;
  }
  function adminSelection() {
    const reduceCompetitors = state.competitorIds.length > modal.limits.competitorLimit;
    const reduceRegions = state.interestRegionCodes.length > modal.limits.interestRegionLimit;
    if (!reduceCompetitors && !reduceRegions) return '';
    return `<div class="limit-selection"><div class="info-strip amber" style="margin-top:0">${icon('info')}한도보다 등록 대상이 많습니다. 유지할 대상을 직접 선택하세요. 선택하지 않은 대상은 비활성 보관합니다.</div>${reduceCompetitors ? `<div class="selection-heading"><h3>유지할 경쟁업체</h3><span>최대 ${modal.limits.competitorLimit}곳</span></div>${selectorCompanies(modal.keepCompetitorIds || [], 'keepCompetitorIds', { activeOnly: true })}` : ''}${reduceRegions ? `<div class="selection-heading"><h3>유지할 관심지역</h3><span>최대 ${modal.limits.interestRegionLimit}곳</span></div>${selectorRegions(modal.keepInterestRegionCodes || [], 'keepInterestRegionCodes', true)}` : ''}<label class="selection-row" style="margin-top:17px"><input type="checkbox" id="archive-confirm" ${modal.archiveConfirmed ? 'checked' : ''}><span><strong>유지 대상을 선택했고, 나머지 대상의 비활성 보관을 확인했습니다.</strong><small>기존 자료와 발행 리포트는 삭제되지 않습니다.</small></span></label></div>`;
  }
  function reportContent(report) {
    const snapshot = report.snapshot;
    if (!snapshot) return empty('발행 당시 자료를 확인할 수 없습니다.', '현재 화면의 수치로 대체하지 않습니다. 발행본 연결이 필요합니다.');
    const metrics = snapshot.metrics || {};
    return `<article class="report-sheet"><div class="report-sheet-top"><span class="report-kicker">SABUN INSIGHT · ${report.type === 'monthly' ? 'MONTHLY' : 'WEEKLY'} REPORT</span><h1>${escape(report.title)}</h1><div class="report-sheet-meta"><span>대상: ${escape(snapshot.name || snapshot.companyName || '예시 대상')}</span><span>기간: ${escape(report.period)}</span><span>버전: ${escape(report.version)}</span><span>가상 예시 발행본</span></div></div><p>${escape(report.summary)}</p><div class="info-strip">${icon('info')}${escape(snapshot.metricScope || '발행 당시 고정한 예시 수치입니다.')} · 현재 설정을 바꾸어도 이 발행본의 수치는 변하지 않습니다.</div><div class="stat-grid">${stat('공개 예약', number(metrics.publicBookings), finite(metrics.publicBookings) ? '실·박' : '', '예시 발행 시점', 'calendar', 'green')}${stat('방막기 추정', number(metrics.inferredBookings), finite(metrics.inferredBookings) ? '실·박' : '', '실제 판매 미확정', 'clock', 'purple')}${stat('추정 매출', money(metrics.estimatedRevenue), '', '공개 및 방막기 추정 포함', 'coin')}</div><h3>발행 당시의 분석 범위</h3><ul class="plain-list"><li><span>대상</span><strong>${escape(snapshot.name || snapshot.companyName || '예시 대상')}</strong></li><li><span>경쟁업체 수</span><strong>${snapshot.competitorIds?.length ?? 0}곳</strong></li><li><span>지역 수</span><strong>${snapshot.regionCodes?.length ?? 0}곳</strong></li><li><span>자료 충족률</span><strong>${percent(finite(metrics.coverage) ? metrics.coverage * 100 : null)}</strong></li><li><span>공급 객실·박</span><strong>${number(metrics.supply)}${finite(metrics.supply) ? ' 실·박' : ''}</strong></li></ul><h3>지표를 읽는 방법</h3><p>공개 예약은 정상 응답에서 관측한 예약, 방막기 추정은 공개되지 않은 객실 상태를 별도로 분류한 값입니다. 추정 매출은 실제 정산 매출과 다를 수 있습니다. 업체별 객실 기준과 관측 범위를 함께 확인해야 합니다.</p>${report.type === 'weekly' ? '<p>이 주간 검수본에는 기간 합계를 담았습니다. 같은 숙박일의 이전·현재 관측 비교와 리드타임 분석은 실제 자료 연결 후 제공하며, 이 합계를 주간 증감으로 해석하지 않습니다.</p>' : '<p>월간 리포트는 숙박일 기준으로 정리합니다. 같은 업체·같은 숙박일을 여러 번 관측하더라도 중복 합산하지 않는 구조로 연결할 예정입니다.</p>'}<div class="info-strip purple">${icon('info')}자료 출처: ${escape(snapshot.source || '가상 예시 데이터')} · 화면과 인쇄물 모두 실제 고객 리포트가 아닙니다.</div></article>`;
  }
  function renderModal() {
    if (!modal) return;
    let html = '';
    if (modal.type === 'onboard') {
      const step = modal.step || 1;
      html = modalShell('LET’S BEGIN', '나의 분석 공간 만들기', '내 매장 등록 또는 준비 중인 상황에 맞춰 시작하세요.', onboardingContent(), `<span class="footer-note">실제 회원가입이 아닌 예시 설정 체험입니다.</span>${step < 3 ? `<button class="button" data-action="close-modal">나중에</button><button class="button primary" data-action="onboard-next" data-save>${step === 1 ? '유형 저장 · 다음' : '분석 대상 저장'} ${icon('arrow')}</button>` : '<button class="button primary" data-action="onboard-done">내 공간 살펴보기 '+icon('arrow')+'</button>'}`);
    } else if (modal.type === 'edit-company') {
      const company = companyById(modal.id);
      html = modalShell('PROPERTY INFORMATION', '매장 정보 수정', company?.name || '등록 매장', company ? companyEditContent(company) : '<p>등록된 매장을 확인해 주세요.</p>', '<span class="footer-note">예시 저장·수정 요청 체험입니다. 운영 DB에는 반영되지 않습니다.</span><button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="save-company-info" data-save>변경 내용 저장</button>');
    } else if (modal.type === 'targets') {
      html = modalShell('YOUR PERSPECTIVE', modal.mode === 'regions' ? '관심지역 관리' : modal.mode === 'competitors' ? '경쟁업체 관리' : '분석 대상 관리', '한도 안에서 원하는 대상을 선택하고 저장하세요.', targetsContent(modal.mode), '<span class="footer-note">제외한 대상과 기존 리포트는 보관합니다.</span><button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="save-targets" data-save>선택 저장 '+icon('check')+'</button>');
    } else if (modal.type === 'admin') {
      html = modalShell('ADMIN PREVIEW', '고객별 제공 범위', `${state.customer.name} · 관리자 화면 검수`, adminContent(), '<button class="button ghost" style="margin-right:auto" data-action="reset-preview">예시 설정 초기화</button><button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="save-limits" data-save>한도 적용 '+icon('check')+'</button>');
    } else if (modal.type === 'report') {
      const report = state.reports.find((item) => item.id === modal.id);
      html = modalShell('PUBLISHED SNAPSHOT', '리포트 미리보기', '발행 당시 수치와 대상을 고정한 예시 리포트입니다.', report ? reportContent(report) : empty('리포트를 찾을 수 없습니다.', '리포트 목록을 다시 확인해 주세요.'), '<span class="footer-note">인쇄 창에서 PDF 저장을 선택할 수 있습니다.</span><button class="button" data-action="close-modal">닫기</button><button class="button primary" data-action="print-report">'+icon('print')+'인쇄 / PDF 저장</button>', true);
    } else if (modal.type === 'company') {
      const company = companyById(modal.id);
      html = modalShell('COMPANY PREVIEW', company?.name || '업체 상세', company?.address || '검수용 가상 업체', company ? `<div class="inline-tags"><span class="tag neutral">${escape(company.category)}</span><span class="tag">예시 객실 ${number(company.rooms)}실</span></div><div class="section-space">${metricCards(company.metrics)}</div><p class="form-help">2026년 9월 · 가상의 예시 데이터입니다. 공개 예약과 방막기 추정은 실·박 단위이며 실제 매출을 확정하지 않습니다.</p>` : '', '<button class="button" data-action="close-modal">닫기</button>', true);
    } else if (modal.type === 'auth') {
      html = modalShell('WELCOME TO SABUN INSIGHT', '나에게 맞는 시작', '회원가입·로그인 이후 흐름을 체험할 수 있습니다.', `<div class="auth-mark">내일의 운영에,<br>하나의 새로운 시선.</div><p class="auth-description">실제 이메일이나 비밀번호 없이 예시 회원을 선택하세요. 고객 인증 연결 전 검수용 체험입니다.</p><div class="auth-samples"><button class="button" data-action="auth-start" data-profile="owner"><span>내 매장 등록으로 시작<small>운영 중 예시 회원으로 등록 흐름 체험</small></span>${icon('arrow')}</button><button class="button" data-action="auth-start" data-profile="planning"><span>매장 준비 중으로 시작<small>창업 준비 예시 회원으로 등록 흐름 체험</small></span>${icon('arrow')}</button></div><p class="auth-footer">실제 계정 생성·비밀번호 저장·개인정보 수집을 하지 않습니다.</p>`);
    } else if (modal.type === 'reset') {
      html = modalShell('RESET PREVIEW', '현재 예시 회원을 초기화할까요?', '이 검수본에서 변경한 매장·대상·한도를 최초 예시로 되돌립니다.', '<div class="info-strip" style="margin-top:0">'+icon('info')+'운영 서비스와 실제 고객 자료에는 영향을 주지 않습니다. 다른 예시 회원의 설정은 유지합니다.</div>', '<button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="confirm-reset" data-save>예시 회원 초기화</button>');
    }
    $('#modal-root').innerHTML = html;
    requestAnimationFrame(() => $('#modal-root .modal-header .icon-button')?.focus({ preventScroll: true }));
  }
  function startOnboarding() {
    openModal('onboard', { step: 1, businessStage: state.customer.businessStage, ownedCompanyId: state.customer.ownedCompanyId, projectName: state.customer.projectName, competitorIds: [...state.competitorIds], interestRegionCodes: [...state.interestRegionCodes] });
  }
  function startTargets(mode = 'all') {
    openModal('targets', { mode, competitorIds: [...state.competitorIds], interestRegionCodes: [...state.interestRegionCodes] });
  }
  function selectedValues(name) { return $$(`input[name="${name}"]:checked`).map((input) => input.value); }
  async function nextOnboard() {
    if (modal.step === 1) {
      const companyId = $('input[name="ownedCompanyId"]:checked')?.value || modal.ownedCompanyId;
      const projectName = modal.businessStage === 'planning' ? $('#project-name')?.value.trim() : companyById(companyId)?.name;
      if (modal.businessStage === 'owned' && !companyId) return showFormError('목록에서 내 매장을 선택해 주세요.');
      if (!projectName) return showFormError('준비 프로젝트 이름을 입력해 주세요.');
      const saved = await save('set-profile', { businessStage: modal.businessStage, ownedCompanyId: modal.businessStage === 'owned' ? companyId : null, projectName });
      if (!saved || !modal) return;
      modal.step = 2;
      modal.competitorIds = [...state.competitorIds];
      modal.interestRegionCodes = [...state.interestRegionCodes];
      renderModal();
    } else if (modal.step === 2) {
      const saved = await save('set-targets', { competitorIds: modal.competitorIds, interestRegionCodes: modal.interestRegionCodes });
      if (!saved || !modal) return;
      modal.step = 3;
      renderModal();
    }
  }
  async function saveLimits() {
    const competitorLimit = Number($('#competitor-limit').value);
    const interestRegionLimit = Number($('#region-limit').value);
    if ($('#competitor-limit').value === '' || $('#region-limit').value === '' || !Number.isInteger(competitorLimit) || !Number.isInteger(interestRegionLimit) || competitorLimit < 0 || interestRegionLimit < 0 || competitorLimit > 1000 || interestRegionLimit > 1000) return showFormError('허용 수량은 0부터 1000까지 정수로 입력해 주세요.');
    const payload = { competitorLimit, interestRegionLimit };
    const reduceCompetitors = state.competitorIds.length > competitorLimit;
    const reduceRegions = state.interestRegionCodes.length > interestRegionLimit;
    if ((reduceCompetitors || reduceRegions) && !$('#archive-confirm')?.checked) return showFormError('유지할 대상을 선택하고 비활성 보관 확인에 체크해 주세요.');
    if (reduceCompetitors) payload.keepCompetitorIds = selectedValues('keepCompetitorIds');
    if (reduceRegions) payload.keepInterestRegionCodes = selectedValues('keepInterestRegionCodes');
    if ((payload.keepCompetitorIds?.length || 0) > competitorLimit || (payload.keepInterestRegionCodes?.length || 0) > interestRegionLimit) return showFormError('유지할 대상 수가 새 한도보다 많습니다. 선택을 줄여 주세요.');
    if (await save('set-limits', payload)) { closeModal(); toast('예시 고객의 제공 범위를 변경했습니다. 기존 리포트는 유지됩니다.'); }
  }
  async function handleAction(button) {
    const action = button.dataset.action;
    if (action === 'theme') { setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); return; }
    if (action === 'toggle-menu') { setMenu(!$('#sidebar').classList.contains('open')); return; }
    if (action === 'close-modal') { if (!busy) closeModal(); return; }
    if (action === 'reload') { await load(); return; }
    if (!state || busy) return;
    switch (action) {
      case 'onboard': startOnboarding(); break;
      case 'edit-company': openModal('edit-company', { id: button.dataset.id }); break;
      case 'save-company-info': await saveCompanyInfo(); break;
      case 'withdraw-company-correction':
        if (await save('withdraw-company-correction', { requestId: button.dataset.id })) { renderModal(); toast('수정 요청을 철회했습니다. 이력은 보존됩니다.'); }
        break;
      case 'targets-competitors': startTargets('competitors'); break;
      case 'targets-regions': startTargets('regions'); break;
      case 'admin': openModal('admin', { limits: { ...state.limits }, keepCompetitorIds: [], keepInterestRegionCodes: [], archiveConfirmed: false }); break;
      case 'auth': openModal('auth'); break;
      case 'auth-start': if (await load(button.dataset.profile)) startOnboarding(); break;
      case 'stage':
        modal.projectName = $('#project-name')?.value || modal.projectName;
        modal.ownedCompanyId = $('input[name="ownedCompanyId"]:checked')?.value || modal.ownedCompanyId;
        modal.businessStage = button.dataset.stage;
        renderModal();
        break;
      case 'onboard-next': await nextOnboard(); break;
      case 'onboard-done': closeModal(); location.hash = 'home'; render(); toast('예시 회원의 분석 공간 설정을 완료했습니다.'); break;
      case 'save-targets':
        if (await save('set-targets', { competitorIds: modal.competitorIds, interestRegionCodes: modal.interestRegionCodes })) { closeModal(); toast('분석 대상을 저장했습니다. 과거 리포트는 그대로 보관합니다.'); }
        break;
      case 'save-limits': await saveLimits(); break;
      case 'report': openModal('report', { id: button.dataset.id }); break;
      case 'print-report': if (modal?.type === 'report') window.print(); break;
      case 'filter-reports': reportFilter = button.dataset.filter; render(); break;
      case 'select-region': selectedRegion = button.dataset.code; render(); break;
      case 'company-detail': openModal('company', { id: button.dataset.id }); break;
      case 'reset-preview': openModal('reset'); break;
      case 'confirm-reset': if (await save('reset', {})) { closeModal(); toast('현재 예시 회원을 처음 상태로 되돌렸습니다.'); } break;
    }
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) { event.preventDefault(); void handleAction(button); }
    if (event.target.closest('.nav-link')) setMenu(false);
    if (event.target.matches('.modal-backdrop') && !busy) closeModal();
  });
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target.dataset.search === 'companies') {
      const query = target.value.trim().toLowerCase();
      const rows = $$('[data-company-search]', target.closest('.modal-content'));
      rows.forEach((row) => { row.hidden = !row.dataset.companySearch.includes(query); });
      const emptyMessage = $('[data-company-empty]', target.closest('.modal-content'));
      if (emptyMessage) emptyMessage.hidden = rows.some((row) => !row.hidden);
    }
    if (target.id === 'report-search') {
      const query = target.value.trim().toLowerCase();
      const reports = $$('[data-search-report]');
      reports.forEach((report) => { report.hidden = !report.dataset.searchReport.includes(query); });
      $('#report-search-empty').hidden = reports.some((report) => !report.hidden);
    }
    if (modal?.type === 'admin' && ['competitor-limit', 'region-limit'].includes(target.id)) {
      modal.limits = { competitorLimit: Number($('#competitor-limit').value), interestRegionLimit: Number($('#region-limit').value) };
      modal.archiveConfirmed = false;
      $('#admin-limit-selection').innerHTML = adminSelection();
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'preview-profile') {
      if (busy) { target.value = profile; return; }
      closeModal();
      void load(target.value);
      return;
    }
    if (!modal) return;
    if (['competitorIds', 'interestRegionCodes'].includes(target.name)) {
      const key = target.name;
      const limit = key === 'competitorIds' ? state.limits.competitorLimit : state.limits.interestRegionLimit;
      const values = selectedValues(key);
      if (values.length > limit) {
        target.checked = false;
        toast(`${key === 'competitorIds' ? '경쟁업체' : '관심지역'}는 현재 ${limit}곳까지 선택할 수 있습니다.`);
      }
      modal[key] = selectedValues(key);
      const counter = $(key === 'competitorIds' ? '#competitor-selection-count' : '#region-selection-count');
      if (counter) counter.textContent = `${modal[key].length} / ${limit}곳`;
    }
    if (['keepCompetitorIds', 'keepInterestRegionCodes'].includes(target.name)) {
      modal[target.name] = selectedValues(target.name);
      modal.archiveConfirmed = false;
      if ($('#archive-confirm')) $('#archive-confirm').checked = false;
    }
    if (target.id === 'archive-confirm') modal.archiveConfirmed = target.checked;
    if (target.name === 'ownedCompanyId') modal.ownedCompanyId = target.value;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { if (modal && !busy) closeModal(); else setMenu(false); }
    if (event.key === 'Tab' && modal) {
      const focusable = $$('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]', $('#modal-root')).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = $$('[role="tab"]', tab.parentElement);
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      const action = tabs[next].dataset.action;
      const value = tabs[next].dataset.code || tabs[next].dataset.filter;
      tabs[next].click();
      $(`[data-action="${action}"][${action === 'select-region' ? 'data-code' : 'data-filter'}="${CSS.escape(value)}"]`)?.focus();
    }
  });
  window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); $('#main').focus({ preventScroll: true }); });
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => setMenu(false));
  setMenu(false);
  setTheme(getTheme());
  void load();
})();
