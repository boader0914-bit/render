"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in location hierarchy card tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function balancedRange(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  assert.notEqual(open, -1, "expected opening brace");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return { close: index, body: source.slice(open + 1, index) };
  }
  assert.fail("expected balanced block");
}

function functionRange(name) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    const character = app[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  return { match, range: balancedRange(app, parameterClose) };
}

function functionSource(name) {
  const { match, range } = functionRange(name);
  return app.slice(match.index, range.close + 1);
}

function functionBlock(name) {
  return functionRange(name).range.body;
}

const context = {
  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};
vm.createContext(context);
for (const name of ["fmtNumber", "fmtRate", "summaryIcon", "locationScoreBand", "renderLocationGroupComparison"]) {
  vm.runInContext(functionSource(name), context);
}

const rows = [
  { card: { searchKeyword: "사천 글램핑" }, runtime: { rate: 0.36, items: Array(5), targets: [] }, score: 72, primaryCluster: "산업평일수요형" },
  { card: { searchKeyword: "산청 글램핑" }, runtime: { rate: 0.39, items: Array(18), targets: [] }, score: 70, primaryCluster: "관광목적형" },
  { card: { searchKeyword: "남해 글램핑" }, runtime: { rate: 0.29, items: Array(2), targets: [] }, score: 68, primaryCluster: "관광목적형" },
  { card: { searchKeyword: "밀양 <글램핑>" }, runtime: { rate: Number.NaN, items: [], targets: [] }, score: 56, primaryCluster: "도심근교 가족형" },
];

const comparison = context.renderLocationGroupComparison(rows);
assert.match(comparison, /class="location-block region-group-section region-group-comparison-section" aria-labelledby="regionGroupComparisonTitle"/);
assert.match(comparison, /role="list" aria-label="하위 지역별 점수와 실제 수집 결과"/);
assert.equal((comparison.match(/class="region-compare-row /g) || []).length, 4, "each fixture region must render one comparison card");
assert.equal((comparison.match(/type="button" role="listitem"/g) || []).length, 4, "comparison cards must remain keyboard-operable buttons");
assert.equal((comparison.match(/data-score-tone="strong"/g) || []).length, 2, "70+ scores must reuse the established strong band");
assert.equal((comparison.match(/data-score-tone="mid"/g) || []).length, 2, "50-69 scores must reuse the established mid band");
assert.match(comparison, /<b>72<\/b><small>점 · 강<\/small>/);
assert.match(comparison, /<b>68<\/b><small>점 · 중<\/small>/);
assert.match(comparison, /업체[\s\S]*?5[\s\S]*?판매[\s\S]*?36%[\s\S]*?후보[\s\S]*?0/);
assert.match(comparison, /업체[\s\S]*?0[\s\S]*?판매[\s\S]*?확인필요[\s\S]*?후보[\s\S]*?0/);
assert.match(comparison, /밀양 &lt;글램핑&gt;/, "region names must remain escaped");
assert.doesNotMatch(comparison, /밀양 <글램핑>/);
assert.doesNotMatch(comparison, /https?:\/\/|\bfetch\s*\(|XMLHttpRequest/, "rendering must not initiate external requests");

const emptyComparison = context.renderLocationGroupComparison([]);
assert.match(emptyComparison, /비교할 하위 지역 카드가 없습니다\./);

const dictionary = functionBlock("renderLocationGroupDictionary");
for (const contract of [
  "location-card region-group-card",
  "region-group-hero",
  "권역-지역 계층 분석",
  "renderLocationGroupComparison(regionRows)",
  "region-group-summary-section",
  "region-group-summary-item is-role",
  "region-group-summary-item is-method",
  "region-group-summary-item is-sales",
  "권역 역할",
  "판단 방식",
  "영업 관점",
]) {
  assert.ok(dictionary.includes(contract), `missing region hierarchy DOM contract: ${contract}`);
}
assert.match(dictionary, /summaryIcon\("tourism"\)/);
assert.match(dictionary, /summaryIcon\("trust"\)/);
assert.match(dictionary, /summaryIcon\("opportunity"\)/);

assert.match(styles, /\.region-compare-row:focus-visible,[\s\S]*?\.region-mini-card:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-border-focus\)[^}]*outline-offset:\s*3px/s, "all region navigation cards must expose a strong focus ring");
assert.match(styles, /\.region-compare-row\s*\{[^}]*min-height:\s*104px[^}]*grid-template-areas:[^}]*"icon copy score"[^}]*"metrics metrics metrics"/s, "comparison cards must expose stable copy, score, and observed-metric areas");
assert.match(styles, /\.region-compare-copy b\s*\{[^}]*overflow-wrap:\s*anywhere|\.region-compare-copy b,[\s\S]*?overflow-wrap:\s*anywhere/s, "long region names must wrap instead of clipping");
assert.match(styles, /\.region-priority-card strong\s*\{[^}]*color:\s*var\(--color-text-primary\)[^}]*line-height:/s);
assert.match(styles, /\.region-mini-card small\s*\{[^}]*color:\s*var\(--color-text-secondary\)[^}]*line-height:/s);
assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.region-compare-row\s*\{[^}]*grid-template-columns:\s*36px minmax\(0, 1fr\) minmax\(62px, auto\)[^}]*grid-template-areas:/s, "320-390px cards must retain explicit non-overlapping columns");
assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.region-compare-metrics > span\s*\{[^}]*min-height:\s*44px/s, "mobile comparison metrics must remain readable touch-sized tiles");

console.log("Location hierarchy card UI contract checks passed");
