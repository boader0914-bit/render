"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in collection result card tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

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
    if (depth === 0) return { open, close: index, body: source.slice(open + 1, index) };
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

function cssRulesContaining(selectorFragment) {
  const results = [];
  const matcher = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = matcher.exec(css))) {
    if (match[1].includes(selectorFragment)) {
      results.push({ selector: match[1].trim(), body: match[2], index: match.index });
    }
  }
  return results;
}

// Existing live-region mount and navigation hooks are public UI contracts.
assert.equal((html.match(/id="runApplySummary"/g) || []).length, 1, "#runApplySummary must stay unique");
assert.match(html, /id="runApplySummary"[^>]*aria-live="polite"/);
assert.match(app, /runApplySummary:\s*document\.getElementById\("runApplySummary"\)/);
const renderApplySummary = functionBlock("renderRunResultApplySummary");
assert.match(renderApplySummary, /if\s*\(!isAdminRole\(\)\s*\|\|\s*!els\.runApplySummary\)\s*return/);
assert.match(renderApplySummary, /els\.runApplySummary\.innerHTML\s*=/);
for (const hook of [
  'data-run-result-resume="rank"',
  'data-run-result-resume="historyOps"',
  'data-admin-section-link="database"',
  'data-admin-db-status-link=',
]) {
  assert.ok(renderApplySummary.includes(hook) || app.includes(hook), `existing collection result hook must remain: ${hook}`);
}
assert.ok((app.match(/renderRunResultApplySummary\(\)/g) || []).length >= 3, "collection result summary must remain wired to render and refresh flows");

// Result cards expose meaning as data, text and a local decorative icon instead of color alone.
const metadataSource = functionSource("collectionResultCardMeta");
for (const property of ["key", "tone", "state", "icon"]) {
  assert.match(metadataSource, new RegExp(`\\b${property}\\b(?:\\s*:|\\s*,)`), `collection result metadata must expose ${property}`);
}
assert.match(metadataSource, /good[\s\S]{0,180}success|success[\s\S]{0,180}good/, "legacy good must map to semantic success");
assert.match(metadataSource, /watch[\s\S]{0,180}warning|warning[\s\S]{0,180}watch/, "legacy watch must map to semantic warning");
assert.match(metadataSource, /bad[\s\S]{0,180}danger|danger[\s\S]{0,180}bad/, "legacy bad must map to semantic danger");
assert.match(metadataSource, /neutral/, "unknown or ordinary values need a neutral fallback");

const iconSource = functionSource("collectionResultIconHtml");
assert.match(iconSource, /summaryIcon\(/, "collection result icons must reuse the local inline SVG helper");
assert.match(iconSource, /aria-hidden="true"/, "the result icon wrapper must remain decorative");
const summaryIconSource = functionSource("summaryIcon");
assert.match(summaryIconSource, /<svg\b[^>]*aria-hidden="true"/, "the reused collection result SVG must be decorative");
assert.doesNotMatch(`${iconSource}\n${summaryIconSource}`, /https?:\/\/|<script\b|<img\b/i, "collection result icons must not load external assets");

const outcomeModel = functionBlock("runPurposeOutcomeCards");
assert.equal((outcomeModel.match(/\bcards\s*:\s*\[/g) || []).length, 3, "all three collection purposes must keep a card model");
assert.ok((outcomeModel.match(/collectionResultCardMeta\(\{/g) || []).length >= 11, "direct purpose metrics and the shared status factory must normalize metadata");
assert.ok((outcomeModel.match(/statusCardMeta\(/g) || []).length >= 2, "purpose-specific baseline cards must use the full status metadata factory");
assert.ok((outcomeModel.match(/\bicon\s*:/g) || []).length >= 10, "direct purpose metrics must declare an icon");
assert.ok((outcomeModel.match(/\bstate\s*:/g) || []).length >= 10, "direct purpose metrics must declare an explicit state");
assert.ok((outcomeModel.match(/\btone\s*:/g) || []).length >= 10, "direct purpose metrics must declare an explicit semantic tone");

const outcomeHtml = functionBlock("runPurposeOutcomeHtml");
assert.match(outcomeHtml, /class="run-purpose-result-grid collection-result-grid"/);
assert.match(outcomeHtml, /collectionResultCardHtml\(/);
const cardHtml = functionBlock("collectionResultCardHtml");
assert.match(cardHtml, /collectionResultCardMeta\(/);
assert.match(cardHtml, /class="collection-result-card[^"`]*\$\{legacyClass\}/, "legacy good/watch/bad hooks must remain available on cards");
assert.match(cardHtml, /data-collection-result-key="\$\{/);
assert.match(cardHtml, /data-collection-result-tone="\$\{/);
assert.match(cardHtml, /data-collection-result-state="\$\{/);
assert.match(cardHtml, /collectionResultIconHtml\(/);
assert.match(cardHtml, /collection-result-state/, "cards need a visible textual state independent of color");
assert.match(renderApplySummary, /class="run-apply-grid collection-result-grid"/, "DB application metrics must share the collection grid contract");
assert.doesNotMatch(outcomeHtml, /\bfetch\s*\(|XMLHttpRequest|https?:\/\//, "card rendering must not initiate external requests");

// Layout follows the rendered container width, not only the browser viewport.
const containerRules = [
  ...cssRulesContaining(".run-apply-panel"),
  ...cssRulesContaining(".run-purpose-result"),
];
assert.ok(containerRules.some(({ body }) => /container-type\s*:\s*inline-size/.test(body) || /container\s*:\s*collection-results\s*\/\s*inline-size/.test(body)), "collection result panels must establish an inline-size container");
assert.ok(containerRules.some(({ body }) => /container-name\s*:\s*collection-results/.test(body) || /container\s*:\s*collection-results\s*\/\s*inline-size/.test(body)), "collection result panels must expose the collection-results container name");
assert.match(css, /@container\s+collection-results\s*\(\s*min-width\s*:\s*520px\s*\)[\s\S]*?\.collection-result-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s, "wide collection containers must use four columns");
assert.match(css, /@container\s+collection-results\s*\(\s*min-width\s*:\s*240px\s*\)\s*and\s*\(\s*max-width\s*:\s*519px\s*\)[\s\S]*?\.collection-result-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s, "medium collection containers must use two columns");
assert.match(css, /@container\s+collection-results\s*\(\s*max-width\s*:\s*239px\s*\)[\s\S]*?\.collection-result-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s, "narrow collection containers must use one column");
assert.match(css, /\.collection-result-grid\s*\{[^}]*min-width\s*:\s*0/s, "shared grid must be allowed to shrink safely");
assert.match(css, /\.collection-result-card\s*\{[^}]*min-width\s*:\s*0[^}]*overflow-wrap\s*:\s*anywhere/s, "long result content must wrap inside its card");
assert.match(css, /\.collection-result-card-copy\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s, "card copy must stack in one readable column instead of placing Korean text into narrow grid tracks");
assert.match(css, /@container\s+collection-results\s*\(\s*min-width\s*:\s*760px\s*\)[\s\S]*?\.collection-result-card\s*\{[^}]*grid-template-columns\s*:\s*36px\s+minmax\(0,\s*1fr\)/s, "wide cards may place the icon beside copy only after enough inline space exists");
assert.match(css, /\.run-result-flow\s*\{[^}]*grid-template-columns\s*:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*150px\),\s*1fr\)\)/s, "adjacent result flow copy must collapse from the actual panel width instead of clipping in narrow desktop columns");
const collectionStyleStart = css.indexOf(".run-apply-summary");
const collectionStyleEnd = css.indexOf("/* Admin readability final pass", collectionStyleStart);
const collectionStyles = css.slice(collectionStyleStart, collectionStyleEnd);
assert.doesNotMatch(collectionStyles, /#(?:fff(?:fff)?|b7c6d8|dcecff|d8e3f0|8ae9c8|d3e1ef|b8c7d8)\b/i, "collection result text must use theme tokens instead of dark-only hardcoded colors");
assert.match(collectionStyles, /\.run-apply-panel strong\s*\{[^}]*color\s*:\s*var\(--color-text-primary\)/s, "collection result headings must use the primary text token");
assert.match(collectionStyles, /\.run-apply-panel span,[\s\S]*?color\s*:\s*var\(--color-text-secondary\)/s, "collection result supporting copy must use the secondary text token");

// The late dark-card reset must not erase semantic result surfaces.
const darkResetIndex = css.indexOf("/* Dark transparent card contract v7");
assert.ok(darkResetIndex >= 0, "dark transparent card contract must remain present");
const darkRestorations = cssRulesContaining(".collection-result-card")
  .filter(({ selector, index }) => index > darkResetIndex && /:root\[data-theme="dark"\]/.test(selector));
assert.ok(darkRestorations.length, "semantic collection cards must restore their surface after the dark reset");
assert.ok(darkRestorations.some(({ selector }) => /\.collection-result-card\[data-collection-result-key\]/.test(selector)), "dark surface restoration must use a card attribute selector that outranks the generic transparent reset");
assert.ok(darkRestorations.some(({ body }) => /background(?:-color)?\s*:[^;]*(?:--collection-result-tone|--color-surface-default)[^;]*!important/.test(body)), "dark result cards need an explicit semantic surface restoration");
assert.ok(darkRestorations.some(({ body }) => /border-color\s*:[^;]*(?:--collection-result-tone|--color-border-default)/.test(body)), "dark result cards must retain a non-color-only border cue");

// Disabled actions remain readable; semantic disabled tokens carry the state instead of opacity.
const disabledRules = [
  ...cssRulesContaining(".run-apply-actions button:disabled"),
  ...cssRulesContaining(".run-apply-linked-actions button:disabled"),
];
assert.ok(disabledRules.length, "collection result actions need a disabled contract");
for (const { selector, body } of disabledRules) {
  assert.doesNotMatch(body, /opacity\s*:\s*(?:0?\.[0-9]+|0)(?:\s*!important)?\s*;/, `${selector} must not fade readable disabled content`);
}
assert.ok(disabledRules.some(({ body }) => (
  /opacity\s*:\s*1/.test(body)
  && /border-color\s*:\s*var\(--color-disabled-border\)/.test(body)
  && /background\s*:\s*var\(--color-disabled-surface\)/.test(body)
  && /color\s*:\s*var\(--color-disabled-text\)/.test(body)
)), "collection result disabled actions must use opaque semantic disabled tokens");

assert.doesNotMatch(html, /<(?:link|script)\b[^>]+(?:href|src)="https?:\/\//i, "collection result cards must not add external UI assets");

console.log("Collection result semantic metadata, icons, container layout, dark surfaces, disabled state, and hooks passed");
