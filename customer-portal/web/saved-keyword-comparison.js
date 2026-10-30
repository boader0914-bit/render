(() => {
  'use strict';
  const PATH = '/saved-keyword-comparison/';
  let generation = 0, controller = null;
  function stop() { generation++; controller?.abort(); controller = null; }
  function entry({ adminView = false } = {}) {
    return adminView ? '<section class="card saved-keyword-entry"><div><span class="status-pill">관리자 검토</span><h2>저장 키워드 비교</h2><p>경남글램핑의 보존 자료로 월명과 상위 20개 표본의 예약률·가격·예약 변화를 비교합니다.</p></div><a class="button" href="#saved-keyword-comparison">비교 화면 열기</a></section>' : '';
  }
  function panel({ adminView = false } = {}) {
    if (!adminView) return '<section class="card"><h1>관리자 전용 검토 화면입니다.</h1><p>등록한 내 매장과 경쟁업체 자료는 경쟁 분석에서 확인해 주세요.</p><a class="button" href="#competitors">경쟁 분석으로 돌아가기</a></section>';
    return '<section class="saved-keyword-page"><div class="saved-keyword-heading"><div><span class="status-pill">보존 자료 · 관리자 검토</span><h1>경남글램핑 저장 비교</h1><p>2026년 9월 20~22일 관측으로 월명글램핑과 상위 20개 표본을 비교합니다. 현재 선택한 고객의 내 매장 자료와는 별도입니다.</p></div><div class="saved-keyword-actions"><a class="button small" href="#competitors">경쟁 분석으로 돌아가기</a><a class="button small" href="'+PATH+'" target="_blank" rel="noopener">전체 화면으로 보기</a></div></div><p class="saved-keyword-scope">저장된 자료만 사용합니다. 데이터랩 실시간 조회·수집·정기수집 설정은 연결하지 않습니다.</p><div id="saved-keyword-frame-slot" class="saved-keyword-frame-slot"><div class="company-connection is-loading" role="status" data-saved-keyword-loading><span class="connection-spinner" aria-hidden="true"></span><div><strong>저장 비교 화면 준비 중</strong><p>관리자 권한을 확인하고 보존 자료를 표시합니다.</p></div></div><iframe data-saved-keyword-frame title="경남글램핑 저장 자료와 월명글램핑 비교" loading="eager" referrerpolicy="same-origin" hidden></iframe></div></section>';
  }
  async function mount({ adminView = false, onSessionExpired } = {}) {
    stop();
    if (!adminView) return;
    const slot = document.querySelector('#saved-keyword-frame-slot');
    if (!slot) return;
    const frame = slot.querySelector('[data-saved-keyword-frame]');
    const loading = slot.querySelector('[data-saved-keyword-loading]');
    const token = generation;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    controller = abort;
    try {
      const response = await fetch(PATH, { method: 'HEAD', credentials: 'same-origin', headers: { Accept: 'text/html' }, ...(abort ? { signal: abort.signal } : {}) });
      if (generation !== token || !slot.isConnected) return;
      if (response.status === 401) { onSessionExpired?.(); return; }
      if (!response.ok) throw Object.assign(new Error(response.status === 403 ? '관리자 권한으로만 저장 비교 자료를 볼 수 있습니다.' : '저장 비교 화면을 확인하지 못했습니다. 잠시 후 다시 열어 주세요.'), { status: response.status });
      frame.addEventListener('load', () => {
        if (generation !== token || !slot.isConnected) return;
        if (loading) loading.hidden = true;
        frame.hidden = false;
      }, { once: true });
      frame.src = PATH;
      frame.hidden = false;
    } catch (error) {
      if (generation !== token || !slot.isConnected || error.name === 'AbortError') return;
      if (loading) { loading.classList.remove('is-loading'); loading.replaceChildren(); const message = document.createElement('p'); message.textContent = error.message || '저장 비교 화면 연결을 확인해 주세요.'; loading.append(message); }
    } finally { if (generation === token) controller = null; }
  }
  window.InsightSavedKeywordComparison = { entry, panel, mount, stop };
})();
