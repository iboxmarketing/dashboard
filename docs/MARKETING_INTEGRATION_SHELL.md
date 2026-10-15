# Marketing integration shell

Branch: `feature/marketing-integration-shell`. This document records the UI ↔
data-branch binding only. It changes no calculation, persistence or sync rule.

## Adapter boundary

Marketing components receive `MarketingDataAdapter`. The local composition root
currently constructs `FixtureMarketingAdapter`; after the data branch is merged,
the mechanical activation is to construct `HttpMarketingAdapter` instead.

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

## Backend fields still optional

The shell works safely without these fields, but the final data merge should
bind them if richer UI is required:

- `options` on summary (source/platform/entity filter option labels). Without
  it, URL filters and drilldown work, but HTTP mode has no dropdown catalogue.
- `costStatus` or `metaStatus` to distinguish Meta disconnected and ingestion
  pending from a legitimate no-spend response. The shell already recognizes
  `META_NOT_CONNECTED`, `PENDING`, `NO_SPEND`, `NO_SALES`,
  `CURRENCY_UNAVAILABLE` and `NOT_APPLICABLE`; current backend numbers safely
  infer only no-spend/no-sales/currency/not-applicable.
- Deal manager display name, canonical source, platform and sale date. Current
  HTTP rows fall back to the supplied manager ID and attribution channel and do
  not invent missing values.

No database change or resync is required for this shell.
