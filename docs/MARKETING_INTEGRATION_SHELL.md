# Marketing integration shell

Branch: `feature/marketing-integration-shell`. This document records the UI ↔
data-branch binding only. It changes no calculation, persistence or sync rule.

## Adapter boundary

Marketing components receive `MarketingDataAdapter`. Since the V1 integration
(`feature/marketing-v1-integration`) the composition root constructs
`HttpMarketingAdapter`; `FixtureMarketingAdapter` remains for tests and demos only
(a test fails if runtime code imports it).

| Adapter method | HTTP endpoint |
| --- | --- |
| `getSummary` | `GET /api/marketing/summary` |
| `getEntities` | `GET /api/marketing/entities` |
| `getDeals` | `GET /api/marketing/deals` |
| `getIcp` | `GET /api/marketing/icp` |
| `getCoverage` | `GET /api/marketing/coverage` |

Every request forwards `workspace`, `startDate`, `endDate`, `source`,
`campaignId`, `adsetId`, `adId`, `placement` and `landing`. Entity requests add
`level`; Deal requests add `metric`. `platform` remains URL/UI state but is not
sent because the agreed backend query does not accept it.

## Known bindings

- `saralanganCount` → the UI's classified count.
- `inPipelineCount` → the UI's pipeline count.
- `revenueUzs`, `spendUzs`, `cmcUzs`, `roas`, `cplUzs`,
  `costPerIcpFitUzs`, `costPerSqlUzs` are displayed as supplied.
- `icpFitRate` and coverage rates remain 0..1 API ratios; converting them to a
  percent string is formatting, not a recomputation.
- The API does not return Lead→SQL or SQL→Sale rates. HTTP mode deliberately
  omits those secondary labels instead of calculating them in React.
- `/api/marketing/icp` returning `icpStatus: NOT_APPLICABLE`, and the
  `ICP_NOT_APPLICABLE` error from an ICP Deal request, are expected capability
  states. Reserved KZ workspaces return `WORKSPACE_NOT_ACTIVATED` until enabled.

## Bound in V1 (backend supplies, UI only formats)

- `costStatus` per summary/entity row: `NOT_INGESTED`, `PENDING`, `NOT_APPLICABLE`,
  `CURRENCY_UNAVAILABLE`, `NO_SPEND`, `NO_SALES`, `AVAILABLE`. Null is never shown as 0.
- `saralanganRate` (of Lead), `sqlRate` (of Saralangan), `saleRate` (of SQL);
  `icpEvaluationShare` (ICP evaluated of Lead, IBOX_UZ only) for the coverage warning.
- `options` on summary (sources, campaigns, ad sets constrained by campaign, ads
  constrained by ad set, placements, landing). `platforms` is empty: not a
  backend dimension yet, so the Platform filter is hidden.
- `spendAttribution` (assigned to this workspace, other workspaces, MIXED,
  UNASSIGNED, NON_DASHBOARD) for the "Data quality / Attribution coverage" area,
  `meta` (Meta status, stored range, updated time) and `fx.usdToUzs`.
- Deal rows: manager name, CRM source, sale date. ICP by manager: names.

Spend shown in a workspace is "Biriktirilgan reklama xarajati": only ads whose Deals
map to that workspace. Unassigned and mixed spend are never in its CMC/ROAS.
