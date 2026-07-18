# Commercial Launch Gate v1

## Purpose

The commercial launch gate is the final administrator-only Go/No-Go sign-off. It does not create another quality-management loop. It summarizes existing evidence, records an operator decision, and detects when an approved automatic state has changed.

## Automatic checks

The gate reads the current summaries from seven existing modules:

1. Product QA
2. Deployment readiness
3. Backup and restore readiness
4. Latest deployment smoke test
5. External API operation v1.0 lock and business boundary
6. Internal quality SLA v1.0 lock
7. Authentication and security v1.0 lock and key state

Any blocked automatic check prevents approval. Warnings require operator judgment but do not create an automatic approval or remediation workflow. A missing smoke-test run is a blocker.

## Manual evidence

Every approval requires a checked item and a short evidence reference for:

- production environment and public route;
- backup, restore rehearsal, and rollback owner;
- administrator access, MFA, and recovery;
- connector and provider cutover decision;
- release, rollback, and customer communication.

The final approver and release note are required for an approved decision. A hold can be saved with incomplete evidence so the current state and reason remain visible.

## Persistence and snapshots

- File: `DATA_DIR/db/commercial_launch_gate_reviews.json`
- Schema: `commercial_launch_gate_reviews_v1`
- History cap: 100 decisions
- API: `GET /api/admin/master-db/commercial-launch-gate`
- Decision API: `POST /api/admin/master-db/commercial-launch-gate`

Each decision stores the automatic summary fingerprint, required evidence confirmations, final approver, approval time, release note, and before/after snapshots. It never stores secret values or raw provider responses.

If the current automatic fingerprint differs from the latest approved fingerprint, the report changes from `go` to `review_required`. A new manual review is required.

## Decision rules

| Decision | Meaning |
| --- | --- |
| `no_go` | One or more automatic blockers exist. |
| `pending_review` | Automatic blockers are clear, but no complete approval exists. |
| `hold` | An administrator explicitly saved a hold decision. |
| `review_required` | A previously approved automatic state has changed. |
| `go` | No automatic blockers, all evidence complete, and a current manual approval exists. |

Approval is manual-only and requires an administrator MFA step-up when MFA is enabled. Do not add auto-approval, recursive SLA, recommendation, reassessment, or quality-calibration layers to this module.

## Business boundary

The launch gate, deployment and security evidence, backup paths, internal logs, approval history, snapshots, and formulas stay under administrator routes. Business APIs and `/app` must not expose these fields.

The administrator RC operating sequence and environment-isolation rules are documented in `docs/commercial_launch_rc_rehearsal.md`. RC evidence can populate the manual gate form, but it never saves or approves the gate automatically.
