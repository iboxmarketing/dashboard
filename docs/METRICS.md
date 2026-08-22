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
| **Leadlar** | eligible cohort deals | — | `createdAt` in range | routing | `crm.deal.list` `DATE_CREATE` |
| **SQL** | `qualified === true` | Leadlar | `createdAt` | routing | stage history + live stage `SORT` |
| **Not Relevant** | `lossReasonGroup === "MARKETING"` | Leadlar | `createdAt` | routing | current stage = configured low-quality stage |
| **Sotilmadi** | `lossReasonGroup === "SALES"` | **SQL** | `createdAt` | routing | closed-lost stage, non-routing reason |
| **Kelgan leadlardan sotuv** | eligible cohort `salesStatus === "WON"` | Leadlar (and SQL for the second rate) | `createdAt` — sale may land later | routing | payment stage / history / post-sale funnel |
| **Shu davrdagi sotuvlar** | `salesStatus === "WON" && wonAt` in range | — | **`wonAt`** — creation date irrelevant | needs a trustworthy `wonAt` | as above |
| **Sotuv summasi** | Σ `OPPORTUNITY` over *Shu davrdagi sotuvlar* | — | `wonAt` | — | `OPPORTUNITY` |
| **Leadni saralash vaqti** | avg business minutes `slaStart` → first SQL-or-downstream **or** Not Relevant entry | — | `createdAt` | routing | stage history; **never calls** |
| **SLA** | `ON_TIME` | `ON_TIME + LATE + OVERDUE_UNPROCESSED` | `createdAt` | PENDING, UNKNOWN_EVIDENCE | stage history |

The two sales cards are different populations by design. A July lead sold in
August appears only in *Shu davrdagi sotuvlar*; an August lead sold in September
appears only in *Kelgan leadlardan sotuv*. Never expect them to match.

## Lead and quality

| Metric | Numerator | Denominator | Date basis | Bitrix source | Exclusions |
| --- | --- | --- | --- | --- | --- |
| Yangi lead | eligible cohort deals | — | `createdAt` | `crm.deal.list` `DATE_CREATE` | routing |
| Qabul qilingan SQL | `qualified === true` | eligible cohort | `createdAt` | stage history + live stage SORT | routing |
| Marketing sifatsiz (Not Relevant) | `lossReasonGroup === "MARKETING"` | eligible cohort | `createdAt` | current stage = configured low-quality stage | routing |
| Sotilmadi | `lossReasonGroup === "SALES"` | **SQL** (`qualified === true`) | `createdAt` | closed-lost stage, non-routing reason | routing |
| Routing | `lossReasonGroup === "ROUTING"` | — (count only) | `createdAt` | failure reason matches a routing pattern | — |
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

Seller priority: stored snapshot (only when it resolved a real seller) →
configured Sales manager field → stage mover (`MOVED_BY_ID`) → current
`ASSIGNED_BY_ID` → unknown. Calls were removed from this chain in Sprint 16. Current-stage workload uses current
`ASSIGNED_BY_ID`. Unattributed deals go to an explicit unknown bucket that is
reported, never dropped. Per-manager denominators sum back to the total.

## Current stage inventory

Live `crm.deal.list` with `CLOSED=N` on the selected Sales funnels, no
`DATE_CREATE` filter. Reconciliation compares that live set against cached
records scoped by funnel only — sales classification never decides cache
membership — while staleness uses the subset the cache still believes is open.
