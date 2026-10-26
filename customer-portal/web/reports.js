(() => {
  'use strict';
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n = x => typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('ko-KR') : '미확인';
  const states = {planned:'예정',in_progress:'진행 중',completed:'완료',held:'보류'};
  let serial = 0;
  function panel(enabled) {
    return `<section class="card" data-issued-reports><h2>받은 월간 리포트</h2><p class="muted">관리자가 검토·발행하고 내 계정에 배정한 고정본입니다. 아래 현재 상황 브리핑과 구분합니다.</p><div data-issued-content role="status">${enabled ? '배정된 발행본을 확인하고 있습니다.' : '월간 발행본 제공 연결을 준비 중입니다.'}</div></section>`;
  }
  function listView(reports) {
    if (!reports.length) return '<p class="empty-note">아직 배정된 월간 발행본이 없습니다.</p>';
    return reports.map(r => `<article class="connected-row"><span class="status-pill">월간 발행본 · v${esc(r.version)}</span><h3>${esc(r.title)}</h3><p>${esc(r.month)} · 발행 ${esc(r.publishedAt)}</p><button class="button" data-issued-id="${esc(r.reportId || r.id)}">발행본 열기</button></article>`).join('');
  }
  function detailView(report, base) {
    const s = report.summary || report.snapshot?.summary || {}, m = s.lodging || {}, plan = report.actionPlan || report.snapshot?.actionPlan;
    const evidence=new Map((report.snapshot?.actionEvidence || []).map(e=>[e.id,e.label]));
    return `<button class="text-link" data-issued-back>발행본 목록으로</button><h3>${esc(report.title)}</h3><p>${esc(report.month)} · 발행 버전 ${esc(report.version)} · 관측 마감 ${esc(report.cutoffDate || report.snapshot?.period?.cutoffDate || report.snapshot?.request?.cutoffDate || '미확인')}</p>
      <p class="muted">공개 자료의 관측·추정입니다. 실제 결제 매출이나 시장 전체 통계가 아닙니다. 발행 후 새 자료가 생겨도 이 본문은 바뀌지 않습니다.</p>
      <dl class="form-grid"><div><dt>공개 예약</dt><dd>${n(m.publicBookings)} 실·박</dd></div><div><dt>방막기 추정</dt><dd>${n(m.phoneBookings)} 실·박</dd></div><div><dt>숙박 추정매출</dt><dd>${n(m.estimatedRevenue)} 원</dd></div><div><dt>관측 업체·숙박일</dt><dd>${n(m.coveredCompanyDays)} / ${n(m.expectedCompanyDays)}</dd></div></dl>
      ${plan ? `<section><h3>검토한 실행 계획</h3><p>${esc(plan.summary)}</p>${(plan.items || []).map(a => `<article class="connected-row"><h4>${esc(a.title)}</h4><p>담당 ${esc(a.owner || '미지정')} · 기한 ${esc(a.dueDate || '미지정')} · ${esc(states[a.status] || '확인 필요')}</p><p>근거: ${(a.evidenceRefs || []).map(id=>esc(evidence.get(id) || "저장 근거 확인 필요")).join(", ") || "연결 근거 없음"}</p><p>${esc(a.outcome || '실행 결과 기록 없음')}</p><small class="muted">실행 결과는 작성자 기록이며, 효과가 독립 검증됐다는 뜻은 아닙니다.</small></article>`).join('')}</section>` : '<p class="muted">이 발행본에는 구조화된 실행 계획이 없습니다.</p>'}
      <a class="button primary" href="${esc(base)}/reports/${encodeURIComponent(report.reportId || report.id)}/pdf" download>검토한 발행 PDF 다운로드</a>`;
  }
  function mount(api, enabled, base) {
    const slot = document.querySelector('[data-issued-content]'), mine = ++serial;
    if (!slot || !enabled) return;
    let reports = [];
    const current = () => mine === serial && slot.isConnected;
    const error = e => { if (current()) slot.innerHTML = `<p class="empty-note" role="alert">${esc(e.message || '발행본을 확인하지 못했습니다.')}</p><button class="button" data-issued-retry>다시 확인</button>`; };
    const load = async () => { slot.innerHTML = '<p role="status">배정된 발행본을 확인하고 있습니다.</p>'; try { const data = await api('/reports'); if (current()) { reports = data.reports; slot.innerHTML = listView(reports); } } catch(e) { error(e); } };
    slot.onclick = async e => {
      const open = e.target.closest('[data-issued-id]');
      if (open) { const id = open.dataset.issuedId; slot.innerHTML = '<p role="status">고정된 발행본을 열고 있습니다.</p>'; try { const data = await api('/reports/' + encodeURIComponent(id)); if (current()) slot.innerHTML = detailView(data.report || data, base); } catch(e) { error(e); } }
      else if (e.target.closest('[data-issued-back]')) slot.innerHTML = listView(reports);
      else if (e.target.closest('[data-issued-retry]')) await load();
    };
    void load();
  }
  const api = {panel,listView,detailView,mount,stop(){serial++;}};
  if (typeof window !== 'undefined') window.InsightReports = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
