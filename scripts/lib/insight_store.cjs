'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const clone = value => JSON.parse(JSON.stringify(value));
function fault(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function text(value, max = 200) {
  if (typeof value !== 'string' || value.length > max) throw fault('INVALID_INPUT', '입력 형식과 길이를 확인해 주세요.');
  return value.trim();
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('INVALID_FIELDS', '허용하지 않은 입력 항목입니다.');
}
const active = row => ['active', 'pending'].includes(row.status);
function createInsightStore({ file, now = () => Date.now() }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw fault('SCHEMA_NEWER', '고객 저장소 버전에 맞는 서버가 필요합니다.', 503); }
  db.exec(`CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, member_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(customer_id TEXT NOT NULL REFERENCES customers(id), command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(customer_id,command_id));
    CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), company_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preparations(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), company_id TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(customer_id,request_key));
    CREATE TABLE IF NOT EXISTS preparation_jobs(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  const stamp = () => new Date(now()).toISOString();
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function audit(customerId, actor, action, data) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id('audit'), customerId, stamp(), actor, action, JSON.stringify(data)); }
  function get(customerId) {
    const row = db.prepare('SELECT data FROM customers WHERE id=?').get(customerId);
    if (!row) throw fault('NOT_FOUND', '이용자를 찾을 수 없습니다.', 404);
    return JSON.parse(row.data);
  }
  function findMember(memberId) {
    const row = db.prepare('SELECT data FROM customers WHERE member_id=?').get(memberId);
    return row ? JSON.parse(row.data) : null;
  }
  function put(customer) { db.prepare('UPDATE customers SET revision=?,data=? WHERE id=?').run(customer.revision, JSON.stringify(customer), customer.customerId); }
  function ensure(member) {
    if (!member?.memberId || member.role !== 'b2b' || member.status === 'disabled') throw fault('CUSTOMER_REQUIRED', '활성 이용자 계정으로 로그인해 주세요.', 403);
    return transaction(() => {
      const old = db.prepare('SELECT id FROM customers WHERE member_id=?').get(member.memberId);
      if (old) return get(old.id);
      const customer = { schemaVersion: 1, customerId: id('cus'), memberId: member.memberId, username: member.username,
        accountKind: member.accountKind === 'admin_preview' ? 'admin_preview' : 'customer',
        revision: 1, accountStatus: 'active', businessStatus: 'planning', projectName: '', relations: [], regions: [],
        entitlements: { competitorLimit: 3, interestRegionLimit: 1 }, settings: {}, createdAt: stamp() };
      db.prepare('INSERT INTO customers VALUES(?,?,?,?)').run(customer.customerId, customer.memberId, customer.revision, JSON.stringify(customer));
      audit(customer.customerId, member.memberId, 'customer-created', { memberId: member.memberId });
      return customer;
    });
  }
  function session(customerId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), customerId, now() + 12 * 3600000);
    return token;
  }
  function authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fault('LOGIN_REQUIRED', '다시 로그인해 주세요.', 401);
    const row = db.prepare('SELECT customer_id FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), now());
    if (!row) throw fault('LOGIN_REQUIRED', '다시 로그인해 주세요.', 401);
    const customer = get(row.customer_id);
    if (customer.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '이용이 중지된 계정입니다.', 403);
    return customer;
  }
  function throttle(key, max = 10) {
    transaction(() => {
      db.prepare('DELETE FROM attempts WHERE until_at<=?').run(now());
      const old = db.prepare('SELECT * FROM attempts WHERE key=?').get(hash(key));
      if (old?.count >= max) throw fault('RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
      db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=attempts.count+1').run(hash(key), 1, now() + 15 * 60000);
    });
  }
  function mutate(customerId, command, actor, apply) {
    fields(command, ['revision', 'requestKey', 'action', 'payload']);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(command.requestKey || '')) throw fault('REQUEST_KEY_REQUIRED', '저장 요청 번호가 필요합니다.');
    const fingerprint = hash(JSON.stringify({ action: command.action, payload: command.payload }));
    return transaction(() => {
      const customer = get(customerId);
      if (actor === customerId && customer.accountStatus !== 'active') throw fault('ACCOUNT_DISABLED', '이용이 중지된 계정입니다.', 403);
      const previous = db.prepare('SELECT fingerprint FROM commands WHERE customer_id=? AND command_id=?').get(customerId, command.requestKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fault('REQUEST_CONFLICT', '같은 요청 번호의 내용이 다릅니다.', 409);
        return customer;
      }
      if (!Number.isSafeInteger(command.revision) || customer.revision !== command.revision) throw fault('STALE_REVISION', '다른 화면에서 변경되었습니다. 최신 내용을 확인해 주세요.', 409);
      const before = clone(customer);
      apply(customer, command.payload || {});
      customer.revision++; customer.updatedAt = stamp(); put(customer);
      db.prepare('INSERT INTO commands VALUES(?,?,?)').run(customerId, command.requestKey, fingerprint);
      audit(customerId, actor, command.action, { before, after: customer });
      return customer;
    });
  }
  function hasCompany(customer, companyId, verified = false) {
    return customer.relations.some(row => row.companyId === companyId && active(row) && (!verified || row.kind === 'competitor' || row.status === 'active'));
  }
  function update(customerId, command, catalog) {
    const companies = new Map(catalog.companies.map(row => [row.companyId, row]));
    const regions = new Map(catalog.regions.map(row => [row.id, row]));
    return mutate(customerId, command, customerId, (c, p) => {
      if (command.action === 'onboarding') {
        fields(p, ['businessStatus', 'projectName']);
        if (!['owned', 'planning'].includes(p.businessStatus)) throw fault('INVALID_INPUT', '사업 상태를 선택해 주세요.');
        if (p.businessStatus === 'planning' && c.relations.some(row => row.kind === 'own' && active(row))) throw fault('OWN_PROPERTY_EXISTS', '내 매장 연결을 먼저 해제해 주세요.', 409);
        c.businessStatus = p.businessStatus; c.projectName = text(p.projectName || '', 100);
      } else if (command.action === 'add-company') {
        fields(p, ['kind', 'companyId']);
        if (!['own', 'competitor'].includes(p.kind) || !companies.has(p.companyId)) throw fault('INVALID_COMPANY', '등록할 업체를 다시 선택해 주세요.');
        if (c.relations.some(row => row.companyId === p.companyId && active(row))) throw fault('DUPLICATE_COMPANY', '이미 등록한 업체입니다.', 409);
        if (p.kind === 'own' && c.relations.some(row => row.kind === 'own' && active(row))) throw fault('OWN_LIMIT', '내 매장은 1곳까지 등록할 수 있습니다.', 409);
        if (p.kind === 'competitor' && c.relations.filter(row => row.kind === 'competitor' && active(row)).length >= c.entitlements.competitorLimit) throw fault('COMPETITOR_LIMIT', '경쟁업체 등록 한도에 도달했습니다.', 409);
        c.relations.push({ relationId: id('rel'), companyId: p.companyId, kind: p.kind, status: p.kind === 'own' ? 'pending' : 'active', createdAt: stamp() });
        if (p.kind === 'own') c.businessStatus = 'owned';
      } else if (command.action === 'archive-company') {
        fields(p, ['relationId']); const row = c.relations.find(row => row.relationId === p.relationId && active(row));
        if (!row) throw fault('NOT_FOUND', '등록 관계를 찾을 수 없습니다.', 404);
        row.status = 'archived'; row.archivedAt = stamp();
      } else if (command.action === 'add-region') {
        fields(p, ['regionKey']);
        if (!regions.has(p.regionKey) || regions.get(p.regionKey).level !== 'local') throw fault('INVALID_REGION', '시군구 지역을 선택해 주세요.');
        const own = c.relations.find(row => row.kind === 'own' && row.status === 'active');
        if (c.regions.some(row => row.regionKey === p.regionKey && active(row)) || (own && companies.get(own.companyId)?.regionKey === p.regionKey)) throw fault('DUPLICATE_REGION', '이미 제공되는 지역입니다.', 409);
        if (c.regions.filter(active).length >= c.entitlements.interestRegionLimit) throw fault('REGION_LIMIT', '관심지역 등록 한도에 도달했습니다.', 409);
        c.regions.push({ relationId: id('region'), regionKey: p.regionKey, status: 'active', createdAt: stamp() });
      } else if (command.action === 'archive-region') {
        fields(p, ['relationId']); const row = c.regions.find(row => row.relationId === p.relationId && active(row));
        if (!row) throw fault('NOT_FOUND', '등록 지역을 찾을 수 없습니다.', 404);
        row.status = 'archived'; row.archivedAt = stamp();
      } else if (command.action === 'settings') {
        fields(p, ['companyId', 'nickname', 'note']);
        if (!hasCompany(c, p.companyId)) throw fault('NOT_FOUND', '등록 업체를 찾을 수 없습니다.', 404);
        c.settings[p.companyId] = { nickname: text(p.nickname || '', 80), note: text(p.note || '', 1000), updatedAt: stamp() };
      } else throw fault('UNKNOWN_ACTION', '지원하지 않는 변경입니다.');
    });
  }
  function adminUpdate(customerId, command, actor, catalog = { companies: [] }) {
    return mutate(customerId, command, actor, (c, p) => {
      if (command.action === 'entitlements') {
        fields(p, ['competitorLimit', 'interestRegionLimit', 'keepCompetitorRelationIds', 'keepInterestRegionRelationIds', 'reason']);
        if (!text(p.reason || '', 500)) throw fault('REASON_REQUIRED', '변경 사유를 입력해 주세요.');
        for (const [field, rows, keepField] of [['competitorLimit', c.relations.filter(row => row.kind === 'competitor'), 'keepCompetitorRelationIds'], ['interestRegionLimit', c.regions, 'keepInterestRegionRelationIds']]) {
          const limit = p[field];
          if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw fault('INVALID_LIMIT', '등록 한도는 0~1000의 정수로 입력해 주세요.');
          const current = rows.filter(active);
          if (current.length > limit) {
            const keep = p[keepField];
            if (!Array.isArray(keep) || keep.length > limit || new Set(keep).size !== keep.length || keep.some(value => !current.some(row => row.relationId === value))) throw fault('KEEP_SELECTION_REQUIRED', '한도 축소 시 유지할 대상을 선택해 주세요.', 409);
            for (const row of current) if (!keep.includes(row.relationId)) { row.status = 'archived'; row.archivedAt = stamp(); }
          }
          c.entitlements[field] = limit;
        }
      } else if (command.action === 'property-review') {
        fields(p, ['relationId', 'decision', 'reason']);
        const row = c.relations.find(row => row.relationId === p.relationId && row.kind === 'own' && row.status === 'pending');
        if (!row) throw fault('NOT_FOUND', '확인 대기 중인 매장이 없습니다.', 404);
        if (!['approve', 'reject'].includes(p.decision) || !text(p.reason || '', 500)) throw fault('INVALID_REVIEW', '판정과 사유를 입력해 주세요.');
        row.status = p.decision === 'approve' ? 'active' : 'rejected'; row.reviewedAt = stamp(); row.reviewReason = p.reason;
        if (row.status === 'active') {
          const regionKey = catalog.companies.find(company => company.companyId === row.companyId)?.regionKey;
          for (const region of c.regions.filter(region => active(region) && region.regionKey === regionKey)) {
            region.status = 'archived'; region.archivedAt = stamp(); region.archiveReason = 'included-own-region';
          }
        }
      } else if (command.action === 'account-status') {
        fields(p, ['status', 'reason']);
        if (!['active', 'disabled'].includes(p.status) || !text(p.reason || '', 500)) throw fault('INVALID_STATUS', '계정 상태와 사유를 확인해 주세요.');
        c.accountStatus = p.status;
        if (p.status === 'disabled') db.prepare('DELETE FROM sessions WHERE customer_id=?').run(c.customerId);
      } else throw fault('UNKNOWN_ACTION', '지원하지 않는 관리자 변경입니다.');
    });
  }
  function corrections(customerId) {
    return db.prepare('SELECT data FROM corrections WHERE customer_id=? ORDER BY rowid DESC').all(customerId).map(row => JSON.parse(row.data));
  }
  function correct(customerId, command, company) {
    return mutate(customerId, command, customerId, (c, p) => {
      if (command.action === 'withdraw-correction') {
        fields(p, ['requestId']);
        const old = corrections(customerId).find(row => row.requestId === p.requestId && row.status === 'pending');
        if (!old) throw fault('NOT_FOUND', '철회할 요청을 찾지 못했습니다.', 404);
        old.status = 'withdrawn'; old.closedAt = stamp();
        db.prepare('UPDATE corrections SET status=?,data=? WHERE id=?').run(old.status, JSON.stringify(old), old.requestId);
        return;
      }
      fields(p, ['companyId', 'proposed', 'reason', 'baseVersion']);
      if (!company || company.companyId !== p.companyId || !hasCompany(c, p.companyId)) throw fault('NOT_FOUND', '등록 업체를 찾을 수 없습니다.', 404);
      if (company.version !== p.baseVersion) throw fault('STALE_COMPANY', '업체 기준이 변경되었습니다. 최신값을 확인해 주세요.', 409);
      fields(p.proposed, ['name', 'address', 'rooms', 'dayUse', 'facilities']);
      const proposed = {};
      for (const [key, value] of Object.entries(p.proposed)) {
        if (key === 'rooms') { if (!Number.isSafeInteger(value) || value < 1) throw fault('INVALID_ROOMS', '객실 수는 양의 정수로 입력해 주세요.'); proposed[key] = value; }
        else if (key === 'dayUse') { if (!['unknown', 'none', 'separate', 'shared'].includes(value)) throw fault('INVALID_DAY_USE', '데이유즈 구분을 확인해 주세요.'); proposed[key] = value; }
        else proposed[key] = text(value, key === 'facilities' ? 1000 : 200);
      }
      if (!Object.keys(proposed).length || !Object.entries(proposed).some(([key, value]) => company[key] !== value) || !text(p.reason || '', 1000)) throw fault('REASON_REQUIRED', '변경할 내용과 근거를 입력해 주세요.');
      const old = corrections(customerId).find(row => row.companyId === p.companyId && row.status === 'pending');
      if (old && old.baseVersion === company.version && old.reason === p.reason && Object.keys(old.proposed).length === Object.keys(proposed).length && Object.entries(proposed).every(([key,value]) => old.proposed[key] === value)) return;
      if (old) {
        old.status = 'superseded'; old.closedAt = stamp();
        db.prepare('UPDATE corrections SET status=?,data=? WHERE id=?').run(old.status, JSON.stringify(old), old.requestId);
      }
      const row = { requestId: id('cor'), customerId, companyId: p.companyId, status: 'pending', baseVersion: company.version,
        baseValues: company, proposed, reason: p.reason, submittedAt: stamp() };
      db.prepare('INSERT INTO corrections VALUES(?,?,?,?,?)').run(row.requestId, customerId, p.companyId, row.status, JSON.stringify(row));
    });
  }
  function reviewCorrection(requestId, decision, reason, actor, currentCompany) {
    return transaction(() => {
      const saved = db.prepare('SELECT data FROM corrections WHERE id=?').get(requestId);
      if (!saved) throw fault('NOT_FOUND', '검수 요청을 찾을 수 없습니다.', 404);
      const row = JSON.parse(saved.data);
      if (row.status !== 'pending') throw fault('REVIEW_CLOSED', '이미 처리한 검수 요청입니다.', 409);
      if (!['verified', 'rejected'].includes(decision) || !text(reason || '', 1000)) throw fault('INVALID_REVIEW', '처리 결과와 사유를 확인해 주세요.');
      // This endpoint certifies an existing central edit; it never guesses how to apply a historic correction.
      if (decision === 'verified' && (!currentCompany || currentCompany.companyId !== row.companyId || Object.entries(row.proposed).some(([key, value]) => currentCompany[key] !== value))) throw fault('CENTRAL_EDIT_REQUIRED', '업체 DB에서 제안값을 검수·반영한 뒤 확인해 주세요.', 409);
      row.status = decision; row.closedAt = stamp(); row.reviewMessage = reason;
      db.prepare('UPDATE corrections SET status=?,data=? WHERE id=?').run(row.status, JSON.stringify(row), requestId);
      audit(row.customerId, actor, 'correction-review', { requestId, decision, reason, companyVersion: currentCompany?.version });
      const c = get(row.customerId); c.revision++; put(c);
      return row;
    });
  }
  function preparation(customerId, command, company) {
    return mutate(customerId, command, customerId, (c, p) => {
      fields(p, ['companyId']);
      if (!company || !hasCompany(c, p.companyId)) throw fault('NOT_FOUND', '등록 업체를 찾을 수 없습니다.', 404);
      const day = new Date(now() + 9 * 3600000).toISOString().slice(0, 10);
      const existing = db.prepare('SELECT data FROM preparations WHERE customer_id=? AND company_id=?').all(customerId, p.companyId).map(row => JSON.parse(row.data)).find(row => row.observationDay === day);
      if (existing) return;
      const row = { requestId: id('prep'), companyId: p.companyId, customerId, observationDay: day, status: 'needs_review',
        submittedAt: stamp(), message: '요청을 접수했습니다. 관리자가 기존 자료와 준비 범위를 확인합니다.' };
      db.prepare('INSERT INTO preparations VALUES(?,?,?,?,?)').run(row.requestId, customerId, p.companyId, command.requestKey, JSON.stringify(row));
    });
  }
  function reservePreparation(customerId, requestId, company, scope, actor) {
    return transaction(() => {
      const found = db.prepare('SELECT data FROM preparations WHERE id=? AND customer_id=?').get(requestId, customerId);
      if (!found) throw fault('NOT_FOUND', '자료 준비 요청을 찾을 수 없습니다.', 404);
      const request = JSON.parse(found.data), customer = get(customerId);
      if (customer.accountStatus !== 'active' || !hasCompany(customer, request.companyId) || request.companyId !== company.companyId) throw fault('PREPARATION_SCOPE_CHANGED', '고객 이용 상태와 등록 관계를 확인해 주세요.', 409);
      if (request.observationDay !== new Date(now() + 9 * 3600000).toISOString().slice(0,10)) throw fault('PREPARATION_EXPIRED', '이전 날짜의 요청입니다. 새 자료 준비 요청이 필요합니다.', 409);
      if (request.jobId) {
        const job = JSON.parse(db.prepare('SELECT data FROM preparation_jobs WHERE id=?').get(request.jobId).data);
        if (JSON.stringify(job.scope) !== JSON.stringify(scope)) throw fault('PREPARATION_SCOPE_CONFLICT', '이미 접수된 작업의 기간은 변경할 수 없습니다.', 409);
        return { job, start: false };
      }
      const fingerprint = hash(JSON.stringify([company.companyId, request.observationDay, scope]));
      const existing = db.prepare('SELECT data FROM preparation_jobs WHERE fingerprint=?').get(fingerprint);
      const job = existing ? JSON.parse(existing.data) : { jobId: crypto.randomUUID(), companyId: company.companyId, observationDay: request.observationDay,
        scope, keyword: company.name, placeIds: company.placeIds, status: 'dispatching', createdAt: stamp(), updatedAt: stamp() };
      if (!existing) db.prepare('INSERT INTO preparation_jobs VALUES(?,?,?)').run(job.jobId, fingerprint, JSON.stringify(job));
      request.jobId = job.jobId; request.status = job.status; request.scope = scope; request.message = '자료 준비 작업의 접수 상태를 확인하고 있습니다.';
      db.prepare('UPDATE preparations SET data=? WHERE id=?').run(JSON.stringify(request), requestId);
      audit(customerId, actor, 'preparation-dispatch', { requestId, jobId: job.jobId, shared: Boolean(existing), scope });
      return { job, start: !existing };
    });
  }
  function updatePreparationJob(jobId, status, message, extra = {}) {
    return transaction(() => {
      const found = db.prepare('SELECT data FROM preparation_jobs WHERE id=?').get(jobId);
      if (!found) throw fault('NOT_FOUND', '자료 준비 작업을 찾을 수 없습니다.', 404);
      const job = { ...JSON.parse(found.data), status, message, ...extra, updatedAt: stamp() };
      db.prepare('UPDATE preparation_jobs SET data=? WHERE id=?').run(JSON.stringify(job), jobId);
      for (const row of db.prepare('SELECT id,data FROM preparations').all()) {
        const request = JSON.parse(row.data); if (request.jobId !== jobId) continue;
        Object.assign(request, { status, message, updatedAt: job.updatedAt, ...(job.runId ? { runId: job.runId } : {}) });
        db.prepare('UPDATE preparations SET data=? WHERE id=?').run(JSON.stringify(request), row.id);
      }
      return job;
    });
  }
  return { get, findMember, ensure, session, authenticate, throttle, update, adminUpdate, corrections, correct, reviewCorrection, preparation, hasCompany,
    reservePreparation, updatePreparationJob,
    preparationJobs: () => db.prepare('SELECT data FROM preparation_jobs').all().map(row => JSON.parse(row.data)),
    recordConsent: (customerId, consent) => transaction(() => { const c = get(customerId); c.insightConsent = { ...consent, acceptedAt: stamp() }; c.revision++; put(c); audit(customerId, customerId, 'insight-consent', c.insightConsent); return c; }),
    logout: token => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token || '')),
    list: () => db.prepare('SELECT data FROM customers ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)),
    requests: customerId => db.prepare('SELECT data FROM preparations WHERE customer_id=? ORDER BY rowid DESC').all(customerId).map(row => JSON.parse(row.data)),
    history: customerId => db.prepare('SELECT at,actor,action,data FROM audit WHERE customer_id=? ORDER BY rowid DESC').all(customerId).map(row => ({ ...row, data: JSON.parse(row.data) })),
    close: () => db.close() };
}
module.exports = { createInsightStore, fault, fields, hash, active };
