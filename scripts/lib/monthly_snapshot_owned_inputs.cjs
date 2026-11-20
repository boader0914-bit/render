"use strict";

// These are trusted producer capabilities, not user-supplied source labels.
// They record an observations-array identity; they do not prove JSON purity,
// content immutability, provenance hashes, or that a callback is actually pure.
const savedSources = new WeakMap();
const industryDiscards = new WeakSet();
const activeScopes = new WeakMap();

function sourceObject(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}
function observationsOf(source) {
  if (!sourceObject(source)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, "observations");
    return descriptor && Object.hasOwn(descriptor, "value") && Array.isArray(descriptor.value)
      ? descriptor.value : null;
  } catch { return null; }
}

// Call only after the trusted producer has established its owned JSON input.
function markSavedMonthlyJsonSource(source) {
  if (!sourceObject(source)) return source;
  const observations = observationsOf(source);
  if (observations === null) savedSources.delete(source);
  else savedSources.set(source, observations);
  return source;
}

// Carry authority only across a wrapper that preserves the same current array.
function carrySavedMonthlyJsonSource(from, to) {
  if (!sourceObject(to)) return to;
  const observations = sourceObject(from) ? savedSources.get(from) : undefined;
  const valid = observations !== undefined
    && observationsOf(from) === observations && observationsOf(to) === observations;
  savedSources.delete(to);
  if (valid) savedSources.set(to, observations);
  return to;
}

// Registration is reserved for the industry's fixed internal diagnostic.
function registerIndustryDiscard(fn) {
  if (typeof fn !== "function") throw new TypeError("Industry discard must be a function");
  industryDiscards.add(fn);
  return fn;
}

function scopeFor(scopedSource, original, onDiscard) {
  if (!sourceObject(scopedSource) || !sourceObject(original) || !industryDiscards.has(onDiscard)) return null;
  const observations = savedSources.get(original);
  if (observations === undefined || observationsOf(original) !== observations
    || observationsOf(scopedSource) !== observations) return null;
  return { original, observations, onDiscard };
}

function withIndustryEvidenceScope(scopedSource, brandedOriginal, onDiscard, work) {
  if (typeof work !== "function") throw new TypeError("Industry evidence work must be a function");
  const scoped = sourceObject(scopedSource);
  const previous = scoped ? activeScopes.get(scopedSource) : undefined;
  // Even an invalid nested scope must not inherit this source's outer authority.
  if (scoped) activeScopes.delete(scopedSource);
  try {
    const scope = scopeFor(scopedSource, brandedOriginal, onDiscard);
    if (scope) activeScopes.set(scopedSource, scope);
    // Deliberately do not await, inspect a thenable, or extend an async scope.
    return work();
  } finally {
    if (scoped) {
      if (previous === undefined) activeScopes.delete(scopedSource);
      else activeScopes.set(scopedSource, previous);
    }
  }
}

function mayBorrowMonthlyEvidence(source, onDiscard) {
  // A WeakMap lookup invokes no observations getter, including on unbranded input.
  const scope = activeScopes.get(source);
  if (!scope || scope.onDiscard !== onDiscard || !industryDiscards.has(onDiscard)) return false;
  return savedSources.get(scope.original) === scope.observations
    && observationsOf(scope.original) === scope.observations
    && observationsOf(source) === scope.observations;
}

module.exports = Object.freeze({
  markSavedMonthlyJsonSource, carrySavedMonthlyJsonSource, registerIndustryDiscard,
  withIndustryEvidenceScope, mayBorrowMonthlyEvidence
});
