"use strict";

const PLATFORM_ALIASES = [
  { key: "stayfolio", label: "스테이폴리오", aliases: ["스테이폴리오", "stayfolio"] }
];

const CATEGORY_ALIASES = [
  { key: "poolVilla", aliases: ["독채풀빌라", "풀빌라펜션", "풀빌라"] },
  { key: "privateStay", aliases: ["프라이빗스테이", "독채스테이", "한옥스테이", "감성숙소"] },
  { key: "campground", aliases: ["오토캠핑장", "글램핑캠핑장", "캠핑장", "야영장"] },
  { key: "glamping", aliases: ["글램핑장", "글램핑"] },
  { key: "pension", aliases: ["키즈펜션", "스파펜션", "애견펜션", "펜션"] },
  { key: "caravan", aliases: ["카라반"] },
  { key: "hotelResort", aliases: ["리조트", "콘도", "호텔"] },
  { key: "motel", aliases: ["모텔"] }
];

const GENERIC_LODGING_TERMS = ["숙박", "숙소"];
const AMBIGUOUS_STAY_TERM = "스테이";
const ADMIN_SUFFIX_RE = /(특별자치도|특별자치시|광역시|자치도|자치시|시|군|구|도)$/u;

function normalizeKeyword(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compactKeyword(value) {
  return normalizeKeyword(value).replace(/\s+/g, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripAdminSuffix(value) {
  return normalizeKeyword(value).replace(ADMIN_SUFFIX_RE, "");
}

function categoryMatch(keyword) {
  const compact = compactKeyword(keyword);
  for (const category of CATEGORY_ALIASES) {
    const aliases = [...category.aliases].sort((a, b) => b.length - a.length);
    const alias = aliases.find((item) => compact.includes(compactKeyword(item)));
    if (alias) return { key: category.key, alias };
  }
  return null;
}

function platformMatch(keyword) {
  const compact = compactKeyword(keyword);
  for (const platform of PLATFORM_ALIASES) {
    const alias = platform.aliases.find((item) => compact.includes(compactKeyword(item)));
    if (alias) return { ...platform, alias };
  }
  return null;
}

function regionEntries(regionMap = {}) {
  const entries = [];
  const provinces = regionMap.provinceAliases || {};
  for (const [key, item] of Object.entries(provinces)) {
    const aliases = unique([item.sido, item.sidoFull, ...(item.aliases || [])]);
    entries.push({
      key,
      canonicalName: item.sidoFull || item.sido || aliases[0] || key,
      aliases: unique([...aliases, ...aliases.map(stripAdminSuffix)]),
      priority: 10
    });
  }
  for (const item of regionMap.regions || []) {
    const aliases = unique([
      item.sigungu,
      stripAdminSuffix(item.sigungu),
      ...(item.aliases || []).map((alias) => {
        let result = normalizeKeyword(alias);
        for (const category of CATEGORY_ALIASES) {
          for (const suffix of category.aliases) {
            result = result.replace(new RegExp(`${suffix}$`, "u"), "").trim();
          }
        }
        return result;
      })
    ]);
    entries.push({
      key: item.regionKey || `${item.sidoKey || "region"}_${item.sigungu || ""}`,
      canonicalName: [item.sidoFull || item.sido, item.sigungu].filter(Boolean).join(" "),
      aliases: unique([...aliases, ...aliases.map(stripAdminSuffix)]),
      priority: Number(item.matchPriority || 50)
    });
  }
  return entries;
}

function findRegion(keyword, regionMap) {
  const compact = compactKeyword(keyword);
  const matches = [];
  for (const entry of regionEntries(regionMap)) {
    for (const alias of entry.aliases) {
      const compactAlias = compactKeyword(alias);
      if (!compactAlias || compactAlias.length < 2) continue;
      const index = compact.indexOf(compactAlias);
      if (index < 0) continue;
      matches.push({
        ...entry,
        alias,
        compactAlias,
        index,
        score: compactAlias.length * 100 + entry.priority
      });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  return matches[0] || null;
}

function removeFirstCompact(source, target) {
  const compact = compactKeyword(source);
  const compactTarget = compactKeyword(target);
  const index = compact.indexOf(compactTarget);
  if (index < 0) return compact;
  return `${compact.slice(0, index)}${compact.slice(index + compactTarget.length)}`;
}

function removeKnownParts(keyword, parts) {
  return parts.filter(Boolean).reduce((text, part) => removeFirstCompact(text, part), compactKeyword(keyword));
}

function candidate(mode, query, extras = {}) {
  return { mode, query: normalizeKeyword(query), ...extras };
}

function resolveLodgingSearchIntent(value, options = {}) {
  const originalKeyword = String(value || "");
  const normalizedKeyword = normalizeKeyword(value);
  if (!normalizedKeyword) {
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "unknown",
      region: null,
      companyName: "",
      lodgingCategoryKey: "",
      platformKey: "",
      confidence: 0,
      evidence: ["검색어가 비어 있습니다."],
      searchCandidates: []
    };
  }

  const platform = platformMatch(normalizedKeyword);
  const category = platform ? null : categoryMatch(normalizedKeyword);
  const region = findRegion(normalizedKeyword, options.regionMap || {});
  const genericTerm = GENERIC_LODGING_TERMS.find((term) => compactKeyword(normalizedKeyword).includes(term)) || "";
  const hasAmbiguousStay = !platform && compactKeyword(normalizedKeyword).includes(AMBIGUOUS_STAY_TERM);
  const removedParts = [platform?.alias, region?.alias, category?.alias, genericTerm];
  const remainder = removeKnownParts(normalizedKeyword, removedParts);
  const companyRemainder = removeKnownParts(normalizedKeyword, [region?.alias]);
  const evidence = [];

  if (platform) evidence.push(`${platform.label}: 플랫폼명 일치`);
  if (region) evidence.push(`${region.alias}: 지역 사전 일치`);
  if (category) evidence.push(`${category.alias}: 숙소 유형 일치`);
  if (genericTerm) evidence.push(`${genericTerm}: 숙박 일반 검색어`);
  if (hasAmbiguousStay) evidence.push("스테이: 단독으로 숙소 유형을 확정하지 않음");

  const regionResult = region ? {
    key: region.key,
    query: region.alias,
    canonicalName: region.canonicalName,
    confidence: region.compactAlias.length >= 3 ? 0.98 : 0.94
  } : null;

  if (platform) {
    const platformRemainder = removeKnownParts(normalizedKeyword, [platform.alias, region?.alias]);
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "platform_search",
      region: regionResult,
      companyName: platformRemainder,
      lodgingCategoryKey: "",
      platformKey: platform.key,
      confidence: region ? 0.98 : 0.99,
      evidence,
      searchCandidates: [candidate("platform", normalizedKeyword, { platformKey: platform.key })]
    };
  }

  const onlyRegionAndType = Boolean(region && !remainder && (category || genericTerm));
  if (onlyRegionAndType) {
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "region_search",
      region: regionResult,
      companyName: "",
      lodgingCategoryKey: category?.key || "",
      platformKey: "",
      confidence: category ? 0.98 : 0.9,
      evidence,
      searchCandidates: [candidate("keyword", normalizedKeyword, { regionKey: region.key, lodgingCategoryKey: category?.key || "" })]
    };
  }

  if (region && remainder && hasAmbiguousStay && remainder === AMBIGUOUS_STAY_TERM) {
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "region_search",
      region: regionResult,
      companyName: "",
      lodgingCategoryKey: "",
      platformKey: "",
      confidence: 0.68,
      evidence,
      searchCandidates: [
        candidate("keyword", normalizedKeyword, { regionKey: region.key }),
        candidate("company", normalizedKeyword, { regionKey: region.key, ambiguous: true })
      ]
    };
  }

  if (region && remainder) {
    evidence.push(`${companyRemainder}: 업체명 후보`);
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "company_in_region",
      region: regionResult,
      companyName: companyRemainder,
      lodgingCategoryKey: category?.key || "",
      platformKey: "",
      confidence: category ? 0.94 : 0.82,
      evidence,
      searchCandidates: [candidate("company", normalizedKeyword, { regionKey: region.key })]
    };
  }

  if (region) {
    return {
      originalKeyword,
      normalizedKeyword,
      intent: "region_search",
      region: regionResult,
      companyName: "",
      lodgingCategoryKey: category?.key || "",
      platformKey: "",
      confidence: 0.9,
      evidence,
      searchCandidates: [candidate("keyword", normalizedKeyword, { regionKey: region.key })]
    };
  }

  const companyConfidence = category ? 0.86 : (hasAmbiguousStay ? 0.72 : 0.62);
  evidence.push(`${compactKeyword(normalizedKeyword)}: 업체명 또는 자유 검색어 후보`);
  return {
    originalKeyword,
    normalizedKeyword,
    intent: "company_search",
    region: null,
    companyName: compactKeyword(normalizedKeyword),
    lodgingCategoryKey: category?.key || "",
    platformKey: "",
    confidence: companyConfidence,
    evidence,
    searchCandidates: companyConfidence < 0.8
      ? [candidate("company", normalizedKeyword), candidate("keyword", normalizedKeyword, { ambiguous: true })]
      : [candidate("company", normalizedKeyword)]
  };
}

const lodgingSearchIntentApi = {
  CATEGORY_ALIASES,
  PLATFORM_ALIASES,
  compactKeyword,
  normalizeKeyword,
  regionEntries,
  resolveLodgingSearchIntent
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = lodgingSearchIntentApi;
}
if (typeof globalThis !== "undefined") {
  globalThis.LodgingSearchIntent = lodgingSearchIntentApi;
}
