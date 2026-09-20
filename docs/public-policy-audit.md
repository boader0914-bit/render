# STAYDATALAB public policy audit

Review date: 2026-09-20. Implementation baseline: `360ed3c8d443882511c6d7f786e78afaa160a401`. This audit separates actual implementation from policy commitments and unresolved operational facts. It does not certify legal compliance or deployment.

## Scope and routes

Policy content lives in `scripts/public_policy_content.cjs`; the server remains responsible for rendering, route access and document versioning. Covered document keys and existing routes:

| Key | Public routes |
| --- | --- |
| terms | `/terms` |
| privacy | `/privacy`, with `#required-consent` separating the signup collection notice |
| refund | `/refund`, `/refund-cancellation-policy` |
| collection | `/data-collection-notice` |
| quality | `/data-quality-notice`, `/external-platform-data-limit` |
| failure | `/collection-failure-notice` |
| retention | `/api-key-retention-policy` |
| disclaimer | `/report-disclaimer` |
| business | `/business-info` |
| dataSafety | `/google-play-data-safety` |

Also review login/signup footer copies and agreement labels, `/account-delete`, authenticated `/account-request`, and footer notices in `web/index.html`. A public Data Safety draft is rewritten as a description of actual web-service processing rather than an app-store submission checklist or certification claim.

## Verified implementation at the baseline

The line references below refer to the baseline before the root integration changes.

| Subject | Evidence | Policy consequence |
| --- | --- | --- |
| Signup status | `scripts/glamping_app_server.cjs:94-95`, `17540-17578` | Signup defaults to disabled. Render-time state must drive public text; do not imply an approval-only workflow. |
| Registration | Server `2301-2396`, `17565-17570` | Username/password/phone/email, required terms/privacy/age checks; company and ownership data optional. Enabled signup creates `active` member and logs in immediately. The profile's admin-review-pending field is not an authentication gate. |
| Password and session | Server `109`, `2130-2142`, `4034-4043`, `4091-4105`, `4149-4171` | PBKDF2-SHA256 for registered members; production HttpOnly/Secure/SameSite=Lax session cookie, 12-hour cookie, server-memory sessions and UA binding. No MFA/TOTP integration identified. Environment-provided admin/demo passwords are not evidence that all credentials are stored as PBKDF2. |
| Member policy | Server `98-102`, `2200-2216`, `3680-3727` | General member defaults: 2 searches/day and ranks 1-10; admin can change limits and enable 1-20. Internal/demo policies differ. Do not hard-code every account as unlimited or 20-rank enabled. |
| Consent/security data | Server `2352-2366`, `3874-3907` | Consent version/time, optional marketing consent; application records hashed IP/UA/session identifiers. Hashing does not establish anonymization or absence of raw infrastructure logs. |
| Deletion workflow | Server `3353-3422`, `3425-3456`, `17512-17532`, `17649-17658` | Public request submission and admin status changes only. No actual member/search-history purge, schedule-based personal-data purge or backups purge found. A completed status alone is not deletion evidence. |
| Persistent storage | Server `35-71`, `130-136`; `render.yaml:6` | Customer/member/history/interest/request JSON stores, collection files and company records on persistent data storage, plus optional master DB shadow write. Repository Render blueprint specifies Singapore; live region/backup processing require deployment evidence. |
| Browser storage | `web/app.js:2`, `2120-2131`, `2900-2938`, `10349-10441`, `12435-12456`; `web/sw.js:22-80` | Theme, 12-hour active-search state, account-keyed interest lodges; PWA pages/assets cached. Logout does not establish deletion of all browser-held account information. No advertising SDK identified. |
| Fonts | `web/index.html:16-17`; baseline server `4558`, `4786`, `5181-5184`; updated `web/public-site.css` | Baseline used jsDelivr Pretendard and SABUN MaruBuri. Updated login/signup/policy/request pages use same-origin bundled fonts. The authenticated analysis app still references jsDelivr; the privacy notice distinguishes these surfaces. |
| External requests | Server `8251-8258`, `8452-8467`; `scripts/gyeongnam_glamping_crawl.cjs:1144-1180`, `1333-1635`, `3138-3269`; `scripts/tourism_collector.cjs:7-49` | Naver keyword/date queries, public Place/Booking data, OTA queries, public tourism region statistics. No member password/contact payload was identified. A user-entered keyword itself can contain personal data. |
| Collection output | Crawler `1155-1161`, `4242-4249`, `4354`, `4449` | Public addresses, review counts, room/product/pricing/availability; raw detail JSON and CSV/XLSX/report/manifest evidence. No guest roster, individual booking transaction or card import from external reservation systems identified. |
| Current scheduled collection | `docs/daily-keyword-collection.md:3-11`; `scripts/daily_keyword_collection_scheduler.cjs`; `scripts/daily_collection_quality.cjs` | 13 keywords, daily 14:00 Asia/Seoul, sequential top-20 detail; failure/partial raw evidence retained and derived updates withheld. Rolling detail period is observation horizon, not retention period. |
| Payments and external AI | Runtime sources, `package.json` and `web` searched for payment/PG/LLM/TOTP integrations | No in-app billing, card storage, recurring charge or external LLM transmission identified. Static `DEMAND_AI_SIGNALS` and calculated AI-labelled scores in server `1769`, `8803`, `8979-9057` are not an external model call. Do not copy OPS AI or subscription provisions. |

## Reference sources checked by the reference-policy audit

- [SABUN public policy](https://www.sabun.co.kr/policy): business 사분 / brand 사분랩스, representative 최지혜, registration `515-13-21899`, mail-order registration `제2026-경남진주-0462호`, address `경남 진주시 도동로36번길 10`, contact `info@sabun.co.kr` / `070-4001-6668`, privacy officer 김정환. Root supplies these as escaped context values. Do not publish a personal birth date or duplicate the old `도동로3번길` address.
- Live OPS `/privacy.html` and `/terms.html` refer to a 2026-09-08.6 pre-operational review draft. Their 30-day-after-checkout rules, Gmail integration and reservation-processor roles do not establish STAYDATALAB behavior.
- [Render DPA](https://render.com/dpa), section 6.1: main processing activities in the United States. A Singapore instance is not evidence of Singapore-only processing. Provider contact from reference audit: `privacy@render.com`.
- [Render security and subprocessors](https://render.com/security): named providers are not proof that every provider receives every STAYDATALAB field or that every STAYDATALAB copy exists in a particular country.
- [Render persistent disks](https://render.com/docs/disks): disk snapshots are created every 24 hours and available for **at least** seven days; the documentation describes encryption for disk data and snapshots. This does not establish a seven-day maximum, that every copy is erased after seven days, or that the separately preserved archive follows snapshot retention.
- Korean Personal Information Protection Act Article 28-8: overseas transfer requires an applicable legal basis and the required information (items, countries/time/method, recipient/contact, purpose/period, refusal and consequences); a published policy does not replace separate consent when required. Reference agent verified the version effective 2026-09-11. This audit does not choose an unverified legal basis for existing users.
- Official law links checked by the reference audit: [Article 28-8 required information](https://law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1033215841), [Article 28-8 legal bases](https://law.go.kr/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029331979), [Enforcement Decree Article 31](https://www.law.go.kr/LSW/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=900079801). Saying an item is unconfirmed does not itself satisfy the complete-notice requirement.

## Remaining facts requiring operational confirmation

1. **Overseas transfer:** confirm Render contracting entity, actual processing countries for backups/support/subprocessors, retained-copy lifetime and applicable transfer basis for each processing purpose. Main storage Singapore plus the DPA's United States processing is the verified minimum, not a full mapping. The public draft explicitly states the limitation and must not be described as fully settled compliance.
2. **Retention and deletion:** choose and implement justified periods for account information, search history, security records, consent evidence and deletion requests. Do not invent 30/90/180-day deadlines. Establish who performs manual deletion, how linked records and browser copies are handled, what evidence proves completion, and how restoration avoids reintroducing deleted personal information. Current status updates do not perform deletion.
3. **Archive/backup scope:** the separately retained original-service archive is not proof of comprehensive backups or recovery capability. Verify which personal data it contains before promising deletion completion or a recovery guarantee. No archive mutation is part of this audit.
4. **Deletion-request privacy fix included:** baseline public requests looked up a member by submitted username and returned `accountDeleteRequestPublicRow`, including memberId, companyName and existing consent metadata (`3285-3306`, `3380-3422`). The root integration now returns only request ID, timestamp, request type/label and status/label from `createAccountDeleteRequest`; richer records remain behind the admin endpoint. The integration test verifies anonymous and different-account requests cannot receive the linked member ID, company name or consent metadata, and also checks the HTML receipt. All test accounts are temporary synthetic fixtures. This response restriction does not implement actual account deletion.
5. **Operational contacts and roles:** public SABUN details are verified public sources; confirm that the shared contact and privacy officer handle STAYDATALAB requests in practice. Do not invent monitoring hours or a response deadline.
6. **Marketing and existing consent:** optional marketing metadata exists; delivery integration was not found. New purpose/transfer requirements may need notice or fresh consent. Updating a version constant must not overwrite old consent evidence or falsely record acceptance.
7. **Billing:** no in-app payment code does not establish that no customer has a separate paid contract. Keep separate-contract terms conditional and do not rewrite private contracts.
8. **Current collection settings:** the 13-keyword 14:00 schedule describes the approved current rollout, not a permanent contractual SLA. Update the notice if the live schedule changes.
9. **Effective date:** a document revision date is not proof that users were notified or have accepted amended terms. Root owns publication/version/previous-document preservation.

## Wording deliberately removed or constrained

- Removed generic beta-only branding, placeholder "service administrator" contacts, unpublished business placeholders and the claim that overseas processing will be documented only after the environment is fixed.
- Removed blanket restrictions on refund after collection/download and blanket user-liability language. Preserved evidence limitations without excluding statutory rights or the operator's own responsibility.
- Kept required collection consent separate from the general privacy notice. Kept optional marketing consent distinct.
- Did not promise MFA, end-to-end encryption, encryption of API keys at rest, independent security certification, immediate account deletion, age-based automated purge, all-copy deletion within an invented deadline, or complete backups.
- Public text avoids local file paths, deployment commands, database filenames and development environment instructions.

## Validation

Ran `node --check scripts/public_policy_content.cjs` and a direct builder smoke check for all ten keys, nonempty sections, escaping of business context, the signup-enabled branch and the `required-consent` anchor; all passed.

Ran `node --check scripts/test_public_policy_pages.cjs` and `node scripts/test_public_policy_pages.cjs` against the real integrated HTTP server; both passed. The test uses two temporary data directories (signup enabled/disabled), random loopback ports, synthetic accounts, a child-process preload guard that rejects outbound HTTP/fetch/socket connections and crawler subprocesses, and explicit disabled collection schedulers. It verifies:

- GET/HEAD access for all ten policies and preserved prior documents, aliases, local CSS and fonts, plus denial of unknown/non-allowlisted paths.
- Login/signup/deletion form targets, required-privacy-consent anchor, required consent enforcement, new consent version, preserved old consent version and hashed member password.
- Existing admin and demo login, new member login, role redirects and protected admin endpoints, logout invalidation, and disabled-signup behavior.
- Minimal public deletion receipts for anonymous/different-account requests, private information remaining accessible only to admins, and a request not automatically deleting its target account.
- No external IO attempt, crawler launch or collection output.

Root verified the rendered login and privacy pages on desktop and at a 390px mobile viewport, including no horizontal overflow. The public-policy integration test passed again after final wording and template edits.

The wider package test chain passed except three existing baseline failures, reproduced against production baseline `360ed3c`: `test_surface_contrast.cjs` expects a different collection keyword row layout; `test_master_db.cjs` and `test_master_db_baseline_audit.cjs` depend on missing baseline company/history fixtures. These are not new failures from this change. Authentication, consent, deletion-request privacy, daily scheduler and collection-quality checks passed.

Before rollout, the production daily scheduler was paused at a keyword boundary with seven completed keywords and six pending; no running collection was terminated. The scheduler must be re-enabled after deployment and the remaining items verified to resume. This audit does not claim that the outstanding operational/legal facts above have been resolved.
