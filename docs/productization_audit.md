# Productization Audit

This audit is the phase-1 boundary for turning the current glamping cluster app into a lodging intelligence SaaS.

## Current Diagnosis

The current app is a single protected Node.js service with one SPA-style frontend.

| Area | Current state | Diagnosis |
|---|---|---|
| Server | `scripts/glamping_app_server.cjs` serves static files, protected APIs, crawl execution, settings, outputs, and run summaries. | Keep as the data engine and admin API base. |
| Crawler | `scripts/gyeongnam_glamping_crawl.cjs` collects Naver ranking, Naver booking stock, NOL/Yanolja, Ddnayo/ONDA-adjacent data, and Yeogi manual fallback. | Keep and split into fast search, detailed search, lead-time observation over time. |
| Frontend | `web/index.html`, `web/app.js`, `web/styles.css` render one dense operational screen. | Keep for admin console, do not use directly as the business SaaS product surface. |
| Outputs | Run folders under `outputs/` are read back into API summaries. | Keep for audit/history, then normalize into stable DB tables. |
| Auth | Basic auth/PIN only. | Enough for internal admin beta, not enough for multi-tenant business SaaS. |
| Data model | Run-based CSV/XLSX summaries with derived API responses. | Needs `company_id`, observations, verified overrides, and role-safe resolved report values. |
| Existing dirty files | `web/app.js` and `web/styles.css` already contain weekly placeholder UI changes. | Preserve; do not overwrite. |

## Keep, Separate, Build New

| Decision | Scope | Reason |
|---|---|---|
| Keep | Naver-first collection, Naver booking availability, NOL/Yanolja collection, Ddnayo/ONDA-adjacent rows, Yeogi manual import, output downloads, Render persistent disk config. | These are the current data engine and should not be rebuilt from scratch. |
| Separate | Admin console vs business app, raw observations vs verified overrides, internal errors vs customer-safe messages, fast search vs detailed search vs lead-time observation. | SaaS value depends on showing customers strategy, not crawler internals. |
| Build new | Business report UI, `company_id` master DB, verified profile editor, duplicate merge/split flow, lead-time scheduler, region cards, business-safe report API, tenant/user preferences, billing tiers. | These are productization gaps. |

## Phase-1 Implementation Boundary

Phase 1 starts by adding role/data boundaries without breaking the existing admin app.

| Task | Status | Notes |
|---|---|---|
| Add productization audit doc | Done | This file. |
| Add role-safe API scaffolding | Done | `/api/productization/diagnostic` and business-safe run projection. |
| Preserve admin default behavior | Done | Existing `/api/runs/:id` remains admin/full by default. |
| Define future data model | Done | Initial JSON-backed `company_master`, `property_observations`, `company_verified_profile`. |
| Add run-to-master ingestion | Done | `/api/admin/master-db/rebuild` imports current run summaries into stable company IDs. |
| Build business report UI | Planned | New `/app` surface after stable report API. |

## Data Model Target

| Table | Purpose |
|---|---|
| `company_master` | One stable internal ID per property, with aliases and external IDs. |
| `property_observations` | Raw automatic collection values by property/date/channel/search. |
| `company_verified_profile` | Admin-reviewed override values. |
| `verified_change_logs` | Who changed what, when, and why. |
| `leadtime_patterns` | Region/category/month/day lead-time curves. |
| `region_cards` | Region/category/month strategy cards. |
| `business_reports` | Role-safe resolved report snapshots. |

## Phase-2 File-Based DB

The first implementation keeps storage file-based so the existing app remains simple and compatible with Render Persistent Disk.

| File | Location | Purpose |
|---|---|---|
| `company_master.json` | `${DATA_DIR}/db/` | Stable internal company records keyed by `companyId`. |
| `property_observations.json` | `${DATA_DIR}/db/` | Automatic run-derived observations. |
| `company_verified_profile.json` | `${DATA_DIR}/db/` | Admin review/override drafts, preserved across rebuilds. |
| `verified_change_logs.json` | `${DATA_DIR}/db/` | Field-level admin verification change history. |
| `leadtime_patterns.json` | `${DATA_DIR}/db/` | Booking pace patterns derived from repeated lead-time observations. |
| `interest_signals.json` | `${DATA_DIR}/db/` | Naver Trend, keyword search volume, SNS mention, and manual/admin interest signals. |
| `interest_signal_jobs.json` | `${DATA_DIR}/db/` | Connector-ready collection queue for interest signal keywords. |

Current `companyId` identity priority:

1. Naver place accommodation ID from URL.
2. Naver booking business ID from URL.
3. Normalized company name + region fallback.

Current ingestion source is `loadRun()` summaries, so it is a safe first bridge. Later phases should ingest from raw crawler rows for richer external IDs, OTA URL detail, and channel-specific observations.

## Phase-2 Admin APIs

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/master-db/status` | Count and file status. |
| `POST` | `/api/admin/master-db/rebuild` | Import all runs, or one `runId`, into the file DB. |
| `GET` | `/api/admin/master-db/companies` | List company master records. Supports `q` and `limit`. |
| `GET` | `/api/admin/master-db/companies/:companyId` | Read one company with verified profile, observations, and change logs. |
| `GET` | `/api/admin/master-db/observations` | List observations. Supports `companyId` and `limit`. |
| `GET` | `/api/admin/master-db/verified-profiles` | List admin verified profile drafts. Supports `companyId` and `limit`. |
| `POST` | `/api/admin/master-db/verified-profiles/:companyId` | Update admin-reviewed profile fields and append change logs. |
| `GET` | `/api/admin/master-db/change-logs` | List verification changes. Supports `companyId` and `limit`. |
| `GET` | `/api/admin/master-db/collection-modes` | List supported collection modes and their intended search scope. |
| `POST` | `/api/admin/master-db/observations` | Append or update one manual/admin observation using the same collection-mode schema. |
| `POST` | `/api/admin/master-db/leadtime-patterns/rebuild` | Recalculate lead-time pattern and segment files from `property_observations`. |
| `GET` | `/api/admin/master-db/leadtime-patterns` | Read lead-time patterns. Supports `type=segments`, `companyId`, `region`, `category`, `channel`, `productKey`, `targetDate`, `targetMonth`, and `limit`. |
| `GET` | `/api/admin/master-db/interest-signals` | Read raw interest signal slots. Supports `region`, `companyId`, `signalType`, `scope`, and `limit`. |
| `POST` | `/api/admin/master-db/interest-signals` | Upsert manual/admin or connector-ready Naver/SNS interest signals. |
| `GET` | `/api/admin/master-db/interest-signal-jobs` | Read interest signal collection queue. Supports `region`, `companyId`, `signalType`, `scope`, `source`, `status`, and `limit`. |
| `POST` | `/api/admin/master-db/interest-signal-jobs/generate` | Generate queued keyword jobs from region/category/company inputs and create matching pending connector signal slots. |
| `POST` | `/api/admin/master-db/interest-signal-jobs/run-queued` | Run queued jobs through the current connector runner. Uses mock connector until real keys are wired. |
| `POST` | `/api/admin/master-db/interest-signal-jobs/:jobId/run` | Run one queue job through the current connector runner. |
| `POST` | `/api/admin/master-db/interest-signal-jobs/:jobId` | Update queue status such as collecting, succeeded, failed, review_required, or cancelled. |
| `GET` | `/api/admin/master-db/strategy-recommendations` | Admin review view for strategy recommendation formulas and source metric snapshots. Requires `companyId`. |
| `GET` | `/api/business/report` | Business-safe report. Requires `companyId`; optional `targetMonth`. |
| `GET` | `/api/business/companies` | Business-safe visible company selector for `/app`. Supports `q` and `limit`. |
| `GET` | `/api/business/region-card` | Business-safe region strategy card. Requires `companyId`. |

## Phase-3 Admin DB Console

The existing admin app now includes a first-pass DB console without replacing the current collection/admin workflow.

| Capability | Status | Notes |
|---|---|---|
| Company master list | Done | Search by property name, alias, or region from `company_master`. |
| Company detail view | Done | Shows one company profile, recent automatic observations, and recent verification changes. |
| Verified profile editing | Done | Admin can edit representative name, category, region, room/site count, day-use count, channel URLs, B2B visibility, final confidence, reviewer, and notes. |
| Field-level change logs | Done | Updates append to `verified_change_logs.json` with before/after values, reviewer, and timestamp. |
| Existing screens preserved | Done | Existing collection, run list, settings, and admin routes remain in place. |

## Phase-4 Collection Mode Split

`property_observations` now carries the fields needed to separate market discovery, detailed competitor checks, repeated lead-time snapshots, and OTA exposure.

| Field | Purpose |
|---|---|
| `collectionMode` | One of `fast_search`, `detailed_search`, `leadtime_observation`, `ota_exposure`. |
| `searchScope` | Logical scope such as `region_category`, `property_inventory`, `property_date_product`, or `ota_channel_presence`. |
| `channel` | Source channel such as `naver_place`, `naver_booking`, or an OTA platform name. |
| `targetDate` | The stay/use date being observed, usually check-in date. |
| `observedAt` | When the observation was collected or imported. |
| `leadTimeDays` | Days between `observedAt` and `targetDate`. |
| `productKey` | Stable product bucket for repeat tracking, such as `all`, `night`, or `ota:<channel>`. |
| `observationGroupKey` | Stable grouping key for repeated same company/date/product/channel observations. |

Current run-to-master rebuild behavior:

| Mode | Source | Notes |
|---|---|---|
| `fast_search` | Run availability rows without inventory signal. | Broad Naver-first market discovery. |
| `detailed_search` | Run availability rows with price/inventory/reservation signals. | Existing base observation ID is preserved to avoid duplicate rebuilds. |
| `leadtime_observation` | Additional row for availability rows with inventory signal. | Enables repeated snapshots for the same company, target date, product, and channel. |
| `ota_exposure` | `companyPlatforms` platform summary rows. | Captures channel presence, listing URL, status, and platform hints separately from Naver inventory. |

## Phase-5 Lead-Time Patterns

`leadtime_patterns.json` is a derived file. It can be rebuilt from `property_observations` at any time and should not replace the raw observations.

| Output | Grain | Purpose |
|---|---|---|
| Pattern | `companyId + region + category + channel + productKey + targetDate` | Track reservation pace for one property/date/product/channel group. |
| Segment | `region + category + channel + productKey + targetMonth` | Compare a property against its local/category booking pace baseline. |

Pattern metrics:

| Metric | Meaning |
|---|---|
| `series` | Time-ordered observations with `observedAt`, `leadTimeDays`, `bookingRate`, stock, and price. |
| `bookingRateStart` / `bookingRateLatest` | First and latest observed reservation/sold-out rate. |
| `bookingRateDelta` | Change between latest and first rate. |
| `pacePerDay` | `bookingRateDelta / observedSpanDays`; null when only one day exists. |
| `projectedArrivalBookingRate` | Draft projection from latest rate plus remaining lead-time pace; clamped to 0-1. |
| `bookingPaceScore` | 0-100 score derived from projected arrival booking rate. |
| `confidenceScore` / `confidenceGrade` | Objective confidence based on sample count, booking-rate availability, stock availability, lead-time span, and segment sample support. |

## Phase-6 Business Report API

`GET /api/business/report?companyId=<companyId>` combines master, verified, observation, and lead-time pattern data into a role-safe business report.

| Report block | Purpose |
|---|---|
| `flows.national` | Overall visible-market price, reservation, OTA, and lead-time flow. |
| `flows.region` | Same metrics for the target property's region. |
| `flows.myProperty` | Same metrics for the target property only. |
| `flows.comparables` | Same-region and same/compatible category comparison group, excluding the target. |
| `objectiveIndicators` | Price, reservation, lead-time, OTA exposure, B2B exposure, and reliability positions. |
| `nextMonthStrategySummary` | Draft strategic recommendations for the requested or next calendar month. |

Business safety boundary:

| Exposed | Hidden |
|---|---|
| Aggregated metrics, confidence grades, B2B status, target company identity, public-safe channel names. | Raw observations, admin notes, change logs, file paths, external IDs, collected URLs, and crawler internals. |

## Phase-7 Business Report UI

`/admin` and `/app` now share the same static bundle but split by `body[data-app-role]`.

| Surface | Purpose |
|---|---|
| `/admin` | Existing collection/admin console, master DB console, settings, downloads. |
| `/app` | Business-facing report dashboard using `GET /api/business/report`. |

Business UI blocks:

| Block | Source |
|---|---|
| Company selector | `GET /api/business/companies` |
| Top score strip | `flows.myProperty` and `objectiveIndicators` |
| Four flow cards | `flows.national`, `flows.region`, `flows.myProperty`, `flows.comparables` |
| Objective indicators | `objectiveIndicators.pricePosition`, `reservationPosition`, `leadtimePosition`, `otaExposure`, `b2bExposure`, `reliability` |
| Strategy summary | `nextMonthStrategySummary` |
| Theme toggle | Local `body[data-theme]` preference persisted to local storage. |

## Phase-8 Business UI Polish

The `/app` dashboard now presents the report as a SaaS-style operating dashboard rather than raw API output.

| UI area | Improvement |
|---|---|
| Flow cards | Added observation badges and visual bars for reservation rate, booking pace, and OTA coverage. |
| Objective indicators | Added status badges, tone states, and comparison bars for price, reservation, lead-time, OTA, B2B, and reliability. |
| Top score strip | Added compact bars under headline KPI values. |
| Theme | Light/dark mode contrast refined through shared CSS variables and dark-mode badge colors. |
| Mobile | Business report cards and controls collapse to single-column layouts without horizontal overflow. |

## Phase-9 Region Card

The business report now includes `regionCard`, and the same card can be fetched separately with `GET /api/business/region-card?companyId=<companyId>`.

| Region card block | Source and role |
|---|---|
| `structure` | Built-in regional structure profile: tourism/living-area/nature/adjacent-demand classification, resources, target demand, and note. |
| `access` | Nearby city access inferred from regional profile coordinates in the same province. |
| `demandKeywords` | Region/category/resource keyword set for Naver Trend/SearchAd/SNS comparison. |
| `searchInterest` | Current observation-count proxy from fast/detailed search rows. |
| `snsInterest` | Explicit pending connector slot; does not pretend to have real SNS mentions yet. |
| `otaExposure` | OTA exposure observation count and public-safe channel names. |
| `leadtime` | Region lead-time pattern count, average booking pace, and confidence grade. |
| `strategyLinks` | Region-structure strategy notes connected to the next-month strategy area. |

## Phase-10 Interest Signals

`interest_signals.json` is the connector-ready slot for Naver Trend, keyword search volume, and SNS mention signals. It can also be filled manually by an admin when external API keys are not available.

| Field | Meaning |
|---|---|
| `signalType` | One of `naver_trend`, `search_volume`, or `sns_mentions`. |
| `scope` | `region_keyword` for regional demand keywords, or `property_keyword` for the target property keyword. |
| `source` | `naver_trend`, `naver_searchad`, `sns`, `manual_admin`, or `verified_admin`. |
| `status` | `collected`, `manual`, `verified`, or `pending_connector`. |
| `score` | Optional normalized 0-100 score; otherwise derived from trend/search/mention values. |
| Raw values | `trendIndex`, `monthlySearchVolume`, `pcSearchVolume`, `mobileSearchVolume`, `mentionCount`, sentiment counts, notes, and reviewer. |

Business-safe use:

| Business block | Rule |
|---|---|
| `regionCard.searchInterest` | Prefer `interest_signals` region search volume, then region Naver trend, then observation-count proxy. |
| `regionCard.snsInterest` | Prefer target property SNS signal, then region SNS signal, then pending connector slot. |
| `/app` UI | Shows only score, keyword, status/source, and basis summary. Raw volumes, mention counts, notes, and reviewer fields remain admin-only. |

## Phase-11 Interest Signal Admin Console

The `/admin` master DB console now includes an interest signal review panel so admins can manage the Phase-10 signal slots without touching JSON files directly.

| Admin capability | Status |
|---|---|
| Filter signals | Region, company, signal type, and scope filters call `GET /api/admin/master-db/interest-signals`. |
| Edit signals | Existing rows can be loaded back into the form through their stable `signalId`. |
| Manual/admin input | `manual_admin` and `verified_admin` sources support direct entry and review. |
| External API placeholders | `naver_trend`, `naver_searchad`, and `sns` sources with `pending_connector` status distinguish planned connector rows from manual data. |
| Raw values | Trend index, monthly/PC/mobile search volume, SNS mention/sentiment counts, reviewer, and notes remain visible only in admin APIs/UI. |
| Business boundary | Business report and region card responses still expose only score, status/source, keyword, and public-safe basis summaries. |

## Phase-12 Interest Signal Collection Queue

`interest_signal_jobs.json` is the pre-connector work queue. It defines what should be collected before actual Naver Trend, Naver SearchAd, or SNS connectors are attached.

| Queue field | Meaning |
|---|---|
| `jobId` | Stable queue ID generated from source, signal type, scope, region, company, and keyword. |
| `signalId` | Matching `interest_signals` ID that starts as `pending_connector`. |
| `source` | Planned connector: `naver_trend`, `naver_searchad`, or `sns`. |
| `status` | `queued`, `collecting`, `succeeded`, `failed`, `review_required`, or `cancelled`. |
| `scope` | `region_keyword` or `property_keyword`. |
| `keyword` | Region/category keyword or selected property keyword. |

Admin workflow:

| Step | Result |
|---|---|
| Generate queue | Admin enters region/category/company/direct keywords; app creates deduplicated queue rows. |
| Pending signal slot | Each new queue row creates a matching `interest_signals` row with `pending_connector`. |
| Mark succeeded | Queue status changes to `succeeded`; connector result fields can update the matching signal as `collected`. |
| Mark failed | Queue keeps failure reason for retry and admin diagnosis. |
| Mark review required | Matching signal becomes manual/review-needed so admin can verify before business use. |

## Phase-13 Mock Connector Runner

The queue can now be executed before real Naver/SNS connectors are available.

| Runner behavior | Result |
|---|---|
| Individual run | Admin can run one `interest_signal_jobs` row from the queue table. |
| Bulk run | Admin can run up to 25 queued rows for the selected connector source. |
| Mock mode | Generates deterministic Naver Trend, Naver SearchAd, or SNS-shaped values from the queue key. |
| State transition | Jobs move through `collecting` and then end as `succeeded`, `failed`, or `review_required`. |
| Signal writeback | Successful runs update the matching `interest_signals` row as `collected` with raw values, score, and confidence. |
| Business boundary | Business APIs still receive only public score/status/source/keyword/basis summaries, not queue IDs or raw connector values. |

## Phase-14 Interest Scoring

Interest signals now have a normalized scoring layer before they enter the business report.

| Signal type | Standard score |
|---|---|
| `naver_trend` | `trendIndex / trend baseline * 100`, clamped to 0-100. |
| `search_volume` | `log10(monthlySearchVolume + 1)` compared with the current signal baseline. |
| `sns_mentions` | `log10(mentionCount + 1)` compared with the current signal baseline. |

Confidence scoring:

| Input | Effect |
|---|---|
| `status` | Verified > collected > manual > pending connector. |
| Raw value completeness | More source values add confidence. |
| Reviewer and recency | Reviewed and recent values score higher. |

Business report use:

| Block | Meaning |
|---|---|
| `flows.*.metrics.interest` | Separate national, region, my-property, and comparable interest aggregates. |
| `objectiveIndicators.interestDemand` | Business-safe score, grade, comparison baseline, and summary basis. |
| `regionCard.searchInterest` | Region search/trend standard score and grade. |
| `regionCard.snsInterest` | Property/region SNS standard score and grade. |

Admin UI keeps raw values and `formulaBasis`; business UI receives only score, grade, confidence grade, and public summary basis.

## Phase-15 Strategy Recommendation Engine

The business report now includes categorized `strategyRecommendations` built from price, reservation, lead-time, interest, OTA, B2B, and reliability metrics.

| Category | Input metrics |
|---|---|
| Price strategy | Price position, reservation position, lead-time pace. |
| Channel strategy | OTA channel count, comparable channel count, B2B status, reliability. |
| Product/package strategy | Reservation position, price position, interest score. |
| Content/SNS strategy | Interest score, reservation position, reliability. |
| Lead-time operation strategy | Booking pace, regional lead-time sample count, reservation position. |

Business response:

| Field | Meaning |
|---|---|
| `strategyRecommendations` | Actionable cards with category, title, action, rationale, objective metrics, priority, and confidence grade. |
| `nextMonthStrategySummary` | Backward-compatible text summary derived from recommendation actions. |

Admin review:

| Field | Meaning |
|---|---|
| `/api/admin/master-db/strategy-recommendations` | Returns the same recommendations plus formulas and raw metric snapshots. |
| Admin company detail | Shows formula, metric keys, confidence grade, and JSON metric snapshot for verification. |

Business UI hides admin formulas and renders only executable strategy cards.

## Phase-16 Strategy Execution Plans

Strategy recommendations now carry execution-planning fields so the business report can be used as a next-month action plan.

| Field | Meaning |
|---|---|
| `executionDifficulty` | Low/medium style effort estimate derived from strategy category and weak metrics. |
| `expectedEffect` | Expected impact tier based on priority and weak objective indicators. |
| `recommendedTiming` | Suggested execution window such as this week, before next-month sales open, or D-30/D-14/D-7. |
| `checklist` | Concrete tasks the operator can mark off in the business UI. |
| `trackingKpis` | KPIs to monitor after executing the strategy. |

Admin review now shows recommendation review status, confidence, difficulty, expected effect, timing, formulas, and raw metric snapshots.

## Phase-17 Persisted Execution Plans

Strategy checklist edits are now saved as file-based execution plans instead of temporary UI state.

| Data file/API | Purpose |
|---|---|
| `db/strategy_execution_plans.json` | Stores `companyId`, `targetMonth`, `strategyId`, status, owner, due date, memo, checklist state, progress, and timestamps. |
| `POST /api/business/strategy-execution-plans` | Saves business-side checklist/status/owner/date/memo edits and returns a role-safe plan. |
| `GET /api/business/strategy-execution-plans` | Lists role-safe plans for a company/month/status filter. |
| `GET /api/admin/master-db/strategy-execution-plans` | Lists raw admin execution plans with status counts and progress summary. |
| `POST /api/admin/master-db/strategy-execution-plans` | Allows admin-side correction of a stored execution plan. |

Business report behavior:

| Field | Meaning |
|---|---|
| `strategyRecommendations[].executionPlan` | Persisted plan merged into each strategy card. |
| `strategyExecutionProgress` | Total plans, completed/blocked counts, average progress, status counts, and incomplete checklist items. |

Admin review behavior:

| Surface | Meaning |
|---|---|
| Strategy recommendation review | Shows execution progress summary and incomplete checklist items next to formulas. |
| Master DB status | Counts execution plans by status for operational monitoring. |

## Phase-18 Monthly Operations Board

Execution plans are now expanded into a monthly operating board for business users and admin reviewers.

| Area | Implementation |
|---|---|
| KPI tracking | `strategy_execution_plans.json` stores `kpiTracking[]` with label, target value, current value, note, and updated timestamp. |
| Due-state logic | Each plan is classified as `overdue`, `this_week`, `scheduled`, or `no_due` from `dueDate` and execution status. |
| Business API | `GET /api/business/operations-board` returns summary, filtered summary, overdue section, this-week section, and all filtered plans. |
| Admin API | `GET /api/admin/master-db/strategy-execution-board` mirrors the board for review workflows. |
| Business UI | `/app` shows status/owner/due filters, monthly execution rate, delayed count, this-week count, and KPI completion. |
| Admin UI | Strategy review summary now includes monthly delayed count and KPI input ratio. |

Supported filters:

| Filter | Values |
|---|---|
| `status` | `not_started`, `in_progress`, `done`, `blocked` |
| `owner` | Partial owner text match |
| `dueState` | `overdue`, `this_week`, `scheduled`, `no_due` |

## Phase-19 Monthly Performance Retrospective

Execution-plan outcomes are now converted into a monthly retrospective report.

| Area | Implementation |
|---|---|
| Business API | `GET /api/business/performance-retrospective` returns monthly score, grade, KPI/checklist summary, incomplete causes, carryover items, repeat strategies, and plan-level results. |
| Admin API | `GET /api/admin/master-db/performance-retrospective` returns the same retrospective with admin role for review workflows. |
| Scoring | Combines checklist completion, KPI achievement, execution status, and due-state penalty. |
| Carryover logic | Plans that are not done, below 100% checklist completion, or overdue become next-month carryover candidates. |
| Repeat logic | Completed/high-progress plans with acceptable KPI achievement become repeat-strategy candidates. |
| Business UI | `/app` shows monthly retrospective cards, incomplete reasons, next-month carryover suggestions, and repeat strategies. |
| Admin UI | Strategy review summary shows retrospective score/grade, carryover count, and repeat count. |

Retrospective scoring inputs:

| Input | Weight/Effect |
|---|---|
| Checklist completion | 40% of score. |
| KPI achievement | 35% of score when target/current values are present; otherwise neutral fallback. |
| Execution status | 25% of score from done/in-progress/blocked/not-started. |
| Due state | Overdue and missing due dates apply penalties. |

## Phase-20 Next-Month Plan Generation

Monthly retrospective output now seeds next-month execution-plan candidates.

| Area | Implementation |
|---|---|
| Candidate API | `GET /api/business/next-month-plan-candidates` returns role-safe carryover, repeat, and new-recommendation candidates. |
| Apply API | `POST /api/business/next-month-plan-candidates/apply` creates only the selected candidates in the next target month. |
| Admin API | `GET /api/admin/master-db/next-month-plan-candidates` returns candidate basis, source links, and duplicate review flags. |
| Stored plan metadata | `strategy_execution_plans.json` now preserves `sourceType`, `sourceMonth`, `sourcePlanId`, `sourceCandidateId`, and `autoGeneratedReason`. |
| Duplicate logic | Candidates are marked when the target month already has the same `strategyId` or when another candidate shares the strategy. |
| Business UI | `/app` shows a selectable next-month candidate board below the retrospective report. |
| Admin UI | Strategy review summary includes next-month candidate counts, duplicate counts, and top candidate basis lines. |

Candidate sources:

| Source | Meaning |
|---|---|
| `carryover` | Previous-month plans that were not complete, overdue, blocked, or below full checklist completion. |
| `repeat` | Completed/high-progress plans with acceptable KPI achievement that should continue tracking. |
| `new_recommendation` | Fresh next-month recommendations from the strategy engine. |

## Phase-21 Execution-Plan Traceability

Auto-generated next-month plans are now traceable inside the operating board and retrospective report.

| Area | Implementation |
|---|---|
| Stored trace fields | Applied plans preserve `appliedAt`, `appliedBy`, and `applicationDuplicateStatus` in `strategy_execution_plans.json`. |
| Business operations board | `GET /api/business/operations-board` accepts `sourceKind=auto_generated` or `sourceKind=manual`. |
| Admin operations board | `GET /api/admin/master-db/strategy-execution-board` accepts the same `sourceKind` filter. |
| Public plan response | Execution plans expose safe source summary fields: generation type, source type/month/plan/candidate, applied timestamp, applied user, and duplicate status. |
| Retrospective API | Monthly retrospective includes `automationTrace`, auto/manual counts, source-type counts, and source fields on plan-level results. |
| Business UI | `/app` operating board shows automatic/manual badges, source trace text, and source filter. |
| Admin UI | Strategy review summary shows auto/manual counts, traced applied plan count, and source/applied details per strategy. |

Generation filters:

| Filter | Meaning |
|---|---|
| `auto_generated` | Created from a next-month candidate selected by the business user. |
| `manual` | Created or edited directly without a candidate source. |

## Phase-22 Recommendation Quality Review

Auto-generated execution plans are now evaluated at month-end against their original candidate source.

| Area | Implementation |
|---|---|
| Quality scoring | Combines execution rate, KPI achievement, due-state, and execution status into `qualityScore` and `qualityGrade`. |
| Business retrospective | `recommendationQuality` exposes only score, grade, keep/adjust/switch decision, and a plain-language summary. |
| Admin retrospective | `adminRecommendationQuality` includes source candidate IDs, original recommendation reason, scoring formula, inputs, and failure reasons. |
| Admin strategy review | Strategy formula cards now include matched recommendation-quality diagnostics in the JSON review block. |
| Business UI | `/app` shows a recommendation-quality panel inside monthly retrospective without raw formula snapshots. |
| Admin UI | `/admin` shows recommendation quality summary and top failure reasons for review. |

Quality decision:

| Decision | Meaning |
|---|---|
| `keep` | Recommendation fit actual execution and can be maintained. |
| `adjust` | Recommendation was partially useful but needs operational adjustment. |
| `drop` | Recommendation should be switched or reworked next month. |

## Phase-23 Strategy Quality Learning Loop

Recommendation quality results now accumulate into a draft learning dataset and influence future recommendation priority.

| Area | Implementation |
|---|---|
| History file | `strategy_quality_history.json` stores candidate-level quality outcomes by company, month, strategy, source candidate, score, fit, and failure reasons. |
| History APIs | Business-safe `GET /api/business/strategy-quality-history`; admin raw `GET /api/admin/master-db/strategy-quality-history`; admin rebuild `POST /api/admin/master-db/strategy-quality-history/rebuild`. |
| History sync | Admin retrospective calls persist `adminRecommendationQuality.items` into the history file. |
| Recommendation learning | `buildStrategyRecommendations` applies prior quality history; low-quality strategies receive a priority penalty and admin adjustment reason. |
| Business UI | Strategy cards show only a simple learning summary such as “지난 회고 반영됨”. |
| Admin UI | Strategy review shows quality history count, low-quality count, priority adjustment reason, and learning diagnostics in the JSON review block. |

Learning adjustment policy:

| Condition | Effect |
|---|---|
| No prior history | No priority change. |
| One weak/failed history or average score below 70 | Mild priority penalty. |
| Multiple weak histories or average score below 55 | Stronger priority penalty. |

## Phase-24 Segment-Based Recommendation Learning

Recommendation learning now considers whether a strategy worked for similar lodging segments, not only for the same company.

| Area | Implementation |
|---|---|
| Segment definition | Region, category, target-month season type, interest-score band, and lead-time booking-pace band form the draft segment key. |
| Combined inputs | `strategy_quality_history` provides outcomes, `interest_signals` provides demand bands, and `leadtime_patterns` provides booking-pace bands. |
| Segment APIs | Business-safe `GET /api/business/strategy-segment-learning`; admin raw `GET /api/admin/master-db/strategy-segment-learning`. |
| Recommendation learning | `buildStrategyRecommendations` applies company quality history plus segment learning; weak segment outcomes lower priority, strong repeated outcomes can lift priority. |
| Business UI | Strategy cards expose only a short summary such as “비슷한 숙소군에서 검증된 전략”. |
| Admin UI | Strategy review shows segment support count, average quality, target segment, priority adjustment reason, and diagnostics in the JSON review block. |

Segment learning policy:

| Condition | Effect |
|---|---|
| No matching segment history | No segment priority change. |
| Similar segment average below 70 or one weak result | Mild priority penalty. |
| Similar segment average below 55 or repeated weak results | Stronger priority penalty. |
| Similar segment average 80+ with repeated keep results | Mild priority lift. |

## Phase-25 Strategy A/B Experiment Drafts

Segment-level learning now creates draft A/B experiments that business users can execute during the report month.

| Area | Implementation |
|---|---|
| Experiment source | `strategyExperiments` is generated from strategy recommendations plus segment learning evidence. |
| Experiment APIs | Business-safe `GET /api/business/strategy-experiments`; admin raw `GET /api/admin/master-db/strategy-experiments`. |
| Experiment shape | Each candidate includes objective, hypothesis, target period, A/B variants, success KPIs, stop criteria, readiness score, and status. |
| Category coverage | Price, channel, product/package, content/SNS, and lead-time strategy categories each have default KPI and stop-rule templates. |
| Business UI | `/app` shows “이번 달 실험 카드” with actionable A/B variants and KPI/stop-rule chips. |
| Admin UI | `/admin` shows experiment count, readiness score, segment evidence, past quality, and priority formula in the strategy review JSON block. |

Experiment readiness policy:

| Input | Effect |
|---|---|
| Strategy confidence grade | Higher confidence increases readiness. |
| Segment support count | More similar-segment outcomes increase readiness. |
| Segment average quality | Strong prior outcomes increase readiness. |
| Segment penalty | Weak prior outcomes reduce readiness and keep the experiment as a lower-priority draft. |

## Phase-26 Experiment Execution Plans

A/B experiment candidates can now be saved as persistent execution plans and appear in the monthly operating board.

| Area | Implementation |
|---|---|
| Plan file | `strategy_experiment_plans.json` stores experiment status, owner, due date, selected variant, KPI targets/current values, stop criteria, memo, and progress. |
| Business APIs | `GET/POST /api/business/strategy-experiment-plans` lets business users save and reload experiment execution plans. |
| Admin APIs | `GET/POST /api/admin/master-db/strategy-experiment-plans` exposes the same plans for verification. |
| Operating board | Saved experiment plans are merged into `GET /api/business/operations-board` with `generationType=experiment` and `sourceKind=experiment`. |
| Business UI | Experiment cards include status, owner, due date, Variant A/B selection, KPI target inputs, stop-criteria checks, memo, and save action. |
| Admin UI | Strategy review summary shows experiment execution progress, Variant A/B distribution, and stop criteria occurrence count. |

Experiment execution summary:

| Metric | Meaning |
|---|---|
| `avgProgress` | Draft execution progress from status, KPI input, and stop-criteria review. |
| `variantCounts` | Count of saved experiments by selected A or B variant. |
| `stopTriggered` | Number of experiment plans where at least one stop criterion is checked. |
| `kpi` | Filled KPI target/current-value summary across experiment plans. |

## Phase-27 Experiment Performance Tracking

Saved A/B experiment execution plans now produce a result report that can guide whether to maintain, stop, adjust, or expand a strategy.

| Area | Implementation |
|---|---|
| Result source | `strategy_experiment_plans.json` is combined with the current `strategyExperiments` candidates. |
| Result APIs | Business-safe `GET /api/business/strategy-experiment-results`; admin raw `GET /api/admin/master-db/strategy-experiment-results`. |
| Score formula | Progress, KPI achievement, status score, selected Variant bonus, and stop-criteria penalty are combined into `performanceScore`. |
| Business UI | `/app` shows “실험 결과 카드” with score, winning Variant candidate, KPI progress, stop count, and maintain/stop/adjust/expand decision. |
| Admin UI | `/admin` shows result summary and per-strategy raw formula inputs in the strategy review JSON block. |

Experiment result decisions:

| Decision | Meaning |
|---|---|
| `expand` | High score with completed execution; candidate can be widened. |
| `maintain` | Positive result; keep the selected Variant running. |
| `adjust` | Partial result; keep observing or tune the experiment. |
| `stop` | Stop criteria, blocked status, or weak score suggests stopping. |

## Phase-28 Experiment Quality Learning

A/B experiment results now become learning data for the next strategy recommendation cycle.

| Area | Implementation |
|---|---|
| Learning file | `experiment_quality_history.json` stores experiment score, winning Variant, decision, KPI achievement, stop-trigger count, failed stop criteria, and admin formula inputs. |
| Learning APIs | Business-safe `GET /api/business/experiment-quality-history`; admin raw `GET /api/admin/master-db/experiment-quality-history`; admin rebuild `POST /api/admin/master-db/experiment-quality-history/rebuild`. |
| Auto sync | Admin strategy review and admin experiment-result reads upsert current experiment results into history. |
| Recommendation effect | High-score `expand`/`maintain` results can lift priority; `stop`, weak score, or failed stop criteria lower priority and carry an admin reason. |
| Experiment effect | Draft A/B experiment readiness includes an experiment-history readiness adjustment and the admin JSON shows the supporting history. |
| Business UI | Strategy and experiment cards only show a public “지난 실험 결과 반영됨” summary. |
| Admin UI | Strategy review shows experiment quality history counts, score averages, priority adjustment reasons, failed stop criteria, and raw formula inputs. |

## Phase-29 Integrated Learning Score

Retrospective execution quality and A/B experiment performance now feed one integrated learning score before the strategy engine applies priority, experiment readiness, and next-month candidate scoring.

| Area | Implementation |
|---|---|
| Integrated inputs | `strategy_quality_history` contributes retrospective quality score and low-quality count; `experiment_quality_history` contributes experiment score, success count, stop count, winning Variant, and failed stop criteria. |
| Score formula | When both sources exist, `integratedScore = retrospective quality 45% + experiment performance 55%`; when only one exists, that source carries the score. |
| Recommendation priority | Segment learning remains separate, while retrospective/experiment effects are applied once through `integratedLearningAdjustment.priorityAdjustment`. |
| Experiment readiness | A/B readiness uses the integrated learning readiness adjustment instead of experiment-only adjustment. |
| Candidate score | Next-month candidates include `candidateScore` and grade from source base score plus integrated learning candidate adjustment. |
| Business UI | Strategy and candidate cards show only “지난 실행/실험 결과 반영됨” and recommendation confidence score/grade. |
| Admin UI | Strategy review JSON exposes integrated formula, source weights, score contributions, risk/success counts, and confidence contribution. |

## Phase-30 Learning Calibration Console

The integrated learning score can now be simulated from an admin-only console without changing the business-safe report surface.

| Area | Implementation |
|---|---|
| Calibration settings | Admins can simulate retrospective/experiment weights, risk penalty, success bonus, and score thresholds. |
| Admin API | `GET /api/admin/master-db/integrated-learning-calibration` returns strategy-level current vs simulated integrated score, recommendation confidence, priority adjustment, experiment readiness adjustment, and candidate score adjustment. |
| Admin UI | `/admin` strategy review now includes a learning calibration panel with setting inputs, summary metrics, a comparison table, and raw formula/settings JSON for review. |
| Business boundary | `/api/business/report` and `/app` continue to expose only recommendation confidence and public learning summaries, not calibration settings or formulas. |

## Phase-31 Learning Calibration Versioning

Admin-approved calibration settings are now persisted and versioned before they affect the recommendation engine.

| Area | Implementation |
|---|---|
| Settings file | `learning_calibration_settings.json` stores active version id, setting versions, status, appliedBy, appliedAt, reason, source, and rollback links. |
| Admin APIs | `GET /api/admin/master-db/learning-calibration-settings`, `POST /api/admin/master-db/learning-calibration-settings/apply`, and `POST /api/admin/master-db/learning-calibration-settings/rollback` manage the active calibration version. |
| Engine effect | `businessReport` reads the active calibration version and applies it before strategy recommendations, A/B experiment candidates, and next-month plan candidates are generated. |
| Admin UI | `/admin` learning calibration panel now supports approve-active, version history display, and rollback to either a saved version or the built-in default. |
| Business boundary | Business report responses still expose only recommendation confidence and public summaries; active settings, version history, and formulas remain admin-only. |

## Phase-32 Learning Calibration Review Workflow

Calibration changes now pass through a proposal review workflow before they can become active.

| Area | Implementation |
|---|---|
| Proposal states | Settings can be saved as `draft` or `proposed`; only `approve` promotes a proposal to `active`. |
| Stored impact | Proposed versions store impact summary and strategy-level before/after snapshots for priority, experiment readiness, candidate score, confidence, and integrated score. |
| Admin APIs | `POST /api/admin/master-db/learning-calibration-settings/propose`, `/approve`, and `/reject` manage review workflow while preserving apply/rollback compatibility. |
| Admin UI | `/admin` shows proposed versions with impact summary plus Approve/Reject actions; rejected versions retain rejection reason in history. |
| Business boundary | Business reports continue to use only active settings and never expose proposal state, settings history, or review reasons. |

## Phase-33 Calibration Proposal Impact Review

Calibration proposals now include a detailed admin review surface before approval.

| Area | Implementation |
|---|---|
| Impact detail | Proposed versions store and display strategy-level before/after/delta for integrated score, recommendation confidence, final priority, experiment readiness, and candidate score. |
| Risk badges | Large integrated score, confidence, priority, readiness, or candidate-score movements are classified as high/medium/low risk and shown in the admin impact panel. |
| Review checklist | Proposed settings include required review checklist items; checklist state can be saved with `POST /api/admin/master-db/learning-calibration-settings/review-checklist`. |
| Approval guard | Approval requires all required checklist items to be checked; incomplete proposals are rejected server-side before active promotion. |
| Business boundary | Business responses remain active-setting-only and expose no proposal impact detail, review checklist, settings, or review history. |

## Phase-34 Learning Calibration Audit Report

Calibration review data now produces an admin-only audit report that connects setting history to recommendation impact and execution-plan outcomes.

| Area | Implementation |
|---|---|
| Audit API | `GET /api/admin/master-db/learning-calibration-audit` returns monthly event counts, risk summaries, affected strategy counts, matched execution-plan performance, and version traces. |
| Monthly rollup | Proposal, approval, rejection, rollback, high-risk, medium-risk, impacted strategy, matched plan, overdue plan, average progress, and retrospective score are grouped by month. |
| Version trace | Each calibration version keeps its event list, impact summary, review state, and matched execution plans for source company/month/strategy ids. |
| Admin UI | `/admin` strategy review includes a `Calibration audit` panel with monthly history and version-level impact/performance trace. |
| Business boundary | `/api/business/report` and `/app` continue to expose only recommendation confidence summaries; calibration settings, proposal history, checklist state, audit events, and formulas remain admin-only. |

Audit interpretation:

| Signal | Meaning |
|---|---|
| `highRiskVersions` | Number of versions with large score, priority, readiness, or candidate-score movement. |
| `affectedStrategies` | Strategy ids captured in proposal impact snapshots for the relevant month/version. |
| `matchedPlans` | Execution plans matching the calibration source company, target month, and affected strategy ids. |
| `avgMatchedPlanScore` | Retrospective score for matched plans, used to review whether a calibration change led to stronger execution outcomes. |

## Phase-35 Calibration Audit Filtering and Export

The calibration audit report can now be filtered, exported, and inspected from version-level drilldowns.

| Area | Implementation |
|---|---|
| Audit filters | `GET /api/admin/master-db/learning-calibration-audit` accepts `companyId`, `month`, `status`, `risk`, and `limit`. |
| Export draft | The same endpoint supports `format=json` and `format=csv` with download headers. The default response remains the admin JSON API. |
| Filter metadata | Audit JSON includes `availableFilters` for months, companies, statuses, and risk levels plus current-filter export URLs. |
| Version drilldown | Each audit item includes `drilldown.proposal`, `drilldown.impactStrategies`, and `drilldown.matchedExecutionPlans`. |
| Admin UI | `/admin` shows filter controls, JSON/CSV export links, monthly summary, and expandable version traces. |
| Business boundary | Business APIs and `/app` still do not expose calibration settings, audit filters, export rows, raw proposal settings, or review history. |

## Phase-36 Calibration Audit Operational Review

Calibration audit items now support admin follow-up workflows without exposing those review records to business users.

| Area | Implementation |
|---|---|
| Review file | `learning_calibration_audit_reviews.json` stores `versionId`, `reviewStatus`, `adminMemo`, `followUpOwner`, `followUpDueDate`, `updatedBy`, and timestamps. |
| Review API | `POST /api/admin/master-db/learning-calibration-audit-reviews` upserts one review record per calibration audit version. |
| Audit merge | `GET /api/admin/master-db/learning-calibration-audit` merges review records into `auditReview` and `drilldown.operationalReview`. |
| Review filters | Audit filtering now supports `reviewStatus` alongside company, month, workflow status, risk, and limit. |
| Export fields | CSV/JSON export rows include review status, memo, owner, due date, overdue flag, reviewer, and update time. |
| Admin UI | Version drilldowns include an operational review form so admins can save status, memo, owner, and due date from the audit panel. |
| Business boundary | `/api/business/report` and `/app` still exclude audit review notes, follow-up owners, due dates, and calibration review history. |

## Phase-37 Calibration Audit Follow-Up Queue

Calibration audit review records now roll up into an admin-only operating queue for follow-up management.

| Area | Implementation |
|---|---|
| Queue API | `GET /api/admin/master-db/learning-calibration-audit-queue` returns follow-up items merged from calibration audit versions and review records. |
| Queue filters | The API supports `reviewStatus`, `owner`, `dueState`, `risk`, `companyId`, `month`, and `limit`. |
| Due states | Follow-ups are classified as `overdue`, `this_week`, `upcoming`, or `no_due` from the KST current date. |
| Queue summary | The response includes open, overdue, this-week, unassigned, resolved, deferred, status counts, and owner-level open/overdue/this-week counts. |
| Admin UI | `/admin` includes a Calibration audit follow-up queue with filters, status cards, owner summary, and item list. |
| Business boundary | Business APIs and `/app` continue to exclude audit queue items, admin memos, follow-up owners, due dates, and calibration settings history. |

## Phase-38 Calibration Audit Queue Inline Review

The admin follow-up queue now supports direct item edits while keeping the audit drilldown and queue summary in sync.

| Area | Implementation |
|---|---|
| Inline queue edit | Queue rows expose editable review status, follow-up owner, due date, and admin memo controls. |
| Save path | Queue edits reuse `POST /api/admin/master-db/learning-calibration-audit-reviews`, preserving one review record per calibration audit version. |
| Synced refresh | After saving from the queue, the follow-up queue summary/list and the selected company's audit drilldown are refreshed together. |
| Detail parity | Saving from the version drilldown also refreshes the operating queue, so both admin surfaces share the latest review state. |
| Admin UI | Inline controls are styled for dense desktop review, dark mode, and single-column mobile layouts. |
| Business boundary | Business APIs and `/app` still exclude calibration settings, audit review status, admin memos, owners, due dates, and queue history. |

## Phase-39 Calibration Audit Queue Bulk Review

The admin follow-up queue now supports selected-item bulk processing for operational review work.

| Area | Implementation |
|---|---|
| Bulk API | `POST /api/admin/master-db/learning-calibration-audit-reviews/bulk` updates multiple audit review records in one write. |
| Bulk fields | Selected queue items can receive shared review status, follow-up owner, due date, and admin memo values. |
| Selection UI | Queue rows include checkboxes plus visible-item select and clear controls with a selected-count indicator. |
| Synced refresh | After bulk saving, the queue summary/list and selected company audit drilldown refresh together. |
| Export continuity | CSV/JSON audit exports continue to read merged review records, so bulk-updated status, owner, due date, and memo appear in admin-only exports. |
| Business boundary | Business APIs and `/app` still exclude calibration settings, audit queue items, review notes, owners, due dates, and export data. |

## Phase-40 Calibration Audit Review Change Logs

Calibration audit queue edits now keep an admin-only change log for single and bulk review operations.

| Area | Implementation |
|---|---|
| Log file | `learning_calibration_audit_review_logs.json` stores before/after review status, owner, due date, memo, changer, timestamp, operation type, and operation id. |
| Single review logging | `POST /api/admin/master-db/learning-calibration-audit-reviews` writes a `single` log row when review fields change. |
| Bulk review logging | `POST /api/admin/master-db/learning-calibration-audit-reviews/bulk` writes one `bulk` log row per changed selected item with a shared operation id. |
| Log API | `GET /api/admin/master-db/learning-calibration-audit-review-logs` returns filtered admin-only log rows and grouped bulk operations. |
| Admin UI | Queue items and audit drilldowns show recent item-level change history; the queue also shows recent bulk operation history. |
| Export continuity | Audit JSON/CSV exports include latest review state plus change count, last changer, last operation type, changed fields, and summary. |
| Business boundary | Business APIs and `/app` still exclude review logs, bulk operation logs, admin memo history, owner history, and calibration audit exports. |

## Phase-41 Calibration Audit Operational Quality

Calibration audit review logs now produce admin-only operational quality metrics.

| Area | Implementation |
|---|---|
| Quality API | `GET /api/admin/master-db/learning-calibration-audit-review-quality` returns monthly and owner-level quality metrics from review change logs. |
| Quality metrics | Metrics include single changes, bulk operations, bulk item changes, average processing days, delayed-resolution rate, owner throughput, reopen count, and memo-change count. |
| Processing time | Processing time is measured from the first review log for a version to the first terminal review transition (`resolved` or `deferred`). |
| Delay resolution | Delay resolution counts overdue open items that were moved to a terminal state. |
| Admin UI | The audit follow-up queue shows operational quality cards, monthly quality rows, and owner performance rows. |
| Business boundary | Business APIs and `/app` still exclude review logs, owner performance, processing-time metrics, delay-resolution metrics, and operational quality summaries. |

## Phase-42 Calibration Audit SLA Grades

Operational quality metrics now include admin-only SLA warning grades and improvement prompts.

| Area | Implementation |
|---|---|
| SLA evaluation | Quality buckets return `sla.level`, `sla.label`, criteria, and improvement items. |
| SLA criteria | Normal requires average processing within 2 days, delay resolution at least 80%, reopen rate at most 10%, and no unresolved delayed items. |
| Warning criteria | Warning allows average processing within 5 days, delay resolution at least 60% when there is a resolution sample, reopen rate at most 20%, and up to 2 unresolved delayed items. |
| Risk criteria | Any metric outside warning criteria is marked `danger` with a specific improvement item. |
| Unresolved delay | The latest review state per audit version is checked for open overdue follow-ups and counted into summary, monthly, owner, and owner-month buckets. |
| Admin UI | The queue quality panel shows SLA cards, monthly/owner SLA badges, unresolved delayed counts, reopen rate, and improvement-needed text. |
| Business boundary | Business APIs and `/app` still exclude SLA grades, owner performance, quality metrics, review logs, and calibration audit operations. |

## Phase-43 Calibration Audit SLA Improvement Actions

SLA warning grades now create admin-only operational action candidates that can be reviewed and saved.

| Area | Implementation |
|---|---|
| Action file | `learning_calibration_sla_actions.json` stores SLA action candidates and saved actions with assignee, target date, priority, status, root metric, and recommendation. |
| Candidate generation | Warning/risk SLA improvement items create deterministic candidates for overall, monthly, and owner-level quality buckets. |
| Action API | `GET /api/admin/master-db/learning-calibration-sla-actions` returns generated plus saved actions; `POST /api/admin/master-db/learning-calibration-sla-actions` upserts reviewed actions. |
| Quality merge | `operationQuality.slaActions` is attached to audit reports, the follow-up queue, and the quality API so admin screens can review actions without extra client orchestration. |
| Admin UI | The queue quality panel shows SLA action cards where admins can edit priority, assignee, target date, status, and recommended action before saving. |
| Business boundary | Business APIs and `/app` still exclude SLA actions, owners, target dates, root metrics, recommendations, SLA grades, and operational quality metrics. |

## Phase-44 Calibration SLA Action Queue

Saved SLA improvement actions now operate as an admin-only action queue with completion tracking.

| Area | Implementation |
|---|---|
| Queue API | `GET /api/admin/master-db/learning-calibration-sla-action-queue` filters SLA actions by status, assignee, due state, priority, risk, and month. |
| Queue summary | The API returns open, overdue, this-week, urgent, high-risk, done, priority, risk, and assignee-level unresolved action counts. |
| Focus groups | Delayed actions, this-week actions, and assignee open-action summaries are returned separately for operational review. |
| Completion snapshot | When an SLA action is saved with `done` status, the action stores a `completionQualitySnapshot` with current source metrics, baseline metrics, deltas, SLA state, and improvement result. |
| Admin UI | A dedicated SLA improvement action queue panel lets admins filter, review, save, and status-change corrective actions without leaving the DB console. |
| Business boundary | Business APIs and `/app` still exclude SLA action queues, risk grades, operational assignees, completion snapshots, and corrective-action recommendations. |

## Phase-45 Calibration SLA Action Reassessment

Completed SLA improvement actions now have an admin-only post-completion reassessment report.

| Area | Implementation |
|---|---|
| Reassessment API | `GET /api/admin/master-db/learning-calibration-sla-action-reassessment` evaluates completed SLA actions that have a `completionQualitySnapshot`. |
| Evaluation logic | The report compares the completion snapshot against post-completion/current operating quality metrics for the same summary, month, or owner scope. |
| Effect score | Each completed action receives an effect score, evaluation state (`improved`, `unchanged`, `worse`), recurrence flag, and follow-up-needed flag. |
| Follow-up API | `POST /api/admin/master-db/learning-calibration-sla-actions/follow-up` creates a saved follow-up SLA action from a weak or recurring reassessment. |
| Admin UI | A dedicated reassessment panel shows completed action outcomes, metric deltas, recurrence, effect score, and a follow-up creation button. |
| Business boundary | Business APIs and `/app` still exclude reassessments, effect scores, completion snapshots, recurrence flags, and follow-up candidates. |

## Phase-46 SLA Action Reassessment History

SLA action reassessment results now accumulate into an admin-only history file and aggregate report.

| Area | Implementation |
|---|---|
| History file | `sla_action_reassessment_history.json` stores completed action reassessment snapshots with effect score, outcome, recurrence, follow-up-needed, and follow-up-created fields. |
| History persistence | The reassessment API upserts one daily history row per completed action/outcome/score so repeated refreshes do not create noisy duplicates. |
| Follow-up tracking | Creating a follow-up action marks the latest source-action history row with follow-up action id, source key, and created timestamp. |
| History API | `GET /api/admin/master-db/sla-action-reassessment-history` returns filtered history rows plus monthly, assignee, and root-metric aggregates. |
| Effect analysis | Admin aggregates separate effective action types from weak action types using average effect score, improvement rate, recurrence rate, and follow-up creation rate. |
| Admin UI | The DB console includes a reassessment history panel with filters, summary cards, effective/weak action type summaries, and recent history rows. |
| Business boundary | Business APIs and `/app` still exclude reassessment history, accumulated effect scores, recurrence history, follow-up creation history, and operational owner scoring. |

## Phase-47 SLA Action Recommendation Priority Calibration

SLA improvement action recommendations now use reassessment history to calibrate recommended priority and explanation.

| Area | Implementation |
|---|---|
| History scoring | Generated SLA action candidates read `sla_action_reassessment_history.json` and calculate history-based effect score by root issue, assignee, and month. |
| Priority calibration | Effective history can raise candidate priority, while weak or recurring history can lower candidate priority within the current SLA severity floor. |
| Recommendation reason | Calibrated candidates append a history adjustment explanation with score, sample size, improvement rate, recurrence rate, and priority movement. |
| Admin API | Existing admin SLA action APIs return `historyAdjustment` on generated and merged action candidates for review and filtering. |
| Admin UI | SLA action cards show history score, boost/downgrade direction, original-to-adjusted priority, and evidence summary. |
| Business boundary | Business APIs and `/app` still exclude SLA action recommendation calibration, history scores, adjustment reasons, and operational owner evidence. |

## Phase-48 SLA Recommendation Adjustment Approval Workflow

History-based SLA action priority corrections now require admin approval before becoming active.

| Area | Implementation |
|---|---|
| Proposal file | `sla_action_recommendation_adjustments.json` stores proposed, approved, and rejected priority adjustment records with effect score, recurrence rate, reason text, and review metadata. |
| Proposed-only generation | Generated SLA action candidates can create proposed adjustments from reassessment history, but candidate priority and recommendation text stay unchanged until approval. |
| Active application | Only `approved` adjustments are applied to later SLA action recommendations; rejected or pending proposals remain visible as admin evidence without changing output. |
| Admin API | `GET /api/admin/master-db/sla-action-recommendation-adjustments` lists proposals with filters; `POST /api/admin/master-db/sla-action-recommendation-adjustments/review` approves or rejects a proposal. |
| Admin UI | The DB console includes an approval panel showing before/after priority, effect score, recurrence rate, recommendation text changes, and approval/rejection history. |
| Business boundary | Business APIs and `/app` still exclude proposal status, approval history, effect scores, recurrence rates, calibration reasons, and SLA recommendation adjustment evidence. |

## Phase-49 SLA Recommendation Auto-Approval Policy

Low-risk SLA recommendation adjustment proposals can now be approved automatically, while medium/high-risk proposals remain in the admin review queue.

| Area | Implementation |
|---|---|
| Policy criteria | Auto approval checks sample size, history effect score, recurrence rate, improvement rate, priority movement, impact scope, and past approval success rate for the same issue/direction. |
| Low-risk approval | Owner-scoped, one-step priority corrections with enough evidence are saved directly as `approved` with `approvalMode: "auto"` and active priority. |
| Manual fallback | Broad-impact, low-sample, weak-evidence, or poor historical approval proposals stay `proposed` with auto policy reasons for admin review. |
| Audit log | `sla_action_recommendation_auto_approval_logs.json` stores auto-approved and rollback events with policy decisions, event actor, event time, and rollback state. |
| Rollback API | `POST /api/admin/master-db/sla-action-recommendation-adjustments/rollback` converts rollback-available auto approvals to rejected state and records a rollback audit event. |
| Admin UI | The adjustment console separates auto-approval criteria, manual review items, auto-approved history, and manual decisions/rollbacks. |
| Business boundary | Business APIs and `/app` still exclude auto approval settings, policy criteria, audit logs, rollback history, and recommendation adjustment evidence. |

## Phase-50 SLA Auto-Approval Performance Tracking

Auto-approved SLA recommendation adjustments now have an admin-only performance report connected to later reassessment history.

| Area | Implementation |
|---|---|
| Performance API | `GET /api/admin/master-db/sla-action-recommendation-auto-approval-performance` joins auto-approved adjustments, auto approval logs, and `sla_action_reassessment_history.json`. |
| Outcome logic | Each auto approval is marked pending, successful, mixed, false-positive, or rolled-back using linked reassessment effect score, improvement state, recurrence, follow-up-needed, and rollback logs. |
| Aggregates | The report calculates success rate, rollback rate, recurrence rate, false-positive rate, and average effect score by month, issue/root metric, and assignee. |
| Policy candidates | Admin-only policy adjustment candidates flag issue segments that should be tightened, kept, or monitored based on false positives, recurrence, rollback, and pending follow-up rates. |
| Admin UI | The DB console includes a performance panel with filters, KPI summary cards, policy adjustment candidates, aggregate tables, and recent auto approval rows. |
| Business boundary | Business APIs and `/app` still exclude auto approval outcomes, policy performance, rollback rates, false-positive rates, operational SLA metrics, and policy adjustment candidates. |

## Phase-51 SLA Auto-Approval Policy Adjustment Review

Auto-approval performance candidates now flow into a governed policy-adjustment approval workflow.

| Area | Implementation |
|---|---|
| Proposal file | `sla_auto_approval_policy_adjustments.json` stores proposed, approved, and rejected policy adjustments with target issue, policy patch, before/after criteria, expected impact, and review metadata. |
| Candidate promotion | Refreshing the auto-approval performance report converts policy candidates into deterministic `proposed` adjustment records without auto-applying them. |
| Active policy | Only `approved` policy adjustments are merged into the active SLA recommendation auto-approval policy used by future adjustment proposals. |
| Review API | `GET /api/admin/master-db/sla-auto-approval-policy-adjustments` lists policy proposals and approval history; `POST /api/admin/master-db/sla-auto-approval-policy-adjustments/review` approves or rejects a proposal. |
| Impact comparison | Admin responses include the before/after auto-approval criteria, expected success-rate change, affected scope, source metrics, and active policy version. |
| Admin UI | The DB console includes a policy review panel with status/type/target filters, summary cards, review queue, approval history, and approve/reject controls. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy settings, policy patches, expected impact math, review status, and approval history. |

## Phase-52 SLA Policy Post-Change Effectiveness

Approved auto-approval policy adjustments now have an admin-only post-change effectiveness report.

| Area | Implementation |
|---|---|
| Effectiveness API | `GET /api/admin/master-db/sla-auto-approval-policy-effectiveness` compares approved policy adjustments against before/after proposal and auto-approval performance windows. |
| Metrics | The report tracks auto-approval success rate, false-positive rate, rollback rate, recurrence rate, average effect score, and manual-review conversion rate. |
| Scope matching | Issue-level policy changes compare only matching `issueKey`/`rootMetric`, while monitoring-window changes compare the broader policy population. |
| Effect score | Each policy adjustment receives an effect score and outcome (`pending`, `improved`, `unchanged`, `worse`) based on metric deltas and the policy type. |
| Suggestions | Admin responses include rollback, partial relaxation, additional tightening, or more-evidence suggestions depending on post-change results. |
| Admin UI | The DB console includes a post-change effectiveness panel with filters, summary cards, before/after metric comparison, and suggestion cards. |
| Business boundary | Business APIs and `/app` still exclude policy effectiveness, rollback suggestions, manual-review conversion, policy adjustment ids, and operational quality outcomes. |

## Phase-53 SLA Policy Effect-Based Candidate Generation

Post-change policy effectiveness suggestions now feed back into the governed policy adjustment workflow.

| Area | Implementation |
|---|---|
| Candidate generation | The effectiveness report converts rollback, partial-relaxation, and additional-tightening suggestions into deterministic `proposed` policy adjustment records. |
| Rollback patches | Weak approved policy changes can generate `rollback_policy_adjustment` candidates that restore the prior issue/global auto-approval criteria. |
| Follow-up patches | Stable tighten policies can generate `partial_relaxation_policy` candidates, while recurring failures can generate `additional_tightening_policy` candidates. |
| Duplicate tracking | Generated candidates store `sourceContext`, source policy adjustment id, effect outcome/score, and duplicate status (`created`, `existing_proposed`, `existing_approved`, `existing_rejected`). |
| Admin API | Existing policy adjustment review APIs now surface effect-based candidates, and the effectiveness API returns generated candidates/proposals with provenance. |
| Admin UI | The policy review panel shows effect-based badges, source policy id, source suggestion type, effect score, and duplicate status before approve/reject. |
| Business boundary | Business APIs and `/app` still exclude effect-based policy candidates, source policy ids, duplicate status, policy patches, and review workflow metadata. |

## Phase-54 SLA Effect-Based Candidate Quality Tracking

Effect-based SLA policy candidates now have admin-only quality tracking connected to approval outcomes and later effectiveness.

| Area | Implementation |
|---|---|
| Quality join | Effect-based policy candidates are linked back to post-change effectiveness by `policyAdjustmentId`, source policy id, source outcome, and candidate type. |
| Candidate outcomes | The report separates pending review, rejected, pending effect, successful, neutral, and failed approved candidates. |
| Type aggregates | Candidate types now have total, proposed, approved, rejected, evaluated, approval rate, approved-success rate, and repeat-recommendation counts. |
| Rejection analysis | Rejected effect-based candidates are grouped by admin review reason so recurring rejection causes are visible. |
| Repeat recommendation | The report flags repeat recommendations when a rejected high-risk source remains unresolved or an approved candidate later produces weak/repeating policy effects. |
| Admin UI | The policy effectiveness panel includes candidate quality summary cards, type-level quality table, rejection reasons, and repeat-recommendation rows. |
| Business boundary | Business APIs and `/app` still exclude candidate quality, approval outcomes, rejection reasons, repeat recommendations, and operational policy metrics. |

## Phase-55 SLA Effect Candidate Quality Calibration

Effect-based SLA policy candidate generation now uses accumulated candidate quality as a learning signal before creating the next proposal.

| Area | Implementation |
|---|---|
| Learning basis | The effectiveness report calculates candidate-type quality before generating new effect-based policy candidates. |
| Priority calibration | Candidate types with strong approved-success and low repeat-recommendation rates are boosted one priority step, while weak success, high rejection, or high repeat-recommendation patterns are downgraded. |
| Recommendation reason | Generated candidates append a quality calibration explanation with previous success rate, repeat-recommendation rate, rejection count, top rejection reason, and priority movement. |
| Persistence | `sla_auto_approval_policy_adjustments.json` stores `qualityCalibration` on generated proposals so later review, duplicate detection, and audit flows retain the learning basis. |
| Admin UI | Policy proposal cards and post-change suggestion rows show the quality adjustment direction, previous quality metrics, and applied reason. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy settings, candidate quality calibration, approval history, rejection reasons, and operational quality metrics. |

## Phase-56 SLA Quality Calibration Review Workflow

Effect-based candidate quality calibration is now governed before it becomes active.

| Area | Implementation |
|---|---|
| Proposal file | `sla_policy_candidate_quality_calibrations.json` stores suggested quality calibrations, active calibrations, comparison simulations, review metadata, and event history. |
| Pre-approval simulation | Each calibration compares before/suggested/active priority, recommendation text, expected impact, and prior candidate quality metrics. |
| Active gating | Suggested quality calibrations no longer change generated policy candidates until an admin approves or overrides the calibration. Rejected calibrations remain inactive. |
| Override flow | Admins can approve the suggested priority, reject it, or override the active priority with a separate reason. Overrides are stored as active governed decisions. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-calibrations` lists calibration proposals, and `POST /api/admin/master-db/sla-policy-candidate-quality-calibrations/review` records approve/reject/override decisions. |
| Admin UI | The policy effectiveness panel now includes a quality calibration review section with before/after comparison, prior quality evidence, and review controls. |
| Business boundary | Business APIs and `/app` still exclude quality calibration proposals, approval status, override reasons, review events, and operational quality metrics. |

## Phase-57 SLA Quality Calibration Performance Tracking

Approved and overridden SLA quality calibrations now have admin-only performance tracking.

| Area | Implementation |
|---|---|
| Performance join | Active/reviewed quality calibrations are joined to their generated policy candidate, candidate approval status, and later post-change effectiveness. |
| Before/after comparison | The report compares previous candidate approval, rejection, post-success, repeat-recommendation, and override rates against the actual calibrated candidate outcomes. |
| Decision aggregates | Performance is grouped by calibration decision and by candidate type/direction/decision so well-matched and weak calibration patterns are visible. |
| Re-review candidates | Low-scoring active calibrations, rejected calibrated candidates, failed post-effect outcomes, and repeated recommendations automatically appear as re-review candidates. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-calibration-performance` returns the same admin-only performance report used by the effectiveness panel. |
| Admin UI | The policy effectiveness panel includes calibration performance summary cards, before/after comparison, decision table, strong/weak type summaries, and re-review candidates. |
| Business boundary | Business APIs and `/app` still exclude calibration performance, re-review candidates, candidate approval outcomes, post-change SLA effects, and operator quality metrics. |

## Phase-58 SLA Quality Calibration Re-Review Operations

Low-performing quality calibrations now flow into an admin operations queue.

| Area | Implementation |
|---|---|
| Queue file | `sla_policy_candidate_quality_rereviews.json` stores re-review owner, due date, status, memo, follow-up action type, performance score, and source performance snapshot. |
| Candidate promotion | Performance report re-review candidates are promoted into stable queue items unless already completed or dismissed. |
| Admin filters | Re-review queue rows can be filtered by status, owner, due state, and performance score from the policy effectiveness panel. |
| Inline updates | Admins can edit owner, due date, review status, memo, and follow-up action type directly in the queue. |
| Completion actions | Completed re-reviews can maintain active calibration, deactivate active calibration, or return the calibration to proposed state as a modification proposal. |
| Admin API | `GET/POST /api/admin/master-db/sla-policy-candidate-quality-rereviews` manages the admin-only re-review workflow. |
| Business boundary | Business APIs and `/app` still exclude calibration performance, re-review queue state, owners, due dates, operational memos, and follow-up actions. |

## Phase-59 SLA Quality Calibration Re-Review Audit Logs

SLA quality re-review queue changes now leave an admin-only audit trail.

| Area | Implementation |
|---|---|
| Audit log file | `sla_policy_candidate_quality_rereview_logs.json` stores before/after changes for status, owner, due date, memo, follow-up action type, completion result, actor, and timestamp. |
| Completion linkage | Completed re-reviews record whether the linked active calibration was maintained, deactivated, or returned to proposed state. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereviews` includes change history summaries, recent logs, linked calibration history, and filtered export URLs. |
| Exports | `format=csv` and `format=json` downloads include latest queue state plus change log counts, latest actor/time, changed field summary, and linked calibration event counts. |
| Admin UI | Re-review cards show audit summary, recent change history, active calibration linkage history, and export buttons. |
| Business boundary | Business APIs and `/app` still exclude re-review queue state, change history, active calibration linkage, operators, memos, and operational quality metrics. |

## Phase-60 SLA Quality Calibration Re-Review Operational Metrics

Re-review audit logs now roll up into admin-only operational quality metrics.

| Area | Implementation |
|---|---|
| Per-item metrics | Each re-review item receives processing hours, status transition count, reopen count, latest activity month, and linked active-calibration result. |
| Monthly rollup | `operationalQuality.monthly` aggregates total/completed items, average processing time, status changes, reopen rate, deactivate rate, and modified-proposal rate. |
| Owner performance | `operationalQuality.ownerPerformance` summarizes owner workload, completion rate, average processing time, reopen rate, and active-calibration outcomes. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereviews` returns the operational quality block and includes key metrics in CSV/JSON export rows. |
| Admin UI | The re-review panel shows operational quality cards plus monthly and owner performance tables; each card shows item-level operations metrics. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, audit logs, operator throughput, processing time, status transitions, and active-calibration operational outcomes. |

## Phase-61 SLA Quality Calibration Re-Review SLA Levels

Re-review operational metrics now include SLA thresholds and warning grades.

| Area | Implementation |
|---|---|
| SLA criteria | Average processing time, reopen rate, overdue incomplete items, owner completion rate, and unresolved active-calibration linkage are evaluated as normal/watch/risk. |
| Monthly badges | `operationalQuality.monthly` rows include `sla.level`, improvement items, overdue open counts, and unresolved active-link counts. |
| Owner badges | `operationalQuality.ownerPerformance` rows include owner-specific SLA badges, throughput warnings, reopen warnings, overdue open counts, and active-link warnings. |
| Exports | Re-review CSV/JSON rows include delayed-incomplete and active-calibration-link-unprocessed flags for admin audit review. |
| Admin UI | The re-review panel shows overall SLA, improvement items, monthly SLA badges, owner SLA badges, and row-level needs. |
| Business boundary | Business APIs and `/app` still exclude re-review SLA levels, warning criteria, owner throughput, overdue operational queues, and active-link failure details. |

## Phase-62 SLA Quality Calibration Re-Review Improvement Actions

Warning and risk SLA findings now become admin-only improvement action candidates.

| Area | Implementation |
|---|---|
| Action file | `sla_policy_candidate_quality_rereview_actions.json` stores saved action state, assignee, target date, priority, recommendation, and source SLA metrics. |
| Candidate generation | Summary, monthly, and owner SLA improvement items are converted into stable action candidates with root metric, recommended action, due date, and priority. |
| Admin API | `GET/POST /api/admin/master-db/sla-policy-candidate-quality-rereview-actions` lists generated/saved actions and persists reviewed action updates. |
| Admin UI | The re-review operations panel shows SLA action cards where admins can adjust priority, owner, target date, status, and recommendation text. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, SLA levels, action candidates, owners, target dates, and corrective action details. |

## Phase-63 SLA Quality Calibration Re-Review Action Queue

Saved re-review SLA improvement actions now operate as an admin-only queue.

| Area | Implementation |
|---|---|
| Queue filters | Saved actions can be filtered by status, assignee, due state, target date, priority, risk, and root metric/issue. |
| Queue summary | The action report separates overdue actions, this-week actions, high-risk/urgent actions, unassigned actions, and owner-level unresolved workload. |
| Completion snapshot | When an action is saved as `done`, the current re-review operational quality summary, matching month, and matching owner are stored on `completionQualitySnapshot`. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-actions` returns `operationQueue` with saved queue items and queue summaries. |
| Admin UI | The re-review panel includes action filters, saved-action queue summary cards, owner unresolved rows, and a queue table with completion snapshot status. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, SLA levels, improvement actions, operational quality, and completion snapshots. |

## Phase-64 SLA Quality Re-Review Action Reassessment

Completed re-review improvement actions now receive an admin-only post-completion effect review.

| Area | Implementation |
|---|---|
| Reassessment basis | Completed saved actions with `completionQualitySnapshot` are compared against the current re-review operational quality row for the same summary/month/owner scope. |
| Effect scoring | The report evaluates the action's root metric, SLA level movement, same-issue recurrence, and worsening signals to produce `effectScore`, outcome, recurrence, and follow-up need. |
| Follow-up action | Admins can create a new planned follow-up action from a weak reassessment; the follow-up stores `parentActionId`, `reassessmentId`, and the comparison evidence. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-reassessment` returns the post-completion report, and `POST /api/admin/master-db/sla-policy-candidate-quality-rereview-actions/follow-up` creates follow-ups. |
| Admin UI | The re-review action panel shows completed-action reassessment cards, before/current metric comparison, recurrence status, and follow-up creation controls. |
| Business boundary | Business APIs and `/app` still exclude re-review actions, operational quality, reassessment scores, recurrence reasons, and follow-up links. |

## Phase-65 SLA Quality Re-Review Action Reassessment History

Post-completion re-review action reassessments now persist as admin-only learning history.

| Area | Implementation |
|---|---|
| History file | `sla_policy_candidate_quality_rereview_action_reassessment_history.json` stores action id, reassessment id, effect score, outcome, recurrence, follow-up need, and follow-up creation linkage. |
| History write | The reassessment report upserts daily history rows for completed actions, and follow-up creation marks the latest source-action history row as follow-up-created. |
| Aggregates | History is grouped by month, assignee, and root issue/metric, with effective and weak action type summaries based on average effect score, improvement rate, recurrence rate, and worse rate. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-reassessment-history` returns filtered history rows and aggregates. |
| Admin UI | The re-review action reassessment panel shows history summary cards, effective/weak action type groups, assignee history, and recent history rows. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, action reassessment history, effect score history, recurrence history, and follow-up creation tracking. |

## Phase-66 SLA Quality Re-Review Action Recommendation Priority Calibration

Re-review improvement action candidates now use accumulated reassessment history to adjust recommendation priority.

| Area | Implementation |
|---|---|
| Learning basis | `sla_policy_candidate_quality_rereview_action_reassessment_history.json` is matched by root issue/metric, assignee, and month. |
| Priority calibration | High effect score with strong improvement and low recurrence can raise a generated action priority; weak score, high recurrence, high worse rate, or high follow-up-need rate can lower it. |
| Recommendation reason | Adjusted candidates append a history adjustment explanation with effect score, sample size, issue result, assignee result, month result, and priority movement. |
| Admin API | Existing re-review action reports return `historyAdjustment` on generated/saved action candidates for admin-only review. |
| Admin UI | Re-review action cards and queue rows show history score, boost/downgrade direction, original-to-adjusted priority, and evidence summary. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, action history, effect scores, recurrence evidence, SLA grades, and recommendation calibration reasons. |

## Phase-67 SLA Quality Re-Review Action Recommendation Approval Workflow

History-based re-review action recommendation corrections now require admin approval before becoming active.

| Area | Implementation |
|---|---|
| Proposal file | `sla_policy_candidate_quality_rereview_action_recommendation_adjustments.json` stores proposed, approved, and rejected priority correction records. |
| Proposed-only generation | Generated re-review action candidates can create proposed corrections from reassessment history, but priority and recommendation text remain unchanged until approval. |
| Active application | Only approved corrections apply `activePriority` and append approved history-adjustment reasoning to future re-review action recommendations. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-adjustments` lists proposals; `POST .../review` approves or rejects one. |
| Admin UI | The admin console shows proposal status, direction, before/after priority, effect score, recurrence rate, recommendation before/after, and approval/rejection history. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, recommendation adjustment proposals, approval history, effect scores, recurrence evidence, and calibration reasons. |

## Phase-68 SLA Quality Re-Review Action Recommendation Auto Approval

Low-risk re-review action recommendation corrections can now be auto-approved while broader or weaker proposals remain in manual review.

| Area | Implementation |
|---|---|
| Auto policy | `sla_rereview_action_rec_auto_approval_v1` checks sample size, effect score, recurrence rate, improvement rate, priority movement, impact scope, and historical approval success. |
| Low-risk gate | Only owner-scoped proposals with enough evidence and one-step-or-less priority movement can move directly to `approved`; month and summary scopes stay `proposed`. |
| Audit log | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_logs.json` records auto-approved adjustments, policy decision evidence, actor, timestamp, and rollback availability. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-adjustments` returns policy thresholds, auto-approval logs, manual-review counts, and rollback-ready counts. |
| Admin UI | The re-review action recommendation console separates manual review required, auto-approved history, and manual decisions, with policy threshold cards and auto/rollback badges. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policies, logs, review decisions, raw effect scores, recurrence evidence, and calibration formulas. |

## Phase-69 SLA Quality Re-Review Action Auto-Approval Performance

Auto-approved re-review action recommendation corrections now have an admin-only performance report.

| Area | Implementation |
|---|---|
| Linked outcome | Auto-approved re-review action adjustments are matched to later `sla_policy_candidate_quality_rereview_action_reassessment_history.json` rows by source key or issue plus assignee. |
| Performance metrics | The report calculates success rate, rollback rate, recurrence rate, false-positive rate, evaluated count, pending count, and average effect score. |
| Aggregates | Performance is grouped by approval month, root issue/metric, and assignee so weak or reliable auto-approval segments can be isolated. |
| Policy candidates | Risky segments generate tightening candidates; reliable segments generate relaxation candidates; high pending volume generates monitoring-window candidates. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-performance` returns the performance summary, aggregates, recent rows, and policy adjustment candidates. |
| Admin UI | The admin console includes a re-review action auto-approval performance panel with filters, KPI cards, grouped tables, recent auto approvals, and policy candidate cards. |
| Business boundary | Business APIs and `/app` still exclude auto-approval performance, rollback and false-positive rates, operational quality outcomes, and policy adjustment candidates. |

## Phase-70 SLA Quality Re-Review Auto-Approval Policy Review

Performance-generated re-review auto-approval policy candidates now move through an admin approval workflow before they change future decisions.

| Area | Implementation |
|---|---|
| Policy file | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_policy_adjustments.json` stores proposed, approved, and rejected policy adjustment records. |
| Proposed workflow | The performance report persists tightening, relaxation, and monitoring-window candidates as `proposed` instead of applying them automatically. |
| Active policy | Only approved policy adjustments are merged into the active re-review action auto-approval policy used by future recommendation auto-approval decisions. |
| Impact comparison | Each proposal stores before/after policy snapshots, expected success-rate impact, affected scope, metrics, and policy patch details. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-adjustments` lists workflow items; `POST .../review` approves or rejects one. |
| Admin UI | The re-review action auto-approval performance panel shows policy review queue, before/after thresholds, expected impact, patches, and approval history. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy thresholds, policy adjustment workflow, approval history, and expected impact formulas. |

## Phase-71 SLA Quality Re-Review Auto-Approval Policy Effectiveness

Approved re-review action auto-approval policy adjustments now have an admin-only post-change effectiveness report.

| Area | Implementation |
|---|---|
| Effectiveness API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effectiveness` compares approved policy adjustments against before/after re-review proposal and auto-approval outcome windows. |
| Compared metrics | Each policy adjustment compares auto-approval success rate, false-positive rate, rollback rate, recurrence rate, manual-review conversion, and average effect score. |
| Suggestions | The report flags rollback review, partial relaxation, additional recurrence tightening, or more evidence collection based on post-change performance. |
| Performance integration | The existing re-review auto-approval performance API now embeds `policyEffectiveness` so the admin console can review policy workflow and post-change effects together. |
| Admin UI | The re-review auto-approval performance panel includes a post-change policy effect section with KPI summary cards and policy-level rollback/follow-up suggestions. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy effectiveness, rollback suggestions, manual-review conversion, policy adjustment ids, review history, and operating-quality metrics. |

## Phase-72 SLA Quality Re-Review Effect-Based Policy Candidates

Post-change effectiveness suggestions for approved re-review auto-approval policy adjustments now create governed policy adjustment candidates.

| Area | Implementation |
|---|---|
| Candidate generation | Effectiveness suggestions create deterministic proposed policy adjustments for rollback, additional recurrence tightening, and partial relaxation. |
| Candidate types | `rollback_rereview_auto_policy_adjustment`, `additional_rereview_tightening`, and `partial_rereview_auto_policy_relaxation` map to concrete policy patches only after admin approval. |
| Duplicate tracking | Generated candidates use the source policy adjustment id plus suggestion type for stable ids and surface `created`, `existing_proposed`, `existing_approved`, or `existing_rejected`. |
| Workflow connection | The re-review auto-approval performance API now runs effect-based candidate generation before returning the policy review queue, so generated candidates appear in the same approve/reject workflow. |
| Admin UI | Policy cards show the post-change effect source, suggestion type, outcome, effect score, and duplicate status alongside the patch and review buttons. |
| Business boundary | Business APIs and `/app` still exclude effect-based policy candidates, automatic policy adjustment generation, duplicate status, review history, and operating-quality metrics. |

## Phase-73 SLA Quality Re-Review Effect Candidate Quality

Effect-based re-review auto-approval policy candidates now have an admin-only quality report that links review decisions to later outcomes.

| Area | Implementation |
|---|---|
| Candidate quality | Generated rollback, additional-tightening, and partial-relaxation candidates are tracked by review status, post-approval outcome, approval success, and repeat recommendation. |
| Outcome linkage | Approved candidates are matched to their own later post-change policy effectiveness row; improved outcomes are counted as successful, worse outcomes are counted as failed. |
| Rejection reasons | Rejected candidates are grouped by review reason so recurring administrator objections can be seen by candidate type. |
| Repeat signals | A candidate is marked repeat-recommended when the same candidate type is suggested again, a high-risk rejection still has weak source evidence, or an approved candidate later performs worse. |
| Admin UI | The re-review auto-approval post-change section now includes candidate-type quality cards, approval success rate, top rejection reason, and repeat recommendation rows. |
| Business boundary | Business APIs and `/app` still exclude effect candidate quality, approval outcomes, rejection reasons, repeat recommendations, policy ids, and operating-quality metrics. |

## Phase-74 SLA Quality Re-Review Effect Candidate Learning

Effect-based re-review auto-approval policy candidate quality now feeds back into the next generated candidate.

| Area | Implementation |
|---|---|
| Learning input | Candidate-type quality uses approval success rate, rejection rate, top rejection reason, and repeat recommendation rate from prior generated candidates. |
| Priority adjustment | Strong prior quality raises the next candidate priority by one level; weak prior quality or high repeat/rejection pressure lowers it by one level; mixed or missing history keeps the base priority. |
| Recommendation text | Generated candidate basis and recommendation text include the quality-learning reason so administrators can see why the priority changed. |
| Stored evidence | Each generated policy candidate stores `qualityLearningAdjustment` with previous quality metrics, priority before/after, direction, and reason. |
| Admin UI | Policy review cards display the applied learning direction, priority shift, previous success rate, repeat rate, rejection rate, and top rejection reason. |
| Business boundary | Business APIs and `/app` still exclude candidate learning, quality metrics, rejection reasons, policy ids, approval history, and operating-quality signals. |

## Phase-75 SLA Quality Re-Review Effect Candidate Learning Review

Effect-based candidate learning now has an approval workflow before it changes future policy candidate generation.

| Area | Implementation |
|---|---|
| Workflow file | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_policy_effect_quality_calibrations.json` stores proposed, approved, rejected, and overridden learning calibration records. |
| Simulation | Each proposal compares priority before, suggested priority after, active priority after, recommendation text, expected impact, and previous quality metrics before approval. |
| Active gate | Generated candidates may show suggested learning, but only `approved` or `overridden` active calibrations change candidate priority and recommendation text used by future generation. |
| Review actions | Admins can approve, reject, or override suggested priority changes; rejection and override reasons are appended to the calibration audit events. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-calibrations` lists filtered workflow items; `POST .../review` records approve, reject, or override decisions. |
| Admin UI | The re-review auto-approval performance panel now shows a quality learning review queue with before/suggested/active comparison, prior quality evidence, and approval history. |
| Business boundary | Business APIs and `/app` still exclude learning calibration proposals, approval decisions, override reasons, raw quality metrics, policy ids, and operating-quality signals. |

## Phase-76 SLA Quality Re-Review Effect Candidate Learning Performance

Approved, rejected, and overridden effect-quality learning decisions now have admin-only performance tracking.

| Area | Implementation |
|---|---|
| Decision performance | Each reviewed learning calibration compares before/after candidate approval rate, approved-success rate, repeat recommendation rate, rejection rate, and top rejection reason. |
| Score formula | Performance score rewards approval and approved-success improvement, penalizes repeat/rejection increases, and adds a small decision-type weight for approved or overridden active calibrations. |
| Re-review candidates | Active calibrations with weak performance automatically produce admin-only re-review candidates with owner, due date, priority, reason, and before/after evidence. |
| Admin API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-performance` returns the performance report; the existing policy effectiveness API embeds the same block. |
| Admin UI | The re-review auto-approval performance panel now shows quality-learning performance summary cards, decision/type tables, weak-active re-review candidates, and item-level before/after comparisons. |
| Business boundary | Business APIs and `/app` still exclude quality-learning performance, approval/override results, rejection reason changes, re-review candidates, and operating-quality metrics. |

## Phase-77 SLA Quality Re-Review Effect Learning Operations Queue

Weak active effect-quality learning decisions now move into a saved admin operations workflow.

| Area | Implementation |
|---|---|
| Queue file | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_policy_effect_quality_rereviews.json` stores owner, due date, status, memo, follow-up action, performance score, source snapshot, and completion linkage. |
| Candidate promotion | Weak-active items from the quality-learning performance report are upserted into the queue without exposing them to business users. |
| Admin API | `GET/POST /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-rereviews` lists and updates queue items. |
| Completion linkage | Completing an item can maintain the active learning calibration, deactivate it, or move it back to proposed modified review with an audit event on the calibration record. |
| Admin UI | The re-review action auto-approval panel now includes queue filters and editable cards for status, owner, due date, follow-up action, and memo. |
| Business boundary | Business APIs and `/app` still exclude quality-learning re-review queue state, owners, due dates, memos, follow-up actions, and active calibration linkage. |

## Phase-78 SLA Quality Re-Review Effect Learning Audit Logs

Effect-quality learning re-review queue changes now have a separate admin-only audit log.

| Area | Implementation |
|---|---|
| Log file | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_policy_effect_quality_rereview_logs.json` stores before/after changes for status, owner, due date, memo, follow-up action, and completion result. |
| Change capture | Updating a queue item appends an audit entry with changedBy, changedAt, event type, changed fields, completion result, and any active learning calibration linkage. |
| Admin API | The existing `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-rereviews` response now includes change history summaries, recent logs, linkage history, and CSV/JSON export URLs. |
| Exports | `format=csv` and `format=json` include the latest queue state plus change log count, latest change metadata, changed field summary, and active calibration linkage summary. |
| Admin UI | The re-review action auto-approval panel shows export buttons and item-level recent change/linkage history. |
| Business boundary | Business APIs and `/app` still exclude quality-learning re-review queue state, change logs, owners, due dates, memos, follow-up actions, and active calibration linkage. |

## Phase-79 SLA Quality Re-Review Effect Learning Operational Quality

Effect-quality learning re-review audit logs now feed an admin-only operational quality report.

| Area | Implementation |
|---|---|
| Item metrics | Each queue item calculates processing hours, status transition count, reopen count, latest activity month, and active learning linkage outcome from audit logs. |
| Aggregates | The queue response includes operational quality summary, monthly aggregates, owner performance, completion rate, reopen rate, deactivate rate, modified-proposal rate, and unresolved linkage counts. |
| Admin API | The existing effect-quality re-review queue API embeds `operationalQuality` and adds operational metric columns to CSV/JSON exports. |
| Admin UI | The re-review action auto-approval panel now shows operational quality cards, monthly performance rows, owner performance rows, and item-level operations summaries. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, audit logs, operational quality metrics, owner throughput, SLA warning details, and active learning linkage outcomes. |

## Phase-80 SLA Quality Re-Review Effect Learning SLA Warnings

Effect-quality learning re-review operational quality now exposes admin-only SLA criteria and warning levels.

| Area | Implementation |
|---|---|
| SLA criteria | Normal/watch/risk thresholds cover average processing hours, reopen rate, overdue incomplete items, owner completion rate, and unresolved active learning linkage. |
| Warning summary | The queue response includes `slaCriteria`, overall SLA level, monthly warning counts, owner warning counts, and attention-needed rows with the triggering metrics. |
| Admin API | `operationalQuality.summary`, `monthly`, and `ownerPerformance` now include `slaLevel`, `slaLabel`, `slaImprovementItems`, and `slaImprovementSummary`. |
| Admin UI | Monthly and owner performance tables now show SLA badges plus improvement-needed details for each warning row. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, audit logs, operational quality metrics, SLA criteria, warning levels, owner throughput, and active learning linkage outcomes. |

## Phase-81 SLA Quality Re-Review Effect Learning SLA Actions

Effect-quality learning re-review SLA warnings now generate admin-only improvement action candidates.

| Area | Implementation |
|---|---|
| Action file | `sla_policy_candidate_quality_rereview_action_recommendation_auto_approval_policy_effect_quality_rereview_sla_actions.json` stores saved actions separately from the general quality re-review action queue. |
| Candidate generation | Warning/risk rows from summary, monthly, and owner SLA metrics generate action candidates with root metric, recommendation, assignee, target date, priority, and risk level. |
| Admin API | `GET/POST /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-rereview-sla-actions` lists generated/saved actions and saves status changes. |
| Admin UI | The re-review action auto-approval panel shows generated/saved effect-quality SLA action cards and lets admins edit priority, assignee, target date, status, and recommendation text. |
| Business boundary | Business APIs and `/app` still exclude effect-quality re-review queues, audit logs, operational quality metrics, SLA grades, action candidates, saved actions, and corrective recommendations. |

## Phase-82 SLA Quality Re-Review Effect Learning SLA Action Queue

Saved effect-quality learning SLA improvement actions now behave like an admin operations queue.

| Area | Implementation |
|---|---|
| Queue API | The effect-quality SLA action API returns an `operationQueue` for saved actions with status, owner, due, target date, priority, risk, issue/root metric, month, and source-type filters. |
| Focus summary | Queue responses include delayed actions, this-week actions, and owner unresolved summaries so admins can triage the next operational work. |
| Completion snapshot | Done actions keep a `completionQualitySnapshot`; queue summaries count completed actions with snapshots and the admin UI exposes captured snapshot timing/evidence. |
| Admin UI | The re-review action auto-approval panel now includes SLA action filters plus delayed/this-week/owner-unresolved focus panels and snapshot visibility. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, change history, operational quality metrics, SLA grades, saved actions, queue focus, owners, due dates, and completion snapshots. |

## Phase-83 SLA Quality Re-Review Effect Learning SLA Action Reassessment

Completed effect-quality learning SLA improvement actions now have an admin-only post-completion reassessment.

| Area | Implementation |
|---|---|
| Reassessment API | `GET /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-rereview-sla-action-reassessment` compares completed saved actions with completion snapshots against current re-review operational quality. |
| Effect scoring | Each completed action receives `effectScore`, outcome, recurrence flag, follow-up-needed flag, metric delta, SLA movement, and suggested follow-up text. |
| Follow-up API | `POST /api/admin/master-db/sla-policy-candidate-quality-rereview-action-recommendation-auto-approval-policy-effect-quality-rereview-sla-actions/follow-up` creates a saved planned follow-up action in the same effect-quality SLA action file. |
| Admin UI | The re-review action auto-approval panel shows effect-quality SLA action reassessment rows and exposes follow-up creation for weak or recurring actions. |
| Business boundary | Business APIs and `/app` still exclude effect-quality re-review queues, operational quality, reassessment scores, recurrence reasons, follow-up links, and completion snapshots. |

## Phase-84 SLA Quality Re-Review Effect Learning SLA Action Reassessment History

Effect-quality learning SLA action reassessments now persist into an admin-only history file.

| Area | Implementation |
|---|---|
| History file | `effect_quality_rereview_sla_action_reassessment_history.json` stores completed action reassessment rows with effect score, outcome, recurrence, follow-up-needed, and follow-up-created linkage. |
| History write | The reassessment report and embedded admin performance report upsert history rows, keyed by action/date/outcome/score/recurrence/follow-up state. |
| History API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-reassessment-history` returns filtered history rows plus monthly, assignee, and root-metric aggregates. |
| Effect analysis | Admin aggregates identify effective and weak action types using average effect score, improvement rate, worse rate, recurrence rate, and follow-up creation rate. |
| Admin UI | The re-review action auto-approval panel now shows history summary cards, effective/weak effect-quality action types, assignee history, and recent history rows. |
| Business boundary | Business APIs and `/app` still exclude effect-quality reassessment history, accumulated effect scores, recurrence history, follow-up creation tracking, and operational quality metrics. |

## Phase-85 SLA Quality Re-Review Effect Learning SLA Action Recommendation Correction

Effect-quality learning SLA action candidates now use accumulated reassessment history to correct recommendation priority.

| Area | Implementation |
|---|---|
| History signal | `effect_quality_rereview_sla_action_reassessment_history.json` is read during effect-quality SLA action candidate generation. |
| Correction formula | The correction score weights matching root issue/action type 55%, assignee 25%, and target month 20%, then raises priority for high-effect/low-recurrence history or lowers priority for low-effect/high-recurrence history. |
| Recommendation reason | Each admin-only action candidate includes `historyAdjustment` with history effect score, sample size, direction, original/adjusted priority, issue/assignee/month stats, and calculation basis. |
| Admin UI | Effect-quality SLA action cards show the history-based score, correction direction, active status, priority movement, and recommendation reason. |
| Business boundary | Business APIs and `/app` still exclude reassessment history, effect scores, recommendation correction reasons, owner/month operational quality, and SLA action internals. |

## Phase-86 SLA Quality Re-Review Effect Learning SLA Action Recommendation Approval

Effect-quality learning SLA action priority corrections now require admin approval before becoming active.

| Area | Implementation |
|---|---|
| Adjustment file | `effect_quality_rereview_sla_action_recommendation_adjustments.json` stores proposed, approved, and rejected history-based priority corrections. |
| Proposal workflow | Effect-quality SLA action generation writes boost/downgrade corrections as `proposed` records without applying them immediately. |
| Active application | Only approved corrections are applied back to generated recommendations as active priority and recommendation text changes. |
| Admin API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-recommendation-adjustments` lists correction proposals, and `POST /api/admin/master-db/effect-quality-rereview-sla-action-recommendation-adjustments/review` approves or rejects them. |
| Admin UI | The effect-quality re-review SLA action panel shows correction proposals, before/after priority, effect score, recurrence rate, recommendation before/after, and approve/reject controls. |
| Business boundary | Business APIs and `/app` still exclude correction proposals, approval history, effect scores, recurrence evidence, review reasons, and operational quality metrics. |

## Phase-87 SLA Quality Re-Review Effect Learning SLA Action Auto Approval

Low-risk effect-quality learning SLA action priority corrections can now be auto-approved with a separate audit trail.

| Area | Implementation |
|---|---|
| Auto policy | `effect_quality_rereview_sla_action_rec_auto_approval_v1` checks minimum sample size, effect score, recurrence rate, improvement rate, impact scope, priority step, and historical approval success. |
| Auto approval | Low-risk owner-scoped corrections that satisfy the policy are saved as `approved`, `approvalMode=auto`, with `rollbackAvailable=true`; medium/high risk items remain `proposed`. |
| Audit log | `effect_quality_rereview_sla_action_recommendation_auto_approval_logs.json` stores automatic approval events, policy decisions, risk level, reason, actor, and rollback availability. |
| Admin API | The adjustment report returns `autoApprovalPolicy` and `autoApprovalLogs` alongside proposals, approved records, and manual review items. |
| Admin UI | The effect-quality SLA action panel separates manual review required, auto-approved history, and manual decisions while showing auto approval thresholds and log evidence. |
| Business boundary | Business APIs and `/app` still exclude auto approval policy, audit logs, review status, formulas, effect scores, recurrence evidence, and operational quality metrics. |

## Phase-88 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Performance

Effect-quality auto approvals now have an admin-only performance report tied to later reassessment history.

| Area | Implementation |
|---|---|
| Performance API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-performance` joins auto-approved correction records, auto approval logs, and `effect_quality_rereview_sla_action_reassessment_history.json`. |
| Outcome logic | Each auto approval is marked pending, successful, mixed, false-positive, or rolled-back using approval-after reassessment effect score, improvement state, recurrence, follow-up-needed, and rollback logs. |
| Aggregates | The report calculates auto approval success rate, rollback rate, recurrence rate, false-positive rate, and average effect score by month, root metric, and assignee. |
| Policy candidates | Weak segments produce tighten/monitoring candidates, while consistently strong segments produce cautious relaxation candidates for future policy review. |
| Admin UI | The effect-quality SLA action panel shows auto approval performance cards, aggregate tables, recent rows, and policy adjustment candidate cards. |
| Business boundary | Business APIs and `/app` still exclude effect-quality auto approval policy performance, logs, rollback/false-positive rates, policy candidates, and operational quality metrics. |

## Phase-89 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Workflow

Effect-quality auto-approval performance candidates now move through an admin approval workflow before changing future auto-approval decisions.

| Area | Implementation |
|---|---|
| Policy file | `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_adjustments.json` stores proposed, approved, and rejected policy adjustment records. |
| Candidate promotion | Refreshing the effect-quality auto-approval performance report converts generated policy candidates into deterministic `proposed` records without auto-applying them. |
| Active policy | Only approved policy adjustments are merged into the active `effect_quality_rereview_sla_action_rec_auto_approval_v1` policy used by future correction auto-approval decisions. |
| Review API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-adjustments` lists workflow items, and `POST .../review` approves or rejects one. |
| Impact comparison | Admin responses include before/after thresholds, expected success-rate change, affected scope, source metrics, and active policy version. |
| Admin UI | The effect-quality SLA action panel now shows a policy review queue, before/after comparison, approval history, and approve/reject controls. |
| Business boundary | Business APIs and `/app` still exclude effect-quality auto-approval policy settings, policy adjustment workflow, approval history, and expected impact formulas. |

## Phase-90 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effectiveness

Approved effect-quality auto-approval policy adjustments now have an admin-only post-change effectiveness report.

| Area | Implementation |
|---|---|
| Effectiveness API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effectiveness` compares approved policy adjustments against before/after effect-quality auto-approval outcome windows. |
| Compared metrics | Each policy adjustment compares auto-approval success rate, false-positive rate, rollback rate, recurrence rate, manual-review conversion, average effect score, and proposal volume. |
| Effect score | The score rewards success-rate/effect-score gains and penalizes false positives, rollbacks, recurrence, and inappropriate manual-review movement by policy type. |
| Suggestions | Weak post-change outcomes generate rollback or additional tightening suggestions; stable tightened policies can generate partial relaxation suggestions; pending rows ask for more evidence. |
| Performance integration | The effect-quality auto-approval performance API embeds `policyEffectiveness` so admins can review policy workflow and post-change effects together. |
| Admin UI | The effect-quality SLA action panel shows post-change effect cards with before/after metrics, effect score, rollback suggestions, and follow-up suggestions. |
| Business boundary | Business APIs and `/app` still exclude effect-quality policy effectiveness, rollback suggestions, manual-review conversion, policy adjustment ids, and post-change formulas. |

## Phase-91 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Workflow

Effect-quality policy effectiveness suggestions now create reviewable policy adjustment candidates instead of stopping at advisory text.

| Area | Implementation |
|---|---|
| Candidate generation | Weak approved policy outcomes generate rollback candidates, high recurrence generates additional tightening candidates, and stable tightened policy outcomes generate partial relaxation candidates. |
| Deterministic upsert | Each post-change suggestion uses a stable generated policy adjustment id, so repeated report refreshes return `existing_proposed` or `existing_approved/rejected` instead of duplicating rows. |
| Workflow connection | Generated candidates are saved to `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_adjustments.json` as `proposed` and flow through the existing approve/reject API. |
| Effect report annotation | Policy effectiveness suggestions now include generated proposal id, status, priority, target, and duplicate status for admin review. |
| Admin UI | The effect-quality policy cards show generated source, source policy adjustment, source suggestion, outcome, score, patch, and duplicate status. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policies, policy effectiveness, generated candidate workflow, approval history, and operating-quality formulas. |

## Phase-92 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality

Effect-quality post-effect policy candidates now have admin-only quality tracking after approve/reject decisions.

| Area | Implementation |
|---|---|
| Quality join | Phase-91 rollback, additional-tightening, and partial-relaxation candidates are linked to later post-change effectiveness by generated policy adjustment id. |
| Outcome logic | Approved candidates are marked successful, failed, neutral, or pending-effect from later policy effectiveness; rejected and proposed candidates stay separate. |
| Type aggregates | Candidate types are grouped by total, approved, rejected, evaluated, approval rate, approved-success rate, repeat recommendation count, and repeat recommendation rate. |
| Rejection reasons | Rejected phase-91 candidates are grouped by review reason so recurring administrator objections are visible by candidate type. |
| Repeat signals | Repeat is flagged when the same type is suggested again, a rejected high-risk source remains weak, or an approved candidate later performs worse. |
| Admin UI | The effect-quality policy effectiveness panel now shows candidate-type quality summary, approval success rate, top rejection reason, and repeat recommendation rows. |
| Business boundary | Business APIs and `/app` still exclude effect-quality candidate quality, approval outcomes, rejection reasons, repeat recommendations, policy ids, and operating-quality metrics. |

## Phase-93 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning

Effect-quality post-effect candidate quality now changes the next generated candidate priority and recommendation reason.

| Area | Implementation |
|---|---|
| Learning basis | The effectiveness report calculates prior phase-91 candidate quality before generating new rollback, additional-tightening, or partial-relaxation candidates. |
| Priority adjustment | Strong prior quality raises the next candidate priority by one level; weak approved-success, high repeat recommendation, or rejection pressure lowers it by one level. |
| Recommendation reason | Generated candidate basis and recommendation text include the history-based quality adjustment reason, including success rate, repeat rate, rejection rate, and top rejection reason. |
| Stored evidence | Each generated effect-quality policy candidate stores `qualityLearningAdjustment` with previous quality metrics, priority before/after, direction, and learning source. |
| Admin UI | Effect-quality policy cards show a quality-learning badge plus previous success, repeat, rejection, and top rejection evidence. |
| Business boundary | Business APIs and `/app` still exclude candidate quality learning, approval outcomes, rejection reasons, repeat recommendations, policy ids, and operating-quality metrics. |

## Phase-94 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Workflow

Effect-quality candidate quality learning is now reviewed before it becomes active.

| Area | Implementation |
|---|---|
| Workflow file | `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_effect_candidate_quality_calibrations.json` stores proposed, approved, rejected, and overridden learning records. |
| Pre-approval simulation | Each calibration compares before/suggested/active priority, recommendation text, expected impact, and prior candidate quality metrics. |
| Active-only application | Generated effect-quality candidates only receive priority/recommendation changes from approved or overridden learning records; proposed records remain advisory. |
| Review API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-calibrations` lists workflow items, and `POST .../review` approves, rejects, or overrides one. |
| Audit history | Review events store previous/next status, actor, time, reason, override priority, and override reason. |
| Admin UI | The effect-quality policy effectiveness panel shows learning proposals, comparison details, approve/reject/override controls, and approval history. |
| Business boundary | Business APIs and `/app` still exclude learning proposals, approval state, override reasons, candidate quality history, policy ids, and operating-quality metrics. |

## Phase-95 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Performance

Approved, rejected, and overridden effect-quality candidate learning decisions now have admin-only performance tracking.

| Area | Implementation |
|---|---|
| Decision performance | Each reviewed learning calibration compares before/after candidate approval rate, approved-success rate, repeat recommendation rate, rejection rate, and top rejection reason. |
| Scoring | Performance score starts from 50, rewards approval and approved-success improvement, penalizes repeat recommendation and rejection increases, and applies a small decision-type weight. |
| Re-review candidates | Active learning calibrations with weak post-decision performance automatically produce admin-only re-review candidates with owner, due date, priority, reason, and before/after evidence. |
| Admin API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-performance` returns the same admin-only performance report embedded in the effectiveness panel. |
| Admin UI | The effect-quality policy effectiveness panel now shows decision/type performance rows, weak-active re-review candidates, and item-level before/after comparison cards. |
| Business boundary | Business APIs and `/app` still exclude learning performance, approval/override results, rejection reason changes, re-review candidates, and operating-quality metrics. |

## Phase-96 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review Operations

Weak active effect-quality candidate learning decisions now become a saved admin-only re-review operations queue.

| Area | Implementation |
|---|---|
| Queue file | `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_effect_candidate_quality_learning_rereviews.json` stores owner, due date, status, memo, follow-up action, performance score, source snapshot, and completion linkage. |
| Candidate promotion | Weak-active items from the Phase-95 performance report are upserted into stable queue items unless already completed or dismissed. |
| Admin API | `GET/POST /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-rereviews` lists and updates the queue. |
| Completion linkage | Completed queue items can maintain active learning, deactivate active learning, or return the learning calibration to proposed status for modification. |
| Admin UI | The effect-quality policy effectiveness panel shows editable queue cards for status, owner, due date, follow-up action, and memo. |
| Business boundary | Business APIs and `/app` still exclude the re-review queue, owners, due dates, memos, active learning linkage, and operational workflow details. |

## Phase-97 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review Audit Logs

The effect-quality candidate learning re-review queue now keeps a separate admin-only audit log for queue changes.

| Area | Implementation |
|---|---|
| Audit log file | `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_effect_candidate_quality_learning_rereview_logs.json` stores created/updated/completed events with before/after status, owner, due date, memo, follow-up action type, completion result, actor, and timestamp. |
| Completion linkage | Completed re-review items also log the active learning calibration linkage result, so admins can see maintain/deactivate/return-to-proposed outcomes from the item history. |
| Admin API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-rereviews` reads the queue plus audit log file; `POST` writes the queue change and appends a file-based audit event. |
| Export | The same GET endpoint supports `format=csv` and `format=json`, including latest queue state plus change-history summary and linked calibration history. |
| Admin UI | Existing effect-quality re-review queue cards continue to show item-level change history and completion linkage from the new file-backed log. |
| Business boundary | Business APIs and `/app` still exclude the re-review queue, change history, owners, due dates, memos, follow-up action types, active learning linkage, and operational quality details. |

## Phase-98 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review Operational Quality

The effect-quality candidate learning re-review audit log now produces admin-only operational quality metrics.

| Area | Implementation |
|---|---|
| Processing metrics | Each re-review item derives processing hours, status transition count, reopen count, activity month, delayed-open state, and active-link unresolved state from queue timestamps plus file-backed audit logs. |
| Monthly quality | `operationalQuality.monthly` groups total, completed, average processing time, status changes, reopen rate, overdue open items, active-link open items, and maintain/deactivate/modified-proposal outcomes by activity month. |
| Owner quality | `operationalQuality.ownerPerformance` groups completion rate, average processing time, transition volume, reopen rate, delayed items, active-link unresolved items, and follow-up outcome mix by owner. |
| SLA warning | The admin report includes normal/watch/risk evaluation, warning counts, criteria, and formula notes for processing time, reopen rate, overdue open items, active-link unresolved items, and owner throughput. |
| Export | CSV/JSON exports include latest queue state plus processing hours, transition count, reopen count, activity month, delayed state, active-link unresolved state, and operational linkage result. |
| Admin UI | Existing effect-quality re-review queue UI renders the new operational quality cards and monthly/owner tables from `operationalQuality`. |
| Business boundary | Business APIs and `/app` still exclude the re-review queue, audit log, processing metrics, owner performance, operational quality, SLA warnings, and active learning linkage details. |

## Phase-99 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Warning Grades

The effect-quality candidate learning re-review operational quality report now has explicit SLA warning criteria and grades.

| Area | Implementation |
|---|---|
| SLA criteria | Normal/watch/risk thresholds cover average processing time, reopen rate, overdue incomplete items, owner completion rate, and active-link issue counts. |
| Link issue split | Active learning linkage is now separated into processed, failed, unprocessed, and total issue counts so failed linkage logs and missing linkage logs can be reviewed separately. |
| Warning grade | Summary, monthly rows, and owner rows expose `slaLevel`, `slaWarningGrade`, `slaWarningLabel`, `slaImprovementCount`, and `slaImprovementSummary`. |
| Admin UI | Monthly and owner operational quality tables show SLA badges, link issue/failed counts, and improvement-needed text beside each row. |
| Export | Queue CSV/JSON exports include per-item active-link failed and issue flags in addition to processing time, status transitions, and reopen counts. |
| Business boundary | Business APIs and `/app` still exclude re-review queue, audit log, operational quality, SLA grades, warning criteria, owner metrics, and active learning linkage details. |

## Phase-100 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Candidates

The effect-quality candidate learning re-review SLA warnings now create admin-only improvement action candidates.

| Area | Implementation |
|---|---|
| SLA candidate generation | Warning/risk rows from summary, monthly, and owner operational quality generate action candidates with the `effect_candidate_quality_learning_rereview_sla` source key prefix. |
| Objective fields | Each candidate includes root metric, recommendation, assignee, target date, priority, risk/SLA level, source metrics, and history-based priority adjustment. |
| Saved workflow | The existing effect-quality re-review SLA action file/API is reused, and saved actions merge back with generated candidates by `sourceKey`. |
| Admin UI | Existing effect-quality SLA action cards render candidates under operational quality with priority, assignee, target date, status, and recommendation controls. |
| Business boundary | Business APIs and `/app` still exclude re-review queue, SLA grades, operational metrics, action candidates, saved action states, and source metrics. |

## Phase-101 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Operations Queue

Saved effect-quality candidate learning re-review SLA actions now have a dedicated admin-only operations queue.

| Area | Implementation |
|---|---|
| Queue API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-rereview-sla-actions` returns saved queue actions by status, owner, due state, target date, priority, risk, issue/root metric, month, and source type. |
| Queue summaries | The report separates delayed actions, this-week actions, owner unresolved load, status counts, priority counts, risk counts, issue counts, and saved/completed snapshot counts. |
| Completion snapshot | When a Phase-100 action is saved as `done`, the action stores a `completionQualitySnapshot` from the effect-quality candidate learning re-review operational quality report. |
| Admin UI | The existing effect-quality learning SLA action panel now labels the saved action operations queue and keeps status/assignee/target/priority/risk/root-metric filters. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, action queue state, change history, SLA grades, operational quality metrics, improvement actions, and completion snapshots. |

## Phase-102 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Reassessment

Completed effect-quality candidate learning re-review SLA actions now have a post-completion reassessment report.

| Area | Implementation |
|---|---|
| Reassessment API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-rereview-sla-action-reassessment` compares completed action snapshots with current re-review operational quality. |
| Effect scoring | The report calculates metric delta, SLA level delta, effect score, improved/unchanged/worse outcome, recurrence, follow-up need, and follow-up reason. |
| Active-link metrics | Reassessment metrics now include `active_link_issue` and `active_link_failed`, so Phase-100 linkage warnings do not fall back to generic totals. |
| Follow-up workflow | The existing effect-quality SLA action follow-up endpoint now routes Phase-100 source actions to a dedicated follow-up creator and keeps parent/follow-up action linkage. |
| Admin UI | The existing effect-quality learning action panel shows completed-action reassessments and follow-up buttons from `postReassessment`. |
| Business boundary | Business APIs and `/app` still exclude re-review queues, operational quality, SLA grades, improvement actions, reassessment scores, recurrence reasons, and follow-up links. |

## Phase-103 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Reassessment History

Effect-quality candidate learning re-review SLA action reassessments now accumulate into scoped history data.

| Area | Implementation |
|---|---|
| History storage | Completed Phase-100/101 action reassessments are upserted into `effect_quality_rereview_sla_action_reassessment_history.json` with effect score, outcome, recurrence, follow-up need, and follow-up linkage. |
| Scoped history API | `GET /api/admin/master-db/effect-quality-rereview-sla-action-auto-approval-policy-effect-candidate-quality-learning-rereview-sla-action-reassessment-history` returns only `effect_candidate_quality_learning_rereview_sla` history rows. |
| Aggregates | The history report groups results by month, assignee, and root metric/issue, and highlights effective and weak action types. |
| Admin UI | The existing reassessment history block now shows monthly effect history, root-metric history, effective action types, weak action types, and assignee history. |
| Business boundary | Business APIs and `/app` still exclude reassessment history, effect scores, recurrence history, follow-up links, operational quality, and SLA grades. |

## Phase-104 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action History-Based Recommendation Priority

Effect-quality candidate learning re-review SLA action recommendations now use accumulated reassessment history to adjust recommendation priority and reasoning.

| Area | Implementation |
|---|---|
| Scoped learning | Phase-100 SLA action candidates only learn from reassessment history whose source key starts with `effect_candidate_quality_learning_rereview_sla`. |
| Priority correction | Historical issue/assignee/month results are weighted 55/25/20; strong history boosts recommendation ordering while weak or recurring history lowers ordering or adds caution. |
| Recommendation reason | Candidate recommendations now include a concise history-learning note with effect score, sample size, improved/worse rates, and recurrence rate. |
| Admin UI | Action cards show the history effect score, adjustment direction, workflow state, priority before/after, reasons, and the calculation basis. |
| Business boundary | Business APIs and `/app` still exclude reassessment history, recommendation correction basis, effect scores, recurrence evidence, operational quality, and SLA grades. |

## Phase-105 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Recommendation Approval Workflow

History-based recommendation priority corrections for effect-candidate learning re-review SLA actions now require explicit admin approval before becoming active.

| Area | Implementation |
|---|---|
| Manual workflow | Corrections whose source key starts with `effect_candidate_quality_learning_rereview_sla` are stored as `proposed` with `manualApprovalRequired` even when the auto-approval policy would otherwise allow them. |
| Active rule | Phase-105 corrections only change active recommendation priority after an admin approves them; old auto-approved rows for this source are not treated as active. |
| Impact comparison | Each proposal stores before/proposed/approved/rejected priority outcomes, recommendation text before/after, effect score, sample size, improvement/worse/recurrence/follow-up rates. |
| Admin UI | The effect-quality correction console shows manual-review badges, auto-held badges, impact comparison, card-level decision history, and an approval/rejection history table. |
| Business boundary | Business APIs and `/app` still exclude recommendation correction proposals, approval history, effect scores, recurrence evidence, review reasons, and operational quality metrics. |

## Phase-106 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Recommendation Auto Approval

Effect-candidate learning re-review SLA recommendation corrections now support risk-based automatic approval.

| Area | Implementation |
|---|---|
| Auto approval policy | Sample size, effect score, recurrence rate, impact scope, priority movement, and same-issue historical approval success determine whether a correction is low-risk. |
| Low-risk handling | Eligible low-risk corrections are saved as `approved`, `approvalMode=auto`, and `rollbackAvailable=true`, and become active in recommendation priority immediately. |
| Manual review handling | Medium/high-risk corrections stay `proposed` with `manualApprovalRequired=true` for admin approve/reject review. |
| Audit trail | Auto-approved corrections write an auto-approval log with policy criteria, risk level, decision reason, and rollback readiness. |
| Admin UI | The correction console separates manual review items, low-risk auto-approved history, approval/rejection history, policy thresholds, and rollback-ready status. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy, audit logs, approval history, rollback state, effect scores, recurrence evidence, and internal formulas. |

## Phase-107 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Auto Approval Performance

Auto-approved effect-candidate learning re-review SLA recommendation corrections now have a lightweight performance report tied to reassessment history.

| Area | Implementation |
|---|---|
| Outcome tracking | Approved `approvalMode=auto` corrections are matched to later reassessment history by source key, issue, owner, and evaluation time. |
| Metrics | The report calculates auto-approval success rate, rollback rate, recurrence rate, false-positive rate, evaluated count, pending count, and average effect score. |
| Aggregates | Performance is grouped by approval month, root metric/issue, and assignee so weak auto-approval patterns can be isolated. |
| Policy candidates | Risky issue groups create tightening candidates, strong issue groups create relaxation candidates, and pending-heavy groups create monitoring-window candidates. |
| Admin UI | The existing effect-quality SLA action console shows auto-approval performance, aggregate tables, outcome rows, auto-approval logs, and policy adjustment candidates. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy, audit logs, rollback state, false-positive tracking, recurrence evidence, effect scores, and policy candidates. |

## Phase-108 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Auto Approval Policy Adjustment Workflow

Performance-based auto-approval policy candidates from Phase-107 now enter an explicit admin approval workflow before changing active policy.

| Area | Implementation |
|---|---|
| Proposal storage | Phase-107 risky/strong/pending performance candidates are upserted into `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_adjustments.json` as `proposed` rows. |
| Impact review | Each proposal stores before/after auto-approval thresholds, policy patch, expected impact scope, current/expected success rate, false-positive rate, rollback rate, recurrence rate, and evaluation count. |
| Approval rule | Only `approved` policy adjustment rows are folded into `activeEffectQualityRereviewSlaActionRecommendationAutoApprovalPolicy`; proposed/rejected rows remain visible but inactive. |
| Admin UI | The effect-quality auto-approval performance block now shows the saved policy review queue, approve/reject controls, active policy version, applied patch count, impact comparison, and approval/rejection history. |
| Business boundary | Business APIs and `/app` still exclude auto-approval policy settings, policy adjustment workflow, approval history, false-positive tracking, recurrence evidence, rollback state, and operational quality metrics. |

## Phase-109 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Auto Approval Policy Post-Change Effect

Approved Phase-108 policy adjustments now carry a post-change effectiveness report inside the admin performance view.

| Area | Implementation |
|---|---|
| Before/after windows | Approved policy adjustments are evaluated with pre/post windows around `approvedAt`, scoped by target issue/root metric or global monitoring-window scope. |
| Metrics | The post-change report compares success rate, false-positive rate, rollback rate, recurrence rate, manual-review conversion rate, average effect score, proposal volume, auto approvals, and evaluated auto approvals. |
| Suggestions | Weak post-change outcomes create rollback or additional-tightening suggestions; stable tightening outcomes can create partial-relaxation suggestions. |
| Admin UI | The effect-quality auto-approval performance block now embeds post-change effect cards, summary deltas, rollback/follow-up suggestion counts, generated proposal links, and candidate quality learning panels. |
| Business boundary | Business APIs and `/app` still exclude policy effectiveness, policy adjustment IDs, rollback/additional-adjustment suggestions, manual-review conversion, effect scores, operational quality, and post-change formulas. |

## Phase-110 SLA Quality Re-Review Effect Learning SLA Action Auto Approval Policy Effect Candidate Quality Learning Re-Review SLA Action Auto Approval Policy Effect-Based Candidate Generation

Post-change rollback/additional-adjustment suggestions now become real policy adjustment proposals in the admin workflow.

| Area | Implementation |
|---|---|
| Candidate generation | Poor approved policies create rollback candidates, high recurrence creates additional-tightening candidates, and stable tightening can create partial-relaxation candidates from post-change effect suggestions. |
| Proposal storage | Effect-based candidates are upserted into `effect_quality_rereview_sla_action_recommendation_auto_approval_policy_adjustments.json` as `proposed` rows, preserving duplicate status and source policy linkage. |
| Admin workflow | Generated proposals appear in the existing effect-quality policy review queue with before/after policy comparison, expected impact, source effect basis, duplicate status, and approve/reject controls. |
| Suggestion linkage | Post-change effect cards show the generated proposal id, status, candidate type, duplicate status, and duplicate target when applicable. |
| Business boundary | Business APIs and `/app` still exclude generated policy proposals, rollback/additional-adjustment suggestions, policy ids, review workflow, effect scores, and operational quality metrics. |

## Phase-111 SLA v1.0 Product Lock

SLA, learning, recommendation, and auto-approval work is now closed as an admin-only internal quality management module.

| Area | Decision |
|---|---|
| Product role | SLA is not a customer-facing SaaS feature; it is an internal reliability guard that protects business reports, region cards, strategies, execution plans, and retrospectives. |
| Frozen scope | Keep the implemented queues, reassessment history, recommendation adjustment approval, auto-approval performance, policy review, post-change effectiveness, and effect-based proposal generation. |
| Allowed admin actions | Admins may view status, approve/reject existing proposals, review generated policy candidates, and roll back auto-approved adjustments when the existing workflow supports it. |
| Blocked expansion | Do not add more recursive SLA-on-SLA workflow layers after v1.0. New development must move to product structure, business report completion, data reliability, commercialization, and external connector phases. |
| Business boundary | `/api/business/*` and `/app` must not expose SLA actions, auto-approval policies/logs, policy workflows, rollback state, operational quality metrics, internal formulas, review reasons, or admin approval history. |
| Implementation guard | Business report projection strips internal quality keys before returning a response, and the admin performance response carries `internalQualityLock` metadata so the UI labels the module as locked. |

## Phase-112 Product Information Architecture

Development has moved from SLA expansion into product-structure cleanup.

| Surface | Product structure |
|---|---|
| Admin mode | Operator-facing groups are Company DB, Interest Collection/Review, Data Reliability, and Internal Quality Management. |
| Business mode | Customer-facing flow is Report, Region Card, Strategy Recommendations, Execution Plan, and Monthly Retrospective. |
| Server diagnostic | `/api/productization/diagnostic` now exposes `productInformationArchitecture` so product direction is visible from the API layer. |
| Admin UI | The master DB console shows an operator product map before detailed queues; SLA remains labeled as locked internal quality management. |
| Business UI | `/app` shows a concise product navigation bar and orders the main workflow around report, region card, strategy, operations, retrospective, and next-month planning. |
| SLA boundary | SLA v1.0 remains locked. No new recursive SLA workflow should be added in later phases. |

## Phase-113 Business Report Flow and Readability

The business report surface now reads as one product workflow instead of separate feature blocks.

| Area | Implementation |
|---|---|
| Product flow | `/app` adds section guidance so Report, Region Card, Strategy Recommendations, Execution Plan, Monthly Retrospective, and Next-Month Candidates connect in order. |
| Empty states | Customer-facing empty messages now explain which observations or actions unlock each section, without exposing admin source rows or SLA internals. |
| Card readability | Business cards, region cards, and section notes use stronger borders, subtle surface contrast, and theme-safe shadows for light and dark modes. |
| Long content | Product nav, operations filters, strategy/KPI chips, region keywords, experiment chips, next-plan checklist, and 30-day reservation detail areas can scroll horizontally instead of crushing content. |
| Reservation graph | 30-day reservation bars remain visible while the axis shows date labels at 7-day intervals; per-day values remain available through bar tooltips and detail rows. |
| SLA boundary | SLA v1.0 remains locked as internal quality management and is not extended or exposed to business users. |

## Phase-114 Admin Operator Flow and Readability

The admin console now reads as an operator workflow rather than a long collection of internal modules.

| Area | Implementation |
|---|---|
| Operator flow | `/admin` introduces a concise workflow note and four visible groups: Company DB, Interest Collection/Review, Data Reliability, and Internal Quality Management. |
| Visual order | Existing DOM IDs and API bindings remain unchanged, while CSS ordering presents the console as Company DB -> Interest Collection/Review -> Data Reliability -> locked Internal Quality. |
| Company DB | The master DB panel now explains company_id, verified profile, observations, change history, and strategy review as one operator task. |
| Interest review | Interest signal and job empty states explain how to create region/category/company keyword queues before external connectors are attached. |
| Data reliability | Company detail now shows a reliability summary for final confidence, automatic observations, verified change logs, and B2B visibility. |
| Internal quality | SLA v1.0 copy and major loading/empty states are labeled as locked admin-only quality management, with no new recursive SLA workflow added. |
| Business boundary | `/app` and `/api/business/*` must continue to hide SLA, auto-approval policy, review history, operational quality, and internal formula details. |

## Phase-115 Final Role Boundary Review

Product-structure cleanup is now closed with a final admin/business boundary pass.

| Area | Implementation |
|---|---|
| Business API guard | Business responses now pass through a recursive internal-key stripper that blocks exact internal keys and future internal-quality key patterns before returning report, region-card, and next-month candidate payloads. |
| Business response wording | Business `reportBoundaries` now use customer-safe wording for hidden data instead of naming internal formulas, review logs, auto-approval policies, or SLA workflows. |
| Business entry | `/app` labels the surface as business mode and clarifies that operator source values are not shown. |
| Admin entry | `/admin` keeps the operator workflow as Company DB, Interest Collection/Review, Data Reliability, and locked Internal Quality Management. |
| SLA lock | SLA v1.0 remains admin-only internal quality management; no recursive SLA expansion is allowed after the lock. |
| Audit rule | Admin-only source data, SLA v1.0, auto-approval policy, review history, operational quality metrics, and internal scoring formulas must stay out of `/api/business/*` and the visible `/app` experience. |

## Phase-116 Business Monthly Report Completion

The business surface now behaves like one monthly operating report rather than separate widgets.

| Area | Implementation |
|---|---|
| Monthly flow | `/app` adds a six-step monthly report status board: Report, Region Card, Strategy Recommendations, Execution Plan, Monthly Retrospective, and Next-Month Candidates. |
| Status language | Each step is labeled with customer-safe statuses: `신뢰 가능`, `검수 필요`, `데이터 부족`, or `불러오는 중`. |
| Section summaries | Strategy, execution plan, retrospective, and next-month candidate headers now include short status summaries so users keep context while scrolling. |
| Empty guidance | Empty states now explain which observations or user actions unlock the next section, without exposing admin source records or SLA internals. |
| Responsive UI | The monthly flow cards keep stable widths and horizontal scrolling on mobile so long status text does not crush the layout. |
| Boundary | SLA v1.0 remains locked as admin-only internal quality management and is not surfaced in business UI/API responses. |

## Phase-117 Business Report Section Productization

The monthly report flow now explains why each section is ready, weak, or waiting for data.

| Area | Implementation |
|---|---|
| Smooth navigation | Monthly flow cards link to their target sections with smooth scrolling and section scroll margins so sticky navigation does not hide content. |
| Section insight cards | Report, Region Card, Strategy Recommendations, Execution Plan, Monthly Retrospective, and Next-Month Candidates now show a shared insight panel with status, judgment basis, and recommended next action. |
| Decision language | Business UI explains causes in customer-safe terms such as observation count, confidence grade, region signal coverage, overdue items, KPI input rate, and duplicate next-month candidates. |
| Product connection | Section copy now reinforces the chain from report comparison to regional context, strategy cards, execution board, retrospective, and next-month plan candidates. |
| Responsive UI | Insight panels collapse to one column on mobile while monthly flow cards keep horizontal scrolling. |
| Boundary | Admin-only source data, SLA v1.0, auto-approval policy, review history, operational quality metrics, and internal formulas remain outside the business API and visible `/app` experience. |

## Phase-118 Business Report Visual Polish

The business report copy and status UI were tightened for a more production-ready SaaS feel.

| Area | Implementation |
|---|---|
| Shorter copy | Product navigation, section notes, monthly flow cards, and section insight messages now use shorter operating-language copy. |
| Badge contrast | Business status badges have stronger light/dark contrast, especially for `신뢰 가능`, `검수 필요`, and muted states. |
| Text wrapping | Monthly flow cards, section notes, and insight panels use safer Korean line wrapping and overflow handling so long text does not push layouts. |
| Interaction | Monthly flow cards now have hover/focus feedback while preserving smooth section navigation. |
| Mobile readability | Insight panels stay single-column on narrow screens and monthly flow cards keep horizontal scrolling. |
| Boundary | Admin-only source data and SLA v1.0 remain locked away from business UI/API responses. |

## Phase-119 Business Reliability Productization

The business report now explains confidence as a customer-facing product signal rather than a simple badge.

| Area | Implementation |
|---|---|
| Reliability model | Report, Region Card, Strategy Recommendations, Execution Plan, Monthly Retrospective, and Next-Month Candidates now derive a customer-safe reliability grade, basis summary, and missing-data list. |
| Monthly flow | Each monthly flow card shows the public status plus a compact reliability line so users can see whether the step is ready, needs review, or needs more data before opening it. |
| Section insight | Each section insight panel now includes three blocks: judgment basis, recommended next action, and data to strengthen. |
| Customer-safe wording | The business UI exposes only reliability grade, basis summary, and strengthening items. It does not expose raw source values, internal formulas, audit logs, or SLA/auto-approval details. |
| Responsive UI | Reliability lines and the new three-column insight detail wrap safely and collapse to one column on mobile. |
| Boundary | SLA v1.0 remains locked as admin-only internal quality management and stays out of business UI/API responses. |

## Phase-120 Business Reliability CTA Completion

The monthly business report now connects low-confidence states to concrete customer-safe actions.

| Area | Implementation |
|---|---|
| CTA mapping | Reliability needs are translated into public action buttons such as Fast Search Request, Detailed Search Request, Interest Collection Request, Lead-Time Observation Request, Execution Plan Save, KPI Input, and Next-Month Candidate Review. |
| Monthly flow | Steps that need data or review show compact CTA chips so users can see the next action before entering the section. |
| Section insight | Each insight panel now shows full CTA cards below the reliability basis, recommended action, and strengthening items. |
| Product boundary | CTA labels remain customer-facing and do not expose raw source data, internal formulas, SLA v1.0, audit logs, or auto-approval policy details. |
| Responsive UI | CTA chips scroll horizontally where needed, and full CTA cards use responsive columns for mobile and desktop. |

## Phase-121 Admin Data Reliability Strengthening

The product now begins the data reliability hardening phase with an admin-only diagnostic layer.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/data-reliability-audit` to inspect company_id quality, duplicate/merge candidates, automatic-vs-verified conflicts, confidence basis, and recommended operator actions. |
| Duplicate review | The audit groups likely duplicate companies by normalized name/region and lists per-company merge candidates with match reasons and scores. |
| Conflict review | Verified profile values are compared with automatic observations/master values for name, region, category, and room/site count. |
| ID quality | Each company receives a stable/needs_review/weak ID status based on company_id format, identity key, external ID availability, missing fields, and duplicate risk. |
| Admin UI | The operator console now includes a Data Reliability Check panel and each company detail includes the selected company’s quality grade, basis, conflicts, merge candidates, and recommended admin actions. |
| Business boundary | Business UI/API remain limited to public reliability grade, basis summary, and strengthening actions. Raw audit details, merge candidates, verified conflicts, and ID quality diagnostics stay admin-only. |

## Phase-160 External API Operation Guide and Handoff Close

The external API connection phase is closed as an admin-only v1.0 operation module with a documented real-connector handoff.

| Area | Implementation |
|---|---|
| Operation guide | Added `docs/external_api_operation_guide.md` with connector environment variables, execution modes, mock-to-real handoff, scheduler guardrails, and failure/retry handling. |
| Admin API | `GET /api/admin/master-db/external-connector-operation-v1-lock` now includes `operationGuide` and `realConnectorGuides` for Naver DataLab, Naver SearchAd, SNS mentions, and OTA exposure. |
| Admin UI | The external API lock card now shows the real connector handoff checklist with required environment variables, execution modes, and first validation conditions. |
| v1.0 boundary | External connector status, scheduler, audit logs, operation warnings, quality actions, auto-approval policy, candidate calibration, and re-review queues remain admin-only. |
| Business boundary | `/api/business/*` and `/app` must not expose raw provider responses, internal errors, quota state, schedules, audit logs, auto-approval policy, review history, re-review queues, or internal formulas. |
| Next rule | After this close, new work should move to production hardening, deployment readiness, tenant permissions, billing, onboarding, and real provider credential validation rather than more recursive operation-quality loops. |

## Phase-161 Final Product Stabilization QA

The pre-commercial stabilization phase now has an admin-only final QA gate.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/product-qa-checklist` to calculate launch readiness from master DB status, data reliability audit, onboarding, subscriptions, SLA lock, and external API lock. |
| QA checklist | The report checks admin/business entry flow, menu structure, empty/error state readiness, permission state, external API v1.0, SLA v1.0, data reliability, location cards, collection queues, and business report flow. |
| Fix items | Non-passing QA rows are returned as action items with severity, summary, recommended action, and target section links. |
| Admin UI | The admin console now includes a Launch QA panel above the operator menu with readiness summary, checklist rows, and fix items. |
| Business boundary | The QA report is admin-only. Business UI/API still expose only report data, public reliability grades, evidence summaries, and strengthening CTAs. |

## Phase-162 Deployment Readiness

The pre-commercial deployment phase adds an admin-only Render operation readiness gate before launch QA.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/deployment-readiness` to summarize Render/runtime readiness, environment variables, persistent data paths, backup/restore runbook, admin PIN state, external connector cutover, and post-deploy smoke tests. |
| Render baseline | Recommended build command is `npm install`, start command is `npm start`, Node version should be 20+, and production data should live on a Render Persistent Disk via `DATA_DIR`. |
| Environment variables | Runtime variables are tracked as configured/missing without exposing values: `NODE_ENV`, `PORT`, `HOST`, `APP_USER`, `APP_PIN`, `DATA_DIR`, `DB_DIR`, `OUTPUTS_DIR`, and `CONFIG_DIR`. |
| Connector variables | Naver Trend, Naver SearchAd, SNS mentions, and OTA exposure variables are grouped by connector and remain admin-only. Missing variables keep the connector in mock/validation mode. |
| Backup and restore | Before deployment, back up `DATA_DIR/db` and `DATA_DIR/config`. Restore by stopping the service, replacing those folders from backup, and restarting the Render service. |
| Mock to real | A connector moves from mock to real only after credentials are configured, one manual real run succeeds, normalized scores are verified, and quota/retry guards are set. |
| Smoke tests | The checklist covers `/api/health`, `/api/admin/master-db/status`, `/api/admin/master-db/product-qa-checklist`, `/api/business/companies`, a sample `/api/business/report`, and `/api/admin/master-db/external-connector-operation-v1-lock`. |
| Admin UI | Added a Deploy Readiness panel above Launch QA with readiness summary, deployment gates, path status, env groups, connector cutover checklist, and smoke tests. |
| Business boundary | Deployment readiness, runtime paths, env status, connector transition, runbook, smoke test status, and internal operation details are admin-only and stripped from business responses if accidentally attached. |

## Phase-163 Security Readiness

The pre-commercial security phase adds an admin-only authorization and exposure boundary gate.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/security-readiness` to summarize admin PIN state, operator identity, production auth guard, admin/business route boundary, sensitive response stripping, and pre-launch security actions. |
| Auth model | Current v1 uses Basic Auth with `APP_PIN` and `APP_USER`. In production/Render mode, non-public routes are blocked when `APP_PIN` is missing. |
| Route boundary | `/api/health` is the only public API. Admin operations stay under `/api/admin/master-db`; business APIs stay under `/api/business` and must return customer-safe summaries only. |
| Response guard | Added deployment/security readiness keys to the business strip guard so security reports, route checks, runbooks, auth boundary data, and blocked-key diagnostics are removed if accidentally attached to business payloads. |
| Admin UI | Added a Security Readiness panel above Deploy Readiness with security state, auth boundary, route samples, blocked-key examples, and business-allowed response shape. |
| Business boundary | `/app` and `/api/business/*` must not expose internal source data, operation logs, review history, auto-approval policy, internal formulas, deployment readiness, security readiness, auth diagnostics, or route boundary diagnostics. |
| Future hardening | Before paid multi-tenant rollout, replace shared PIN operation with tenant-aware business authentication, per-user operator accounts, and explicit audit trails. |

## Phase-164 Backup And Restore Readiness

The pre-commercial recovery phase adds an admin-only backup and restore rehearsal gate.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/backup-restore-readiness` to summarize backup target status, backup directory readiness, latest manual backup, restore preflight checks, rehearsal status, and business exposure boundary. |
| Manual backups | Added `POST /api/admin/master-db/backup-restore-backups` to create a file-based snapshot under `DATA_DIR/backups/<backupId>` and `GET /api/admin/master-db/backup-restore-backups` to list backup manifests. |
| Backup targets | Backups cover `DATA_DIR/db`, `DATA_DIR/config`, and optionally `DATA_DIR/outputs`. `db` and `config` are critical for restore readiness; `outputs` is useful but optional for large artifact-heavy deployments. |
| Restore preflight | The API generates restore preflight checks for selected/latest backup: backup selected, critical targets present, fresh current backup required, service stop/restart window, rehearsal recorded, and target paths checked. |
| Rehearsal status | Added `POST /api/admin/master-db/backup-restore-rehearsals` and `GET /api/admin/master-db/backup-restore-rehearsals` to store planned/in-progress/passed/failed/blocked rehearsal records in `backup_restore_rehearsals.json`. |
| Admin UI | Added a Backup & Restore panel above Security Readiness with manual backup creation, latest backups, target status, restore preflight, and rehearsal save form. |
| Safety boundary | Actual destructive restore is intentionally manual-only in v1.0. The app records readiness and rehearsal state, but does not overwrite `db`, `config`, or `outputs`. |
| Business boundary | Backup paths, backup manifests, rehearsal records, restore runbook, and recovery diagnostics are admin-only and added to the business response strip guard. |

## Phase-165 Deployment Smoke Tests

The post-deploy readiness phase adds an admin-only smoke test runner and execution history.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/deployment-smoke-tests` for smoke test history and latest results, plus `POST /api/admin/master-db/deployment-smoke-tests/run` to execute the full smoke suite. |
| Smoke suite | The run checks health, admin master DB status, security readiness, deployment readiness, backup/restore readiness, business company list, sample business report, and external API v1.0 lock. |
| Failure capture | Each step stores status, detail, failure reason, evidence summary, and duration. Failed steps are summarized in `failureReasons`. |
| File history | Smoke test runs are stored in `DATA_DIR/db/deployment_smoke_test_runs.json` with latest status and run history. |
| Business boundary | The sample business report step recursively checks for internal-key leakage. Smoke test history, failure reasons, operational logs, backup paths, security/deployment reports, and formulas are added to the business response strip guard. |
| Admin UI | Added a Smoke Tests panel above Backup & Restore with run button, latest checklist, latest summary, and recent run history. |

## Phase-166 Deployment Operation Alerts

The pre-commercial incident-response phase turns failed readiness signals into an admin-only action queue.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/deployment-operation-alerts` to generate and list operation alerts from smoke failures, backup/restore readiness gaps, security blocked gates, and deployment blocked gates. |
| Admin updates | Added `POST /api/admin/master-db/deployment-operation-alerts/:alertId` so operators can save status, priority, assignee, due date, and memo. |
| File queue | Alert records are stored in `DATA_DIR/db/deployment_operation_alert_queue.json`; generated candidates are merged with saved operator fields so assignments survive refreshes. |
| Alert sources | Smoke alerts use the latest failed smoke steps. Backup alerts use all non-passed backup/restore action items. Security and deployment alerts only use blocked gates. |
| Admin UI | Added an Operation Alerts panel below Smoke Tests with filters, summary cards, source evidence, recommended action, and inline save controls. |
| Business boundary | Operation alerts, failure reasons, backup paths, security/deployment diagnostics, internal logs, and formulas remain admin-only and are stripped from business-safe responses if accidentally attached. |

## Phase-167 Deployment Operation Alert Audit Logs

The pre-commercial incident-response queue now records operator changes as admin-only audit logs.

| Area | Implementation |
|---|---|
| File audit log | Added `DATA_DIR/db/deployment_operation_alert_logs.json` to store status, priority, assignee, due date, and memo changes with before/after values, changer, and timestamp. |
| Admin API | Added `GET /api/admin/master-db/deployment-operation-alert-logs` for filtered log inspection, while `GET /api/admin/master-db/deployment-operation-alerts` attaches recent change and resolution history to each alert. |
| Update logging | `POST /api/admin/master-db/deployment-operation-alerts/:alertId` now appends a log whenever tracked fields change. Resolved and dismissed status changes are classified as resolution events. |
| Admin UI | Operation Alert cards now show recent change history and a separate resolved/dismissed history section directly under each alert. |
| Boundary | Alert logs, change history, completion/dismissal history, failure reasons, backup paths, security/deployment diagnostics, and internal formulas remain admin-only and are registered in the business response strip guard. |

## Phase-168 Deployment Operation Response Quality

The pre-commercial incident-response audit log now powers admin-only response quality metrics.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/deployment-operation-alert-quality` to aggregate alert change logs by month and owner. |
| Metrics | The report calculates handled alert count, average processing time, late resolution rate, resolved/dismissed ratio, throughput rate, and reopen frequency. |
| Owner performance | The API returns `byAssignee` rows so administrators can compare owner workload, closure quality, lateness, dismissal ratio, and reopen rate. |
| Admin UI | The Operation Alerts panel now includes a Response Quality section with month filter, summary cards, and an owner performance table. |
| Boundary | Response quality metrics, owner performance, alert logs, internal readiness diagnostics, backup paths, and formulas stay under admin APIs only and are registered in the business strip guard. |

## Phase-169 Deployment Operation Quality Standards And Warnings

The response quality report now turns the phase-168 metrics into an admin-only operating standard with warning grades.

| Area | Implementation |
|---|---|
| Admin API | `GET /api/admin/master-db/deployment-operation-alert-quality` now returns `operationStandards`, `warningSummary`, row-level warning badge summaries, and improvement item counts. |
| Warning criteria | Average processing time, late resolution rate, dismissed ratio, reopen rate, and handled conversion rate are evaluated as normal/watch/risk against fixed operating thresholds. |
| Monthly view | The response includes month buckets with the same warning grade and improvement items so administrators can spot month-level operating quality deterioration. |
| Owner view | Owner rows now include warning badges and recommended improvement items, allowing reviewer workload and closure quality to be compared without reading raw audit logs first. |
| Admin UI | The Operation Alerts panel now shows operating warning level, improvement needed items, monthly warning badges, operating standards, and an expanded owner table. |
| Boundary | Operation quality warnings, standards, improvement items, internal logs, readiness diagnostics, backup paths, security/deployment checks, and formulas remain admin-only and are registered in the business strip guard. |

## Phase-170 Deployment Operation Quality Improvement Actions

Watch/risk response quality warnings now become admin-only improvement action candidates.

| Area | Implementation |
|---|---|
| Admin API | Added `GET /api/admin/master-db/deployment-operation-quality-actions` to generate action candidates from monthly and owner-level response quality warning issues. |
| Admin updates | Added `POST /api/admin/master-db/deployment-operation-quality-actions/:actionId` so operators can save status, assignee, due date, and memo. |
| File queue | Saved action state is stored in `DATA_DIR/db/deployment_operation_quality_actions.json`; generated candidates are merged with saved operator fields so review work survives refreshes. |
| Candidate logic | Risk warnings become high-priority actions with shorter default due dates; watch warnings become medium-priority actions. Each action keeps root metric, risk level, source month, scope, source snapshot, and recommended action. |
| Admin UI | The Operation Alerts panel now includes a quality improvement action section with filters, summary cards, overdue/this-week/owner focus rows, and editable action cards. |
| Business boundary | Quality action queues, warning grades, operation alerts, change logs, readiness diagnostics, backup paths, security/deployment checks, and internal formulas remain admin-only and are registered in the business strip guard. |

## Phase-171 Deployment Operation Quality Action Queue

Saved quality improvement actions now behave as a clearer admin-only operating queue.

| Area | Implementation |
|---|---|
| Admin API | `GET /api/admin/master-db/deployment-operation-quality-actions` now returns `operationalQueue` and `queueSections` for saved action workload, active actions, completed/dismissed actions, and unsaved candidates. |
| Queue summary | The operating queue summarizes saved count, active count, completed count, late actions, this-week actions, high-risk active actions, completion snapshots, owner unresolved workload, and root-metric unresolved workload. |
| Completion snapshot | When an action is marked `done`, the saved item keeps a completion-time snapshot of response quality summary, warning summary, criteria, operating standards, source action metrics, and queue state. |
| Admin UI | The Operation Alerts quality action area now separates in-progress saved actions, completed/dismissed actions, and new warning candidates, with clearer late/this-week/owner/metric queue summaries. |
| Boundary | Operating queue data, completion snapshots, quality warnings, operation alerts, change logs, readiness diagnostics, backup paths, security/deployment checks, and internal formulas remain admin-only. |

## Phase-172 Deployment Operation Quality Action Reassessment

Completed operation quality improvement actions now have an admin-only post-completion reassessment report.

| Area | Implementation |
|---|---|
| Reassessment API | Added `GET /api/admin/master-db/deployment-operation-quality-action-reassessment` to compare each completed action's `completionQualitySnapshot` with the latest monthly/owner response quality metrics. |
| Effect logic | Each reassessment returns outcome, effect score, recurrence, current-data-missing state, metric delta, follow-up-needed flag, and recommended follow-up action. |
| Follow-up API | Added `POST /api/admin/master-db/deployment-operation-quality-action-reassessment/:actionId/follow-up` to create a saved follow-up action without recursively reassessing follow-up actions as source actions. |
| Admin UI | The Operation Alerts quality action panel now shows post-completion summary cards, reassessment cards, and a follow-up creation button for weak/recurring completed actions. |
| Boundary | Reassessment reports, effect scores, completion snapshots, follow-up links, operation quality metrics, operation alerts, internal logs, backup paths, security/deployment checks, and formulas remain admin-only and are registered in the business strip guard. |

## Phase-173 Deployment Operation Quality Reassessment History

Operation alert response quality action reassessments now accumulate into admin-only history.

| Area | Implementation |
|---|---|
| History file | `deployment_operation_quality_action_reassessment_history.json` stores action id, source month, owner, root metric, effect score, outcome, recurrence, follow-up need, follow-up creation, and revision count. |
| History write | `GET /api/admin/master-db/deployment-operation-quality-action-reassessment` upserts current completed-action reassessment rows by action/month/root-metric/completion date. |
| Follow-up linkage | `POST /api/admin/master-db/deployment-operation-quality-action-reassessment/:actionId/follow-up` marks the matching history row with `followUpCreated`, `followUpActionIds`, and follow-up creation time. |
| History API | Added `GET /api/admin/master-db/deployment-operation-quality-action-reassessment-history` with month, owner, root metric, outcome, follow-up filters plus monthly, assignee, and root-metric aggregates. |
| Admin UI | The Operation Alerts panel now includes reassessment history summary cards, effective/weak action type groups, owner/month effect groups, and recent history rows. |
| Boundary | Reassessment history, accumulated effect scores, recurrence history, follow-up creation history, response quality metrics, internal logs, backup paths, security/deployment checks, and formulas remain admin-only. |

## Phase-174 Deployment Operation Quality Action Recommendation Learning

Operation alert response quality improvement action candidates now use accumulated reassessment history to correct recommendation priority.

| Area | Implementation |
|---|---|
| History evidence | Candidate actions are matched against completed reassessment history by root metric, owner, and source month. Metric matches carry the most weight, with owner and month used as supporting evidence. |
| Priority correction | High-effect, low-recurrence history boosts or reinforces action priority. Weak, recurring, or worsening history lowers priority or adds a caution reason before repeating the same action type. |
| Admin API | `GET /api/admin/master-db/deployment-operation-quality-actions` now returns `recommendationLearning` and per-action `historyPriorityAdjustment` for administrator review. |
| Admin UI | The Operation Alerts quality action cards show history-adjusted badges, effect score, sample counts, recurrence rate, and recommendation correction basis. |
| Business boundary | Reassessment history, recommendation correction basis, effect scores, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas remain admin-only and are registered in the business strip guard. |

## Phase-175 Deployment Operation Quality Recommendation Approval Workflow

History-based operation alert action corrections now stay proposed until an administrator approves them.

| Area | Implementation |
|---|---|
| Proposal file | `deployment_operation_quality_recommendation_adjustments.json` stores generated correction proposals with before/after priority, effect score, recurrence rate, sample counts, proposed recommendation text, and decision history. |
| Active rule | Proposed corrections do not change action priority or recommendation text. Only `approved` and `active` corrections are applied back to `GET /api/admin/master-db/deployment-operation-quality-actions`. |
| Admin API | Added `GET /api/admin/master-db/deployment-operation-quality-recommendation-adjustments` and approve/reject POST endpoints for individual adjustment ids. |
| Admin UI | The Operation Alerts quality action panel now shows pending recommendation adjustments, impact comparison, review notes, approve/reject buttons, and approval/rejection history. |
| Business boundary | Recommendation adjustment workflow, approval/rejection history, effect scores, recurrence evidence, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas remain admin-only and are registered in the business strip guard. |

## Phase-176 Deployment Operation Quality Recommendation Auto Approval

Operation alert response quality recommendation corrections now use an admin-only low-risk auto approval policy.

| Area | Implementation |
|---|---|
| Auto approval policy | Low-risk corrections must pass sample size, effect score, recurrence, impact scope, priority movement, and historical approval success checks before automatic approval. |
| Manual review split | Medium/high-risk corrections, weak evidence, high recurrence, broad impact scope, or downgrade/caution directions remain `proposed` for administrator approval or rejection. |
| Audit trail | Auto-approved corrections write `deployment_operation_quality_recommendation_auto_approval_logs.json` with policy decision, risk level, reason, actor, event time, and rollback-ready state. |
| Active preservation | Saved operation quality actions keep active auto-approved priority and recommendation corrections when an admin later edits status, assignee, due date, or memo. |
| Admin UI | The Operation Alerts quality action panel separates auto approval criteria, manual review items, low-risk auto-approved history, audit logs, and manual decision history. |
| Business boundary | Business APIs and `/app` continue to hide auto approval policy, audit logs, review status, rollback readiness, effect scores, recurrence evidence, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-177 Deployment Operation Quality Auto Approval Performance

Auto-approved operation alert recommendation corrections now have an admin-only performance report tied to later action reassessment history.

| Area | Implementation |
|---|---|
| Performance API | Added `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-performance` to join auto-approved correction records, auto-approval logs, and `deployment_operation_quality_action_reassessment_history.json`. |
| Outcome logic | Each auto approval is classified as pending, successful, mixed, false-positive, or rolled-back using linked reassessment effect score, improvement state, recurrence, follow-up-needed, and rollback logs. |
| Aggregates | The report calculates auto-approval success rate, rollback rate, recurrence rate, false-positive rate, evaluated count, pending count, and average effect score by month, root metric, and assignee. |
| Policy candidates | Admin-only policy adjustment candidates flag root metrics or assignee scopes that should be tightened, maintained, relaxed, or monitored based on false positives, recurrence, rollback, and missing reassessment coverage. |
| Admin UI | The Operation Alerts quality panel now shows auto approval performance cards, grouped aggregate rows, policy adjustment candidates, and recent auto approval outcome rows. |
| Business boundary | Business APIs and `/app` continue to hide auto approval performance, policy candidates, rollback/false-positive rates, recurrence tracking, reassessment evidence, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-178 Deployment Operation Quality Auto Approval Policy Workflow

Operation alert auto-approval performance candidates now move through an admin-only approval workflow before affecting future automatic recommendation approvals.

| Area | Implementation |
|---|---|
| Policy proposal file | `deployment_operation_quality_recommendation_auto_approval_policy_adjustments.json` stores performance-based policy candidates as `proposed`, `approved`, or `rejected` records with policy patch, before/after policy snapshots, expected impact, review note, and decision history. |
| Admin APIs | Added `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-adjustments` plus approve/reject POST endpoints for individual policy adjustment ids. |
| Active policy | Only approved policy adjustments are folded into the active deployment operation recommendation auto-approval policy; proposed and rejected items remain audit history only. |
| Performance linkage | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-performance` now upserts policy candidates into the workflow and returns candidate proposals, workflow summary, active policy version, and admin-only impact comparisons. |
| Admin UI | The Operation Alerts auto-approval performance section now shows proposed policy candidates, before/after threshold comparison, expected impact, review notes, approve/reject buttons, and approval/rejection history. |
| Business boundary | Business APIs and `/app` continue to hide auto-approval policy settings, policy proposal workflow, approval history, expected impact, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-179 Deployment Operation Quality Auto Approval Policy Post-Effect

Approved operation-alert auto-approval policy changes now have an admin-only post-effect report.

| Area | Implementation |
|---|---|
| Post-effect API | Added `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effects` to compare each approved policy adjustment's before/after auto-approval outcomes. |
| Before/after metrics | The report compares success rate, false-positive rate, rollback rate, recurrence rate, manual-review transition rate, volume, and average effect score around the policy approval timestamp. |
| Effect scoring | Each approved policy adjustment is classified as pending, improved, stable, or worse and receives an effect score based on risk change and success change. |
| Admin suggestions | Weak or worsening policy effects surface rollback or additional-tightening suggestions; stable policies surface a maintain recommendation. Suggestions remain display-only admin guidance at this phase. |
| Admin UI | The Operation Alerts auto-approval performance panel now shows approved policy post-effect cards, before/after comparison, effect score, evidence rows, and rollback/additional-adjustment suggestions. |
| Business boundary | Business APIs and `/app` continue to hide policy post-effect data, rollback/additional-adjustment suggestions, manual-review transition rates, false-positive/rollback rates, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-180 Deployment Operation Quality Post-Effect Candidate Generation

Operation alert auto-approval policy post-effect suggestions now create real admin-review policy proposals.

| Area | Implementation |
|---|---|
| Candidate generation | Post-effect suggestions are converted into policy adjustment candidates: weak approved policies create rollback proposals, high residual false-positive/rollback/recurrence creates additional-tightening proposals, and stable policies create maintain/relax proposals. |
| Proposal persistence | Generated candidates are upserted into `deployment_operation_quality_recommendation_auto_approval_policy_adjustments.json` as `proposed` unless an identical approved/rejected/proposed record already exists. |
| Duplicate visibility | Generated proposals carry `duplicateStatus` so administrators can see whether a post-effect suggestion created a new proposal or matched an existing workflow item. |
| Workflow connection | The auto-approval performance report now returns both generated post-effect proposals and the refreshed policy workflow, so administrators can approve/reject them through the existing Phase-178 controls. |
| Admin UI | The post-effect card shows generated policy candidates with status, duplicate state, candidate type, and id; the policy workflow section provides the approval/rejection form and impact comparison. |
| Business boundary | Business APIs and `/app` continue to hide post-effect proposals, policy workflow status, approval history, rollback/additional-tightening suggestions, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-181 Deployment Operation Quality Post-Effect Candidate Quality

Post-effect generated operation-alert policy candidates now have an admin-only quality report.

| Area | Implementation |
|---|---|
| Candidate quality API | The auto-approval performance and policy-effects reports now include `policyAdjustmentCandidateQuality`, derived from post-effect generated policy proposals and their later approved policy outcomes. |
| Quality outcomes | Candidates are classified as pending review, rejected, pending effect, successful, failed, or neutral based on approve/reject status and later post-effect result. |
| Type aggregation | Rollback, additional-tightening, and maintain/relax candidates are aggregated by candidate type with total, proposed, approved, rejected, evaluated, successful, failed, approval rate, approval success rate, repeat recommendation rate, and top rejection reasons. |
| Repeat detection | Repeated candidate generation for the same type/scope/source pattern is flagged so administrators can see whether the same policy issue keeps returning. |
| Admin UI | The Operation Alerts auto-approval performance panel now shows the candidate quality table and repeated recommendation list alongside policy workflow and post-effect cards. |
| Business boundary | Business APIs and `/app` continue to hide candidate quality, approval success, rejection reasons, repeat recommendation flags, post-effect outcomes, policy workflow state, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-182 Deployment Operation Quality Post-Effect Candidate Quality Learning

Operation-alert post-effect policy candidates now use accumulated candidate quality as a learning signal before the next generated proposal is shown to administrators.

| Area | Implementation |
|---|---|
| Learning basis | The policy-effects and auto-approval performance reports calculate existing candidate quality before generating new rollback, additional-tightening, or maintain/relax candidates. |
| Priority correction | Candidate types with strong approved-success and low repeat pressure are boosted one priority step, while weak success, high rejection, or high repeat recommendation lowers the next candidate priority. |
| Recommendation reason | Generated candidates append a history-based quality adjustment reason with prior success rate, repeat rate, rejection rate, and top rejection reason. |
| Stored evidence | Generated policy proposals persist `qualityCalibration` with previous quality metrics, priority before/after, direction, learning source, and simulation context. |
| Admin UI | Operation-alert policy cards and post-effect generated candidate rows show quality direction, previous success/repeat/history metrics, and the applied learning reason. |
| Business boundary | Business APIs and `/app` continue to hide candidate quality learning, approval success, rejection reasons, repeat recommendations, policy ids, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-183 Deployment Operation Quality Candidate Learning Review Workflow

Operation-alert candidate quality learning now requires administrator review before it changes future generated policy candidates.

| Area | Implementation |
|---|---|
| Workflow file | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_calibrations.json` stores proposed, approved, rejected, and overridden learning records. |
| Audit log | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_calibration_logs.json` records review decisions, reviewer, timestamp, status movement, review reason, and override reason. |
| Pre-approval simulation | Each calibration compares before/suggested/active priority, recommendation text, expected impact, and prior candidate quality metrics before approval. |
| Active-only application | Proposed learning remains advisory; only approved or overridden calibrations change the priority/recommendation of future operation-alert post-effect candidates. |
| Admin UI | The Operation Alerts auto-approval performance panel now includes a candidate quality calibration review section with approve, reject, and override controls. |
| Business boundary | Business APIs and `/app` continue to hide candidate quality calibration, approval status, override reason, review events, policy ids, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-184 Deployment Operation Quality Candidate Learning Performance Tracking

Operation-alert candidate quality calibration decisions now have admin-only performance tracking.

| Area | Implementation |
|---|---|
| Performance API | The policy-effects and auto-approval performance reports now include `policyAdjustmentQualityCalibrationPerformance`, and a dedicated admin endpoint returns the same performance report. |
| Before/after comparison | Approved, rejected, and overridden calibration decisions compare prior candidate approval rate, approval-success rate, repeat recommendation rate, rejection rate, and top rejection reason against current candidate quality. |
| Decision grouping | The report groups performance by decision type and candidate type so administrators can see whether approve/reject/override choices improved later recommendations. |
| Re-review candidates | Weak active calibrations automatically produce `reReviewCandidates` with owner, due date, priority, performance score, reason, and recommended action for the next operating workflow. |
| Admin UI | The Operation Alerts auto-approval performance panel now shows the calibration performance summary, decision table, item rows, and weak active re-review candidates. |
| Business boundary | Business APIs and `/app` continue to hide quality calibration performance, re-review candidates, approval and override decisions, rejection reasons, policy ids, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-185 Deployment Operation Quality Re-Review Operations Queue

Weak active operation-alert candidate quality calibrations now move into a persistent admin-only re-review queue.

| Area | Implementation |
|---|---|
| Queue file | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereviews.json` stores re-review items with owner, due date, status, memo, follow-up action, performance score, source calibration, and source snapshot. |
| Queue sync | The auto-approval performance report automatically upserts weak active re-review candidates into the queue while preserving completed or dismissed items. |
| Admin API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereviews` returns the filtered queue, and `POST /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereviews/:id` updates one item. |
| Completion linkage | Completed queue items can keep the active calibration, deactivate it, or move it back to proposed modification. Linked calibration changes are recorded through the existing candidate quality calibration log. |
| Admin UI | The Operation Alerts auto-approval performance panel now includes a re-review operations queue with status, owner, due state, score filters, inline edit fields, and save controls. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, owners, due dates, memos, follow-up actions, active calibration linkage, auto-approval policy, review history, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-186 Deployment Operation Quality Re-Review Audit Logs

Operation-alert candidate-quality re-review queue changes now persist as admin-only audit logs.

| Area | Implementation |
|---|---|
| Audit log file | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_logs.json` stores before/after status, owner, due date, memo, follow-up action, completion result, changer, timestamp, and linked calibration result. |
| Queue report enrichment | The re-review queue report now returns `changeHistorySummary`, recent `changeLogs`, `linkedCalibrationHistory`, filtered `exportUrls`, and `exportRows`. |
| Export support | `format=csv` and `format=json` exports include the latest queue state plus change history summary and active calibration linkage summary. |
| Admin UI | The Operation Alerts auto-approval performance panel shows export links, per-item change history, recent audit logs, and completion-to-calibration linkage. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, audit logs, active calibration linkage, auto-approval policy, review history, operational quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-187 Deployment Operation Quality Re-Review Operational Metrics

Operation-alert candidate-quality re-review audit logs now roll up into admin-only operational quality metrics.

| Area | Implementation |
|---|---|
| Per-item metrics | Each re-review item derives processing hours, status transition count, reopen count, activity month, delayed-open state, and active-calibration linkage outcome from queue timestamps plus file-backed audit logs. |
| Monthly quality | `operationalQuality.monthly` groups total, completed, completion rate, average processing time, status changes, reopen rate, overdue open items, active-link issues, deactivate rate, and modified-proposal rate by activity month. |
| Owner quality | `operationalQuality.ownerPerformance` groups owner throughput, completion rate, average processing time, transition volume, reopen rate, delayed items, active-link issues, and follow-up outcome mix. |
| Admin UI | The Operation Alerts auto-approval performance panel shows operational quality summary cards plus monthly and owner performance tables, and each queue card shows item-level operation metrics. |
| Export support | CSV/JSON exports include processing hours, status transitions, reopen count, activity month, delayed state, active-link unresolved/failed/issue flags, and operational linkage result. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, audit logs, owner throughput, processing time, status transitions, active-calibration linkage outcomes, operational quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-188 Deployment Operation Quality Re-Review Warning Grades

Operation-alert candidate-quality re-review operational metrics now expose explicit admin-only criteria and warning grades.

| Area | Implementation |
|---|---|
| Operation criteria | `operationCriteria` defines normal/warning/risk thresholds for average processing hours, reopen rate, overdue incomplete items, owner completion rate, and active-calibration link unresolved/failed counts. |
| Warning grades | Summary, monthly rows, and owner rows include `operationWarning`, `warningGrade`, `warningLabel`, and `warningSeverity` alongside the existing compatibility `sla` fields. |
| Warning summary | `operationWarningSummary` reports overall warning state, monthly warning counts, owner warning counts, and the monthly/owner rows that need attention. |
| Admin UI | The Operation Alerts auto-approval performance panel now labels these as operation warnings, shows warning badges in monthly and owner tables, and displays improvement-needed items beside each row. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, change history, operational quality metrics, operation criteria, warning grades, owner performance, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-189 Deployment Operation Quality Re-Review Warning Actions

Operation-alert candidate-quality re-review warning grades now feed an admin-only corrective action candidate workflow.

| Area | Implementation |
|---|---|
| Action generation | `operationWarning` rows with `warning` or `danger` severity generate action candidates by overall/month/owner scope and issue key. |
| Action storage | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_actions.json` stores saved candidate state, assignee, target date, priority, memo, recommendation, and completion snapshot. |
| Admin UI | The Operation Alerts auto-approval performance panel shows warning action candidates with status, priority, assignee, target date, memo, saved/generated state, and warning source metric. |
| Admin API | `POST /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-actions` saves or updates one warning action candidate and refreshes the re-review report. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, warning grades, operational quality metrics, improvement action candidates, assignees, target dates, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-190 Deployment Operation Quality Re-Review Action Queue

Saved operation-alert re-review warning actions now have a dedicated admin operating queue.

| Area | Implementation |
|---|---|
| Queue API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-queue` returns saved actions only, with status, assignee, due, target date, priority, risk, and root-metric filters. |
| Queue summary | The queue reports open, overdue, this-week, urgent, high-risk, unassigned, completed-with-snapshot counts, and owner unresolved rows. |
| Focus sections | API/UI expose delayed actions, this-week actions, and assignee unresolved workload as admin-only operational focus lists. |
| Admin UI | The Operation Alerts auto-approval performance panel now separates generated warning candidates from the saved action operation queue and refreshes queue filters from the admin panel. |
| Completion snapshot | Marking a saved action `done` continues to capture `completionQualitySnapshot` from current re-review operational quality for later reassessment. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, warning grades, saved action queues, completion snapshots, internal logs, backup paths, security/deployment checks, operating quality metrics, and formulas. |

## Phase-191 Deployment Operation Quality Re-Review Action Reassessment

Completed operation-alert re-review warning actions now have an admin-only post-completion reassessment report.

| Area | Implementation |
|---|---|
| Reassessment API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-reassessment` compares each completed saved action's `completionQualitySnapshot` with the latest re-review operational quality. |
| Effect scoring | The report calculates metric delta, improvement amount, warning-level movement, recurrence, current-data-missing state, effect score, and improved/stable/worse outcome. |
| Follow-up flow | `POST /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-reassessment/:actionId/follow-up` creates or returns a linked saved follow-up action in the same admin action queue. |
| Admin UI | The Operation Alerts auto-approval performance panel shows completed action reassessment cards with outcome, effect score, recurrence, follow-up need, and a follow-up creation button. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, change history, operational quality metrics, warning grades, reassessment results, completion snapshots, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-192 Deployment Operation Quality Re-Review Action Reassessment History

Post-completion reassessment results for deployment-operation re-review warning actions are now stored as cumulative admin-only history.

| Area | Implementation |
|---|---|
| History storage | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_action_reassessment_history.json` stores completed action reassessment results by stable `historyId`. |
| Stored fields | Each history row keeps action id, source key/type/label, evaluated month/date, assignee, root metric, baseline/current values, metric delta, effect score, outcome, recurrence, follow-up need, and follow-up creation state. |
| History API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-reassessment-history` returns filtered history rows and aggregates. |
| Aggregates | Admin reports summarize monthly, assignee, and root-metric performance, including effective and weak action-type lists. |
| Admin UI | The Operation Alerts auto-approval performance panel now shows accumulated reassessment history, effective/weak action types, assignee/month effect summaries, and recent history rows. |
| Business boundary | Business APIs and `/app` continue to hide reassessment history, operational quality metrics, warning grades, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-193 Deployment Operation Quality Re-Review Action Recommendation Learning

Operation-alert re-review warning action candidates now use accumulated reassessment history to adjust recommendation priority and explanation.

| Area | Implementation |
|---|---|
| History evidence | Action candidates are matched against completed re-review action history by issue/root metric, assignee, and month. Issue/root-metric history carries 55% of the weighted score, assignee 25%, and month 20%. |
| Priority correction | High-effect, low-recurrence history boosts priority. Weak, recurring, or worsening history lowers priority where risk allows, or adds a caution reason when the priority should stay unchanged. |
| Admin API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereviews` and the saved action queue now include admin-only `historyAdjustment` and `recommendationLearning` summaries. |
| Admin UI | Warning action cards and the saved action queue display history effect score, sample count, direction, recurrence basis, and the recommendation correction reason. |
| Business boundary | Business APIs and `/app` continue to hide action reassessment history, recommendation correction basis, effect scores, operational quality metrics, warning grades, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-194 Deployment Operation Quality Re-Review Action Recommendation Approval

History-based re-review action corrections now require admin approval before they affect active recommendations.

| Area | Implementation |
|---|---|
| Proposal storage | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_action_recommendation_adjustments.json` stores proposed, approved, and rejected correction rows separately from active action data. |
| Approval API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-adjustments` lists correction proposals, and `POST /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-adjustments/review` records approve/reject decisions. |
| Active rule | Proposed and rejected corrections are never applied to generated action priority or text. Only approved rows with `active: true` affect subsequent re-review improvement action recommendations. |
| Admin UI | The Operation Alerts auto-approval performance panel shows proposed correction cards, before/after priority, effect score, recurrence basis, proposed copy, and approval/rejection history. |
| Business boundary | Business APIs and `/app` continue to hide recommendation adjustment workflows, approval history, reassessment evidence, effect scores, operational quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-195 Deployment Operation Quality Re-Review Action Recommendation Auto Approval

Low-risk history-based re-review action corrections can now be approved automatically while medium/high-risk corrections remain proposed for admin review.

| Area | Implementation |
|---|---|
| Auto policy | `deployment_operation_quality_candidate_quality_rereview_action_rec_auto_approval_v1` checks sample size, history effect score, recurrence rate, improvement rate, priority movement, impact scope, and same-issue historical approval success. |
| Auto approval | Owner-scoped low-risk corrections that pass policy are saved as `approved`, `approvalMode=auto`, `active=true`, and `rollbackAvailable=true`; month/summary or weak-evidence corrections stay `proposed`. |
| Audit trail | Auto-approved rows write `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_action_recommendation_auto_approval_logs.json` with policy decision, reason, event actor/time, and rollback readiness. |
| Admin UI | The Operation Alerts auto-approval performance panel separates manual-review proposals, low-risk auto-approved history, auto-approval audit logs, and manual approval/rejection history. |
| Business boundary | Business APIs and `/app` continue to hide auto-approval policy, auto-approval logs, rollback state, approval history, reassessment evidence, effect scores, operational quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-196 Deployment Operation Quality Re-Review Action Recommendation Auto Approval Performance

Auto-approved re-review action corrections are now tracked against post-reassessment history before any policy adjustment is proposed.

| Area | Implementation |
|---|---|
| Performance API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-auto-approval-performance` returns admin-only auto-approval performance. |
| Evidence link | Approved auto corrections are matched with completed action reassessment history by action id, source key, root metric/issue, owner, and approval timing. |
| Metrics | The report aggregates success rate, rollback rate, recurrence rate, false-positive rate, evaluated count, and average effect score by month, root metric, and assignee. |
| Policy candidates | Risky segments generate tighten/monitor candidates, while stable high-success segments generate low-risk relaxation candidates for the next approval workflow. |
| Admin UI | The Operation Alerts auto-approval performance panel now shows auto-approval outcome cards, aggregate tables, and policy adjustment candidates inside the re-review action correction workflow. |
| Business boundary | Business APIs and `/app` continue to hide auto-approval performance, policy candidates, reassessment evidence, rollback/false-positive rates, operational quality metrics, logs, backup paths, security/deployment checks, and formulas. |

## Phase-197 Deployment Operation Quality Re-Review Action Recommendation Auto Approval Policy Workflow

Performance-based policy changes for deployment-operation re-review action recommendation auto-approval are now gated by an admin approval workflow.

| Area | Implementation |
|---|---|
| Proposal storage | `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereview_action_recommendation_auto_approval_policy_adjustments.json` stores generated policy adjustment candidates as `proposed`, plus approved/rejected decision history. |
| Admin API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-auto-approval-policy-adjustments` lists candidates, and `POST /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-auto-approval-policy-adjustments/review` records approve/reject decisions. |
| Active rule | Proposed and rejected policy changes never alter the auto-approval policy. Only approved active adjustments are folded into the policy used for future deployment-operation re-review action recommendation auto-approval. |
| Admin UI | The Operation Alerts auto-approval performance panel shows candidate list, before/after criteria, expected impact, expected success rate, and approval/rejection history. |
| Business boundary | Business APIs and `/app` continue to hide auto-approval policies, policy adjustment workflow, approval history, internal formulas, operational quality metrics, logs, backup paths, security/deployment checks, and raw evidence. |

## Phase-198 Deployment Operation Quality Re-Review Action Recommendation Auto Approval Policy Post-Effect

Approved re-review action recommendation auto-approval policy adjustments are now tracked after application before any later rollback or additional-adjustment workflow is introduced.

| Area | Implementation |
|---|---|
| Post-effect API | `GET /api/admin/master-db/deployment-operation-quality-recommendation-auto-approval-policy-effect-candidate-quality-rereview-action-recommendation-auto-approval-policy-effectiveness` returns approved policy post-effect rows. |
| Comparison metrics | Each approved policy adjustment compares before/after auto-approval success rate, false-positive rate, rollback rate, recurrence rate, manual-review transition rate, average effect score, and volume. |
| Suggestions | Weak or worsening post-effect outcomes surface admin-only rollback or additional-tightening suggestions; stable outcomes show maintain guidance. These suggestions are display-only in this phase. |
| Admin UI | The Operation Alerts auto-approval performance panel now embeds post-effect cards for the re-review action recommendation auto-approval policy workflow. |
| Business boundary | Business APIs and `/app` continue to hide policy effectiveness, rollback/additional-adjustment suggestions, manual-review conversion, false-positive/recurrence rates, operation quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-199 Deployment Operation Quality Post-Effect Policy Candidate Generation

Phase-198 post-effect suggestions now feed into the governed policy adjustment workflow instead of remaining advisory only.

| Area | Implementation |
|---|---|
| Candidate generation | Weak approved policies generate rollback candidates, residual recurrence/false-positive/rollback risk generates additional-tightening candidates, and stable policies generate maintain/partial-relaxation candidates. |
| Deterministic upsert | Each generated candidate uses the source approved policy id plus suggestion type and scope for a stable `policyAdjustmentId`, so repeated report refreshes show duplicate status instead of creating duplicate rows. |
| Admin workflow | Generated candidates are stored as `proposed` policy adjustments in the existing workflow and can be approved or rejected through the current admin review controls. |
| Admin evidence | Post-effect cards now surface generated proposal status, duplicate status, target, and basis; workflow cards show post-effect source context and review history. |
| Business boundary | Business APIs and `/app` continue to hide generated policy candidates, policy workflow status, approval/rejection history, rollback/additional-tightening suggestions, internal logs, backup paths, security/deployment checks, and internal formulas. |

## Phase-200 Deployment Operation Quality Post-Effect Candidate Quality

Phase-199 generated candidates now have quality tracking after approve/reject decisions.

| Area | Implementation |
|---|---|
| Quality link | Generated rollback, additional-tightening, and maintain/relax candidates are linked to their own later approved policy post-effect row when available. |
| Outcome states | Candidates are classified as `pending_review`, `rejected`, `pending_effect`, `successful`, `failed`, or `neutral` based on admin decision and later policy performance. |
| Type summary | Candidate quality is grouped by candidate type with approval rate, approved-success rate, rejection reasons, and repeat recommendation rate. |
| Repeat tracking | A candidate is flagged when the same type/scope appears again, a rejected high-risk source remains unresolved, or an approved candidate later performs worse. |
| Admin UI | The Operation Alerts re-review action auto-approval performance panel now shows a post-effect candidate quality summary table and repeat recommendation list. |
| Business boundary | Business APIs and `/app` continue to hide candidate quality, approval success, rejection reasons, repeat recommendation flags, policy workflow status, internal logs, backup paths, security/deployment checks, and internal formulas. |

## Phase-201 Deployment Operation Quality Post-Effect Candidate Quality Learning

Post-effect generated policy candidates now use prior candidate quality when the next candidate is created.

| Area | Implementation |
|---|---|
| Learning basis | Candidate type history is derived from approval rate, approved-success rate, rejection rate, repeat recommendation rate, and top rejection reason. |
| Priority correction | Strong history boosts the next candidate priority, while weak approval success, high repeat recommendation, or high rejection lowers it. |
| Candidate evidence | Generated candidates store `qualityCalibration` and `postEffectCandidateQualityLearning` with the applied direction, previous quality metrics, and recommendation reason. |
| Admin UI | Policy candidate cards and generated post-effect proposal rows show the quality learning reason plus previous approval, success, repeat, rejection, and history counts. |
| Business boundary | Business APIs and `/app` continue to hide quality learning, candidate calibration, previous quality metrics, approval/rejection history, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-202 Deployment Operation Quality Candidate Learning Approval Workflow

Candidate quality learning now runs through an admin approval workflow before it changes future generated candidates.

| Area | Implementation |
|---|---|
| Draft proposal | Post-effect generated candidates first create candidate quality calibration proposals with suggested priority, recommendation text, expected impact, and previous quality metrics. |
| Active boundary | Suggested learning is not applied to candidate priority or recommendation text until the calibration is approved or overridden by an administrator. |
| Admin review | The existing operation candidate quality calibration console supports approve, reject, and override decisions for these Phase-202 proposals. |
| Audit trail | Review status, reviewer, reason, override priority, and override reason are stored in the calibration file and calibration event log. |
| Admin UI | The operation-alert auto-approval performance panel now shows the calibration review workflow next to post-effect candidate quality. |
| Business boundary | Business APIs and `/app` continue to hide quality calibration workflow, review history, override reasons, previous quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-203 Deployment Operation Quality Candidate Learning Decision Performance

Operation-alert candidate quality calibration decisions now track whether approved, rejected, or overridden learning decisions improved later generated candidate outcomes.

| Area | Implementation |
|---|---|
| Performance link | Operation-alert auto-approval reports include `policyAdjustmentQualityCalibrationPerformance`, tying candidate quality calibration decisions to later candidate approval, approval success, repeat recommendation, rejection rate, and top rejection reason changes. |
| Before/after comparison | The report compares candidate approval rate, approval-success rate, repeat recommendation rate, rejection rate, and rejection reason before and after each calibration decision. |
| Decision analysis | Administrator summaries group results by decision type and show approval delta, success delta, repeat delta, rejection delta, and rejection reason change count. |
| Re-review generation | Low-performing active calibrations automatically create admin-only re-review candidates so weak active learning can be reviewed before it keeps shaping future candidate generation. |
| Admin UI | The Operation Alerts auto-approval performance panel displays decision performance cards, decision tables, top rejection reasons, item-level before/after evidence, and generated re-review candidates. |
| Business boundary | Business APIs and `/app` continue to hide calibration performance, re-review candidates, decision history, rejection reasons, operational quality metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Phase-204 Deployment Operation Quality Re-Review Operating Queue

Operation-alert candidate quality performance re-review candidates now resolve into a file-backed administrator operating queue.

| Area | Implementation |
|---|---|
| Queue sync | Direct calibration performance candidates and policy-adjustment quality calibration performance candidates are upserted into the same `deployment_operation_quality_recommendation_auto_approval_policy_effect_candidate_quality_rereviews.json` queue before the admin report returns. |
| Operating queue API | The re-review report now includes `operationQueue` with status, owner, due, performance score filters, summary counts, overdue focus, this-week focus, owner backlog, and completion-link pending items. |
| Editable fields | Each queue item keeps owner, due date, status, memo, follow-up action type, performance score, source snapshot, before/after deltas, change history, and linked calibration result in the file-backed queue. |
| Completion linkage | Completed items can keep active calibration, deactivate active calibration, or move calibration back to proposed modification; the linked result is recorded on the queue item and calibration event log. |
| Admin UI | The Operation Alerts auto-approval performance panel shows generated candidate sources, queue focus rows, editable queue cards, status/owner/due/score filters, and completion-link state. |
| Business boundary | Business APIs and `/app` continue to hide re-review queues, owners, due dates, memos, follow-up actions, completion linkage, auto-approval policy, review history, operating metrics, internal logs, backup paths, security/deployment checks, and formulas. |

## Role Boundary

| Role | May see | Must not see |
|---|---|---|
| Admin | Raw rows, downloads, crawl status, settings, confidence reasons, verification queue. | Nothing except secret plaintext values. |
| Operator | Collection, review queue, channel verification, DB edits. | Billing/admin user controls unless granted. |
| Business | Report KPIs, demand, reservation pace, price bands, channel gap, region card, recommendations. | API keys, raw errors, caches, file paths, crawler wording, admin logs, unfiltered confidence grades. |

## Next Engineering Steps

1. Add stable `company_id` generation and matching around Naver place ID, name, region, address, URL, and channel aliases.
2. Persist automatic observations separately from admin verified overrides.
3. Add admin DB list/detail screens for review, edit, merge, split, and B2B visibility.
4. Split collection modes:
   - fast search: broad metro/local category discovery.
   - detailed search: top competitors, target property, inventory, price, booking rate.
   - lead-time observation: repeated same property/date/product tracking.
   - OTA exposure: channel presence and URL matching.
5. Build the new business report surface on top of role-safe APIs.
# Stage 207 - Dependency and import boundary hardening

| Area | Result |
| --- | --- |
| Vulnerable dependency | Removed `xlsx@0.18.5`, whose only runtime use was crawler workbook output. |
| Replacement | Added the output-only `write-excel-file` adapter and explicit string typing to prevent formula creation. |
| Import route | Added administrator credentials, JSON/body limits, CSV/text extension and MIME checks, structural limits, formula rejection, and worker timeout. |
| Error boundary | Import and business runtime failures no longer return internal file paths, parser details, or stack information. |
| Regression coverage | Added XLSX ZIP/XML output checks, CSV guard tests, worker parsing checks, and production administrator-auth tests. |
| Runbook | See `docs/dependency_and_import_security.md` for limits, variables, residual risk, and the XLSX-import prohibition. |
# Stage 208 - Account, session, and tenant authorization

| Area | Result |
| --- | --- |
| Account model | Added named administrator/business accounts with scrypt password hashes and active/disabled state. |
| Session model | Added expiring HttpOnly/SameSite sessions, logout revocation, and password-change session revocation. |
| Tenant boundary | Business company lists, reads, and writes are constrained by the signed-in account's allowed `company_id` values. |
| Route boundary | Business sessions receive 403 from administrator APIs, output files, settings, collection, logs, SLA, and internal operation modules. |
| Password reset | Added generic self-service request, administrator one-time token issue, confirmation, expiry, and session revocation. |
| UI | Added login/logout flow and administrator account/company assignment console without exposing password hashes or session stores. |
| Compatibility | Existing PIN becomes a bootstrap administrator and Basic Auth remains a configurable migration bridge. |
| Regression coverage | Added account creation, tenant isolation, forbidden read/write, role boundary, expiry, logout, and reset tests. |
| Runbook | See `docs/account_session_tenant_security.md`. |

# Stage 209 - Authentication operations hardening

| Area | Result |
| --- | --- |
| Rate limiting | Added independent login and password-reset windows for account and hashed IP identities with persistent temporary locks. |
| Audit trail | Added sanitized administrator-only events for login, logout, password change, account/permission change, tenant denial, and lock release. |
| Session fixation | Successful login rotates the browser session and revokes the previously presented token. |
| Administrator protection | The final active administrator cannot be disabled or demoted, and the first persisted account must be an active administrator. |
| Session revocation | Disabling an account or changing its role, company scope, username, or password immediately revokes active sessions. |
| Admin operations | Added authentication summary cards, current policy display, active-lock release, and recent audit history to the account console. |
| Business boundary | Authentication audit, locks, policies, and security state remain outside `/api/business/*` and `/app`. |
| Regression coverage | Added lock/unlock, rate-limit, session rotation, final-admin protection, disabled-session revocation, audit sanitization, and role-boundary tests. |

# Stage 210 - Account invitation, activation, and reset delivery

| Area | Result |
| --- | --- |
| Invitation lifecycle | Added administrator-issued invitations with role and `company_id` scope, expiry, cancellation, reissue/supersession, single-use activation, and fail-closed consumption. |
| Token storage | Invitation and reset credentials are stored only as SHA-256 hashes; raw links are never written to account, invitation, delivery, or audit files. |
| Delivery adapter | Added mock and real generic-HTTP email providers with HTTPS credential diagnostics, timeout, rate-limit/auth/failure classification, and sanitized delivery logs. |
| Public activation | Added masked invitation inspection and one-time password setup from URL-fragment links without exposing other accounts or administrator security data. |
| Administrator operations | Added invite issuance, status summary, delivery state, reissue, cancellation, and mock-preview controls to the account console. |
| Stage 209 integration | Invitation delivery and activation use persistent account/IP rate limits, temporary locks, session revocation, and sanitized authentication audit events. |
| Deployment readiness | Added invitation/public-base/email provider variables and mock-to-real readiness to the administrator deployment checklist. |
| Business boundary | Business APIs and `/app` expose only the signed-in business session and owned companies; invitations, delivery logs, rate policies, audit events, and other accounts remain administrator-only. |
| Regression coverage | Added delivery-adapter classification, token non-persistence, single use, reissue/cancel invalidation, activation throttling, role denial, and tenant-isolation tests. |
| Runbook | Updated `docs/account_session_tenant_security.md` with files, routes, variables, cutover steps, and remaining provider constraints. |

# Stage 211 - Email delivery operational verification

| Area | Result |
| --- | --- |
| Provider receipt | Real provider responses now store sanitized provider delivery/message IDs, provider status, HTTP code, and completion time without persisting raw response bodies. |
| Duplicate prevention | Stable hashed idempotency keys and atomic in-flight/success checks suppress repeated delivery of the same target and one-time link. |
| Retry queue | HTTP 429, HTTP 5xx, timeout, and network failures create AES-256-GCM encrypted retry envelopes with capped attempts and exponential backoff. |
| Retry worker | Real mode atomically claims and executes due queue rows on a configurable interval; administrators can also run one row or the due queue manually. |
| Webhook intake | Added HMAC-SHA256 signature verification, optional timestamp tolerance, duplicate event suppression, matched provider-ID lookup, and delivered/bounced/complained/failed state updates. |
| Manual resend | Permanent failures and bounces can issue a fresh invitation/reset credential instead of replaying the old one-time link. |
| Administrator UI | Added delivery summaries, provider readiness diagnostics, provider IDs, recipient/status filters, queue state, retry controls, and fresh-link resend controls. |
| Business boundary | Delivery recipients, provider IDs/responses, errors, queue rows, webhook events, audit history, and operational controls remain unavailable to business sessions and `/app`. |
| Regression coverage | Added provider-ID extraction, idempotency, 429/503 queueing, encrypted-at-rest checks, forced retry, signed/duplicate webhook, manual resend, and administrator-route denial tests. |
| Runbook | Expanded `docs/account_session_tenant_security.md` with queue/webhook files, APIs, environment variables, cutover verification, and single-instance constraints. |

# Stage 213 - Session request security boundary

| Area | Result |
| --- | --- |
| CSRF | Added per-session HMAC CSRF tokens, same-origin session delivery, and automatic browser headers for all state-changing shared API calls. |
| Origin and Host | Added production Origin/effective-Host validation before state-changing route logic, with sanitized 403 responses and administrator-only audit events. |
| Proxy trust | Forwarded IP, host, and protocol headers are ignored unless the direct peer is inside the Render/private boundary or an explicit trusted proxy CIDR. |
| Public webhook | Kept the email provider webhook in a dedicated signed exception boundary using raw-body HMAC, timestamp tolerance, and duplicate protection. |
| Response headers | Applied CSP, production HSTS, `nosniff`, no-referrer, permissions, frame, opener, and resource isolation headers at the server response boundary. |
| Compatibility | Public login/invitation/reset entry points keep working with Origin validation; administrator MFA and business tenant checks remain after the request-integrity gate. |
| Regression coverage | Added missing-CSRF, cross-origin, spoofed-Host, trusted/untrusted proxy, signed-webhook, response-header, role, tenant, and MFA checks. |
| Business boundary | Business APIs and `/app` receive only a session CSRF token needed for writes; policies, proxy decisions, block logs, security readiness, and internal formulas remain administrator-only. |

# Stage 214 - Versioned security-key rotation

| Area | Result |
| --- | --- |
| Key ring | Added current/previous versioned key rings for CSRF HMAC, MFA encryption, email retry-queue encryption, and email webhook signatures. |
| Bounded compatibility | Previous-key verification is available only inside a validated ISO transition window with a configurable duration cap; all new writes use the current version. |
| Migration | Administrator apply re-encrypts MFA and retry-queue envelopes, fails closed on unreadable rows, activates the current version, and revokes all active sessions. |
| Administrator console | Added configuration booleans, version/transition state, impact counts, blockers, apply confirmation, and sanitized history without exposing key material. |
| Audit | Added file-backed rotation outcome history and authentication audit events with actor, version labels, affected counts, and error classification only. |
| Business boundary | Business routes and `/app` do not expose key configuration, transition state, security status, rotation history, internal records, or formulas. |
| Regression coverage | Added previous CSRF-window behavior, MFA re-encryption, queue re-encryption, previous webhook-window behavior, role denial, secret non-persistence, and post-rotation session rejection tests. |
| Runbook | Expanded `docs/account_session_tenant_security.md` with environment variables, dual-key deployment order, cutover checks, cleanup, and residual KMS constraints. |

# Stage 215 - Authentication security v1.0 lock

| Area | Result |
| --- | --- |
| Preflight | Added an administrator-only, non-destructive key-rotation dry-run with current/previous configuration, bounded-window, session, MFA, queue, unreadable-record, and webhook checks. |
| Evidence store | Extended `auth_key_rotation_history.json` with capped preflight and post-rotation smoke histories containing only versions, counts, statuses, and sanitized reasons. |
| Post-rotation smoke | Added login/session, MFA, CSRF, invitation storage, retry-envelope, webhook signature, and applied-version checks that do not create real credentials or provider events. |
| Administrator UI | The key-rotation console now follows preflight -> apply -> re-login -> security smoke -> previous-key removal and displays recovery guidance in the same panel. |
| Recovery | Added a fixed fail-safe procedure that preserves previous keys, pauses unsafe retries, verifies evidence, restores configuration first, and restores data only for confirmed unreadable envelopes. |
| Removal checklist | Added active-version, passing-smoke, current-only MFA/queue, provider cutover, previous-env removal, and transition-close gates. |
| v1.0 lock | Authentication security is locked at v1.0. Recursive quality/approval loops are prohibited without a concrete vulnerability, compliance requirement, provider migration, or incident. |
| Business boundary | Business APIs and `/app` hide key status, preflight, smoke evidence, recovery procedures, removal checklists, lock metadata, audit history, and internal formulas. |
| Regression coverage | Added dry-run persistence, role denial, session invalidation, re-login smoke, in-memory cryptographic round trips, evidence sanitization, and locked-scope assertions. |
| Runbook | Added `docs/auth_security_v1_operation_guide.md` and updated the account/session security guide. |

# Stage 216 - Commercial launch Go/No-Go gate

| Area | Result |
| --- | --- |
| Integrated gate | Combined product QA, deployment readiness, backup/restore, deployment smoke, external API v1.0, SLA v1.0, and authentication security v1.0 into one administrator report. |
| Automatic checks | Normalized existing module summaries into passed, warning, and blocked outcomes without copying raw source data or creating a new quality loop. |
| Manual evidence | Added five required operator confirmations with evidence references, final approver, approval time, and release note. |
| Decision persistence | Added `commercial_launch_gate_reviews.json` with capped manual approval/hold history and sanitized before/after snapshots. |
| Stale approval detection | Added a stable automatic-state fingerprint; any source-state change after approval changes the result to `review_required`. |
| Approval boundary | Approval is manual-only, blocked while automatic blockers or required evidence are missing, and treated as an MFA-sensitive administrator operation. |
| Business boundary | Added launch-gate keys and tokens to business response stripping and verified that business sessions cannot access the administrator APIs. |
| Non-recursive scope | Explicitly prohibited auto-approval, recursive quality management, SLA, recommendation, reassessment, and calibration extensions for the final gate. |
| Runbook | Added `docs/commercial_launch_gate_v1.md`. |
