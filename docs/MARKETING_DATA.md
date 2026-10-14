# Marketing data engine (V1)

Marketing analytics is a **dimension over the existing Deal analytics**. It adds
no Lead/SQL/Sale classifier: every outcome is read from the Deal's own
project-specific analytics record. Branch `feature/marketing-data-v1`, code in
`lib/marketing/`, APIs under `/api/marketing/`.

## Rules (owner, 2026-10-14)

| | |
| --- | --- |
| **Population** | the dashboard's cohort: eligible Deals of the project created (Tashkent date) in the range. Same Lead count as the Sales pages. |
| **Outcomes** | Saralangan, SQL, NR, Sale, Lost from the record. **In Pipeline** = SQL, still open (ACTIVE), not a sale, not lost. |
| **Revenue** | Opportunity of the cohort's Sales (UZS; USD at the marketing rate). |
| **Spend** | Meta spend delivered on the same calendar days. |
| **CMC** | Meta spend UZS ÷ attributed cohort Sales. 0 Sales → null. |
| **ROAS** | attributed cohort revenue UZS ÷ Meta spend UZS. 0 spend → null. |
| **Other costs** | CPL, cost per ICP-fit Lead, cost per SQL, cost per Sale (= CMC). |
| **Attributed** | the Deal carries a stable Meta campaign, ad set or ad ID. |
| **Period Sales** | never used for acquisition ROAS. |
| **Marketing FX** | `1 USD = 11,800 UZS` — a reporting setting (`app_settings` key `marketing`, `usdToUzs`), not Finance FX. A currency with no rate stays native and every UZS ratio on it is null. |
| **Money** | integers only: Meta spend stored as `spend_minor` + `currency`; UZS results are whole sums. |

### ICP — `UF_CRM_1787725980192` "ICP ga moslik"

| Bitrix option | ID (from metadata) | Class |
| --- | --- | --- |
| P1 (Оптовик) | 11139 | P1 — fit |
| P2 (Импортер) | 11141 | P2 — fit |
| P3 (Retail ) | 11143 | P3 — fit |
| Other | 11145 | OTHER — evaluated, not fit |
| empty | — | UNSET — reported, never in the denominator |

`ICP_FIT_RATE = (P1+P2+P3) / (P1+P2+P3+OTHER)`. IDs are resolved through the
field's metadata on every sync; none is hard-coded. Raw ID and class are both kept.

## Bitrix fields (resolved from live metadata, never guessed)

`UTM_SOURCE/MEDIUM/CAMPAIGN/CONTENT/TERM`; the tracking Worker's
`UF_CRM_META_LEAD_ID/PAGE_ID/FORM_ID/CAMPAIGN_ID/ADSET_ID/AD_ID` (its write
audit lists exactly these) and `UF_CRM_META_AD_ACCOUNT_ID`; `UF_CRM_680729666FC5E`
"utm_id" (the campaign id the Instant Form route writes); `UF_CRM_1784828015`
"Marketing: Landing"; the ICP field. A role resolves only if its field exists; a
title pattern only if exactly one field matches. The map is stored in
`crm_dictionaries.marketingFields` at every Full Sync start and added to every
Deal read (main, period-sale discovery, refresh), so `raw_deals` keeps it.

## Attribution — `marketing_deal_attribution`

One row per Deal (upsert on `deal_id`), with `project_key` from the Deal's own
analytics record. Precedence:

1. the Bitrix Deal's fields,
2. the tracking D1 (`TRACKING_DB`, **read-only**) for exactly this Deal —
   `bitrix_delivery.deal_id → meta_leads`, `meta_leads.bitrix_entity_id`, or
   `website_leads.deal_id` (last paid touch, else first touch),
3. unknown.

Tracking only fills gaps. Disagreeing stable IDs → `attribution_conflict` JSON
with both values; Bitrix stays. Both acquisition paths (Meta Instant Form,
website lead from a Meta ad) produce the same row; `channel` says which.
Raw evidence: `bitrix_evidence_json`, `tracking_evidence_json`.

Kept current by every sync analytics batch. History: `POST
/api/marketing/backfill` `{action:"start"}` then `{action:"step"}` until
`success` — resumable from its cursor (`{action:"resume"}` after an error),
idempotent.

## Meta Insights — `marketing_meta_daily`

`level=ad&time_increment=1`, one row per `(date, ad_id)`; a re-fetch replaces
that day. Spend `spend_minor` + `currency`; impressions, clicks, reach;
creative/video/image ids when Meta returns them. `project_key` from the
Marketing setting's account→project map, else the campaign's attributed Deals
when they are all in one project, else null (reported as unassigned spend).
`POST /api/marketing/meta-sync` `{action:"start", days}` then `{action:"step"}`:
7-day windows, newest first, checkpointed per account. Needs the Worker secret
`META_ADS_ACCESS_TOKEN` (ads_read); without it the job reports `blocked`.

## API (all `?project=IBOX|SALES_DOCTOR`, guarded by the `dashboard` permission)

Common inputs: `startDate`, `endDate` (YYYY-MM-DD, default last 30 days),
`source` (repeatable, Bitrix source label), `campaignId`, `adsetId`, `adId`,
`placement`, `landing`. Every response carries `project`, `range`, `filters`,
`fx`, `dataAsOf`. Values are raw numbers; formatting is the UI's job.
Placement/landing filters make spend unavailable (`spendApplies:false`) —
Meta daily rows have no such breakdown.

| Endpoint | Returns |
| --- | --- |
| `GET /api/marketing/summary` | `summary`: leadCount, saralanganCount, sqlCount, nrCount, inPipelineCount, saleCount, lostCount, revenueByCurrency, revenueUzs, attributedLeadCount, attributedSaleCount, attributedRevenueUzs, icpEvaluatedCount, icpFitCount, icpOtherCount, icpUnsetCount, icpFitRate, spendByCurrency (minor units), spendUzs, impressions, clicks, cmcUzs, roas, cplUzs, costPerIcpFitUzs, costPerSqlUzs, costPerSaleUzs, coverage {campaignIdCoverage, adsetIdCoverage, adIdCoverage} |
| `GET /api/marketing/entities?level=campaign\|adset\|ad\|creative\|placement\|landing` | `rows[]`: id, name, campaignId, adsetId (parents), leadCount, saralanganCount, icpEvaluatedCount, icpFitCount, icpUnsetCount, icpFitRate, sqlCount, inPipelineCount, saleCount, revenueUzs, spendUzs, spendByCurrency, impressions, clicks, cmcUzs, roas, cplUzs, … — `id:"__unattributed__"` holds Deals with no ID at that level |
| `GET /api/marketing/deals?metric=lead\|icp_fit\|icp_other\|icp_unset\|sql\|pipeline\|sale` | `deals[]` with outcome flags, ICP, IDs/names, channel, conflict |
| `GET /api/marketing/icp` | `icp` totals, `byChannel`, `byManager` (funnel owner) — for Overview/Managers |
| `GET /api/marketing/coverage` | `coverage` {deals, withCampaignId, withAdsetId, withAdId, metaInstantForm, website, otherSource, unknown, conflicts, notYetAttributed}, `unassignedSpend` |
| `POST /api/marketing/backfill`, `/meta-sync`, `/settings` | jobs and the Marketing setting (`settings` permission) |

## Operations

- Migration `drizzle/0015_marketing_data.sql` — additive (two tables, indexes);
  the code also creates them on first use.
- Deploy with `CLOUDFLARE_TRACKING_D1_ID=ba59e4d6-4e05-4536-8562-469198a261bd`
  to bind the tracking D1 as `TRACKING_DB`; without it the fallback is skipped.
- Secret `META_ADS_ACCESS_TOKEN` on the dashboard Worker for Insights.
