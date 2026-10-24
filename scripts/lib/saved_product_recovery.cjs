"use strict";

// A saved-evidence overlay, never a collector or an edit of original history.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const KIND = "saved_product_recovery_v1", HEX = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const recoveryRowDigest = row => hash(JSON.stringify(canonical(row)));
// The same saved response is projected into a basis-day and a weekly table.
// Unit/coupon display metadata can differ; every field used in inventory,
// valuation, classification or response validation must still agree.
const productDigest = row => recoveryRowDigest(Object.fromEntries([
  "date", "bizItemId", "name", "saleType", "bizItemSubType", "listType", "stock", "bookingCount", "occupiedBookingCount", "price", "open",
  "available", "total", "soldOut", "isBusinessDay", "isSaleDay", "collectionFailed", "collectionErrorCode", "responseStatus", "error", "errors",
  "failed", "queryAttempted", "stockObserved", "missing", "status"
].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
const quality = run => String(typeof run?.collectionQuality === "string" ? run.collectionQuality : run?.collectionQuality?.status || "unknown").toLowerCase();
const count = value => typeof value !== "boolean" && value !== null && value !== undefined && String(value).trim() !== ""
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const identifier = value => /^[A-Za-z0-9_-]{1,160}$/.test(String(value || "")) ? String(value) : "";
function date(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : "";
}
function instant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
    && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}
const observedDate = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
function fail(code) { throw Object.assign(new Error(code), { code, statusCode: 503 }); }
function need(condition, code) { if (!condition) fail(code); }
const stamp = value => [value.size, value.mtimeNs, value.ctimeNs, value.ino, value.dev].map(String).join(":");
function relative(value) {
  need(typeof value === "string" && value && !value.includes("\\") && !value.includes(":") && !path.isAbsolute(value)
    && value.split("/").every(part => part && part !== "." && part !== ".."), "RECOVERY_ARTIFACT_PATH_INVALID");
  return value;
}
function parseCsv(text) {
  const records = []; let record = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (char === '"') { if (quoted && next === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === "," && !quoted) { record.push(field); field = ""; }
    else if ((char === "\r" || char === "\n") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      record.push(field); if (record.some(Boolean)) records.push(record); record = []; field = "";
    } else field += char;
  }
  need(!quoted, "RECOVERY_CSV_INVALID");
  if (field || record.length) { record.push(field); records.push(record); }
  const headers = records.shift() || [];
  need(headers.length && new Set(headers).size === headers.length && records.length <= 5000, "RECOVERY_CSV_INVALID");
  return records.map(values => { need(values.length <= headers.length, "RECOVERY_CSV_INVALID");
    return Object.fromEntries(headers.map((key, index) => [key, values[index] || ""])); });
}
function first(row, keys) { for (const key of keys) if (Object.hasOwn(row, key) && row[key] !== "") return row[key]; return undefined; }
function productKind(row) {
  const explicit = [row.saleType, row.bizItemSubType].filter(Boolean).join(" ");
  const dayUse = /데이|day[_\s]*use|당일|캠프닉|campnic|camp_nic/i.test(explicit), lodging = /숙박|night|overnight/i.test(explicit);
  if (dayUse && lodging) return "";
  if (dayUse) return "dayuse";
  if (lodging) return "lodging";
  return "";
}
function identity(row) {
  // URLs are accepted only as a second, exact provider identity, never as names.
  let placeId = identifier(first(row, ["place_id", "placeId"])), bookingBusinessId = identifier(first(row, ["네이버예약사업자ID", "bookingBusinessId"]));
  for (const value of [row.url, row["네이버예약URL"]].filter(Boolean)) {
    let url; try { url = new URL(value); } catch { continue; }
    if (["m.place.naver.com", "pcmap.place.naver.com", "map.naver.com"].includes(url.hostname)) {
      const found = url.pathname.match(/\/(?:place|accommodation|camping|pension|hotel|motel)\/(\d+)(?:\/|$)/)?.[1];
      if (found) { need(!placeId || placeId === found, "RECOVERY_PROVIDER_ID_CONFLICT"); placeId = found; }
    }
    if (url.hostname === "booking.naver.com") {
      const found = url.pathname.match(/\/bizes\/(\d+)(?:\/|$)/)?.[1];
      if (found) { need(!bookingBusinessId || bookingBusinessId === found, "RECOVERY_PROVIDER_ID_CONFLICT"); bookingBusinessId = found; }
    }
  }
  return { placeId, bookingBusinessId };
}
function runIds(company) {
  const inventory = company.inventory || {};
  return new Set([...(company.runIds || []), ...(inventory.runIds || []), company.firstRunId, company.lastRunId,
    inventory.latest?.runId, inventory.previousLatest?.runId, ...(inventory.snapshots || []).map(value => value?.runId),
    ...Object.values(company.keywords || {}).flatMap(value => (value.runs || []).map(row => row?.runId))].filter(Boolean).map(String));
}

function createSavedProductRecovery({ dataDir, outputsDir = path.join(dataDir || "", "outputs"), projectCompany = value => value,
  applyCompanyManualCorrection, buildHistoryObservations, now = () => new Date() } = {}) {
  if (!dataDir || !outputsDir || [projectCompany, applyCompanyManualCorrection, buildHistoryObservations, now].some(value => typeof value !== "function")) throw new TypeError("Saved product recovery dependencies are required");
  const root = path.resolve(outputsDir), directory = path.join(path.resolve(dataDir), "history", "saved_product_recoveries");
  let serial = Promise.resolve();
  const schedule = operation => { const pending = serial.then(operation); serial = pending.then(() => undefined, () => undefined); return pending; };
  async function readFile(relativePath, limit) {
    relative(relativePath);
    const file = path.resolve(root, ...relativePath.split("/")), inside = path.relative(root, file);
    need(inside && !inside.startsWith("..") && !path.isAbsolute(inside), "RECOVERY_ARTIFACT_PATH_INVALID");
    const actualRoot = await fs.realpath(root), actualFile = await fs.realpath(file);
    const actualRelative = path.relative(actualRoot, actualFile);
    need(actualRelative && !actualRelative.startsWith("..") && !path.isAbsolute(actualRelative), "RECOVERY_ARTIFACT_PATH_INVALID");
    let current = root;
    for (const part of relativePath.split("/")) { current = path.join(current, part); need(!(await fs.lstat(current)).isSymbolicLink(), "RECOVERY_ARTIFACT_PATH_INVALID"); }
    const before = await fs.lstat(file, { bigint: true });
    need(before.isFile() && before.size <= BigInt(limit), "RECOVERY_ARTIFACT_TOO_LARGE");
    const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
    try {
      need(stamp(await handle.stat({ bigint: true })) === stamp(before), "RECOVERY_SOURCE_CHANGED");
      const bytes = await handle.readFile();
      need(BigInt(bytes.length) === before.size && stamp(await handle.stat({ bigint: true })) === stamp(before)
        && stamp(await fs.lstat(file, { bigint: true })) === stamp(before), "RECOVERY_SOURCE_CHANGED");
      return { path: relativePath, sha256: hash(bytes), bytes };
    } finally { await handle.close(); }
  }
  async function verifyFiles(files) {
    need(Array.isArray(files) && files.length > 1 && files.length <= 20, "RECOVERY_RECEIPT_INVALID");
    for (const file of files) { need(object(file) && HEX.test(file.sha256), "RECOVERY_RECEIPT_INVALID");
      const actual = await readFile(file.path, 64 * 1024 * 1024); need(actual.sha256 === file.sha256, "RECOVERY_SOURCE_CHANGED"); }
  }
  function companies(data) {
    need(data?.rawCompanies instanceof Map && Array.isArray(data.runs), "RECOVERY_CATALOG_INVALID");
    return [...data.rawCompanies.values()].filter(company => company?.companyId && !company.deletedAt && !company.mergedIntoCompanyId);
  }
  function checkIdentity(company, ids, all) {
    need(ids.placeId && ids.bookingBusinessId, "RECOVERY_PROVIDER_ID_MISSING");
    const places = all.filter(value => (value.placeIds || []).map(String).includes(ids.placeId));
    const bookings = all.filter(value => (value.bookingBusinessIds || []).map(String).includes(ids.bookingBusinessId));
    need(places.length === 1 && bookings.length === 1 && places[0].companyId === company.companyId && bookings[0].companyId === company.companyId,
      "RECOVERY_PROVIDER_ID_AMBIGUOUS");
  }
  async function source(runId, company, all, expected = null) {
    need(identifier(runId), "RECOVERY_RUN_ID_INVALID");
    const files = [], used = new Map(); let totalBytes = 0;
    const read = async (name, limit) => {
      if (used.has(name)) return used.get(name);
      const value = await readFile(`${runId}/${relative(name)}`, limit); totalBytes += value.bytes.length;
      need(totalBytes <= 128 * 1024 * 1024, "RECOVERY_ARTIFACT_TOO_LARGE");
      files.push({ path: value.path, sha256: value.sha256 }); const text = value.bytes.toString("utf8").replace(/^\uFEFF/, ""); used.set(name, text); return text;
    };
    const manifest = JSON.parse(await read("manifest.json", 4 * 1024 * 1024));
    need(object(manifest) && quality(manifest) === "unknown", "RECOVERY_RUN_NOT_LEGACY");
    need(manifest.collectedAtSource !== "filesystem", "RECOVERY_TIME_UNVERIFIED");
    const collectedAt = instant(manifest.completedAt || manifest.finishedAt || manifest.collectedAt || manifest.startedAt || manifest.createdAt);
    need(collectedAt, "RECOVERY_TIME_UNVERIFIED");
    if (manifest.runId || manifest.id) need(String(manifest.runId || manifest.id) === runId, "RECOVERY_RUN_ID_CONFLICT");
    const start = date(manifest.checkIn), days = count(manifest.bookingRangeDays);
    need(start && days >= 1 && days <= 366, "RECOVERY_RANGE_UNVERIFIED");
    const listed = await fs.readdir(path.join(root, runId));
    const csvName = manifest.fileRoles?.overall || listed.find(name => name.endsWith("_overall_place_rank.csv"));
    need(csvName, "RECOVERY_CSV_MISSING");
    const rows = parseCsv(await read(csvName, 64 * 1024 * 1024));
    const matches = [];
    for (const row of rows) {
      let ids; try { ids = identity(row); } catch { continue; }
      if ((company.placeIds || []).map(String).includes(ids.placeId) || (company.bookingBusinessIds || []).map(String).includes(ids.bookingBusinessId)) matches.push({ row, ids });
    }
    need(matches.length === 1, "RECOVERY_COMPANY_ROW_AMBIGUOUS");
    const { row, ids } = matches[0]; checkIdentity(company, ids, all);
    const bookingStatus = String(first(row, ["네이버예약재고수집상태", "bookingStatus"]) || "");
    need(!/실패|차단|오류|불완전|일부|captcha|blocked|error|limit/i.test(bookingStatus), "RECOVERY_PRODUCT_LIST_INCOMPLETE");
    const nightCount = count(first(row, ["숙박상품수", "nightItemCount"])), dayCount = count(first(row, ["데이유즈상품수", "dayUseItemCount"]));
    const counted = count(first(row, ["예약계산대상상품수", "countedItemCount"]));
    need(nightCount !== null && dayCount !== null && nightCount + dayCount > 0 && counted !== null, "RECOVERY_PRODUCT_COUNTS_MISSING");
    const unknownCount = first(row, ["미분류상품수", "unknownItemCount"]);
    need(unknownCount === undefined || count(unknownCount) === 0, "RECOVERY_PRODUCT_CLASSIFICATION_INCOMPLETE");
    const arrays = [];
    for (const keys of [["네이버상품상세JSON", "itemDetailsJson", "itemDetails"], ["네이버요일별상품상세JSON", "weeklyProductDetailsJson", "weeklyProductDetails"], ["dayUseWeeklyProductDetailsJson"]]) {
      const value = first(row, keys); if (value === undefined) continue;
      let parsed;
      if (typeof value === "string" && value.startsWith("@json-file:")) {
        const name = value.slice("@json-file:".length).trim();
        const entries = (manifest.detailJsonFiles || []).filter(entry => entry?.file === name);
        need(entries.length > 0 && entries.every(entry => String(entry.placeId) === ids.placeId && String(entry.bookingBusinessId) === ids.bookingBusinessId), "RECOVERY_DETAIL_ID_CONFLICT");
        parsed = JSON.parse(await read(name, 16 * 1024 * 1024));
        need(entries.every(entry => count(entry.itemCount) === parsed?.length), "RECOVERY_DETAIL_COUNT_CONFLICT");
      } else parsed = typeof value === "string" ? JSON.parse(value) : value;
      need(Array.isArray(parsed) && parsed.length <= 100000, "RECOVERY_PRODUCTS_INVALID"); arrays.push(...parsed);
    }
    need(arrays.length > 0 && arrays.length <= 100000, "RECOVERY_PRODUCTS_MISSING");
    const products = new Map(), byKind = { lodging: new Set(), dayuse: new Set() }, invalidDates = new Map();
    for (const product of arrays) {
      need(object(product) && date(product.date) && identifier(product.bizItemId) && productKind(product), "RECOVERY_PRODUCT_ID_UNVERIFIED");
      const kind = productKind(product), id = identifier(product.bizItemId), key = `${product.date}|${kind}|${id}`;
      byKind[kind].add(id);
      if (products.has(key)) { need(productDigest(products.get(key)) === productDigest(product), "RECOVERY_DUPLICATE_PRODUCT_CONFLICT"); continue; }
      products.set(key, product);
      const stock = count(product.stock), booked = count(product.bookingCount), occupied = count(product.occupiedBookingCount);
      const invalidBoolean = ["collectionFailed", "failed", "queryAttempted", "stockObserved", "missing", "isBusinessDay", "isSaleDay"]
        .some(field => Object.hasOwn(product, field) && typeof product[field] !== "boolean");
      const failed = invalidBoolean || product.collectionFailed === true || product.collectionErrorCode || product.error
        || Boolean(product.errors && (!Array.isArray(product.errors) || product.errors.length)) || product.failed === true
        || product.queryAttempted === false || product.stockObserved === false || product.missing === true
        || ["failed", "blocked", "error", "partial", "missing"].includes(product.status)
        || (Object.hasOwn(product, "responseStatus") && (count(product.responseStatus) === null || Number(product.responseStatus) !== 200));
      const rawTotal = product.listType === "객실별 예약리스트" && stock > 0 ? 1 : stock;
      const opened = typeof product.open === "boolean" ? product.open && product.isBusinessDay !== false && product.isSaleDay !== false : undefined;
      if (failed || stock === null || booked === null || occupied === null || opened === undefined || booked + occupied > rawTotal
        || (Object.hasOwn(product, "available") && (count(product.available) === null || Number(product.available) !== (opened ? Math.max(0, rawTotal - booked - occupied) : 0)))) {
        invalidDates.set(product.date, "RECOVERY_PRODUCT_DATE_INVALID");
      }
    }
    need(byKind.lodging.size === nightCount && byKind.dayuse.size === dayCount && counted === nightCount,
      "RECOVERY_PRODUCT_LIST_INCOMPLETE");
    const daysInRange = Array.from({ length: days }, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
    const verifiedDates = { lodging: [], dayuse: [] }, exclusions = [];
    for (const day of daysInRange) {
      if (day < observedDate(collectedAt)) { exclusions.push({ date: day, reason: "RECOVERY_POST_STAY_OBSERVATION" }); continue; }
      let valid = !invalidDates.has(day);
      for (const kind of ["lodging", "dayuse"]) for (const id of byKind[kind]) if (!products.has(`${day}|${kind}|${id}`)) valid = false;
      if (!valid) { exclusions.push({ date: day, reason: invalidDates.get(day) || "RECOVERY_PRODUCT_DATE_MISSING" }); continue; }
      if (nightCount) verifiedDates.lodging.push(day); if (dayCount) verifiedDates.dayuse.push(day);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (expected) need(recoveryRowDigest(files) === recoveryRowDigest(expected.sourceFiles) && collectedAt === expected.collectedAt
      && recoveryRowDigest(ids) === recoveryRowDigest(expected.providerIdentity) && recoveryRowDigest(verifiedDates) === recoveryRowDigest(expected.verifiedDates), "RECOVERY_SOURCE_CHANGED");
    return { manifest, row, ids, collectedAt, products: [...products.values()], sourceFiles: files, verifiedDates, exclusions, start, days, nightCount, dayCount };
  }
  function build(value, company, month, runId) {
    const item = { name: company.primaryName, placeId: value.ids.placeId, place_id: value.ids.placeId,
      bookingBusinessId: value.ids.bookingBusinessId, url: value.row.url || value.row["네이버예약URL"] || "", rank: count(value.row.overall_rank || value.row["순위"]),
      checkIn: value.start, bookingRangeDays: value.days, weeklyDays: value.days, itemDetails: [],
      // A rejected product/date cannot contribute a fallback price for another
      // date, even if the old failed row retained a numeric price.
      weeklyProductDetails: clone(value.products).map(product => value.exclusions.some(entry => entry.date === product.date && entry.reason !== "RECOVERY_POST_STAY_OBSERVATION")
        ? { ...product, collectionFailed: true } : product),
      nightItemCount: value.nightCount, dayUseItemCount: value.dayCount, countedItemCount: value.nightCount,
      dayUseMode: "detail", dayUsePresence: value.dayCount ? "present" : "absent", dayUseScheduleStatus: value.dayCount ? "requested" : "no_day_use_product" };
    const corrected = applyCompanyManualCorrection(item, clone(projectCompany(company)));
    need(Number(corrected?.inventoryEvidence?.version) >= 4, "RECOVERY_CURRENT_EVIDENCE_UNAVAILABLE");
    const run = { ...value.manifest, id: runId, collectedAt: value.collectedAt, collectedAtSource: "recorded", collectionQuality: null };
    const generated = buildHistoryObservations({ run, availability: { items: [{ ...corrected, companyId: company.companyId }] } }, value.collectedAt);
    need(Array.isArray(generated), "RECOVERY_CURRENT_EVIDENCE_UNAVAILABLE");
    return generated.filter(row => {
      const day = date(row?.stayDate || row?.date), kind = row?.productType === "day-use" ? "dayuse" : row?.productType;
      return day.startsWith(month + "-") && value.verifiedDates[kind]?.includes(day) && Number(row.inventoryEvidenceVersion) >= 4;
    }).map(row => ({ ...row, companyId: company.companyId, companyKey: company.companyId, companyName: company.primaryName,
      runId, collectedAt: value.collectedAt, collectedDate: observedDate(value.collectedAt), stayDate: date(row.stayDate || row.date) }));
  }
  async function checkCatalog(data) { if (typeof data?._companySource?.assertCurrent === "function") await data._companySource.assertCurrent(); }
  async function recoverOwned(input, data) {
    need(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(input?.month) && Array.isArray(input.companyIds) && input.companyIds.length > 0 && input.companyIds.length <= 20,
      "RECOVERY_REQUEST_INVALID");
    const all = companies(data), requested = [...new Set(input.companyIds.map(String))], result = { kind: KIND, month: input.month, companyIds: requested, receipts: [], warnings: [] };
    await checkCatalog(data);
    for (const companyId of requested) {
      const company = all.find(value => value.companyId === companyId); need(company, "RECOVERY_COMPANY_NOT_FOUND");
      const knownRuns = runIds(company);
      for (const run of data.runs) {
        const runId = String(run.id || run.runId || "");
        if (!knownRuns.has(runId) || quality(run) !== "unknown") continue;
        if (date(run.checkIn) && run.checkIn > input.month + "-31") continue;
        try {
          const value = await source(runId, company, all), rows = build(value, company, input.month, runId);
          result.warnings.push(...value.exclusions.filter(value => value.date.startsWith(input.month + "-")).map(value => ({ code: value.reason, companyId, runId, date: value.date })));
          if (!rows.length) { result.warnings.push({ code: "RECOVERY_NO_VALID_DATES", companyId, runId, message: "해당 월에 검증 가능한 상품별 날짜가 없습니다." }); continue; }
          const core = { kind: KIND, validatorVersion: 1, companyId, month: input.month, runId, collectedAt: value.collectedAt,
            originalRunQuality: "unknown", sourceFiles: value.sourceFiles, providerIdentity: value.ids, verifiedDates: value.verifiedDates, exclusions: value.exclusions };
          const receiptId = recoveryRowDigest(core), payload = { ...core, receiptId, createdAt: new Date(now()).toISOString() };
          payload.checksum = recoveryRowDigest(payload);
          await verifyFiles(value.sourceFiles); await checkCatalog(data);
          const targetDirectory = path.join(directory, hash(companyId), input.month), file = path.join(targetDirectory, receiptId + ".json");
          await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
          for (const location of [directory, path.dirname(targetDirectory), targetDirectory]) {
            const info = await fs.lstat(location); need(info.isDirectory() && !info.isSymbolicLink(), "RECOVERY_RECEIPT_PATH_INVALID");
          }
          let created = false;
          try { const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(JSON.stringify(payload) + "\n"); await handle.sync(); created = true; } finally { await handle.close(); } }
          catch (error) { if (error.code !== "EEXIST") throw error; const previous = await receipt(file, receiptId, companyId, input.month);
            need(recoveryRowDigest(receiptCore(previous)) === receiptId, "RECOVERY_RECEIPT_INVALID"); }
          result.receipts.push({ receiptId, companyId, runId, month: input.month, collectedAt: value.collectedAt, verifiedObservationCount: rows.length, created });
        } catch (error) {
          if (["RECOVERY_SOURCE_CHANGED", "MONTHLY_COMPANY_SOURCE_CHANGED", "RECOVERY_RECEIPT_INVALID"].includes(error.code)) throw error;
          result.warnings.push({ code: error.code || "RECOVERY_SOURCE_UNAVAILABLE", companyId, runId, message: "저장 상품 원문의 검증 조건이 부족하여 복구에서 제외했습니다." });
        }
      }
    }
    await checkCatalog(data); return result;
  }
  function receiptCore(value) { const { checksum, receiptId, createdAt, ...core } = value; return core; }
  async function receipt(file, receiptId, companyId, month) {
    const stat = await fs.lstat(file); need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, "RECOVERY_RECEIPT_INVALID");
    const value = JSON.parse(await fs.readFile(file, "utf8")), { checksum, ...body } = value;
    need(object(value) && HEX.test(checksum) && recoveryRowDigest(body) === checksum && value.kind === KIND && value.receiptId === receiptId
      && value.companyId === companyId && value.month === month && value.originalRunQuality === "unknown"
      && recoveryRowDigest(receiptCore(value)) === receiptId && instant(value.collectedAt), "RECOVERY_RECEIPT_INVALID");
    return value;
  }
  async function read(request, data) {
    const all = companies(data), observations = [], warnings = [];
    need(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(request?.month), "RECOVERY_REQUEST_INVALID");
    const targets = request.type === "company" ? all.filter(value => value.companyId === request.targetId) : all;
    await checkCatalog(data);
    for (const company of targets) {
      const targetDirectory = path.join(directory, hash(company.companyId), request.month);
      let names; try { names = await fs.readdir(targetDirectory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const location of [directory, path.dirname(targetDirectory), targetDirectory]) {
        const info = await fs.lstat(location); need(info.isDirectory() && !info.isSymbolicLink(), "RECOVERY_RECEIPT_PATH_INVALID");
      }
      need(names.length <= 10000, "RECOVERY_RECEIPTS_TOO_MANY");
      for (const name of names.sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const saved = await receipt(path.join(targetDirectory, name), name.slice(0, -5), company.companyId, request.month);
          const run = data.runs.find(value => String(value.id || value.runId || "") === saved.runId);
          need(run && quality(run) === "unknown", "RECOVERY_RUN_NOT_LEGACY");
          await verifyFiles(saved.sourceFiles);
          const value = await source(saved.runId, company, all, saved), rows = build(value, company, request.month, saved.runId);
          await verifyFiles(saved.sourceFiles);
          for (const row of rows) observations.push({ row, certificate: { kind: KIND, companyId: company.companyId, runId: saved.runId,
            date: row.stayDate, productType: row.productType, collectedAt: saved.collectedAt, originalRunQuality: "unknown", receiptId: saved.receiptId,
            sourceDigest: recoveryRowDigest({ receiptId: saved.receiptId, sourceFiles: saved.sourceFiles }), rowDigest: recoveryRowDigest(row) } });
        } catch (error) {
          // A previously certified input disappearing/changing is a failed
          // refresh, never an empty successful replacement of the last good
          // company/month. The caller preserves its last validated snapshot.
          if (error.code !== "RECOVERY_RUN_NOT_LEGACY") throw Object.assign(error, { code: error.code || "RECOVERY_SOURCE_UNAVAILABLE", statusCode: 503 });
          warnings.push({ code: error.code, companyId: company.companyId, receiptId: name.slice(0, -5),
            message: "원래 수집 상태가 변경되어 이전 복구 증명은 현재 집계에서 사용하지 않습니다." });
        }
      }
    }
    await checkCatalog(data); return { observations, warnings };
  }
  return { recover: (input, data) => schedule(() => recoverOwned(input, data)), read, directory };
}

module.exports = { createSavedProductRecovery, recoveryRowDigest };
