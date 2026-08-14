# DataLab Rebuild: Basic Place Test UI

## Scope

This phase adds a standalone operator console for the verified V2-compatible
Naver Place collector. It does not modify the existing Web, Worker, database,
or Render services.

- Baseline commit: `03a0bacbb2735d51016700d1566383a55a1ede73`
- Local branch: `recovery/v2-basic-place-test-ui`
- Local URL: `http://127.0.0.1:4178/`
- Provider requests during implementation: 0
- Operational writes: 0
- Raw Provider responses stored: 0

## Operator Experience

The first screen is the usable collection console:

- Demo and Live segmented modes;
- keyword search for regional, category, or business-name queries;
- password-style operator token input;
- organic ranking, advertisement, and diagnostic tabs;
- Place ID, address, category, booking flag, preview count, and minimum price;
- advertisement order and diagnostic response classification;
- JSON and CSV download actions;
- daily live budget, retry, and operational-write status.

Live mode is disabled unless every server-side gate is valid. The browser never
stores the operator token in local or session storage.

## Collection Safety

- one Provider GET per Live submission;
- concurrency fixed at one active collection per instance;
- idempotency claims and terminal results stored by request-key hash;
- daily request usage reserved before the Provider request;
- malformed usage state fails closed;
- automatic retry and fallback fixed at zero;
- operational database and Web import writes fixed at zero;
- collector artifacts restricted to the dedicated state directory;
- Provider response, headers, cookies, and authorization values are not stored;
- cross-origin POST requests are rejected;
- operator tokens are compared by SHA-256 using constant-time equality.

## Files

| File | Purpose |
| --- | --- |
| `scripts/v2_basic_place_ui_demo_fixture.cjs` | Synthetic Apollo Demo transport with no external request. |
| `scripts/v2_basic_place_test_ui_server.cjs` | Static Web server, status API, authenticated one-shot API, budget and state isolation. |
| `scripts/test_v2_basic_place_test_ui_server.cjs` | HTTP, auth, budget, concurrency, idempotency, state, and secret tests. |
| `scripts/test_v2_basic_place_test_ui_contract.cjs` | Static accessibility, responsive, layout, and browser-safety contract. |
| `web/v2-basic-place-test/index.html` | Operator console structure. |
| `web/v2-basic-place-test/styles.css` | Responsive operational layout. |
| `web/v2-basic-place-test/app.js` | Search, results, tabs, diagnostics, and downloads. |
| `render.v2-basic-place-test-ui.proposal.yaml` | Proposal-only isolated Render Web Service. |
| `package.json` | Check, test, and start commands. |

## Verification

Node version: `v26.5.0`

| Verification | Result |
| --- | --- |
| UI server and API | PASS, 86 assertions |
| Static UI contract | PASS, 52 assertions |
| Existing basic collector | PASS, 58 assertions |
| Existing ad diagnostics | PASS, 48 assertions |
| Demo end-to-end HTTP collection | PASS, organic 5 and advertisements 3 |
| Live fixture budget | PASS, 2 allowed then third blocked |
| Concurrent request | PASS, second request blocked |
| Duplicate request | PASS, terminal replay without collector rerun |
| Corrupted usage state | PASS, fail-closed |
| External network requests | 0 |
| Operational writes | 0 |
| Raw Provider responses stored | 0 |

Browser verification at a 1440-pixel viewport confirmed:

- no page-level horizontal overflow;
- no clipped buttons;
- exactly one visible tab panel;
- header, control, result, and workbench regions do not overlap;
- organic, advertisement, and diagnostic views render their expected content.

## Render Readiness Proposal

- Service type: Web Service
- Service name: `datalab-v2-basic-place-test-ui`
- Plan: Starter
- Instances: 1
- Auto Deploy: Off
- Disk: `/var/data/v2-basic-place-test-ui`, 1 GB
- Health check: `/healthz`
- Start Command: `npm run start:v2-basic-place-test-ui`
- Initial mode: authenticated Demo only
- Live request budget: 0

The initial deployment must set an operator-token SHA-256 through a secret
environment value. It must not set or expose the raw token in source, logs, or
the proposal file.

## Stop Point

The UI is implemented, tested, and running locally in Demo mode. No commit,
push, Render service creation, deployment, or Provider call was performed.

HANDOFF_BASIC_PLACE_TEST_UI
- baseline_commit: 03a0bacbb2735d51016700d1566383a55a1ede73
- local_branch: recovery/v2-basic-place-test-ui
- local_url: http://127.0.0.1:4178/
- ui_entrypoint: scripts/v2_basic_place_test_ui_server.cjs
- start_command: npm run start:v2-basic-place-test-ui
- health_path: /healthz
- offline_tests: 86 + 52 + 58 + 48 assertions
- browser_verification: desktop PASS, overflow 0, clipped buttons 0, visible panels 1
- external_network_requests: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- render_changes: 0
- approval_ui_commit_required: true
- recommended_next_scope: commit and push, then authenticated Demo-only Render Web deployment
END_HANDOFF_BASIC_PLACE_TEST_UI
