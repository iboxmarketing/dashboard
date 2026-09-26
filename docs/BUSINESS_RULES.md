# Authoritative business rules

This document records the product owner's current rules. If a request conflicts with this file, stop and confirm the intended rule before changing calculations.

## 1. Project and funnel scope

- IBOX project = IBOX Sales + its IBOX Обучение/Сопровождение funnel.
- SD project = SD Sales + its SD Обучение/Сопровождение funnel.
- A user may select only IBOX. Two Sales funnels are not mandatory.
- Call-center and unrelated funnels are excluded.
- The same Bitrix card moves between funnels. Count its `dealId` once.

### Canonical IBOX Lead membership

The canonical IBOX Lead population uses the Deal's original Bitrix
`DATE_CREATE`, interpreted as an inclusive calendar-date range in
`Asia/Tashkent`. One unique Bitrix Deal ID is one Lead; Contact, phone or
company duplication never merges different Deal IDs.

A Deal becomes an IBOX Lead when its stage history records entry into the
configured IBOX Sales category, regardless of the funnel where the Deal was
created. The IBOX Sales stages are, in order:

1. РАСПРЕДЕЛЁННЫЕ СДЕЛКИ
2. НЕТ ОТВЕТА
3. Первое касание
4. ОБРАБОТКА
5. ВСТРЕЧА НАЗНАЧЕНА
6. ВСТРЕЧА ПРОВЕДЕНА
7. СОГЛАСИЕ
8. ПОЛУЧЕНИЕ ДАННЫХ/ОПЛАТА
9. Сделка провалена
10. Not relevant
11. Оплата получена

There are no routing-only stages inside IBOX Sales. Entry into any stage above
is legitimate IBOX membership evidence. `Not relevant` and
`Сделка провалена` remain membership evidence and must not be treated as
routing stages.

Where the Deal is **now** decides whether it stays in the current canonical
population:

- currently in IBOX Sales — included, whether it never left or returned;
- currently in the matching IBOX Обучение/Сопровождение (post-sale) funnel —
  included, including a Deal that reached `Оплата получена`;
- currently in any other funnel, for example IDOKON or SD Sales, and not
  returned to IBOX Sales — excluded from the current canonical IBOX Lead
  population;
- if it later returns to IBOX Sales — included again, counted once by Deal ID.

Verified live benchmark, `DATE_CREATE` 2026-09-01 — 2026-09-19 inclusive in
`Asia/Tashkent`: 429 Deals currently in IBOX Sales (category 3) plus 41 in IBOX
Обучение (category 13) give 470 all-source canonical IBOX Leads. Filtering that
same canonical population to source `CRM-форма` gives 448. Source is a
breakdown/filter, never part of the Lead definition. The audit completed with
zero unresolved Deals.

The failure reason is supporting routing evidence, never the only source of
truth. The labels `передано Idokon (Not relevant)` and
`передано SD (Not relevant)` are reported next to a Deal but do not, by
themselves, include or exclude it. A failure-reason enum ID that no longer
exists in `crm.deal.fields` (an orphan, shown by Bitrix as "not selected") is
never inferred to be a transfer and never excludes a Deal; Deal 43205 (orphan
ID `11151`, currently in IBOX Sales) is included. The evidence report keeps
orphan IDs, and transfer labels on Deals that are still included, visible as
data-quality metadata.

A Deal created outside IBOX and later entering IBOX Sales is included.

A Deal confirmed deleted from Bitrix is excluded. Access-denied, unreadable or
otherwise ambiguous lookups are unresolved evidence and must never be treated
as deletion.

A stored analytics record older than persisted membership (before analytics
version 8) carries no membership decision of its own. Such a record is resolved
on read (`resolveProjectMembership`):

- its last known current category is outside the project funnels — excluded,
  exactly as the canonical rule requires, until the Deal returns and is rebuilt;
- inside the project with legacy transfer evidence — excluded, as before;
- inside the project with no decision at all — unresolved: kept in the
  population, never silently dropped, and counted in Diagnostics as "needs
  refresh" until a Full Sync rebuilds it.

The legacy "everything except a routing reason" fallback may never override a
known current category. Every reader of stored records — the Sales sections, a
public shared page, the Stage funnel — applies this one rule. This canonical ID set is the future base population for downstream
IBOX metrics; those metric formulas are approved separately.

## 2. Lead quality

### Marketing low quality

`Not Relevant` always means the lead supplied by Marketing was low quality.

- It remains Marketing low quality even if the deal previously visited Обработка/SQL.
- Failure-reason text does not override this stage-authoritative rule.
- Numerator: unique `Not Relevant` deals in the chosen cohort.
- Denominator for the low-quality rate: **classified leads** in the same cohort, not all leads. See *Classified vs unclassified* below.

### Quality accepted

A deal is quality accepted when it reaches the configured SQL stage, normally Обработка.

A canonical **WON** also counts as quality accepted: an actual sale proves the
lead was accepted, whatever the history shows. `Not Relevant` never does —
`LOW_QUALITY` forces `qualified: false`, so Not Relevant is never SQL.

An **ordinary Sales-funnel closure is also always quality accepted** (owner
decision, deployed in analytics version 7 and unchanged since). A Deal moved
straight to `Сделка провалена` / `Закрыто и нереализовано` without ever visiting
SQL/Обработка is a seller process violation, not proof the lead was never worked,
so it counts as **SQL = yes and Sales Lost = yes**:

| Outcome | SQL | Sales Lost | `preSqlClosed` diagnostic |
| --- | --- | --- | --- |
| direct `Сделка провалена`, no prior SQL stage | **yes** | **yes** | **true** |
| `Сделка провалена` after a real SQL stage | yes | yes | false |
| `Not Relevant` (`lossReasonGroup = MARKETING`) | **no** | no | false |
| routed / transferred closure (`ROUTING`) | no | no | false — outside the eligible cohort |

`qualifiedAt` / `qualifiedStage` stay `null` for a direct close, because timing
may come only from real qualification evidence; `qualified` is still true. Routed
and transferred closures are excluded from this rule: they never had a chance to
convert here, so they are neither SQL nor Sales Lost.

### Classified vs unclassified

A lead's quality is **decided** once it has been either accepted (`qualified`) or
rejected as `Not Relevant`. Everything else — Распределение, Нет ответа, Первое
касание, callback/retry stages and any other pre-SQL stage — has **unknown**
quality, not low quality.

- Saralangan (classified) = `qualified === true` OR `lossReasonGroup === "MARKETING"`.
- Saralanmagan (unclassified) = eligible cohort minus Saralangan.
- Quality rates (Sifatli %, Sifatsiz %) divide by Saralangan.
- Funnel rates (Lead → SQL, Lead → Sotuv) divide by Leadlar, and keep doing so:
  they measure total funnel efficiency, not quality.
- `Saralash qamrovi` = Saralangan ÷ Leadlar makes cohort maturity visible instead
  of letting an unworked cohort masquerade as a low-quality one. No maturity
  threshold is imposed; the percentage is reported objectively.

Membership is determined only by the canonical `qualified` / `lossReasonGroup`
fields, never by a display stage name, so an unlisted or renamed pre-SQL stage is
unclassified by default rather than being silently miscounted.

A `Not Relevant` deal that previously visited SQL stays `qualified: false`: it is
classified and low quality, and must never also count as quality accepted.

### Pre-SQL closure — "SQLgacha yopilgan" (diagnostic only)

`isPreSqlClosed` = `salesStatus === "LOST"` and `lossReasonGroup === "SALES"` and
no `qualifiedStageId`.

It flags a **missing SQL-stage evidence trail** — a Deal closed as an ordinary
Sales loss without ever passing through SQL/Обработка — and is a process-discipline
signal, never a population. It is **never subtracted** from SQL, Sales Lost,
Saralangan or any other KPI: such a Deal is counted as SQL and as Sales Lost (see
*Quality accepted* above). Versions 5 and 6 of the analytics record excluded it and
therefore report different SQL, Sotilmadi and Saralangan numbers until rebuilt.

### Product fit — "Programma mos emas"

Owner decision, 2026-09-24. A Deal closed in a stage configured as a **product-fit
outcome** (`productFitStageIds`; on production `C3:UC_FKITQ2` "Klient lekin
programma nepodxodit") means: *the client is real, our programme does not fit them*.
It blames neither Marketing nor Sales.

| | |
| --- | --- |
| Lead | **yes** — it stays in the eligible cohort |
| SQL | **no** |
| Not Relevant | **no** |
| Sales Lost | **no** |
| Saralangan | no |
| **Saralanmagan** | **yes** |
| `preSqlClosed` | no — that diagnostic is defined over `SALES` losses only |
| Product Fit | **yes** — reported on its own line |

`lossReasonGroup = "PRODUCT_FIT"`. The stage decides it, never the failure-reason
text: the same reason in an ordinary lost stage is still a Sales loss. Only
configured stage ids qualify, so renaming a stage cannot move a Deal out of
Sotilmadi, and an unconfigured failure stage is **never** assumed to be product fit.
It is excluded from Not Relevant, from Sotilmadi, from every seller's Lost score and
from all seller performance penalties, and it is visible in Lead sifati, in
Diagnostics, on the Deal row ("Programma mos emas") and in the CSV export.

### Bitrix stage semantics are authoritative about failure

A stage Bitrix marks `SEMANTICS = F` can never be read as qualification evidence,
whether or not it has been configured. The semantics travel on stage metadata, so a
caller walking the stage timeline (which carries no semantics of its own) still sees
them. Without this, a newly created terminal stage became "downstream of SQL"
purely because its SORT sat after Обработка — which is exactly how one product-fit
Deal was counted as SQL + Sotilmadi before this correction.

## 3. Sales loss

`Закрыто и не реализовано` / closed-and-not-realized is a Sales loss:

- the lead was accepted as quality;
- Sales did not complete a sale;
- show its `Причина провала` separately from Marketing low-quality reasons.

Routing reasons such as transfer to another brand/team may be placed in a separate routing group through configurable patterns and should not automatically blame a seller.

Canonical **Sales Lost** requires both `lossReasonGroup === "SALES"` **and**
`qualified === true`. Sales Lost is a post-SQL outcome by definition, so it is a
strict subset of SQL and the invariant `Sales Lost <= SQL` always holds. The
broader `salesStatus === "LOST"` state remains stored for diagnostics but must
never power the Sotilmadi KPI on its own.

`qualifiedAt` / `qualifiedStage` may only come from real SQL or downstream
evidence. When a deal is qualified solely through the safe missing-history
fallback, both stay `null` rather than being pointed at an arbitrary earlier
stage.

## 4. Sale

A deal is won when either condition is true:

1. it reaches a payment-received stage; or
2. it moves into the matching brand post-sale funnel.

A deal is counted once even when both signals exist. Payment/post-sale outcome contributes to quality-accepted counts.

Sales count for a date range uses the recorded `wonAt` date. Lead cohort count uses `createdAt`. These are different populations and must be labeled accordingly.

The analytics cache must therefore discover sale events independently from the
Lead import's `DATE_CREATE` window. A Deal created before the synchronized Lead
cohort but entering a configured payment stage or the matching post-sale funnel
inside the sync window is loaded through that event and then follows the same
raw/history/analytics path as every other Deal. A current payment stage may use
`MOVED_TIME`; `DATE_MODIFY` is never a payment timestamp.

Current project location still controls canonical Lead/cohort membership. It
does not erase an already proven IBOX sale from the outcome-date Period Sales
population: a later move outside IBOX excludes that Deal from Leadlar and cohort
Sales, while trustworthy IBOX payment/post-sale history can still place it in
Period Sales exactly once.

Verified live reference for 2026-09-01 — 2026-09-19 inclusive in
`Asia/Tashkent`: cohort Sales = 41 and Period Sales = 42. Deal 40099 is the one
Period Sale created before the selected range.

## 5. Seller attribution

The goal is to attribute performance to the seller responsible at the sales outcome, not to a later support/customer-care assignee.

### Sales Owner at Won — the canonical seller field

Owner decision (2026-09-24): the seller of a Deal is the value of the Bitrix Deal
field **`UF_CRM_1790230512` "Sales Owner at Won"** (Settings → *Sales Owner at Won
maydoni*, `salesOwnerAtWonField`).

A Bitrix automation fills it: when a Deal enters `Оплата получена` **and the field
is still empty**, it writes the current Responsible person. That runs before the
operator/onboarding reassignment, so the value is the seller at the moment of
sale, it is captured once, and a later handoff — or a reopen and a second win —
cannot move it. A populated field therefore outranks every inferred signal,
including a frozen legacy snapshot: nothing in `ASSIGNED_BY_ID`, `MOVED_BY_ID`,
the observer list, `FIRST_CALL` or a legacy custom field may override it.

`UF_CRM_1740741551` "Первый sales" is **rejected** as seller evidence anywhere in
the product (`REJECTED_SELLER_FIELDS`): the owner confirmed it carries no seller
meaning, so it cannot be configured, suggested or backfilled from.

Old sales whose field is empty are resolved in one of two ways, never by
guessing: a one-time backfill writes the field only where existing evidence is
already deterministic (`lib/seller-backfill.ts`), and everything else waits in the
admin review queue for a human to name the seller. A confirmation there writes the
same Bitrix field first and is only then certified, so the CRM and the dashboard
can never disagree.

### Certification: no credit or blame without evidence

This dashboard evaluates employees, so an attribution is either proven or it is
not counted. Every attributed sale and every ordinary Sales loss carries a
certification (`lib/seller-evidence.ts`):

| Status | Meaning | Counts on a scorecard |
| --- | --- | --- |
| `OWNER_CONFIRMED` | explicit reviewed per-Deal owner decision, or an admin confirmation written back to Bitrix (`MANUAL_CONFIRMATION`) | yes |
| `CERTIFIED` | the Sales Owner at Won field (`SALES_OWNER_AT_WON`), a configured stable seller field, or the approved single post-sale observer handoff | yes |
| `REVIEW_REQUIRED` | somebody is named, but the evidence does not prove they sold | no — shown for a human |
| `UNKNOWN` | no seller evidence, or the id is not a real user | no |

Manager Sales, Manager Revenue, Manager conversions, rankings and the manager
profile count only `CERTIFIED` and `OWNER_CONFIRMED`. Everything else is visible
in a named review/unknown bucket, so the rows still sum to the KPI totals while
no person is credited. Core KPI membership — Lead, SQL, Not Relevant,
Saralangan/Saralanmagan, Sales Lost, Cohort and Period Sales, Revenue — is
decided by the funnel rules and is never changed by certification.

What Bitrix can and cannot prove: its REST API exposes no history of
`ASSIGNED_BY_ID`, and `crm.stagehistory.list` rows carry stage, funnel, semantic,
type and time but **no actor**. "Who was responsible at the exact sale
transition" is therefore reconstructible only from an owner confirmation, a
configured stable seller field, or the observer handoff. `MOVED_BY_ID` is
whoever moved a card, current `ASSIGNED_BY_ID` is routinely onboarding or
support after a sale, and a legacy `FIRST_CALL` value is neither — all three are
`REVIEW_REQUIRED`, never credit.

An ordinary Sales loss is owned by the Sales person responsible when it closed.
Without a configured seller field or an owner confirmation that person is not
provable, so the loss owner is `UNKNOWN` rather than whoever holds the card now.
`MOVED_BY_ID` is recorded beside it as audit evidence only.

### Manager funnel ownership — by the Deal's outcome

A manager scorecard answers "what is this person's funnel", which is NOT the same
question as "who sold this Deal". Ownership is therefore decided per Deal by its
own state (`lib/funnel-owner.ts`):

| Deal state | Owner |
| --- | --- |
| WON, or currently in the paired post-sale funnel | the **certified** sale seller (Sales Owner at Won). The current Responsible person is never used here — after a sale the card belongs to onboarding/customer care |
| still open in Sales | the current Responsible person, **only** when they are on the approved Sales roster |
| ordinary Sales Lost | the current Responsible person, same roster condition |
| Not Relevant | the current Responsible person, same roster condition |
| anything else — an operator, customer care, an unproven sale | `REVIEW_REQUIRED`: a visible bucket, credited to nobody |

A production defect this rule replaces: the funnel used to be grouped by the sale
seller, which exists only for WON Deals, so a seller with 11 proven sales showed
Lead 11, SQL 11, Sales 11, Not Relevant 0, Sales Lost 0 and a 100% conversion.
Sales Owner at Won decides **sales and revenue only**; it can never make Not
Relevant or Sales Lost disappear from a scorecard, and every attributed row still
sums to the KPI totals (the review bucket carries the remainder).

### Approved Sales roster — resolved to user IDs

The owner names the approved Sales employees (`OWNER_APPROVED_SELLER_NAMES` in
`lib/seller-roster.ts`). Names are free text, so they are resolved **once** —
provided name → exact Bitrix user → user id + canonical name — and every rule
afterwards compares ids. Matching folds case, diacritics, apostrophes,
punctuation and name order, and tolerates a single character edit per token
(`Rahmatullo` / `Rahmatulloh`) but nothing looser: `Sanjar Juraev` never matches
`Sardor Juraev`. A name matching two different users, or none, is
`ROSTER_MAPPING_REVIEW` / `NOT_FOUND` and is left out of the approved set, so no
automatic decision can rest on it. Full Sync persists the resolved ids in
`salesStaffIds` and the mapping table in the `salesRoster` dictionary.

### Legacy Sales Owner auto-confirmation

One-time rule for old WON Deals whose canonical field is still empty
(`lib/legacy-seller-autoconfirm.ts`). Observers are read **live** from Bitrix, not
from the stored record: sync enriches that list only for Deals in the post-sale
funnel, so a stored empty list means "never fetched" as often as "no observers".

1. **Field already populated** — never overwritten. Certified when the named user
   is on the roster (`CERTIFIED_EXISTING_FIELD`), otherwise flagged
   (`REVIEW_REQUIRED_NON_SALES_OWNER`) and left exactly as it is.
2. **Observers ∩ roster = exactly one** → that person sold it
   (`AUTO_CONFIRM_OBSERVER`). More than one → `REVIEW_REQUIRED_MULTIPLE_SELLERS`.
   Observers exist but none on the roster → `REVIEW_REQUIRED_NO_SELLER_OBSERVER`;
   an observer outside the roster is never used.
3. **No observers at all** → the current Responsible person, and only when they
   are on the roster (`AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER`); otherwise
   `REVIEW_REQUIRED_NON_SALES_RESPONSIBLE`. This fallback exists *because* there
   is no observer, and is forbidden the moment one exists.
4. Observer **order never decides anything** — the candidate set is a set.

Before every write the Deal is re-read and re-classified against live Bitrix: a
Deal whose field, observers or Responsible person moved since the dry-run is
skipped, never written. Certification follows the write, never precedes it.

### Sales staff roster — validation only, and never over owner-reviewed evidence

The roster of approved Sales staff (`salesStaffIds`, resolved from the owner's
names) may flag an **inferred** attribution that names somebody outside it
(`OUTSIDE_SALES_ROSTER`, which sends an otherwise countable attribution to
review). It never decides who sold and never promotes an unproven attribution.

It may **not** demote owner-reviewed evidence: `SALES_OWNER_AT_WON`,
`MANUAL_CONFIRMATION` and the owner registry are exempt. A seller who has since
left Sales therefore keeps the sales they made — historical seller attribution and
the current active roster are two different questions (see *Manager funnel
ownership*). Job titles are never evidence.

Priority order:

1. `OWNER_CONFIRMED` — an explicit business-owner decision for one Deal,
   recorded in the version-controlled registry `lib/seller-overrides.ts`, or an
   admin confirmation stored in `seller_confirmations` whose Bitrix write-back
   succeeded (`MANUAL_CONFIRMATION`); a failed write certifies nothing;
2. `SALES_OWNER_AT_WON` — the canonical field, when it names a known Bitrix user.
   A value naming no known user is kept for audit and decides nothing;
3. stored sale snapshot that resolved a seller from trustworthy evidence;
4. configured legacy Sales manager custom field (safe `UF_CRM_*` only);
5. `MOVED_BY_ID` only while the Deal is currently in the payment stage, where
   it is the actor for that sale transition;
6. for a WON Deal currently in its paired post-sale funnel, the universal
   Bitrix `observers` user list only when it contains exactly one valid,
   non-zero observer and that user differs from current `ASSIGNED_BY_ID`;
7. for a not-yet-won Deal still in the Sales funnel, current-stage mover and
   then current `ASSIGNED_BY_ID` may attribute the commercial workload;
8. unknown.

Snapshot writes follow the same strength order (`ATTRIBUTION_RANK`, mirrored by
the SQL in `lib/sales-snapshots.ts`): an attested fact (3) may replace anything
including another attested fact, the canonical field (2) may replace inferred
evidence, and inferred evidence (1) can never overwrite either. The old
attribution source is preserved in `seller_attribution_audit`, which is
append-only — a correction never erases the evidence a Deal used to carry.

Owner confirmations are per-Deal facts, never inferred rules. Nothing infers a
seller from a job title or department: audits showed titles go
stale in both directions. An owner confirmation may carry only the seller; it
can never set `wonAt`, `OPPORTUNITY`, revenue, a sales/lead status, source or
stage history. Once stored, no Sync, observer, mover, assignee, custom field or
legacy `FIRST_CALL` value can overwrite it; only a changed registry entry can.

Environment-specific seller review classifications and repair manifests are
external release evidence, not production analytics rules. A Deal omitted from
an explicit invalidation manifest keeps its existing frozen snapshot. Production
repair requires its own production-reviewed evidence and manifest.

Bitrix stage history exposes stage, funnel and transition time, but not the
historical transition actor. After a Deal moves to post-sale, current
`MOVED_BY_ID` and `ASSIGNED_BY_ID` describe that post-sale stage/owner and are
not seller evidence. The IBOX handoff process keeps the commercial seller as a
Deal observer while assigning onboarding to `ASSIGNED_BY_ID`, so one distinct
observer may resolve the seller as `POST_SALE_OBSERVER`. Empty or multiple
observer lists, or an observer equal to the assignee, remain Unknown. Legacy
snapshots whose only source was
`CURRENT_RESPONSIBLE` are treated as unresolved and may be repaired by stronger
evidence; correctly resolved snapshots remain immutable.

Historical Sales analytics, Sales Lost, conversion, sales/revenue attribution,
manager rows and historical manager filters use `salesManagerId` only.
`assignedManagerId` is a separate current operational owner and must not add a
person to the seller selector.

Current stage workload uses current Bitrix `ASSIGNED_BY_ID`, because it answers who owns the deal now.

Historical Manager and Source filters are multi-select: values are ORed within
each dimension and the two dimensions are ANDed together. An empty selection
means all values. The same predicate applies to dashboard KPIs, Managers,
Manager Detail, Lead Flow, Quality, Deals, cohort and period Sales, and the
historical Stage Funnel. The Stage Funnel uses `salesManagerId`; only the live
Current Stage Control uses `assignedManagerId`. Source does not filter that live
inventory.

## 6. Processing and SLA

### 6.1 Employee SLA — distribution to first move (owner rule, 2026-09-26)

The SLA answers one question: **how long did the lead wait for a human after it
was handed to Sales?**

| Element | Rule |
| --- | --- |
| Start | Entry into the distributed stage (`РАСПРЕДЕЛЁННЫЕ СДЕЛКИ`, `C3:NEW`). Configurable per funnel in Settings; otherwise the funnel's first stage by Bitrix SORT. |
| Stop | The **first** transition to any other stage. `НЕТ ОТВЕТА`, `Первое касание` and `ОБРАБОТКА` all stop it equally — the seller acted. |
| Re-entry | A second entry into the distributed stage neither restarts nor stops the clock; the first entry is the start. |
| Unit | Scheduled working minutes only: 10:00–18:00 `Asia/Tashkent`, Mon–Fri, holidays and disabled days excluded. The clock pauses at 18:00 and resumes at 10:00 the next working day. |
| Off-hours response | A seller who answers outside working hours (evening, Sunday, a holiday) scores **0 minutes**. Never a negative value, and never "wait for Monday and charge the gap". |
| Still in distribution | No stop event yet: `PENDING` inside the target, `OVERDUE_UNPROCESSED` past it. No duration is invented. |
| No distribution evidence | `UNKNOWN_EVIDENCE`, excluded from the rate. Qualification speed is **not** substituted — blending two measures into one rate is the defect this replaced. |
| Calls | Never evidence, in either direction. Not every seller uses a corporate phone. |

Canonical function: `businessSlaMinutes(startAt, stopAt, settings)`
(`lib/business-time.ts`). Every SLA figure in the product comes from it.

**Aggregation.** Team average SLA is the average over **every completed Deal**
value, never the average of per-seller averages — a seller with three Deals must
not weigh as much as one with thirty. A seller's average is the same function
over that seller's own Deals. The median is reported beside the average because
a handful of multi-day waits pull the mean. Calendar elapsed time is a detail
shown next to the SLA; it is never the SLA and never the employee measure.

### 6.2 Qualification speed (separate measure)

- Processing event: the earliest entry into a configured SQL/Обработка or Not Relevant stage — the CRM-recorded result of the first real qualification conversation.
- Calls never stop the processing timer. Not every seller has a Bitrix-connected phone, so call coverage is uneven and would bias manager and SLA comparisons.
- Intermediate operational stages (No Answer, First Attempt) do not stop the timer.
- Without stage history the current stage's `MOVED_TIME` is used only while that stage is itself SQL or Not Relevant; for a later stage the processing time is reported as unknown and never fabricated.
- Working-time calculations use the configured weekly schedule, holidays and `Asia/Tashkent`.
- Time-to-qualification is **not** the SLA: it measures the qualification verdict, not the response, and stays in the SLA card's detail line and the Deal report.
- `NO_PROCESSING` is separate from late processing.
- Stage limits are configured independently for each stage, with a default fallback.

## 7. Current stage inventory

- Query all open deals in the selected Sales funnel directly from Bitrix.
- Do not apply the historical `DATE_CREATE` import window.
- Retrieve only lightweight fields needed for manager, stage, age and link.
- Reconcile live inventory against analytics cache and expose missing, stale and stage-mismatch counts.
- Date filters must not alter current stage inventory.

Canonical live workload: one row per distinct Deal ID, currently in a selected
Sales funnel, whose current stage is still work. `CLOSED = N` alone is not the
rule — Bitrix keeps some Not Relevant and closed-lost cards non-closed, and a
paid card can sit in the payment stage — so Not Relevant, ordinary Sales Lost
and payment stages are excluded, as are other funnels, deleted and unreadable
Deals, and repeated ids. Every exclusion is counted by reason and shown beside
the number (`lib/current-stages.ts`), never silently dropped.

Live-view filters must affect the live number: seller (current assignee),
Source (canonical `SOURCE_ID`), pipeline, stage and search all apply to the list.
The date range deliberately does not apply to live inventory and the view says
so, rather than offering a control that does nothing.

## 8. Historical cohort

- Cohort membership is based on deal creation time.
- IBOX Sales and matching IBOX post-sale history are combined into one project record.
- A deal moving to post-sale remains part of its original Sales cohort.
- Historical reports may be incomplete outside the synchronized date range; the UI must label that boundary.

## 9. Source and failure reason

- **Standard Source is the Bitrix `SOURCE_ID` label, and only that** (owner
  decision, deployed in analytics version 13 and unchanged since). `source` and
  `rawSource` are therefore always equal on a current record. There is no
  fallback and no override: the Marketing channel can never become Manba.
- **Marketing Kanali is a separate dimension.** The configured custom field —
  `UF_CRM_1784823646` on production, a 9-option enumeration — is read into
  `marketingChannel` and reported beside Source, never as Source. It is configured
  in Settings and never detected by name; a configured field Bitrix no longer
  lists is dropped, and an enum value whose option Bitrix no longer lists yields no
  channel label rather than a bare option ID.
- Every user-facing surface says which is which: "Manba (SOURCE_ID)" for Source,
  "Marketing kanali" for the channel. Nothing labelled Manba is ever fed by the
  channel.
- Labels are Bitrix's own, verbatim, from the channel's option list or the
  SOURCE dictionary. The two vocabularies are never mapped onto each other.
- `sourceAuthority` is a legacy version-12 field: the current builder never writes
  it, and records that still carry it are pre-13 rows awaiting a rebuild.
- Failure reason uses the configured Bitrix custom field and must resolve enum IDs to readable labels.
- Missing failure reason on a terminal lead is a data-quality issue and must be visible in Diagnostics.

## 10. Duplicate signal

Duplicates are an analytical signal, never authoritative deduplication: one
Bitrix deal id is one lead. They are not removed from Leadlar, SQL, Saralangan,
Sifatli, Sifatsiz, sales or revenue, because the same contact or company can
legitimately open a second real opportunity. *Takrorsiz lead (taxminiy)* is a
diagnostic estimate only.


- First key: Contact ID.
- Fallback key: Company ID.
- Later records sharing the same key are marked as possible duplicates.
- This is an analytical warning only. Never delete or merge Bitrix deals automatically from this dashboard.

## Required regression cases

Tests must continue to prove:

- old open deals remain in current-stage inventory;
- Bitrix 91 vs cache 57 reports 34 missing records;
- `Not Relevant` remains Marketing low quality after a prior SQL visit;
- closed-and-not-realized is a Sales loss;
- payment and post-sale do not double-count a sale;
- IBOX and SD pair only with their own post-sale funnels;
- one selected IBOX pipeline is valid;
- an outgoing call does not stop the first-processing timer; only SQL or Not Relevant entry does.
