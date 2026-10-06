'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../web/connected.js'), 'utf8');

async function customerScreen(adminView, setup) {
  const companies = ['first', 'second', 'third'].map((id, index) => ({
    companyId: `cmp_${id}`, name: `경쟁업체 ${index + 1}`, address: '검수 지역',
    rooms: 10 + index, roomCountSource: 'DB 검토값', dayUse: 'unknown', facilities: '',
  }));
  const state = {
    customer: { username: 'review', settings: {}, regions: [], entitlements: { competitorLimit: 3 },
      relations: companies.map((c, i) => ({ companyId: c.companyId, relationId: `rel_${i}`, kind: 'competitor', status: i === 1 ? 'pending' : 'active' })) },
    companies, corrections: [], preparations: [], features: { directCollection: true },
  };
  if(setup)setup(state);
  const elements = new Map(), events = {}, documentEvents = {}, calls = [], mounted = [], opened = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', dataset:{}, classList: { toggle() {} }, focus() {} });
    return elements.get(selector);
  };
  const location = { pathname: adminView ? '/customer-view' : '/', hash: '#competitors' };
  const window = { addEventListener(name, callback) { events[name] = callback; }, scrollTo() {},
    InsightCollection: { panel(company,enabled,request,quota,openCollection) { opened.push({companyId:company.companyId,openCollection}); return `<h1>${company.name} 자료 수집</h1>`; }, mount(id) { mounted.push(id); } } };
  const context = vm.createContext({ location, window,
    document: { querySelector: element, body: element('body'), documentElement: { dataset: {} }, addEventListener(name,handler) { documentEvents[name]=handler; } },
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
  return { html: () => element('#main').innerHTML, companies, state, mounted, opened, calls,
    select(id) { documentEvents.change({target:{matches:selector=>selector==='[data-own-company]',value:id}}); },
    navigate(hash) { location.hash = hash; events.hashchange(); } };
}

for (const adminView of [false,true]) {
  test(`${adminView?'administrator':'customer'} own-store menu reads the linked DB immediately and keeps collection separate`, async () => {
    const ui=await customerScreen(adminView,state=>{
      state.customer.relations=[{kind:'own',status:'pending',companyId:'cmp_first',relationId:'own_1'}];
      state.registrationAllowance={ownLimit:1};
    });
    ui.navigate('#property');
    assert.equal(ui.mounted.at(-1),'cmp_first');
    assert.equal(ui.opened.at(-1).openCollection,false,'opening my store must not open a new collection form');
    assert.match(ui.html(),/경쟁업체 1 자료 수집/);
    assert.match(ui.html(),/매장 연결 확인 대기/);
    assert.doesNotMatch(ui.html(),/업체 자료 보기|내 매장 등록|data-own-company/);
    assert.match(ui.html(),/업체 정보 수정 · 등록 관리/);
    assert.equal(ui.state.customer.relations[0].status,'pending','reading does not approve the ownership relation');
    assert.ok(ui.calls.every(call=>call.method==='GET'||call.url.endsWith('/customer-view/start')));
  });
}

test('multiple own stores retain the selected company across navigation and ignore foreign IDs', async () => {
  const ui=await customerScreen(true,state=>{
    state.customer.relations[0].kind='own';state.customer.relations[1].kind='own';
    state.registrationAllowance={ownLimit:null};
  });
  ui.navigate('#property');assert.equal(ui.mounted.at(-1),'cmp_first');
  assert.match(ui.html(),/내 매장 선택/);assert.match(ui.html(),/내 매장 추가 등록/);
  ui.select('cmp_second');assert.equal(ui.mounted.at(-1),'cmp_second');
  ui.select('cmp_third');assert.equal(ui.mounted.at(-1),'cmp_second');
  ui.navigate('#settings');ui.navigate('#property');assert.equal(ui.mounted.at(-1),'cmp_second');
  ui.state.customer.relations[1].status='archived';ui.navigate('#property');assert.equal(ui.mounted.at(-1),'cmp_first');
  ui.navigate('#company=cmp_first');ui.navigate('#property');assert.equal(ui.mounted.at(-1),'cmp_first');
});

test('no own store shows registration and unavailable company links remain explicit without collection reads', async () => {
  const ui=await customerScreen(false);
  ui.navigate('#property');assert.match(ui.html(),/내 매장 등록/);assert.equal(ui.mounted.length,0);
  ui.state.customer.relations.push({kind:'own',status:'active',companyId:'not_available',relationId:'missing'});
  ui.navigate('#property');assert.match(ui.html(),/업체 연결 확인 필요/);assert.equal(ui.mounted.length,0);
});

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
