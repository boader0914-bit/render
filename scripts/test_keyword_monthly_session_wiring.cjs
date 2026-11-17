"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) { const value = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0]; assert.ok(value, name); return value; }
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const valid = () => ({ authenticated: true, role: "admin", username: "synthetic-admin", memberId: "synthetic-member",
  sessionCreatedAt: "2026-11-17T00:00:00.000Z", expiresAt: "2026-11-17T12:00:00.000Z" });

function fixture({ response = valid(), customerView = false, configureGate = null, sessionFailure = null, logoutGate = null } = {}) {
  const calls = { configure: [], preview: [], request: [], apply: 0, clear: 0, location: [], order: [] }, state = {};
  const context = { state, location: { pathname: customerView || response?.role === "b2b" ? "/b2b" : "/admin", replace: url => calls.location.push(url) },
    window: { KeywordMonthlyAnalysis: { configure(session, flags) { calls.configure.push({ session, flags }); calls.order.push("configure"); return configureGate?.promise || Promise.resolve(Boolean(session)); }, clear() { calls.clear++; calls.order.push("clear"); } },
      AdminCompanyPreviewCache: { configure: session => calls.preview.push(session) } },
    fetchJson: async (url, options) => { calls.request.push([url, options]); calls.order.push(url); if (url === "/api/session") { if (sessionFailure) throw sessionFailure; return context.response; } if (url === "/api/logout") { if (logoutGate) await logoutGate.promise; return {}; } throw new Error("unexpected request"); },
    response, adminUserViewRequested: () => customerView, applyRoleUi: () => { calls.apply++; calls.order.push("role-ui"); } };
  for (const name of ["resetAdminDbSearchDraft", "stopSavedRegionalCatchment", "stopTourismDemandStrengthBackfillPolling"]) context[name] = () => {};
  vm.createContext(context); const api = vm.runInContext(`${declaration("loadSession")}\n${declaration("logout")}\n({loadSession,logout})`, context);
  return { api, context, state, calls };
}

test("fresh session fields needed by the opaque catalogue scope reach KMA before administrator UI starts", async () => {
  const gate = defer(), f = fixture({ configureGate: gate }), pending = f.api.loadSession(); await turn();
  assert.equal(f.calls.configure.length, 1); assert.equal(f.calls.apply, 0, "fresh identity configuration is awaited before restoring a private screen");
  const actual = f.calls.configure[0];
  for (const field of ["authenticated", "role", "username", "memberId", "sessionCreatedAt", "expiresAt"]) assert.equal(actual.session[field], f.context.response[field]);
  assert.equal(actual.flags.customerView, false); gate.resolve(true); await pending;
  assert.equal(f.calls.apply, 1); assert.equal(f.state.session.sessionCreatedAt, f.context.response.sessionCreatedAt);
  assert.ok(f.calls.order.indexOf("configure") < f.calls.order.indexOf("role-ui"));
});

test("the caller never synthesizes missing or expired identity dates for catalogue reuse", async () => {
  for (const response of [{ authenticated: true, role: "admin", username: "synthetic-admin" },
    { ...valid(), expiresAt: "2020-01-01T00:00:00.000Z" }]) {
    const f = fixture({ response }); await f.api.loadSession(); const session = f.calls.configure[0].session;
    assert.equal(session.sessionCreatedAt, response.sessionCreatedAt || ""); assert.equal(session.expiresAt, response.expiresAt || "");
  }
});

test("a repeated username in a new login still forwards the new session-created identity", async () => {
  const f = fixture(); await f.api.loadSession();
  f.context.response = { ...valid(), sessionCreatedAt: "2026-11-17T01:00:00.000Z" }; await f.api.loadSession();
  assert.equal(f.calls.configure.length, 2); assert.notEqual(f.calls.configure[0].session.sessionCreatedAt, f.calls.configure[1].session.sessionCreatedAt);
  assert.equal(f.calls.configure[1].session.sessionCreatedAt, f.context.response.sessionCreatedAt);
});

test("customer view, B2B and unauthenticated sessions remain explicit catalogue authorization boundaries", async () => {
  for (const options of [{ customerView: true }, { response: { ...valid(), role: "b2b" } }, { response: { ...valid(), authenticated: false } }]) {
    const f = fixture(options); await f.api.loadSession(); const value = f.calls.configure[0];
    assert.equal(value.flags.customerView, options.customerView === true);
    assert.equal(value.session.authenticated, (options.response || valid()).authenticated);
    assert.equal(value.session.role, (options.response || valid()).role);
  }
});

test("an unknown raw role is not promoted into administrator catalogue credentials", async () => {
  const f = fixture({ response: { ...valid(), role: "synthetic-unknown" } }); await f.api.loadSession();
  assert.equal(f.calls.configure[0].session.role, "synthetic-unknown", "cache authorization receives the raw API role, not the UI fallback");
});

test("unexpected credential fields in a session response are not forwarded to the KMA identity configuration", async () => {
  const f = fixture({ response: { ...valid(), token: "DO_NOT_FORWARD_CREDENTIAL", password: "DO_NOT_FORWARD_CREDENTIAL", cookie: "DO_NOT_FORWARD_CREDENTIAL" } });
  await f.api.loadSession(); const text = JSON.stringify(f.calls.configure);
  assert.equal(text.includes("DO_NOT_FORWARD_CREDENTIAL"), false);
  for (const name of ["token", "password", "cookie"]) assert.equal(Object.hasOwn(f.calls.configure[0].session, name), false);
});

test("failed fresh authentication revokes private KMA configuration and preserves the original failure", async () => {
  const error = new Error("synthetic authentication unavailable"), f = fixture({ sessionFailure: error });
  await assert.rejects(f.api.loadSession(), value => value === error);
  assert.equal(f.calls.configure.length, 1); assert.equal(f.calls.configure[0].session, null); assert.equal(f.calls.preview[0], null); assert.equal(f.calls.apply, 0);
});

test("logout clears private KMA state before the network logout settles", async () => {
  const gate = defer(), f = fixture({ logoutGate: gate }); const pending = f.api.logout(); await turn();
  assert.equal(f.calls.clear, 1); assert.equal(f.calls.preview[0], null); assert.equal(f.calls.order[0], "clear"); assert.deepEqual(f.calls.location, []);
  gate.resolve(); await pending; assert.deepEqual(f.calls.location, ["/login"]);
});
