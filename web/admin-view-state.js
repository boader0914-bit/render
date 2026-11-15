(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdminViewState = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Only in-memory view state lives here. Updates never read or write storage,
  // URLs, the DOM or application data, and never schedule work.
  const limits = Object.freeze({ maxBytes: 256 * 1024, maxDepth: 16, maxNodes: 4096,
    maxObjectKeys: 256, maxArrayLength: 2048, maxStringLength: 64 * 1024 });
  const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
  const nativeObject = Function.prototype.toString.call(Object);
  const nativeArray = Function.prototype.toString.call(Array);

  function fail(code, limit) {
    const error = new TypeError(`AdminViewState: ${code}`);
    error.code = `ADMIN_VIEW_STATE_${code}`;
    if (limit) error.limit = limit;
    throw error;
  }

  function plainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) return true;
    // A native Object prototype from another frame/realm is still plain JSON.
    const constructor = Object.getOwnPropertyDescriptor(proto, "constructor");
    return Object.getPrototypeOf(proto) === null && constructor && "value" in constructor
      && typeof constructor.value === "function" && Function.prototype.toString.call(constructor.value) === nativeObject;
  }

  function ordinaryArray(value) {
    const proto = Object.getPrototypeOf(value);
    if (proto === Array.prototype) return true;
    const constructor = proto && Object.getOwnPropertyDescriptor(proto, "constructor");
    return Boolean(constructor && "value" in constructor && typeof constructor.value === "function"
      && Function.prototype.toString.call(constructor.value) === nativeArray);
  }

  function cloneRoot(value) {
    if (!plainObject(value)) fail("ROOT_OBJECT_REQUIRED");
    const ancestors = new Set();
    let nodes = 0, bytes = 0;
    function addBytes(count) {
      bytes += count;
      if (bytes > limits.maxBytes) fail("LIMIT_EXCEEDED", "maxBytes");
    }
    function quotedString(value) {
      if (value.length > limits.maxStringLength) fail("LIMIT_EXCEEDED", "maxStringLength");
      addBytes(2);
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 34 || code === 92) addBytes(2);
        else if (code <= 31) addBytes([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) { addBytes(4); index++; }
          else addBytes(6); // JSON's escaped lone surrogate.
        } else if (code >= 0xdc00 && code <= 0xdfff) addBytes(6);
        else addBytes(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3);
      }
    }
    function clone(value, depth) {
      if (depth > limits.maxDepth) fail("LIMIT_EXCEEDED", "maxDepth");
      if (++nodes > limits.maxNodes) fail("LIMIT_EXCEEDED", "maxNodes");
      if (value === null) { addBytes(4); return null; }
      if (typeof value === "string") { quotedString(value); return value; }
      if (typeof value === "boolean") { addBytes(value ? 4 : 5); return value; }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) fail("UNSUPPORTED_VALUE");
        addBytes(String(value).length); return Object.is(value, -0) ? 0 : value;
      }
      if (typeof value !== "object") fail("UNSUPPORTED_VALUE");
      const array = Array.isArray(value);
      if (array ? !ordinaryArray(value) : !plainObject(value)) fail("UNSAFE_OBJECT");
      if (ancestors.has(value)) fail("CYCLE");
      if (array && value.length > limits.maxArrayLength) fail("LIMIT_EXCEEDED", "maxArrayLength");
      const keys = Reflect.ownKeys(value);
      if (!array && keys.length > limits.maxObjectKeys) fail("LIMIT_EXCEEDED", "maxObjectKeys");
      for (const key of keys) {
        if (typeof key !== "string") fail("UNSUPPORTED_VALUE");
        if (unsafeKeys.has(key)) fail("UNSAFE_KEY");
        if (array && key === "length") continue;
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail("UNSAFE_OBJECT");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) fail("ACCESSOR_NOT_ALLOWED");
        if (!descriptor.enumerable) fail("UNSAFE_OBJECT");
      }
      if (array && keys.length !== value.length + 1) fail("SPARSE_ARRAY_NOT_ALLOWED");
      ancestors.add(value); addBytes(2);
      const copy = array ? [] : {};
      for (let index = 0; index < (array ? value.length : keys.length); index++) {
        const key = array ? String(index) : keys[index];
        if (index) addBytes(1);
        if (!array) { quotedString(key); addBytes(1); }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) fail("SPARSE_ARRAY_NOT_ALLOWED");
        copy[key] = clone(descriptor.value, depth + 1);
      }
      ancestors.delete(value);
      return copy;
    }
    return clone(value, 0);
  }

  function create(initial = {}) {
    const baseline = cloneRoot(initial);
    let current = cloneRoot(baseline);
    function snapshot() { return cloneRoot(current); }
    return Object.freeze({
      snapshot,
      // Top-level merge only: nested draft/selection objects are replaced whole.
      update(patch) {
        const checked = cloneRoot(patch);
        const next = cloneRoot(Object.assign({}, current, checked));
        current = next;
        return snapshot();
      },
      replace(next) { const checked = cloneRoot(next); current = checked; return snapshot(); },
      // Baseline is private; no previous selection or edited draft is retained.
      clear() { current = cloneRoot(baseline); return snapshot(); }
    });
  }
  return Object.freeze({ create, limits });
});
