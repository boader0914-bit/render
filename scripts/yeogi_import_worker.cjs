const { parentPort, workerData } = require("node:worker_threads");
const { parseYeogiImport } = require("./yeogi_import_parser.cjs");

try {
  const rows = parseYeogiImport(workerData?.sourceText || "");
  parentPort.postMessage({ ok: true, rows });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: error?.code || "IMPORT_PARSE_FAILED",
    message: error?.message || "Import parsing failed."
  });
}
