(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const number = value => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '미확인';
  const states = { planned:'예정', in_progress:'진행 중', completed:'완료', held:'보류' };
  const idFor = report => report?.reportId || report?.id;
  const validId = value => typeof value === 'string' && /^mr_[a-zA-Z0-9_-]+$/.test(value);
  let active;

  function panel(enabled) {
    return `<section class="card" data-issued-reports><h2>받은 월간 리포트</h2><p class="muted">관리자가 발행하고 내 계정에 배정한 고정본입니다.</p><div data-issued-content aria-live="polite">${enabled ? '배정된 발행본을 확인하고 있습니다.' : '월간 발행본 제공 연결을 준비 중입니다.'}</div></section>`;
  }
  function listView(reports) {
    if (!reports.length) return '<p class="empty-note">아직 배정된 월간 발행본이 없습니다.</p>';
    return reports.map(report => `<article class="connected-row"><span class="status-pill">월간 발행본 · v${esc(report.version)}</span><h3>${esc(report.title)}</h3><p>${esc(report.month)} · 발행 ${esc(report.publishedAt)}</p><button type="button" class="button" data-issued-id="${esc(idFor(report))}">발행본 열기</button></article>`).join('');
  }
  function detailView(report) {
    const snapshot = report.snapshot || {}, summary = report.summary || snapshot.summary || {};
    const lodging = summary.lodging || {}, plan = snapshot.actionPlan;
    const evidence = new Map((snapshot.actionEvidence || []).map(row => [row.id, row.label]));
    return `<button type="button" class="text-link" data-issued-back>발행본 목록으로</button><h3>${esc(report.title)}</h3><p>${esc(report.month)} · 발행 버전 ${esc(report.version)} · 관측 마감 ${esc(report.cutoffDate || snapshot.period?.cutoffDate || snapshot.request?.cutoffDate || '미확인')}</p>
      <p class="muted">공개 자료에서 확인한 관측과 추정입니다. 발행 시점의 수치와 검토 내용을 담았습니다.</p>
      <dl class="form-grid"><div><dt>공개 예약</dt><dd>${number(lodging.publicBookings)} 실·박</dd></div><div><dt>방막기 추정</dt><dd>${number(lodging.phoneBookings)} 실·박</dd></div><div><dt>숙박 추정매출</dt><dd>${number(lodging.estimatedRevenue)} 원</dd></div><div><dt>관측 업체·숙박일</dt><dd>${number(lodging.coveredCompanyDays)} / ${number(lodging.expectedCompanyDays)}</dd></div></dl>
      ${plan ? `<section><h3>검토한 실행 계획</h3><p>${esc(plan.summary)}</p>${(plan.items || []).map(item => `<article class="connected-row"><h4>${esc(item.title)}</h4><p>담당 ${esc(item.owner || '미지정')} · 기한 ${esc(item.dueDate || '미지정')} · ${esc(states[item.status] || '확인 필요')}</p><p>연결 근거 · ${(item.evidenceRefs || []).map(id => esc(evidence.get(id) || '저장 근거 확인 필요')).join(', ') || '연결 근거 없음'}</p><p>${esc(item.outcome || '실행 결과 기록 없음')}</p><small class="muted">실행 결과는 작성자 기록입니다.</small></article>`).join('')}</section>` : '<p class="muted">저장된 실행 계획이 없습니다.</p>'}
      <button type="button" class="button primary" data-issued-pdf="${esc(idFor(report))}">발행 PDF 다운로드</button><p data-issued-download-status class="muted" role="status"></p>`;
  }
  function stop() {
    if (!active) return;
    active.controller.abort();
    active.slot.onclick = null;
    active = null;
  }
  function mount(api, enabled, { onSessionExpired } = {}) {
    stop();
    const slot = document.querySelector('[data-issued-content]');
    if (!slot || !enabled) return;
    const controller = new AbortController();
    active = { slot, controller };
    let reports = [], sequence = 0;
    const current = request => !controller.signal.aborted && slot.isConnected && request === sequence;
    const read = (path, options) => api(path, undefined, { signal:controller.signal, ...options });
    function showError(request, error) {
      if (!current(request)) return;
      if (error.status === 401) onSessionExpired?.();
      if (!current(request)) return;
      slot.innerHTML = `<p class="empty-note" role="alert">${esc(error.message || '발행본을 확인하지 못했습니다.')}</p><button type="button" class="button" data-issued-retry>다시 확인</button>`;
    }
    async function load() {
      const request = ++sequence;
      slot.innerHTML = '<p role="status">배정된 발행본을 확인하고 있습니다.</p>';
      try {
        const data = await read('/reports');
        if (!current(request)) return;
        if (!Array.isArray(data.reports) || !data.reports.every(report => validId(idFor(report)))) throw new Error('발행본 목록을 확인하지 못했습니다.');
        reports = data.reports;
        slot.innerHTML = listView(reports);
      } catch (error) { showError(request, error); }
    }
    async function open(id) {
      const request = ++sequence;
      slot.innerHTML = '<p role="status">발행본을 열고 있습니다.</p>';
      try {
        const data = await read('/reports/' + encodeURIComponent(id)), report = data.report || data;
        if (!current(request)) return;
        if (idFor(report) !== id || !report.snapshot) throw new Error('선택한 발행본을 확인하지 못했습니다.');
        slot.innerHTML = detailView(report);
      } catch (error) { showError(request, error); }
    }
    async function download(button, id) {
      const request = sequence;
      const status = slot.querySelector('[data-issued-download-status]');
      button.disabled = true;
      if (status) status.textContent = '발행 PDF를 준비하고 있습니다.';
      try {
        const { blob, filename } = await read('/reports/' + encodeURIComponent(id) + '/pdf', { pdf:true });
        if (!current(request)) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        try { link.click(); }
        finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
        if (status) status.textContent = '발행 PDF 다운로드를 시작했습니다.';
      } catch (error) {
        if (!current(request)) return;
        if (error.status === 401) onSessionExpired?.();
        if (current(request) && status) status.textContent = error.message || '발행 PDF를 확인하지 못했습니다.';
      } finally { if (current(request)) button.disabled = false; }
    }
    slot.onclick = event => {
      const report = event.target.closest('[data-issued-id]');
      const pdf = event.target.closest('[data-issued-pdf]');
      if (report && validId(report.dataset.issuedId)) void open(report.dataset.issuedId);
      else if (pdf && !pdf.disabled && validId(pdf.dataset.issuedPdf)) void download(pdf, pdf.dataset.issuedPdf);
      else if (event.target.closest('[data-issued-back]')) { sequence++; slot.innerHTML = listView(reports); }
      else if (event.target.closest('[data-issued-retry]')) void load();
    };
    void load();
  }
  const reports = { panel, detailView, mount, stop };
  if (typeof window !== 'undefined') window.InsightReports = reports;
  if (typeof module !== 'undefined' && module.exports) module.exports = reports;
})();
