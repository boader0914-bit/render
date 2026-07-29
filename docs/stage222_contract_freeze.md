# Stage 222 - Integration Contract Freeze

## Scope

Stage 222 freezes the current `glamping-datalab-v2` contracts before any RC feature is ported. All test data is synthetic and all integration flags default to disabled.

No production deployment, production file mutation, secret copy, RC merge, or data migration is part of this stage.

## Frozen fixtures

| Fixture | Contract |
| --- | --- |
| `test/fixtures/stage222/api_contracts.json` | Major route method, path, access role and request shape |
| `test/fixtures/stage222/company_master_store.json` | Keyed v2 company master store and company record |
| `test/fixtures/stage222/collection_run.json` | Run manifest and collected availability item |
| `test/fixtures/stage222/b2b_session.json` | Public B2B session response only |
| `test/fixtures/stage222/location_card_requests_store.json` | Keyed location-card request, evidence and history |

Fixture rules:

- Use only synthetic names, IDs, dates and `example.invalid` URLs.
- Do not include passwords, password hashes, session IDs, cookies, API keys, tokens, IP hashes, contact details or live Render URLs.
- Do not include `/var/data` or another operating filesystem path.
- Keep fixture changes intentional and regenerate the contract snapshot in the same change.

## Snapshot

`test/snapshots/stage222_contract_snapshot.json` freezes:

- fixture SHA-256 digests;
- fixture object/array/type shapes;
- live temporary-server API response shapes;
- response status codes;
- B2B denial of the administrator company-master API;
- B2B hidden run-list behavior;
- default-disabled integration flag status.

The snapshot stores shapes and digests, not response values or secrets.

To intentionally refresh it:

```powershell
$env:UPDATE_CONTRACT_SNAPSHOTS = "1"
node scripts/test_integration_contracts.cjs
Remove-Item Env:UPDATE_CONTRACT_SNAPSHOTS
```

The normal test command never updates snapshots.

## Feature flags

| Domain | Environment variable | Default | Stage 222 behavior |
| --- | --- | --- | --- |
| Company adapter | `V2_INTEGRATION_COMPANY_ENABLED` | `false` | No route or write behavior |
| Observation adapter | `V2_INTEGRATION_OBSERVATION_ENABLED` | `false` | No projection or write behavior |
| Authentication adapter | `V2_INTEGRATION_AUTH_ENABLED` | `false` | Existing B2B authentication only |
| Business report | `V2_INTEGRATION_BUSINESS_REPORT_ENABLED` | `false` | No RC business route or UI |

Only `1`, `true`, `on` or `yes` enables a flag. Unset, blank and all other values are disabled.

The company and observation flags are Stage 223 contract-test controls only. They can
become enabled only when `NODE_ENV=test`; every other environment ignores a true
environment value and keeps the preview routes at `404`. Authentication and business
report flags remain runtime-scoped, default-disabled placeholders.

Stage 224 adds a second independent boundary: even in `NODE_ENV=test`, preview reads
require `V2_INTEGRATION_PREVIEW_PURPOSE=contract-preview`, an explicit
`V2_INTEGRATION_PREVIEW_FIXTURE_ROOT`, and a successful data-access guard decision for
every company/history/output path. Flags alone never authorize a read.

The administrator-only `/api/security-hardening` response includes a read-only `integration` summary. No flag state is added to the public health response, B2B session response or business UI.

## Regression test

`scripts/test_integration_contracts.cjs` starts the current v2 server on an ephemeral local port with a temporary data directory. It then verifies:

1. All fixtures pass the sensitive-field audit.
2. Frozen API paths still exist in the server source.
3. Anonymous health shape remains stable.
4. Admin and B2B login/session response shapes remain stable.
5. B2B cannot read `/api/company-master/summary`.
6. B2B receives an empty global run list.
7. Admin can read the synthetic company master, run list and location-card requests.
8. Public API responses do not contain password, secret, token, cookie, session-ID, user-agent hash, IP hash, API key or contact fields.
9. All integration flags are disabled in the administrator readiness summary.
10. API and fixture shapes match the committed snapshot.

The test disables repository-output seeding so only the synthetic run is visible.

## Commands

```powershell
npm run test:contracts
npm test
```

## Stage result

- Current v2 contracts are frozen before adapter work.
- Synthetic fixture and snapshot data contain no operating values.
- Four integration features are present but disabled.
- Existing route behavior is unchanged except for an additive administrator-only readiness summary.
- The production branch and Render service remain untouched.
