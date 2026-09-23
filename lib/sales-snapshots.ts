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
 *    custom-field/current-payment-mover/post-sale-observer evidence;
 *  - OWNER_CONFIRMED is the strongest seller source. Only the reviewed owner
 *    registry (lib/seller-overrides.ts) emits it, one explicit Deal at a time,
 *    so it may replace any stored seller — including a known-bad legacy
 *    CUSTOM_FIELD/FIRST_CALL — and nothing else may ever overwrite it. A
 *    changed registry entry (a new OWNER_CONFIRMED value) is the only way to
 *    move an owner-confirmed seller.
 *
 * The guard makes the statement idempotent: once a trustworthy manager source
 * is stored the conflict clause stops matching, so repeated syncs are a no-op.
 * An owner confirmation already stored with the same seller is not rewritten,
 * so repeated Backfills spend no D1 writes on it.
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
    (
      excluded.attribution_source = 'OWNER_CONFIRMED'
      AND NOT (
        deal_sales_snapshots.attribution_source = 'OWNER_CONFIRMED'
        AND deal_sales_snapshots.manager_id IS excluded.manager_id
        AND deal_sales_snapshots.manager_name IS excluded.manager_name
      )
    )
    OR (
      deal_sales_snapshots.attribution_source IS NOT 'OWNER_CONFIRMED'
      AND (
        deal_sales_snapshots.manager_id IS NULL
        OR (
          deal_sales_snapshots.attribution_source = 'CURRENT_RESPONSIBLE'
          AND excluded.attribution_source IN ('CUSTOM_FIELD', 'STAGE_MOVER', 'POST_SALE_OBSERVER')
        )
      )
    )
  )
`;

/**
 * Which rebuilt records may create or update a sale snapshot: a sale with a
 * date, whose Deal belongs to the project. A Deal decided EXCLUDED — one that
 * sits in another project's funnel — is not this project's sale, so a Full
 * Sync that rebuilds it must not freeze another project's seller into the
 * snapshot table. If it later returns to the project it is rebuilt INCLUDED
 * and snapshotted then, under the normal attribution order.
 */
export function isSnapshotCandidate(record: { salesStatus: string; wonAt: string | null; projectLeadMembership?: string | null }) {
  return record.salesStatus === "WON" && Boolean(record.wonAt) && record.projectLeadMembership !== "EXCLUDED";
}
