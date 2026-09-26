# IBOX Dashboard — handoff

One page for whoever operates or inherits this dashboard. It states what is
deployed, what every number means, and what must never be done to it. The
detailed rules live in `docs/BUSINESS_RULES.md`, the runbooks in
`docs/OPERATIONS.md`, the system shape in `docs/ARCHITECTURE.md`.

## Production

| | |
| --- | --- |
| Worker | `bitrix-deal-dashboard` (Cloudflare Workers, Paid — 30 s CPU) |
| **Worker version** (what serves traffic) | `c9fd375b-4028-4656-bbc2-ef0f2f8c3ebf` |
| **Deployed application SHA** (what that version was built from) | `4ce68f7` — analytics version 15 |
| **Release branch** | `release/meeting-2026-09-21` |
| **Branch HEAD** (latest commit on that branch) | `4ce68f7`, plus the documentation-only commit that records this deployment |
| URL | `https://bitrix-deal-dashboard.lively-river-afba.workers.dev` (behind Cloudflare Access) |
| D1 database | `ibox-dashboard-production`, id `281835a3-f1f4-4f92-be6c-818b05583a00` |
| Latest Full Sync | `2026-09-24T09:24:57.400Z` (14:24:57 Asia/Tashkent), run `2421c3e2-5762-4048-b53f-bad446536aa7`, analytics version 14 — **a new Full Sync is required** for version 15 records |
| Staging Worker | `bitrix-dashboard-staging` → D1 `ibox-dashboard-staging` (`a97770c8-995d-419d-aa5d-122fbb956610`) |
| Cron | `*/15 * * * *`; it syncs only while `autoSyncMinutes > 0` (currently `0`, so sync is manual) |
| Observability | deliberately OFF — public share tokens ride in the URL path and Workers Logs would retain them |

Three identities, deliberately listed apart:

- the **Worker version** is what serves traffic — the only thing a user is
  actually looking at;
- the **deployed application SHA** is the commit that version was built from;
- the **branch HEAD** may be ahead of it by documentation-only commits (this file
  records the deployment, so the commit that records it necessarily follows it).
  A branch HEAD ahead by application code means something is built but not
  deployed — check before assuming production has it.

The previous accepted version was `be58b080-b832-48f1-8a5d-5805ea83c4fe`
(SHA `0d60464`, analytics version 14), kept here only as the rollback target — and
because version 15 changes stored classification, rolling back to it needs the
matching D1 restore, not code alone.

**Deploying:** `npm run verify` builds `dist/` only after its test suite passes, so
a failed run leaves the previous build in place. Always confirm the build ran
(`Build complete` in the log, or `dist/server/index.js`'s timestamp) before
`wrangler deploy`, or the deploy ships the last successful build instead of the
change you just made. Confirm the live identity
with `npx wrangler deployments status --name bitrix-deal-dashboard` and
`git rev-parse origin/release/meeting-2026-09-21`, and update this table whenever a
new version is accepted.

**Staging and production share ONE Bitrix portal.** A CRM write issued from
staging changes production data. Never create test Deals in the portal: they
enter production KPI.

## Business rules (frozen)

| Metric | Definition |
| --- | --- |
| **Lead** | a Deal that entered the IBOX Sales funnel (category 3) and belongs to the project, counted by `createdAt`. Membership is decided by the Deal's canonical Sales entry and its current funnel, never by source or loss reason. |
| **Saralangan / Saralanmagan** | classified = the Deal reached a qualification decision (SQL or Not Relevant); unclassified = it has not. |
| **SQL** | a qualified Deal. An ordinary direct "Сделка провалена" IS SQL. Not Relevant is never SQL. |
| **Not Relevant** | marketing-side rejection (`lossReasonGroup = MARKETING`). Never SQL, never Sales Lost. |
| **Sales Lost** | Sales-side loss (`lossReasonGroup = SALES`), including a direct close without a historical SQL stage. Routing losses are excluded from the cohort entirely. |
| **Product fit** | a Deal closed in a configured product-fit stage (`productFitStageIds`, production: `C3:UC_FKITQ2` "Klient lekin programma nepodxodit"): a real client our programme does not fit. A Lead and Saralanmagan; **not** SQL, **not** Not Relevant, **not** Sales Lost, and never on a seller's Lost score. Reported on its own line. |
| **Cohort Sales** | sales among Deals *created* in the window (`createdAt`). |
| **Period Sales** | sales whose payment date (`wonAt`) falls in the window. A proven IBOX sale keeps its Period Sale even if the Deal later moves; a DELETED Deal does not. |
| **Revenue** | sum of `OPPORTUNITY` over Period Sales, currency as Bitrix reports it (UZS). |
| **Source** | the Bitrix `SOURCE_ID` label, and nothing else. Marketing Kanali (`UF_CRM_1784823646`) is a **separate dimension**, labelled "Marketing kanali" wherever it appears — never "Manba". |
| **Stage workload** | Stage Control is a LIVE Bitrix snapshot of open Deals in the selected Sales funnel: deduplicated by Deal ID, with Not Relevant / closed-lost / payment stages excluded by stage semantics. It has no created-date bound, so **the date filter does not apply to it** — the page says so. |
| **SLA — javob vaqti** | scheduled working minutes from entry into the distributed stage (`C3:NEW` РАСПРЕДЕЛЁННЫЕ СДЕЛКИ) to the **first** move out of it. `НЕТ ОТВЕТА`, `Первое касание` and `ОБРАБОТКА` all stop the clock. 10:00–18:00 Asia/Tashkent, Mon–Fri, holidays skipped; an off-hours response scores **0 minutes**, never negative. Team average = average over every completed Deal, never an average of seller averages; the median is shown beside it. Calls are never evidence. Time-to-qualification is a different measure and stays in the card's detail. |
| **Deleted Deal lifecycle** | a Deal Bitrix no longer serves is marked `DELETED` by the refresh scope and leaves every current KPI and every scorecard. Its evidence is kept, never erased. |

Core KPI totals are decided by these rules alone. Seller attribution can never
move a Lead, SQL, Not Relevant, Sales Lost, Cohort/Period Sale or Revenue figure.

## Seller attribution

**Canonical field: `UF_CRM_1790230512` "Sales Owner at Won"** (Settings → *Sales
Owner at Won maydoni*).

- **Robot behaviour.** A Bitrix automation writes the current Responsible person
  into the field when a Deal enters `Оплата получена` **and the field is empty**.
  That fires before the operator/onboarding handoff, so the value is the seller at
  the moment of sale. It is written once and never overwritten — a reopen and a
  second win cannot move it.
- **Priority.** attested per-Deal fact (reviewed owner registry in
  `lib/seller-overrides.ts`, or an admin confirmation whose Bitrix write-back
  succeeded) → the canonical field → already-approved deterministic legacy
  evidence → review / unknown. Nothing below the field may override it: not
  `ASSIGNED_BY_ID`, not `MOVED_BY_ID`, not an observer, not a legacy custom field.
  `UF_CRM_1740741551` "Первый sales" is rejected everywhere.
- **Active roster.** The owner-approved Sales names are resolved once to Bitrix
  user IDs (`lib/seller-roster.ts`) and persisted by Full Sync into
  `salesStaffIds`. The roster decides ownership of **current** work only: open
  Deals, Not Relevant, Sales Lost, Active Leads, funnel ownership.
- **Historical former sellers.** A populated, owner-reviewed Sales Owner at Won
  makes that person the historical seller **even if they have left Sales**. Their
  sales and revenue stay theirs; their current open / NR / lost work is *not*
  attributed to them. The Managers page lists them under "Tarixiy sotuvchilar",
  and their profile shows historical ownership only.
- **Owner Confirmed.** `OWNER_CONFIRMED` comes from the git-reviewed registry or
  from an admin confirmation in **Sotuvchi tasdiqlash**. A confirmation writes
  Bitrix first and certifies only on success; a failed write is recorded and
  certifies nothing.
- **Review bucket.** Anything unproven lands in a visible review bucket, credited
  to nobody, and is shown on the Managers page with its reason
  ("Bu Deal hech bir xodim natijasiga qo'shilmagan"). The rows still sum to the
  KPI totals.

Scorecards count only `SALES_OWNER_AT_WON`, `MANUAL_CONFIRMATION` and
`OWNER_CONFIRMED`.

## Auth

- **Roles**: `ADMIN` (everything, including Users and Sotuvchi tasdiqlash) and
  `MEMBER` (only the sections granted).
- **Permissions** (per user): `dashboard`, `managers`, `leadFlow`, `quality`,
  `stages`, `deals`, `finance`, `projects`, `pages`, `diagnostics`, `settings`,
  `users`. `users` is ADMIN-only and the server refuses to grant it to a MEMBER.
  Derived views inherit their parent section's permission.
- **First Admin**: created by `scripts/bootstrap-admin.ts`; the credential is
  stored locally at `~/.ibox-admin/production-admin-password` (0600) and is never
  printed. A database trigger refuses to remove or demote the last active admin.
- **Login flow**: email + password → PBKDF2-SHA-512 (100k, the edge cap) →
  `__Host-` session cookie. A temporary password forces a change on first use.
  Login failures are deliberately indistinguishable. Public share links
  (`/share/<token>`) re-check the owner's current permissions on every read.

## Finance (MVP)

Manual finance entries with categories and monthly summaries: income, expense and
balance per month, plus a category breakdown. It is **not** connected to Bitrix
and does not touch Sales KPI. Money is stored and computed in **minor units**
(integers), formatted only at the edge, so no rounding drift accumulates; the
currency is per entry and totals never mix currencies.

## Operations

| Task | How |
| --- | --- |
| **Full Sync** | Sozlamalar → Full Sync. Rebuilds every analytics record at the current version, refreshes known Deals, resolves the roster and persists it. Required after any deploy that changes analytics version or the seller rules. |
| **Backfill** | Sozlamalar → Backfill for a bounded historical window. Never needed for ordinary operation. |
| **Restore point** | `npx wrangler d1 time-travel info ibox-dashboard-production` before any mutation; it prints the bookmark to restore to. |
| **Rollback** | see below. |
| **Diagnostics** | Diagnostika page: Bitrix permissions, data counts, classification, membership, marketing-channel coverage, seller certification, lifecycle, funnel-owner basis. Stage Control shows last Full Sync, live Bitrix, analytics cache and post-sync drift. |
| **Seller review** | Sotuvchi tasdiqlash (ADMIN): dry-run and apply the legacy observer/roster rule, and confirm a seller by hand. The only screen that writes to Bitrix. |
| **Production access** | the Worker sits behind Cloudflare Access; automation reaches it only through `wrangler tail` and read-only D1. |

## Rollback and recovery

Rollback is **two decisions, not one**: the Worker version, and the stored data
the rolled-back code will read. See the rollback matrix in `docs/OPERATIONS.md`.

**Reverting to a Worker version whose analytics or storage semantics differ** —
a different `ANALYTICS_VERSION`, a different record shape, a new table or column:

1. roll the Worker back:
   `npx wrangler deployments list --name bitrix-deal-dashboard` then
   `npx wrangler rollback <previous-version-id> --name bitrix-deal-dashboard`;
2. restore D1 to the **matching** Time Travel bookmark — the one taken immediately
   before the deploy or the first write of that release:
   `npx wrangler d1 time-travel restore ibox-dashboard-production --bookmark=<id>`;
3. verify schema and data compatibility: analytics versions present
   (`SELECT DISTINCT json_extract(payload,'$.analyticsVersion') FROM analytics_records`),
   the tables the old code expects, and one KPI window against the accepted
   reference figures;
4. only then resume normal operation.

Both steps, always. A code-only rollback across a semantics change leaves new-shape
records being read by old rules — a state neither release produces, which reports
numbers that belong to nothing (`docs/OPERATIONS.md` documents exactly such a
mix: SQL 167 with Sotilmadi 124).

**Code-only rollback is safe only when** the stored schema and analytics semantics
are compatible with both builds: the same `ANALYTICS_VERSION`, no migration since
the version being restored, and no change to how records are written. UX,
copy-only and documentation releases — this one included — are in that category.

**A Full Sync is not a rollback.** It re-derives records with whatever code is
deployed, so it can never restore previous semantics; never present
"Worker rollback + Full Sync" as the universal safe path.

**Bitrix has no undo.** A written `UF_CRM_1790230512` can only be corrected in
Bitrix or through a new admin confirmation. D1 restore rewinds settings, analytics,
snapshots, confirmations and auth together, so take a fresh bookmark before
restoring an old one.

**What NOT to do**

- Do **not** apply the staging seller manifest (the old 105-ID list) to
  production. It is environment-specific release evidence, not a rule.
- Do **not** run a blind seller backfill. Only deterministic, already-certified
  evidence may be written, and only through Sotuvchi tasdiqlash.
- Do **not** change `UF_CRM_1790230512` automatically, and never overwrite a
  non-empty value: the robot's capture at sale time outranks anything computed
  later.
- Do **not** re-enable Workers observability while share tokens live in the URL.
- Do **not** infer a seller from a job title, `MOVED_BY_ID`, `FIRST_CALL`, a
  legacy custom field or "Первый sales".

## Known limitations

- **Stage Control latency.** The live workload is fetched from Bitrix on demand,
  so the page is slower than the Sales sections and moves with the CRM. Post-sync
  drift (Deals created, closed or moved after the last Full Sync) is normal and is
  labelled as such, not as an error.
- **Former historical sellers.** Their sales are certified from the canonical
  field; their current workload is deliberately unattributed. If such a person
  returns to Sales, add them to the roster and their current metrics come back
  automatically.
- **Review bucket.** Deals whose seller or current owner cannot be proven stay in
  the review bucket until a human confirms them. This is by design; the count is
  visible on the Managers page.
- **Cloudflare Access.** Production is gated, so no automation (including this
  toolchain) can call production endpoints. Full Sync, Backfill and the seller
  backfill must be started by a signed-in admin.
- **Bitrix API limits.** `crm.stagehistory.list` carries no actor and there is no
  `ASSIGNED_BY_ID` history, which is precisely why the canonical field exists.
- **Finance** is manual-entry only and has no Bitrix integration.
