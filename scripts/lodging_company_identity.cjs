"use strict";

const CATEGORY_KEYS = new Set(["glamping", "campground", "caravan", "pension", "poolVilla", "privateStay", "hotelResort", "motel"]);
const SOURCE_KEYS = new Set(["naver", "nol", "ddnayo", "yeogi_manual", "tourism_public", "manual"]);
const MAX_EVIDENCE = 40;

function text(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function key(value) {
  return text(value).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function addressKey(value) {
  return text(value).replace(/\([^)]*\)/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function phoneKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 12) return "";
  return digits.startsWith("82") ? `0${digits.slice(2)}` : digits;
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function unique(values, limit = 50) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, limit);
}

function sourceKey(value) {
  const compact = key(value);
  if (["naver", "네이버"].includes(compact)) return "naver";
  if (["nol", "yanolja", "놀", "야놀자"].includes(compact)) return "nol";
  if (["ddnayo", "tteonayo", "떠나요"].includes(compact)) return "ddnayo";
  if (["yeogi", "goodchoice", "여기어때", "yeogimanual"].includes(compact)) return "yeogi_manual";
  return SOURCE_KEYS.has(value) ? value : "";
}

function categoryKeys(values) {
  return unique(array(values)).filter((value) => CATEGORY_KEYS.has(value));
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeEvidence(value, fallback = {}) {
  if (typeof value === "string") {
    return {
      categoryKey: fallback.categoryKey || "",
      source: fallback.source || "",
      reason: text(value).slice(0, 180),
      confidence: Number(fallback.confidence || 0),
      observedAt: fallback.observedAt || ""
    };
  }
  if (!value || typeof value !== "object") return null;
  const categoryKey = CATEGORY_KEYS.has(value.categoryKey) ? value.categoryKey : fallback.categoryKey || "";
  const source = sourceKey(value.source) || fallback.source || "";
  const reason = text(value.reason || value.detail || value.evidence).slice(0, 180);
  const confidence = Math.max(0, Math.min(1, Number(value.confidence ?? fallback.confidence) || 0));
  const observedAt = text(value.observedAt || fallback.observedAt).slice(0, 40);
  if (!categoryKey || !reason) return null;
  return { categoryKey, source, reason, confidence, observedAt };
}

function evidenceKey(value = {}) {
  return [value.categoryKey, value.source, key(value.reason)].join("|");
}

function standardizeCompanyObservation(value = {}, defaults = {}) {
  const sourcePlatform = sourceKey(value.sourcePlatform || value.platform || value.channel || defaults.sourcePlatform);
  const detectedCategoryKey = CATEGORY_KEYS.has(value.detectedCategoryKey) ? value.detectedCategoryKey : "";
  const tags = categoryKeys([detectedCategoryKey, ...categoryKeys(value.categoryTags || value.detectedCategoryTags)]);
  const confidence = Math.max(0, Math.min(1, Number(value.categoryConfidence || 0)));
  const observedAt = text(value.observedAt || defaults.observedAt);
  const rawEvidence = array(value.categoryEvidence);
  const categoryEvidence = rawEvidence
    .map((item) => sanitizeEvidence(item, { categoryKey: detectedCategoryKey, source: sourcePlatform, confidence, observedAt }))
    .filter(Boolean);
  if (!categoryEvidence.length && detectedCategoryKey) {
    categoryEvidence.push({
      categoryKey: detectedCategoryKey,
      source: sourcePlatform,
      reason: `${text(value.name)} 유형 판정`,
      confidence,
      observedAt
    });
  }
  return {
    sourcePlatform,
    sourceId: text(value.sourceId || value.placeId || value.platformId),
    name: text(value.name),
    nameKey: key(value.name),
    address: text(value.address || value.location),
    addressKey: addressKey(value.address || value.location),
    region: text(value.region),
    regionKey: key(value.region),
    phone: text(value.phone || value.telephone),
    phoneKey: phoneKey(value.phone || value.telephone),
    latitude: finiteCoordinate(value.latitude ?? value.lat),
    longitude: finiteCoordinate(value.longitude ?? value.lng),
    requestedCategoryKey: CATEGORY_KEYS.has(value.requestedCategoryKey) ? value.requestedCategoryKey : "",
    detectedCategoryKey,
    categoryTags: tags,
    categoryConfidence: confidence,
    categoryEvidence,
    observedAt
  };
}

function distanceMeters(a = {}, b = {}) {
  if (![a.latitude, a.longitude, b.latitude, b.longitude].every((value) => Number.isFinite(value))) return null;
  const radians = (degree) => degree * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function overlap(values = [], target = "", normalizer = text) {
  const normalized = normalizer(target);
  return Boolean(normalized && values.some((value) => normalizer(value) === normalized));
}

function bigramSimilarity(leftValue, rightValue) {
  const left = key(leftValue);
  const right = key(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value) => value.length < 2 ? [value] : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
  const rightCounts = new Map();
  for (const gram of grams(right)) rightCounts.set(gram, (rightCounts.get(gram) || 0) + 1);
  let matches = 0;
  const leftGrams = grams(left);
  for (const gram of leftGrams) {
    const count = rightCounts.get(gram) || 0;
    if (!count) continue;
    matches += 1;
    rightCounts.set(gram, count - 1);
  }
  return (2 * matches) / (leftGrams.length + grams(right).length);
}

function scoreCompanyCandidate(observation, company = {}) {
  const evidence = [];
  const conflicts = [];
  let score = 0;
  const platformIds = company.sourcePlatformIds || {};
  if (observation.sourcePlatform && observation.sourceId && (platformIds[observation.sourcePlatform] || []).includes(observation.sourceId)) {
    score = 100;
    evidence.push(`${observation.sourcePlatform} source ID 일치`);
  }
  if (observation.sourcePlatform === "naver" && observation.sourceId && (company.placeIds || []).includes(observation.sourceId)) {
    score = 100;
    evidence.push("네이버 place ID 일치");
  }
  if (observation.phoneKey && overlap(company.phones || [], observation.phoneKey, phoneKey)) {
    score = Math.max(score, 98);
    evidence.push("전화번호 일치");
  }
  const nameMatched = observation.nameKey && [company.nameKey, ...(company.aliases || []).map(key)].filter(Boolean).includes(observation.nameKey);
  const addressMatched = observation.addressKey && (company.addresses || []).map(addressKey).includes(observation.addressKey);
  const nameSimilarity = Math.max(0, ...[company.primaryName, ...(company.aliases || [])].map((value) => bigramSimilarity(observation.name, value)));
  const partialAddressMatched = !addressMatched && observation.addressKey.length >= 8 && (company.addresses || []).map(addressKey).some((value) => value.length >= 8 && (value.includes(observation.addressKey) || observation.addressKey.includes(value)));
  const regionMatched = !observation.regionKey || !(company.regions || []).length || (company.regions || []).map(key).includes(observation.regionKey);
  if (nameMatched) { score += 38; evidence.push("정규화 업체명 일치"); }
  else if (nameSimilarity >= 0.72) { score += 28; evidence.push(`업체명 유사도 ${Math.round(nameSimilarity * 100)}%`); }
  if (addressMatched) { score += 54; evidence.push("정규화 주소 일치"); }
  else if (partialAddressMatched) { score += 30; evidence.push("주소 부분 일치"); }
  if (regionMatched && observation.regionKey) { score += 12; evidence.push("지역 일치"); }
  if (!regionMatched && observation.regionKey && (company.regions || []).length) {
    score -= 45;
    conflicts.push("지역 불일치");
  }
  const companyPoint = company.coordinates?.[0] || {};
  const meters = distanceMeters(observation, companyPoint);
  if (meters !== null && meters <= 150) { score += 35; evidence.push(`좌표 ${Math.round(meters)}m`); }
  if (meters !== null && meters > 3000) { score -= 40; conflicts.push(`좌표 ${Math.round(meters)}m 불일치`); }
  score = Math.max(0, Math.min(100, score));
  return { companyId: company.companyId || "", score, confidence: score / 100, evidence: unique(evidence), conflicts: unique(conflicts) };
}

function decideCompanyMatch(observationInput = {}, companies = []) {
  const observation = observationInput.nameKey ? observationInput : standardizeCompanyObservation(observationInput);
  const ranked = companies.map((company) => scoreCompanyCandidate(observation, company)).sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  if (!best || best.score < 65) return { decision: "create", score: best?.score || 0, confidence: (best?.score || 0) / 100, matchedCompanyId: "", evidence: best?.evidence || [], conflicts: best?.conflicts || [] };
  if (best.score >= 90 && !best.conflicts.length) return { decision: "merge", score: best.score, confidence: best.confidence, matchedCompanyId: best.companyId, evidence: best.evidence, conflicts: [] };
  return { decision: "review", score: best.score, confidence: best.confidence, matchedCompanyId: best.companyId, evidence: best.evidence, conflicts: best.conflicts };
}

function normalizeCategoryFields(company = {}) {
  const legacy = CATEGORY_KEYS.has(company.categoryKey) ? [company.categoryKey] : [];
  return {
    primaryCategoryKey: CATEGORY_KEYS.has(company.primaryCategoryKey) ? company.primaryCategoryKey : (legacy[0] || ""),
    categoryTags: categoryKeys([...(company.categoryTags || []), ...legacy]),
    categoryConfidence: Math.max(0, Math.min(1, Number(company.categoryConfidence || 0))),
    categoryEvidence: array(company.categoryEvidence).map((item) => sanitizeEvidence(item)).filter(Boolean),
    sourcePlatforms: unique(array(company.sourcePlatforms).map(sourceKey).filter(Boolean)),
    sourcePlatformIds: company.sourcePlatformIds && typeof company.sourcePlatformIds === "object" ? company.sourcePlatformIds : {},
    phones: unique(company.phones || []),
    coordinates: Array.isArray(company.coordinates) ? company.coordinates.filter(Boolean).slice(0, 10) : []
  };
}

function mergeEvidence(existing = [], incoming = []) {
  const byKey = new Map();
  for (const item of [...existing, ...incoming]) {
    const safe = sanitizeEvidence(item);
    if (!safe) continue;
    const id = evidenceKey(safe);
    const previous = byKey.get(id);
    if (!previous || safe.confidence > previous.confidence || String(safe.observedAt).localeCompare(String(previous.observedAt)) > 0) byKey.set(id, safe);
  }
  return [...byKey.values()]
    .sort((a, b) => b.confidence - a.confidence || String(b.observedAt).localeCompare(String(a.observedAt)))
    .slice(0, MAX_EVIDENCE);
}

function categoryResult(company, fields) {
  const manual = company.manualCorrection || {};
  const manualPrimary = CATEGORY_KEYS.has(manual.primaryCategoryKey) ? manual.primaryCategoryKey : "";
  const manualTags = categoryKeys(manual.categoryTags);
  const tags = categoryKeys([...fields.categoryTags, ...manualTags, manualPrimary]);
  const scores = new Map();
  for (const item of fields.categoryEvidence) {
    const current = scores.get(item.categoryKey) || { score: 0, sources: new Set() };
    current.score = Math.max(current.score, item.confidence);
    if (item.source) current.sources.add(item.source);
    scores.set(item.categoryKey, current);
  }
  const ranked = [...scores.entries()].sort((a, b) => {
    const aScore = a[1].score + Math.min(0.04, a[1].sources.size * 0.01);
    const bScore = b[1].score + Math.min(0.04, b[1].sources.size * 0.01);
    if (bScore !== aScore) return bScore - aScore;
    if (a[0] === fields.primaryCategoryKey) return -1;
    if (b[0] === fields.primaryCategoryKey) return 1;
    return 0;
  });
  const automaticPrimary = ranked[0]?.[0] || fields.primaryCategoryKey || tags[0] || "";
  const primaryCategoryKey = manualPrimary || automaticPrimary;
  const automaticConfidence = ranked[0]?.[1]?.score || fields.categoryConfidence || 0;
  return { primaryCategoryKey, categoryTags: categoryKeys([primaryCategoryKey, ...tags]), categoryConfidence: manualPrimary ? 1 : automaticConfidence };
}

function applyObservationToCompany(companyInput = {}, observationInput = {}) {
  const before = JSON.stringify(companyInput);
  const observation = observationInput.nameKey ? observationInput : standardizeCompanyObservation(observationInput);
  const fields = normalizeCategoryFields(companyInput);
  fields.categoryTags = categoryKeys([...fields.categoryTags, ...observation.categoryTags]);
  fields.categoryEvidence = mergeEvidence(fields.categoryEvidence, observation.categoryEvidence);
  fields.sourcePlatforms = unique([...fields.sourcePlatforms, observation.sourcePlatform].filter(Boolean));
  if (observation.sourcePlatform && observation.sourceId) {
    fields.sourcePlatformIds = { ...fields.sourcePlatformIds };
    fields.sourcePlatformIds[observation.sourcePlatform] = unique([...(fields.sourcePlatformIds[observation.sourcePlatform] || []), observation.sourceId], 20);
  }
  fields.phones = unique([...fields.phones, observation.phone]);
  if (Number.isFinite(observation.latitude) && Number.isFinite(observation.longitude)) {
    const point = { latitude: observation.latitude, longitude: observation.longitude };
    fields.coordinates = [...fields.coordinates.filter((item) => distanceMeters(item, point) !== 0), point].slice(-10);
  }
  const selected = categoryResult(companyInput, fields);
  const company = { ...companyInput, ...fields, ...selected };
  return { company, changed: before !== JSON.stringify(company), fieldsChanged: ["primaryCategoryKey", "categoryTags", "categoryConfidence", "categoryEvidence", "sourcePlatforms"].filter((field) => JSON.stringify(companyInput[field]) !== JSON.stringify(company[field])) };
}

function mergeCompanyCategoryProfiles(target = {}, source = {}) {
  const sourceFields = normalizeCategoryFields(source);
  const observation = {
    sourcePlatform: "",
    categoryTags: sourceFields.categoryTags,
    categoryEvidence: sourceFields.categoryEvidence,
    categoryConfidence: sourceFields.categoryConfidence,
    detectedCategoryKey: sourceFields.primaryCategoryKey
  };
  const merged = applyObservationToCompany(target, standardizeCompanyObservation(observation));
  merged.company.sourcePlatforms = unique([...(merged.company.sourcePlatforms || []), ...sourceFields.sourcePlatforms]);
  merged.company.sourcePlatformIds = { ...(merged.company.sourcePlatformIds || {}) };
  for (const [platform, ids] of Object.entries(sourceFields.sourcePlatformIds || {})) {
    merged.company.sourcePlatformIds[platform] = unique([...(merged.company.sourcePlatformIds[platform] || []), ...(ids || [])], 20);
  }
  return merged.company;
}

module.exports = {
  MAX_EVIDENCE,
  applyObservationToCompany,
  decideCompanyMatch,
  mergeCompanyCategoryProfiles,
  normalizeCategoryFields,
  phoneKey,
  scoreCompanyCandidate,
  standardizeCompanyObservation
};
