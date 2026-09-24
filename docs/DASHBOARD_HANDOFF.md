# IBOX Dashboard — handoff

One page for whoever operates or inherits this dashboard. It states what is
deployed, what every number means, and what must never be done to it. The
detailed rules live in `docs/BUSINESS_RULES.md`, the runbooks in
`docs/OPERATIONS.md`, the system shape in `docs/ARCHITECTURE.md`.

## Production

| | |
| --- | --- |
| Worker | `bitrix-deal-dashboard` (Cloudflare Workers, Paid — 30 s CPU) |
| URL | `https://bitrix-deal-dashboard.lively-river-afba.workers.dev` (behind Cloudflare Access) |
| Release branch | `release/meeting-2026-09-21` |
| D1 database | `ibox-dashboard-production`, id `281835a3-f1f4-4f92-be6c-818b05583a00` |
| Staging Worker | `bitrix-dashboard-staging` → D1 `ibox-dashboard-staging` (`a97770c8-995d-419d-aa5d-122fbb956610`) |
| Cron | `*/15 * * * *`; it syncs only while `autoSyncMinutes > 0` (currently `0`, so sync is manual) |
| Observability | deliberately OFF — public share tokens ride in the URL path and Workers Logs would retain them |

The deployed SHA and Worker version for this handoff are recorded in the release
report that accompanied it; read them live with
`npx wrangler deployments status --name bitrix-deal-dashboard`.

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
| **Cohort Sales** | sales among Deals *created* in the window (`createdAt`). |
| **Period Sales** | sales whose payment date (`wonAt`) falls in the window. A proven IBOX sale keeps its Period Sale even if the Deal later moves; a DELETED Deal does not. |
| **Revenue** | sum of `OPPORTUNITY` over Period Sales, currency as Bitrix reports it (UZS). |
| **Source** | the Bitrix `SOURCE_ID` label, and nothing else. Marketing Kanali (`UF_CRM_1784823646`) is a **separate dimension**, labelled "Marketing kanali" wherever it appears — never "Manba". |
| **Stage workload** | Stage Control is a LIVE Bitrix snapshot of open Deals in the selected Sales funnel: deduplicated by Deal ID, with Not Relevant / closed-lost / payment stages excluded by stage semantics. It has no created-date bound, so **the date filter does not apply to it** — the page says so. |
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

1. **Worker rollback.** `npx wrangler deployments list --name bitrix-deal-dashboard`,
   then `npx wrangler rollback <previous-version-id> --name bitrix-deal-dashboard`.
   Code rollback alone is safe; if the rolled-back build reads an older analytics
   version, run a Full Sync afterwards.
2. **D1 recovery.** `npx wrangler d1 time-travel info ibox-dashboard-production`
   to find a bookmark, then
   `npx wrangler d1 time-travel restore ibox-dashboard-production --bookmark <id>`.
   Restoring rewinds settings, analytics, snapshots, confirmations and auth
   together — take a fresh bookmark first.
3. **Bitrix has no undo.** A written `UF_CRM_1790230512` can only be corrected in
   Bitrix or through a new admin confirmation.

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
