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
- Denominator for low-quality rate: unique project leads in the same cohort.

### Quality accepted

A deal is quality accepted when it reaches the configured SQL stage, normally Обработка.

To avoid understating quality when Bitrix history is incomplete, genuine Sales losses and won deals also count as quality accepted. `Not Relevant` never does.

## 3. Sales loss

`Закрыто и не реализовано` / closed-and-not-realized is a Sales loss:

- the lead was accepted as quality;
- Sales did not complete a sale;
- show its `Причина провала` separately from Marketing low-quality reasons.

Routing reasons such as transfer to another brand/team may be placed in a separate routing group through configurable patterns and should not automatically blame a seller.

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

- Primary processing event: first outgoing call after deal creation.
- Fallback only when no outgoing call exists: first genuine stage change.
- An unanswered outgoing call still stops the initial-processing SLA.
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
- outgoing call takes priority over an earlier stage change for processing attribution.
