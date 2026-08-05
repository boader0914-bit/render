"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({
  allowLocalhost: false,
  label: "region analysis responsive contract fixture"
});

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function balancedBlockFrom(source, marker, openCharacter = "{", closeCharacter = "}") {
  const markerIndex = typeof marker === "number" ? marker : source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing source marker: ${marker}`);
  const openIndex = source.indexOf(openCharacter, markerIndex);
  assert.notEqual(openIndex, -1, `missing opening ${openCharacter} after ${marker}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
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
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  assert.fail(`unbalanced block after ${marker}`);
}

function functionBlock(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let depth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    if (app[index] === "(") depth += 1;
    if (app[index] === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  return balancedBlockFrom(app, app.indexOf("{", parameterClose));
}

function cssRule(selectorPattern, message) {
  const match = selectorPattern.exec(css);
  assert.ok(match, message);
  return balancedBlockFrom(css, match.index);
}

try {
  // One shared, live-updating context must precede role-specific region panels.
  const contextTag = /<[^>]+\bid="regionAnalysisContext"[^>]*>/i.exec(html)?.[0] || "";
  assert.ok(contextTag, "the integrated region analysis surface needs one shared context");
  assert.match(contextTag, /class="[^"]*\bregion-analysis-context\b[^"]*"/);
  assert.match(contextTag, /role="status"/);
  assert.match(contextTag, /aria-live="polite"/);
  assert.equal((html.match(/id="regionAnalysisContext"/g) || []).length, 1, "the shared region context must exist exactly once");
  assert.match(app, /regionAnalysisContext:\s*document\.getElementById\("regionAnalysisContext"\)/);

  const contextRenderer = functionBlock("renderRegionAnalysisContext");
  for (const field of [
    "regionKey",
    "runId",
    "measurementPeriod",
    "asOf",
    "publicationVersion",
    "freshness",
    "coverage",
    "matchStatus"
  ]) {
    assert.match(contextRenderer, new RegExp(field), `shared region context must render ${field}`);
  }
  assert.match(contextRenderer, /지역 분석 미연결|unmatched|ambiguous|inactive/, "non-canonical context must be explicit rather than silently substituted");
  assert.doesNotMatch(contextRenderer, /\?\?\s*0\b|\|\|\s*50\b/, "shared context must not replace missing observations with zero or 50");

  // Tabs and their panels retain complete WAI-ARIA relationships for both roles.
  assert.match(html, /id="regionAnalysisTabs"[^>]*role="tablist"[^>]*aria-label=/);
  const panelIds = ["map", "demand", "dictionary", "regionInsight", "reviewPublish"];
  for (const panelId of panelIds) {
    const panelTag = new RegExp(`<section\\b[^>]*id="${panelId}Panel"[^>]*>`, "i").exec(html)?.[0] || "";
    assert.ok(panelTag, `missing ${panelId} region analysis panel`);
    assert.match(panelTag, /role="tabpanel"/, `${panelId} must expose role=tabpanel`);
    assert.match(panelTag, new RegExp(`aria-labelledby="regionAnalysisTab-${panelId}"`), `${panelId} must reference its owning tab`);
  }
  const tabRenderer = functionBlock("renderRegionAnalysisNavigation");
  assert.match(tabRenderer, /role="tab"/);
  assert.match(tabRenderer, /aria-controls=/);
  assert.match(tabRenderer, /aria-selected/);
  assert.match(tabRenderer, /button\.tabIndex\s*=\s*tabState\.tabIndex/);
  assert.match(functionBlock("handleRegionAnalysisTabKeydown"), /ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/);
  assert.match(app, /admin:\s*Object\.freeze\(\["map", "demand", "dictionary", "reviewPublish"\]\)/);
  assert.match(app, /b2b:\s*Object\.freeze\(\["map", "demand", "regionInsight"\]\)/);

  // Horizontal tab overflow must stay inside the component and all tabs remain touch-sized.
  const rootTokens = balancedBlockFrom(css, css.indexOf(":root"));
  assert.match(rootTokens, /--touch-target-min:\s*44px/);
  const tabListRule = cssRule(/\.region-analysis-tabs\s*\{/, "missing region analysis tab-list styles");
  assert.match(tabListRule, /min-width:\s*0/);
  assert.match(tabListRule, /overflow-x:\s*auto/);
  assert.match(tabListRule, /overflow-y:\s*hidden/);
  const tabRule = cssRule(/\.region-analysis-tabs\s+\[role="tab"\]\s*\{/, "missing region analysis tab styles");
  assert.match(tabRule, /min-height:\s*var\(--touch-target-min\)/);
  assert.match(tabRule, /min-width:\s*max-content/);
  assert.match(css, /\.region-analysis-tabs\s+\[role="tab"\]:focus-visible\s*\{[^}]*outline:/s);

  // The 320/390 layout must collapse context grids and allow long identifiers and messages to wrap.
  const contextRule = cssRule(/\.region-analysis-context\s*\{/, "missing shared region context styles");
  assert.match(contextRule, /min-width:\s*0/);
  assert.match(contextRule, /(?:background|color):\s*(?:color-mix\([^;]*var\(--color-|var\(--color-)/, "context surface must consume semantic colors");
  const contextGridRule = cssRule(/\.region-analysis-context-grid\s*\{/, "missing shared region context grid styles");
  assert.match(contextGridRule, /min-width:\s*0/);
  assert.match(contextGridRule, /grid-template-columns:/);
  assert.match(
    css,
    /\.region-analysis-context[^{}]*(?:,\s*[^{}]+)*\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    "long canonical keys and context messages must wrap"
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*390px\)\s*\{[\s\S]*?\.region-analysis-context-grid\s*\{[^}]*grid-template-columns:\s*1fr/s,
    "the common context must collapse to one column at 390px and therefore at 320px"
  );
  for (const selector of [
    "region-insight-publication-head",
    "region-review-head",
    "region-insight-warning",
    "region-insight-feedback",
    "region-analysis-placeholder"
  ]) {
    assert.match(
      css,
      new RegExp(`\\.${selector}[\\s\\S]{0,900}?overflow-wrap:\\s*anywhere`),
      `${selector} must wrap long region names, statuses, or errors`
    );
  }

  // Region UI must remain native in both themes and avoid light-only literal colors.
  for (const theme of ["light", "dark"]) {
    const themeRule = cssRule(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{`), `missing ${theme} theme tokens`);
    for (const token of ["color-surface-default", "color-text-primary", "color-text-secondary", "color-border-default", "color-border-focus", "color-action-primary", "color-status-warning", "color-status-danger"]) {
      assert.match(themeRule, new RegExp(`--${token}:`), `${theme} theme is missing --${token}`);
    }
  }
  const regionContractStart = css.indexOf("/* Region analysis navigation contract v1. */");
  assert.notEqual(regionContractStart, -1, "missing bounded region analysis CSS contract");
  const regionContractEnd = css.indexOf("body.role-admin {", regionContractStart);
  assert.ok(regionContractEnd > regionContractStart, "region analysis CSS contract must be bounded");
  const regionContract = css.slice(regionContractStart, regionContractEnd);
  assert.match(regionContract, /var\(--color-surface-/);
  assert.match(regionContract, /var\(--color-text-/);
  assert.match(regionContract, /var\(--color-border-/);
  assert.doesNotMatch(regionContract, /#[0-9a-f]{3,8}\b|rgba?\s*\(/i, "region analysis UI must not add light- or dark-only literal colors");

  // No region animation is allowed outside a reduced-motion override.
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(regionContract, /scroll-behavior:\s*smooth|animation(?:-name)?:\s*(?!none\b)/i);

  // Visible words, not color alone, communicate publication, freshness, and evidence states.
  assert.match(functionBlock("b2bRegionInsightHtml"), /publication\.status/);
  assert.match(functionBlock("b2bRegionInsightHtml"), /freshness\.status/);
  assert.match(functionBlock("renderAdminRegionInsightWorkbench"), /row\.status/);

  // `missing` means unknown: neither the SNS row nor seed coverage may display a fabricated zero.
  const evidenceRows = functionBlock("adminRegionInsightEvidenceRows");
  const snsRow = /\{\s*source:\s*"SNS"[\s\S]*?\},/.exec(evidenceRows)?.[0] || "";
  assert.ok(snsRow, "missing SNS evidence fixture row");
  assert.match(snsRow, /status:\s*"missing"/);
  assert.doesNotMatch(snsRow, /sample:\s*["'`]\s*0(?:\s*건)?\s*["'`]/, "missing SNS evidence must not be presented as zero");
  assert.match(snsRow, /sample:\s*["'`](?:미수집|표본 없음|관측 없음|확인되지 않음)["'`]/);
  const draftSeed = functionBlock("adminRegionInsightDraftSeed");
  assert.match(
    draftSeed,
    /qualityStatus\s*===\s*"missing"[\s\S]*?coverage[\s\S]*?numerator:\s*null[\s\S]*?denominator:\s*null/,
    "a missing draft must preserve unknown coverage as null/null"
  );
  const scoreModelRenderer = functionBlock("renderLocationScoreModel");
  assert.match(
    scoreModelRenderer,
    /component\?\.observed\s*===\s*true/,
    "location score components must consult the explicit observation flag"
  );
  assert.doesNotMatch(
    scoreModelRenderer,
    /Number\.isFinite\(Number\(component\.value\)\)\s*\?\s*fmtNumber/,
    "null location observations must not render as the numeric value zero"
  );
  assert.match(scoreModelRenderer, /dataQuality\.grade/);
  assert.match(scoreModelRenderer, /dataQuality\.penalties/);
  assert.doesNotMatch(
    scoreModelRenderer,
    /<span>데이터 신뢰도<\/span>[\s\S]{0,180}?fmtNumber\(scoreModel\.confidence/,
    "data quality must render its grade and penalties instead of a neutral-looking numeric placeholder"
  );

  assert.equal(networkGuard.blockedAttempts(), 0, "responsive contract fixtures must make no network requests");
  console.log("Region analysis responsive, accessibility, theme, and missing-value contract checks passed");
} finally {
  networkGuard.restore();
}
