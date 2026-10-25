'use strict';
// An assignment grants access to one already issued report. It never publishes,
// rebuilds, edits, or infers an assignment from current company relationships.
// assign() is an internal admin-only operation: the HTTP handler must authenticate
// its actor. authorizedReport() returns an INTERNAL report for the existing PDF
// renderer, never a customer JSON response. detail()/list() are the public DTOs.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CUSTOMER = /^cus_[a-zA-Z0-9-]{1,100}$/;
const REPORT = /^mr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const { HASH, hash, fail, need, stamp, safe, reportBinding, published, metadata, project } = require('./monthly_report_delivery_projection.cjs');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ASSIGNMENTS = 1000;
const MAX_COMMANDS = 4096;
const notFound = () => fail('REPORT_NOT_FOUND', '배정된 발행본을 찾을 수 없습니다.', 404);
const signature = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
function createMonthlyReportDelivery({ dataDir, reports, customers, now = () => new Date(), fileSystem = fs } = {}) {
  need(typeof dataDir === 'string' && dataDir && typeof reports?.get === 'function' && typeof customers?.get === 'function'
    && typeof now === 'function', 'DELIVERY_CONFIGURATION', '발행본 전달 연결을 확인해 주세요.', 503);
  const directory = path.resolve(dataDir);
  const fileFor = id => path.join(directory, id + '.json');
  function currentCustomer(customerId) {
    need(safe(customerId, CUSTOMER), 'INVALID_CUSTOMER', '이용자를 확인해 주세요.');
    const customer = customers.get(customerId);
    need(customer?.customerId === customerId && customer.accountStatus === 'active', 'ACCOUNT_DISABLED', '이용이 중지된 계정입니다.', 403);
    return customer;
  }
  async function access(customerId, options) {
    need(typeof options?.verifyAccess === 'function', 'CUSTOMER_ACCESS_REQUIRED', '고객 인증 연결을 확인해 주세요.', 503);
    const verified = await options.verifyAccess(customerId);
    need(verified === true || verified?.customerId === customerId, 'LOGIN_REQUIRED', '다시 로그인해 주세요.', 401);
    return currentCustomer(customerId);
  }
  async function checkDirectory(create = false) {
    if (create) await fileSystem.mkdir(directory, { recursive: true });
    try {
      const stat = await fileSystem.lstat(directory);
      need(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await fileSystem.realpath(directory)) === directory,
        'DELIVERY_STORAGE_INVALID', '배정 저장소를 확인해 주세요.', 503);
      return true;
    } catch (error) { if (error.code === 'ENOENT' && !create) return false; throw error; }
  }
  function validateRecord(record, id) {
    const valid = record?.schemaVersion === 1 && record.customerId === id && Number.isSafeInteger(record.revision) && record.revision >= 0
      && Array.isArray(record.assignments) && record.assignments.length <= MAX_ASSIGNMENTS
      && Array.isArray(record.commands) && record.commands.length <= MAX_COMMANDS;
    need(valid, 'DELIVERY_RECEIPT_INVALID', '저장된 배정 기록을 확인해 주세요.', 503);
    const ids = new Set(), keys = new Set();
    for (const row of record.assignments) {
      need(row && safe(row.reportId, REPORT) && !ids.has(row.reportId) && HASH.test(row.snapshotHash || '') && HASH.test(row.reportBindingHash || '')
        && Number.isSafeInteger(row.version) && row.version > 0 && stamp(row.assignedAt) && typeof row.actorId === 'string',
      'DELIVERY_RECEIPT_INVALID', '저장된 배정 기록을 확인해 주세요.', 503);
      ids.add(row.reportId);
    }
    for (const row of record.commands) {
      need(row && safe(row.requestKey, /^[A-Za-z0-9_-]{16,100}$/) && !keys.has(row.requestKey) && ids.has(row.reportId)
        && typeof row.actorId === 'string' && typeof row.created === 'boolean' && Number.isSafeInteger(row.revision)
        && row.revision > 0 && row.revision <= record.revision, 'DELIVERY_RECEIPT_INVALID', '저장된 배정 기록을 확인해 주세요.', 503);
      keys.add(row.requestKey);
    }
    return record;
  }
  async function readRecord(customerId) {
    const empty = () => ({ schemaVersion: 1, customerId, revision: 0, assignments: [], commands: [] });
    if (!await checkDirectory()) return empty();
    let handle, found = false;
    try {
      const file = fileFor(customerId), before = await fileSystem.lstat(file);
      found = true;
      need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_BYTES,
        'DELIVERY_RECEIPT_INVALID', '저장된 배정 기록을 확인해 주세요.', 503);
      handle = await fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      need(opened.isFile() && opened.nlink === 1 && signature(opened) === signature(before), 'DELIVERY_RECEIPT_INVALID', '배정 기록이 변경되었습니다.', 503);
      const bytes = Buffer.alloc(opened.size + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      need(length === opened.size && signature(await handle.stat()) === signature(opened)
        && signature(await fileSystem.lstat(file)) === signature(opened), 'DELIVERY_RECEIPT_INVALID', '배정 기록이 변경되었습니다.', 503);
      return validateRecord(JSON.parse(bytes.toString('utf8', 0, length)), customerId);
    } catch (error) {
      if (error.code === 'ENOENT' && !found) return empty();
      if (error.statusCode) throw error;
      throw fail('DELIVERY_RECEIPT_INVALID', '저장된 배정 기록을 확인해 주세요.', 503);
    } finally { await handle?.close(); }
  }
  async function writeRecord(record) {
    const content = JSON.stringify(record) + '\n';
    need(Buffer.byteLength(content) <= MAX_BYTES, 'DELIVERY_LIMIT', '배정 기록의 보관 한도를 확인해 주세요.', 409);
    const temp = path.join(directory, '.' + record.customerId + '.' + crypto.randomUUID() + '.tmp');
    let handle;
    try {
      handle = await fileSystem.open(temp, 'wx', 0o600);
      await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
      await fileSystem.rename(temp, fileFor(record.customerId));
    } finally { await handle?.close(); await fileSystem.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function assignedReport(customerId, reportId, savedRecord) {
    need(safe(reportId, REPORT), 'INVALID_REPORT_ID', '보고서 번호를 확인해 주세요.');
    const record = savedRecord || await readRecord(customerId), assignment = record.assignments.find(row => row.reportId === reportId);
    if (!assignment) throw notFound(); // Never read an unassigned report, even to discover its status.
    const report = published(await reports.get(reportId), reportId);
    need(report.snapshotHash === assignment.snapshotHash && hash(reportBinding(report)) === assignment.reportBindingHash
      && report.version === assignment.version, 'REPORT_INTEGRITY_CHANGED', '배정 당시 발행본이 변경되었습니다.', 409);
    return { report, assignment };
  }
  async function assign(input) {
    need(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 4
      && ['customerId', 'reportId', 'actorId', 'requestKey'].every(key => Object.hasOwn(input, key)), 'INVALID_FIELDS', '배정 입력을 확인해 주세요.');
    const { customerId, reportId, actorId, requestKey } = input;
    currentCustomer(customerId);
    need(safe(reportId, REPORT) && safe(requestKey, /^[A-Za-z0-9_-]{16,100}$/)
      && typeof actorId === 'string' && actorId.trim().length > 0 && actorId.length <= 200, 'INVALID_ASSIGNMENT', '배정 대상과 요청 번호를 확인해 주세요.');
    await checkDirectory(true);
    let lock;
    try { lock = await fileSystem.open(fileFor(customerId) + '.lock', 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw fail('DELIVERY_BUSY', '다른 배정이 저장 중입니다. 남은 잠금은 운영자가 확인해야 합니다.', 423); throw error; }
    try {
      const record = await readRecord(customerId), previous = record.commands.find(row => row.requestKey === requestKey);
      if (previous && (previous.reportId !== reportId || previous.actorId !== actorId)) throw fail('REQUEST_CONFLICT', '같은 요청 번호의 배정 내용이 다릅니다.', 409);
      const report = published(await reports.get(reportId), reportId);
      let assignment = record.assignments.find(row => row.reportId === reportId);
      if (assignment) need(assignment.snapshotHash === report.snapshotHash && assignment.reportBindingHash === hash(reportBinding(report)),
        'REPORT_INTEGRITY_CHANGED', '배정 당시 발행본이 변경되었습니다.', 409);
      const created = !assignment;
      currentCustomer(customerId);
      if (!previous) {
        need(record.commands.length < MAX_COMMANDS && (!created || record.assignments.length < MAX_ASSIGNMENTS), 'DELIVERY_LIMIT', '배정 기록의 보관 한도를 확인해 주세요.', 409);
        const at = new Date(now()).toISOString();
        if (!assignment) { assignment = { reportId, snapshotHash: report.snapshotHash, reportBindingHash: hash(reportBinding(report)),
          version: report.version, assignedAt: at, actorId }; record.assignments.push(assignment); }
        record.revision++;
        record.commands.push({ requestKey, reportId, actorId, created, revision: record.revision });
        await writeRecord(record);
      }
      const command = previous || record.commands.at(-1);
      return { assignment: { reportId, snapshotHash: assignment.snapshotHash, version: assignment.version, assignedAt: assignment.assignedAt },
        created: command.created, revision: command.revision };
    } finally { await lock.close(); await fileSystem.unlink(fileFor(customerId) + '.lock'); }
  }
  async function list(customerId, options) {
    await access(customerId, options);
    const record = await readRecord(customerId), result = [];
    for (const assignment of record.assignments) {
      if (typeof reports.getPublishedListSummary === 'function') {
        const saved = await reports.getPublishedListSummary(assignment.reportId);
        need(saved.snapshotHash === assignment.snapshotHash && saved.reportBindingHash === assignment.reportBindingHash
          && saved.version === assignment.version, 'REPORT_INTEGRITY_CHANGED', '배정 당시 발행본이 변경되었습니다.', 409);
        result.push({ ...saved.metadata, assignedAt: assignment.assignedAt });
      } else {
        const { report } = await assignedReport(customerId, assignment.reportId, record);
        result.push(metadata(report, assignment));
      }
    }
    result.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt) || a.id.localeCompare(b.id));
    await access(customerId, options);
    return { reports: result };
  }
  async function detail(customerId, reportId, options) {
    await access(customerId, options);
    const { report, assignment } = await assignedReport(customerId, reportId), result = project(report, assignment);
    await access(customerId, options);
    return result;
  }
  async function authorizedReport(customerId, reportId, options) {
    await access(customerId, options);
    const { report } = await assignedReport(customerId, reportId);
    await access(customerId, options);
    return report;
  }
  return { assign, list, detail, authorizedReport };
}
module.exports = { createMonthlyReportDelivery };
