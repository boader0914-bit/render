"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in administrator operations UI contract tests: ${url}`);
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

function functionMatch(name) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(app);
  assert.ok(match, `missing function ${name}`);
  return match;
}

function functionRange(name) {
  const match = functionMatch(name);
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

function functionBlock(name) {
  return functionRange(name).range.body;
}

function functionSource(name) {
  const { match, range } = functionRange(name);
  return app.slice(match.index, range.close + 1);
}

function openingTagById(id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "i"));
  assert.ok(match, `missing element #${id}`);
  return match[0];
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "administrator operations mounts must not introduce duplicate ids");

for (const id of [
  "adminCollectionOverview",
  "adminRegionOverview",
  "adminConsoleDashboard",
  "adminMemberRequestDashboard",
  "adminSettingsOverview",
  "crawlForm",
  "trafficKeyForm",
  "trafficKeyCancelButton",
  "trafficKeyVerifyButton",
]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} must remain unique`);
}

assert.match(openingTagById("adminCollectionOverview"), /aria-label="[^"]+"/);
assert.doesNotMatch(openingTagById("adminCollectionOverview"), /aria-live=/, "large collection summary must not be a noisy live region");
assert.match(openingTagById("adminRegionOverview"), /aria-label="[^"]+"/);
assert.doesNotMatch(openingTagById("adminRegionOverview"), /aria-live=/, "large region summary must not be a noisy live region");
assert.doesNotMatch(openingTagById("adminSettingsOverview"), /aria-live=/, "secret input changes must not announce the entire settings summary");
assert.match(openingTagById("crawlForm"), /aria-describedby="[^"]*adminCollectionOverview[^"]*crawlStatus/);
assert.match(openingTagById("trafficKeyForm"), /aria-describedby="[^"]*trafficKeyStatus[^"]*trafficKeyVerifyResult[^"]*adminSettingsOverview/);
assert.match(openingTagById("trafficKeyForm"), /autocomplete="off"/, "credential form must opt out of login autofill");
for (const id of [
  "naverClientIdInput",
  "naverClientSecretInput",
  "searchadApiKeyInput",
  "searchadSecretKeyInput",
  "searchadCustomerIdInput",
]) {
  assert.match(openingTagById(id), /autocomplete="new-password"/, `${id} must not reuse login credentials`);
}

const crawlFormMatch = html.match(/<form\b[^>]*\bid="crawlForm"[^>]*>[\s\S]*?<\/form>/i);
assert.ok(crawlFormMatch, "collection form must remain available");
const crawlFormHtml = crawlFormMatch[0];
assert.match(crawlFormHtml, /<span id="checkInLabel">시작일<\/span>/, "collection check-in label must use 시작일");
assert.match(crawlFormHtml, /<span id="checkOutLabel">종료일<\/span>/);
assert.match(openingTagById("checkInInput"), /type="date"/);
assert.match(openingTagById("checkInInput"), /aria-labelledby="checkInLabel"/);
assert.match(openingTagById("checkInInput"), /aria-describedby="checkInWeekdayA11y"/, "the input must announce only the weekday-only accessible description");
assert.match(openingTagById("checkOutInput"), /type="date"/);
assert.match(openingTagById("checkOutInput"), /aria-labelledby="checkOutLabel"/);
assert.match(openingTagById("checkOutInput"), /aria-describedby="checkOutWeekdayA11y"/, "the input must announce only the weekday-only accessible description");
assert.match(openingTagById("checkInWeekday"), /aria-hidden="true"/);
assert.match(openingTagById("checkOutWeekday"), /aria-hidden="true"/);
assert.doesNotMatch(openingTagById("checkInWeekday"), /aria-live=/);
assert.doesNotMatch(openingTagById("checkOutWeekday"), /aria-live=/);
for (const id of ["checkInWeekdayA11y", "checkOutWeekdayA11y"]) {
  assert.match(openingTagById(id), /class="sr-only"/);
  assert.match(openingTagById(id), /aria-live="polite"/);
  assert.match(openingTagById(id), /aria-atomic="true"/);
}
assert.equal((crawlFormHtml.match(/class="field-date-control"/g) || []).length, 2, "both collection dates must use the in-card date control");
assert.match(crawlFormHtml, /<span class="field-date-control">\s*<input id="checkInInput"[\s\S]*?<small class="field-date-weekday" id="checkInWeekday"[\s\S]*?<\/span>/);
assert.match(crawlFormHtml, /<span class="field-date-control">\s*<input id="checkOutInput"[\s\S]*?<small class="field-date-weekday" id="checkOutWeekday"[\s\S]*?<\/span>/);

const purposeOptionsMatch = crawlFormHtml.match(/<div class="crawl-purpose-options">([\s\S]*?)<\/div>/);
assert.ok(purposeOptionsMatch, "collection purpose choices must remain grouped");
const purposeOptionsHtml = purposeOptionsMatch[1];
assert.equal((purposeOptionsHtml.match(/data-collection-purpose=/g) || []).length, 3, "exactly three collection purposes must be shown");
for (const label of ["기본정보 수집", "상세정보 수집", "지역정보 수집"]) {
  assert.match(purposeOptionsHtml, new RegExp(`<strong>${label}<\\/strong>`));
}
assert.doesNotMatch(purposeOptionsHtml, /<(?:span|em)\b/, "purpose cards must show their names only");
assert.match(crawlFormHtml, /<details class="crawl-purpose-details">[\s\S]*?<summary>[\s\S]*?세부내용[\s\S]*?id="crawlPurposeRoutePreview"[\s\S]*?<\/details>/);
assert.match(crawlFormHtml, /<span class="crawl-purpose-details-icon" aria-hidden="true">\+<\/span>/, "purpose details must keep one decorative toggle mount");
assert.doesNotMatch(openingTagById("crawlPurposeRoutePreview"), /aria-live=/, "collapsed purpose details must not announce hidden updates");
assert.doesNotMatch(crawlFormHtml, /crawlProgressEta|완료 예정/, "the collection form must show remaining time without an absolute completion clock");

const weekdayLabel = vm.runInNewContext(`(${functionSource("collectionDateWeekdayLabel")})`, {
  COLLECTION_WEEKDAY_LABELS: ["일", "월", "화", "수", "목", "금", "토"],
});
assert.equal(weekdayLabel("2026-08-03"), "2026-08-03(월)");
assert.equal(weekdayLabel("2026-08-20"), "2026-08-20(목)");
assert.equal(weekdayLabel("2028-02-29"), "2028-02-29(화)");
assert.equal(weekdayLabel("2026-02-30"), "");
assert.equal(weekdayLabel(""), "");
assert.match(functionBlock("updateCrawlSpeedPreview"), /syncCollectionDateWeekdays\(\)/);

const weekdayA11yLabel = vm.runInNewContext(`(() => {
  const collectionDateWeekdayLabel = ${functionSource("collectionDateWeekdayLabel")};
  return ${functionSource("collectionDateWeekdayA11yLabel")};
})()`, {
  COLLECTION_WEEKDAY_LABELS: ["일", "월", "화", "수", "목", "금", "토"],
  COLLECTION_WEEKDAY_FULL_LABELS: ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"],
});
assert.equal(weekdayA11yLabel("2026-08-03"), "선택 요일: 월요일");
assert.equal(weekdayA11yLabel("2026-08-08"), "선택 요일: 토요일");
assert.equal(weekdayA11yLabel(""), "");
assert.match(functionBlock("syncCollectionDateWeekdays"), /\|\|\s*"날짜 선택"[\s\S]*?collectionDateWeekdayA11yLabel[\s\S]*?checkInWeekdayA11y[\s\S]*?checkOutWeekdayA11y/, "empty dates need one visible fallback and weekday-only accessible updates");

const requestDatePicker = vm.runInNewContext(`(${functionSource("requestCollectionDatePicker")})`);
let pickerCalls = 0;
assert.equal(requestDatePicker({ disabled: false, readOnly: false, showPicker() { pickerCalls += 1; } }), true);
assert.equal(pickerCalls, 1);
assert.equal(requestDatePicker({ disabled: true, readOnly: false, showPicker() { pickerCalls += 1; } }), false);
assert.equal(requestDatePicker({ disabled: false, readOnly: true, showPicker() { pickerCalls += 1; } }), false);
assert.equal(requestDatePicker({ disabled: false, readOnly: false }), false);
assert.equal(requestDatePicker({ disabled: false, readOnly: false, showPicker() { throw new Error("picker unavailable"); } }), false);
assert.equal(pickerCalls, 1, "disabled, read-only, missing and failing pickers must not count as opened");

const keyboardControl = {
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value); },
  removeAttribute(name) { this.attributes.delete(name); },
};
const keyboardInput = { closest(selector) { return selector === ".field-date-control" ? keyboardControl : null; } };
const setKeyboardEditing = vm.runInNewContext(`(${functionSource("setCollectionDateKeyboardEditing")})`);
assert.equal(setKeyboardEditing(keyboardInput, true), true);
assert.equal(keyboardControl.attributes.get("data-keyboard-editing"), "true");
assert.equal(setKeyboardEditing(keyboardInput, false), true);
assert.equal(keyboardControl.attributes.has("data-keyboard-editing"), false);
assert.equal(setKeyboardEditing(null, true), false);
const dateBindingBlock = functionBlock("bindEvents");
assert.match(dateBindingBlock, /\[els\.checkInInput,\s*els\.checkOutInput\][\s\S]*?addEventListener\("pointerdown"[\s\S]*?setCollectionDateKeyboardEditing\(input,\s*false\)[\s\S]*?addEventListener\("click"[\s\S]*?requestCollectionDatePicker\(input\)[\s\S]*?addEventListener\("keydown"[\s\S]*?setCollectionDateKeyboardEditing\(input,\s*true\)[\s\S]*?isEnter\s*=\s*event\.key === "Enter"[\s\S]*?isSpace\s*=\s*event\.key === " "[\s\S]*?!isEnter\s*&&\s*!isSpace[\s\S]*?isEnter\)\s*event\.preventDefault\(\)[\s\S]*?event\.repeat[\s\S]*?pickerOpened\s*=\s*requestCollectionDatePicker\(input\)[\s\S]*?pickerOpened\)\s*event\.preventDefault\(\)[\s\S]*?addEventListener\("blur"[\s\S]*?setCollectionDateKeyboardEditing\(input,\s*false\)/, "pointer/touch must keep the exact mirror, keyboard editing must be explicit, and Enter must not submit the collection form");
assert.ok(dateBindingBlock.indexOf('if (isEnter) event.preventDefault();') < dateBindingBlock.indexOf('if (event.repeat) return;'), "repeated Enter must be blocked before the repeat fast path");

for (const functionName of [
  "ensureCrawlControls",
  "renderCollectionPurposeRoutePreview",
  "updateCrawlSpeedPreview",
  "scheduleCrawlEstimatePreviewRefresh",
  "updateCrawlProgressNumbers",
  "crawlEstimateInlineText",
  "adminConsoleCrawlPanel",
]) {
  assert.doesNotMatch(functionBlock(functionName), /crawlProgressEta|estimatedCompleteAt|완료 예정|예상 완료/, `${functionName} must not render an absolute completion clock`);
}
assert.match(css, /\.crawl-progress-numbers\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
assert.match(css, /\.crawl-purpose-details\s*>\s*summary\s*\{[^}]*min-height:\s*var\(--touch-target-min\)[^}]*list-style:\s*none/s);
assert.match(css, /\.crawl-purpose-details\s*>\s*summary:focus-visible\s*\{[^}]*outline:/s);
assert.match(css, /\.crawl-purpose-details-icon\s*\{[^}]*position:\s*relative[^}]*width:\s*28px[^}]*height:\s*28px[^}]*box-sizing:\s*border-box[^}]*align-self:\s*center[^}]*justify-self:\s*center[^}]*border-radius:\s*8px[^}]*font-size:\s*0[^}]*transform-origin:\s*50%\s+50%/s);
assert.match(css, /\.crawl-purpose-details-icon::before,\s*\.crawl-purpose-details-icon::after\s*\{[^}]*top:\s*50%[^}]*left:\s*50%[^}]*width:\s*12px[^}]*height:\s*2px[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
assert.match(css, /\.crawl-purpose-details-icon::after\s*\{[^}]*rotate\(90deg\)/s);
assert.match(css, /\.crawl-purpose-details\[open\]\s+\.crawl-purpose-details-icon::before\s*\{[^}]*rotate\(45deg\)/s);
assert.match(css, /\.crawl-purpose-details\[open\]\s+\.crawl-purpose-details-icon::after\s*\{[^}]*rotate\(135deg\)/s);
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.crawl-purpose-details-icon::before,\s*\.crawl-purpose-details-icon::after\s*\{[^}]*transition:\s*none/s);
assert.doesNotMatch(functionBlock("crawlPreviewMeta"), /trendSeconds/, "client ETA must model only work the collector actually executes");
assert.match(functionBlock("crawlPreviewMeta"), /source:\s*"client_fallback"[\s\S]*confidence:\s*"low"/);
assert.match(functionBlock("crawlEstimateBasisText"), /최근 실측[\s\S]*confidenceLabel/);
assert.match(functionBlock("crawlEstimateBasisText"), /uncertaintySeconds[\s\S]*오차범위/);
assert.match(css, /\.field\s+\.field-date-weekday\s*\{[^}]*font-variant-numeric:\s*tabular-nums[^}]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\.field-date-control\s*\{[^}]*position:\s*relative[^}]*min-width:\s*0[^}]*min-height:\s*var\(--control-height-default\)[^}]*overflow:\s*hidden[^}]*border:\s*1px\s+solid\s+var\(--color-border-default\)[^}]*border-radius:\s*var\(--radius-md\)[^}]*background:\s*var\(--color-surface-raised\)/s);
assert.match(css, /\.field\s+\.field-date-control\s+input\[type="date"\]\s*\{[^}]*position:\s*relative[^}]*display:\s*block[^}]*border:\s*0[^}]*background:\s*transparent[^}]*color:\s*transparent[^}]*padding:\s*0\s+42px\s+0\s+12px[^}]*cursor:\s*pointer[^}]*-webkit-text-fill-color:\s*transparent/s, "the scoped selector must outrank the later administrator input color rule in Firefox");
assert.doesNotMatch(css, /\.field\s+\.field-date-control\s+input\[type="date"\]\s*\{[^}]*opacity:\s*0/s, "the real date input must remain a full interactive control");
assert.match(css, /\.field\s+\.field-date-control\s+input\[type="date"\]::\-webkit-calendar-picker-indicator\s*\{[^}]*cursor:\s*pointer[^}]*opacity:\s*1/s, "the native calendar indicator must stay visible and interactive");
assert.match(css, /\.field-date-control:focus-within\s*\{[^}]*border-color:\s*var\(--color-border-focus\)[^}]*outline:\s*2px\s+solid\s+transparent[^}]*box-shadow:/s);
assert.match(css, /\.field\s+\.field-date-control\[data-keyboard-editing="true"\]\s+input\[type="date"\]\s*\{[^}]*color:\s*var\(--color-text-primary\)[^}]*-webkit-text-fill-color:\s*currentColor/s, "actual keyboard editing must restore the native editable date text");
assert.match(css, /\.field\s+\.field-date-control\s+\.field-date-weekday\s*\{[^}]*position:\s*absolute[^}]*inset:\s*1px\s+42px\s+1px\s+12px[^}]*display:\s*flex[^}]*border:\s*0[^}]*background:\s*transparent[^}]*font-size:\s*14px[^}]*pointer-events:\s*none[^}]*white-space:\s*nowrap/s);
assert.match(css, /\.field\s+\.field-date-control\[data-keyboard-editing="true"\]\s+\.field-date-weekday\s*\{[^}]*visibility:\s*hidden/s, "only one date representation may be visible during actual keyboard editing");
assert.doesNotMatch(css, /input\[type="date"\]:focus-visible\s*\+\s*\.field-date-weekday/, "pointer and touch focus must not hide the exact formatted date");
assert.doesNotMatch(css, /\.field\s+\.field-date-control\s+\.field-date-weekday\s*\{[^}]*border-top:/s, "the duplicate second date row must not return");
assert.match(css, /\.field-date-control:has\(input\[type="date"\]:disabled\)\s*\{[^}]*border-color:\s*var\(--color-disabled-border\)[^}]*background:\s*var\(--color-disabled-surface\)/s);
assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*?\.field-date-control:focus-within\s*\{[^}]*outline-color:\s*Highlight/s);

assert.match(functionBlock("renderAdminCollectionOverview"), /role="status" aria-live="polite" aria-atomic="true"/);
assert.match(functionBlock("renderAdminRegionOverview"), /role="status" aria-live="polite" aria-atomic="true"/);
assert.match(functionBlock("renderAdminSettingsOverview"), /role="status" aria-live="polite" aria-atomic="true"/);

const valueState = vm.runInNewContext(`(${functionSource("adminValueState")})`);
assert.equal(valueState(null), "unavailable");
assert.equal(valueState(undefined), "unavailable");
assert.equal(valueState(""), "unavailable");
assert.equal(valueState(Number.NaN), "unavailable");
assert.equal(valueState(false), "unavailable");
assert.equal(valueState([]), "unavailable");
assert.equal(valueState({}), "unavailable");
assert.equal(valueState(0), "zero");
assert.equal(valueState("0"), "zero");
assert.equal(valueState(1), "ready");
assert.equal(valueState(-1), "unavailable");

const countValueState = vm.runInNewContext(`(${functionSource("adminCountValueState")})`);
for (const value of [null, undefined, "", "   ", false, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, -1, "not-a-number"]) {
  assert.equal(countValueState(value), "unavailable", `invalid count ${String(value)} must not render as an observed value`);
}
assert.equal(countValueState(0), "zero");
assert.equal(countValueState("0"), "zero");
assert.equal(countValueState(4), "ready");

const renderLocationCandidatePublicData = vm.runInNewContext(
  `(${functionSource("renderLocationCandidatePublicData")})`,
  { escapeHtml: String, fmtNumber: String }
);
assert.equal(renderLocationCandidatePublicData(null), "", "a missing saved location request must render safely");
assert.equal(renderLocationCandidatePublicData(undefined), "", "an undefined saved location request must render safely");
assert.equal(
  renderLocationCandidatePublicData({ baseInfo: null, publicData: null }),
  "",
  "nullable saved location sections must render safely"
);

const collectionContext = {
  state: { crawlProgressRunning: false },
  currentCrawlFormPayload: () => ({}),
  crawlPreviewMeta: () => ({}),
  clientSearchIntent: (keyword) => keyword === "스테이폴리오"
    ? { intent: "platform_search", lodgingCategoryKey: "", region: null }
    : { intent: "region_search", lodgingCategoryKey: "pension", region: { query: "가평" } },
  searchIntentHintMeta: (keyword) => keyword === "스테이폴리오"
    ? { text: "플랫폼 검색은 수집 연결 전", supported: false }
    : { text: keyword ? "지역 검색" : "검색어 입력", supported: Boolean(keyword) },
  collectionPurposeProfile: () => ({ key: "basic_db", label: "기본", defaultRange: "1-10" }),
  productModeLabel: (value) => value,
  lodgingCategoryIntentLabel: (value) => value,
  formatElapsed: (value) => `${value}s`,
};
vm.createContext(collectionContext);
vm.runInContext(functionSource("adminCollectionReadinessModel"), collectionContext);
const readiness = collectionContext.adminCollectionReadinessModel;
let model = readiness({ keyword: "", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "blocked");
assert.equal(model.executable, false);
model = readiness({ keyword: "스테이폴리오", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "blocked");
model = readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "preview");
assert.equal(model.serverResolved, false);
model = readiness(
  { keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" },
  { resolvedIntent: { intent: "region_search", lodgingCategoryKey: "pension", region: { query: "가평" } }, intentSupported: true }
);
assert.equal(model.stateKey, "ready");
assert.equal(model.serverResolved, true);
assert.equal(model.productLabel, "lodging");
assert.equal(model.categoryLabel, "pension");
model = readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, { estimateError: true });
assert.equal(model.stateKey, "warning");
collectionContext.state.crawlProgressRunning = true;
assert.equal(readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, {}).stateKey, "running");

const estimateScheduleContext = {
  state: { crawlProgressRunning: false, crawlEstimateRequestId: 9, crawlEstimateTimer: 77 },
  cleared: 0,
  scheduled: 0,
  currentCrawlFormPayload: () => ({ keyword: "" }),
  isAdminRole: () => true,
};
estimateScheduleContext.clearCrawlEstimateTimer = () => {
  estimateScheduleContext.cleared += 1;
  estimateScheduleContext.state.crawlEstimateTimer = null;
};
estimateScheduleContext.setTimeout = () => {
  estimateScheduleContext.scheduled += 1;
  return 1;
};
vm.createContext(estimateScheduleContext);
vm.runInContext(functionSource("scheduleCrawlEstimatePreviewRefresh"), estimateScheduleContext);
estimateScheduleContext.scheduleCrawlEstimatePreviewRefresh({ keyword: "   " });
assert.equal(estimateScheduleContext.cleared, 1, "clearing a keyword must cancel the pending estimate timer");
assert.equal(estimateScheduleContext.state.crawlEstimateRequestId, 10, "clearing a keyword must invalidate an in-flight estimate response");
assert.equal(estimateScheduleContext.scheduled, 0, "an empty keyword must not schedule another estimate request");

function crawlControl(disabled = false) {
  return {
    disabled,
    dataset: {},
    hasAttribute(name) {
      return name === "data-crawl-disabled-before-run" && Object.prototype.hasOwnProperty.call(this.dataset, "crawlDisabledBeforeRun");
    },
  };
}
const initiallyEnabledCrawlControl = crawlControl(false);
const initiallyDisabledCrawlControl = crawlControl(true);
const crawlControlContext = {
  els: {
    keywordInput: initiallyEnabledCrawlControl,
    checkInInput: initiallyDisabledCrawlControl,
    crawlForm: { querySelectorAll: () => [] },
  },
};
vm.createContext(crawlControlContext);
vm.runInContext(functionSource("syncCrawlExecutionControls"), crawlControlContext);
crawlControlContext.syncCrawlExecutionControls(true);
assert.equal(initiallyEnabledCrawlControl.disabled, true);
assert.equal(initiallyDisabledCrawlControl.disabled, true);
crawlControlContext.syncCrawlExecutionControls(false);
assert.equal(initiallyEnabledCrawlControl.disabled, false, "run completion must restore an originally enabled field");
assert.equal(initiallyDisabledCrawlControl.disabled, true, "run completion must preserve an originally disabled field");

const submitCrawlSource = functionBlock("submitCrawl");
assert.match(submitCrawlSource, /intentSupported === false[\s\S]*setCrawlProgress\(false, "", "", preview, payload\)/);
assert.doesNotMatch(submitCrawlSource, /intentSupported === false[\s\S]{0,240}submitButton\.disabled = false/, "server-rejected intent must remain blocked");
assert.match(functionBlock("setCrawlProgress"), /crawlExecutionPayload/);
assert.match(functionBlock("setCrawlProgress"), /syncCrawlExecutionControls\(active\)/);
assert.match(functionBlock("setCrawlProgress"), /if \(active && submitButton\) submitButton\.disabled = true/, "restored active collection must also lock submit");

for (const endpoint of [
  "/api/crawl-estimate",
  "/api/crawl",
  "/api/crawl-status",
  "/api/runs",
  "/api/b2b-members/",
  "/api/account-delete-requests/",
  "/api/settings/traffic-keys",
  "/api/settings/traffic-keys/verify",
]) {
  assert.ok(app.includes(endpoint), `${endpoint} must preserve its existing API contract`);
}

assert.match(app, /data-admin-metric-state=/);
const analyticsModelSource = functionBlock("adminAnalyticsOverviewModel");
const analyticsBasisSource = functionBlock("adminAnalyticsOverviewHtml");
const analyticsKpiSource = functionBlock("adminReportKpiCardsHtml");
assert.match(analyticsModelSource, /categorySummary\.primaryCounts/);
assert.match(analyticsModelSource, /observedPlatforms/);
assert.doesNotMatch(analyticsModelSource, /platformStats\.names\.length\s*:/);
assert.match(analyticsBasisSource, /report-basis-card/);
assert.doesNotMatch(analyticsBasisSource, /adminAnalyticsValueCell|reportMetricCardHtml/, "analysis basis must remain a flat context card");
for (const key of ["companies", "sales-sample", "primary-category", "platforms", "contact-candidates", "product-gap"]) {
  assert.match(analyticsKpiSource, new RegExp(`key:\\s*"${key}"`), `${key} KPI must remain in the report KPI renderer`);
}

const analyticsContext = {
  state: { data: {}, companyMaster: null },
  summarizeSales: () => ({ sold: 0, supply: 0 }),
  reportPlatformStats: () => ({ names: ["네이버", "NOL"], counts: { 네이버: 0, NOL: 0 } }),
};
vm.createContext(analyticsContext);
vm.runInContext(functionSource("adminAnalyticsOverviewModel"), analyticsContext);
analyticsContext.state.data = { run: { id: "run-1" }, availability: { items: [{}] } };
let analyticsModel = analyticsContext.adminAnalyticsOverviewModel("summary");
assert.equal(analyticsModel.salesObserved, false, "missing inventory fields must remain uncollected");
assert.equal(analyticsModel.categorySummaryObserved, false, "missing category summary must remain uncollected");
assert.deepEqual(Array.from(analyticsModel.observedPlatforms), [], "zero-count platforms must not be reported as observed");
analyticsContext.state.data = {
  run: { id: "run-2" },
  availability: { items: [{ nightTotalStock: 0, nightAvailableStock: 0 }] },
  companyMaster: { categorySummary: { totalCompanies: 0, primaryCounts: {} } },
};
analyticsModel = analyticsContext.adminAnalyticsOverviewModel("summary");
assert.equal(analyticsModel.salesObserved, true, "an observed zero inventory must remain a real zero");
assert.equal(analyticsModel.categorySummaryObserved, true, "an observed zero category summary must remain a real zero");
assert.equal(analyticsModel.categoryCount, 0);

assert.match(functionBlock("renderAdminRegionOverview"), /waiting:[\s\S]*error:/);
assert.match(functionBlock("renderAdminRegionOverview"), /API 미신청·미연결은 지역 오류가 아님/);
assert.doesNotMatch(functionBlock("adminSelectedRegion"), /regions\[0\]/);
assert.match(functionBlock("adminRegionCardHtml"), /aria-pressed/);
assert.match(functionBlock("loadLocationDictionary"), /state\.dictionary\s*=\s*\{\s*error:/);
assert.match(functionBlock("loadLocationCardRequests"), /renderAdminRegionOverview\(\)/);
assert.match(functionBlock("adminRegionalDetailPanel"), /data-admin-region-back/);
assert.match(functionBlock("bindEvents"), /adminRegionReturnFocusKey[\s\S]*data-admin-region-key/);
assert.match(functionBlock("saveAdminRegionReview"), /window\.confirm/);
assert.match(functionBlock("saveAdminRegionReview"), /regionLabel[\s\S]*statusLabel/);
assert.match(functionBlock("applyAdminRegionApproval"), /window\.confirm/);

for (const hook of [
  "data-admin-member-select",
  "data-admin-member-back",
  "data-admin-member-filter-clear",
  "data-admin-member-query",
  "data-admin-member-status-filter",
  "data-admin-member-type-filter",
]) {
  assert.ok(app.includes(hook), `${hook} member workbench hook must remain available`);
}
assert.match(functionBlock("adminConsoleMemberPanel"), /adminMemberRecordKey/);
assert.doesNotMatch(functionBlock("adminConsoleMemberPanel"), /adminConsoleMemberLegacyPanel/);
assert.match(functionBlock("adminMemberSelectButton"), /aria-pressed/);
assert.match(functionBlock("adminMemberDetailHtml"), /tabindex="-1"/);
assert.match(functionBlock("adminMaskedContact"), /\*\*\*/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /adminMaskedContact\(request\.contact/);
assert.doesNotMatch(functionBlock("adminConsoleAccountDeletePanel"), /escapeHtml\(request\.contact/);
assert.match(app, /window\.confirm\(`\$\{request\?\.username/);
assert.match(functionBlock("adminConsoleMemberPanel"), /visibleLimit\s*=\s*50/);
assert.match(functionBlock("adminConsoleMemberPanel"), /selectedVisible[\s\S]*rows\.push\(selected\)/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /adminCountMetricHtml\("미처리"/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /상태 미확인/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /요청 식별자 없음 · 읽기 전용/);

const deleteStatusContext = {};
vm.createContext(deleteStatusContext);
vm.runInContext(functionSource("adminDeleteRequestStatusKey"), deleteStatusContext);
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey("received"), "received");
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey("legacy"), "unknown");
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey(""), "unknown");

const memberFilterContext = {
  state: { adminMemberFilters: {} },
  compactSearchText: (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
  adminMemberSearchText: (member) => JSON.stringify(member).replace(/\s+/g, "").toLowerCase(),
};
vm.createContext(memberFilterContext);
for (const name of ["adminMemberStatusKey", "adminMemberAccountTypeKey", "adminMemberMatchesFilters"]) {
  vm.runInContext(functionSource(name), memberFilterContext);
}
const unknownMember = { username: "legacy-user", status: "pending", accountType: "legacy" };
assert.equal(memberFilterContext.adminMemberStatusKey("pending"), "unknown");
assert.equal(memberFilterContext.adminMemberAccountTypeKey("legacy"), "unknown");
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { status: "unknown", accountType: "unknown" }), true);
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { query: "legacy", status: "unknown", accountType: "unknown" }), true);
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { status: "active", accountType: "all" }), false);
assert.match(functionBlock("adminMemberDetailHtml"), /policyMutable[\s\S]*disabled/);
assert.match(functionBlock("adminMemberDetailHtml"), /expandedPolicyKnown/);
assert.match(functionBlock("adminMemberDetailHtml"), /typeof expandedPolicyValue === "boolean"/);
assert.match(functionBlock("updateB2BMemberAdminPolicy"), /expandedPolicyKnown/);
assert.match(functionBlock("updateB2BMemberAdminPolicy"), /typeof expandedPolicyValue === "boolean"/);
assert.doesNotMatch(functionBlock("updateB2BMemberAdminPolicy"), /Boolean\(policy\.expandedAllowed \|\| policy\.expandedSearchAllowed\)/);

function assertGuardBeforeFetch(name) {
  const block = functionBlock(name);
  const guard = block.indexOf("allowAdminOperationsMutation");
  const fetch = block.indexOf("fetchJson");
  assert.ok(guard >= 0, `${name} must use the administrator mutation guard`);
  assert.match(block, /if\s*\([^\n;]*allowAdminOperationsMutation[^\n;]*\)\s*return/, `${name} must return when its mutation guard rejects the action`);
  if (fetch >= 0) assert.ok(guard < fetch, `${name} must guard before its first fetch`);
}

for (const name of [
  "updateB2BMemberAdminPolicy",
  "updateAccountDeleteRequestStatus",
  "submitTrafficKeys",
  "verifyTrafficKeys",
  "saveLocationCardCandidateAction",
  "saveLocationCardRequestQueueAction",
  "saveLocationScoreOverride",
  "applyAdminRegionCompanyBulkReview",
  "saveAdminRegionReview",
]) {
  assertGuardBeforeFetch(name);
}

function assertRejectedGuardMakesNoRequest(name, args = [], additions = {}) {
  let fetchCount = 0;
  const context = {
    state: {},
    els: { trafficKeyVerifyButton: {} },
    allowAdminOperationsMutation: () => false,
    fetchJson: () => {
      fetchCount += 1;
      throw new Error(`${name} must not request data after a rejected guard`);
    },
    ...additions,
  };
  vm.createContext(context);
  vm.runInContext(functionSource(name), context);
  context[name](...args);
  assert.equal(fetchCount, 0, `${name} must make zero requests when the guard rejects the action`);
}

assertRejectedGuardMakesNoRequest("updateB2BMemberAdminPolicy", ["member-1", {}]);
assertRejectedGuardMakesNoRequest("updateAccountDeleteRequestStatus", ["request-1", {}]);
assertRejectedGuardMakesNoRequest("submitTrafficKeys", [{ preventDefault() {} }]);
assertRejectedGuardMakesNoRequest("verifyTrafficKeys");
assertRejectedGuardMakesNoRequest("saveLocationCardCandidateAction", [{ dataset: { locationCandidateAction: "requested" } }]);
assertRejectedGuardMakesNoRequest("saveLocationScoreOverride", [{}, false]);

const submitTrafficKeys = functionBlock("submitTrafficKeys");
assert.doesNotMatch(submitTrafficKeys, /verifyTrafficKeys\s*\(/, "saving keys must not automatically contact external APIs");
assert.match(submitTrafficKeys, /adminSettingsSaving/);
assert.match(submitTrafficKeys, /adminSettingsDirty = false/);
assert.match(submitTrafficKeys, /!Object\.keys\(payload\)\.length[\s\S]*trafficKeyForm\.reset\(\)/);
assert.match(functionBlock("verifyTrafficKeys"), /window\.confirm/);
assert.match(functionBlock("cancelTrafficKeyDraft"), /trafficKeyForm\.reset\(\)/);
assert.match(functionBlock("cancelTrafficKeyDraft"), /adminSettingsDirty = false/);
assert.match(functionBlock("loadTrafficState"), /renderTrafficState\(\{ error: true \}\)/);
assert.match(functionBlock("renderAdminSettingsOverview"), /datalabConfigured/);
assert.match(functionBlock("renderAdminSettingsOverview"), /searchadConfigured/);
assert.doesNotMatch(functionBlock("renderAdminSettingsOverview"), /clientSecret|secretKey|apiKeyStorage|configDir|cookie|token/i);
assert.match(functionBlock("bindEvents"), /adminSettingsDirty/);
assert.match(functionBlock("bindEvents"), /String\(input\.value \|\| ""\)\.trim\(\)/);
assert.match(functionBlock("bindEvents"), /trafficKeyCancelButton/);
assert.match(functionBlock("verifyTrafficKeys"), /adminSettingsVerifying = true/);
assert.match(functionBlock("verifyTrafficKeys"), /adminSettingsVerifying = false/);
assert.match(functionBlock("submitTrafficKeys"), /adminSettingsVerifying/);

const trafficStateContext = {
  state: {},
  els: { trafficApiState: { textContent: "" } },
  renderTrafficVerification() {},
  renderAdminSettingsOverview() {},
  renderDemand() {},
};
vm.createContext(trafficStateContext);
vm.runInContext(functionSource("renderTrafficState"), trafficStateContext);
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: true, verification: { datalab: { ok: true }, searchad: { ok: false } } });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "일부 연결 확인");
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: true, verification: { datalab: { ok: true }, searchad: { ok: true } } });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "연동 정상");
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: false });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "키 저장됨");
trafficStateContext.renderTrafficState({ error: true });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "조회 실패");

const securityPanel = functionBlock("adminConsoleSecurityPanel");
assert.doesNotMatch(securityPanel, /escapeHtml\([^)]*storage\./, "internal storage paths must not be rendered");
assert.match(securityPanel, /내부 경로 비공개/);

const stageMarker = "/* Stage 5 admin operations workbenches */";
const stageStart = css.indexOf(stageMarker);
const stageEnd = css.indexOf("/* Light theme compatibility", stageStart);
assert.ok(stageStart >= 0 && stageEnd > stageStart, "Stage 5 styles must have a bounded responsibility block");
const stageCss = css.slice(stageStart, stageEnd);
for (const selector of [
  ".admin-operations-context",
  ".admin-operation-status",
  ".admin-member-toolbar",
  ".admin-member-workbench",
  ".admin-member-option",
  ".admin-member-detail-workbench",
  ".admin-settings-actions",
]) {
  assert.ok(stageCss.includes(selector), `${selector} must have a Stage 5 style contract`);
}
assert.match(stageCss, /min-height:\s*var\(--touch-target-min\)/);
assert.match(stageCss, /@media \(min-width: 721px\) and \(max-width: 1120px\)/);
assert.match(stageCss, /@media \(max-width: 720px\)/);
assert.match(stageCss, /@media \(max-width: 390px\)/);
assert.match(stageCss, /overflow-wrap:\s*anywhere/);
assert.match(
  stageCss,
  /@media \(min-width: 721px\) and \(max-width: 1120px\)[\s\S]*?body\.role-admin \.admin-console-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
  "administrator queues must collapse to one column before fixed queue columns are clipped",
);
assert.match(
  stageCss,
  /@media \(min-width: 721px\) and \(max-width: 1120px\)[\s\S]*?body\.role-admin \.admin-queue-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.25fr\) minmax\(0, \.55fr\) minmax\(0, 1fr\)/s,
  "administrator queue columns must be allowed to shrink within the available content width",
);
assert.match(
  stageCss,
  /body\.role-admin \.admin-queue-row > \*\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
  "administrator queue cells must wrap rather than disappear behind their details container",
);
assert.match(
  stageCss,
  /@media \(min-width: 721px\) and \(max-width: 1120px\)[\s\S]*?\.admin-region-company-toolbar,[\s\S]*?\.location-score-admin-form[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s,
  "region toolbars and score forms must use bounded two-column layouts at tablet widths",
);
assert.match(
  stageCss,
  /@media \(max-width: 720px\)[\s\S]*?\.admin-db-audit-gate-actions button[\s\S]*?min-height:\s*var\(--touch-target-min\)/s,
  "mobile administrator queue and audit actions must meet the shared touch target",
);
for (const selector of [
  ".admin-region-review-filter-summary button",
  ".admin-region-audit-head button",
  "[data-admin-region-company-focus]",
  ".admin-region-company-row > button",
  ".target-gate-filters button",
  ".target-gate-recrawl > button",
  ".company-check-filters button",
  ".recrawl-auto-head button",
  ".recrawl-auto-list button",
  ".recrawl-batch-list button",
  ".recrawl-range-presets button",
]) {
  assert.equal(
    stageCss.includes(selector),
    true,
    `mobile operations touch-target rule must include ${selector}`,
  );
}
assert.match(
  css,
  /\.report-target-row strong\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
  "long report company names must wrap instead of becoming inaccessible ellipses",
);
assert.match(
  css,
  /\.report-target-row small\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
  "long report reasons must wrap instead of becoming inaccessible ellipses",
);
assert.match(stageCss, /#adminMemberRequestDashboard \.admin-member-option\[aria-pressed="true"\]/, "selected member styling must outrank the dashboard button base rule");
assert.match(stageCss, /#adminMemberRequestDashboard[\s\S]*:disabled[\s\S]*--color-disabled-surface/, "member and settings disabled controls must retain a semantic disabled surface");
assert.match(stageCss, /button\.danger:not\(:disabled\)/, "member account suspension must remain visually distinct");
assert.match(stageCss, /button\.restore:not\(:disabled\)/, "member account restoration must remain visually distinct");
assert.match(stageCss, /data-admin-member-back/, "member mobile return action must meet the shared touch-target contract");
assert.match(stageCss, /advanced-box > summary/, "settings disclosure must meet the shared touch-target contract");
assert.match(css, /\.advanced-box:not\(\[open\]\) > :not\(summary\)\s*\{[^}]*display:\s*none/s, "closed disclosures must not leak grid children into following card content");
assert.match(css, /\.admin-console-head\s*\{[^}]*flex-wrap:\s*wrap/s, "administrator card headings must wrap before action labels overflow");
assert.match(css, /\.admin-console-head > div\s*\{[^}]*flex:\s*1 1 220px/s, "administrator card copy must keep a usable responsive width");
assert.match(css, /\.admin-console-head > :is\(button, a\)\s*\{[^}]*flex:\s*0 0 auto[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s, "administrator card actions must wrap safely without escaping the card");
assert.match(stageCss, /@media \(max-width: 390px\)[\s\S]*#adminMemberRequestDashboard \.admin-security-panel \.admin-console-head[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/, "the security summary must stack before its description collapses at 320px");
assert.match(stageCss, /@media \(max-width: 720px\)[\s\S]*\.admin-member-option[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/, "member rows must collapse before common 393-540px mobile widths");
assert.match(stageCss, /\.admin-region-detail-actions[\s\S]*data-admin-region-back|\.admin-region-detail-actions/, "region detail must expose a bounded return-action layout");
assert.doesNotMatch(stageCss, /#[0-9a-f]{3,8}\b/i, "Stage 5 workbench styles must use semantic tokens instead of new hex colors");
assert.doesNotMatch(stageCss, /filter:\s*(?:invert|hue-rotate)/i);
assert.doesNotMatch(css, /body\.role-admin \.company-master-route-summary article\s*\{[^}]*rgba\(/s, "settings route summary must not retain a fixed dark-only surface");
const surfaceV3Start = css.indexOf("/* Surface contrast contract v3");
const surfaceV3End = css.indexOf("/* Surface contrast contract v4", surfaceV3Start);
assert.ok(surfaceV3Start >= 0 && surfaceV3End > surfaceV3Start, "final surface normalization block must remain bounded");
const surfaceV3Css = css.slice(surfaceV3Start, surfaceV3End);
assert.match(surfaceV3Css, /\.history-ops-log button:not\(\.watch\):not\(\.bad\)/, "final surface normalization must not erase history warning and failure tones");
assert.match(surfaceV3Css, /\.history-ops-log article:not\(\.good\):not\(\.watch\):not\(\.bad\)/, "final surface normalization must not erase history success tones");
assert.match(surfaceV3Css, /\.demand-signal-card:not\(\.positive\):not\(\.warning\)/, "final surface normalization must preserve demand status tones");
assert.match(surfaceV3Css, /\.collection-diagnostic-list div:not\(\.good\):not\(\.watch\):not\(\.bad\)/, "final surface normalization must preserve collection diagnostic tones");
assert.match(surfaceV3Css, /\.admin-region-ops-queue-grid article:not\(\.good\):not\(\.watch\):not\(\.hot\)/, "final surface normalization must not erase region queue tones");
assert.doesNotMatch(surfaceV3Css, /\.history-ops-log button,|\.history-ops-log article,|\.demand-signal-card,|\.collection-diagnostic-list div,|\.company-insight-grid div,|\.b2b-company-card-summary div,/, "final surface normalization must not contain unqualified status-card selectors");
const adminReadabilityStart = css.indexOf("/* Admin readability final pass");
const adminReadabilityEnd = css.indexOf("/* Final contrast lock", adminReadabilityStart);
const adminReadabilityCss = css.slice(adminReadabilityStart, adminReadabilityEnd);
assert.match(adminReadabilityCss, /\.admin-delete-row:not\(\.verifying\):not\(\.processing\):not\(\.completed\):not\(\.rejected\)/, "admin readability normalization must preserve deletion request status surfaces");
assert.match(css, /\.admin-console-dashboard article:not\(\.good\):not\(\.watch\):not\(\.hot\)/, "light compatibility must preserve administrator status surfaces");
assert.match(css, /\.admin-member-request-dashboard article:not\(\.verifying\):not\(\.processing\):not\(\.completed\):not\(\.rejected\)/, "light compatibility must preserve deletion request status surfaces");

for (const forbidden of ["rgba(13, 20, 29", "#dcecff", "#e7f1ff", "#1f4f83"]) {
  const adminOpsLegacyStart = css.indexOf("body.role-admin #adminConsoleDashboard");
  const adminOpsLegacyEnd = css.indexOf("body.role-admin .company-master-route-summary", adminOpsLegacyStart);
  assert.doesNotMatch(css.slice(adminOpsLegacyStart, adminOpsLegacyEnd), new RegExp(forbidden.replace(/[()]/g, "\\$&"), "i"), `light-compatible administrator operations rules must not retain ${forbidden}`);
}

console.log("Administrator collection, analytics, region, member, and settings UI contract checks passed");
