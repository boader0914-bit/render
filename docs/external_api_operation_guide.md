# External API Operation Guide v1.0

This guide closes the external API connection phase as an admin-only operation module. Business screens and `/api/business/*` responses must expose only normalized scores, grades, and short evidence summaries.

## Scope

| Area | v1.0 decision |
|---|---|
| Connectors | Naver DataLab Trend, Naver SearchAd Keyword Tool, SNS Mention Provider, OTA Exposure Provider |
| Admin-only modules | Connector status, scheduler, audit logs, operation report, warning queue, quality actions, auto-approval policy, candidate quality calibration, re-review queue |
| Business-safe output | Interest score, OTA exposure score, confidence grade, evidence summary, strengthening CTA |
| Hidden from business | Raw responses, internal errors, quota state, schedules, audit logs, auto-approval policy, review logs, re-review queues, formulas |

## Connector Environment Variables

| Connector | Required environment/config | Optional environment | Real-mode validation |
|---|---|---|---|
| Naver DataLab Trend | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` or local `naverClientId`, `naverClientSecret` | none | Run one region keyword and one property keyword in real mode. Confirm trend index, point count, and confidence score. |
| Naver SearchAd Keyword Tool | `NAVER_SEARCHAD_API_KEY`, `NAVER_SEARCHAD_SECRET_KEY`, `NAVER_SEARCHAD_CUSTOMER_ID` or local SearchAd config fields | none | Run one keyword-tool request. Confirm signature auth, monthly volume, device split, and normalized score. |
| SNS Mention Provider | `SNS_MENTION_API_KEY`, `SNS_MENTION_API_BASE_URL` | `SNS_MENTION_API_PATH` | Run one keyword per selected platform group. Confirm mention count, sentiment counts, sample size, and source coverage. |
| OTA Exposure Provider | `OTA_CONNECTOR_API_KEY`, `OTA_CONNECTOR_BASE_URL` | `OTA_CONNECTOR_API_PATH`, `OTA_CONNECTOR_PROVIDER` | Run one company and one region/channel scope. Confirm channel, listing URL, exposed flag, exposure score, and observed time. |

## Execution Modes

| Mode | Use when | Rule |
|---|---|---|
| `mock` | Credentials are missing or the adapter is being validated. | Never calls an external provider. Safe for UI and scoring-shape tests. |
| `auto` | Scheduler should prefer real only when credentials and adapter status are ready. | Falls back to mock when credentials are missing. Use for normal scheduled operation after validation. |
| `real` | Admin manually validates a connector before production cadence. | Forces provider adapter. Do not expose raw provider data to business users. |

## Mock-to-Real Handoff Checklist

1. Confirm required environment variables or local config fields are present.
2. Run a mock job and verify that the normalized score shape matches the business report needs.
3. Run one manual real job from the admin connector console.
4. Compare real/mock output in the admin console.
5. Confirm 429, auth failure, quota exceeded, empty result, and network error handling.
6. Set scheduler interval, daily limit, retry limit, quota warning threshold, and quota stop threshold.
7. Enable `auto` mode only after the connector has a successful real run and no open critical warning.

## Failure and Retry Policy

| Failure | Status | Operator action |
|---|---|---|
| Missing credentials | `failed` or `mock_fallback` | Configure credentials, then run manual real validation. |
| Auth failure | `failed` | Fix key/customer/signature/provider permission before retrying. |
| 429 or quota exceeded | `retry_scheduled` or `quota_blocked` | Reduce cadence or daily limit. Do not raise automation frequency until the backlog clears. |
| Network error | `retry_scheduled` | Retry with backoff. Repeated failures should create an admin operation warning. |
| Empty result | `review_required` | Check keyword, region, company, channel match, or provider response mapping. |
| Schema mismatch | `review_required` | Update provider adapter mapping before business score use. |

## Scheduler Guardrails

| Guardrail | Default expectation |
|---|---|
| Daily limit | Set per connector before scheduled real mode. |
| Retry limit | Keep low until the provider has stable success rate. |
| Quota warning threshold | Warn before provider rate limit is reached. |
| Quota stop threshold | Block scheduled runs before external quota damage. |
| Audit logs | Policy save, forced run, scheduled run, retry result, and quota block events must be logged. |

## Admin Handoff

Use `GET /api/admin/master-db/external-connector-operation-v1-lock` to check:

- v1.0 locked status
- admin-only operation modules
- connector readiness
- remaining setup checklist
- real connector handoff checklist
- business exposure boundary audit

## Business Boundary

The following must never be exposed through `/api/business/*` or visible `/app` UI:

- raw provider response
- internal error log
- quota state
- schedule policy
- audit log
- operation warning queue
- improvement action queue
- auto-approval policy or history
- candidate quality calibration
- re-review queue
- internal scoring formula
