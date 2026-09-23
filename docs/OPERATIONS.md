# Operations and continuity

## Normal production workflow

1. Create a short-lived branch in the private GitHub repository.
2. Make the smallest change that satisfies the metric requirement.
3. Add or update regression tests.
4. Run `npm run verify`.
5. Open a pull request and document whether a resync is required.
6. Merge only after the calculation semantics are reviewed.
7. From the Site owner/editor account, reopen the existing ChatGPT Site and checkpoint the approved commit.
8. Verify the Sites deployment status and then compare one representative number with Bitrix.

## Git remotes

Preserve both remotes:

```text
origin  → ChatGPT Sites internal source repository
github  → private portable backup/collaboration repository
```

Typical synchronization:

```bash
git fetch origin
git fetch github
git push github main
```

Do not force-push `main`. Use a pull request for changes created outside the Site checkout.

## If the current ChatGPT account reaches its work limit

- The live deployment and D1 state remain separate from the coding session.
- Continue code work through GitHub with Claude, another AI tool or an engineer.
- Keep changes in a pull request; do not invent production values for testing.
- When the owner account is available again, fetch/merge the reviewed commit and publish it to the existing Site.
- If eligible, the owner may use additional Codex credits rather than moving the deployment.

## If a second personal ChatGPT account must take over immediately

A GitHub repository transfers source, not ownership of the existing ChatGPT Site.

1. Create a new Site from the repository.
2. Let the new Sites workflow create its own `.openai/hosting.json` identity. Never invent or reuse an opaque project ID across accounts.
3. Configure a new server-side `BITRIX24_WEBHOOK_URL` secret.
4. Apply the D1 migrations.
5. Select the IBOX Sales and matching post-sale funnels in Settings.
6. Run a fresh full sync for the required history window.
7. Validate current stage reconciliation and core business-rule fixtures.
8. Only then switch users to the replacement URL.

The original URL can be updated only by its Site owner or an authorized editor in the same supported workspace.

## Claude or another coding agent

Give the agent repository access, not the production webhook. Its first instruction should be:

> Read `CLAUDE.md`, `AGENTS.md` and all files in `docs/` before changing code. Preserve the business rules and run `npm run verify`.

The agent may prepare pull requests. It cannot manage the original ChatGPT Site unless it operates through an authorized Site owner/editor workflow.

## Secrets

Only one application secret is currently required:

```text
BITRIX24_WEBHOOK_URL
```

Rules:

- store production value only in ChatGPT Sites runtime secrets;
- use ignored `.env.local` for local development;
- never commit `.env.local`, `.dev.vars`, webhook screenshots or database dumps;
- rotate the Bitrix incoming webhook immediately if a real URL reaches GitHub, an AI prompt or logs;
- run `npm run secrets:check` before pushing.

## Read-only IBOX Lead evidence extraction

The standalone audit CLI discovers every Deal ID returned by Bitrix stage
history for one explicitly supplied IBOX Sales category. It then performs a
current read of every discovered Deal, applies the original `DATE_CREATE` in
`Asia/Tashkent`, decides membership from the Deal's current funnel (IBOX Sales
or the supplied post-sale funnel stay included; any other funnel is excluded),
uses the failure reason only as supporting evidence, and writes `INCLUDED`, `EXCLUDED`, and `UNRESOLVED` evidence.
It does not read or write D1 and does not invoke dashboard Sync or Backfill.

Run it only from an authorized environment where `BITRIX24_WEBHOOK_URL` is
already configured. Never put the webhook on the command line:

```bash
npm run audit:ibox-leads -- \
  --category-id <IBOX_SALES_CATEGORY_ID> \
  --post-sale-category-id <IBOX_POST_SALE_CATEGORY_ID> \
  --failure-reason-field <UF_CRM_FAILURE_REASON_FIELD> \
  --from YYYY-MM-DD \
  --to YYYY-MM-DD
```

Both JSON and text results are written with local-only permissions under
`.audit/ibox-lead-evidence/`, which is git-ignored. The output deliberately
contains Deal IDs and audit classifications but no webhook URL or customer
payloads. Stage-history pages and Deal lookups use bounded backoff only for
rate limits, temporary network errors and HTTP 502/503/504 responses. Permanent
errors are not retried. The summary groups unresolved Deal IDs by error code.
A result of `COMPLETE_WITH_UNRESOLVED` must not be accepted as a
fully reconciled ID set until each unresolved lookup or field value is resolved.

## Database and recovery

GitHub stores migrations, not D1 rows. Most analytics data is recoverable from Bitrix with a full selected-funnel sync. Settings must be re-entered on a new database:

- selected Sales and post-sale funnels;
- SQL stage(s);
- failure reason field;
- Marketing channel field;
- Sales manager field when used;
- stage limits, work schedule, holidays and SLA;
- routing patterns and telephony provider rules.

Capture these values in an internal password manager/runbook, never in a public or AI-readable repository.

## Repairing Period Sales coverage

After deploying sale-event discovery, run one Full Sync for a history window
that covers the required `wonAt` dates. Full Sync keeps Lead discovery based on
`DATE_CREATE`, but also scans configured payment-stage entries, current payment
stages by `MOVED_TIME`, and matching post-sale transitions inside that window.
This discovers older-created Deals such as a prior-month Lead paid this month.

Backfill alone cannot repair a missing Period Sale: it performs no Bitrix calls
and only rebuilds raw Deals already stored in D1. A normal incremental Sync will
cover new sale events after its checkpoint, but cannot recover an event that is
already older than that checkpoint. Use Full Sync once for historical repair;
do not run Backfill as a substitute.

API-volume impact is bounded by the selected time window. Sync adds one paged
payment-history scan and one paged current-payment scan; the existing paged
post-sale transition scan remains. Candidate Deal IDs are deduplicated against
the current run before Deal details and full history are fetched, so payment
plus post-sale evidence does not multiply analytics rows.

## Repairing seller attribution semantics

Seller attribution is stored in each analytics payload. Version 10's unsafe
seller-field guard could be rebuilt from existing raw data, but version 11 adds
new Bitrix evidence: the universal Deal `observers` user list. Run one Full Sync
after deploying version 11 so every relevant current post-sale raw Deal stores
that evidence. Analytics Backfill does not call Bitrix and cannot populate a
missing observer list by itself.

Staging recovery order for version 11 is controlled:

1. deploy the observer-aware Worker with `salesManagerField` still null;
2. run one Full Sync whose history window covers the reviewed repair Deals and
   wait for success;
3. reconcile the approved core KPI/Deal-ID reference before seller mutation;
4. dry-run the conservative reviewed seller manifest and review requested,
   matched, missing and would-change counts;
5. only after explicit approval, apply that exact manifest;
6. run Analytics Backfill so invalidated rows can resolve from an
   `OWNER_CONFIRMED` registry entry, payment-stage mover or the persisted
   post-sale observer; human-review rows omitted from the manifest retain their
   frozen snapshots because they were never invalidated;
7. reconcile seller attribution and repeat the unchanged core KPI check.

Do not run the seller repair before the Full Sync: an old raw Deal without an
`observers` property cannot distinguish “not fetched” from “no observers.”

The normal rebuild ignores legacy snapshots sourced only from
`CURRENT_RESPONSIBLE`; those records resolve from stronger evidence or move to
the explicit Unknown seller bucket. Correct `CUSTOM_FIELD`, `STAGE_MOVER` and
`POST_SALE_OBSERVER` snapshots remain frozen. `OWNER_CONFIRMED` snapshots come
only from `lib/seller-overrides.ts`, replace any stored seller for that one
Deal, and are never overwritten afterwards; adding or changing an owner
confirmation is a reviewed code change followed by a Backfill. An old `STAGE_MOVER` snapshot captured after the Deal
had already entered post-sale cannot be distinguished from one captured in the
payment stage with the current schema. Those exceptional rows require an
evidence-led audit/correction; neither Backfill nor Full Sync can safely guess
them. Do not delete or bulk-rewrite snapshots merely to remove Unknown values.

### Targeted invalidation of reviewed bad seller snapshots

When an evidence audit proves that specific snapshot seller values came from an
unsafe historical configuration (for example `ASSIGNED_BY_ID`) or a legacy
`FIRST_CALL` source, repair only an explicit reviewed Deal-ID manifest. Never
derive the execution set from a category, seller name or attribution source.

The local-only manifest shape is:

```json
{
  "reviewed": true,
  "dealIds": ["12345", "12346"]
}
```

Keep live manifests out of Git. The command is dry-run by default and prints
counts only — no seller names, seller IDs or secrets:

```bash
npm run repair:seller-snapshots -- \
  --manifest /secure/path/reviewed-seller-repair.json \
  --target staging \
  --database ibox-dashboard-staging \
  --config wrangler.generated.jsonc \
  --dry-run
```

After reviewing the count, repeat with `--apply` instead of `--dry-run`. The
config is rejected unless both its Worker name and D1 database name match the
explicit target. Production additionally requires `--confirm-production` and a
production-specific config; never reuse a staging config for production.

Apply changes only `manager_id`, `manager_name` and `attribution_source` in
`deal_sales_snapshots`, setting them to `NULL`, `NULL` and `UNKNOWN`. The SQL
does not update `deal_id`, `won_at` or `created_at`, and its state predicate
makes repeat execution a zero-row no-op. Run Analytics Backfill afterward so
the analytics payload resolves trustworthy current-payment evidence or reports
the seller honestly as `Aniqlanmagan`.

## Rolling back a release that changed stored analytics semantics

`qualified` and the fields derived from it are **computed during sync and stored
on the record**, so an analytics-version bump plus a backfill changes data, not
just code. Code and data must then be rolled back together.

A code-only rollback is safe **only before the backfill starts**. Once
version-6 records exist, the old Worker reads them with the old rules, and the
two disagree. Concretely, the old `isSalesLost` is `lossReasonGroup === "SALES"`
with no `qualified` requirement, so on the 2026-08 production cohort:

| Combination | SQL | Sotilmadi | rate |
| --- | --- | --- | --- |
| old code + v5 data (before release) | 249 | 124 | 50% |
| new code + v6 data (target) | 167 | 42 | 25% |
| **old code + v6 data (code-only rollback)** | **167** | **124** | **74%** |

The last row is a state neither rule produces by design: the 82 pre-SQL closures
are excluded from SQL but still counted in Sotilmadi. Do not describe that as a
restored dashboard.

**Rollback matrix**

| Situation | Action |
| --- | --- |
| Failure **before** any backfill write | Worker rollback alone is sufficient. |
| Failure during/after backfill, corrected data acceptable | Stay on the new Worker. Resume the backfill from its stored cursor, or leave it partially rebuilt — records stay individually consistent and the legacy banner flags the v5/v6 mix. |
| Full **old** semantics required | Worker rollback **and** D1 Time Travel restore to the pre-backfill bookmark. Both, always. |

Take the bookmark immediately before the first backfill write and keep it with
the release notes:

```
wrangler d1 time-travel info ibox-dashboard-production            # record the bookmark
wrangler d1 export ibox-dashboard-production --remote --output <path>   # optional second copy
wrangler d1 time-travel restore ibox-dashboard-production --bookmark=<id>
```

A full Bitrix re-sync is **not** a rollback: it re-derives records with whatever
code is deployed, so it cannot restore the previous semantics and it is exactly
the load this release avoids. The export contains hashed share tokens only and no
webhook, but it is still production data — keep it out of the repository.

## Release checklist

- [ ] PR explains numerator, denominator and date basis.
- [ ] Live vs historical semantics are labeled correctly.
- [ ] Business-rule test added/updated.
- [ ] `npm run verify` passes.
- [ ] No secret or production data is tracked.
- [ ] Migration is additive and reviewed, if present.
- [ ] Resync requirement is stated.
- [ ] If persisted analytics semantics changed: ANALYTICS_VERSION bumped, a pre-backfill Time Travel bookmark recorded, and `autoSyncMinutes` set to 0 for the backfill window.
- [ ] Site deployment reaches `succeeded`.
- [ ] One Bitrix number is manually reconciled after deploy.

## Full Sync refresh of previously known Deals

A Full Sync clears and re-reads only the scoped funnels, so before this step a
Deal that had moved to another project's funnel kept whatever analytics row it
last received — counted through the legacy membership fallback — and a sale
snapshot with no raw row stayed invisible. The Full Sync now ends with a
`refresh` scope (`lib/known-deal-refresh.ts`) that re-reads every such Deal by
ID and rebuilds it at the current analytics version.

Reading the evidence afterwards, read-only:

```bash
wrangler d1 execute <database> --remote --json --command \
  "SELECT json_extract(value,'\$.runId') run,
          (SELECT count(*) FROM json_each(json_extract(value,'\$.entries'))) entries
     FROM crm_dictionaries WHERE key = 'refreshAudit:3'"
```

Per-Deal outcomes live in the same row: `REFRESHED` (rebuilt this run, with the
category Bitrix returned), `NOT_FOUND` (definitively gone — current scope set to
`UNAVAILABLE`, nothing deleted), `FOUND_NOT_LISTED` (a visibility question for a
human) and `LOOKUP_ERROR` (no answer; the stored record is untouched).

Diagnostics shows two counts for records older than persisted membership:
"needs refresh" (kept as unresolved) and "other project" (excluded by their last
known category). Both should be zero after a Full Sync; a non-zero "needs
refresh" means Leads are still resting on legacy evidence.
