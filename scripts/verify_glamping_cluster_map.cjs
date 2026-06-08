const path = require("path");
const modulePath = "C:\\Users\\User\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules";
process.env.NODE_PATH = modulePath;
require("module").Module._initPaths();

const { chromium } = require("playwright");

async function main() {
  const htmlPath = path.join(__dirname, "..", "outputs", "gyeongbuk_glamping_20260607", "gyeongbuk_cluster_map_test.html");
  const screenshotPath = path.join(__dirname, "..", "outputs", "gyeongbuk_glamping_20260607", "gyeongbuk_cluster_map_test.png");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });

  await page.goto(`file:///${htmlPath.replace(/\\/g, "/")}`);
  await page.waitForSelector("#markers .map-region");

  const title = await page.locator("h1").innerText();
  const markerCount = await page.locator("#markers .map-region").count();
  const detailBefore = await page.locator("#detail .region-title h2").innerText();
  await page.locator('button[data-mode="price"]').click();
  const activeButton = await page.locator("#modeButtons button.active").innerText();
  await page.locator('#markers .map-region[data-region="포항"]').click();
  const detailAfter = await page.locator("#detail .region-title h2").innerText();
  const svgBox = await page.locator("#map").boundingBox();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ title, markerCount, detailBefore, activeButton, detailAfter, svgBox, screenshotPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
