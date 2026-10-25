'use strict';
// Cache only a small projection after validating the complete stored report.
// Every hit still reads and hashes every file byte. Timestamps are race guards,
// never proof that a previously validated body is unchanged.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MiB = 1024 * 1024;
const invalid = () => Object.assign(new Error('저장된 발행본을 확인하지 못했습니다. 원본 파일은 보존했습니다.'),
  { code: 'corrupt_report', statusCode: 500, status: 500 });
const identity = stat => ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');

function createVerifiedReportProjectionReader({ directory, fileFor, parse, project, fileSystem = fs,
  maxEntries = 128, maxCacheBytes = 2 * MiB, maxReportBytes = 128 * MiB } = {}) {
  if (![fileFor, parse, project].every(fn => typeof fn === 'function') || typeof directory !== 'string'
    || ![maxEntries, maxCacheBytes, maxReportBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid projection reader');
  const root = path.resolve(directory), cache = new Map();
  let bytes = 0, queue = Promise.resolve(), buffer = null;
  const counters = { reads: 0, hashedBytes: 0, cacheHits: 0, parsedReports: 0, evictions: 0, oversizedProjections: 0 };
  const remove = id => { const item = cache.get(id); if (item) { bytes -= item.bytes; cache.delete(id); } };
  async function checkDirectory() {
    const stat = await fileSystem.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fileSystem.realpath(root)) !== root) throw invalid();
  }
  const safeFile = stat => stat.isFile() && !stat.isSymbolicLink?.() && stat.nlink === 1n
    && stat.size > 0n && stat.size <= BigInt(maxReportBytes);
  async function readOne(id) {
    const file = fileFor(id);
    if (path.dirname(path.resolve(file)) !== root) throw invalid();
    let handle, found = false;
    try {
      await checkDirectory();
      const before = await fileSystem.lstat(file, { bigint: true }); found = true;
      if (!safeFile(before)) throw invalid();
      handle = await fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!safeFile(opened) || identity(before) !== identity(opened)) throw invalid();
      buffer ||= Buffer.alloc(128 * 1024);
      const size = Number(opened.size), entry = cache.get(id);
      let content = entry ? null : Buffer.alloc(size + 1);
      let length = 0;
      const digest = crypto.createHash('sha256');
      while (length <= size) {
        const count = Math.min(buffer.length, size + 1 - length);
        const target = content || buffer, offset = content ? length : 0;
        const read = await handle.read(target, offset, count, length);
        if (!read.bytesRead) break;
        digest.update(target.subarray(offset, offset + read.bytesRead)); length += read.bytesRead;
      }
      const unchanged = async () => {
        if (identity(await handle.stat({ bigint: true })) !== identity(opened)
          || identity(await fileSystem.lstat(file, { bigint: true })) !== identity(opened)) throw invalid();
        await checkDirectory();
      };
      if (length !== size) throw invalid();
      await unchanged();
      const rawHash = digest.digest('hex'); counters.reads++; counters.hashedBytes += length;
      if (entry?.rawHash === rawHash) {
        cache.delete(id); cache.set(id, entry); counters.cacheHits++;
        return JSON.parse(entry.json);
      }
      remove(id);
      if (content) content = content.subarray(0, length);
      else {
        // Changed bytes must receive a complete validation, never a stale DTO.
        content = Buffer.alloc(size + 1); let offset = 0;
        while (offset < content.length) {
          const read = await handle.read(content, offset, content.length - offset, offset);
          if (!read.bytesRead) break; offset += read.bytesRead;
        }
        if (offset !== size || crypto.createHash('sha256').update(content.subarray(0, size)).digest('hex') !== rawHash) throw invalid();
        content = content.subarray(0, size);
      }
      await unchanged();
      const report = parse(content.toString('utf8'), id);
      content = null;
      const json = JSON.stringify(project(report, id)), count = Buffer.byteLength(json);
      counters.parsedReports++;
      if (count <= maxCacheBytes) {
        while (cache.size >= maxEntries || bytes + count > maxCacheBytes) { remove(cache.keys().next().value); counters.evictions++; }
        cache.set(id, { rawHash, json, bytes: count }); bytes += count;
      } else counters.oversizedProjections++;
      return JSON.parse(json);
    } catch (error) {
      remove(id);
      if (error.code === 'ENOENT' && !found) throw Object.assign(new Error('보고서를 찾을 수 없습니다.'),
        { code: 'report_not_found', statusCode: 404, status: 404 });
      if (error.statusCode) throw error;
      throw invalid();
    } finally { await handle?.close(); }
  }
  return {
    read(id) {
      // One bounded streaming buffer; concurrent callers cannot overwrite it.
      const work = queue.then(() => readOne(id)); queue = work.catch(() => {}); return work;
    },
    invalidate: remove,
    metrics: () => ({ ...counters, entries: cache.size, serializedBytes: bytes, maxEntries, maxCacheBytes, maxReportBytes })
  };
}
module.exports = { createVerifiedReportProjectionReader };
