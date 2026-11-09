'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require.resolve('../web/reports.js'), 'utf8');
const metadata = { id:'mr_assigned', title:'검토 발행본 <title>', month:'2026-10', version:1, publishedAt:'2026-11-01' };
const detail = { ...metadata, snapshot:{ summary:{ lodging:{ publicBookings:0, phoneBookings:null, estimatedRevenue:125000 } },
  actionPlan:{ summary:'<검토> 결과', items:[{ title:'가격 자료 확인', evidenceRefs:['linked'], outcome:'작성자 기록' }] },
  actionEvidence:[{ id:'linked', label:'저장 수치 근거' }] } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const window = {}, calls = [], downloads = [], revoked = [];
  const status = { textContent:'' }, slot = { innerHTML:'', isConnected:true, onclick:null, querySelector:() => status };
  const document = { querySelector:selector => selector === '[data-issued-content]' ? slot : null, body:{ append(){} },
    createElement:() => ({ click(){ downloads.push({ href:this.href, filename:this.download }); }, remove(){} }) };
  const URL = { createObjectURL:() => 'blob:verified-report', revokeObjectURL:value => revoked.push(value) };
  vm.runInNewContext(script, { window, document, AbortController, URL, setTimeout:callback => callback() });
  const view = window.InsightReports;
  const request = (path, data, options) => new Promise((resolve,reject) => calls.push({ path, data, options, resolve, reject }));
  function click(selector, dataset = {}) {
    const button = { dataset, disabled:false };
    slot.onclick({ target:{ closest:value => selector === value ? button : null } });
    return button;
  }
  return { view, calls, downloads, revoked, status, slot, request, click };
}

test('received monthly report panel shows the assigned snapshot and downloads through the scoped request', async () => {
  const h = harness();
  assert.match(h.view.panel(false), /준비 중/);
  h.view.mount(h.request, false);
  assert.equal(h.calls.length, 0);
  h.view.mount(h.request, true);
  assert.equal(h.calls[0].path, '/reports');
  h.calls[0].resolve({ reports:[metadata] }); await flush();
  assert.match(h.slot.innerHTML, /검토 발행본 &lt;title&gt;/);
  h.click('[data-issued-id]', { issuedId:metadata.id });
  assert.equal(h.calls[1].path, '/reports/' + metadata.id);
  h.calls[1].resolve(detail); await flush();
  assert.match(h.slot.innerHTML, /0 실·박/);
  assert.match(h.slot.innerHTML, /미확인 실·박/);
  assert.match(h.slot.innerHTML, /125,000 원/);
  assert.match(h.slot.innerHTML, /저장 수치 근거/);
  const button = h.click('[data-issued-pdf]', { issuedPdf:metadata.id });
  assert.equal(button.disabled, true);
  assert.equal(h.calls[2].path, '/reports/' + metadata.id + '/pdf');
  assert.equal(h.calls[2].options.pdf, true);
  assert.ok(h.calls.every(call => call.data === undefined));
  h.calls[2].resolve({ blob:{}, filename:'monthly-report-2026-10-v1.pdf' }); await flush();
  assert.deepEqual(h.downloads, [{ href:'blob:verified-report', filename:'monthly-report-2026-10-v1.pdf' }]);
  assert.deepEqual(h.revoked, ['blob:verified-report']);
  assert.equal(button.disabled, false);
  h.click('[data-issued-back]');
  assert.match(h.slot.innerHTML, /발행본 열기/);
  assert.equal(h.calls.length, 3);
});

test('navigation cancels a pending report download and a current 401 expires the session', async () => {
  const h = harness();
  let expired = 0;
  const onSessionExpired = () => { expired++; h.view.stop(); };
  h.view.mount(h.request, true, { onSessionExpired });
  h.calls[0].resolve({ reports:[metadata] }); await flush();
  h.click('[data-issued-id]', { issuedId:metadata.id });
  h.calls[1].resolve(detail); await flush();
  h.click('[data-issued-pdf]', { issuedPdf:metadata.id });
  h.view.stop();
  assert.equal(h.calls[2].options.signal.aborted, true);
  h.calls[2].resolve({ blob:{}, filename:'discarded.pdf' }); await flush();
  assert.equal(h.downloads.length, 0);
  h.view.mount(h.request, true, { onSessionExpired });
  h.calls[3].reject(Object.assign(new Error('로그인 필요'), { status:401 })); await flush();
  assert.equal(expired, 1);
  assert.equal(h.slot.onclick, null);
});
