const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { UI_V3_FEATURE_FLAG, readUiV3FeatureFlag } = require("./ui_v3_feature_flag.cjs");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const rootPackage = JSON.parse(read("package.json"));
assert.deepEqual(rootPackage.workspaces, ["apps/web", "packages/ui"]);
assert.equal(rootPackage.name, "glamping-datalab-v2");
assert.ok(fs.existsSync(path.join(ROOT, "package-lock.json")), "root package-lock.json is required");

const ignoredDirectories = new Set([".git", "node_modules", "dist", "artifacts", "outputs", "db"]);
function lockfiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return lockfiles(fullPath);
    return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].includes(entry.name) ? [fullPath] : [];
  });
}
assert.deepEqual(lockfiles(ROOT).map((file) => path.relative(ROOT, file).replace(/\\/g, "/")), ["package-lock.json"]);

const packageLock = JSON.parse(read("package-lock.json"));
const reactInstallations = Object.entries(packageLock.packages)
  .filter(([packagePath]) => /(?:^|\/)node_modules\/react$/.test(packagePath))
  .map(([packagePath, metadata]) => ({ packagePath, version: metadata.version }));
const reactDomInstallations = Object.entries(packageLock.packages)
  .filter(([packagePath]) => /(?:^|\/)node_modules\/react-dom$/.test(packagePath))
  .map(([packagePath, metadata]) => ({ packagePath, version: metadata.version }));
assert.deepEqual(reactInstallations, [{ packagePath: "node_modules/react", version: "19.2.7" }], "React must have one root installation");
assert.deepEqual(reactDomInstallations, [{ packagePath: "node_modules/react-dom", version: "19.2.7" }], "React DOM must have one root installation");

assert.equal(readUiV3FeatureFlag({}), false);
assert.equal(readUiV3FeatureFlag({ V2_UI_V3_ENABLED: "false" }), false);
assert.equal(readUiV3FeatureFlag({ V2_UI_V3_ENABLED: "true" }), true);
for (const key of ["owner", "approver", "dependsOn", "defaultValue", "targetRoles", "rolloutOrder", "observe", "rollback"]) {
  assert.notEqual(UI_V3_FEATURE_FLAG[key], undefined, `UI flag governance is missing ${key}`);
}

const indexHtml = read("apps/web/index.html");
assert.ok(indexHtml.indexOf('/theme-boot.js') < indexHtml.indexOf('/src/main.tsx'), "theme boot must run before React");
assert.match(indexHtml, /data-v2-ui-root/);
assert.doesNotMatch(indexHtml, /\/styles\.css|\/app\.js/);
const themeBoot = read("apps/web/public/theme-boot.js");
assert.match(themeBoot, /lodging-v2-theme/);
assert.match(themeBoot, /saved === "dark" \? "dark" : "light"/);

const routeSource = read("apps/web/src/routeRegistry.ts");
assert.equal((routeSource.match(/role: "business"/g) || []).length, 9);
assert.equal((routeSource.match(/role: "admin"/g) || []).length, 13);
for (const route of ["/login", "/signup", "/activate", "/reset-password", "/admin", "/b2b", "/view"]) assert.ok(routeSource.includes(`"${route}"`));

for (const cssFile of ["packages/ui/src/styles.css", "apps/web/src/app.css"]) {
  const css = read(cssFile);
  const selectorLines = css.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith("{") && !line.startsWith("@"));
  for (const line of selectorLines) {
    assert.ok(
      line.startsWith(":root") || line.startsWith("body[data-v2-ui") || line.startsWith("[data-v2-ui-root]"),
      `${cssFile} has an unscoped selector: ${line}`
    );
  }
}

const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest"));
assert.equal(manifest.name, "숙박 데이터랩");
assert.equal(manifest.id, "/b2b");
assert.equal(manifest.start_url, "/b2b");
assert.equal(manifest.scope, "/");
const serviceWorker = read("apps/web/public/sw.js");
assert.match(serviceWorker, /glamping-datalab-v2-ui-v3-stage225-v1/);
assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
assert.match(serviceWorker, /url\.pathname\.startsWith\("\/outputs\/"\)/);
assert.match(serviceWorker, /PURGE_V2_UI_CACHES/);

childProcess.execFileSync("git", ["diff", "--exit-code", "--", "web"], { cwd: ROOT, stdio: "pipe" });
assert.ok(fs.existsSync(path.join(ROOT, "docs", "stage225_v3_ui_foundation.md")), "Stage 225 implementation record is required");
assert.ok(fs.existsSync(path.join(ROOT, "docs", "stage225_ui_rollback_runbook.md")), "Stage 225 rollback runbook is required");
const completionEvidence = JSON.parse(read("docs/stage225_completion_evidence.json"));
assert.equal(completionEvidence.stage, 225);
assert.equal(completionEvidence.status, "complete");
assert.deepEqual(completionEvidence.blockers, []);
assert.equal(completionEvidence.verification.legacyWebDiffCount, 0);
assert.equal(completionEvidence.dataImpact.migration + completionEvidence.dataImpact.backfill + completionEvidence.dataImpact.dualWrite, 0);
assert.equal(completionEvidence.deployment.staging || completionEvidence.deployment.production, false);

console.log("Stage 225 workspace, route, theme, PWA, CSS and legacy-boundary checks passed");
