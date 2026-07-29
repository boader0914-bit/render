const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LEGACY_DIRECTORY_NAMES = Object.freeze([
  "data",
  "output",
  "outputs",
  "db",
  "cache",
  "caches",
  "history",
  "config",
  "backup",
  "backups",
  "company_master",
  "customer_db",
  "tourism_data",
  "artifacts"
]);

const DEFAULT_LEGACY_ABSOLUTE_ROOTS = Object.freeze([
  "/var/data",
  "/tmp/glamping-data"
]);

const DEFAULT_BLOCKED_SOURCE_IDENTIFIERS = Object.freeze([
  "stage223_preview",
  "integration_preview",
  "v2_company_master",
  "v2_history",
  "v2_run_output",
  "rc_company_master_v1",
  "rc_property_observations_v1",
  "company_master/companies.json",
  "history/observations.jsonl",
  "service:glamping-datalab-v2",
  "service:glamping-cluster-app:srv-d8jcapmrnols738cg40g",
  "service:glamping-cluster-app",
  "repository",
  "preview-source",
  "legacy-runtime",
  "disk:glamping-data",
  "disk:glamping-datalab-v2-data",
  "/api/integration-preview/companies",
  "/api/integration-preview/observations"
]);

const CONTRACT_PREVIEW_PURPOSE = "contract-preview";
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const PLACEHOLDER_PATTERN = /^(?:tbd|todo|unknown|n\/a|none|pending|미정)$/i;

function nonPlaceholderText(value) {
  const normalized = String(value || "").trim();
  return normalized && !PLACEHOLDER_PATTERN.test(normalized) ? normalized : "";
}

function normalizedSourceUrl(value) {
  const source = nonPlaceholderText(value);
  if (!source) return "";
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizedChecksum(value) {
  const checksum = String(value || "").trim().toLowerCase();
  return CHECKSUM_PATTERN.test(checksum) ? checksum : "";
}

function isCompleteStaticAssetAllowlistEntry(entry = {}) {
  return Boolean(
    nonPlaceholderText(entry.path)
    && normalizedSourceUrl(entry.source)
    && nonPlaceholderText(entry.version)
    && nonPlaceholderText(entry.license)
    && normalizedChecksum(entry.checksum)
  );
}

function canonicalPath(value, basePath = process.cwd()) {
  const input = String(value || "").trim();
  if (!input) return "";
  const absolute = path.resolve(basePath, input);
  let existing = absolute;
  const suffix = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }

  if (!fs.existsSync(existing)) return absolute;
  try {
    const realBase = fs.realpathSync.native(existing);
    return path.resolve(realBase, ...suffix);
  } catch {
    return absolute;
  }
}

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isPathWithin(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function uniquePaths(values, basePath) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const resolved = canonicalPath(value, basePath);
    if (!resolved) continue;
    const key = comparablePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function requestSourceIdentifiers(request = {}) {
  const values = [request.sourceIdentifier, request.sourceId, request.source];
  if (Array.isArray(request.sourceIdentifiers)) values.push(...request.sourceIdentifiers);
  if (Array.isArray(request.sources)) values.push(...request.sources);
  return values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return `sha256:${digest}`;
}

function denied(code, reason, details = {}) {
  return Object.freeze({ allowed: false, code, reason, ...details });
}

function allowed(code, reason, details = {}) {
  return Object.freeze({ allowed: true, code, reason, ...details });
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "INTEGRATION_DATA_ACCESS_GUARD_CONFIG_INVALID";
  return error;
}

function createIntegrationDataAccessGuard(options = {}) {
  const projectRoot = canonicalPath(options.projectRoot || process.cwd());
  if (!nonPlaceholderText(options.freshStoreRoot)) {
    throw configurationError("freshStoreRoot is required and must identify a dedicated integrated store");
  }
  const freshStoreRoot = canonicalPath(options.freshStoreRoot, projectRoot);
  const defaultLegacyRoots = [
    ...DEFAULT_LEGACY_DIRECTORY_NAMES.map((name) => path.join(projectRoot, name)),
    ...DEFAULT_LEGACY_ABSOLUTE_ROOTS
  ];
  const legacyRoots = uniquePaths([
    ...defaultLegacyRoots,
    ...(Array.isArray(options.legacyRoots) ? options.legacyRoots : [])
  ], projectRoot);

  const overlap = legacyRoots.find((legacyRoot) => pathsOverlap(freshStoreRoot, legacyRoot));
  if (overlap) {
    throw configurationError(`freshStoreRoot overlaps a blocked legacy root: ${overlap}`);
  }

  const fixtureRoots = uniquePaths(
    Array.isArray(options.fixtureRoots) ? options.fixtureRoots : [],
    projectRoot
  );
  const processEnvironment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const configuredEnvironment = String(options.env?.NODE_ENV ?? processEnvironment)
    .trim()
    .toLowerCase();
  const renderRuntime = Boolean(
    process.env.RENDER
    || process.env.RENDER_EXTERNAL_URL
    || options.env?.RENDER
    || options.env?.RENDER_EXTERNAL_URL
  );
  const environment = processEnvironment === "production"
    || configuredEnvironment === "production"
    || renderRuntime
    ? "production"
    : configuredEnvironment;
  const blockedSourceIdentifiers = new Set([
    ...DEFAULT_BLOCKED_SOURCE_IDENTIFIERS,
    ...(Array.isArray(options.blockedSourceIdentifiers) ? options.blockedSourceIdentifiers : [])
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));

  const staticAssets = new Map();
  const invalidStaticAssetEntries = [];
  const duplicateStaticPaths = new Set();
  for (const entry of Array.isArray(options.staticAssetAllowlist) ? options.staticAssetAllowlist : []) {
    if (!isCompleteStaticAssetAllowlistEntry(entry)) {
      invalidStaticAssetEntries.push(Object.freeze({ entry, reason: "incomplete_metadata" }));
      continue;
    }
    const assetPath = canonicalPath(entry.path, projectRoot);
    if (legacyRoots.some((legacyRoot) => isPathWithin(assetPath, legacyRoot))) {
      invalidStaticAssetEntries.push(Object.freeze({ entry, reason: "legacy_path" }));
      continue;
    }
    const key = comparablePath(assetPath);
    if (staticAssets.has(key) || duplicateStaticPaths.has(key)) {
      staticAssets.delete(key);
      duplicateStaticPaths.add(key);
      invalidStaticAssetEntries.push(Object.freeze({ entry, reason: "duplicate_path" }));
      continue;
    }
    staticAssets.set(key, Object.freeze({
      id: nonPlaceholderText(entry.id),
      path: assetPath,
      source: normalizedSourceUrl(entry.source),
      version: nonPlaceholderText(entry.version),
      license: nonPlaceholderText(entry.license),
      checksum: normalizedChecksum(entry.checksum)
    }));
  }

  function evaluate(request = {}) {
    const kind = String(request.kind || "").trim().toLowerCase();
    const targetPath = canonicalPath(request.path, projectRoot);
    if (!kind || !targetPath) {
      return denied("invalid_request", "kind and path are required", { kind, path: targetPath });
    }

    const legacyRoot = legacyRoots.find((root) => isPathWithin(targetPath, root));
    if (legacyRoot) {
      return denied("legacy_path_blocked", "legacy V2 or Cluster storage is not an integrated runtime source", {
        kind,
        path: targetPath,
        blockedRoot: legacyRoot
      });
    }

    if (kind === "test-fixture") {
      if (environment !== "test") {
        return denied("fixture_environment_blocked", "contract fixtures are allowed only in NODE_ENV=test", {
          kind,
          path: targetPath
        });
      }
      if (String(request.purpose || "").trim().toLowerCase() !== CONTRACT_PREVIEW_PURPOSE) {
        return denied("fixture_purpose_blocked", "contract fixtures require the explicit contract-preview purpose", {
          kind,
          path: targetPath
        });
      }
      const fixtureRoot = fixtureRoots.find((root) => isPathWithin(targetPath, root));
      if (!fixtureRoot) {
        return denied("fixture_path_blocked", "fixture path is outside the configured contract fixture roots", {
          kind,
          path: targetPath
        });
      }
      return allowed("contract_preview_fixture_allowed", "test-only contract preview fixture", {
        kind,
        path: targetPath,
        fixtureRoot
      });
    }

    const blockedSource = requestSourceIdentifiers(request)
      .find((identifier) => blockedSourceIdentifiers.has(identifier));
    if (blockedSource) {
      return denied("preview_source_blocked", "Stage 223 preview sources cannot feed the integrated runtime", {
        kind,
        path: targetPath,
        sourceIdentifier: blockedSource
      });
    }

    if (kind === "fresh-store") {
      if (!isPathWithin(targetPath, freshStoreRoot)) {
        return denied("outside_fresh_store", "integrated runtime data must stay inside freshStoreRoot", {
          kind,
          path: targetPath,
          freshStoreRoot
        });
      }
      return allowed("fresh_store_allowed", "dedicated integrated fresh-store path", {
        kind,
        path: targetPath,
        freshStoreRoot
      });
    }

    if (kind === "static-asset") {
      const entry = staticAssets.get(comparablePath(targetPath));
      if (!entry) {
        return denied("static_asset_not_allowlisted", "static asset lacks a complete approved allowlist entry", {
          kind,
          path: targetPath
        });
      }
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
        return denied("static_asset_missing", "allowlisted static asset is not a readable file", {
          kind,
          path: targetPath
        });
      }
      let actualChecksum = "";
      try {
        actualChecksum = sha256File(targetPath);
      } catch {
        return denied("static_asset_unreadable", "allowlisted static asset checksum could not be verified", {
          kind,
          path: targetPath
        });
      }
      if (actualChecksum !== entry.checksum) {
        return denied("static_asset_checksum_mismatch", "static asset content does not match its allowlist checksum", {
          kind,
          path: targetPath,
          expectedChecksum: entry.checksum,
          actualChecksum
        });
      }
      return allowed("static_asset_allowed", "static asset metadata and checksum are approved", {
        kind,
        path: targetPath,
        asset: entry
      });
    }

    return denied("unknown_access_kind", "access kind is not part of the integrated runtime boundary", {
      kind,
      path: targetPath
    });
  }

  function assertAccess(request = {}) {
    const decision = evaluate(request);
    if (decision.allowed) return decision;
    const error = new Error(`Integrated runtime data access denied: ${decision.code}`);
    error.code = "INTEGRATION_DATA_ACCESS_DENIED";
    error.decision = decision;
    throw error;
  }

  return Object.freeze({
    evaluate,
    assertAccess,
    policy: Object.freeze({
      environment,
      projectRoot,
      freshStoreRoot,
      legacyRoots: Object.freeze([...legacyRoots]),
      fixtureRoots: Object.freeze([...fixtureRoots]),
      blockedSourceIdentifiers: Object.freeze([...blockedSourceIdentifiers]),
      staticAssetAllowlist: Object.freeze([...staticAssets.values()]),
      invalidStaticAssetEntries: Object.freeze([...invalidStaticAssetEntries])
    })
  });
}

module.exports = {
  CONTRACT_PREVIEW_PURPOSE,
  DEFAULT_LEGACY_ABSOLUTE_ROOTS,
  DEFAULT_BLOCKED_SOURCE_IDENTIFIERS,
  DEFAULT_LEGACY_DIRECTORY_NAMES,
  createIntegrationDataAccessGuard,
  isCompleteStaticAssetAllowlistEntry,
  sha256File
};
