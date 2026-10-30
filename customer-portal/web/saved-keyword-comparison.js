(() => {
  'use strict';
  const PATH = '/saved-keyword-comparison/';
  function entry({ adminView = false } = {}) {
    return adminView ? '<section class="card saved-keyword-entry"><div><span class="status-pill">관리자 검토</span><h2>저장 키워드 비교</h2><p>경남글램핑의 보존 자료로 월명과 상위 20개 표본의 예약률·가격·예약 변화를 비교합니다.</p></div><a class="button" href="'+PATH+'" target="_blank" rel="noopener">비교 화면 열기</a></section>' : '';
  }
  function panel({ adminView = false } = {}) {
    if (!adminView) return '<section class="card"><h1>관리자 전용 검토 화면입니다.</h1><p>등록한 내 매장과 경쟁업체 자료는 경쟁 분석에서 확인해 주세요.</p><a class="button" href="#competitors">경쟁 분석으로 돌아가기</a></section>';
    return '<section class="card saved-keyword-page"><div class="saved-keyword-heading"><div><span class="status-pill">보존 자료 · 관리자 검토</span><h1>경남글램핑 저장 비교</h1><p>2026년 9월 20~22일 관측으로 월명글램핑과 상위 20개 표본을 비교합니다. 현재 선택한 고객의 내 매장 자료와는 별도입니다.</p></div></div><p class="saved-keyword-scope">저장된 자료만 사용합니다. 데이터랩 실시간 조회·수집·정기수집 설정은 연결하지 않습니다.</p><div class="saved-keyword-actions"><a class="button primary" href="'+PATH+'" target="_blank" rel="noopener">저장 비교 화면 열기</a><a class="button" href="#competitors">경쟁 분석으로 돌아가기</a></div></section>';
  }
  window.InsightSavedKeywordComparison = { entry, panel };
})();
