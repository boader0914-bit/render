"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real popup lifecycle without app bootstrap, a server, or external requests.
// --source - permits the identical behavior checks against git show <base>:web/app.js.
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--source"), "Usage: node test_overlay_lifecycle.cjs [--source <path|->]");
const source = fs.readFileSync(args[1] === "-" ? 0 : args[1] || path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const functions = ["openSheet", "closeSheet", "openDrawer", "closeDrawer"];
const lifecycleFunctions = [
  "appOverlayFocusableElements", "appOverlayCanFocus", "focusAppOverlay", "syncAppOverlayState",
  "activateAppOverlay", "deactivateAppOverlay", "handleAppOverlayKeydown", "keepAppOverlayFocus"
];
const hasLifecycle = source.includes("function activateAppOverlay(");
if (hasLifecycle) functions.push(...lifecycleFunctions);
const declarations = functions.map((name) => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `Missing lifecycle function: ${name}`);
  return declaration;
});
if (hasLifecycle) {
  const declaration = source.match(/^const appOverlayState = .*;$/m)?.[0];
  assert.ok(declaration, "Missing overlay lifecycle state");
  declarations.unshift(declaration);
}

function fixture(initialOverflow = "", priority = "") {
  const styleValues = new Map(initialOverflow ? [["overflow", { value: initialOverflow, priority }]] : []);
  const style = {
    getPropertyValue: (key) => styleValues.get(key)?.value || "",
    getPropertyPriority: (key) => styleValues.get(key)?.priority || "",
    setProperty: (key, value, importance = "") => styleValues.set(key, { value, priority: importance }),
    removeProperty: (key) => styleValues.delete(key)
  };
  Object.defineProperty(style, "overflow", {
    get: () => style.getPropertyValue("overflow"), set: (value) => style.setProperty("overflow", value)
  });
  const document = { activeElement: null, nativeDialog: null };
  function element(name, parent = null, tabIndex = -1) {
    const attrs = new Map();
    const node = {
      name, parentElement: parent, children: [], hidden: false, inert: false, disabled: false,
      isConnected: true, tabIndex, visibility: "visible", scrollTop: 0,
      contains(target) { for (let current = target; current; current = current.parentElement) if (current === node) return true; return false; },
      closest(selector) {
        assert.equal(selector, "[hidden], [inert]");
        for (let current = node; current; current = current.parentElement) if (current.hidden || current.inert) return current;
        return null;
      },
      matches: (selector) => selector === ":disabled" && node.disabled,
      getClientRects: () => node.hidden || !node.isConnected ? [] : [{}],
      focus(options) { document.activeElement = node; node.focusOptions = options; },
      getAttribute: (key) => attrs.get(key) ?? null,
      hasAttribute: (key) => attrs.has(key),
      setAttribute(key, value) { attrs.set(key, String(value)); if (key === "tabindex") node.tabIndex = Number(value); },
      removeAttribute: (key) => attrs.delete(key),
      querySelector: (selector) => selector === '[role="dialog"]' ? node.dialog || null : null,
      querySelectorAll: () => node.controls || []
    };
    if (parent) parent.children.push(node);
    return node;
  }
  const body = element("body");
  body.style = style;
  document.body = body;
  const main = element("main", body);
  const opener = element("opener", main, 0);
  const footer = element("footer", body);
  footer.inert = true; // A pre-existing lock must survive our open/close cycle.
  function overlay(id) {
    const root = element(id, body);
    root.hidden = true;
    const markup = html.match(new RegExp(`<div class="(?:detail-sheet|control-drawer)" id="${id}"[^]*?<section([^>]*)>`))?.[1];
    assert.ok(markup?.includes('role="dialog"') && markup.includes('aria-modal="true"'), `${id}: real dialog semantics`);
    const dialog = element(`${id}-dialog`, root);
    root.dialog = dialog;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const close = element(`${id}-close`, dialog, 0);
    const control = element(`${id}-control`, dialog, 0);
    dialog.controls = [close, control];
    return { root, dialog, close, control };
  }
  const drawer = overlay("controlDrawer");
  const sheet = overlay("detailSheet");
  const sheetBody = element("sheetBody", sheet.dialog);
  sheetBody.scrollTop = 180;
  document.querySelector = (selector) => selector === "dialog[open]" ? document.nativeDialog : null;
  document.getElementById = (id) => id === "appMain" ? main : null;
  document.activeElement = opener;
  const state = { data: { availability: { items: [{ name: "offline popup fixture" }] } }, selectedItem: null };
  let renders = 0;
  const context = vm.createContext({
    state, document, window: { getComputedStyle: (node) => ({ visibility: node.visibility }) },
    els: { detailSheet: sheet.root, controlDrawer: drawer.root, sheetBody },
    renderSheet: () => { renders++; }, fetch: () => { throw new Error("Network is forbidden in lifecycle checks"); }
  });
  vm.runInContext(`${declarations.join("\n")}\nglobalThis.api = { ${functions.join(",")} };`, context);
  const api = context.api;
  function key(keyValue, shiftKey = false) {
    const event = { key: keyValue, shiftKey, target: document.activeElement, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    if (api.handleAppOverlayKeydown) api.handleAppOverlayKeydown(event);
    else if (keyValue === "Escape") { api.closeSheet(); api.closeDrawer(); }
    return event;
  }
  return { api, document, body, main, opener, footer, drawer, sheet, sheetBody, state, key, renders: () => renders };
}

let passed = 0;
const failures = [];
function check(label, work) {
  try { work(); passed++; } catch (error) { failures.push({ label, message: error.message.replace(/\s+/g, " ").slice(0, 260) }); }
}

for (const kind of ["sheet", "drawer"]) {
  check(`${kind}: opens as the only interactive modal and takes first focus`, () => {
    const f = fixture();
    kind === "sheet" ? f.api.openSheet(0) : f.api.openDrawer();
    const modal = f[kind];
    assert.equal(modal.root.hidden, false);
    assert.equal(f.body.style.overflow, "hidden");
    assert.equal(f.main.inert, true, "Background navigation must be inert");
    assert.equal(modal.root.inert, false);
    assert.equal(modal.root.getAttribute("data-overlay-active"), "true");
    assert.equal(modal.dialog.getAttribute("aria-modal"), "true");
    assert.equal(f.document.activeElement, modal.close, "Focus must enter the dialog");
  });
  check(`${kind}: Tab wraps both boundaries but leaves interior navigation native`, () => {
    const f = fixture();
    kind === "sheet" ? f.api.openSheet(0) : f.api.openDrawer();
    const modal = f[kind];
    f.document.activeElement = modal.close;
    assert.equal(f.key("Tab").defaultPrevented, false);
    assert.equal(f.key("Tab", true).defaultPrevented, true);
    assert.equal(f.document.activeElement, modal.control);
    assert.equal(f.key("Tab").defaultPrevented, true);
    assert.equal(f.document.activeElement, modal.close);
  });
  check(`${kind}: close restores opener, original overflow including priority, and prior inert state`, () => {
    const f = fixture("clip", "important");
    kind === "sheet" ? f.api.openSheet(0) : f.api.openDrawer();
    kind === "sheet" ? f.api.closeSheet() : f.api.closeDrawer();
    assert.equal(f[kind].root.hidden, true);
    assert.equal(f.main.inert, false);
    assert.equal(f.footer.inert, true);
    assert.equal(f.body.style.overflow, "clip");
    assert.equal(f.body.style.getPropertyPriority("overflow"), "important");
    assert.equal(f.document.activeElement, f.opener);
    assert.equal(f.opener.focusOptions?.preventScroll, true);
    kind === "sheet" ? f.api.closeSheet() : f.api.closeDrawer();
    assert.equal(f.body.style.overflow, "clip", "Closing an already hidden dialog must do nothing");
  });
}

for (const first of ["sheet", "drawer"]) {
  check(`${first} then another dialog: Escape closes only the top and keeps the lower lock`, () => {
    const f = fixture("auto");
    const second = first === "sheet" ? "drawer" : "sheet";
    first === "sheet" ? f.api.openSheet(0) : f.api.openDrawer();
    f.document.activeElement = f[first].control;
    second === "sheet" ? f.api.openSheet(0) : f.api.openDrawer();
    assert.equal(f[first].root.inert, true);
    assert.equal(f[first].dialog.getAttribute("aria-modal"), "false");
    assert.equal(f[second].root.getAttribute("data-overlay-active"), "true");
    assert.equal(f.key("Escape").defaultPrevented, true);
    assert.equal(f[second].root.hidden, true);
    assert.equal(f[first].root.hidden, false);
    assert.equal(f[first].root.inert, false);
    assert.equal(f[first].root.getAttribute("data-overlay-active"), "true");
    assert.equal(f.main.inert, true);
    assert.equal(f.body.style.overflow, "hidden");
    assert.equal(f.document.activeElement, f[first].control);
    f.key("Escape");
    assert.equal(f.document.activeElement, f.opener);
    assert.equal(f.body.style.overflow, "auto");
  });
}

check("Closing the lower dialog cannot unlock the page or lose the final opener", () => {
  const f = fixture();
  f.api.openSheet(0);
  f.document.activeElement = f.sheet.control;
  f.api.openDrawer();
  f.api.closeSheet();
  assert.equal(f.main.inert, true);
  assert.equal(f.body.style.overflow, "hidden");
  assert.equal(f.document.activeElement, f.drawer.close);
  f.api.closeDrawer();
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.body.style.getPropertyValue("overflow"), "");
});

check("Unexpected background focus returns to the current dialog", () => {
  const f = fixture();
  f.api.openSheet(0);
  f.document.activeElement = f.opener;
  f.api.keepAppOverlayFocus?.({ target: f.opener, stopPropagation() {} });
  assert.equal(f.document.activeElement, f.sheet.close);
});

check("Hidden/disabled controls are skipped; a dialog with no controls remains focusable", () => {
  const f = fixture();
  f.sheet.close.disabled = true;
  f.sheet.control.hidden = true;
  f.api.openSheet(0);
  assert.equal(f.document.activeElement, f.sheet.dialog);
  assert.equal(f.sheet.dialog.tabIndex, -1);
  assert.equal(f.key("Tab").defaultPrevented, true);
  assert.equal(f.document.activeElement, f.sheet.dialog);
});

check("Removed opener falls back to the main content without stealing scroll", () => {
  const f = fixture();
  f.api.openSheet(0);
  f.opener.isConnected = false;
  f.api.closeSheet();
  assert.equal(f.document.activeElement, f.main);
  assert.equal(f.main.focusOptions?.preventScroll, true);
});

check("Reopening an already open sheet preserves the original restore point", () => {
  const f = fixture("scroll");
  f.api.openSheet(0);
  f.api.openSheet(0);
  assert.equal(f.sheetBody.scrollTop, 0);
  assert.equal(f.renders(), 2);
  f.api.closeSheet();
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.body.style.overflow, "scroll");
});

check("Native showModal dialogs keep their own focus, Tab and Escape behavior", () => {
  const f = fixture();
  f.api.openSheet(0);
  const nativeInput = { name: "native-dialog-input" };
  f.document.nativeDialog = {};
  f.document.activeElement = nativeInput;
  f.api.keepAppOverlayFocus?.({ target: nativeInput, stopPropagation() {} });
  assert.equal(f.document.activeElement, nativeInput);
  assert.equal(f.key("Tab").defaultPrevented, false);
  assert.equal(f.key("Escape").defaultPrevented, false);
  assert.equal(f.sheet.root.hidden, false, "Native Escape must not also close the underlying sheet");
});

check("Invalid company selection leaves existing UI, focus and scroll lock untouched", () => {
  const f = fixture("auto");
  f.api.openSheet(999);
  assert.equal(f.sheet.root.hidden, true);
  assert.equal(f.body.style.overflow, "auto");
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.renders(), 0);
});

check("Product event bindings route keyboard and escaped focus through the lifecycle", () => {
  assert.match(source, /document\.addEventListener\("focusin", keepAppOverlayFocus, true\)/);
  assert.match(source, /document\.addEventListener\("keydown", \(event\) => \{\s*if \(handleAppOverlayKeydown\(event\)\) return;/);
});

console.log(`Overlay lifecycle checks: ${passed} passed, ${failures.length} failed`);
for (const failure of failures.slice(0, 8)) console.error(`${failure.label}: ${failure.message}`);
if (failures.length) process.exitCode = 1;
