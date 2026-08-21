const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const CASES = [
  { keyword: "경남펜션", requested: "company", expected: "keyword" },
  { keyword: "경남 펜션", requested: "company", expected: "keyword" },
  { keyword: "경남글램핑", requested: "company", expected: "keyword" },
  { keyword: "경남풀빌라", requested: "company", expected: "keyword" },
  { keyword: "경상남도 펜션", requested: "company", expected: "keyword" },
  { keyword: "경상남펜션", requested: "company", expected: "keyword" },
  { keyword: "전라북펜션", requested: "company", expected: "keyword" },
  { keyword: "산청풀빌라", requested: "company", expected: "keyword" },
  { keyword: "포천오토캠핑장", requested: "company", expected: "keyword" },
  { keyword: "경남카라반캠핑장", requested: "company", expected: "keyword" },
  { keyword: "포천글램핑장", requested: "company", expected: "keyword" },
  { keyword: "가평캠핑장", requested: "company", expected: "keyword" },
  { keyword: "강원야영장", requested: "company", expected: "keyword" },
  { keyword: "제주카라반", requested: "company", expected: "keyword" },
  { keyword: "경남캠핑", requested: "company", expected: "keyword" },
  { keyword: "제주 글램핑", requested: "company", expected: "keyword" },
  { keyword: "거제생각속의집펜션", requested: "company", expected: "company" },
  { keyword: "월명글램핑", requested: "company", expected: "company" },
  { keyword: "산청애펜션", requested: "company", expected: "company" },
  { keyword: "경남리조트", requested: "company", expected: "company" },
  { keyword: "경남펜션", requested: "keyword", expected: "keyword" }
];

const COLLECTION_RANGE_CASES = [
  {
    label: "basic default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "precision" },
    expectedRange: "1-40",
    expectedStockLimit: 40,
    expectedWeeklyLimit: 0
  },
  {
    label: "detail default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "revenue_detail", collectionMode: "precision" },
    expectedRange: "1-20",
    expectedStockLimit: 20,
    expectedWeeklyLimit: 20
  },
  {
    label: "basic custom",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "precision", detailRankRanges: "1-15" },
    expectedRange: "1-15",
    expectedStockLimit: 15,
    expectedWeeklyLimit: 0
  },
  {
    label: "fast safety",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "fast" },
    expectedRange: "없음",
    expectedStockLimit: 0,
    expectedWeeklyLimit: 0
  }
];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(baseUrl, method, pathname, body, cookies = []) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Cookie: cookies.join("; ")
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { raw: data };
        }
        const setCookie = res.headers["set-cookie"] || [];
        resolve({
          statusCode: res.statusCode,
          cookies: setCookie.map((item) => item.split(";")[0]),
          body: parsed
        });
      });
    });
    req.once("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error(`request timeout: ${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    child.kill();
    timer = setTimeout(finish, 5000);
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 20000);
    const onData = (chunk) => {
      if (!String(chunk || "").includes("Lodging datalab beta app running")) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before ready: ${code}`));
    });
  });
}

async function loadClientClassifier() {
  const appPath = path.resolve(__dirname, "..", "web", "app.js");
  const source = await fsp.readFile(appPath, "utf8");
  const start = source.indexOf("const REGIONAL_GLAMPING_BASES");
  const end = source.indexOf("function adminUserViewRequested", start);
  assert.ok(start >= 0 && end > start, "client search-mode classifier source block not found");
  const context = {};
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.__searchModeTest = { correctedSearchMode };`,
    context,
    { filename: appPath }
  );
  return context.__searchModeTest;
}

async function verifyClientClassifier() {
  const classifier = await loadClientClassifier();
  for (const testCase of CASES) {
    assert.equal(
      classifier.correctedSearchMode(testCase.keyword, testCase.requested),
      testCase.expected,
      `client mode mismatch for ${testCase.keyword}`
    );
  }
}

async function verifyClientCollectionRangeHelpers() {
  const appPath = path.resolve(__dirname, "..", "web", "app.js");
  const source = await fsp.readFile(appPath, "utf8");
  const start = source.indexOf("function normalizedRankRangeText");
  const end = source.indexOf("function rankRangeCountFromText", start);
  assert.ok(start >= 0 && end > start, "client collection range helper block not found");
  const context = {};
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.__collectionRangeTest = { rankRangeEndFromText, canonicalCrawlFormRange };`,
    context,
    { filename: appPath }
  );
  const helper = context.__collectionRangeTest.rankRangeEndFromText;
  assert.equal(helper("1-40", "1-20"), 40, "basic end rank should stay 40");
  assert.equal(helper("1-20", "1-40"), 20, "detail end rank should stay 20");
  assert.equal(helper("", "1-40"), 40, "empty end rank should restore the purpose default");
  assert.equal(helper("invalid", "1-20"), 20, "invalid end rank should restore the purpose default");
  const canonical = context.__collectionRangeTest.canonicalCrawlFormRange;
  assert.equal(canonical("10-20", "revenue_detail"), "1-20", "detail recrawl ranges must start at rank 1");
  assert.equal(canonical("1-30", "revenue_detail"), "1-20", "detail recrawl ranges must stay within rank 20");
  assert.equal(canonical("1-15", "basic_db"), "1-15", "basic custom ranges must remain editable");
}

async function verifyServerClassifier() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "search-mode-classification-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "glamping_app_server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: path.join(tmp, "data"),
      OUTPUTS_DIR: path.join(tmp, "outputs"),
      CONFIG_DIR: path.join(tmp, "config"),
      GLAMPING_ADMIN_USER: "admin",
      GLAMPING_ADMIN_PASSWORD: "0914"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await request(baseUrl, "POST", "/api/login", { username: "admin", password: "0914" });
    assert.equal(login.statusCode, 200, "admin login should succeed");

    for (const testCase of CASES) {
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword: testCase.keyword,
        searchMode: testCase.requested,
        collectionMode: "fast",
        collectionPurpose: "basic_db",
        detailRankRanges: "none"
      }, login.cookies);
      assert.equal(estimate.statusCode, 200, `estimate failed for ${testCase.keyword}`);
      assert.equal(estimate.body.searchMode, testCase.expected, `server mode mismatch for ${testCase.keyword}`);
      assert.equal(estimate.body.estimateBasis?.searchMode, testCase.expected, `server basis mismatch for ${testCase.keyword}`);
    }

    for (const testCase of COLLECTION_RANGE_CASES) {
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", testCase.payload, login.cookies);
      assert.equal(estimate.statusCode, 200, `estimate failed for ${testCase.label}`);
      assert.equal(estimate.body.productMode, "all", `${testCase.label} should collect all products`);
      assert.equal(estimate.body.detailRankRanges, testCase.expectedRange, `${testCase.label} range mismatch`);
      assert.equal(estimate.body.bookingStockPlaceLimit, testCase.expectedStockLimit, `${testCase.label} stock limit mismatch`);
      assert.equal(estimate.body.bookingRangePlaceLimit, testCase.expectedWeeklyLimit, `${testCase.label} weekly limit mismatch`);
      assert.equal(estimate.body.estimateBasis?.bookingStockPlaceLimit, testCase.expectedStockLimit, `${testCase.label} basis stock limit mismatch`);
    }
  } finally {
    await stopChild(child);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await verifyClientClassifier();
  await verifyClientCollectionRangeHelpers();
  await verifyServerClassifier();
  console.log("Search mode classification tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
