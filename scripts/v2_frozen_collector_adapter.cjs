"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const FROZEN_V2_SOURCE_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const FROZEN_V2_SOURCE_DEPLOY_ID = "dep-d9atqu5ckfvc73bubmgg";
const FROZEN_V2_SOURCE_SERVICE_ID = "srv-d8rjrmojs32c73c4tmhg";
const FROZEN_V2_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const FROZEN_V2_COLLECTOR_STRATEGY = "frozen_v2_4e4e190";
const FROZEN_V2_CONTRACT_VERSION = "frozen-v2-collector.v1";
const FROZEN_V2_ADAPTER_VERSION = "v2-frozen-collector-adapter.v1";
const FROZEN_V2_SOURCE_RELATIVE_PATH = "scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs";
const FROZEN_V2_WORKBOOK_BRIDGE_RELATIVE_PATH = "scripts/frozen_v2_4e4e190/runtime/@oai/artifact-tool/index.js";
const FROZEN_V2_NODE_PATH_RELATIVE_PATH = "scripts/frozen_v2_4e4e190/runtime";
const FROZEN_V2_FETCH_SAFETY_PRELOAD_RELATIVE_PATH = "scripts/frozen_v2_4e4e190/runtime/fetch_safety_preload.cjs";
const FROZEN_V2_WORKBOOK_BRIDGE_BLOB = "d19583d7d93703d304dd3590f824efb6cb653e74";
const FROZEN_V2_FETCH_SAFETY_PRELOAD_BLOB = "35f1881ebf083ea34045c050dd8eae152dcbd705";
const FROZEN_V2_PACKAGE_LOCK_BLOB = "6c9f3b2346031a6364b8e27822d009934f41b915";
const FROZEN_V2_WORKBOOK_PACKAGE = "write-excel-file";
const FROZEN_V2_WORKBOOK_PACKAGE_VERSION = "4.1.1";
const FROZEN_V2_CHILD_TIMEOUT_MS = 20 * 60 * 1000;
const FROZEN_V2_STAGING_DIRECTORY = ".frozen-v2-staging";
const FROZEN_V2_MANIFEST_FILE = "manifest.json";
const FROZEN_V2_COMMIT_MARKER_FILE = ".frozen-v2-commit.json";
const FROZEN_V2_COMMIT_MARKER_SCHEMA_VERSION = "frozen-v2-run-commit.v1";
const FROZEN_V2_OVERALL_SUFFIX = "_네이버전체순위.csv";
const MAX_PRIOR_OVERALL_BYTES = 16 * 1024 * 1024;
const MAX_PRIOR_FALLBACK_RUNS = 200;
const MAX_PRIOR_FALLBACK_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_RESULT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const PROVIDER_URL_PATTERN = /https?:\/\/[^\s"'<>\])},]+/giu;
const RAW_HTML_PATTERN = /<(?:!doctype\s+html|html|head|body)\b|window\.__APOLLO_STATE__/iu;
const SPREADSHEET_FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/u;
const FROZEN_CHILD_INHERITED_ENV_ALLOWLIST = Object.freeze(["SystemRoot", "WINDIR"]);

const REGIONAL_GLAMPING_BASES = new Set([
  "경남", "경상남도", "경남도", "경북", "경상북도", "경북도",
  "경기", "경기도", "경기북부", "경기남부", "수도권", "서울근교",
  "강원", "강원도", "춘천", "원주", "강릉", "동해", "태백", "속초", "삼척", "홍천", "횡성", "영월", "평창", "정선", "철원", "화천", "양구", "인제", "고성", "양양",
  "제주", "제주도", "전북", "전라북도", "전북특별자치도", "전남", "전라남도",
  "충남", "충청남도", "충북", "충청북도",
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "포천", "가평", "양평", "연천", "파주", "김포", "강화", "남양주", "양주", "의정부",
  "안성", "이천", "용인", "여주", "평택", "화성", "오산",
  "진주", "사천", "산청", "남해", "하동", "합천", "거창", "함양", "밀양", "김해", "양산", "거제", "통영", "창녕", "함안", "의령", "창원",
  "경주", "포항", "안동", "영천", "문경", "청도", "성주", "칠곡", "김천", "구미", "영주", "상주", "영덕", "울진",
  "전주", "완주", "군산", "익산", "무주", "진안", "장수", "남원", "임실", "순창", "고창", "부안", "정읍",
  "천안", "아산", "공주", "보령", "서산", "당진", "부여", "예산", "홍성", "태안",
  "청주", "충주", "제천", "단양", "괴산", "보은", "옥천", "영동"
]);

const TRUSTED_FROZEN_PAYLOAD = Symbol("trusted-frozen-v2-payload");
const VALIDATED_FROZEN_RUN = Symbol("validated-frozen-v2-run");
const PROMOTED_FROZEN_RUN = Symbol("promoted-frozen-v2-run");

class FrozenV2CollectorAdapterError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "FrozenV2CollectorAdapterError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function adapterError(code, message, statusCode = 500) {
  return new FrozenV2CollectorAdapterError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeText(value, maxLength, fieldName) {
  const text = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw adapterError(
      "FROZEN_V2_PAYLOAD_INVALID",
      `Frozen V2 ${fieldName} is invalid`,
      400
    );
  }
  return text;
}

function compactKeyword(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function looksLikeRegionalGlampingKeyword(value) {
  const compact = compactKeyword(value);
  const suffix = "글램핑";
  if (!compact.endsWith(suffix)) return false;
  const base = compact.slice(0, -suffix.length);
  if (!base || base.length > 10) return false;
  const withoutAdminSuffix = base.replace(/(특별자치도|광역시|특별시|특별자치시|자치도|자치시|시|군|구|도)$/u, "");
  return REGIONAL_GLAMPING_BASES.has(base) || REGIONAL_GLAMPING_BASES.has(withoutAdminSuffix);
}

function normalizeSearchMode(value) {
  const text = String(value || "").trim();
  if (text === "company" || text === "업체명") return "company";
  return "keyword";
}

function normalizeCollectionMode(value) {
  const text = String(value || "").trim();
  return text === "fast" || text === "빠른 순위" || text === "순위 확인" ? "fast" : "precision";
}

function normalizeCollectionPurpose(value) {
  const text = String(value || "").trim();
  if (text === "basic_db" || /basic|master|db|기본/u.test(text)) return "basic_db";
  if (text === "demand_location" || /demand|location|cluster|입지|수요/u.test(text)) return "demand_location";
  return "revenue_detail";
}

function normalizeProductMode(value) {
  const text = String(value || "").trim();
  if (text === "lodging" || text === "숙박") return "lodging";
  if (text === "campnic" || text === "캠프닉" || text === "데이유즈" || text.toLowerCase() === "dayuse") return "campnic";
  return "all";
}

function collectionPurposeDefaultRange(purpose) {
  if (purpose === "basic_db") return "1-50";
  if (purpose === "demand_location") return "1-20";
  return "1-10";
}

function sanitizeClientRequestId(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[^a-z0-9._:-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function normalizeToken(value, allowed, fallback, fieldName) {
  const token = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.has(token)) {
    throw adapterError(
      "FROZEN_V2_PAYLOAD_INVALID",
      `Frozen V2 ${fieldName} is invalid`,
      400
    );
  }
  return token;
}

function normalizeInteger(value, fallback, minimum, maximum, fieldName) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw adapterError(
      "FROZEN_V2_PAYLOAD_INVALID",
      `Frozen V2 ${fieldName} is invalid`,
      400
    );
  }
  return number;
}

function normalizeDate(value, fieldName) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", `Frozen V2 ${fieldName} is invalid`, 400);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", `Frozen V2 ${fieldName} is invalid`, 400);
  }
  return text;
}

function normalizeRankRanges(value, fallback = "1-20", options = {}) {
  const text = String(value ?? "").trim();
  const source = (!text || /^(none|skip|없음)$/iu.test(text)) ? fallback : text;
  if (!source || /^(none|skip|없음)$/iu.test(source)) return "없음";
  const pieces = source.split(/[\s,]+/u).filter(Boolean);
  const ranges = [];
  for (const piece of pieces) {
    const match = piece.match(/^(\d{1,3})(?:[-~](\d{1,3}))?$/u);
    if (!match) continue;
    const left = Number(match[1]);
    const right = Number(match[2] || match[1]);
    const safeLeft = Math.max(1, Math.min(100, Math.floor(left)));
    const safeRight = Math.max(1, Math.min(100, Math.floor(right)));
    if (!Number.isFinite(safeLeft) || !Number.isFinite(safeRight)) continue;
    ranges.push([Math.min(safeLeft, safeRight), Math.max(safeLeft, safeRight)]);
  }
  if (!ranges.length && options.strict === true && text) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 detail rank range is invalid", 400);
  }
  if (!ranges.length && source !== fallback) return normalizeRankRanges(fallback, "");
  if (!ranges.length) return "없음";
  return ranges.map(([left, right]) => left === right ? String(left) : `${left}-${right}`).join(",");
}

function rankCountFromRanges(value) {
  if (!value || /^(none|skip|없음)$/iu.test(String(value))) return 0;
  const ranks = new Set();
  for (const range of String(value || "").split(",")) {
    const [leftText, rightText] = range.split("-");
    const left = Number(leftText);
    const right = Number(rightText || leftText);
    for (let rank = left; rank <= right; rank += 1) ranks.add(rank);
  }
  return Math.min(ranks.size, 20);
}

function kstDateAt(asOf = new Date(), offsetDays = 0) {
  const date = asOf instanceof Date ? new Date(asOf.getTime()) : new Date(asOf);
  if (Number.isNaN(date.getTime())) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 execution time is invalid", 400);
  }
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

function bookingDaysFromRange(checkIn, checkOut) {
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const end = new Date(`${checkOut}T00:00:00.000Z`);
  const diff = Math.round((end.getTime() - start.getTime()) / 86400000);
  return diff > 1 ? Math.min(31, diff + 1) : 1;
}

function resolveBookingRangePlaceLimit(value, bookingRangeDays, fallbackLimit) {
  const fallback = Math.max(0, Math.min(20, Math.floor(Number(fallbackLimit) || 0)));
  const text = String(value ?? "").trim();
  if (!text) return bookingRangeDays > 1 ? fallback : 0;
  const number = Number(text);
  if (!Number.isFinite(number)) return bookingRangeDays > 1 ? fallback : 0;
  return Math.max(0, Math.min(20, Math.floor(number)));
}

function kstRunStamp(asOf = new Date()) {
  const date = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(date.getTime())) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 execution time is invalid", 400);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}_${values.hour}${values.minute}${values.second}`;
}

function normalizeRunStamp(value, asOf) {
  const stamp = value ? String(value).trim() : kstRunStamp(asOf);
  if (!/^\d{8}_\d{6}$/u.test(stamp)) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 run stamp is invalid", 400);
  }
  return stamp;
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function keywordHash(keyword) {
  return crypto.createHash("sha256").update(keyword).digest("hex");
}

function frozenContractSignatureFields(payload) {
  return {
    adapterVersion: FROZEN_V2_ADAPTER_VERSION,
    contractVersion: FROZEN_V2_CONTRACT_VERSION,
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    sourceCommit: FROZEN_V2_SOURCE_COMMIT,
    sourceBlob: FROZEN_V2_COLLECTOR_BLOB,
    keywordHash: keywordHash(payload.keyword),
    searchMode: payload.searchMode,
    collectionMode: payload.collectionMode,
    collectionPurpose: payload.collectionPurpose,
    productMode: payload.productMode,
    checkIn: payload.checkIn,
    checkOut: payload.checkOut,
    adults: payload.adults,
    detailRankRanges: payload.detailRankRanges,
    bookingRangeDays: payload.bookingRangeDays,
    bookingRangePlaceLimit: payload.bookingRangePlaceLimit,
    sourceRole: payload.sourceRole,
    collectionSource: payload.collectionSource
  };
}

function buildFrozenContractHash(payload) {
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  return hashJson(frozenContractSignatureFields(payload));
}

function buildFrozenContractSignature(payload) {
  return `${FROZEN_V2_COLLECTOR_STRATEGY}:${buildFrozenContractHash(payload)}`;
}

function frozenExecutionIdentityFields(payload) {
  return {
    ...frozenContractSignatureFields(payload),
    runStamp: payload.runStamp
  };
}

function buildFrozenExecutionIdentity(payload) {
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  const fields = frozenExecutionIdentityFields(payload);
  return deepFreeze({
    ...fields,
    executionIdentityHash: hashJson(fields)
  });
}

function buildTrustedFrozenPayload(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 payload is invalid", 400);
  }
  const keyword = normalizeText(input.keyword, 120, "keyword");
  const collectionMode = normalizeCollectionMode(input.collectionMode);
  const collectionPurpose = normalizeCollectionPurpose(input.collectionPurpose);
  const productMode = normalizeProductMode(input.productMode);
  const requestedSearchMode = normalizeSearchMode(input.searchMode);
  const searchMode = requestedSearchMode === "company" && looksLikeRegionalGlampingKeyword(keyword)
    ? "keyword"
    : requestedSearchMode;
  const checkIn = normalizeDate(input.checkIn || kstDateAt(options.asOf, 0), "check-in date");
  const checkOut = normalizeDate(input.checkOut || kstDateAt(options.asOf, 6), "check-out date");
  if (checkOut < checkIn) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 date range is invalid", 400);
  }
  const defaultRanks = collectionMode === "fast" ? "" : collectionPurposeDefaultRange(collectionPurpose);
  const detailRankRanges = collectionMode === "fast"
    ? "없음"
    : normalizeRankRanges(input.detailRankRanges ?? input.detailRanks ?? input.rankRanges, defaultRanks, { strict: true });
  const detailPlaceLimit = collectionMode === "fast" ? 0 : (rankCountFromRanges(detailRankRanges) || 10);
  const explicitBookingDays = input.bookingDays || input.bookingRangeDays;
  const explicitBookingDaysNumber = Number(explicitBookingDays);
  const bookingRangeDays = explicitBookingDays
    ? Math.max(1, Math.min(31, Math.round(Number.isFinite(explicitBookingDaysNumber) ? explicitBookingDaysNumber : 7)))
    : bookingDaysFromRange(checkIn, checkOut);
  const collectWeeklyRange = collectionMode !== "fast" && collectionPurpose === "revenue_detail";
  const bookingRangePlaceLimit = collectWeeklyRange
    ? resolveBookingRangePlaceLimit(input.bookingRangePlaceLimit, bookingRangeDays, detailPlaceLimit)
    : 0;
  const sourceRole = normalizeToken(input.sourceRole, new Set(["admin", "b2b"]), "admin", "source role");
  const collectionSource = normalizeToken(
    input.collectionSource,
    new Set(["admin_search", "b2b_search"]),
    sourceRole === "b2b" ? "b2b_search" : "admin_search",
    "collection source"
  );
  const payload = {
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    contractVersion: FROZEN_V2_CONTRACT_VERSION,
    keyword,
    requestedSearchMode,
    searchMode,
    collectionMode,
    collectionPurpose,
    productMode,
    checkIn,
    checkOut,
    adults: normalizeInteger(input.adults, 2, 1, 20, "adult count"),
    detailRankRanges,
    bookingRangeDays,
    bookingRangePlaceLimit,
    sourceRole,
    collectionSource,
    collectionSourceLabel: normalizeText(
      input.collectionSourceLabel || (sourceRole === "b2b" ? "B2B 검색" : "관리자 수집"),
      80,
      "collection source label"
    ),
    runStamp: normalizeRunStamp(options.allowExplicitRunStamp === true ? input.runStamp : "", options.asOf),
    clientRequestId: sanitizeClientRequestId(input.clientRequestId),
    providerAttemptExplicit: input.providerAttemptExplicit === true
  };
  if (
    (payload.sourceRole === "admin" && payload.collectionSource !== "admin_search")
    || (payload.sourceRole === "b2b" && payload.collectionSource !== "b2b_search")
  ) {
    throw adapterError("FROZEN_V2_PAYLOAD_INVALID", "Frozen V2 role and source do not match", 400);
  }
  Object.defineProperty(payload, TRUSTED_FROZEN_PAYLOAD, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });
  return Object.freeze(payload);
}

function isTrustedFrozenPayload(payload) {
  return Boolean(
    payload
    && typeof payload === "object"
    && payload[TRUSTED_FROZEN_PAYLOAD] === true
    && payload.collectorStrategy === FROZEN_V2_COLLECTOR_STRATEGY
    && payload.contractVersion === FROZEN_V2_CONTRACT_VERSION
  );
}

function gitBlobHash(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.from(`blob ${buffer.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(buffer).digest("hex");
}

async function verifyFrozenCollectorIntegrity(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const collectorPath = path.resolve(rootDir, FROZEN_V2_SOURCE_RELATIVE_PATH);
  const relative = path.relative(rootDir, collectorPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw adapterError("FROZEN_V2_SOURCE_PATH_INVALID", "Frozen V2 source path is invalid");
  }
  const stat = await fsp.lstat(collectorPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_SOURCE_MISSING", "Frozen V2 source file is unavailable");
  }
  const content = await fsp.readFile(collectorPath);
  const actualBlob = gitBlobHash(content);
  if (actualBlob !== FROZEN_V2_COLLECTOR_BLOB) {
    throw adapterError("FROZEN_V2_SOURCE_INTEGRITY_FAILED", "Frozen V2 source integrity check failed");
  }
  const dependencySpecs = [
    {
      id: "safe-workbook-bridge",
      relativePath: FROZEN_V2_WORKBOOK_BRIDGE_RELATIVE_PATH,
      expectedBlob: FROZEN_V2_WORKBOOK_BRIDGE_BLOB
    },
    {
      id: "fetch-safety-preload",
      relativePath: FROZEN_V2_FETCH_SAFETY_PRELOAD_RELATIVE_PATH,
      expectedBlob: FROZEN_V2_FETCH_SAFETY_PRELOAD_BLOB
    },
    {
      id: "locked-workbook-dependency",
      relativePath: "package-lock.json",
      expectedBlob: FROZEN_V2_PACKAGE_LOCK_BLOB,
      canonicalLf: true
    }
  ];
  const dependencyClosure = [];
  for (const dependency of dependencySpecs) {
    const dependencyPath = path.resolve(rootDir, dependency.relativePath);
    const dependencyRelative = path.relative(rootDir, dependencyPath);
    if (!dependencyRelative || dependencyRelative.startsWith("..") || path.isAbsolute(dependencyRelative)) {
      throw adapterError("FROZEN_V2_DEPENDENCY_PATH_INVALID", "Frozen V2 dependency path is invalid");
    }
    const dependencyStat = await fsp.lstat(dependencyPath).catch(() => null);
    if (!dependencyStat?.isFile() || dependencyStat.isSymbolicLink()) {
      throw adapterError("FROZEN_V2_DEPENDENCY_MISSING", "Frozen V2 dependency is unavailable");
    }
    const dependencyContent = await fsp.readFile(dependencyPath);
    const rawDependencyBlob = gitBlobHash(dependencyContent);
    const canonicalDependencyBlob = dependency.canonicalLf
      ? gitBlobHash(Buffer.from(dependencyContent.toString("utf8").replace(/\r\n/gu, "\n"), "utf8"))
      : rawDependencyBlob;
    const dependencyBlob = rawDependencyBlob === dependency.expectedBlob
      ? rawDependencyBlob
      : canonicalDependencyBlob;
    if (dependencyBlob !== dependency.expectedBlob) {
      throw adapterError("FROZEN_V2_DEPENDENCY_INTEGRITY_FAILED", "Frozen V2 dependency integrity check failed");
    }
    dependencyClosure.push(Object.freeze({
      id: dependency.id,
      dependencyPath: dependency.relativePath.replaceAll("\\", "/"),
      expectedBlob: dependency.expectedBlob,
      actualBlob: dependencyBlob
    }));
  }
  const [packageManifest, packageLock] = await Promise.all([
    fsp.readFile(path.join(rootDir, "package.json"), "utf8").then(JSON.parse),
    fsp.readFile(path.join(rootDir, "package-lock.json"), "utf8").then(JSON.parse)
  ]).catch(() => {
    throw adapterError("FROZEN_V2_DEPENDENCY_CONTRACT_INVALID", "Frozen V2 dependency contract is invalid");
  });
  if (
    packageManifest?.dependencies?.[FROZEN_V2_WORKBOOK_PACKAGE] !== FROZEN_V2_WORKBOOK_PACKAGE_VERSION
    || packageLock?.packages?.[`node_modules/${FROZEN_V2_WORKBOOK_PACKAGE}`]?.version !== FROZEN_V2_WORKBOOK_PACKAGE_VERSION
    || Object.prototype.hasOwnProperty.call(packageManifest?.dependencies || {}, "xlsx")
  ) {
    throw adapterError("FROZEN_V2_DEPENDENCY_CONTRACT_INVALID", "Frozen V2 dependency contract is invalid");
  }
  return Object.freeze({
    collectorPath,
    sourceCommit: FROZEN_V2_SOURCE_COMMIT,
    expectedBlob: FROZEN_V2_COLLECTOR_BLOB,
    actualBlob,
    byteLength: content.length,
    dependencyClosure: Object.freeze(dependencyClosure),
    workbookPackage: FROZEN_V2_WORKBOOK_PACKAGE,
    workbookPackageVersion: FROZEN_V2_WORKBOOK_PACKAGE_VERSION,
    valid: true
  });
}

function resolvedInside(root, candidate, allowRoot = false) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  if ((allowRoot && !relative) || inside) return absoluteCandidate;
  throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 path escaped its approved root");
}

function safeTaskToken(value) {
  const token = String(value || "").normalize("NFKC").trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
  if (!token || token.length > 120 || token === "." || token === "..") {
    throw adapterError("FROZEN_V2_TASK_ID_INVALID", "Frozen V2 task identity is invalid", 400);
  }
  return token;
}

function frozenStagingContainer(outputsRoot) {
  return path.resolve(outputsRoot, FROZEN_V2_STAGING_DIRECTORY);
}

function buildFrozenTaskStagingPath(outputsRoot, taskId) {
  const container = frozenStagingContainer(outputsRoot);
  const target = path.resolve(container, safeTaskToken(taskId));
  resolvedInside(container, target);
  if (path.dirname(target) !== container) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 staging path is not a direct child");
  }
  return target;
}

async function assertDirectoryWithoutSymlink(directory, options = {}) {
  const stat = await fsp.lstat(directory).catch(() => null);
  if (!stat) {
    if (options.required) throw adapterError("FROZEN_V2_DIRECTORY_MISSING", "Frozen V2 directory is unavailable");
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_SYMLINK_REJECTED", "Frozen V2 directory boundary is unsafe");
  }
  return true;
}

async function createFrozenTaskStaging(options = {}) {
  const outputsRoot = path.resolve(options.outputsRoot || "");
  if (!options.outputsRoot) {
    throw adapterError("FROZEN_V2_OUTPUT_ROOT_REQUIRED", "Frozen V2 output root is required");
  }
  await fsp.mkdir(outputsRoot, { recursive: true });
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  const container = frozenStagingContainer(outputsRoot);
  await fsp.mkdir(container, { recursive: true });
  await assertDirectoryWithoutSymlink(container, { required: true });
  const stagingRoot = buildFrozenTaskStagingPath(outputsRoot, options.taskId);
  try {
    await fsp.mkdir(stagingRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw adapterError("FROZEN_V2_STAGING_EXISTS", "Frozen V2 task staging already exists", 409);
    }
    throw error;
  }
  await assertDirectoryWithoutSymlink(stagingRoot, { required: true });
  return stagingRoot;
}

function isSafeHistoricalRunName(value) {
  return /^[a-z0-9][a-z0-9._-]{0,159}$/iu.test(String(value || ""))
    && String(value).includes("_glamping_");
}

function isSafeOverallFileName(value) {
  const name = String(value || "");
  return name === path.basename(name)
    && name.endsWith(FROZEN_V2_OVERALL_SUFFIX)
    && name.length <= 220
    && !/[\u0000-\u001f\u007f]/u.test(name);
}

async function safeCopyPriorNaverOverallFallbackInputs(options = {}) {
  const payload = options.payload;
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  const outputsRoot = path.resolve(options.outputsRoot || "");
  const stagingRoot = path.resolve(options.stagingRoot || "");
  if (!options.outputsRoot || !options.stagingRoot) {
    throw adapterError("FROZEN_V2_FALLBACK_COPY_INVALID", "Frozen V2 fallback copy roots are required");
  }
  const container = frozenStagingContainer(outputsRoot);
  resolvedInside(container, stagingRoot);
  if (path.dirname(stagingRoot) !== container) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 staging path is not a direct child");
  }
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  await assertDirectoryWithoutSymlink(container, { required: true });
  await assertDirectoryWithoutSymlink(stagingRoot, { required: true });

  const entries = await fsp.readdir(outputsRoot, { withFileTypes: true });
  const sourceRootReal = await fsp.realpath(outputsRoot);
  const seededDirectoryNames = [];
  let copiedFileCount = 0;
  let copiedBytes = 0;
  let omittedFileCount = 0;
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeHistoricalRunName(entry.name)) continue;
    if (options.runStamp && entry.name.endsWith(`_glamping_${options.runStamp}`)) {
      throw adapterError("FROZEN_V2_RUN_EXISTS", "Frozen V2 run identity already exists", 409);
    }
    const sourceRun = path.resolve(outputsRoot, entry.name);
    resolvedInside(outputsRoot, sourceRun);
    await assertDirectoryWithoutSymlink(sourceRun, { required: true });
    const sourceRunReal = await fsp.realpath(sourceRun);
    resolvedInside(sourceRootReal, sourceRunReal);
    const files = await fsp.readdir(sourceRun, { withFileTypes: true });
    const manifestEntry = files.find((file) => file.name === FROZEN_V2_MANIFEST_FILE);
    if (!manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) continue;
    const manifestPath = path.resolve(sourceRun, manifestEntry.name);
    resolvedInside(sourceRunReal, await fsp.realpath(manifestPath));
    const manifestStat = await fsp.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 2 * 1024 * 1024) continue;
    let priorManifest = null;
    try {
      priorManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const sameSearchContract = (
      priorManifest
      && typeof priorManifest === "object"
      && !Array.isArray(priorManifest)
      && priorManifest.collectorStrategy === FROZEN_V2_COLLECTOR_STRATEGY
      && priorManifest.frozenCollector?.sourceBlob === FROZEN_V2_COLLECTOR_BLOB
      && String(priorManifest.keyword || "").normalize("NFC").trim() === payload.keyword
      && String(priorManifest.searchMode || "").trim() === payload.searchMode
      && String(priorManifest.productMode || "").trim() === payload.productMode
      && String(priorManifest.collectionSource || "").trim() === payload.collectionSource
    );
    if (!sameSearchContract) continue;
    const overallFileName = String(priorManifest.fileRoles?.overall || "");
    if (!isSafeOverallFileName(overallFileName)) continue;
    const overall = files.find((file) => file.name === overallFileName && file.isFile() && !file.isSymbolicLink());
    if (!overall) continue;
    const commitState = await readFrozenRunCommitState({ runDirectory: sourceRun, manifest: priorManifest });
    if (!commitState.frozen || !commitState.visible || commitState.reason !== "committed") continue;
    const sourceFile = path.resolve(sourceRun, overall.name);
    resolvedInside(sourceRunReal, await fsp.realpath(sourceFile));
    const sourceStat = await fsp.lstat(sourceFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > MAX_PRIOR_OVERALL_BYTES) {
      omittedFileCount += 1;
      continue;
    }
    candidates.push({ runName: entry.name, fileName: overall.name, sourceFile, size: sourceStat.size });
  }

  const selected = [];
  for (const candidate of candidates.sort((left, right) => right.runName.localeCompare(left.runName, "en"))) {
    if (selected.length >= MAX_PRIOR_FALLBACK_RUNS || copiedBytes + candidate.size > MAX_PRIOR_FALLBACK_TOTAL_BYTES) {
      omittedFileCount += 1;
      continue;
    }
    selected.push(candidate);
    copiedBytes += candidate.size;
  }
  copiedBytes = 0;
  for (const candidate of selected.sort((left, right) => left.runName.localeCompare(right.runName, "en"))) {
    const destinationRun = path.resolve(stagingRoot, candidate.runName);
    resolvedInside(stagingRoot, destinationRun);
    await fsp.mkdir(destinationRun, { recursive: false });
    const destinationFile = path.resolve(destinationRun, candidate.fileName);
    resolvedInside(destinationRun, destinationFile);
    await fsp.copyFile(candidate.sourceFile, destinationFile, fs.constants.COPYFILE_EXCL);
    seededDirectoryNames.push(candidate.runName);
    copiedFileCount += 1;
    copiedBytes += candidate.size;
  }

  return Object.freeze({
    copiedFileCount,
    copiedBytes,
    seededRunCount: seededDirectoryNames.length,
    omittedFileCount,
    truncated: omittedFileCount > 0,
    maxSeededRuns: MAX_PRIOR_FALLBACK_RUNS,
    maxSeededBytes: MAX_PRIOR_FALLBACK_TOTAL_BYTES,
    seededDirectoryNames: Object.freeze(seededDirectoryNames)
  });
}

async function ensureWorkbookBridge(rootDir) {
  const bridgePath = path.resolve(rootDir, FROZEN_V2_WORKBOOK_BRIDGE_RELATIVE_PATH);
  const relative = path.relative(rootDir, bridgePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw adapterError("FROZEN_V2_WORKBOOK_BRIDGE_INVALID", "Frozen V2 workbook bridge path is invalid");
  }
  const stat = await fsp.lstat(bridgePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_WORKBOOK_BRIDGE_MISSING", "Frozen V2 locked workbook bridge is unavailable");
  }
  return bridgePath;
}

async function ensureFetchSafetyPreload(rootDir) {
  const preloadPath = path.resolve(rootDir, FROZEN_V2_FETCH_SAFETY_PRELOAD_RELATIVE_PATH);
  const relative = path.relative(rootDir, preloadPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw adapterError("FROZEN_V2_FETCH_PRELOAD_INVALID", "Frozen V2 fetch safety preload path is invalid");
  }
  const stat = await fsp.lstat(preloadPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_FETCH_PRELOAD_MISSING", "Frozen V2 fetch safety preload is unavailable");
  }
  return preloadPath;
}

async function buildFrozenCollectorSpawnSpec(options = {}) {
  const payload = options.payload;
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const outputsRoot = path.resolve(options.outputsRoot || "");
  const stagingRoot = path.resolve(options.stagingRoot || "");
  if (!options.outputsRoot || !options.stagingRoot) {
    throw adapterError("FROZEN_V2_SPAWN_SPEC_INVALID", "Frozen V2 output and staging roots are required");
  }
  const container = frozenStagingContainer(outputsRoot);
  resolvedInside(container, stagingRoot);
  if (path.dirname(stagingRoot) !== container) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 staging path is not a direct child");
  }
  await assertDirectoryWithoutSymlink(stagingRoot, { required: true });
  const integrity = await verifyFrozenCollectorIntegrity({ rootDir });
  await ensureWorkbookBridge(rootDir);
  const fetchSafetyPreloadPath = await ensureFetchSafetyPreload(rootDir);
  const identity = buildFrozenExecutionIdentity(payload);
  const bridgeNodePath = path.resolve(rootDir, FROZEN_V2_NODE_PATH_RELATIVE_PATH);
  const configDir = path.resolve(options.configDir || path.join(rootDir, "web", "data"));
  const baseEnv = options.baseEnv && typeof options.baseEnv === "object" ? options.baseEnv : process.env;
  const nodeOptions = `--require=${fetchSafetyPreloadPath}`;
  const inheritedEnv = {};
  for (const key of FROZEN_CHILD_INHERITED_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length <= 4096 && !/[\u0000\r\n]/u.test(value)) inheritedEnv[key] = value;
  }
  const env = {
    ...inheritedEnv,
    CHECK_IN: payload.checkIn,
    CHECK_OUT: payload.checkOut,
    ADULTS: String(payload.adults),
    SEARCH_MODE: payload.searchMode,
    COLLECTION_MODE: payload.collectionMode,
    COLLECTION_PURPOSE: payload.collectionPurpose,
    DETAIL_RANK_RANGES: payload.detailRankRanges,
    PRODUCT_MODE: payload.productMode,
    BOOKING_RANGE_DAYS: String(payload.bookingRangeDays),
    BOOKING_RANGE_PLACE_LIMIT: String(payload.bookingRangePlaceLimit),
    SOURCE_ROLE: payload.sourceRole,
    COLLECTION_SOURCE: payload.collectionSource,
    COLLECTION_SOURCE_LABEL: payload.collectionSourceLabel,
    RUN_STAMP: payload.runStamp,
    DATA_DIR: stagingRoot,
    OUTPUTS_DIR: stagingRoot,
    CONFIG_DIR: configDir,
    NODE_PATH: bridgeNodePath,
    NODE_OPTIONS: nodeOptions,
    FROZEN_V2_WORKBOOK_ROOT: stagingRoot,
    REGIONAL_LIMIT: "10",
    REGIONAL_SEARCH_CONCURRENCY: "4",
    NAVER_BOOKING_STOCK_LIMIT: "20",
    NAVER_BOOKING_DETAIL_CONCURRENCY: "2",
    NAVER_SCHEDULE_CONCURRENCY: "4",
    NAVER_SCHEDULE_DELAY_MS: "35",
    NAVER_BOOKING_ID_FALLBACK: "1",
    NAVER_COUPON_PAGE_FALLBACK: "1"
  };
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([integrity.collectorPath, payload.keyword]),
    cwd: rootDir,
    env: Object.freeze(env),
    windowsHide: true,
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    sourceBlob: integrity.actualBlob,
    executionIdentityHash: identity.executionIdentityHash,
    runStamp: payload.runStamp,
    stagingRoot
  });
}

async function prepareFrozenCollectorExecution(options = {}) {
  const payload = options.payload;
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  const identity = buildFrozenExecutionIdentity(payload);
  const taskId = options.taskId || `frozen-${identity.executionIdentityHash.slice(0, 24)}`;
  const stagingRoot = await createFrozenTaskStaging({ outputsRoot: options.outputsRoot, taskId });
  try {
    const fallbackInputs = await safeCopyPriorNaverOverallFallbackInputs({
      outputsRoot: options.outputsRoot,
      stagingRoot,
      runStamp: payload.runStamp,
      payload
    });
    const spawnSpec = await buildFrozenCollectorSpawnSpec({ ...options, payload, stagingRoot });
    return Object.freeze({
      ...spawnSpec,
      taskId: safeTaskToken(taskId),
      fallbackInputs
    });
  } catch (error) {
    await safeCleanupFrozenStaging({ outputsRoot: options.outputsRoot, stagingRoot }).catch(() => {});
    throw error;
  }
}

function parseFrozenCollectorStdoutManifest(stdout) {
  const text = String(stdout || "").trim();
  if (!text || text.length > 2 * 1024 * 1024) {
    throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 collector output is invalid", 502);
  }
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{" && (index === 0 || text[index - 1] === "\n")) starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(text.slice(starts[index]));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the preceding top-level JSON candidate.
    }
  }
  throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 collector manifest was not produced", 502);
}

async function locateSingleFrozenRunDirectory(options = {}) {
  const stagingRoot = path.resolve(options.stagingRoot || "");
  if (!options.stagingRoot || !/^\d{8}_\d{6}$/u.test(String(options.runStamp || ""))) {
    throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 run locator input is invalid", 502);
  }
  await assertDirectoryWithoutSymlink(stagingRoot, { required: true });
  const seeded = new Set(options.seededDirectoryNames || []);
  const entries = await fsp.readdir(stagingRoot, { withFileTypes: true });
  const matches = entries.filter((entry) => (
    entry.isDirectory()
    && !entry.isSymbolicLink()
    && !seeded.has(entry.name)
    && isSafeHistoricalRunName(entry.name)
    && entry.name.endsWith(`_glamping_${options.runStamp}`)
  ));
  if (matches.length !== 1) {
    throw adapterError("FROZEN_V2_RESULT_COUNT_INVALID", "Frozen V2 collector did not produce exactly one run", 502);
  }
  const runId = matches[0].name;
  const runDirectory = path.resolve(stagingRoot, runId);
  resolvedInside(stagingRoot, runDirectory);
  await assertDirectoryWithoutSymlink(runDirectory, { required: true });
  return Object.freeze({ runId, runDirectory });
}

async function assertSafeRunFile(runDirectory, relativeFile) {
  const normalized = String(relativeFile || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw adapterError("FROZEN_V2_RESULT_FILE_INVALID", "Frozen V2 result file path is invalid", 502);
  }
  const target = path.resolve(runDirectory, ...normalized.split("/"));
  resolvedInside(runDirectory, target);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_RESULT_FILE_MISSING", "Frozen V2 result file is unavailable", 502);
  }
  const runReal = await fsp.realpath(runDirectory);
  const fileReal = await fsp.realpath(target);
  resolvedInside(runReal, fileReal);
  return target;
}

async function assertSafeRunTree(runDirectory) {
  const root = path.resolve(runDirectory);
  const rootReal = await fsp.realpath(root);
  const queue = [{ directory: root, depth: 0 }];
  let entryCount = 0;
  while (queue.length) {
    const { directory, depth } = queue.shift();
    if (depth > 8) {
      throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree is too deep", 502);
    }
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > 20000) {
        throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree is too large", 502);
      }
      if (entry.isSymbolicLink()) {
        throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree contains a symbolic link", 502);
      }
      const target = path.resolve(directory, entry.name);
      resolvedInside(root, target);
      const realTarget = await fsp.realpath(target);
      resolvedInside(rootReal, realTarget);
      if (entry.isDirectory()) queue.push({ directory: target, depth: depth + 1 });
      else if (!entry.isFile()) {
        throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree contains an unsupported entry", 502);
      }
    }
  }
  return Object.freeze({ entryCount, valid: true });
}

async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function hashFrozenResultTree(runDirectory) {
  const root = path.resolve(runDirectory);
  await assertDirectoryWithoutSymlink(root, { required: true });
  const rootReal = await fsp.realpath(root);
  const queue = [{ directory: root, relative: "", depth: 0 }];
  const files = [];
  let totalBytes = 0;
  while (queue.length) {
    const current = queue.shift();
    if (current.depth > 8) throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree is too deep", 502);
    for (const entry of await fsp.readdir(current.directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree contains a symbolic link", 502);
      const absolutePath = path.resolve(current.directory, entry.name);
      resolvedInside(root, absolutePath);
      resolvedInside(rootReal, await fsp.realpath(absolutePath));
      const relativePath = path.posix.join(current.relative.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) {
        queue.push({ directory: absolutePath, relative: relativePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree contains an unsupported entry", 502);
      if ([FROZEN_V2_MANIFEST_FILE, FROZEN_V2_COMMIT_MARKER_FILE].includes(relativePath)) continue;
      const stat = await fsp.lstat(absolutePath);
      if (stat.size > MAX_RESULT_FILE_BYTES) throw adapterError("FROZEN_V2_RESULT_FILE_TOO_LARGE", "Frozen V2 result file is too large", 502);
      totalBytes += stat.size;
      if (totalBytes > MAX_RESULT_TREE_BYTES) throw adapterError("FROZEN_V2_RESULT_TREE_TOO_LARGE", "Frozen V2 result tree is too large", 502);
      files.push(Object.freeze({
        path: relativePath,
        size: stat.size,
        sha256: await sha256File(absolutePath)
      }));
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const resultTreeHash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return Object.freeze({
    files: Object.freeze(files),
    fileCount: files.length,
    totalBytes,
    resultTreeHash
  });
}

function parseCsvRecords(text) {
  const source = String(text || "").replace(/^\uFEFF/u, "");
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/u, ""));
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw adapterError("FROZEN_V2_RESULT_CSV_INVALID", "Frozen V2 result CSV is malformed", 502);
  if (cell || row.length) {
    row.push(cell.replace(/\r$/u, ""));
    if (row.some((value) => value !== "")) records.push(row);
  }
  return records;
}

function csvCell(value) {
  const source = String(value ?? "");
  const text = SPREADSHEET_FORMULA_PREFIX.test(source) ? `'${source}` : source;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsvRecords(records) {
  return `\uFEFF${records.map((record) => record.map(csvCell).join(",")).join("\n")}\n`;
}

function sanitizedProviderText(value) {
  return String(value ?? "").replace(PROVIDER_URL_PATTERN, "[provider-url-removed]");
}

function sanitizeJsonValue(value) {
  if (typeof value === "string") return sanitizedProviderText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizeJsonValue(nested)]));
}

function containsRawHtml(value) {
  RAW_HTML_PATTERN.lastIndex = 0;
  const detected = RAW_HTML_PATTERN.test(String(value ?? ""));
  RAW_HTML_PATTERN.lastIndex = 0;
  return detected;
}

async function writeAtomicText(filePath, text) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function sanitizeFrozenRunArtifacts(options = {}) {
  const runDirectory = path.resolve(options.runDirectory || "");
  const stagingRoot = path.resolve(options.stagingRoot || "");
  if (!options.runDirectory || !options.stagingRoot) {
    throw adapterError("FROZEN_V2_SANITIZE_INVALID", "Frozen V2 sanitize input is invalid", 502);
  }
  resolvedInside(stagingRoot, runDirectory);
  if (path.dirname(runDirectory) !== stagingRoot) {
    throw adapterError("FROZEN_V2_SANITIZE_INVALID", "Frozen V2 sanitize path is invalid", 502);
  }
  await assertSafeRunTree(runDirectory);
  const manifestPath = await assertSafeRunFile(runDirectory, FROZEN_V2_MANIFEST_FILE);
  let sanitizedFileCount = 0;
  const queue = [runDirectory];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name);
      resolvedInside(runDirectory, target);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw adapterError("FROZEN_V2_RESULT_TREE_INVALID", "Frozen V2 result tree contains an unsupported entry", 502);
      }
      if (target === manifestPath) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (extension === ".xlsx") continue;
      const stat = await fsp.lstat(target);
      if (stat.size > MAX_RESULT_FILE_BYTES) throw adapterError("FROZEN_V2_RESULT_FILE_TOO_LARGE", "Frozen V2 result file is too large", 502);
      if (extension === ".csv") {
        const records = parseCsvRecords(await fsp.readFile(target, "utf8"));
        if (!records.length) throw adapterError("FROZEN_V2_RESULT_CSV_INVALID", "Frozen V2 result CSV is empty", 502);
        await writeAtomicText(target, serializeCsvRecords(records.map((record) => record.map(sanitizedProviderText))));
      } else if (extension === ".md") {
        const sanitized = sanitizedProviderText(await fsp.readFile(target, "utf8"));
        if (RAW_HTML_PATTERN.test(sanitized)) throw adapterError("FROZEN_V2_RESULT_TEXT_INVALID", "Frozen V2 result text is unsafe", 502);
        await writeAtomicText(target, sanitized);
      } else if (extension === ".json") {
        let value;
        try {
          value = JSON.parse(await fsp.readFile(target, "utf8"));
        } catch {
          throw adapterError("FROZEN_V2_RESULT_JSON_INVALID", "Frozen V2 result JSON is malformed", 502);
        }
        const serialized = `${JSON.stringify(sanitizeJsonValue(value), null, 2)}\n`;
        if (containsRawHtml(serialized)) {
          throw adapterError("FROZEN_V2_RESULT_JSON_INVALID", "Frozen V2 result JSON contains unsafe raw HTML", 502);
        }
        await writeAtomicText(target, serialized);
      } else {
        throw adapterError("FROZEN_V2_RESULT_FILE_TYPE_INVALID", "Frozen V2 result file type is not approved", 502);
      }
      sanitizedFileCount += 1;
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch {
    throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 stored manifest is malformed", 502);
  }
  const sanitizedManifest = sanitizeJsonValue(manifest);
  delete sanitizedManifest.naverAttemptedQueries;
  sanitizedManifest.providerUrlStorage = "redacted";
  const serializedManifest = `${JSON.stringify(sanitizedManifest, null, 2)}\n`;
  if (containsRawHtml(serializedManifest)) {
    throw adapterError("FROZEN_V2_RESULT_JSON_INVALID", "Frozen V2 manifest contains unsafe raw HTML", 502);
  }
  await writeAtomicText(manifestPath, serializedManifest);
  return Object.freeze({ sanitizedFileCount, providerUrlStorage: "redacted" });
}

function csvObjects(records, requiredHeaders = []) {
  if (!Array.isArray(records) || records.length < 1) {
    throw adapterError("FROZEN_V2_RESULT_CSV_INVALID", "Frozen V2 result CSV is invalid", 502);
  }
  const headers = records[0];
  if (!headers.length || new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw adapterError("FROZEN_V2_RESULT_CSV_INVALID", "Frozen V2 result CSV headers are invalid", 502);
  }
  if (requiredHeaders.some((header) => !headers.includes(header))) {
    throw adapterError("FROZEN_V2_RESULT_CSV_INVALID", "Frozen V2 result CSV contract is incomplete", 502);
  }
  const rows = records.slice(1).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
  return Object.freeze({ headers: Object.freeze(headers), rows: Object.freeze(rows) });
}

function detailRankSet(value) {
  const ranks = new Set();
  if (!value || /^(?:none|skip|없음)$/iu.test(String(value))) return ranks;
  for (const piece of String(value).split(",")) {
    const [leftText, rightText] = piece.split("-");
    const left = Number(leftText);
    const right = Number(rightText || leftText);
    if (!Number.isInteger(left) || !Number.isInteger(right)) continue;
    for (let rank = Math.min(left, right); rank <= Math.max(left, right) && ranks.size < 20; rank += 1) ranks.add(rank);
  }
  return ranks;
}

async function validateFrozenArtifactSemantics({ runDirectory, manifest, counts, naverOverall }) {
  const fileRoles = manifest.fileRoles;
  const overallPath = await assertSafeRunFile(runDirectory, fileRoles.overall);
  const overallText = await fsp.readFile(overallPath, "utf8");
  if (PROVIDER_URL_PATTERN.test(overallText) || RAW_HTML_PATTERN.test(overallText)) {
    PROVIDER_URL_PATTERN.lastIndex = 0;
    throw adapterError("FROZEN_V2_RESULT_SENSITIVE_CONTENT", "Frozen V2 result contains prohibited provider content", 502);
  }
  PROVIDER_URL_PATTERN.lastIndex = 0;
  const overall = csvObjects(parseCsvRecords(overallText), [
    "overall_rank",
    "place_id",
    "예약",
    "네이버예약재고수집상태"
  ]);
  if (overall.rows.length !== naverOverall) {
    throw adapterError("FROZEN_V2_PLACE_RESULT_INVALID", "Frozen V2 Place result count does not match the CSV", 502);
  }
  const placeIds = new Set();
  const detailRanks = detailRankSet(manifest.detailRankRanges);
  for (let index = 0; index < overall.rows.length; index += 1) {
    const row = overall.rows[index];
    const rank = Number(row.overall_rank);
    const placeId = String(row.place_id || "").trim();
    if (rank !== index + 1 || rank < 1 || rank > 50 || !placeId || placeIds.has(placeId)) {
      throw adapterError("FROZEN_V2_PLACE_RESULT_INVALID", "Frozen V2 Place ranking is invalid", 502);
    }
    placeIds.add(placeId);
    if (detailRanks.has(rank) && row["예약"] === "Y") {
      const status = String(row["네이버예약재고수집상태"] || "").trim();
      if (!status || /^실패/iu.test(status)) {
        throw adapterError("FROZEN_V2_DETAIL_RESULT_INCOMPLETE", "Frozen V2 requested detail result is incomplete", 502);
      }
    }
  }
  const checked = Number(counts.naverBookingStockChecked);
  const succeeded = Number(counts.naverBookingStockSucceeded);
  if (manifest.collectionMode !== "fast" && succeeded !== checked) {
    throw adapterError("FROZEN_V2_DETAIL_RESULT_INCOMPLETE", "Frozen V2 booking detail result is partial", 502);
  }

  const platformPath = await assertSafeRunFile(runDirectory, fileRoles.platform);
  const platformText = await fsp.readFile(platformPath, "utf8");
  if (PROVIDER_URL_PATTERN.test(platformText) || RAW_HTML_PATTERN.test(platformText)) {
    PROVIDER_URL_PATTERN.lastIndex = 0;
    throw adapterError("FROZEN_V2_RESULT_SENSITIVE_CONTENT", "Frozen V2 platform result contains prohibited provider content", 502);
  }
  PROVIDER_URL_PATTERN.lastIndex = 0;
  csvObjects(parseCsvRecords(platformText), ["channel", "name"]);

  for (const role of ["ads", "regional", "ddnayo"]) {
    if (!fileRoles[role]) continue;
    const rolePath = await assertSafeRunFile(runDirectory, fileRoles[role]);
    const table = csvObjects(parseCsvRecords(await fsp.readFile(rolePath, "utf8")));
    const expectedCount = role === "ads" ? Number(counts.naverAds)
      : role === "regional" ? Number(counts.naverRegional)
        : Number(counts.ddnayo);
    if (Number.isInteger(expectedCount) && expectedCount >= 0 && table.rows.length !== expectedCount) {
      throw adapterError("FROZEN_V2_RESULT_COUNTS_INVALID", "Frozen V2 result count does not match the CSV", 502);
    }
  }

  const reportPath = await assertSafeRunFile(runDirectory, fileRoles.report);
  const report = await fsp.readFile(reportPath, "utf8");
  if (report.trim().length < 32 || PROVIDER_URL_PATTERN.test(report) || RAW_HTML_PATTERN.test(report)) {
    PROVIDER_URL_PATTERN.lastIndex = 0;
    throw adapterError("FROZEN_V2_RESULT_TEXT_INVALID", "Frozen V2 report is invalid", 502);
  }
  PROVIDER_URL_PATTERN.lastIndex = 0;
  for (const role of ["workbook", "naverWorkbook"]) {
    const workbookPath = await assertSafeRunFile(runDirectory, fileRoles[role]);
    const handle = await fsp.open(workbookPath, "r");
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      if (bytesRead !== 4 || !header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw adapterError("FROZEN_V2_RESULT_WORKBOOK_INVALID", "Frozen V2 workbook is invalid", 502);
      }
    } finally {
      await handle.close();
    }
  }
  for (const relativeFile of manifest.detailJsonFiles || []) {
    const detailPath = await assertSafeRunFile(runDirectory, relativeFile);
    try {
      JSON.parse(await fsp.readFile(detailPath, "utf8"));
    } catch {
      throw adapterError("FROZEN_V2_RESULT_JSON_INVALID", "Frozen V2 detail JSON is malformed", 502);
    }
  }
}

function normalizedManifestRankRanges(value) {
  return String(value || "").replace(/\s+/gu, "").replace(/~/gu, "-");
}

async function validateStoredFrozenRunManifest(options = {}) {
  const payload = options.payload;
  if (!isTrustedFrozenPayload(payload)) {
    throw adapterError("FROZEN_V2_PAYLOAD_UNTRUSTED", "Frozen V2 payload is not trusted", 403);
  }
  const located = options.runDirectory && options.runId
    ? { runDirectory: path.resolve(options.runDirectory), runId: String(options.runId) }
    : await locateSingleFrozenRunDirectory({
      stagingRoot: options.stagingRoot,
      runStamp: payload.runStamp,
      seededDirectoryNames: options.seededDirectoryNames
    });
  const stagingRoot = path.resolve(options.stagingRoot || "");
  resolvedInside(stagingRoot, located.runDirectory);
  if (path.dirname(located.runDirectory) !== stagingRoot || path.basename(located.runDirectory) !== located.runId) {
    throw adapterError("FROZEN_V2_RESULT_PATH_INVALID", "Frozen V2 run directory is invalid", 502);
  }
  await assertDirectoryWithoutSymlink(located.runDirectory, { required: true });
  await assertSafeRunTree(located.runDirectory);
  const manifestPath = await assertSafeRunFile(located.runDirectory, FROZEN_V2_MANIFEST_FILE);
  const manifestText = await fsp.readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 stored manifest is malformed", 502);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw adapterError("FROZEN_V2_RESULT_INVALID", "Frozen V2 stored manifest is invalid", 502);
  }
  const manifestOutput = path.resolve(String(manifest.outputDir || ""));
  if (manifestOutput !== located.runDirectory) {
    throw adapterError("FROZEN_V2_RESULT_IDENTITY_MISMATCH", "Frozen V2 stored run identity does not match", 502);
  }
  const fieldsMatch = (
    manifest.keyword === payload.keyword
    && manifest.searchMode === payload.searchMode
    && manifest.collectionMode === payload.collectionMode
    && manifest.collectionPurpose === payload.collectionPurpose
    && manifest.productMode === payload.productMode
    && manifest.checkIn === payload.checkIn
    && manifest.checkOut === payload.checkOut
    && Number(manifest.adults) === payload.adults
    && normalizedManifestRankRanges(manifest.detailRankRanges) === normalizedManifestRankRanges(payload.detailRankRanges)
    && Number(manifest.bookingRangeDays) === payload.bookingRangeDays
    && Number(manifest.bookingRangePlaceLimit) === payload.bookingRangePlaceLimit
    && manifest.sourceRole === payload.sourceRole
    && manifest.collectionSource === payload.collectionSource
  );
  if (!fieldsMatch) {
    throw adapterError("FROZEN_V2_RESULT_CONTRACT_MISMATCH", "Frozen V2 stored manifest contract does not match", 502);
  }
  const counts = manifest.counts && typeof manifest.counts === "object" ? manifest.counts : {};
  const naverOverall = Number(counts.naverOverall);
  if (!Number.isInteger(naverOverall) || naverOverall < 1 || naverOverall > 50) {
    throw adapterError("FROZEN_V2_PLACE_RESULT_INVALID", "Frozen V2 Place result contract is incomplete", 502);
  }
  if (options.expectedNaverOverall !== undefined && naverOverall !== Number(options.expectedNaverOverall)) {
    throw adapterError("FROZEN_V2_PLACE_RESULT_INVALID", "Frozen V2 Place result count does not match", 502);
  }
  for (const countField of ["naverAds", "naverRegional", "naverBookingStockChecked", "naverBookingStockSucceeded"]) {
    const value = Number(counts[countField]);
    if (!Number.isInteger(value) || value < 0) {
      throw adapterError("FROZEN_V2_RESULT_COUNTS_INVALID", "Frozen V2 result counts are invalid", 502);
    }
  }
  const fileRoles = manifest.fileRoles && typeof manifest.fileRoles === "object" ? manifest.fileRoles : {};
  for (const role of ["platform", "report", "overall", "workbook", "naverWorkbook"]) {
    if (!fileRoles[role] || String(fileRoles[role]) !== path.basename(String(fileRoles[role]))) {
      throw adapterError("FROZEN_V2_RESULT_FILE_ROLE_INVALID", "Frozen V2 result file role is invalid", 502);
    }
  }
  if (!String(fileRoles.overall).endsWith(FROZEN_V2_OVERALL_SUFFIX)) {
    throw adapterError("FROZEN_V2_RESULT_FILE_ROLE_INVALID", "Frozen V2 overall result role is invalid", 502);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const requiredFiles = new Set([...Object.values(fileRoles), ...files, ...(manifest.detailJsonFiles || [])]);
  if (!requiredFiles.size) {
    throw adapterError("FROZEN_V2_RESULT_FILE_MISSING", "Frozen V2 result files are unavailable", 502);
  }
  for (const relativeFile of requiredFiles) await assertSafeRunFile(located.runDirectory, relativeFile);

  await validateFrozenArtifactSemantics({
    runDirectory: located.runDirectory,
    manifest,
    counts,
    naverOverall
  });
  const sourceManifestHash = crypto.createHash("sha256").update(manifestText).digest("hex");
  const resultTree = await hashFrozenResultTree(located.runDirectory);

  const identity = buildFrozenExecutionIdentity(payload);
  const validation = {
    runId: located.runId,
    runDirectory: located.runDirectory,
    stagingRoot,
    manifestPath,
    manifest,
    executionIdentityHash: identity.executionIdentityHash,
    sourceBlob: FROZEN_V2_COLLECTOR_BLOB,
    sourceManifestHash,
    resultTreeHash: resultTree.resultTreeHash,
    resultFileCount: resultTree.fileCount,
    resultTotalBytes: resultTree.totalBytes,
    naverOverall,
    valid: true
  };
  Object.defineProperty(validation, VALIDATED_FROZEN_RUN, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });
  return Object.freeze(validation);
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function promoteValidatedFrozenRun(options = {}) {
  const validation = options.validation;
  if (!validation || validation[VALIDATED_FROZEN_RUN] !== true || validation.valid !== true) {
    throw adapterError("FROZEN_V2_PROMOTION_UNVALIDATED", "Frozen V2 run was not validated", 409);
  }
  const outputsRoot = path.resolve(options.outputsRoot || "");
  if (!options.outputsRoot) {
    throw adapterError("FROZEN_V2_OUTPUT_ROOT_REQUIRED", "Frozen V2 output root is required");
  }
  const container = frozenStagingContainer(outputsRoot);
  resolvedInside(container, validation.stagingRoot);
  if (path.dirname(validation.stagingRoot) !== container) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 staging path is not a direct child");
  }
  resolvedInside(validation.stagingRoot, validation.runDirectory);
  if (path.dirname(validation.runDirectory) !== validation.stagingRoot) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 run is not a direct staging child");
  }
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  await assertDirectoryWithoutSymlink(container, { required: true });
  await assertDirectoryWithoutSymlink(validation.stagingRoot, { required: true });
  await assertDirectoryWithoutSymlink(validation.runDirectory, { required: true });
  const finalRunDirectory = path.resolve(outputsRoot, validation.runId);
  resolvedInside(outputsRoot, finalRunDirectory);
  if (path.dirname(finalRunDirectory) !== outputsRoot) {
    throw adapterError("FROZEN_V2_PATH_BOUNDARY_FAILED", "Frozen V2 final run path is invalid");
  }
  if (await fsp.lstat(finalRunDirectory).catch(() => null)) {
    throw adapterError("FROZEN_V2_RUN_EXISTS", "Frozen V2 run already exists", 409);
  }
  const compatibilityManifest = {
    ...validation.manifest,
    outputDir: finalRunDirectory,
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    collectorContractVersion: FROZEN_V2_CONTRACT_VERSION,
    frozenCollector: {
      sourceCommit: FROZEN_V2_SOURCE_COMMIT,
      sourceDeployId: FROZEN_V2_SOURCE_DEPLOY_ID,
      sourceServiceId: FROZEN_V2_SOURCE_SERVICE_ID,
      sourceBlob: FROZEN_V2_COLLECTOR_BLOB,
      adapterVersion: FROZEN_V2_ADAPTER_VERSION,
      executionIdentityHash: validation.executionIdentityHash,
      sourceManifestHash: validation.sourceManifestHash,
      resultTreeHash: validation.resultTreeHash,
      resultFileCount: validation.resultFileCount,
      resultTotalBytes: validation.resultTotalBytes,
      immutableSource: true
    }
  };
  await writeAtomicJson(validation.manifestPath, compatibilityManifest);
  await fsp.rename(validation.runDirectory, finalRunDirectory);
  const promotedTree = await hashFrozenResultTree(finalRunDirectory);
  if (promotedTree.resultTreeHash !== validation.resultTreeHash) {
    await fsp.rm(finalRunDirectory, { recursive: true, force: false }).catch(() => {});
    throw adapterError("FROZEN_V2_PROMOTION_HASH_MISMATCH", "Frozen V2 promoted result hash does not match", 502);
  }
  await safeCleanupFrozenStaging({ outputsRoot, stagingRoot: validation.stagingRoot }).catch(() => {});
  const promoted = {
    runId: validation.runId,
    runDirectory: finalRunDirectory,
    manifest: deepFreeze(compatibilityManifest),
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    executionIdentityHash: validation.executionIdentityHash,
    promoted: true
  };
  Object.defineProperty(promoted, PROMOTED_FROZEN_RUN, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });
  return Object.freeze(promoted);
}

function isFrozenV2RunManifest(manifest) {
  return Boolean(
    manifest
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && (
      manifest.collectorStrategy === FROZEN_V2_COLLECTOR_STRATEGY
      || manifest.frozenCollector?.sourceBlob === FROZEN_V2_COLLECTOR_BLOB
    )
  );
}

function isRecognizedLegacyRunManifest(manifest, runDirectory) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || isFrozenV2RunManifest(manifest)) return false;
  const outputDir = String(manifest.outputDir || "").trim();
  const keyword = String(manifest.keyword || "").trim();
  const overallFile = String(manifest.fileRoles?.overall || "");
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const naverOverall = Number(manifest.counts?.naverOverall);
  return Boolean(
    outputDir
    && path.basename(path.resolve(outputDir)) === path.basename(path.resolve(runDirectory))
    && keyword
    && isSafeOverallFileName(overallFile)
    && files.includes(overallFile)
    && Number.isInteger(naverOverall)
    && naverOverall >= 0
    && naverOverall <= 50
  );
}

function frozenCommitMarkerPath(runDirectory) {
  const root = path.resolve(runDirectory);
  const markerPath = path.resolve(root, FROZEN_V2_COMMIT_MARKER_FILE);
  resolvedInside(root, markerPath);
  return markerPath;
}

async function readFrozenRunCommitState(options = {}) {
  const runDirectory = path.resolve(options.runDirectory || "");
  if (!options.runDirectory) {
    return Object.freeze({ frozen: true, visible: false, reason: "run_directory_required" });
  }
  const markerPath = frozenCommitMarkerPath(runDirectory);
  try {
    await assertDirectoryWithoutSymlink(runDirectory, { required: true });
    const markerStat = await fsp.lstat(markerPath).catch(() => null);
    const manifest = JSON.parse(await fsp.readFile(path.join(runDirectory, FROZEN_V2_MANIFEST_FILE), "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return Object.freeze({ frozen: true, visible: false, reason: "manifest_invalid" });
    }
    if (!isFrozenV2RunManifest(manifest)) {
      const legacyValid = !markerStat && isRecognizedLegacyRunManifest(manifest, runDirectory);
      return Object.freeze({
        frozen: !legacyValid,
        visible: legacyValid,
        reason: legacyValid ? "not_frozen" : "manifest_invalid"
      });
    }
    if (!markerStat) {
      return Object.freeze({ frozen: true, visible: false, reason: "commit_marker_missing" });
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size < 2 || markerStat.size > 64 * 1024) {
      return Object.freeze({ frozen: true, visible: false, reason: "commit_marker_invalid" });
    }
    const markerReal = await fsp.realpath(markerPath);
    resolvedInside(await fsp.realpath(runDirectory), markerReal);
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
    const committedAt = new Date(String(marker?.committedAt || ""));
    const manifestText = await fsp.readFile(path.join(runDirectory, FROZEN_V2_MANIFEST_FILE), "utf8");
    const manifestHash = crypto.createHash("sha256").update(manifestText).digest("hex");
    const resultTree = await hashFrozenResultTree(runDirectory);
    const valid = (
      marker?.schemaVersion === FROZEN_V2_COMMIT_MARKER_SCHEMA_VERSION
      && marker?.state === "committed"
      && marker?.historyAppendSucceeded === true
      && marker?.runId === path.basename(runDirectory)
      && marker?.collectorStrategy === FROZEN_V2_COLLECTOR_STRATEGY
      && marker?.sourceBlob === FROZEN_V2_COLLECTOR_BLOB
      && marker?.executionIdentityHash === manifest.frozenCollector?.executionIdentityHash
      && marker?.resultTreeHash === manifest.frozenCollector?.resultTreeHash
      && marker?.resultTreeHash === resultTree.resultTreeHash
      && Number(marker?.resultFileCount) === resultTree.fileCount
      && Number(marker?.resultTotalBytes) === resultTree.totalBytes
      && marker?.manifestHash === manifestHash
      && !Number.isNaN(committedAt.getTime())
      && committedAt.toISOString() === marker.committedAt
    );
    return Object.freeze({
      frozen: true,
      visible: valid,
      reason: valid ? "committed" : "commit_marker_invalid",
      marker: valid ? Object.freeze({
        schemaVersion: marker.schemaVersion,
        state: marker.state,
        runId: marker.runId,
        committedAt: marker.committedAt,
        resultTreeHash: marker.resultTreeHash
      }) : null
    });
  } catch {
    return Object.freeze({ frozen: true, visible: false, reason: "commit_validation_failed" });
  }
}

async function isVisibleCommittedFrozenRun(runDirectory, manifest = undefined) {
  const input = { runDirectory };
  if (manifest !== undefined) input.manifest = manifest;
  const state = await readFrozenRunCommitState(input);
  return state.frozen ? state.visible : true;
}

async function commitPromotedFrozenRun(options = {}) {
  const promoted = options.promoted;
  if (!promoted || promoted[PROMOTED_FROZEN_RUN] !== true || promoted.promoted !== true) {
    throw adapterError("FROZEN_V2_COMMIT_UNTRUSTED", "Frozen V2 promoted run is not trusted", 409);
  }
  if (!options.history || typeof options.history !== "object" || Array.isArray(options.history)) {
    throw adapterError("FROZEN_V2_HISTORY_COMMIT_REQUIRED", "Frozen V2 history append result is required", 409);
  }
  const outputsRoot = path.resolve(options.outputsRoot || "");
  const runDirectory = path.resolve(promoted.runDirectory || "");
  if (!options.outputsRoot) {
    throw adapterError("FROZEN_V2_OUTPUT_ROOT_REQUIRED", "Frozen V2 output root is required");
  }
  resolvedInside(outputsRoot, runDirectory);
  if (path.dirname(runDirectory) !== outputsRoot || path.basename(runDirectory) !== promoted.runId) {
    throw adapterError("FROZEN_V2_COMMIT_REJECTED", "Frozen V2 commit target is unsafe");
  }
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  await assertDirectoryWithoutSymlink(runDirectory, { required: true });
  const markerPath = frozenCommitMarkerPath(runDirectory);
  if (await fsp.lstat(markerPath).catch(() => null)) {
    throw adapterError("FROZEN_V2_COMMIT_MARKER_EXISTS", "Frozen V2 commit marker already exists", 409);
  }
  const manifestPath = await assertSafeRunFile(runDirectory, FROZEN_V2_MANIFEST_FILE);
  const manifestText = await fsp.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  if (
    !isFrozenV2RunManifest(manifest)
    || manifest.frozenCollector?.executionIdentityHash !== promoted.executionIdentityHash
  ) {
    throw adapterError("FROZEN_V2_COMMIT_REJECTED", "Frozen V2 commit identity is invalid", 409);
  }
  const resultTree = await hashFrozenResultTree(runDirectory);
  if (resultTree.resultTreeHash !== manifest.frozenCollector?.resultTreeHash) {
    throw adapterError("FROZEN_V2_COMMIT_HASH_MISMATCH", "Frozen V2 commit result hash does not match", 502);
  }
  const committedDate = options.committedAt ? new Date(options.committedAt) : new Date();
  if (Number.isNaN(committedDate.getTime())) {
    throw adapterError("FROZEN_V2_COMMIT_TIME_INVALID", "Frozen V2 commit time is invalid", 400);
  }
  const marker = {
    schemaVersion: FROZEN_V2_COMMIT_MARKER_SCHEMA_VERSION,
    state: "committed",
    runId: promoted.runId,
    collectorStrategy: FROZEN_V2_COLLECTOR_STRATEGY,
    sourceBlob: FROZEN_V2_COLLECTOR_BLOB,
    executionIdentityHash: promoted.executionIdentityHash,
    resultTreeHash: resultTree.resultTreeHash,
    resultFileCount: resultTree.fileCount,
    resultTotalBytes: resultTree.totalBytes,
    manifestHash: crypto.createHash("sha256").update(manifestText).digest("hex"),
    historyAppendSucceeded: true,
    historyObservationCount: Math.max(0, Number(options.history.appended) || 0),
    historyReason: String(options.history.reason || "").slice(0, 80),
    committedAt: committedDate.toISOString()
  };
  await writeAtomicJson(markerPath, marker);
  const state = await readFrozenRunCommitState({ runDirectory, manifest });
  if (!state.visible) {
    await fsp.rm(markerPath, { force: true }).catch(() => {});
    throw adapterError("FROZEN_V2_COMMIT_MARKER_INVALID", "Frozen V2 commit marker validation failed", 502);
  }
  return Object.freeze({
    runId: promoted.runId,
    runDirectory,
    committed: true,
    committedAt: marker.committedAt,
    resultTreeHash: marker.resultTreeHash,
    markerFile: FROZEN_V2_COMMIT_MARKER_FILE
  });
}

async function rollbackPromotedFrozenRun(options = {}) {
  const promoted = options.promoted;
  if (!promoted || promoted[PROMOTED_FROZEN_RUN] !== true || promoted.promoted !== true) {
    throw adapterError("FROZEN_V2_ROLLBACK_UNTRUSTED", "Frozen V2 promoted run is not trusted", 409);
  }
  const outputsRoot = path.resolve(options.outputsRoot || "");
  if (!options.outputsRoot) {
    throw adapterError("FROZEN_V2_OUTPUT_ROOT_REQUIRED", "Frozen V2 output root is required");
  }
  const runDirectory = path.resolve(promoted.runDirectory || "");
  resolvedInside(outputsRoot, runDirectory);
  if (path.dirname(runDirectory) !== outputsRoot || path.basename(runDirectory) !== promoted.runId) {
    throw adapterError("FROZEN_V2_ROLLBACK_REJECTED", "Frozen V2 rollback target is unsafe");
  }
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  const stat = await fsp.lstat(runDirectory).catch(() => null);
  if (!stat) return Object.freeze({ removed: false, runId: promoted.runId });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_ROLLBACK_REJECTED", "Frozen V2 rollback target is unsafe");
  }
  if (await fsp.lstat(frozenCommitMarkerPath(runDirectory)).catch(() => null)) {
    throw adapterError("FROZEN_V2_ROLLBACK_COMMITTED", "Committed Frozen V2 run cannot be rolled back", 409);
  }
  await fsp.rm(runDirectory, { recursive: true, force: false });
  return Object.freeze({ removed: true, runId: promoted.runId });
}

async function safeCleanupFrozenStaging(options = {}) {
  const outputsRoot = path.resolve(options.outputsRoot || "");
  const stagingRoot = path.resolve(options.stagingRoot || "");
  if (!options.outputsRoot || !options.stagingRoot) {
    throw adapterError("FROZEN_V2_CLEANUP_INVALID", "Frozen V2 cleanup roots are required");
  }
  const container = frozenStagingContainer(outputsRoot);
  resolvedInside(container, stagingRoot);
  if (path.dirname(stagingRoot) !== container || stagingRoot === container || stagingRoot === outputsRoot) {
    throw adapterError("FROZEN_V2_CLEANUP_REJECTED", "Frozen V2 cleanup target is unsafe");
  }
  await assertDirectoryWithoutSymlink(outputsRoot, { required: true });
  await assertDirectoryWithoutSymlink(container, { required: true });
  const stat = await fsp.lstat(stagingRoot).catch(() => null);
  if (!stat) return Object.freeze({ removed: false });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw adapterError("FROZEN_V2_CLEANUP_REJECTED", "Frozen V2 cleanup target is unsafe");
  }
  await fsp.rm(stagingRoot, { recursive: true, force: false });
  return Object.freeze({ removed: true });
}

module.exports = {
  FROZEN_V2_SOURCE_COMMIT,
  FROZEN_V2_SOURCE_DEPLOY_ID,
  FROZEN_V2_SOURCE_SERVICE_ID,
  FROZEN_V2_COLLECTOR_BLOB,
  FROZEN_V2_COLLECTOR_STRATEGY,
  FROZEN_V2_CONTRACT_VERSION,
  FROZEN_V2_ADAPTER_VERSION,
  FROZEN_V2_SOURCE_RELATIVE_PATH,
  FROZEN_V2_WORKBOOK_BRIDGE_RELATIVE_PATH,
  FROZEN_V2_NODE_PATH_RELATIVE_PATH,
  FROZEN_V2_FETCH_SAFETY_PRELOAD_RELATIVE_PATH,
  FROZEN_V2_WORKBOOK_BRIDGE_BLOB,
  FROZEN_V2_FETCH_SAFETY_PRELOAD_BLOB,
  FROZEN_V2_PACKAGE_LOCK_BLOB,
  FROZEN_V2_WORKBOOK_PACKAGE,
  FROZEN_V2_WORKBOOK_PACKAGE_VERSION,
  FROZEN_V2_CHILD_TIMEOUT_MS,
  FROZEN_V2_STAGING_DIRECTORY,
  FROZEN_V2_COMMIT_MARKER_FILE,
  FROZEN_V2_COMMIT_MARKER_SCHEMA_VERSION,
  FROZEN_V2_OVERALL_SUFFIX,
  MAX_PRIOR_FALLBACK_RUNS,
  MAX_PRIOR_FALLBACK_TOTAL_BYTES,
  FrozenV2CollectorAdapterError,
  gitBlobHash,
  verifyFrozenCollectorIntegrity,
  buildTrustedFrozenPayload,
  isTrustedFrozenPayload,
  frozenContractSignatureFields,
  buildFrozenContractHash,
  buildFrozenContractSignature,
  buildFrozenExecutionIdentity,
  frozenExecutionIdentityFields,
  looksLikeRegionalGlampingKeyword,
  bookingDaysFromRange,
  kstRunStamp,
  frozenStagingContainer,
  buildFrozenTaskStagingPath,
  createFrozenTaskStaging,
  safeCopyPriorNaverOverallFallbackInputs,
  buildFrozenCollectorSpawnSpec,
  prepareFrozenCollectorExecution,
  parseFrozenCollectorStdoutManifest,
  locateSingleFrozenRunDirectory,
  assertSafeRunTree,
  hashFrozenResultTree,
  sanitizeFrozenRunArtifacts,
  validateStoredFrozenRunManifest,
  promoteValidatedFrozenRun,
  isFrozenV2RunManifest,
  isRecognizedLegacyRunManifest,
  readFrozenRunCommitState,
  isVisibleCommittedFrozenRun,
  commitPromotedFrozenRun,
  rollbackPromotedFrozenRun,
  safeCleanupFrozenStaging
};
