/**
 * Sale snapshot persistence SQL.
 *
 * Lives in its own dependency-free module so the exact statement the worker
 * runs can also be exercised by tests; `lib/storage.ts` reaches D1 through
 * `cloudflare:workers` and cannot be loaded by the node test runner.
 *
 * Two different immutability rules are encoded here:
 *
 *  - `won_at` and `created_at` are never in the DO UPDATE SET list, so an
 *    existing sale date can never be replaced by a later recalculation;
 *  - the seller fields are updated only while the stored seller is unresolved,
 *    or when repairing the legacy CURRENT_RESPONSIBLE guess with stronger
 *    custom-field/current-payment-mover/post-sale-observer evidence.
 *
 * The guard makes the statement idempotent: once a trustworthy manager source
 * is stored the conflict clause stops matching, so repeated syncs are a no-op.
 */
export const SALES_SNAPSHOT_UPSERT = `
INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(deal_id) DO UPDATE SET
  manager_id = excluded.manager_id,
  manager_name = excluded.manager_name,
  attribution_source = excluded.attribution_source
WHERE excluded.manager_id IS NOT NULL
  AND (
    deal_sales_snapshots.manager_id IS NULL
    OR (
      deal_sales_snapshots.attribution_source = 'CURRENT_RESPONSIBLE'
      AND excluded.attribution_source IN ('CUSTOM_FIELD', 'STAGE_MOVER', 'POST_SALE_OBSERVER')
    )
  )
`;
