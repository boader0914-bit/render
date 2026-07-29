# Stage 221 - glamping-datalab-v2 Integration Baseline

> **2026-07-29 data-strategy amendment:** The inventory and V2-first functional
> decisions in this baseline remain valid, but existing V2 and Cluster business
> data will not be merged, projected into the integrated runtime, dual-written,
> or backfilled. The integrated store starts empty and is populated by fresh
> collection. UI and data execution follow
> `docs/v2_cluster_v3_ui_master_plan.md` when this baseline conflicts with it.
>
> **Stage 224 supersession warning:** references below to account/data migration,
> dual-write, backfill, sanitized data copies, preserving the V2 visual system, or
> the former Stage 222-232 sequence are historical findings only. They are not an
> executable plan after Stage 224. The current authority is the fresh-collection,
> V3-UI Stage 224-234 plan in `docs/v2_cluster_v3_ui_master_plan.md`.

## 1. Decision

`glamping-datalab-v2` is the canonical commercial service and `codex/glamping-datalab-v2` is the canonical source branch.

| Item | Canonical value |
| --- | --- |
| Git repository | `boader0914-bit/render` |
| Production branch | `codex/glamping-datalab-v2` |
| Stage 221 integration branch | `integration/glamping-datalab-v2-stage221` |
| Production Render service | `glamping-datalab-v2` |
| Production service ID | `srv-d8rjrmojs32c73c4tmhg` |
| Production URL | `https://glamping-datalab-v2.onrender.com` |
| Baseline commit | `4e4e1906e2967fe58df66f8ad67f832043d2763b` |
| Reference RC only | `57a6c561496812126e2ff2e8a61bff51099b2423` |
| Reference Render service | `glamping-cluster-app` (`srv-d8jcapmrnols738cg40g`) |

Stage 221 does not merge, cherry-pick, deploy, modify production data, copy secrets, or change the production branch.

## 2. Git divergence

The branches share commit `01880738b17fe16de5e4ba8a10087d441bb70464` and then diverge.

| Metric | Result |
| --- | --- |
| v2-only commits after the merge base | 416 |
| RC-only commits after the merge base | 4 |
| Changed files between heads | 48 |
| Diff size | 86,328 insertions / 77,977 deletions |
| Largest conflicts | `scripts/glamping_app_server.cjs`, `web/app.js`, `web/styles.css`, `web/index.html` |

The RC accumulated Stages 1-218 in one large release commit. It is not a linear upgrade of v2. Whole-file merge or automatic conflict resolution is prohibited.

## 3. File comparison

| Area | v2 baseline | RC reference | Decision |
| --- | --- | --- | --- |
| Server | Operational collection, B2B membership, company master, location review, tourism and history routes in `glamping_app_server.cjs` | Business reports, strategy engine, file DB, security, connector operations and release gates in the same monolith | Keep v2 file; extract and port RC services by domain |
| Crawler | Rich regional, OTA and operational collection implementation | Older crawler base plus collection-mode observation projection | Keep v2 crawler; port only observation normalization contracts |
| Frontend | Mature mobile admin product, summary/ranking/dictionary/contact/map/demand/history/admin flows | Separate business monthly report and large internal operations console | Keep v2 information architecture and design system; rebuild selected business views on it |
| PWA/static | Manifest, service worker, offline page, icons, favicon, region dictionaries | These assets are absent | Keep v2 assets |
| Tourism | `tourism_collector.cjs`, region mapping and cache model | No equivalent runtime collector | Keep v2 |
| Authentication | B2B member signup/login/session and account deletion | Multi-tenant accounts, session cookies, CSRF, MFA, invite/reset and audit modules | Conflict; create an account migration adapter before replacing any route |
| Spreadsheet | `xlsx` dependency and existing export/import behavior | `write-excel-file`, `fflate`, bounded import worker and security tests | Port RC safe import/export boundary; remove `xlsx` only after regression parity |
| Tests | Syntax, Yeogi parser and surface contrast | Auth, tenant, import, business API and visual QA suites | Keep v2 tests and port RC guardrail suites incrementally |
| Render manifests | `render.v2*.yaml` targets the canonical service | `render*.yaml` targets `glamping-cluster-app` and RC security variables | Keep v2 service name; create a new staging manifest before adding RC variables |
| Documents | API key policy and operational product notes | Productization, auth, external connector and launch-gate runbooks | Port and rewrite URLs/service names; archive cluster-specific RC result files |

Files that must never be merged wholesale:

- `scripts/glamping_app_server.cjs`
- `web/app.js`
- `web/styles.css`
- `web/index.html`
- `render.yaml`
- `render.persistent.yaml`

## 4. API comparison

Literal route extraction found 43 v2 API paths, 228 RC API paths and only 6 exact common paths. Dynamically constructed routes can make the literal count lower than the real count, but the ownership conflict is still conclusive.

| API domain | v2 state | RC state | Decision |
| --- | --- | --- | --- |
| Health, crawl, runs, settings, Yeogi | Production operational routes | Similar names with changed auth and response contracts | Keep v2 contract; add contract tests before adapting internals |
| B2B membership | `/api/signup`, `/api/login`, `/api/session`, member runs/history/interests | `/api/auth/*` and tenant-owned `/api/business/*` | Preserve v2 login during migration; add compatibility session adapter |
| Company master | `/api/company-master/*` with duplicate, region, channel and manual review operations | `/api/admin/master-db/companies*`, verified profiles and observations | Keep v2 endpoints; add v2-native observation and verified-profile subresources |
| Location card | Request queue and score overrides | Draft/review/publish cards plus business-safe region-card response | Keep v2 requests; port RC draft/publish lifecycle after schema adapter |
| Collection | Operational B2B search, crawl estimates/status and tourism collection | Fast/detail/lead-time/OTA observation modes and connector scheduler | Keep v2 execution; emit RC-compatible observations from completed runs |
| Business intelligence | Summary/ranking/demand data but no complete monthly product API | Report, region card, strategies, plans, board, retrospective and next-month candidates | Selectively port as new v2 business API module |
| Internal quality | Focused admin review and hardening | 172 literal `/api/admin/master-db/*` paths, many recursive SLA/calibration/auto-approval chains | Do not port recursive chains; retain only bounded v1 readiness checks |
| Commercial operations | Existing live operating flow | Backup, smoke, security readiness and Go/No-Go gates | Port after staging data/auth are stable |

## 5. Data model comparison and mapping

### 5.1 Canonical v2 runtime data

| Path | Observed state | Ownership |
| --- | --- | --- |
| `/var/data/company_master/companies.json` | 214 keyed companies | Canonical company identity source |
| `/var/data/config/b2b_members.json` | 1 active stored member row | Canonical legacy account source until migration |
| `/var/data/config/location_card_requests.json` | 2 keyed requests | Canonical request queue |
| `/var/data/customer_db/b2b_search_history.json` | 47 search-history entries | Canonical customer activity history |
| `/var/data/history/observations.jsonl` | Existing observation history | Canonical raw operational history |
| `/var/data/history/datalab_trends.json` | Existing trend store | Canonical v2 trend source |
| `/var/data/outputs/` | 158 run directories | Canonical collection evidence |
| `/var/data/tourism_data/cache/` | Tourism cache directory | Canonical tourism cache |

The v2 company model is keyed by `companyId` and includes aliases, place IDs, booking business IDs, addresses, regions, keywords, URLs, collection route statistics, inventory, manual corrections, duplicate notes and run history.

### 5.2 RC runtime data

| Path | Observed state | Decision |
| --- | --- | --- |
| `/var/data/db/user_accounts.json` | 1 administrator account | Reference only; do not overwrite v2 members |
| `/var/data/db/auth_sessions.json` | Session store | Reference only |
| `/var/data/db/auth_audit_logs.json` | Authentication audit store | Port schema only after account migration design |
| `/var/data/db/auth_security_state.json` | Authentication lock state | Port schema only |
| `/var/data/outputs/` | 32 older run directories | Do not merge into canonical outputs without deduplication |
| Product DB files | Most RC product files have not yet been materialized on this disk | Port schemas/code, not empty runtime files |

### 5.3 Model mapping

| Canonical concept | v2 | RC | Integration rule |
| --- | --- | --- | --- |
| Company | `company_master/companies.json` object keyed by company ID | `db/company_master.json` item collection | v2 ID wins; build a read-only adapter and alias map |
| Observation | `history/observations.jsonl` and run outputs | `property_observations.json` | Convert completed v2 runs into append-only normalized observations |
| Verified value | `manualCorrection`, review histories and region reviews | `company_verified_profile.json`, `verified_change_logs.json` | Preserve v2 review provenance; expose resolved profile through a new adapter |
| Member/account | `b2b_members.json` | `user_accounts.json` plus sessions/MFA/invites | Migrate by explicit account link; never copy password hashes blindly |
| Search history | `customer_db/b2b_search_history.json` | No direct equivalent | Keep v2 and reference it from onboarding/report context |
| Location request | Keyed object with evidence/history | Item queue with company/region/category/status | Version the v2 schema and migrate requests in place with reversible fields |
| Location card | Dictionary, score overrides and request evidence | Draft/review/publish `location_cards.json` | Add published-card records alongside the v2 dictionary, not instead of it |
| Interest | `datalab_trends.json`, traffic keys and collection outputs | `interest_signals.json`, jobs and scores | Build normalized signal projection while preserving raw v2 trend history |
| Lead time | Search history and run evidence | `leadtime_patterns.json` | Derive patterns from v2 observations; never import empty RC patterns |
| Strategy/plan | Not persisted as one monthly workflow | Strategy quality, experiments, execution plans and retrospectives | Port only business-facing workflow and bounded learning history |
| Subscription/export | B2B account type and existing files | Company subscription and report export history | Map plan entitlement to v2 member/company link before enabling export |

## 6. UI comparison

> **Superseded after Stage 224:** this section remains as source-comparison
> evidence. Its directions to keep the V2 information architecture, visual system,
> or a "v2-native" UI no longer govern implementation. Preserve V2 functional and
> API behavior where conflicts exist, but implement login, role navigation,
> responsive layout, and light/dark themes in the approved V3 UI form.

| Product surface | Keep | Port | Conflict handling |
| --- | --- | --- | --- |
| Admin navigation | v2 summary, DB, collection and settings primary navigation | RC operator grouping concepts | Rename/group inside v2 navigation; do not copy RC HTML |
| Operational tabs | v2 report, ranking, location dictionary, contacts, review queue, map, demand and history | RC data reliability summaries where useful | Add compact subviews; keep v2 mobile behavior |
| Company detail | v2 booking/platform/search sheets and channel/manual correction workflow | RC verified profile, observation and confidence summaries | Extend the existing sheet with new tabs and adapters |
| Business product | v2 B2B member/search foundation | RC report -> region card -> strategy -> plan -> retrospective -> next-month flow | Rebuild as a v2-native business route and components |
| Location experience | v2 dictionary, map and request evidence | RC draft/review/publish and business-safe confidence CTA | Keep v2 visuals; add lifecycle controls and resolved card API |
| Theme/contrast | v2 current mobile polish, PWA and location contrast fixes | RC business light/dark tokens and visual QA rules | Token-level port only; screenshot-test every imported component |
| Internal quality UI | v2 focused admin controls | RC deeply nested SLA/auto-approval panels | Archive recursive panels; expose only locked readiness/status summaries |

## 7. Keep / Port / Conflict / Retire matrix

### Keep

- v2 Render service, branch, persistent disk and production URL.
- v2 company identity and 214-company master data.
- v2 158-run evidence, search history, tourism cache and location evidence.
- v2 admin/mobile navigation, operational collection UI, company detail and PWA assets.
- v2 B2B access during the migration window.
- v2 crawler, tourism collector, region dictionary and OTA operational behavior.

### Port selectively

- Business-safe monthly report, region card, strategy, execution plan, retrospective and next-month candidate flow.
- Normalized property observations, verified-profile resolution, lead-time patterns and interest-signal scoring.
- Tenant ownership checks, secure sessions, CSRF, administrator MFA, invitation/reset delivery and security audit.
- Safe spreadsheet import/export boundary and RC regression tests.
- External connector adapter contracts, retry classification and bounded scheduler operations.
- Backup/restore rehearsal, deployment smoke and manual Go/No-Go gate after staging parity.

### Resolve as explicit conflicts

- `companies.json` versus `company_master.json`.
- `b2b_members.json` versus `user_accounts.json`.
- Both `location_card_requests.json` files with incompatible top-level and item schemas.
- v2 `/api/login` and `/api/session` versus RC `/api/auth/login` and `/api/auth/session`.
- v2 operational UI versus RC full-page admin/business HTML and CSS.
- v2 `xlsx` behavior versus RC replacement library and parser limits.
- Disk layout `/var/data/{company_master,customer_db,history,...}` versus `/var/data/db/*`.

### Retire or archive

- `glamping-cluster-app` service name and cluster-specific production target documents.
- Automatic migration of cluster environment values or secrets.
- Empty RC product DB files and direct copying of cluster auth/session state.
- Recursive SLA, calibration, reassessment and auto-approval chains beyond the locked v1 readiness summary.
- Wholesale replacement of v2 server, HTML, JavaScript or CSS with RC files.
- Direct union of the 32 cluster run folders with the 158 canonical v2 run folders.

## 8. Render service boundary

| Item | glamping-datalab-v2 | glamping-cluster-app |
| --- | --- | --- |
| Role | Canonical production | Frozen reference only; not a runtime or data migration source after Stage 224 |
| Service ID | `srv-d8rjrmojs32c73c4tmhg` | `srv-d8jcapmrnols738cg40g` |
| Branch | `codex/glamping-datalab-v2` | `main` |
| Live commit observed | `4e4e1906e2967fe58df66f8ad67f832043d2763b` | `57a6c561496812126e2ff2e8a61bff51099b2423` |
| Plan/region | Starter / Singapore | Starter / Singapore |
| Disk | 1 GB at `/var/data` | 1 GB at `/var/data` |
| Disk identity | `glamping-datalab-v2-data` in the v2 persistent manifest | `glamping-data` in the RC persistent manifest |
| Data layout | Six domain directories and 158 output runs | `config`, `db`, `outputs`; 4 auth DB files and 32 output runs |

The disks have the same mount path but are different Render disks. No filesystem-level copy or restore may cross service IDs.

## 9. Environment boundary

### v2 live environment observed in Render

- `CONFIG_DIR`
- `DATA_DIR`
- `HOST`
- `NODE_ENV`
- `OUTPUTS_DIR`

The v2 persistent manifest also declares Naver client/search-ad credentials as operator-supplied variables, but they were not visible as configured live environment rows during Stage 221. A `traffic_api_keys.local.json` file exists on the v2 disk; its values were not read.

### Cluster live environment observed during Stage 220

- `APP_PIN`
- `AUTH_ALLOW_LEGACY_BASIC`
- `AUTH_CSRF_ENFORCE`
- `AUTH_CSRF_SECRET`
- `AUTH_EMAIL_MODE`
- `AUTH_EMAIL_QUEUE_SECRET`
- `AUTH_EMAIL_WEBHOOK_SECRET`
- `AUTH_KEY_CURRENT_VERSION`
- `AUTH_MFA_ENCRYPTION_KEY`
- `AUTH_MFA_ENFORCE_ADMIN`
- `AUTH_ORIGIN_ENFORCE`
- `AUTH_PUBLIC_BASE_URL`
- `AUTH_TRUST_PROXY`
- `CONFIG_DIR`
- `DATA_DIR`
- `HOST`
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NODE_ENV`
- `OUTPUTS_DIR`
- `RC_RUNTIME_ENVIRONMENT`

Environment values were not recorded. Secrets must be re-provisioned through the v2 staging environment after code readiness; they must not be copied from cluster automatically.

## 10. Integration rules

> **Superseded data-flow warning:** rule 6 and every migration, projection,
> backfill, sanitized-copy, or dual-write reference in this historical baseline
> are disabled after Stage 224. The integrated store starts empty and accepts only
> newly collected records. Existing V2 and Cluster runtime data remain denylisted.

1. Start every integration change from `integration/glamping-datalab-v2-stage221` or a child branch.
2. Keep `codex/glamping-datalab-v2` deployable and unchanged until staging acceptance.
3. Treat `57a6c561` as a reference tree, not a merge parent.
4. Port domain modules with tests; do not cherry-pick the monolithic RC commit.
5. Snapshot v2 contracts and disk schema before introducing adapters.
6. Use read-only projections first, dual-write only after replay tests, and cut over only after rollback rehearsal.
7. Never expose administrator raw data, connector errors, internal formulas or security state to business APIs.
8. Keep final production release approval manual.

## 11. Phased implementation plan

> **Historical table - superseded after Stage 224:** do not execute or renumber the
> Stage 222-232 rows below. In particular, the former migration rehearsal,
> v2-native UI, and monitored migration/cutover steps are cancelled. Use the
> current Stage 224-234 sequence and gates in
> `docs/v2_cluster_v3_ui_master_plan.md`.

| Stage | Scope | Exit criteria |
| --- | --- | --- |
| 222 | Contract freeze and test harness | v2 API/UI/data snapshots, fixture redaction, baseline tests and migration feature flags |
| 223 | Company and observation adapter | 214 company IDs preserved; v2 runs project to observations without modifying production files |
| 224 | Verified profile, location card and interest/lead-time adapters | Resolved confidence and card APIs pass fixture/replay tests |
| 225 | Account/session migration design | Legacy B2B login remains valid; tenant ownership, CSRF and admin MFA pass staging tests |
| 226 | Business monthly report APIs | Report, region, strategy, plans, retrospective and next-month APIs are role-safe |
| 227 | v2-native business UI | Monthly flow works on mobile/desktop and light/dark modes without RC HTML/CSS replacement |
| 228 | Admin integration | Existing DB/collection/settings flows gain verification and card controls without navigation regression |
| 229 | Connector/import/export hardening | Naver/SNS/OTA adapter states, safe spreadsheet handling and retry boundaries pass tests |
| 230 | Staging data migration rehearsal | Sanitized copy, schema migration, account linking, backup and rollback are repeatable |
| 231 | Staging RC and visual/security QA | Browser screenshots, tenant tests, smoke tests and operator evidence pass |
| 232 | Manual production cutover | Operator-approved deploy, monitored migration and rollback window; cluster remains archived until acceptance |

## 12. Stage 221 verification result

- Canonical branch/service decision: complete.
- Git divergence and high-conflict files: verified.
- Literal API and JSON-store inventories: compared.
- v2 runtime disk layout and non-sensitive counts: verified through authenticated Render Shell.
- Cluster runtime disk layout and non-sensitive counts: verified through authenticated Render Shell.
- Environment variable names: separated without reading values.
- Integration branch: created from the v2 production branch.
- Source merge: not performed.
- Production deploy or data modification: not performed.
