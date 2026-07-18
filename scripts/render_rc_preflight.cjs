const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const targetUrl = String(process.env.RC_TARGET_URL || "https://glamping-cluster-app.onrender.com").trim().replace(/\/$/, "");
const expectedCommit = String(process.env.RC_EXPECTED_COMMIT || "").trim().toLowerCase();
const authorization = String(process.env.RC_PREFLIGHT_AUTHORIZATION || "").trim();
const outputPath = path.resolve(process.env.RC_PREFLIGHT_OUTPUT || path.join(ROOT, "artifacts", "rc-stage218", "render-rc-preflight.json"));
const timeoutMs = Math.max(3000, Math.min(60000, Number(process.env.RC_PREFLIGHT_TIMEOUT_MS || 30000)));

function validCommit(value = "") {
  return /^[a-f0-9]{7,64}$/.test(value) ? value : "";
}

async function request(requestPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (options.authorized && authorization) headers.Authorization = authorization;
    const response = await fetch(`${targetUrl}${requestPath}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return {
      reachable: true,
      status: response.status,
      body,
      headers: {
        renderOrigin: Boolean(response.headers.get("x-render-origin-server") || response.headers.get("rndr-id")),
        hsts: Boolean(response.headers.get("strict-transport-security")),
        contentType: String(response.headers.get("content-type") || "")
      }
    };
  } catch (error) {
    return {
      reachable: false,
      status: 0,
      error: error?.name === "AbortError" ? "timeout" : "network_error",
      body: null,
      headers: { renderOrigin: false, hsts: false, contentType: "" }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function check(checkId, label, status, evidence, requiredAction = "") {
  return { checkId, label, status, evidence, requiredAction };
}

async function main() {
  let parsedTarget = null;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {}
  const [health, anonymousAdmin, rc] = await Promise.all([
    request("/api/health"),
    request("/admin"),
    request("/api/admin/master-db/commercial-launch-rc-rehearsals", { authorized: true })
  ]);
  const rcReport = rc.status === 200 && rc.body?.schema === "commercial_launch_rc_rehearsals_v1" ? rc.body : null;
  const detectedCommit = validCommit(String(rcReport?.releaseCandidate?.detectedCommit || "").toLowerCase());
  const normalizedExpected = validCommit(expectedCommit);
  const sourceMatches = Boolean(normalizedExpected && detectedCommit
    && (normalizedExpected.startsWith(detectedCommit) || detectedCommit.startsWith(normalizedExpected)));
  const checks = [
    check("https_target", "HTTPS target", parsedTarget?.protocol === "https:" ? "passed" : "blocked", parsedTarget?.protocol || "invalid", "Use the exact HTTPS Render service URL."),
    check("health", "Public health", health.status === 200 && health.body?.ok === true ? "passed" : "blocked", `HTTP ${health.status || 0}; ok=${Boolean(health.body?.ok)}`, "Resolve deployment or health-check failure before continuing."),
    check("render_runtime", "Render runtime response", health.headers.renderOrigin ? "passed" : "blocked", health.headers.renderOrigin ? "Render response headers detected" : "Render response headers missing", "Confirm the target belongs to the intended Render service."),
    check("transport_security", "HTTPS transport headers", health.headers.hsts ? "passed" : "warning", health.headers.hsts ? "HSTS present" : "HSTS missing", "Enable and verify HSTS on the public service."),
    check("admin_protection", "Anonymous administrator protection", [401, 403].includes(anonymousAdmin.status) ? "passed" : "blocked", `GET /admin returned HTTP ${anonymousAdmin.status || 0}`, "Require authentication for administrator routes."),
    check("rc_contract", "Stage 218 RC administrator contract", rcReport ? "passed" : "blocked", rcReport ? rcReport.schema : `HTTP ${rc.status || 0}; admin authorization ${authorization ? "provided" : "not provided"}`, authorization ? "Deploy the Stage 218 RC contract and verify the administrator response." : "Provide a short-lived administrator Authorization header through RC_PREFLIGHT_AUTHORIZATION; it is never stored in the report."),
    check("runtime_environment", "RC runtime environment", rcReport?.runtime?.environment === "render" ? "passed" : "blocked", rcReport?.runtime?.environment || "unverified", "Run the RC rehearsal from the Render process, not from local evidence."),
    check("source_parity", "Expected and running commit", sourceMatches ? "passed" : "blocked", `expected=${normalizedExpected ? normalizedExpected.slice(0, 12) : "missing"}; running=${detectedCommit ? detectedCommit.slice(0, 12) : "unverified"}`, "Set RC_EXPECTED_COMMIT to the tested commit and deploy that exact commit."),
    check("manual_approval", "Manual final approval policy", rcReport?.policy?.finalApproval === "manual_only" && rcReport?.policy?.automaticApproval === false ? "passed" : "blocked", rcReport ? `final=${rcReport.policy?.finalApproval || "unknown"}; automatic=${Boolean(rcReport.policy?.automaticApproval)}` : "unverified", "Keep final release approval as a separate administrator-only manual decision.")
  ];
  const counts = checks.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { passed: 0, warning: 0, blocked: 0 });
  const report = {
    schema: "render_rc_preflight_stage218_v1",
    generatedAt: new Date().toISOString(),
    target: targetUrl,
    expectedCommit: normalizedExpected,
    adminAuthorizationProvided: Boolean(authorization),
    decision: counts.blocked === 0 && counts.warning === 0 ? "go_candidate" : "no_go",
    summary: { total: checks.length, ...counts },
    checks,
    operatorActions: checks.filter((item) => item.status !== "passed").map((item) => ({
      checkId: item.checkId,
      status: item.status,
      requiredAction: item.requiredAction
    })),
    policy: {
      finalApproval: "manual_only",
      storesAuthorization: false,
      localEvidenceCountsForRelease: false
    }
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ decision: report.decision, summary: report.summary, outputPath }, null, 2)}\n`);
  if (process.argv.includes("--strict") && report.decision !== "go_candidate") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.message || "Render RC preflight failed."}\n`);
  process.exitCode = 1;
});
