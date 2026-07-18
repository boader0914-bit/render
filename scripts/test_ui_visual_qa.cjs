const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.resolve(
  process.env.UI_QA_OUTPUT_DIR || path.join(ROOT_DIR, "artifacts", "ui-qa")
);

const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 }
};

const SURFACES = {
  business: {
    path: "/app",
    readySelector: "#businessCompanyName",
    detailSelector: "#businessRegionCard",
    contrastSelectors: [
      ".business-controls .secondary-button",
      ".business-controls .ghost-button",
      ".business-product-nav strong",
      ".business-badge.good",
      ".business-badge.warning",
      ".business-badge.muted",
      ".subflow-eyebrow"
    ]
  },
  admin: {
    path: "/admin",
    readySelector: "#runSelect",
    detailSelector: "#commercialLaunchGatePanel",
    contrastSelectors: [
      ".brand strong",
      ".analysis-item strong",
      ".kpi-card strong",
      ".feedback-message strong",
      ".availability-head h2",
      ".availability-title strong",
      ".availability-card-top > b span",
      ".availability-card-actions > strong",
      ".commercial-launch-gate-head strong",
      ".commercial-launch-gate-head p",
      ".commercial-launch-evidence-row strong",
      ".commercial-launch-evidence-row small",
      ".commercial-launch-gate-decision-form label",
      ".commercial-launch-rc-step header strong",
      ".commercial-launch-rc-step p",
      ".commercial-launch-rc-step small",
      ".commercial-launch-rc-action-card strong",
      ".commercial-launch-rc-action-card p",
      ".commercial-launch-rc-order",
      ".commercial-launch-gate-panel .interest-badge.good",
      ".commercial-launch-gate-panel .interest-badge.warning",
      ".commercial-launch-gate-panel .interest-badge.danger"
    ]
  }
};

function findBrowserExecutable() {
  const candidates = [
    process.env.UI_QA_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, processState) {
  const deadline = Date.now() + 15000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (processState?.exited) {
      throw new Error(`UI QA server exited early: ${processState.output.trim()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`UI QA server did not become ready: ${lastError}`);
}

async function startLocalServer(envOverrides = {}) {
  const port = await freePort();
  const processState = { exited: false, output: "" };
  const child = spawn(process.execPath, [path.join(ROOT_DIR, "scripts", "glamping_app_server.cjs")], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "development",
      RENDER: "",
      AUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      AUTH_CSRF_SECRET: "visual-qa-csrf-secret-at-least-32-characters",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const appendOutput = (chunk) => {
    processState.output = `${processState.output}${chunk}`.slice(-8000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.on("exit", (code) => {
    processState.exited = true;
    processState.output += `\nexit=${code}`;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, processState);
  return { baseUrl, child };
}

function basicAuthHeaders() {
  const user = process.env.UI_QA_USER || "";
  const pin = process.env.UI_QA_PIN || "";
  if (!pin) return {};
  return { Authorization: `Basic ${Buffer.from(`${user || "admin"}:${pin}`).toString("base64")}` };
}

async function inspectLayout(page, surface) {
  return page.evaluate(({ currentSurface }) => {
    const intentionalScrollSelector = [
      ".business-product-nav",
      ".business-monthly-flow-steps",
      ".business-monthly-ctas",
      ".operations-filters",
      ".region-keyword-row",
      ".region-strategy-links",
      ".availability-summary",
      ".weekly-bars-scroll",
      ".daily-rate-scroll",
      ".external-connector-log-list",
      ".commercial-launch-rc-summary",
      ".commercial-launch-rc-owner-fields",
      ".commercial-launch-rc-connector-grid",
      ".commercial-launch-rc-toolbar",
      ".table-scroll"
    ].join(",");

    const hasIntentionalScrollParent = (element) => {
      const parent = element.closest(intentionalScrollSelector);
      if (!parent) return false;
      const style = getComputedStyle(parent);
      return ["auto", "scroll"].includes(style.overflowX);
    };

    const clippedText = Array.from(document.querySelectorAll("button, a, strong, span, small, em, p, h1, h2, h3"))
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || !rect.width || !rect.height) return false;
        if (!String(element.textContent || "").trim()) return false;
        if (element.closest("details:not([open])")) return false;
        if (style.textOverflow === "ellipsis" || hasIntentionalScrollParent(element)) return false;
        return element.scrollWidth > element.clientWidth + 2 && !["auto", "scroll"].includes(style.overflowX);
      })
      .slice(0, 20)
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: String(element.className || "").slice(0, 120),
        text: String(element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }));

    const refreshButton = document.querySelector("#businessReportRefreshButton");
    const refreshStyle = refreshButton ? getComputedStyle(refreshButton) : null;
    const keyWidths = currentSurface === "business"
      ? [".business-topbar", ".business-main", ".business-hero"]
      : [".app-shell", ".main", ".availability-panel"];
    const keyRects = keyWidths.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return { selector, width: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right) };
    });
    const containedSelectors = currentSurface === "admin"
      ? [
          "#commercialLaunchRcPanel",
          ".commercial-launch-rc-operator-actions",
          ".commercial-launch-rc-action-card",
          ".commercial-launch-rc-step",
          ".commercial-launch-rc-connector-grid",
          ".commercial-launch-rc-toolbar"
        ]
      : [];
    const escapedContainers = containedSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth
        };
      })
    ).filter((item) => item.left < -2 || item.right > document.documentElement.clientWidth + 2 || item.width > document.documentElement.clientWidth + 2);

    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      rootOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      clippedText,
      keyRects,
      escapedContainers,
      refreshButton: refreshButton ? {
        whiteSpace: refreshStyle.whiteSpace,
        height: refreshButton.clientHeight,
        scrollHeight: refreshButton.scrollHeight
      } : null
    };
  }, { currentSurface: surface });
}

async function inspectContrast(page, selectors) {
  return page.evaluate(({ targetSelectors }) => {
    const parseColor = (value) => {
      const rgb = String(value || "").match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
      }
      const srgb = String(value || "").match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/i);
      if (srgb) {
        return {
          r: Number(srgb[1]) * 255,
          g: Number(srgb[2]) * 255,
          b: Number(srgb[3]) * 255,
          a: srgb[4] === undefined ? 1 : Number(srgb[4])
        };
      }
      return null;
    };
    const blend = (front, back) => {
      const alpha = front.a + back.a * (1 - front.a);
      if (!alpha) return { r: 255, g: 255, b: 255, a: 1 };
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
        a: alpha
      };
    };
    const effectiveBackground = (element) => {
      const chain = [];
      for (let current = element; current; current = current.parentElement) chain.unshift(current);
      let background = { r: 255, g: 255, b: 255, a: 1 };
      chain.forEach((current) => {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0) background = blend(color, background);
      });
      return background;
    };
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const contrast = (a, b) => {
      const bright = Math.max(luminance(a), luminance(b));
      const dark = Math.min(luminance(a), luminance(b));
      return (bright + 0.05) / (dark + 0.05);
    };

    const results = [];
    targetSelectors.forEach((selector) => {
      Array.from(document.querySelectorAll(selector)).slice(0, 12).forEach((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || !rect.width || !rect.height) return;
        if (element.closest("details:not([open])")) return;
        const foreground = parseColor(style.color);
        if (!foreground) return;
        const ratio = contrast(foreground, effectiveBackground(element));
        results.push({
          selector,
          text: String(element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70),
          ratio: Math.round(ratio * 100) / 100
        });
      });
    });
    return {
      tested: results.length,
      failures: results.filter((item) => item.ratio < 4.5)
    };
  }, { targetSelectors: selectors });
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const executablePath = findBrowserExecutable();
  assert.ok(executablePath, "Set UI_QA_BROWSER_PATH to a Chromium-based browser executable.");

  let localServer = null;
  let authServer = null;
  let authDataDir = "";
  const baseUrl = process.env.UI_QA_BASE_URL || (localServer = await startLocalServer()).baseUrl;
  const browser = await chromium.launch({ executablePath, headless: true });
  const reports = [];

  try {
    for (const [surface, config] of Object.entries(SURFACES)) {
      for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
        for (const theme of ["light", "dark"]) {
          const context = await browser.newContext({
            viewport,
            extraHTTPHeaders: basicAuthHeaders()
          });
          const page = await context.newPage();
          const browserErrors = [];
          page.on("console", (message) => {
            if (message.type() === "error") browserErrors.push(message.text());
          });
          page.on("pageerror", (error) => browserErrors.push(error.message));
          await page.addInitScript((selectedTheme) => {
            localStorage.setItem("lodgingDataLabTheme", selectedTheme);
          }, theme);

          await page.goto(`${baseUrl}${config.path}`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(`body[data-app-role="${surface}"]`, { state: "visible" });
          await page.waitForSelector(config.readySelector, { state: "visible" });
          await page.waitForTimeout(900);
          if (surface === "admin") {
            await page.waitForSelector("#commercialLaunchGateAutomaticChecks .commercial-launch-check", { state: "visible", timeout: 20000 });
          }

          const prefix = `${surface}-${viewportName}-${theme}`;
          const topScreenshot = path.join(OUTPUT_DIR, `${prefix}-top.png`);
          const detailScreenshot = path.join(OUTPUT_DIR, `${prefix}-detail.png`);
          const modalScreenshot = path.join(OUTPUT_DIR, `${prefix}-company-detail.png`);
          const authSecurityScreenshot = path.join(OUTPUT_DIR, `${prefix}-auth-security.png`);
          await page.screenshot({ path: topScreenshot, fullPage: false });

          const layout = await inspectLayout(page, surface);
          const contrast = await inspectContrast(page, config.contrastSelectors);
          let modalContrast = { tested: 0, failures: [] };
          let authSecurityContrast = { tested: 0, failures: [] };
          if (surface === "admin") {
            const cards = page.locator(".availability-card");
            const cardCount = await cards.count();
            if (cardCount > 0) {
              const firstCard = cards.nth(0);
              const moreSummary = firstCard.locator(".availability-more summary");
              if (await moreSummary.count() === 1) {
                await moreSummary.click();
                await page.waitForTimeout(120);
                await page.screenshot({ path: modalScreenshot, fullPage: false });
                modalContrast = await inspectContrast(page, [
                  ".availability-sheet .sheet-head h3",
                  ".availability-sheet .sheet-tabs span",
                  ".availability-sheet .detail-block h3",
                  ".availability-sheet .detail-block p",
                  ".availability-sheet .daily-rate-row > span",
                  ".availability-sheet .daily-rate-row strong"
                ]);
                const closeButton = firstCard.locator(".availability-sheet .sheet-close");
                if (await closeButton.count() === 1) await closeButton.click();
              }
            }
          }
          const detail = page.locator(config.detailSelector);
          if (await detail.count()) {
            await detail.scrollIntoViewIfNeeded();
            await page.waitForTimeout(150);
            await page.screenshot({ path: detailScreenshot, fullPage: false });
          }
          if (surface === "admin") {
            const authSecurity = page.locator("#authAccountPanel");
            if (await authSecurity.count()) {
              await authSecurity.scrollIntoViewIfNeeded();
              await page.waitForTimeout(180);
              await page.screenshot({ path: authSecurityScreenshot, fullPage: false });
              authSecurityContrast = await inspectContrast(page, [
                ".auth-security-summary strong",
                ".auth-security-summary em",
                ".auth-security-policy span",
                ".auth-security-subhead strong",
                ".auth-security-subhead span",
                ".auth-lock-row strong",
                ".auth-audit-row strong",
                ".auth-audit-row time",
                ".auth-delivery-summary strong",
                ".auth-delivery-summary em",
                ".auth-delivery-diagnostics strong",
                ".auth-delivery-diagnostics em",
                ".auth-delivery-row strong",
                ".auth-delivery-row span"
              ]);
            }
          }

          const report = {
            surface,
            viewport: viewportName,
            theme,
            topScreenshot: path.relative(ROOT_DIR, topScreenshot),
            detailScreenshot: fs.existsSync(detailScreenshot) ? path.relative(ROOT_DIR, detailScreenshot) : "",
            modalScreenshot: fs.existsSync(modalScreenshot) ? path.relative(ROOT_DIR, modalScreenshot) : "",
            authSecurityScreenshot: fs.existsSync(authSecurityScreenshot) ? path.relative(ROOT_DIR, authSecurityScreenshot) : "",
            layout,
            contrast,
            modalContrast,
            authSecurityContrast,
            browserErrors: browserErrors.slice(0, 10)
          };
          reports.push(report);

          assert.equal(layout.rootOverflow, false, `${prefix}: document has horizontal overflow`);
          assert.deepEqual(layout.clippedText, [], `${prefix}: text clipping detected`);
          assert.deepEqual(layout.escapedContainers, [], `${prefix}: RC container escapes the viewport`);
          assert.deepEqual(contrast.failures, [], `${prefix}: low contrast text detected`);
          assert.deepEqual(modalContrast.failures, [], `${prefix}: low contrast modal text detected`);
          assert.deepEqual(authSecurityContrast.failures, [], `${prefix}: low contrast authentication security text detected`);
          if (surface === "business") {
            assert.equal(layout.refreshButton?.whiteSpace, "nowrap", `${prefix}: refresh button may wrap`);
            assert.ok(layout.refreshButton.scrollHeight <= layout.refreshButton.height + 2, `${prefix}: refresh button text is clipped`);
          }
          await context.close();
        }
      }
    }

    authDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lodging-auth-ui-"));
    const visualInviteToken = "visual-invite-token-for-render-check";
    const visualDbDir = path.join(authDataDir, "db");
    fs.mkdirSync(visualDbDir, { recursive: true });
    fs.writeFileSync(path.join(visualDbDir, "account_invitations.json"), JSON.stringify({
      version: 1,
      name: "account_invitations",
      updatedAt: new Date().toISOString(),
      items: [{
        inviteId: "inv_visual",
        tokenHash: crypto.createHash("sha256").update(visualInviteToken).digest("hex"),
        username: "visual-owner@example.test",
        displayName: "Visual Owner",
        role: "business",
        companyIds: ["cmp_visual"],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        acceptedAt: "",
        cancelledAt: "",
        supersededAt: "",
        consumedAt: ""
      }]
    }, null, 2));
    authServer = await startLocalServer({
      NODE_ENV: "production",
      RENDER: "true",
      DATA_DIR: authDataDir,
      OUTPUTS_DIR: path.join(authDataDir, "outputs"),
      APP_PIN: "",
      ADMIN_PIN: "",
      ADMIN_BOOTSTRAP_USER: "visual-admin",
      ADMIN_BOOTSTRAP_PASSWORD: "VisualPassword!23",
      AUTH_ALLOW_LEGACY_BASIC: "false"
    });
    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const browserErrors = [];
        page.on("console", (message) => {
          if (message.type() === "error") browserErrors.push(message.text());
        });
        page.on("pageerror", (error) => browserErrors.push(error.message));
        await page.addInitScript((selectedTheme) => localStorage.setItem("lodgingDataLabTheme", selectedTheme), theme);
        await page.goto(`${authServer.baseUrl}/app`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#authGate:not([hidden])", { state: "visible" });
        await page.waitForTimeout(250);
        const prefix = `auth-${viewportName}-${theme}`;
        const screenshot = path.join(OUTPUT_DIR, `${prefix}-top.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        const layout = await inspectLayout(page, "auth");
        const contrast = await inspectContrast(page, [
          ".auth-brand span",
          ".auth-brand strong",
          ".auth-login-form label",
          ".auth-login-form .primary-button",
          ".auth-reset summary"
        ]);
        reports.push({
          surface: "auth",
          viewport: viewportName,
          theme,
          topScreenshot: path.relative(ROOT_DIR, screenshot),
          detailScreenshot: "",
          modalScreenshot: "",
          layout,
          contrast,
          modalContrast: { tested: 0, failures: [] },
          browserErrors: browserErrors.slice(0, 10)
        });
        assert.equal(layout.rootOverflow, false, `${prefix}: document has horizontal overflow`);
        assert.deepEqual(layout.clippedText, [], `${prefix}: text clipping detected`);
        assert.deepEqual(contrast.failures, [], `${prefix}: low contrast text detected`);
        assert.deepEqual(browserErrors, [], `${prefix}: browser error detected`);

        browserErrors.length = 0;
        await page.goto(`${authServer.baseUrl}/app?activationQa=1#invite=${encodeURIComponent(visualInviteToken)}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#authLinkPanel:not([hidden])", { state: "visible" });
        assert.equal(await page.locator("#authLoginForm").isHidden(), true, `${viewportName}-${theme}: login form must be hidden during activation`);
        assert.equal(await page.locator(".auth-reset").isHidden(), true, `${viewportName}-${theme}: reset request must be hidden during activation`);
        await page.waitForTimeout(300);
        const activationPrefix = `activation-${viewportName}-${theme}`;
        const activationScreenshot = path.join(OUTPUT_DIR, `${activationPrefix}-top.png`);
        await page.screenshot({ path: activationScreenshot, fullPage: false });
        const activationLayout = await inspectLayout(page, "auth");
        const activationContrast = await inspectContrast(page, [
          ".auth-brand span",
          ".auth-brand strong",
          ".auth-link-summary",
          ".auth-link-form label",
          ".auth-link-form .primary-button"
        ]);
        reports.push({
          surface: "activation",
          viewport: viewportName,
          theme,
          topScreenshot: path.relative(ROOT_DIR, activationScreenshot),
          detailScreenshot: "",
          modalScreenshot: "",
          layout: activationLayout,
          contrast: activationContrast,
          modalContrast: { tested: 0, failures: [] },
          browserErrors: browserErrors.slice(0, 10)
        });
        assert.equal(activationLayout.rootOverflow, false, `${activationPrefix}: document has horizontal overflow`);
        assert.deepEqual(activationLayout.clippedText, [], `${activationPrefix}: text clipping detected`);
        assert.deepEqual(activationContrast.failures, [], `${activationPrefix}: low contrast text detected`);
        assert.deepEqual(browserErrors, [], `${activationPrefix}: browser error detected`);
        await context.close();
      }
    }

    const sessionContext = await browser.newContext({ viewport: VIEWPORTS.desktop });
    const sessionPage = await sessionContext.newPage();
    const sessionErrors = [];
    const sessionFailedResponses = [];
    sessionPage.on("console", (message) => {
      if (message.type() === "error") sessionErrors.push(message.text());
    });
    sessionPage.on("pageerror", (error) => sessionErrors.push(error.message));
    sessionPage.on("response", (response) => {
      if (response.status() >= 400) sessionFailedResponses.push({ url: response.url(), status: response.status() });
    });
    await sessionPage.goto(`${authServer.baseUrl}/admin`, { waitUntil: "domcontentloaded" });
    await sessionPage.locator('#authLoginForm input[name="username"]').fill("visual-admin");
    await sessionPage.locator('#authLoginForm input[name="password"]').fill("VisualPassword!23");
    const [loginResponse] = await Promise.all([
      sessionPage.waitForResponse((response) => response.url().endsWith("/api/auth/login")),
      sessionPage.locator("#authLoginForm button[type=submit]").click()
    ]);
    assert.equal(loginResponse.status(), 200, "browser login must pass origin validation");
    await sessionPage.waitForSelector("#authSessionBar:not([hidden])", { state: "visible" });
    const [logoutResponse] = await Promise.all([
      sessionPage.waitForResponse((response) => response.url().endsWith("/api/auth/logout")),
      sessionPage.locator("#authLogoutButton").click()
    ]);
    assert.equal(logoutResponse.status(), 200, "browser logout must pass CSRF and origin validation");
    await sessionPage.waitForSelector("#authGate:not([hidden])", { state: "visible" });
    assert.equal(sessionFailedResponses.some((item) => item.status === 403), false, "browser session flow must not hit request-integrity 403 responses");
    assert.equal(sessionErrors.some((message) => /403 \(Forbidden\)/.test(message)), false, "browser session flow must not log request-integrity errors");
    await sessionContext.close();

    const reportPath = path.join(OUTPUT_DIR, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, reports }, null, 2)}\n`);
    console.log(`UI visual QA passed: ${reports.length} render combinations`);
    console.log(`Screenshots: ${OUTPUT_DIR}`);
    console.log(`Report: ${reportPath}`);
  } finally {
    await browser.close();
    for (const child of [localServer?.child, authServer?.child].filter(Boolean)) {
      if (child.exitCode !== null) continue;
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    }
    if (authDataDir) fs.rmSync(authDataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
