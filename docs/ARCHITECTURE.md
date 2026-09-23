# Architecture

## Runtime

The application is built with Vinext and Vite and emits a Cloudflare Worker-compatible server bundle. ChatGPT Sites provides:

- the production deployment;
- a D1 database bound as `DB`;
- the server-side `BITRIX24_WEBHOOK_URL` runtime secret;
- Site ownership, access policy, versions and URL.

The browser never receives the webhook URL. All Bitrix REST calls go through server API routes.

## Data flow

```text
Bitrix24 REST
  ├─ selected Sales + matching post-sale deals
  ├─ universal Deal `observers` for current post-sale seller handoff evidence
  ├─ activities and outgoing calls
  ├─ stage history
  ├─ telephony statistics
  └─ users, stages, sources and custom-field dictionaries
          ↓
chunked/resumable sync (`lib/sync.ts`)
          ↓
D1 raw cache + settings + stable sale snapshots
          ↓
analytics record builder (`lib/analytics.ts`)
          ↓
D1 `analytics_records`
          ↓
dashboard API and client views
```

Current stage inventory follows a separate path:

```text
Bitrix open deals in selected Sales funnels
          ↓ minimal live query, no DATE_CREATE limit
`/api/current-stages`
          ↓
live stage controls + reconciliation with analytics cache
```

This separation prevents historical import limits from understating current workload.

## Sync phases

1. `deals` — selected Sales Lead scope, plus bounded sale-event discovery, and
   in a Full Sync a final `refresh` scope:
   configured payment-stage history, current payment-stage `MOVED_TIME`, and
   matching post-sale transitions. The event streams are independent of a
   Deal's `DATE_CREATE` and converge on the same `raw_deals` row by Deal ID.
   Current post-sale Deals are enriched through `crm.item.list` (`entityTypeId:
   2`, `select: ["id", "observers"]`) because `observers` is the documented
   universal `user[]` field and is not guessed from a legacy Deal field name.
   The Full Sync `refresh` scope (`lib/known-deal-refresh.ts`) then re-reads by
   ID every Deal D1 already knows but those queries did not return — a Deal that
   moved to another project's funnel, or a sale snapshot with no raw row — so it
   is rebuilt from current evidence by the current analytics version instead of
   surviving as a stale row. A Deal Bitrix does not list is asked for with
   `crm.deal.get`: only a definitive NOT_FOUND marks it unavailable, and each
   outcome is recorded in `crm_dictionaries` under `refreshAudit:<pipelineId>`.
   Nothing is deleted, and a Deal decided EXCLUDED writes no sale snapshot.
2. `activities` — activity data in bounded deal batches.
3. `stageHistory` — stage movement per deal.
4. `telephony` — call-result enrichment.
5. `lookups` — dictionaries and field metadata.
6. `analytics` — canonical record construction and persistence.
7. `done` — stable sync state saved.

Jobs are resumable and stored in D1. Sync is scoped to one selected Sales pipeline at a time to avoid loading all Bitrix funnels.

This split is intentional: the main Full Sync query remains `DATE_CREATE`-based
for historical Lead cohorts, while payment/post-sale discovery uses event time
so Period Sales and revenue can include an older-created Deal sold during the
window. Analytics still derives `wonAt` only from full stage history or current
payment-stage `MOVED_TIME`; discovery does not itself invent a sale date.

## Persistence

Important tables:

- `app_settings` — funnel selection, fields, SLA and stage limits;
- `raw_deals`, `raw_activities`, `raw_stage_history`, `raw_call_stats` — synchronized inputs;
- `crm_dictionaries` — cached Bitrix lookup values;
- `analytics_records` — flattened report records;
- `deal_sales_snapshots` — stable won date and seller attribution, each carrying
  a certification on read (`lib/seller-evidence.ts`) that decides whether it may
  appear on an employee scorecard; resolved
  seller values are immutable, while legacy `CURRENT_RESPONSIBLE` guesses may
  be upgraded only by stronger custom-field/current-payment evidence;
- `sync_jobs`, `sync_state` — resumable job and visible progress;
- `provider_rules`, `provider_diagnostics` — telephony filtering and diagnostics.

Schema upgrades live in `drizzle/`. Do not edit a shipped migration.

## Security boundaries

- GitHub: source, migrations, tests, docs; no production data or secrets.
- ChatGPT Sites: production access, D1 data and runtime secret.
- Bitrix24: operational source of truth.
- Browser: receives only safe dashboard JSON and safe Bitrix detail links.

Server errors must sanitize webhook URLs and avoid returning raw credential-bearing messages.

## Portability

The source is portable, but the hosted state is not automatically cloned. A new host must provide:

- a Cloudflare-compatible Worker runtime;
- a D1-compatible database binding named `DB` or an intentional storage adapter;
- migrations from `drizzle/`;
- `BITRIX24_WEBHOOK_URL` as a server-side secret;
- a fresh selected-funnel sync.

Do not point two production deployments at uncontrolled concurrent syncs without deciding which instance owns the analytics cache.
