"use strict";

// A read-only, address-only view of the saved company master. Each caller
// checks the source again; only a completely validated, unchanged file may
// supply a reusable directory. This is not geocoding or address certification.
const native = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");
const { companyAddressBasis, normalizeCompanyAddress } = require("./company_address_basis.cjs");

const MAX_COMPANIES = 4096, MAX_BYTES = 4 * 1024 * 1024;
const fault = code => Object.assign(new Error("저장된 업체 주소 원장을 확인하지 못했습니다."), { code, statusCode: 503 });
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String).join(":");
const directorySignature = stat => [stat.dev, stat.ino].map(String).join(":");
function fileChunks(handle) {
  // The projection reader destroys its input in finally. Keep descriptor
  // ownership here so the same opened file can still be fstat-checked after
  // a complete parse, including on Node versions that close fs.ReadStreams.
  return Readable.from((async function* () {
    const buffer = Buffer.allocUnsafe(64 * 1024), decoder = new StringDecoder("utf8");
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      if (chunk.includes("\uFFFD")) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
      if (chunk) yield chunk;
    }
    const tail = decoder.end();
    if (tail.includes("\uFFFD")) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
    if (tail) yield tail;
  })());
}

function createCatchmentAddressDirectory({ file, dataDir = null, maxCompanies = MAX_COMPANIES, maxBytes = MAX_BYTES,
  fileSystem = fs, stream = fileChunks, includeRegionBasis = false } = {}) {
  if (typeof file !== "string" || !file || !Number.isSafeInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > MAX_COMPANIES
    || !Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_BYTES || typeof stream !== "function" || typeof includeRegionBasis !== "boolean") throw new TypeError("A saved company file and bounded directory limits are required");
  const source = path.resolve(file);
  if (dataDir !== null) {
    if (typeof dataDir !== "string" || !dataDir) throw new TypeError("Invalid address directory data folder");
    const relative = path.relative(path.resolve(dataDir), source);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new TypeError("The saved company file must stay inside its data folder");
  }
  let cached = null;
  const flights = new Map();

  async function inspect() {
    const root = path.parse(source).root;
    const parts = path.relative(root, source).split(path.sep);
    const ancestors = [];
    let current = root;
    const inspectDirectory = async target => {
      const stat = await fileSystem.lstat(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
      ancestors.push(directorySignature(stat));
    };
    await inspectDirectory(root);
    for (const part of parts.slice(0, -1)) { current = path.join(current, part); await inspectDirectory(current); }
    const stat = await fileSystem.lstat(source, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
    return { key: JSON.stringify([ancestors, signature(stat)]), fileSignature: signature(stat) };
  }

  async function load(before) {
    let handle, projectionFailure = null;
    try {
      handle = await fileSystem.open(source, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || signature(opened) !== before.fileSignature) throw fault("CATCHMENT_ADDRESS_SOURCE_CHANGED");
      const rows = [], companyIds = new Set();
      let bytes = 2; // JSON array brackets; each following row adds a comma.
      await readCompanyMasterProjection(source, { projectCompany: null, stream: () => stream(handle, source),
        onCompany(company, key) { try {
          if (company.deletedAt || company.mergedIntoCompanyId) return;
          if (typeof company.companyId !== "string" || !/^[A-Za-z0-9_:-]{1,120}$/.test(company.companyId) || company.companyId !== key || companyIds.has(company.companyId)) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
          if (rows.length >= maxCompanies) throw fault("CATCHMENT_ADDRESS_SOURCE_LIMIT");
          companyIds.add(company.companyId);
          const candidates = [...(Array.isArray(company.addresses) ? company.addresses : []), ...(typeof company.address === "string" ? [company.address] : [])];
          const addresses = [];
          for (const value of candidates) {
            const rawAddress = typeof value === "string" ? value : value?.address;
            if (typeof rawAddress === "string" && rawAddress.includes("\uFFFD")) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
            const address = normalizeCompanyAddress(rawAddress);
            if (address && addresses.length < 20 && !addresses.includes(address)) addresses.push(address);
          }
          const row = { companyId: company.companyId,
            label: String(company.primaryName || company.companyId).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160),
            addressBasis: companyAddressBasis(company), addresses };
          if (includeRegionBasis) {
            const strings = values => Array.isArray(values) && values.length <= 30 && values.every(value => typeof value === "string" && value.length <= 300 && !/[\x00-\x1f\x7f\uFFFD]/.test(value));
            const correction = company.manualCorrection?.active === false ? null : company.manualCorrection;
            const override = correction?.regionOverride;
            row.regionBasis = { regions: strings(company.regions || []) ? company.regions || [] : [],
              invalid: !strings(company.regions || []) || correction?.regionOverrideInvalid === true || override !== undefined && (typeof override !== "string" || override.length > 300 || /[\x00-\x1f\x7f\uFFFD]/.test(override)),
              override: typeof override === "string" ? override : "" };
          }
          bytes += Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
          if (bytes > maxBytes) throw fault("CATCHMENT_ADDRESS_SOURCE_LIMIT");
          rows.push(row);
        } catch (error) { projectionFailure = error; throw error; }
        } });
      if (signature(await handle.stat({ bigint: true })) !== before.fileSignature || (await inspect()).key !== before.key) throw fault("CATCHMENT_ADDRESS_SOURCE_CHANGED");
      const entry = { key: before.key, rows };
      cached = entry;
      return entry;
    } catch (error) {
      if (projectionFailure) throw projectionFailure;
      if (/^CATCHMENT_ADDRESS_SOURCE_/.test(error?.code || "")) throw error;
      if (/^COMPANY_MASTER_/.test(error?.code || "")) throw fault("CATCHMENT_ADDRESS_SOURCE_INVALID");
      throw Object.assign(fault("CATCHMENT_ADDRESS_SOURCE_UNAVAILABLE"), { cause: error });
    } finally { if (handle) await handle.close().catch(() => {}); }
  }

  async function read() {
    try {
      const before = await inspect();
      let entry = cached?.key === before.key ? cached : null;
      if (!entry) {
        let flight = flights.get(before.key);
        if (!flight) {
          // A changing source must not multiply simultaneous full-master
          // scans and projected generations. Retry once the source is stable.
          if (flights.size) throw fault("CATCHMENT_ADDRESS_SOURCE_CHANGED");
          flight = load(before);
          flights.set(before.key, flight);
          // Use both handlers so a failed parse never leaves an unhandled
          // rejection or a reusable failed/empty directory behind.
          const release = () => { if (flights.get(before.key) === flight) flights.delete(before.key); };
          flight.then(release, release);
        }
        entry = await flight;
      }
      if ((await inspect()).key !== before.key) throw fault("CATCHMENT_ADDRESS_SOURCE_CHANGED");
      return structuredClone(entry.rows);
    } catch (error) {
      if (/^CATCHMENT_ADDRESS_SOURCE_/.test(error?.code || "")) throw error;
      throw fault("CATCHMENT_ADDRESS_SOURCE_UNAVAILABLE");
    }
  }
  return { read };
}

module.exports = { createCatchmentAddressDirectory, MAX_COMPANIES, MAX_BYTES };
