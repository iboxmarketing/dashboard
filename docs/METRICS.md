# Metric definitions

> **Calls are not a dashboard data source.** Telephony and activity data are no
> longer synced, no longer drive First Processing or SLA, and no longer take part
> in seller attribution. The `raw_activities` / `raw_call_stats` tables remain for
> historical reasons and are unused.

Source of truth for every dashboard number. Change a definition here in the same
commit that changes the code. See `BUSINESS_RULES.md` for the product rules this
implements and `ARCHITECTURE.md` for where the data comes from.

## Record version

`analyticsVersion` marks the semantics a stored record was built with. It lives
inside the `analytics_records` payload — no column, no migration. The dashboard
treats anything below the current version as stale and prompts for a rebuild.

| Version | Semantics |
| --- | --- |
| ≤ 3 | pre-Sprint-10: call-priority first processing |
| 4 | Sprint 10/11: qualification-based processing, strict SLA |
| **5 (current)** | Sprint 15/16: `SOURCE_ID` source, per-funnel failure reason, downstream-stage qualification, no call-derived attribution |

A record already written as version 4 is **not** current under Sprint 15/16 and
must be rebuilt by the pending full sync.

## Populations

| Name | Definition |
| --- | --- |
| **Raw population** | Every synced deal in the selected Sales funnels plus their paired post-sale funnels. Nothing is ever deleted from it. |
| **Eligible cohort** | Raw population minus routed deals (`lossReasonGroup === "ROUTING"`). Routed deals went to another project, so counting them would depress every IBOX denominator. Helper: `isEligibleCohortDeal`. |
| **Cohort-based** | Membership by `createdAt` inside the selected range. |
| **Period-based** | Membership by `wonAt` inside the selected range. Different population from cohort — never expect the two to match. |
| **Live inventory** | Bitrix `CLOSED=N` in the selected Sales funnels. No date filter. Separate from every metric below. |

One Bitrix Deal ID counts once, even when the card moves between funnels.

## Main dashboard cards

Card visibility is a preference (`dashboardMetricIds`); the numbers below never
change with visibility. Default set: Leadlar, SQL, Not Relevant, Sotilmadi,
Kelgan leadlardan sotuv, Shu davrdagi sotuvlar, Sotuv summasi, Leadni saralash
vaqti, SLA.

| Card | Numerator | Denominator | Selected date means | Exclusions | Bitrix source |
| --- | --- | --- | --- | --- | --- |
| **Leadlar** | unique Deal IDs that entered selected Sales and are currently in Sales or matching post-sale | — | original `createdAt` in range | other project funnel; confirmed deletion | stage history + current Deal category |
| **SQL** | `qualified === true` inside canonical Leadlar | Leadlar | `createdAt` | non-members | stage history + live stage `SORT` |
| **Not Relevant** | `lossReasonGroup === "MARKETING"` inside canonical Leadlar | **Saralangan leadlar** for the quality rate | `createdAt` | non-members | current stage = configured low-quality stage |
| **Saralangan leadlar** | canonical Lead with `qualified === true \|\| lossReasonGroup === "MARKETING"` | — | `createdAt` | non-members | canonical fields, never stage names |
| **Saralanmagan leadlar** | Leadlar − Saralangan | — | `createdAt` | non-members | canonical fields |
| **Saralash qamrovi** | Saralangan | Leadlar | `createdAt` | non-members | — |
| **Sifatli lead %** | SQL | **Saralangan leadlar** | `createdAt` | non-members | — |
| **Sifatsiz lead %** | Not Relevant | **Saralangan leadlar** | `createdAt` | non-members | — |
| **Umumiy leadlardan Not Relevant %** | Not Relevant | Leadlar | `createdAt` | non-members | full-funnel share, *not* a quality rate |
| **Sotilmadi** | canonical Lead with `lossReasonGroup === "SALES"` **and** `qualified === true` | **SQL** | `createdAt` | non-members, pre-SQL closures | closed-lost stage, non-routing reason |
| **SQLgacha yopilgan** | canonical Lead with `LOST` + `SALES` + `qualified !== true` | — | `createdAt` | non-members | diagnostic only; inside Saralanmagan |
| **Kelgan leadlardan sotuv** | canonical cohort `salesStatus === "WON"` | Leadlar (and SQL for the second rate) | `createdAt` — sale may land later | non-members | payment stage / history / post-sale funnel |
| **Shu davrdagi sotuvlar** | `salesStatus === "WON" && wonAt` in range | — | **`wonAt`** — creation date irrelevant | needs a trustworthy `wonAt` | as above |
| **Sotuv summasi** | Σ `OPPORTUNITY` over *Shu davrdagi sotuvlar* | — | `wonAt` | — | `OPPORTUNITY` |
| **Leadni saralash vaqti** | avg business minutes `slaStart` → first SQL-or-downstream **or** Not Relevant entry | — | `createdAt` | non-members | stage history; **never calls** |
| **SLA** | `ON_TIME` | `ON_TIME + LATE + OVERDUE_UNPROCESSED` | `createdAt` | PENDING, UNKNOWN_EVIDENCE | stage history |

## Quality is not funnel

Three questions, three denominators, and they must never be mixed:

| Question | Metric | Formula |
| --- | --- | --- |
| How many real leads came in? | Leadlar | canonical Sales-entry/current-project population |
| Of the leads we have judged, how many were good? | Sifatli / Sifatsiz lead % | SQL ÷ **Saralangan**, Not Relevant ÷ **Saralangan** |
| Of everything that arrived, how much progressed? | Lead → SQL, Lead → Sotuv | SQL ÷ **Leadlar**, Cohort sotuv ÷ **Leadlar** |

`Leadlar ≠ Saralangan leadlar`, and `Lead → SQL ≠ Sifatli lead %`. A lead sitting
in Распределение, Нет ответа, Первое касание or any other pre-SQL stage is
**unclassified**, not low quality: its verdict has not been reached yet. Dividing
Not Relevant by Leadlar therefore answers "what share of everything that arrived
was rejected", which is a funnel share — it is available as *Umumiy leadlardan
Not Relevant %* and is deliberately **not** the primary quality metric.

`Saralash qamrovi` (Saralangan ÷ Leadlar) is what separates "quality is good"
from "we have barely judged this cohort yet". A young cohort with 40% coverage
and 75% Sifatli is a different situation from a mature one with 95% coverage and
75% Sifatli, and no threshold is imposed on it — the percentage is shown as-is.

Lead membership is decided by `projectLeadMembership` plus definitive live
`currentScope` evidence via `isEligibleCohortDeal()` in `lib/sales-logic.ts`.
Source and failure reason never decide membership. Quality classification is a
separate decision over `qualified` and `lossReasonGroup` via
`isClassifiedLead()`, never by matching a display stage name.

SQL is evidence-based: a lead is qualified by explicit configured SQL-stage
evidence, by downstream same-pipeline evidence at or after the SQL threshold, or
by being a canonical WON. A terminal LOST outcome qualifies a deal only when the
history could not be observed at all. Deals closed in the Sales funnel with no
SQL evidence are **SQLgacha yopilgan** and count in none of the quality KPIs.

Note for releases: `qualified` is computed during sync and **stored** on the
record, so a change to this rule only affects deals that are subsequently
re-synced or rebuilt by the analytics-only backfill. Existing records keep the
value they were written with until then — and because the value is stored,
rolling the *code* back after a backfill does not roll the *data* back. See
"Rolling back a release that changed stored analytics semantics" in
`docs/OPERATIONS.md`.

Invariants, enforced by `tests/lead-classification.test.ts` and `tests/sql-evidence.test.ts`:

```
raw cohort  = Leadlar + canonical exclusions
Leadlar     = Saralangan + Saralanmagan
Saralangan  = Sifatli (SQL) + Sifatsiz (Not Relevant)
Sales Lost <= SQL                       (Sales Lost is a post-SQL outcome)
```

The last one holds because MARKETING is only ever produced from a `LOW_QUALITY`
status, which forces `qualified: false`. Should a record ever assert both, the
overlap is counted and surfaced in Diagnostics rather than absorbed silently.

Duplicates remain **analytical only**. One Bitrix deal id is one lead, and a
repeat customer may be a genuine second opportunity, so duplicates are never
removed from Leadlar, SQL, Saralangan, Sifatli, Sifatsiz, sales or revenue.
*Takrorsiz lead (taxminiy)* is a diagnostic estimate, never the canonical
population.

The two sales cards are different populations by design. A July lead sold in
August appears only in *Shu davrdagi sotuvlar*; an August lead sold in September
appears only in *Kelgan leadlardan sotuv*. Never expect them to match.

## Lead and quality

| Metric | Numerator | Denominator | Date basis | Bitrix source | Exclusions |
| --- | --- | --- | --- | --- | --- |
| Yangi lead | canonical project Leads | — | `createdAt` | Sales-entry history + current category | non-members |
| Qabul qilingan SQL | `qualified === true` | canonical cohort | `createdAt` | stage history + live stage SORT | non-members |
| Marketing sifatsiz (Not Relevant) | `lossReasonGroup === "MARKETING"` | canonical cohort | `createdAt` | current stage = configured low-quality stage | non-members |
| Sotilmadi | `lossReasonGroup === "SALES"` | **SQL** (`qualified === true`) | `createdAt` | closed-lost stage, non-routing reason | non-members |
| Routing evidence | `lossReasonGroup === "ROUTING"` | — (diagnostic only) | `createdAt` | failure reason matches a routing pattern | never membership authority |
| Takroriy lead | `duplicateOfDealId !== null` | cohort | `createdAt` | Contact ID, then Company ID | — |

**SQL / quality acceptance.** A deal is qualified when it enters the configured
SQL stage **or any stage downstream of it in the same pipeline** — Встреча,
Согласие and Оплата all prove acceptance, so a seller need not pass through
Обработка. Ordering comes from the live Bitrix `SORT` in the stage dictionary,
never from a display name, so renaming a stage is safe. `Not Relevant` is never
qualified. Genuine closed-lost and won deals count as qualified even when history
is incomplete.

## Sales

| Metric | Numerator | Denominator | Date basis | Bitrix source |
| --- | --- | --- | --- | --- |
| Cohort sotuv | `salesStatus === "WON"` | eligible cohort | `createdAt` | payment stage, payment history, or post-sale funnel |
| Davr sotuv | `salesStatus === "WON" && wonAt` in range | — | **`wonAt`** | as above |
| Sotuv summasi / chek / savdo sikli | sum / avg / median over Davr sotuv | — | `wonAt` | `OPPORTUNITY`, `wonAt − createdAt` |

A deal is won when it reaches a payment stage (by history **or** by current
stage) or moves into the paired post-sale funnel. Counted once when both hold.
`wonAt` priority: stored snapshot → payment history → post-sale transition →
`MOVED_TIME` while the current stage is the payment stage → `null`. A won deal
with no trustworthy `wonAt` counts in Cohort sotuv and is invisible to every
`wonAt`-keyed metric; Diagnostics counts it as **Sotuv vaqti aniqlanmagan**.

## First processing and SLA

| Metric | Definition |
| --- | --- |
| Birinchi ishlov vaqti | Business minutes from `slaStart` to the earliest entry into a SQL-or-downstream stage **or** the Not Relevant stage. |
| SLA % | `ON_TIME / (ON_TIME + LATE + OVERDUE_UNPROCESSED)` |

Calls never stop the timer: call coverage is uneven across sellers, so it would
bias every comparison. Intermediate stages (No Answer, First Attempt) do not stop
it either. Without stage history, the current stage's `MOVED_TIME` is used only
while that stage is itself a qualification outcome; for a later stage the time is
reported unknown and never fabricated.

SLA states: `ON_TIME` (≤ target), `LATE` (> target), `PENDING` (unprocessed,
inside target — excluded), `OVERDUE_UNPROCESSED` (unprocessed, past target —
counts against), `UNKNOWN_EVIDENCE` (history missing — excluded). Business time
uses `Asia/Tashkent`, the configured schedule and holidays.

## Source and failure reason

**Source** is the standard Bitrix `SOURCE_ID` resolved through the live `SOURCE`
dictionary (`crm.status.list`, `ENTITY_ID=SOURCE`). Filters and breakdowns show
the readable name; a missing id shows **Aniqlanmagan**. Custom "how did you hear"
fields and UTM parameters are separate attribution dimensions and are never
substituted for Source.

**Failure reason** is per Sales funnel, via
`failureReasonFieldByPipeline[categoryId]`, falling back to the single
`failureReasonField`. Enum ids are decoded to labels from the cached field
dictionary. Reason text **never** decides Marketing vs Sales: the stage is
authoritative — `Not Relevant` → MARKETING, closed-lost → SALES, and a routing
pattern in the reason → ROUTING. The same reason label may legitimately appear
under more than one group.

## Manager attribution

Seller priority: trustworthy stored snapshot → configured stable Sales Manager
field → `MOVED_BY_ID` while the Deal is currently in payment → unknown. For a
not-yet-won Deal still in the Sales funnel, current-stage mover and then current
`ASSIGNED_BY_ID` remain labelled fallbacks. Bitrix stage history does not carry
the historical transition actor, so after a Deal moves to post-sale its current
mover/assignee must never be guessed as the seller. Historical filters and all
manager performance, Sales Lost, conversion, Sales and Revenue grouping use
`salesManagerId` only. Current-stage workload separately uses current
`ASSIGNED_BY_ID`. Unattributed deals go to an explicit unknown bucket that is
reported, never dropped. Per-manager denominators sum back to the total.

## Current stage inventory

Live `crm.deal.list` with `CLOSED=N` on the selected Sales funnels, no
`DATE_CREATE` filter powers the current-stage board. Separately, membership
reconciliation compares an all-status live snapshot of the selected Sales and
paired post-sale funnels against cached project records. A missing row gets a
direct by-ID lookup; only a definitive move or deletion changes membership.

## Aktiv leadlar (`active_cohort`)

Historical eligible cohort records that are still `ACTIVE` **and** operationally
`IN_SCOPE`.

A deal that has left the project funnels or is confirmed deleted is outside the
current canonical Lead population. `currentScope` records this definitive live
evidence, so Leadlar and every cohort metric derived from it exclude the row;
`active_cohort` additionally requires `salesStatus === "ACTIVE"`. An ambiguous
lookup does not write an exclusion and therefore cannot silently remove a Deal.
