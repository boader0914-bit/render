"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.resolve(__dirname, "run_collection_worker_naver_canary_once.cjs");
const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/gu;
const FORBIDDEN_RUNTIME_SPECIFIERS = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "node:sqlite",
  "sqlite",
  "better-sqlite3",
  "level",
]);
const FORBIDDEN_LOCAL_PATTERNS = Object.freeze([
  /(?:^|\/)secure_json_store\.cjs$/u,
  /(?:^|\/)collection_job_store\.cjs$/u,
  /(?:^|\/)collection_artifact_importer\.cjs$/u,
  /(?:^|\/)naver_provider_health_store\.cjs$/u,
  /(?:^|\/)collection_worker_canary_orchestrator\.cjs$/u,
  /(?:^|\/)glamping_app_server\.cjs$/u,
  /(?:^|\/)workbook_export\.cjs$/u,
  /(?:^|\/)company_master_shared_lock\.cjs$/u,
  /(?:^|\/)geocode_lodging_companies\.cjs$/u,
  /(?:^|\/)migrate_[^/]+\.cjs$/u,
]);

function relativeName(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/gu, "/");
}

function assertInsideRoot(filePath) {
  const relative = path.relative(ROOT, filePath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `worker require escaped repository root: ${filePath}`);
}

function resolveLocalRequire(parentFile, specifier) {
  const base = path.resolve(path.dirname(parentFile), specifier);
  assertInsideRoot(base);
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.cjs`, `${base}.js`, `${base}.json`, path.join(base, "index.cjs"), path.join(base, "index.js")];
  const resolved = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  assert.ok(resolved, `unable to resolve local worker require ${specifier} from ${relativeName(parentFile)}`);
  assertInsideRoot(resolved);
  return path.resolve(resolved);
}

function staticRequires(source, filePath) {
  const requires = [];
  const matchedRanges = [];
  for (const match of source.matchAll(STATIC_REQUIRE_PATTERN)) {
    requires.push(match[2]);
    matchedRanges.push([match.index, match.index + match[0].length]);
  }
  const withoutStaticRequires = [...source];
  for (const [start, end] of matchedRanges) {
    for (let index = start; index < end; index += 1) withoutStaticRequires[index] = " ";
  }
  assert.doesNotMatch(
    withoutStaticRequires.join(""),
    /\brequire\s*\(/u,
    `dynamic require is forbidden in worker execution graph: ${relativeName(filePath)}`,
  );
  return requires;
}

function inspectWorkerGraph(entryFile) {
  const pending = [path.resolve(entryFile)];
  const visited = new Set();
  const edges = [];
  const forbidden = [];

  while (pending.length) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const specifier of staticRequires(source, filePath)) {
      edges.push(Object.freeze({ from: relativeName(filePath), specifier }));
      if (FORBIDDEN_RUNTIME_SPECIFIERS.has(specifier)) {
        forbidden.push(`${relativeName(filePath)} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveLocalRequire(filePath, specifier);
      const relative = relativeName(resolved);
      if (FORBIDDEN_LOCAL_PATTERNS.some((pattern) => pattern.test(relative))) {
        forbidden.push(`${relativeName(filePath)} -> ${relative}`);
      }
      pending.push(resolved);
    }
  }

  return Object.freeze({
    files: Object.freeze([...visited].map(relativeName).sort()),
    edges: Object.freeze(edges),
    forbidden: Object.freeze(forbidden.sort()),
  });
}

const graph = inspectWorkerGraph(ENTRY);
assert.ok(graph.files.includes("scripts/run_collection_worker_naver_canary_once.cjs"));
assert.ok(graph.files.includes("scripts/collection_worker_naver_canary.cjs"));
assert.deepEqual(
  graph.forbidden,
  [],
  `worker execution graph contains write-capable dependencies:\n${graph.forbidden.join("\n")}`,
);

const cliSource = fs.readFileSync(ENTRY, "utf8");
assert.match(
  cliSource,
  /result\.status\s*!==\s*["']ready["'][\s\S]*?process\.exitCode\s*=\s*2\s*;/u,
  "non-ready worker results must set exit code 2",
);
assert.match(
  cliSource,
  /catch\s*\([^)]*\)\s*\{[\s\S]*?safeFatalResult\([^)]+\)[\s\S]*?process\.exitCode\s*=\s*1\s*;/u,
  "fatal worker errors must set exit code 1",
);
assert.equal(
  (cliSource.match(/console\.log\(JSON\.stringify\(result\)\)/gu) || []).length,
  1,
  "worker CLI must emit exactly one sanitized JSON result line",
);
assert.doesNotMatch(cliSource, /process\.exit\s*\(/u, "worker CLI must not bypass the 0/2/1 exit contract");

console.log(JSON.stringify({
  ok: true,
  entry: relativeName(ENTRY),
  graphFiles: graph.files.length,
  graphEdges: graph.edges.length,
  writeCapableDependencies: graph.forbidden.length,
  exitContract: [0, 2, 1],
}));
