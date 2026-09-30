'use strict';

const { randomBytes } = require('node:crypto');
const { createPreviewStore, PreviewError } = require('./preview-store.cjs');
const COOKIE = '__Host-insight-preview';

// Only fictional preview data lives here. This is not a customer authentication store.
function createPreviewSessions({ maxSessions = 200, ttlMs = 2 * 60 * 60 * 1000, now = Date.now } = {}) {
  const sessions = new Map();
  return {
    resolve(req, res, create = false) {
      const time = now();
      for (const [key, entry] of sessions) if (time - entry.lastSeen >= ttlMs) sessions.delete(key);
      const token = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const entry = /^[a-f0-9]{64}$/.test(token || '') ? sessions.get(token) : null;
      if (entry) { entry.lastSeen = time; return entry.store; }
      if (!create) throw new PreviewError('preview_expired', '예시 설정이 초기화되었습니다. 화면을 새로고침해 주세요.', 409);
      if (sessions.size >= maxSessions) throw new PreviewError('preview_busy', '현재 검수 접속이 많습니다. 잠시 후 다시 접속해 주세요.', 503);
      const id = randomBytes(32).toString('hex');
      const store = createPreviewStore();
      sessions.set(id, { store, lastSeen: time });
      res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`);
      return store;
    },
  };
}

module.exports = { createPreviewSessions };
