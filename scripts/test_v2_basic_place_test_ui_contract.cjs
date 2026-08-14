"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "web", "v2-basic-place-test");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(root, "app.js"), "utf8");
let assertions = 0;

function match(value, pattern) {
  assert.match(value, pattern);
  assertions += 1;
}

function noMatch(value, pattern) {
  assert.doesNotMatch(value, pattern);
  assertions += 1;
}

function equal(value, expected) {
  assert.equal(value, expected);
  assertions += 1;
}

match(html, /<html lang="ko">/u);
match(html, /<meta name="viewport"/u);
match(html, /<main class="app-main">/u);
match(html, /id="collectorForm"/u);
match(html, /id="modeDemo"[^>]*checked/u);
match(html, /id="modeLive"/u);
match(html, /id="keywordInput"[^>]*maxlength="120"/u);
match(html, /id="tokenInput"[^>]*type="password"/u);
match(html, /id="collectButton"/u);
match(html, /role="status" aria-live="polite"/u);
match(html, /role="tablist"/u);
equal((html.match(/role="tab"/gu) || []).length, 3);
equal((html.match(/role="tabpanel"/gu) || []).length, 3);
match(html, /id="panelOrganic"/u);
match(html, /id="panelAds"/u);
match(html, /id="panelDiagnostics"/u);
match(html, /id="downloadJson"[^>]*disabled/u);
match(html, /id="downloadCsv"[^>]*disabled/u);
match(html, /id="bookmarkletLink"[^>]*draggable="true"/u);
match(html, /id="browserAdFile"[^>]*type="file"[^>]*disabled/u);
match(html, /id="clearBrowserAds"[^>]*disabled/u);
match(html, /id="advertisementSource"/u);
match(html, /<template id="rowTemplate">/u);
match(html, /<script src="\/naver-visible-place-ad-contract\.js" defer><\/script>/u);
match(html, /<script src="\/app\.js" defer><\/script>/u);
noMatch(html, /<script(?![^>]*src=)[^>]*>/iu);
noMatch(html, /style="/iu);
noMatch(html, /onclick=|onsubmit=/iu);

match(css, /--green:\s*#08a34a/u);
match(css, /--blue:\s*#2563b9/u);
match(css, /--amber:\s*#b96508/u);
match(css, /grid-template-columns:\s*170px minmax\(260px, 1\.5fr\)/u);
match(css, /table-layout:\s*fixed/u);
match(css, /min-width:\s*960px/u);
match(css, /@media \(max-width: 720px\)/u);
match(css, /prefers-reduced-motion/u);
match(css, /:focus-visible/u);
match(css, /overflow-x:\s*auto/u);
match(css, /\.visually-hidden/u);
match(css, /\.tool-action/u);
match(css, /letter-spacing:\s*0/u);
noMatch(css, /linear-gradient|radial-gradient|conic-gradient/iu);
noMatch(css, /font-size:\s*[^;]*(?:vw|vh)/iu);
noMatch(css, /letter-spacing:\s*-/iu);
noMatch(css, /border-radius:\s*(?:[1-9]\d|9)px/iu);

match(js, /fetch\("\/api\/status"/u);
match(js, /fetch\("\/api\/collect"/u);
match(js, /fetch\("\/naver-ad-bookmarklet\.txt"/u);
match(js, /crypto\?\.randomUUID/u);
match(js, /x-v2-basic-operator-token/u);
match(js, /textContent/u);
match(js, /replaceChildren/u);
match(js, /URL\.createObjectURL/u);
match(js, /current-filter-matched-root-shape-mismatch/u);
match(js, /Live · 네이버 요청 1회/u);
match(js, /Demo · 외부 요청 0회/u);
match(js, /HTTP \$\{error\.providerStatus\}/u);
match(js, /manual-unlimited/u);
match(js, /providerBlocked/u);
match(js, /V2_BASIC_UI_PROVIDER_CIRCUIT_OPEN/u);
match(js, /validateVisibleAdCaptureEnvelope/u);
match(js, /mergeVisibleAdsWithPlaceResult/u);
match(js, /file\.size > 64 \* 1024/u);
match(js, /expectedQuery:\s*serverResult\.keyword/u);
match(js, /advertisementEvidence/u);
noMatch(js, /localStorage|sessionStorage/u);
noMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/u);
noMatch(js, /https?:\/\//u);
noMatch(js, /console\.(?:log|error|warn)/u);

process.stdout.write(`${JSON.stringify({
  event: "v2_basic_place_test_ui_contract_tests_complete",
  assertions,
  externalRequests: 0,
  operationalWrites: 0
})}\n`);
