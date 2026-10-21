"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const { setImmediate: yieldToLoop } = require("node:timers/promises");

/**
 * Find only the incoming observation IDs already present in append-only history.
 * Memory is bounded by the candidate IDs and one input line, not history size.
 * The caller must retain its existing shared write lock across this read and
 * the subsequent append; this read-only helper is not a write transaction.
 */
async function findExistingObservationIds({ file, observationIds, checkpoint = async () => {} } = {}) {
  if (typeof file !== "string" || !file) throw new TypeError("file is required");
  if (!Array.isArray(observationIds) && !(observationIds instanceof Set)) throw new TypeError("observationIds must be an Array or Set");
  if (typeof checkpoint !== "function") throw new TypeError("checkpoint must be a function");
  // Do not coerce IDs. Existing history compares observationId using Set/Map
  // identity, and silently coercing a numeric ID could exclude a new string ID.
  const candidates = new Set(observationIds), existingIds = new Set();
  const stats = { candidateCount: candidates.size, scannedLines: 0, parsedRows: 0, malformedLines: 0, blankLines: 0,
    matchedRows: 0, retainedIdCount: 0, maxRetainedIds: 0, yieldCount: 0, missingFile: false, skippedEmptyCandidates: candidates.size === 0 };
  if (!candidates.size) return { existingIds, stats, needsSeparator: false };

  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let streamError = null, lastCharacterCode = null;
  // Keep an error listener until destroy/close completes. In particular, do not
  // interpret a read error as empty history and allow duplicate append writes.
  const rememberError = error => { streamError = error; };
  stream.on("error", rememberError);
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Track one character only, independently of whether the final JSON line is
  // valid. Appending after an unterminated or truncated tail needs a separator
  // so the newly serialized observation does not become part of that old line.
  const rememberTail = chunk => {
    if (chunk.length) lastCharacterCode = typeof chunk === "string" ? chunk.charCodeAt(chunk.length - 1) : chunk[chunk.length - 1];
  };
  stream.on("data", rememberTail);
  try {
    for await (const line of input) {
      stats.scannedLines++;
      const text = stats.scannedLines === 1 ? line.replace(/^\uFEFF/, "") : line;
      if (!text.trim()) stats.blankLines++;
      else {
        let row;
        try { row = JSON.parse(text); }
        catch { stats.malformedLines++; }
        if (row !== undefined) {
          stats.parsedRows++;
          // Retain the candidate ID only, never the observation object or an
          // unrelated historical ID. Duplicate historical lines remain benign.
          if (row?.observationId && candidates.has(row.observationId)) {
            existingIds.add(row.observationId); stats.matchedRows++;
            stats.retainedIdCount = existingIds.size;
            stats.maxRetainedIds = Math.max(stats.maxRetainedIds, existingIds.size);
          }
        }
      }
      // Even an all-blank or malformed history yields at the same cadence.
      if (stats.scannedLines % 256 === 0) {
        stats.yieldCount++;
        await yieldToLoop();
        await checkpoint({ ...stats });
      }
    }
    if (streamError) throw streamError;
    return { existingIds, stats, needsSeparator: lastCharacterCode !== null && lastCharacterCode !== 10 && lastCharacterCode !== 13 };
  } catch (error) {
    if (error === streamError && error.code === "ENOENT") {
      stats.missingFile = true;
      return { existingIds, stats, needsSeparator: false };
    }
    throw error;
  } finally {
    input.close();
    // destroy is required when parsing/checkpoint work throws before EOF.
    // Await close so callers cannot append while the old read handle is open.
    if (!stream.closed) {
      const closed = new Promise(resolve => stream.once("close", resolve));
      stream.destroy();
      await closed;
    }
    stream.removeListener("error", rememberError);
    stream.removeListener("data", rememberTail);
  }
}

module.exports = { findExistingObservationIds };
