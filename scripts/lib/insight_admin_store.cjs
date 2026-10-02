'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { fault, hash } = require('./insight_store.cjs');
const scrypt = promisify(crypto.scrypt);
const cleanName = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const publicAccount = row => ({ adminId: row.id, username: row.username, status: row.status, role: 'insight_admin', createdAt: row.created_at });
function createInsightAdminStore({ file, now = () => Date.now() }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, status TEXT NOT NULL, password_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);`);
  const stamp = () => new Date(now()).toISOString();
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  function audit(adminId, actor, action) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(crypto.randomUUID(), adminId, actor, action, stamp()); }
  function reserve(username, actor) {
    username = cleanName(username);
    if (!/^[a-z0-9._-]{4,60}$/.test(username)) throw fault('INVALID_USERNAME', '아이디는 영문·숫자·점·밑줄·하이픈 4~60자로 입력해 주세요.');
    return transaction(() => {
      const old = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
      if (old) return publicAccount(old);
      const id = `iad_${crypto.randomUUID()}`;
      db.prepare('INSERT INTO accounts VALUES(?,?,?,NULL,?)').run(id, username, 'pending', stamp());
      audit(id, actor, 'account-reserved');
      return publicAccount(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
    });
  }
  async function activate(adminId, password, confirm, actor) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 120 || !/[a-zA-Z]/.test(password) || !/\d/.test(password) || !/[^a-zA-Z0-9]/.test(password)) throw fault('PASSWORD_POLICY', '비밀번호는 12자 이상이며 영문·숫자·특수문자를 포함해야 합니다.');
    if (confirm !== password) throw fault('PASSWORD_MISMATCH', '비밀번호 확인이 일치하지 않습니다.');
    const before = db.prepare('SELECT * FROM accounts WHERE id=?').get(adminId);
    if (!before || before.status !== 'pending') throw fault('ACCOUNT_NOT_PENDING', '최초 설정 대기 중인 계정만 활성화할 수 있습니다.', 409);
    const salt = crypto.randomBytes(16).toString('base64url');
    const digest = (await scrypt(password, salt, 64)).toString('base64url');
    return transaction(() => {
      const r = db.prepare("UPDATE accounts SET status='active',password_hash=? WHERE id=? AND status='pending'").run(`scrypt$${salt}$${digest}`, adminId);
      if (r.changes !== 1) throw fault('ACCOUNT_NOT_PENDING', '이미 처리된 계정입니다.', 409);
      audit(adminId, actor, 'account-activated');
      return publicAccount(db.prepare('SELECT * FROM accounts WHERE id=?').get(adminId));
    });
  }
  function throttle(key, limit) {
    transaction(() => {
      db.prepare('DELETE FROM attempts WHERE until_at<=?').run(now());
      const old = db.prepare('SELECT count FROM attempts WHERE key=?').get(hash(key));
      if (old?.count >= limit) throw fault('RATE_LIMITED', '로그인 시도가 많습니다. 15분 뒤 다시 시도해 주세요.', 429);
      db.prepare('INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=attempts.count+1').run(hash(key), 1, now() + 900000);
    });
  }
  async function login(username, password) {
    username = cleanName(username);
    if (!username || username.length > 60 || typeof password !== 'string' || password.length > 120) throw fault('INVALID_LOGIN', '아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    throttle(`login:${username}`, 8); throttle('login-total', 60);
    const row = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const [, salt, expected] = (row?.password_hash || 'scrypt$unavailable-account$').split('$');
    const actual = await scrypt(password, salt, 64);
    const stored = expected ? Buffer.from(expected, 'base64url') : Buffer.alloc(64);
    if (!row || row.status !== 'active' || stored.length !== actual.length || !crypto.timingSafeEqual(actual, stored)) throw fault('INVALID_LOGIN', '아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    // Recheck after asynchronous hashing, including a concurrent permission revocation.
    return transaction(() => {
      const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(row.id);
      if (current.status !== 'active' || current.password_hash !== row.password_hash) throw fault('INVALID_LOGIN', '계정 상태를 다시 확인해 주세요.', 401);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), row.id, now() + 8 * 3600000);
      db.prepare('DELETE FROM attempts WHERE key=?').run(hash(`login:${username}`));
      audit(row.id, row.id, 'login');
      return { token, admin: publicAccount(current) };
    });
  }
  function authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fault('ADMIN_LOGIN_REQUIRED', '인사이트 관리자 로그인이 필요합니다.', 401);
    const row = db.prepare("SELECT a.* FROM accounts a JOIN sessions s ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires>? AND a.status='active'").get(hash(token), now());
    if (!row) throw fault('ADMIN_LOGIN_REQUIRED', '인사이트 관리자 로그인이 필요합니다.', 401);
    return publicAccount(row);
  }
  function disable(adminId, actor) {
    return transaction(() => {
      const r = db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(adminId);
      if (!r.changes) throw fault('NOT_FOUND', '관리자 계정을 찾을 수 없습니다.', 404);
      db.prepare('DELETE FROM sessions WHERE admin_id=?').run(adminId); audit(adminId, actor, 'account-disabled');
      return publicAccount(db.prepare('SELECT * FROM accounts WHERE id=?').get(adminId));
    });
  }
  return { reserve, activate, login, authenticate, disable,
    list: () => db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(publicAccount),
    logout: token => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token || '')),
    close: () => db.close() };
}
module.exports = { createInsightAdminStore };
