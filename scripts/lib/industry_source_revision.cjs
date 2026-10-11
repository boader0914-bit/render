"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// Fingerprint saved inputs by file metadata, without parsing large observations
// or provider payloads. Generated industry/company aggregates are excluded.
function createIndustrySourceRevision({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile }) {
  const calendarDir = path.join(dataDir, "history", "special_days");
  const singles = [regionMasterFile, tourismRegionMapFile].filter(Boolean);
  return async function readIndustrySourceRevision() {
    const rows = [];
    async function fileStamp(file, label) {
      try {
        const stat = await fs.stat(file, { bigint: true });
        if (stat.isFile()) rows.push(`${label}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    async function tree(directory, label, depth = 0, runs = false) {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name), next = `${label}/${entry.name}`;
        if (entry.isDirectory() && depth < (runs ? 2 : 4)
          && (!runs || (depth === 0 ? /_glamping_\d{8}(?:_\d{6})?$/.test(entry.name) : entry.name === "details"))) await tree(file, next, depth + 1, runs);
        else if (entry.isFile() && /\.(?:json|csv)$/i.test(entry.name)) await fileStamp(file, next);
      }
    }
    // A single scan in progress is shared by the service. Keep I/O bounded here.
    if (outputsDir) await tree(outputsDir, "runs", 0, true);
    await tree(calendarDir, "calendar");
    for (let index = 0; index < singles.length; index++) await fileStamp(singles[index], `file${index}`);
    return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex");
  };
}

module.exports = { createIndustrySourceRevision };
