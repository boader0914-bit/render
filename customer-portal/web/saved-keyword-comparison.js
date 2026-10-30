(() => {
  'use strict';
  const PATH = '/saved-keyword-comparison/';
  function entry({ adminView = false, surface = '' } = {}) {
    return adminView && surface === 'admin' ? '<section class="card saved-keyword-entry" id="saved-keyword-review"><div><span class="status">관리자 보존 자료</span><h2>저장 키워드 비교</h2><p>경남글램핑의 2026년 9월 보존 자료로 월명과 상위 20개 표본을 검토합니다. 고객별 경쟁분석과 별도입니다.</p></div><a class="button" href="'+PATH+'" target="_blank" rel="noopener">보존 비교 화면 열기</a></section>' : '';
  }
  function panel({ adminView = false } = {}) {
    if (!adminView) return '<section class="card"><h1>관리자 전용 검토 화면입니다.</h1><p>등록한 내 매장과 경쟁업체 자료는 경쟁 분석에서 확인해 주세요.</p><a class="button" href="#competitors">경쟁 분석으로 돌아가기</a></section>';
    return '<section class="card saved-keyword-page"><h1>보존 자료 검토는 관리자 화면으로 이동했습니다.</h1><p>이 고객의 경쟁분석은 등록한 내 매장과 경쟁업체를 기준으로 표시합니다.</p><div class="saved-keyword-actions"><a class="button" href="/admin#saved-keyword-review">관리자 보존 자료로 이동</a><a class="button" href="#competitors">고객 경쟁 분석으로 돌아가기</a></div></section>';
  }
  window.InsightSavedKeywordComparison = { entry, panel };
})();
