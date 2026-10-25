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
const { normalizeMonthlyReportActionPlan, listMonthlyReportActionEvidence } = require('./monthly_report_actions.cjs');
const CUSTOMER = /^cus_[a-zA-Z0-9-]{1,100}$/;
const REPORT = /^mr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ASSIGNMENTS = 1000;
const MAX_COMMANDS = 4096;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function need(condition, code, message, status = 400) { if (!condition) throw fail(code, message, status); }
const notFound = () => fail('REPORT_NOT_FOUND', '배정된 발행본을 찾을 수 없습니다.', 404);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const safe = (value, expression) => typeof value === 'string' && expression.test(value);
const signature = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const METRICS = ['supply', 'sold', 'publicBookings', 'phoneBookings', 'sharedDayUseExcluded', 'explicitBlockedBookings',
  'phoneMissingPriceBookings', 'estimatedRevenue', 'publicRevenue', 'phoneRevenue', 'phoneFallbackRevenue', 'phoneFallbackBookings',
  'phoneAllocatedBookings', 'phoneAllocatedRevenue', 'phoneRevenueLow', 'phoneRevenueHigh', 'actualRevenue', 'reservationRate',
  'coveredSupply', 'coveredCompanyDays', 'expectedCompanyDays', 'missingCompanyDays', 'coverageRate', 'revenueCoveredCompanyDays',
  'revenueCoverageRate', 'sameDayObservedCompanyDays', 'staleDays', 'minObservationLeadTimeDays', 'maxObservationLeadTimeDays',
  'medianObservationLeadTimeDays', 'knownPartialRevenue', 'knownPartialPublicRevenue', 'knownPartialBlockedRevenue', 'knownPartialCompanyDays'];
function aggregate(value = {}) {
  return { ...Object.fromEntries(METRICS.map(key => [key, number(value?.[key])])),
    partial: typeof value?.partial === 'boolean' ? value.partial : null,
    revenuePartial: typeof value?.revenuePartial === 'boolean' ? value.revenuePartial : null,
    containsPartialRun: typeof value?.containsPartialRun === 'boolean' ? value.containsPartialRun : null,
    rateDenominator: value?.rateDenominator === 'covered_supply' ? 'covered_supply' : null };
}
const summary = value => ({ lodging: aggregate(value?.lodging), dayuse: aggregate(value?.dayuse) });
function quality(value = {}) {
  const fields = ['companyCount', 'expectedCompanyDays', 'coveredCompanyDays', 'coverageRate', 'missingCompanyDays',
    'sameDayObservedCompanyDays', 'staleDays', 'minObservationLeadTimeDays', 'maxObservationLeadTimeDays',
    'medianObservationLeadTimeDays', 'revenueCoveredCompanyDays', 'revenueExcludedCompanyDays', 'discardedObservationCount',
    'partialRunObservationCount', 'knownPartialCompanyDays', 'recoveredCompanyDays'];
  return { status: ['complete', 'partial', 'insufficient'].includes(value?.status) ? value.status : 'unknown',
    provisional: typeof value?.provisional === 'boolean' ? value.provisional : null,
    ...Object.fromEntries(fields.map(key => [key, number(value?.[key])])) };
}
function reportBinding(report) {
  // snapshotHash binds the snapshot separately. Bind every other issued field
  // too: notes are rendered in the original PDF and must not change unnoticed.
  const { snapshot, ...metadata } = report;
  return metadata;
}
function published(report, id) {
  need(report && report.id === id && report.status === 'published', 'PUBLISHED_REPORT_REQUIRED', '발행된 보고서만 배정할 수 있습니다.', 409);
  need(report.schemaVersion === 1 && HASH.test(report.snapshotHash || '') && report.snapshot && typeof report.snapshot === 'object'
    && !Array.isArray(report.snapshot) && hash(report.snapshot) === report.snapshotHash
    && Number.isSafeInteger(report.revision) && report.revision > 0 && Number.isSafeInteger(report.version) && report.version > 0
    && stamp(report.publishedAt) && ['company', 'keyword', 'region'].includes(report.type)
    && safe(report.month, /^20\d{2}-(0[1-9]|1[0-2])$/) && typeof report.targetId === 'string' && typeof report.title === 'string',
  'REPORT_INTEGRITY_CHANGED', '발행본의 고정된 내용을 확인하지 못했습니다.', 409);
  if (report.snapshot.actionPlan !== undefined) normalizeMonthlyReportActionPlan(report.snapshot.actionPlan, report.snapshot);
  return report;
}
function metadata(report, assignment) {
  return { id: report.id, title: text(report.title), type: report.type, month: report.month, status: 'published',
    version: report.version, publishedAt: report.publishedAt, assignedAt: assignment.assignedAt,
    target: { type: report.type, id: text(report.snapshot.target?.id), label: text(report.snapshot.target?.label) },
    summary: summary(report.snapshot.summary), quality: quality(report.snapshot.quality) };
}
function project(report, assignment) {
  const snapshot = report.snapshot, period = snapshot.period || {};
  const actionPlan = snapshot.actionPlan === undefined ? undefined : normalizeMonthlyReportActionPlan(snapshot.actionPlan, snapshot);
  const refs = new Set(actionPlan?.items.flatMap(item => item.evidenceRefs) || []);
  return { ...metadata(report, assignment), snapshot: {
    period: { start: text(period.start, 10), end: text(period.end, 10), days: number(period.days),
      cutoffDate: text(period.cutoffDate, 10), monthClosed: typeof period.monthClosed === 'boolean' ? period.monthClosed : null },
    summary: summary(snapshot.summary),
    daily: Array.isArray(snapshot.daily) ? snapshot.daily.filter(row => row && /^20\d{2}-\d{2}-\d{2}$/.test(row.date || ''))
      .map(row => ({ date: row.date, ...summary(row) })) : [],
    quality: quality(snapshot.quality),
    ...(actionPlan === undefined ? {} : { actionPlan, actionEvidence: listMonthlyReportActionEvidence(snapshot)
      .filter(row => refs.has(row.id)).map(row => ({ id: row.id, label: text(row.label) })) }),
    definitions: { estimates: '공개 예약과 전화·타채널 예약 추정은 구분하며, 실제 결제 매출을 뜻하지 않습니다.',
      missing: '자료 없음·미확인 값은 0으로 바꾸지 않습니다. 부분 금액은 정상 예상매출과 별도입니다.' }
  } };
}
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
      const { report } = await assignedReport(customerId, assignment.reportId, record);
      result.push(metadata(report, assignment));
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
