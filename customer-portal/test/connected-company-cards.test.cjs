'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../web/connected.js'), 'utf8');

async function customerScreen(adminView) {
  const companies = ['first', 'second', 'third'].map((id, index) => ({
    companyId: `cmp_${id}`, name: `경쟁업체 ${index + 1}`, address: '검수 지역',
    rooms: 10 + index, roomCountSource: 'DB 검토값', dayUse: 'unknown', facilities: '',
  }));
  const state = {
    customer: { username: 'review', settings: {}, regions: [], entitlements: { competitorLimit: 3 },
      relations: companies.map((c, i) => ({ companyId: c.companyId, relationId: `rel_${i}`, kind: 'competitor', status: i === 1 ? 'pending' : 'active' })) },
    companies, corrections: [], preparations: [], features: { directCollection: true },
  };
  const elements = new Map(), events = {}, calls = [], mounted = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', classList: { toggle() {} }, focus() {} });
    return elements.get(selector);
  };
  const location = { pathname: adminView ? '/customer-view' : '/', hash: '#competitors' };
  const window = { addEventListener(name, callback) { events[name] = callback; }, scrollTo() {},
    InsightCollection: { panel(company) { return `<h1>${company.name} 자료 수집</h1>`; }, mount(id) { mounted.push(id); } } };
  const context = vm.createContext({ location, window,
    document: { querySelector: element, body: element('body'), documentElement: { dataset: {} }, addEventListener() {} },
    localStorage: { getItem() { return null; } },
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      const value = url === '/api/insight-admin/v1/me' ? { csrfToken: 'fixture' }
        : url.endsWith('/config') ? {} : state;
      return { ok: true, status: 200, json: async () => value };
    },
  });
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { html: () => element('#main').innerHTML, companies, mounted, calls,
    navigate(hash) { location.hash = hash; events.hashchange(); } };
}

for (const adminView of [false, true]) {
  test(`${adminView ? 'administrator customer view' : 'customer'} shows results links for every competitor and opens the selected company`, async () => {
    const ui = await customerScreen(adminView);
    const cards = [...ui.html().matchAll(/<article class="connected-row">([\s\S]*?)<\/article>/g)];
    assert.equal(cards.length, 3);
    for (const [index, company] of ui.companies.entries()) {
      assert.match(cards[index][1], new RegExp(`href="#company=${company.companyId}"`));
      assert.match(cards[index][1], /업체 자료 보기/);assert.match(cards[index][1],new RegExp(`href="#collect=${company.companyId}"`));
    }
    for (const company of ui.companies) {
      ui.navigate(`#company=${company.companyId}`);
      assert.match(ui.html(), new RegExp(`${company.name} 자료 수집`));
      assert.equal(ui.mounted.at(-1), company.companyId);
      assert.match(ui.html(), /href="#competitors"/);
      assert.doesNotMatch(ui.html(), /href="#company=/, 'result-page edit card must not link back to itself');
      ui.navigate('#competitors');
      assert.equal((ui.html().match(/업체 자료 보기/g) || []).length, 3);
    }
    assert.ok(ui.calls.every(call => call.method === 'GET' || call.url.endsWith('/customer-view/start')),
      'reading cards must not submit collection or edit commands');
  });
}
