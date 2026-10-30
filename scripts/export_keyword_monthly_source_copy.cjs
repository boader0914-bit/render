"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { inspect, copy, safeJson } = require("./lib/keyword_monthly_source_copy.cjs");
function args(values) {
  const result = {}, allowed = new Set(["mode", "source-data", "scratch-parent", "inspection", "copy-root", "output", "include-prepared"]);
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.replace(/^--/, "");
    if (!values[i]?.startsWith("--") || !allowed.has(key) || !values[i + 1] || Object.hasOwn(result, key)) throw Error("KEYWORD_COPY_ARGUMENTS");
    result[key] = values[i + 1];
  }
  if (!["inspect", "copy"].includes(result.mode) || !result["source-data"] || !path.isAbsolute(result["source-data"])) throw Error("KEYWORD_COPY_ARGUMENTS");
  for (const key of ["scratch-parent", "inspection", "copy-root", "output"]) if (result[key] && !path.isAbsolute(result[key])) throw Error("KEYWORD_COPY_ABSOLUTE_PATH_REQUIRED");
  if (result["include-prepared"] && !["true", "false"].includes(result["include-prepared"])) throw Error("KEYWORD_COPY_ARGUMENTS");
  if (result.mode === "copy" && (!result.inspection || !result["copy-root"])) throw Error("KEYWORD_COPY_INSPECTION_REQUIRED");
  return result;
}
async function run(values) {
  const input = args(values), options = { sourceDataDir: input["source-data"], scratchParent: input["scratch-parent"], includePrepared: input["include-prepared"] !== "false" };
  if (input.output) {
    const output = path.resolve(input.output), source = path.resolve(input["source-data"]), operations = path.join(source, "operations");
    // Receipts may be created only in an explicitly named operations folder,
    // or in the requested temporary scratch parent. Existing files are never replaced.
    const under = (parent, file) => file.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
    const scratch = input["scratch-parent"] && path.resolve(input["scratch-parent"]);
    if (!under(operations, output) && !(scratch && under(scratch, output) && !under(source, output))) throw Error("KEYWORD_COPY_RECEIPT_PATH_INVALID");
  }
  const value = input.mode === "inspect" ? await inspect(options) : await copy({ ...options, copyRoot: input["copy-root"], inspection: (await safeJson(input.inspection, 16 * 1024 * 1024)).value });
  if (input.output) await fs.writeFile(input.output, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  // The console contains no business rows, paths inside runs, credentials or contact data.
  return { mode: input.mode, state: value.state || "inspected", fileCount: value.fileCount, bytes: value.bytes, inventorySha256: value.inventorySha256 || value.sourceInventorySha256,
    sourceWrites: 0, ...(input.mode === "inspect" ? { scratchAvailableBytes: value.scratchAvailableBytes, conservativeRequiredBytes: value.conservativeRequiredBytes, canCopyWithReserve: value.canCopyWithReserve }
      : { copyRoot: value.copyRoot, captureManifestSha256: value.captureManifestSha256, sourcePreserved: value.sourcePreserved, elapsedMs: value.elapsedMs }) };
}
if (require.main === module) run(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(JSON.stringify({ code: error.code || (/^[A-Z0-9_]+$/.test(error.message || "") ? error.message : "KEYWORD_COPY_FAILED") })); process.exitCode = 1; });
module.exports = { run, args };
