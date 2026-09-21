# Data accuracy certification toolkit

This toolkit certifies the historical analytics cache after a release. It is read-only: it never calls Sync, Backfill, `ensureSchema`, an API mutation, or a D1 write statement. It does not certify live current-stage inventory, which remains a separate direct Bitrix query.

The machine-readable counterpart to this document is [`data-certification-matrix.json`](./data-certification-matrix.json). Keep the two files together when calculation rules change.

## Certification input and evidence boundary

Bitrix24 is the system of record. `analytics_records` is the synchronized historical cache being certified. Export every row, including corrupt payloads, with this fixed query:

```sql
SELECT deal_id, payload, json_valid(payload) AS payload_valid
FROM analytics_records
ORDER BY deal_id
```

An authorized operator can make a read-only D1 export after production release. Do not put secrets on the command line and do not commit the export:

```bash
mkdir -p .audit/data-certification
npx wrangler d1 execute <D1_DATABASE> --remote --config <WRANGLER_CONFIG> --yes --json \
  --command "SELECT deal_id, payload, json_valid(payload) AS payload_valid FROM analytics_records ORDER BY deal_id" \
  > .audit/data-certification/analytics-records.json
```

The query is fixed in `ANALYTICS_EXPORT_QUERY`. The validator also accepts an array of full analytics records or `{ "records": [...] }`, but a compact `/api/dashboard` response omits raw `sourceId`; use the D1 export for complete source certification.

Historical completeness is limited by the configured sync/import coverage. A passing cache certification proves internal calculation and reference reconciliation for the exported cache; it does not prove that Bitrix records outside that coverage were synchronized. Reconcile the release’s sync state and selected project funnels before signing off.

## KPI certification matrix

All calendar ranges below are inclusive in `Asia/Tashkent` (`00:00:00.000+05:00` through `23:59:59.999+05:00`). Every population is a set of Bitrix Deal IDs. Contact, company and phone matches are diagnostic only and never merge Deals.

### Lead

- Business definition: one canonical project Deal whose original `DATE_CREATE` is in the selected historical cohort.
- Authoritative CRM evidence: Deal ID, `DATE_CREATE`, recorded entry into selected Sales, and the synchronized `projectLeadMembership`/`currentScope` decision.
- Date field: `createdAt` from Bitrix `DATE_CREATE`.
- Inclusion: membership `INCLUDED` or `UNRESOLVED`; legacy rows without membership unless `lossReasonGroup=ROUTING`.
- Exclusion: membership `EXCLUDED`; `currentScope=OUT_OF_SCOPE|UNAVAILABLE`; legacy routing row.
- Deduplication: one `dealId`; never deduplicate by contact/company.
- Funnel/category behavior: selected Sales plus its matching brand post-sale funnel are one project; unrelated and call-center funnels are excluded.
- Expected invariants: `Lead = SQL + Not Relevant + Saralanmagan`; no repeated Deal ID.
- Known edges: unresolved membership remains visible; historical cache coverage is bounded; a Deal may have been created outside Sales and later entered it.
- Exact validator: `isCertificationLead()` and `calculateCertificationMetrics().populations.lead`.

### SQL

- Business definition: a quality-accepted canonical Lead.
- Authoritative CRM evidence: stored `qualified=true`, derived by runtime analytics from configured SQL/Обработка or downstream evidence, or a canonical win.
- Date field: `createdAt`; `qualifiedAt` is evidence metadata and does not control cohort membership.
- Inclusion: canonical Lead with `qualified === true`.
- Exclusion: final Not Relevant, unclassified pre-SQL, or excluded/routed membership.
- Deduplication: one `dealId`.
- Funnel/category behavior: evidence comes from selected Sales stages; a matching payment/post-sale outcome proves acceptance.
- Expected invariants: disjoint from Not Relevant; Sales Lost is a subset; every win is SQL.
- Known edges: the validator uses the stored canonical flag and never invents missing qualification; `qualifiedStageId` may remain absent on a direct-close process diagnostic.
- Exact validator: `record.qualified === true` in `calculateCertificationMetrics()`.

### Not Relevant

- Business definition: Marketing low quality in the final quality classification.
- Authoritative CRM evidence: configured/current Not Relevant stage producing `lossReasonGroup=MARKETING`.
- Date field: `createdAt`.
- Inclusion: canonical Lead with `lossReasonGroup === "MARKETING"`.
- Exclusion: Sales loss, routing, or any record also marked SQL.
- Deduplication: one `dealId`.
- Funnel/category behavior: remains Marketing low quality after a prior SQL visit; failure-reason text cannot override the stage verdict.
- Expected invariants: no overlap with SQL; never counted as Sales Lost.
- Known edges: configured stable stage IDs must survive stage renames.
- Exact validator: MARKETING filter in `calculateCertificationMetrics().populations.notRelevant`.

### Saralangan

- Business definition: quality decided—accepted as SQL or rejected as Not Relevant.
- Authoritative CRM evidence: canonical `qualified` flag or MARKETING loss group.
- Date field: `createdAt`.
- Inclusion: `qualified === true || lossReasonGroup === "MARKETING"`.
- Exclusion: no verdict or excluded/routed membership.
- Deduplication: set union by `dealId`, never an unchecked sum.
- Funnel/category behavior: classification follows canonical evidence, not display-stage names.
- Expected invariants: `Saralangan + Saralanmagan = Lead`; with no conflict, `Saralangan = SQL + Not Relevant`.
- Known edges: any SQL/Not Relevant overlap fails certification.
- Exact validator: classified population in `calculateCertificationMetrics()`.

### Saralanmagan

- Business definition: canonical Lead with no recorded quality verdict.
- Authoritative CRM evidence: absence of both quality-acceptance and Marketing-rejection flags.
- Date field: `createdAt`.
- Inclusion: `qualified !== true && lossReasonGroup !== "MARKETING"`.
- Exclusion: SQL, Not Relevant, excluded/routed membership.
- Deduplication: one `dealId`.
- Funnel/category behavior: distribution, no-answer and other pre-SQL stages are unclassified, not low quality.
- Expected invariant: `Lead = SQL + Not Relevant + Saralanmagan`.
- Known edges: young cohorts can legitimately have high Saralanmagan; direct-close treatment follows stored canonical data and is not re-derived here.
- Exact validator: unclassified population in `calculateCertificationMetrics()`.

### Sales Lost

- Business definition: a quality-accepted Lead closed and not realized by Sales.
- Authoritative CRM evidence: `lossReasonGroup=SALES` plus `qualified=true`, derived from configured terminal outcome and qualification evidence.
- Date field: `createdAt`; this is a cohort KPI.
- Inclusion: canonical Lead satisfying both flags.
- Exclusion: Not Relevant, routing, win, or unqualified record.
- Deduplication: one `dealId`.
- Funnel/category behavior: closed-and-not-realized is separate from Marketing low quality; routing stays separate.
- Expected invariants: Sales Lost is a subset of SQL and cannot exceed it.
- Known edges: missing failure reason is a quality issue; process-diagnostic direct closure does not cause the validator to rewrite stored fields.
- Exact validator: `qualified === true && lossReasonGroup === "SALES"`.

### Cohort Sales

- Business definition: canonical Leads created in the range that eventually became won.
- Authoritative CRM evidence: payment-stage history or entry into the matching brand post-sale funnel, with stable sale snapshot fields.
- Date field: `createdAt`; `wonAt` may be outside the selected range.
- Inclusion: eligible created cohort with `salesStatus=WON`.
- Exclusion: created outside the range or excluded from project membership.
- Deduplication: payment and post-sale evidence for one `dealId` count once.
- Funnel/category behavior: Sales and matching post-sale form one project; cross-brand funnels do not win it.
- Expected invariants: every Cohort Sale is SQL; it uses a distinct selector from Period Sales.
- Known edges: the same Deal may correctly belong to both sales populations; frozen snapshot evidence wins over later movement.
- Exact validator: WON filter on the eligible created cohort.

### Period Sales

- Business definition: won Deals whose stable `wonAt` falls in the selected range, regardless of creation date.
- Authoritative CRM evidence: frozen sale `wonAt` backed by payment or matching post-sale evidence.
- Date field: `wonAt`.
- Inclusion: `salesStatus=WON` and valid in-range `wonAt`.
- Exclusion: non-won or missing/invalid/out-of-range `wonAt`.
- Deduplication: one `dealId`; payment plus post-sale never double-counts.
- Funnel/category behavior: an older cohort may be sold now; selected Sales and matching post-sale remain one project.
- Expected invariants: selector is independent from Cohort Sales; every Period Sale is SQL.
- Known edges: population overlap with Cohort Sales is expected, not duplication. Deal `40099` is the fixed evidence check.
- Exact validator: WON plus `wonAt` bounds in `calculateCertificationMetrics().populations.periodSales`.

### Revenue

- Business definition: Period Revenue is `SUM(OPPORTUNITY)` over Period Sales; Cohort Revenue is separately summed over Cohort Sales.
- Authoritative CRM evidence: Bitrix Deal `OPPORTUNITY` and `CURRENCY_ID` stored on each won row.
- Date field: `wonAt` for Period Revenue; `createdAt` for Cohort Revenue.
- Inclusion: exactly the corresponding sales population, finite opportunity, and one nonblank currency.
- Exclusion: non-sales; mixed/missing currencies block the aggregate rather than being converted.
- Deduplication: sum once per unique `dealId`.
- Funnel/category behavior: follows the matching project’s sales evidence; Finance data and currency conversion are out of scope.
- Expected invariants: revenue equals independently summed opportunities; no mixed-currency aggregate.
- Known edges: zero-value sale is valid; invalid money or mixed currency fails certification.
- Exact validator: `moneySummary()` over each sales population.

### Manager attribution

- Business definition: seller responsible for a completed sale, kept with the evidence source used to attribute it.
- Authoritative CRM evidence: stable `salesManagerId`, `salesManager`, and `salesManagerAttribution` in the analytics/sale snapshot.
- Date field: `wonAt`; the report population is Period Sales.
- Inclusion: every Period Sale, including unknown and review-required rows.
- Exclusion: none from the population; current assignee is never substituted for an unresolved completed-sale seller.
- Deduplication: one `dealId`, grouped by seller and attribution source.
- Funnel/category behavior: later post-sale/customer-care ownership must not replace the frozen commercial seller.
- Expected invariants: seller-only changes preserve Lead, SQL, NR, Sales, Revenue and `wonAt`; manager totals reconcile to Period Sales.
- Known edges: `OWNER_CONFIRMED`, `POST_SALE_OBSERVER`, `STAGE_MOVER`, and `CUSTOM_FIELD` with complete seller identity are certified. Legacy `FIRST_CALL`, `CURRENT_RESPONSIBLE`, and `UNKNOWN` are visible but uncertified. `HUMAN_REVIEW` is a separate disposition, not an attribution source. Unexpected/structurally inconsistent rows require review; no seller is guessed.
- Exact validator: `buildManagerCertification()` and optional `compareSellerMutationIsolation()` via `--compare-input`.

### Source attribution

- Business definition: exact Bitrix standard `SOURCE_ID` and its SOURCE dictionary label, audited without silently merging raw values.
- Authoritative CRM evidence: Deal `SOURCE_ID` plus `crm.status.list` entries where `ENTITY_ID=SOURCE`.
- Date field: `createdAt`; the source funnel is cohort-based.
- Inclusion: every eligible cohort Lead grouped by exact raw ID and label.
- Exclusion: excluded/routed project membership.
- Deduplication: one `dealId` in one exact raw-source row.
- Funnel/category behavior: source is independent of stage; no UTM/custom Marketing-field fallback.
- Expected invariants: raw source deal counts reconcile to Lead; spelling clusters do not alter aggregation.
- Known edges: blank ID is `MISSING`; unresolved nonblank ID is `UNKNOWN`. Only exact audit labels for CRM-forma, Meta, Google, and organic/other are tagged. Instagram, Facebook and all other ambiguous labels remain their own `UNMAPPED` raw rows. Duplicate spellings use a diagnostic comparison key only.
- Exact validator: `buildSourceCertification()`; `sourceComparisonKey()` never changes metric grouping.

## Preserved certified reference

The default validator range is `2026-09-01..2026-09-19`, `Asia/Tashkent`:

| Metric | Certified value |
| --- | ---: |
| Lead | 470 |
| SQL | 209 |
| Not Relevant | 230 |
| Saralangan | 439 |
| Saralanmagan | 31 |
| Sales Lost | 80 |
| Cohort Sales | 41 |
| Period Sales | 42 |
| Period Revenue | 18,862,500 UZS |
| Cohort Revenue | 18,303,500 UZS |

Deal `40099` must be a Period Sale for `559,000 UZS`. It is not required to be a Cohort Sale unless its `createdAt` is also within the reference range.

Run the full certification:

```bash
npm run audit:data-certification -- \
  --input .audit/data-certification/analytics-records.json \
  --output-dir .audit/data-certification
```

Exit code `0` means every required invariant and reference check passed. Exit code `1` means a check failed. Exit code `2` means the input or command was invalid. Reports contain aggregate calculations and Deal-ID evidence, but never CRM payloads; keep them in the approved audit location.

To prove that a seller-only repair did not change non-seller facts, provide both exports:

```bash
npm run audit:data-certification -- \
  --input .audit/data-certification/after.json \
  --compare-input .audit/data-certification/before.json \
  --output-dir .audit/data-certification
```

The comparison permits changes to seller fields but fails if any Deal is added/removed or if `createdAt`, membership, quality, loss group, sale status, `wonAt`, `OPPORTUNITY`, or currency changes.

## August/September comparison

The monthly report calculates values from the supplied analytics export and contains no invented monthly references:

```bash
npm run audit:monthly-comparison -- \
  --input .audit/data-certification/analytics-records.json \
  --output-dir .audit/data-certification
```

It reports August 1–31 and September 1–30, 2026 in Tashkent time. Revenue means Period Revenue. Lead-to-SQL and Lead-to-Sale use Lead as denominator; SQL-to-Sale uses SQL. The percentages match dashboard integer rounding. A partial September sync produces a partial September report and must be labeled as such operationally; the tool does not invent missing days or targets.

## Sign-off checklist

- Confirm the export came from the released production version and the intended D1 database.
- Confirm sync completed for the required historical window and project funnels.
- Require `certificationStatus=PASS` for the fixed reference.
- Require no mixed/missing currency and no invalid/duplicate Deal rows.
- Review every manager `UNCERTIFIED` row, every `UNKNOWN`, and every `HUMAN_REVIEW` count.
- Review source `MISSING_SOURCE`, `UNKNOWN_SOURCE`, `UNMAPPED`, and duplicate-spelling diagnostics without merging them in place.
- Save only the aggregate JSON/text report in the approved audit location. Never commit the raw analytics export.

No resync is required by this toolkit itself; it only reads an export.
