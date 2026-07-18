const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { unzipSync, strFromU8 } = require("fflate");
const {
  IMPORT_LIMITS,
  parseYeogiImportSafely,
  publicImportError,
  validateImportMetadata,
  validateImportSourceText
} = require("./import_security.cjs");
const { parseYeogiImport } = require("./yeogi_import_parser.cjs");
const { buildWorkbook } = require("./spreadsheet_export.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");

function assertCode(callback, expectedCode) {
  assert.throws(callback, (error) => error?.code === expectedCode);
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function waitForServer(baseUrl, child) {
  const timeoutAt = Date.now() + 15000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function startServer(dataDir) {
  const port = 45000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      NODE_ENV: "production",
      RENDER: "true",
      APP_USER: "business",
      APP_PIN: "business-pin",
      ADMIN_USER: "operator",
      ADMIN_PIN: "admin-pin",
      AUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      AUTH_ORIGIN_ENFORCE: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);
  return {
    baseUrl,
    async stop() {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      if (child.exitCode && child.exitCode !== 0) throw new Error(stderr || `server exited with code ${child.exitCode}`);
    }
  };
}

async function testSpreadsheetExport(tempDir) {
  const output = path.join(tempDir, "regression.xlsx");
  await buildWorkbook(output, [
    {
      name: "Market/Overview",
      columns: ["name", "price", "note"],
      rows: [
        { name: "Secure Stay", price: 249000, note: "=HYPERLINK(\"https://invalid.test\")" },
        { name: "Peer Camp", price: 189000, note: "normal" }
      ]
    },
    {
      name: "Market/Overview",
      columns: ["status"],
      rows: [{ status: "ready" }]
    }
  ]);

  const bytes = await fs.readFile(output);
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
  const archive = unzipSync(new Uint8Array(bytes));
  const workbookXml = strFromU8(archive["xl/workbook.xml"]);
  assert.match(workbookXml, /Market Overview/);
  assert.match(workbookXml, /Market Overview \(2\)/);

  const worksheetXml = Object.entries(archive)
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, content]) => strFromU8(content))
    .join("\n");
  assert.doesNotMatch(worksheetXml, /<f(?:\s|>)/, "formula nodes must not be written");
  await assert.rejects(
    buildWorkbook(path.join(tempDir, "invalid.xls"), [{ name: "x", columns: ["a"], rows: [] }]),
    (error) => error?.code === "XLSX_EXTENSION_REQUIRED"
  );
}

async function testImportBoundaries() {
  const validCsv = [
    "rank,name,price,location,reservation_available,raw",
    '1,"Blue Ridge Glamping","120000","Pocheon","Y","available"'
  ].join("\n");
  assert.equal(parseYeogiImport(validCsv).length, 1);
  assert.equal((await parseYeogiImportSafely(validCsv)).length, 1);

  const formulaCsv = [
    "rank,name,price",
    '1,"=HYPERLINK(\"\"https://invalid.test\"\")","120000"'
  ].join("\n");
  assertCode(() => parseYeogiImport(formulaCsv), "IMPORT_FORMULA_BLOCKED");
  assertCode(() => parseYeogiImport('rank,name\n1,"unclosed'), "IMPORT_STRUCTURE_INVALID");
  assertCode(
    () => parseYeogiImport(`rank,name,${Array.from({ length: IMPORT_LIMITS.maxColumns }, (_, index) => `c${index}`).join(",")}\n1,x`),
    "IMPORT_COLUMN_LIMIT"
  );
  assertCode(() => validateImportSourceText("x".repeat(IMPORT_LIMITS.maxBytes + 1)), "IMPORT_SIZE_LIMIT");
  assertCode(() => validateImportMetadata({ fileName: "payload.xlsx", mimeType: "application/octet-stream" }), "IMPORT_EXTENSION_NOT_ALLOWED");
  assertCode(() => validateImportMetadata({ fileName: "payload.csv", mimeType: "application/octet-stream" }), "IMPORT_MIME_NOT_ALLOWED");
  validateImportMetadata({ fileName: "payload.csv", mimeType: "text/csv; charset=utf-8" });

  const safeError = publicImportError(Object.assign(new Error("C:\\secret\\parser.cjs"), { code: "ENOENT" }));
  assert.equal(safeError.statusCode, 500);
  assert.deepEqual(safeError.body, {
    error: "The import data could not be processed.",
    code: "IMPORT_FAILED"
  });
}

async function testAdminImportAuth(tempDir) {
  const server = await startServer(tempDir);
  try {
    const denied = await fetch(`${server.baseUrl}/api/yeogi-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.baseUrl },
      body: "{}"
    });
    assert.equal(denied.status, 401);

    const businessDenied = await fetch(`${server.baseUrl}/api/yeogi-import`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("business", "business-pin"),
        "Content-Type": "application/json",
        Origin: server.baseUrl
      },
      body: "{}"
    });
    assert.equal(businessDenied.status, 403);

    const invalidType = await fetch(`${server.baseUrl}/api/yeogi-import`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("operator", "admin-pin"),
        "Content-Type": "text/plain",
        Origin: server.baseUrl
      },
      body: "{}"
    });
    assert.equal(invalidType.status, 415);
    const payload = await invalidType.json();
    assert.equal(payload.code, "IMPORT_FAILED");
    assert.doesNotMatch(JSON.stringify(payload), /parser|stack|scripts|\\|\//i);
  } finally {
    await server.stop();
  }
}

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "glamping-import-security-"));
  try {
    await testSpreadsheetExport(tempDir);
    await testImportBoundaries();
    await testAdminImportAuth(tempDir);
    console.log("import and spreadsheet security tests passed");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
