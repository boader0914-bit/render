'use strict';
const crypto = require('node:crypto');
const { fault, fields, hash, active } = require('./insight_store.cjs');
const csrf = token => crypto.createHmac('sha256', token).update('insight-csrf-v1').digest('base64url');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a || '')), Buffer.from(hash(b || '')));
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fault('JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw fault('BODY_TOO_LARGE', '입력 내용이 너무 큽니다.', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('INVALID_JSON', '입력 내용을 확인해 주세요.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_JSON', '객체 형식으로 요청해 주세요.');
  return value;
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function createInsightHttp({ store, serviceToken, authenticateMember, memberActive, registerMember, catalog, requireAdmin, preparationBridge = null,
  signup = { enabled: false } }) {
  if (typeof serviceToken !== 'string' || serviceToken.length < 32) throw new Error('Insight service credential must contain at least 32 characters');
  async function state(customer) {
    if (preparationBridge) await preparationBridge.refresh(customer.customerId);
    const data = await catalog();
    const allowed = new Set(customer.relations.filter(active).map(row => row.companyId));
    const companies = data.companies.filter(row => allowed.has(row.companyId));
    const regionKeys = new Set(customer.regions.filter(active).map(row => row.regionKey));
    const own = customer.relations.find(row => row.kind === 'own' && row.status === 'active');
    if (own) regionKeys.add(companies.find(row => row.companyId === own.companyId)?.regionKey);
    return { customer, companies, regions: data.regions.filter(row => regionKeys.has(row.id)), corrections: store.corrections(customer.customerId),
      preparations: store.requests(customer.customerId), features: { weeklyReports: false, reportDelivery: false, directCollection: false, dataPreparationRequests: true } };
  }
  const policyUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
  const signupReady = signup.enabled === true && registerMember && signup.termsVersion && signup.privacyVersion && policyUrl(signup.termsUrl) && policyUrl(signup.privacyUrl);
  async function internal(req, res, url) {
    const base = '/api/insight/v1';
    if (!url.pathname.startsWith(base + '/')) return false;
    try {
      if (!equal(req.headers.authorization, `Bearer ${serviceToken}`)) throw fault('SERVICE_UNAUTHORIZED', '서비스 연결 인증이 필요합니다.', 401);
      const tail = url.pathname.slice(base.length);
      if (!['GET', 'POST'].includes(req.method)) throw fault('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405);
      if (tail === '/config' && req.method === 'GET') { json(res, 200, { signupEnabled: Boolean(signupReady), termsVersion: signup.termsVersion || null, privacyVersion: signup.privacyVersion || null, termsUrl: signup.termsUrl || null, privacyUrl: signup.privacyUrl || null }); return true; }
      if ((tail === '/auth/login' || tail === '/auth/signup') && req.method === 'POST') {
        const p = await body(req);
        fields(p, ['username', 'password', 'passwordConfirm', 'phone', 'email', 'agreeTerms', 'agreePrivacy', 'confirmAge', 'termsVersion', 'privacyVersion']);
        if (typeof p.username !== 'string' || p.username.length > 120 || typeof p.password !== 'string' || p.password.length > 256) throw fault('INVALID_LOGIN', '아이디와 비밀번호를 확인해 주세요.');
        store.throttle(`auth:${p.username.trim().toLowerCase()}`, 10);
        store.throttle('auth-service-total', 100);
        let member;
        if (tail === '/auth/signup') {
          if (!signupReady) throw fault('SIGNUP_NOT_READY', '회원가입 준비 중입니다. 관리자에게 문의해 주세요.', 503);
          if (p.termsVersion !== signup.termsVersion || p.privacyVersion !== signup.privacyVersion || p.agreeTerms !== true || p.agreePrivacy !== true || p.confirmAge !== true) throw fault('CONSENT_REQUIRED', '최신 약관과 개인정보 안내를 확인해 주세요.');
          member = await registerMember(p);
        } else member = await authenticateMember(p.username, p.password);
        if (!member || member.role !== 'b2b' || !member.memberId || member.status === 'disabled') throw fault('INVALID_LOGIN', '아이디 또는 비밀번호가 올바르지 않습니다.', 401);
        let c = store.ensure(member);
        if (tail === '/auth/signup') c = store.recordConsent(c.customerId, { termsVersion: signup.termsVersion, privacyVersion: signup.privacyVersion, termsUrl: signup.termsUrl, privacyUrl: signup.privacyUrl, ageConfirmed: true });
        if (c.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '이용이 중지된 계정입니다.', 403);
        const token = store.session(c.customerId);
        json(res, 200, { token, csrfToken: csrf(token), ...(await state(c)) }); return true;
      }
      const token = req.headers['x-insight-session'];
      const c = store.authenticate(token);
      if (!await memberActive(c.memberId)) { store.logout(token); throw fault('ACCOUNT_DISABLED', '이용자 계정이 중지되었습니다.', 403); }
      if (req.method === 'POST' && !equal(req.headers['x-csrf-token'], csrf(token))) throw fault('CSRF_INVALID', '화면을 새로 열고 다시 요청해 주세요.', 403);
      if (req.method === 'GET' && tail === '/me') json(res, 200, { ...(await state(c)), csrfToken: csrf(token) });
      else if (req.method === 'POST' && tail === '/auth/logout') { store.logout(token); json(res, 200, { ok: true }); }
      else if (req.method === 'GET' && ['/catalog/companies', '/catalog/regions'].includes(tail)) {
        const query = (url.searchParams.get('q') || '').normalize('NFKC').trim().toLowerCase();
        if (query.length < 2 || query.length > 120) throw fault('SEARCH_QUERY', '두 글자 이상으로 검색해 주세요.');
        const data = await catalog();
        const rows = tail.endsWith('/companies') ? data.companies : data.regions.filter(row => row.level === 'local');
        const results = rows.filter(row => [row.name, row.address, row.label, ...(row.placeIds || [])].filter(Boolean).join(' ').toLowerCase().includes(query)).sort((a,b) => String(a.name || a.label).localeCompare(String(b.name || b.label), 'ko')).slice(0, 30);
        // Registration candidates intentionally contain no private notes, analysis or raw observations.
        json(res, 200, { results: results.map(row => tail.endsWith('/companies') ? { companyId: row.companyId, name: row.name, address: row.address, placeIds: row.placeIds, regionLabel: row.regionLabel } : row) });
      } else if (req.method === 'POST' && tail === '/commands') {
        store.throttle(`changes:${c.customerId}`, 120);
        const command = await body(req); const data = await catalog();
        const company = data.companies.find(row => row.companyId === command.payload?.companyId);
        let result;
        if (['correction', 'withdraw-correction'].includes(command.action)) result = store.correct(c.customerId, command, company);
        else if (command.action === 'prepare-data') result = store.preparation(c.customerId, command, company);
        else result = store.update(c.customerId, command, data);
        json(res, 200, { ...(await state(result)), csrfToken: csrf(token) });
      } else throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
    } catch (error) { const safe = Number.isInteger(error.statusCode) && error.statusCode < 500; json(res, safe ? error.statusCode : 503, { error: { code: safe ? error.code || 'REQUEST_FAILED' : 'SERVICE_UNAVAILABLE', message: safe ? error.message : '자료 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' } }); }
    return true;
  }
  async function admin(req, res, url, session) {
    const base = '/api/admin/insight-customers';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      const tail = url.pathname.slice(base.length).split('/').filter(Boolean);
      if (req.method === 'GET' && !tail.length) { json(res, 200, { customers: store.list().map(c => ({ customerId: c.customerId, memberId: c.memberId, username: c.username, accountStatus: c.accountStatus, businessStatus: c.businessStatus, relations: c.relations.filter(active), entitlements: c.entitlements, revision: c.revision })) }); return true; }
      if (req.method === 'GET' && tail.length === 1) { const c = store.get(tail[0]); json(res, 200, { ...(await state(c)), history: store.history(c.customerId) }); return true; }
      if (req.method !== 'POST' || tail.length !== 2) throw fault('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405);
      let origin; try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || origin.host !== req.headers.host) throw fault('ORIGIN_REQUIRED', '현재 데이터랩 화면에서 요청해 주세요.', 403);
      const p = await body(req); const actor = session.memberId || session.username;
      if (tail[1] === 'commands') store.adminUpdate(tail[0], p, actor, await catalog());
      else if (tail[1] === 'preparation-dispatch' && preparationBridge) await preparationBridge.dispatch(tail[0],p,actor);
      else if (tail[1] === 'correction-review') {
        fields(p, ['requestId', 'decision', 'reason']);
        const correction = store.corrections(tail[0]).find(row => row.requestId === p.requestId);
        if (!correction) throw fault('NOT_FOUND', '검수 요청을 찾을 수 없습니다.', 404);
        const company = (await catalog()).companies.find(row => row.companyId === correction.companyId);
        store.reviewCorrection(p.requestId, p.decision, p.reason, actor, company);
      } else throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
      json(res, 200, await state(store.get(tail[0])));
    } catch (error) { json(res, error.statusCode || 503, { error: { code: error.code || 'SERVICE_UNAVAILABLE', message: error.statusCode ? error.message : '고객 자료 처리 상태를 확인해 주세요.' } }); }
    return true;
  }
  return { internal, admin };
}
module.exports = { createInsightHttp, body, json, csrf, equal };
