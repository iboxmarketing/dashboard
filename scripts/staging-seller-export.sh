#!/usr/bin/env bash
# Read-only staging export for the seller certification lane.
#
# Every statement below is a SELECT. Nothing is written to D1 or Bitrix, and no
# sync, backfill or deploy is started. A test asserts this file contains no
# write verb.
#
#   bash scripts/staging-seller-export.sh            # export only
#
# Output lands in .audit/staging-in/ (git-ignored). Production is never read:
# staging repair decisions must not depend on the production snapshot table.
set -euo pipefail

db="${STAGING_D1_NAME:-ibox-dashboard-staging}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${root}/.audit/staging-in"
mkdir -p "$out"

run() { # run <file> <sql>
  echo "  -> $1"
  npx --yes wrangler@latest d1 execute "$db" --remote --json --command "$2" > "${out}/$1"
}

echo "Read-only staging export from ${db}"

run snapshots.json \
  "SELECT deal_id, won_at, manager_id, manager_name, attribution_source, created_at FROM deal_sales_snapshots"

run deals.json \
  "SELECT deal_id, json_extract(payload,'\$.CATEGORY_ID') AS cat, json_extract(payload,'\$.STAGE_ID') AS stage, json_extract(payload,'\$.DATE_CREATE') AS created, json_extract(payload,'\$.MOVED_TIME') AS moved_time, json_extract(payload,'\$.MOVED_BY_ID') AS moved_by, json_extract(payload,'\$.ASSIGNED_BY_ID') AS assigned, json_extract(payload,'\$.OPPORTUNITY') AS opportunity, json_extract(payload,'\$.CURRENCY_ID') AS currency, json_extract(payload,'\$.SOURCE_ID') AS source, json_extract(payload,'\$.observers') AS observers FROM raw_deals"

run history.json \
  "SELECT deal_id, MIN(CASE WHEN json_extract(payload,'\$.STAGE_ID') IN ('C3:WON','C5:WON') THEN json_extract(payload,'\$.CREATED_TIME') END) AS payment_at, MIN(CASE WHEN json_extract(payload,'\$.CATEGORY_ID')=13 THEN json_extract(payload,'\$.CREATED_TIME') END) AS post_sale_at, MIN(CASE WHEN json_extract(payload,'\$.CATEGORY_ID')=3 THEN json_extract(payload,'\$.CREATED_TIME') END) AS sales_at, COUNT(*) AS rows FROM raw_stage_history GROUP BY deal_id"

run footprint.json \
  "SELECT json_extract(payload,'\$.ASSIGNED_BY_ID') AS mid, json_extract(payload,'\$.CATEGORY_ID') AS cat, COUNT(*) AS n FROM raw_deals GROUP BY mid, cat"

run users.json "SELECT payload FROM crm_dictionaries WHERE key='users'"

run progress.json \
  "SELECT (SELECT COUNT(*) FROM deal_sales_snapshots) AS snaps, (SELECT COUNT(*) FROM analytics_records) AS analytics, (SELECT COUNT(*) FROM raw_deals) AS raws, (SELECT COUNT(DISTINCT deal_id) FROM raw_stage_history) AS history_deals, (SELECT COUNT(*) FROM raw_deals WHERE payload LIKE '%bserver%') AS observers, (SELECT payload FROM sync_jobs ORDER BY updated_at DESC LIMIT 1) AS job"

echo "Done. Exports in ${out}"
