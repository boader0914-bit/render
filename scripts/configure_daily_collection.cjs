const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { defaultConfig, validateConfig, createDailyKeywordCollectionScheduler } = require("./daily_keyword_collection_scheduler.cjs");

async function main(args = process.argv.slice(2)) {
  const action = args[0];
  if (!["--enable", "--disable", "--status"].includes(action) || args[1] !== "--data-dir" || !args[2] || args.length !== 3) {
    throw new Error("Usage: node scripts/configure_daily_collection.cjs --enable|--disable|--status --data-dir /var/data");
  }
  const dataDir = path.resolve(args[2]);
  const configFile = path.join(dataDir, "config", "daily_keyword_collection.json");
  if (action !== "--status") {
    await fs.access(dataDir);
    let config = defaultConfig();
    try { config = validateConfig(JSON.parse((await fs.readFile(configFile, "utf8")).replace(/^\uFEFF/, ""))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    config.enabled = action === "--enable";
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const temporary = `${configFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, configFile);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  // This command only changes/reads policy. The web server owns execution.
  const scheduler = createDailyKeywordCollectionScheduler({ dataDir,
    runCrawler: async () => { throw new Error("configuration_command_cannot_collect"); },
    inspectResult: async () => { throw new Error("configuration_command_cannot_collect"); },
    isBusy: () => true });
  console.log(JSON.stringify(await scheduler.status(), null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
