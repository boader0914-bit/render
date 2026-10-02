'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { body, json } = require('./insight_http.cjs');
const { fields, fault } = require('./insight_store.cjs');
function createInsightAdminProvisioning({ adminStore, requireAdmin }) {
  const assets = {
    '/insight-admin-accounts': ['admin-setup.html', 'text/html'],
    '/insight-admin-accounts.js': ['admin-setup.js', 'text/javascript'],
    '/insight-admin-accounts.css': ['admin.css', 'text/css']
  };
  return async (req, res, url, session) => {
    if (!assets[url.pathname] && url.pathname !== '/api/admin/insight-admin-accounts') return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (assets[url.pathname] && req.method === 'GET') {
        const [file, type] = assets[url.pathname];
        const content = await fs.readFile(path.join(__dirname, '../../customer-portal/web', file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" }); res.end(content); return true;
      }
      if (req.method === 'GET') { json(res, 200, { accounts: adminStore.list() }); return true; }
      if (req.method !== 'POST' || assets[url.pathname]) throw fault('NOT_FOUND', '지원하지 않는 요청입니다.', 404);
      let origin; try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || origin.host !== req.headers.host) throw fault('ORIGIN_REQUIRED', '현재 데이터랩 관리자 화면에서 설정해 주세요.', 403);
      const p = await body(req); const actor = session.memberId || session.username;
      if (p.action === 'reserve') { fields(p, ['action', 'username']); adminStore.reserve(p.username, actor); }
      else if (p.action === 'activate') { fields(p, ['action', 'adminId', 'password', 'passwordConfirm']); await adminStore.activate(p.adminId, p.password, p.passwordConfirm, actor); }
      else if (p.action === 'disable') { fields(p, ['action', 'adminId']); adminStore.disable(p.adminId, actor); }
      else throw fault('INVALID_ACTION', '지원하지 않는 요청입니다.');
      json(res, 200, { accounts: adminStore.list() });
    } catch (e) { json(res, e.statusCode || 503, { error: { code: e.statusCode ? e.code : 'SERVICE_UNAVAILABLE', message: e.statusCode ? e.message : '계정 설정을 완료하지 못했습니다.' } }); }
    return true;
  };
}
module.exports = { createInsightAdminProvisioning };
