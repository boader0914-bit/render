"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in application shell UI contract tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const themeScript = fs.readFileSync(path.join(root, "web", "login-theme.js"), "utf8");

function balancedBlockFrom(source, marker, openCharacter = "{", closeCharacter = "}") {
  const markerIndex = typeof marker === "number" ? marker : source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing source marker: ${marker}`);
  const openIndex = source.indexOf(openCharacter, markerIndex);
  assert.notEqual(openIndex, -1, `missing ${openCharacter} after ${marker}`);
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
    if (character === '"' || character === "'" || character === "`") {
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
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(app);
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
  const bodyOpen = app.indexOf("{", parameterClose);
  return balancedBlockFrom(app, bodyOpen);
}

function openingTagById(id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "i"));
  assert.ok(match, `missing element #${id}`);
  return match[0];
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "application shell must not contain duplicate ids");

assert.match(html, /<a\b[^>]*class="[^"]*skip-link[^"]*"[^>]*href="#appMain"[^>]*>본문 바로가기<\/a>/);
assert.match(openingTagById("appMain"), /^<main\b/i);
assert.match(openingTagById("appMain"), /tabindex="-1"/);
assert.match(html, /<header\b[^>]*class="[^"]*app-header[^"]*"/);
assert.match(openingTagById("appPrimaryNav"), /^<nav\b/i);
assert.match(openingTagById("appPrimaryNav"), /aria-label="[^"]+"/);
assert.match(openingTagById("themeToggle"), /aria-label="[^"]+"/);

const previewBanner = openingTagById("adminUserViewBanner");
assert.match(previewBanner, /role="status"/);
assert.match(previewBanner, /aria-live="polite"/);
assert.match(previewBanner, /hidden/);
assert.match(html, /관리자 미리보기 · 읽기 전용/);
assert.match(html, /<a\b[^>]*href="\/admin"[^>]*>관리자 화면으로 돌아가기<\/a>/);

assert.match(app, /const\s+APP_NAVIGATION\s*=\s*(?:Object\.freeze\s*\()?\s*\{/);
const navigationStart = app.search(/const\s+APP_NAVIGATION\s*=/);
const navigationModelSource = balancedBlockFrom(app, navigationStart, "{", "}");
for (const field of ["key", "label", "tab"]) {
  assert.match(navigationModelSource, new RegExp(`\\b${field}\\s*:`), `APP_NAVIGATION items must expose ${field}`);
}
for (const label of ["홈", "업체", "수집", "분석", "지역", "회원", "설정", "경쟁", "지도", "수요", "계정"]) {
  assert.ok(navigationModelSource.includes(`label: "${label}"`) || navigationModelSource.includes(`label: '${label}'`), `APP_NAVIGATION must include ${label}`);
}
assert.match(navigationModelSource, /\badmin\s*:\s*\{/);
assert.match(navigationModelSource, /\bb2b\s*:\s*\{/);
assert.match(navigationModelSource, /\bmobile\s*:/);
assert.match(navigationModelSource, /\baction\s*:\s*["'](?:drawer|account)["']/);

const navigationFunctions = [
  "navigationModel",
  "navigationEntries",
  "navigationItemByKey",
  "navigationItemIsActive",
  "renderPrimaryNavigation",
  "renderControlDrawerNavigation",
  "activateAppNavigation",
];
for (const name of navigationFunctions) functionBlock(name);
assert.match(functionBlock("navigationModel"), /APP_NAVIGATION/);
assert.match(functionBlock("navigationEntries"), /navigationModel|APP_NAVIGATION/);
assert.match(functionBlock("renderPrimaryNavigation"), /navigationEntries/);
assert.match(functionBlock("renderPrimaryNavigation"), /appPrimaryNav/);
assert.match(functionBlock("renderPrimaryNavigation"), /aria-current/);
assert.match(functionBlock("renderControlDrawerNavigation"), /navigationEntries/);
assert.match(functionBlock("renderControlDrawerNavigation"), /drawerActions/);
assert.match(functionBlock("renderControlDrawerNavigation"), /data-drawer-tab/);
assert.match(functionBlock("activateAppNavigation"), /navigationItemByKey/);
assert.match(functionBlock("activateAppNavigation"), /setActiveTab/);
assert.match(app, /const\s+ROLE_TABS\s*=\s*Object\.fromEntries\([\s\S]*APP_NAVIGATION/, "role tab compatibility must derive from APP_NAVIGATION");

assert.match(app, /function\s+canMutateB2B\s*\(/);
assert.match(functionBlock("canMutateB2B"), /isAdminUserViewMode/);
assert.match(app, /function\s+blockAdminUserViewMutation\s*\(/);
assert.match(functionBlock("blockAdminUserViewMutation"), /canMutateB2B/);
assert.match(functionBlock("applyRoleUi"), /adminUserViewBanner/);

function createThemeHarness(storedTheme, systemDark) {
  const domListeners = new Map();
  const mediaListeners = new Map();
  const buttonListeners = new Map();
  const stored = new Map();
  if (storedTheme !== undefined) stored.set("lodging-theme", storedTheme);

  const rootElement = { dataset: {} };
  const buttonAttributes = new Map([["aria-label", "화면 테마 전환"]]);
  const button = {
    textContent: "",
    addEventListener(type, listener) { buttonListeners.set(type, listener); },
    setAttribute(name, value) { buttonAttributes.set(name, String(value)); },
    getAttribute(name) { return buttonAttributes.get(name) || null; },
  };
  const metaAttributes = new Map();
  const meta = {
    setAttribute(name, value) { metaAttributes.set(name, String(value)); },
    getAttribute(name) { return metaAttributes.get(name) || null; },
  };
  const media = {
    matches: systemDark,
    addEventListener(type, listener) { mediaListeners.set(type, listener); },
    removeEventListener(type) { mediaListeners.delete(type); },
    addListener(listener) { mediaListeners.set("change", listener); },
    removeListener() { mediaListeners.delete("change"); },
  };
  const document = {
    documentElement: rootElement,
    readyState: "loading",
    addEventListener(type, listener) { domListeners.set(type, listener); },
    getElementById(id) {
      if (id === "themeToggle") return button;
      if (id === "themeColor") return meta;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const localStorage = {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); },
  };
  const context = {
    document,
    localStorage,
    matchMedia: () => media,
    console,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(themeScript, context, { filename: "login-theme.js" });
  return {
    rootElement,
    button,
    meta,
    stored,
    fireDomReady() { domListeners.get("DOMContentLoaded")?.(); },
    click() { buttonListeners.get("click")?.({ type: "click" }); },
  };
}

const storedLightTheme = createThemeHarness("light", true);
assert.equal(storedLightTheme.rootElement.dataset.theme, "light", "stored theme must apply synchronously before DOM ready");
storedLightTheme.fireDomReady();
assert.equal(storedLightTheme.button.getAttribute("aria-pressed"), "false");
assert.match(storedLightTheme.button.getAttribute("aria-label") || "", /다크|dark/i);
assert.match(storedLightTheme.button.innerHTML || "", /class="theme-toggle-icon"/);
assert.match(storedLightTheme.button.innerHTML || "", /aria-hidden="true"/);
storedLightTheme.click();
assert.equal(storedLightTheme.rootElement.dataset.theme, "dark");
assert.equal(storedLightTheme.stored.get("lodging-theme"), "dark");
assert.equal(storedLightTheme.button.getAttribute("aria-pressed"), "true");
assert.ok(storedLightTheme.meta.getAttribute("content"), "theme toggle must update theme-color metadata");

const systemTheme = createThemeHarness(undefined, true);
assert.equal(systemTheme.rootElement.dataset.theme, "dark", "system preference must be used when no theme is stored");
systemTheme.fireDomReady();
assert.match(systemTheme.button.getAttribute("aria-label") || "", /라이트|light/i);

const drawerPanel = html.match(/<section\b[^>]*class="drawer-panel"[^>]*>/)?.[0] || "";
const sheetPanel = html.match(/<section\b[^>]*class="sheet-panel"[^>]*>/)?.[0] || "";
for (const [label, tag] of [["drawer", drawerPanel], ["sheet", sheetPanel]]) {
  assert.ok(tag, `missing ${label} dialog panel`);
  assert.match(tag, /role="dialog"/);
  assert.match(tag, /aria-modal="true"/);
  assert.match(tag, /aria-labelledby="[^"]+"/);
  assert.match(tag, /tabindex="-1"/);
}
assert.match(html, /id="controlDrawerTitle"/);
assert.match(html, /id="sheetTitle"/);

const openOverlay = functionBlock("openAccessibleOverlay");
const closeOverlay = functionBlock("closeAccessibleOverlay");
const overlayBackground = functionBlock("setAccessibleOverlayBackgroundInactive");
assert.match(openOverlay, /document\.activeElement|trigger/);
assert.match(openOverlay, /focus\s*\(/);
assert.match(openOverlay, /setAccessibleOverlayBackgroundInactive/);
assert.match(openOverlay, /overflow/);
assert.match(closeOverlay, /focus\s*\(/);
assert.match(closeOverlay, /setAccessibleOverlayBackgroundInactive/);
assert.match(closeOverlay, /overflow/);
assert.match(overlayBackground, /\.inert\s*=/);
assert.match(overlayBackground, /aria-hidden/);
assert.match(app, /event\.key\s*(?:===|!==)\s*["']Tab["']/);
assert.match(app, /event\.key\s*===\s*["']Escape["']/);
assert.match(app, /querySelectorAll\([^)]*(?:button|tabindex|input)/s, "overlay manager must enumerate focusable controls");
assert.match(functionBlock("openDrawer"), /openAccessibleOverlay/);
assert.match(functionBlock("closeDrawer"), /closeAccessibleOverlay/);
assert.match(functionBlock("openSheet"), /openAccessibleOverlay/);
assert.match(functionBlock("closeSheet"), /closeAccessibleOverlay/);

const sheetTabs = [...html.matchAll(/<button\b[^>]*data-sheet-tab="([^"]+)"[^>]*>/g)];
assert.equal(sheetTabs.length, 3, "detail sheet must retain its three tabs");
for (const [, key] of sheetTabs) {
  const tag = sheetTabs.find((match) => match[1] === key)[0];
  assert.match(tag, /role="tab"/);
  assert.match(tag, /aria-selected="(?:true|false)"/);
  assert.match(tag, /aria-controls="sheetBody"/);
  assert.match(tag, /tabindex="(?:0|-1)"/);
}
const sheetBody = openingTagById("sheetBody");
assert.match(sheetBody, /role="tabpanel"/);
assert.match(sheetBody, /aria-labelledby="sheetTab/);
assert.match(functionBlock("renderSheet"), /aria-selected/);
assert.match(functionBlock("renderSheet"), /tabIndex|tabindex/);
assert.match(functionBlock("renderSheet"), /aria-labelledby/);
assert.match(app, /ArrowLeft|ArrowRight/);

for (const contract of [
  /--control-height-default:\s*44px/,
  /--control-height-compact:\s*36px/,
  /--touch-target-min:\s*44px/,
  /--content-max-width:/,
  /env\(safe-area-inset-bottom\)/,
  /@media\s*\(max-width:\s*390px\)/,
  /min-width:\s*721px/,
  /max-width:\s*1120px/,
  /@media\s*\(min-width:\s*1024px\)/,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
]) {
  assert.match(css, contract);
}

assert.match(css, /:focus-visible/);
assert.match(css, /var\(--focus-ring\)|--focus-ring:/, "common focus treatment must use the semantic focus ring");
assert.match(
  css,
  /@media\s*\(max-width:\s*1023px\)[^{]*\{[\s\S]*?:is\(body\.role-admin,\s*body\.role-b2b\)\s+\.app-legal-footer\s*\{[^}]*margin-bottom:\s*calc\(var\(--touch-target-min\)\s*\+\s*var\(--spacing-8\)\)/,
  "mobile legal footer must clear the fixed application navigation"
);
assert.match(
  css,
  /:is\(body\.role-admin,\s*body\.role-b2b\)\s+button:is\(\.primary-button,\s*\.secondary-button,\s*\.ghost-button,\s*\.small-button\):disabled\s*\{[^}]*border-color:\s*var\(--color-disabled-border\)[^}]*background:\s*var\(--color-disabled-surface\)[^}]*color:\s*var\(--color-disabled-text\)/,
  "common action buttons must keep a visibly distinct semantic disabled state"
);

const commonStateTokenContracts = new Map([
  ["loading", "color-status-info"],
  ["empty", "color-text-tertiary"],
  ["error", "color-status-danger"],
  ["disabled", "color-disabled-text"],
  ["pending", "color-status-info"],
  ["success", "color-status-success"],
  ["warning", "color-status-warning"],
]);
for (const [state, token] of commonStateTokenContracts) {
  const stateRule = new RegExp(`(?:\\.ui-state|\\.ui-inline-alert|\\.ui-badge)[^{}]*\\[data-(?:state|tone)=["'](?:${state}|${state === "error" ? "danger" : state})["'][^{}]*\\][^{]*\\{[^}]*var\\(--${token}\\)`, "s");
  assert.match(css, stateRule, `common ${state} state must use --${token}`);
}

const unscopedBodyRules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|})\s*body\s*\{([^{}]*)\}/gm)];
for (const match of unscopedBodyRules) {
  assert.doesNotMatch(match[2], /overflow-x\s*:\s*hidden/, "global overflow-x hiding must not mask layout defects");
}

for (const preservedId of ["targetPanel", "decisionQueuePanel", "controlDrawer", "detailSheet", "appPrimaryNav", "drawerActions"]) {
  assert.equal((html.match(new RegExp(`id="${preservedId}"`, "g")) || []).length, 1, `${preservedId} must remain unique`);
}

console.log("Application shell, navigation, theme, preview boundary, overlay, and responsive UI contracts passed");
