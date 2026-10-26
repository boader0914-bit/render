'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../web/connected.js'), 'utf8');
const collectionSource = fs.readFileSync(require.resolve('../web/collection.js'), 'utf8');
const loadingWindow = {};
vm.runInContext(collectionSource, vm.createContext({ window: loadingWindow, document: { addEventListener() {} } }));
const flush = () => new Promise(resolve => setImmediate(resolve));

async function registrationScreen({ adminView = false, kind = 'own' } = {}) {
  const company = { companyId: 'cmp_registration_fixture', name: '등록 검수 글램핑', address: '검수 지역', rooms: 16, roomCountSource: 'DB 검토값' };
  const initialState = {
    customer: { customerId: 'customer_fixture', username: 'review', revision: 1, settings: {}, regions: [], relations: [], entitlements: { competitorLimit: 3, interestRegionLimit: 1 } },
    companies: [company], corrections: [], preparations: [], features: { directCollection: true },
  };
  const registeredState = { ...initialState, customer: { ...initialState.customer, revision: 2,
    relations: [{ companyId: company.companyId, relationId: 'rel_fixture', kind, status: 'pending' }] } };
  const elements = new Map(), documentEvents = {}, windowEvents = {}, calls = [], pendingCommands = [], mounted = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', hidden: false,
      classList: { add() {}, remove() {}, toggle() {} }, focus() {} });
    return elements.get(selector);
  };
  let hash = kind === 'own' ? '#property' : '#settings';
  const location = { pathname: adminView ? '/customer-view' : '/', get hash() { return hash; }, set hash(value) { hash = value.startsWith('#') ? value : `#${value}`; } };
  const window = { addEventListener(name, callback) { windowEvents[name] = callback; }, scrollTo() {},
    InsightCollection: { stop() {}, setContext() {}, invalidate() {}, loading: loadingWindow.InsightCollection.loading,
      panel(row) { return `<h1>${row.name}</h1>`; }, mount(id) { mounted.push(id); } } };
  class FormDataFixture {
    constructor(form) { this.values = form.values; }
    *[Symbol.iterator]() { yield* Object.entries(this.values); }
  }
  const context = vm.createContext({ location, window,
    document: { querySelector(selector) {
      if (selector === '#company-registration-progress' && !element('#main').innerHTML.includes('id="company-registration-progress"')) return null;
      return element(selector);
    }, body: element('body'), documentElement: { dataset: {} }, addEventListener(name, callback) { documentEvents[name] = callback; } },
    localStorage: { getItem() { return null; } }, FormData: FormDataFixture, crypto: { randomUUID() { return 'fixture-request-key'; } },
    setTimeout() { return 1; },
    fetch(url, options) {
      const method = options?.method || 'GET';
      const data = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, method, data });
      const response = value => ({ ok: true, status: 200, json: async () => value });
      if (url.endsWith('/commands')) return new Promise(resolve => pendingCommands.push({ resolve, response }));
      if (url.includes('/catalog/companies?')) return Promise.resolve(response({ results: [company] }));
      if (url.endsWith('/config')) return Promise.resolve(response({}));
      if (url === '/api/insight-admin/v1/me') return Promise.resolve(response({ csrfToken: 'fixture' }));
      return Promise.resolve(response(initialState));
    },
  });
  vm.runInContext(source, context);
  await flush();
  const searchButton = { disabled: false };
  const searchForm = { id: 'search-form', dataset: { kind }, values: { q: company.name },
    querySelectorAll() { return [searchButton]; }, querySelector() { return null; } };
  await documentEvents.submit({ preventDefault() {}, target: searchForm });
  assert.match(element('#search-results').innerHTML, /data-action="add"/);
  const addButton = { disabled: false, dataset: { action: 'add', kind, id: company.companyId } };
  const click = () => documentEvents.click({ target: { closest() { return addButton; } } });
  return { company, location, calls, pendingCommands, mounted, addButton, click,
    html: () => element('#main').innerHTML,
    progress: () => element('#company-registration-progress').innerHTML,
    toast: () => element('#toast').textContent,
    succeed() { const pending = pendingCommands.at(-1); pending.resolve(pending.response(registeredState)); },
    fail(message) { pendingCommands.at(-1).resolve({ ok: false, status: 503, json: async () => ({ error: { message, code: 'REGISTRATION_FAILED' } }) }); },
    navigate() { windowEvents.hashchange(); },
  };
}

for (const adminView of [false, true]) {
  const name = adminView ? 'administrator customer view' : 'customer';
  test(`${name} shows a connecting animation until one company registration command finishes`, async () => {
    const ui = await registrationScreen({ adminView });
    assert.match(ui.html(), /id="company-registration-progress"/);
    const registration = ui.click();
    assert.match(ui.progress(), /role="status"/);
    assert.match(ui.progress(), /connection-spinner/);
    assert.match(ui.progress(), /업체 등록 · 자료 연결 중/);
    assert.equal(ui.addButton.disabled, true);
    await ui.click();
    assert.equal(ui.pendingCommands.length, 1, 'a second click while connecting must not register again');
    const command = ui.calls.find(call => call.url.endsWith('/commands'));
    assert.equal(command.data.action, 'add-company');
    assert.equal(command.data.payload.companyId, ui.company.companyId);
    assert.ok(ui.calls.every(call => !call.url.includes('/crawl') && call.data?.action !== 'collect'), 'registering must not start a crawler');
    ui.succeed();
    await registration;
    assert.equal(ui.progress(), '', 'finished registration clears the animation');
    assert.equal(ui.addButton.disabled, false);
    assert.equal(ui.location.hash, `#company=${ui.company.companyId}`);
    ui.navigate();
    assert.equal(ui.mounted.at(-1), ui.company.companyId, 'the hash change opens the registered company');
    assert.match(ui.html(), /등록 검수 글램핑/);
  });

  test(`${name} stops the connecting animation and reports a failed competitor registration`, async () => {
    const ui = await registrationScreen({ adminView, kind: 'competitor' });
    const registration = ui.click();
    assert.match(ui.progress(), /connection-spinner/);
    ui.fail('등록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    await registration;
    assert.equal(ui.progress(), '');
    assert.equal(ui.addButton.disabled, false);
    assert.equal(ui.location.hash, '#settings', 'a failed command stays in registration settings without opening an unregistered company');
    assert.equal(ui.mounted.length, 0);
    assert.match(ui.toast(), /등록을 저장하지 못했습니다/);
    assert.equal(ui.pendingCommands.length, 1);
  });
}
