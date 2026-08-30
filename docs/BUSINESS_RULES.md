# Authoritative business rules

This document records the product owner's current rules. If a request conflicts with this file, stop and confirm the intended rule before changing calculations.

## 1. Project and funnel scope

- IBOX project = IBOX Sales + its IBOX Обучение/Сопровождение funnel.
- SD project = SD Sales + its SD Обучение/Сопровождение funnel.
- A user may select only IBOX. Two Sales funnels are not mandatory.
- Call-center and unrelated funnels are excluded.
- The same Bitrix card moves between funnels. Count its `dealId` once.

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
lead was accepted, whatever the history shows. `Not Relevant` never does.

A terminal **LOST** state is *not* by itself quality-acceptance evidence. It may
stand in for evidence only when the qualification history genuinely could not be
observed — the history source was unavailable, or returned no rows for the deal.
History that was read and simply contains no SQL stage is positive evidence that
the lead never reached SQL, and must not be upgraded.

Before this correction the LOST fallback was unconditional. On the 2026-08 production
cohort it promoted 82 of 249 SQL deals whose complete history showed paths such as
`РАСПРЕДЕЛЁННЫЕ СДЕЛКИ → НЕТ ОТВЕТА → Сделка провалена` — leads that were never worked.

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

### Pre-SQL closure — "SQLgacha yopilgan"

`salesStatus === "LOST"` and `lossReasonGroup === "SALES"` and `qualified !== true`.

A deal closed inside the Sales funnel that never produced SQL evidence. It is a
workflow signal, not a KPI, and belongs to none of SQL, Sifatli, Sifatsiz,
Not Relevant, Sotilmadi or Sales Lost. It sits inside **Saralanmagan**, because
its quality verdict was never actually reached — so Saralanmagan legitimately
contains both still-active pre-SQL leads and these terminal ones.

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

## 5. Seller attribution

The goal is to attribute performance to the seller responsible at the sales outcome, not to a later support/customer-care assignee.

Priority order:

1. stored sale snapshot;
2. configured Sales manager custom field;
3. first outgoing call responsible;
4. stage mover;
5. current `ASSIGNED_BY_ID` fallback;
6. unknown.

When a deal becomes won, its seller snapshot must remain stable. When no sale exists, current responsibility may be shown operationally but must be labeled as a fallback.

Current stage workload uses current Bitrix `ASSIGNED_BY_ID`, because it answers who owns the deal now.

## 6. Processing and SLA

- Processing event: the earliest entry into a configured SQL/Обработка or Not Relevant stage — the CRM-recorded result of the first real qualification conversation.
- Calls never stop the processing timer. Not every seller has a Bitrix-connected phone, so call coverage is uneven and would bias manager and SLA comparisons.
- Intermediate operational stages (No Answer, First Attempt) do not stop the timer.
- Without stage history the current stage's `MOVED_TIME` is used only while that stage is itself SQL or Not Relevant; for a later stage the processing time is reported as unknown and never fabricated.
- Working-time calculations use the configured weekly schedule, holidays and `Asia/Tashkent`.
- `NO_PROCESSING` is separate from late processing.
- Stage limits are configured independently for each stage, with a default fallback.

## 7. Current stage inventory

- Query all open deals in the selected Sales funnel directly from Bitrix.
- Do not apply the historical `DATE_CREATE` import window.
- Retrieve only lightweight fields needed for manager, stage, age and link.
- Reconcile live inventory against analytics cache and expose missing, stale and stage-mismatch counts.
- Date filters must not alter current stage inventory.

## 8. Historical cohort

- Cohort membership is based on deal creation time.
- IBOX Sales and matching IBOX post-sale history are combined into one project record.
- A deal moving to post-sale remains part of its original Sales cohort.
- Historical reports may be incomplete outside the synchronized date range; the UI must label that boundary.

## 9. Source and failure reason

- Marketing source uses the configured custom Marketing channel field when available.
- Fallback source is standard Bitrix `SOURCE_ID`.
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
