const MAX_REPAIR_DEALS = 500;

export type SellerSnapshotRepairManifest = {
  reviewed: true;
  dealIds: string[];
};

/**
 * A repair manifest is evidence, not a query. IDs must be explicitly reviewed
 * before execution; no category, manager-name or attribution-source heuristic
 * may expand this set at runtime.
 */
export function parseSellerSnapshotRepairManifest(raw: unknown): SellerSnapshotRepairManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Repair manifest must be a JSON object");
  const manifest = raw as Record<string, unknown>;
  if (manifest.reviewed !== true) throw new Error("Repair manifest must contain reviewed: true");
  if (!Array.isArray(manifest.dealIds) || !manifest.dealIds.length) throw new Error("Repair manifest must contain explicit dealIds");
  const dealIds = [...new Set(manifest.dealIds.map(String).map((id) => id.trim()))];
  if (dealIds.length > MAX_REPAIR_DEALS) throw new Error(`Repair manifest exceeds ${MAX_REPAIR_DEALS} Deal IDs`);
  if (dealIds.some((id) => !/^[1-9]\d*$/.test(id))) throw new Error("Every repair Deal ID must be a positive integer string");
  return { reviewed: true, dealIds };
}

function idList(dealIds: readonly string[]) {
  if (!dealIds.length || dealIds.some((id) => !/^[1-9]\d*$/.test(id))) throw new Error("Explicit valid Deal IDs are required");
  return dealIds.map((id) => `'${id}'`).join(", ");
}

const needsInvalidation = "manager_id IS NOT NULL OR manager_name IS NOT NULL OR attribution_source <> 'UNKNOWN'";

/** Count-only preview: it never emits names, seller IDs, or other row data. */
export function sellerSnapshotRepairPreviewSql(dealIds: readonly string[]) {
  return `SELECT COUNT(*) AS matched, COALESCE(SUM(CASE WHEN ${needsInvalidation} THEN 1 ELSE 0 END), 0) AS would_change FROM deal_sales_snapshots WHERE deal_id IN (${idList(dealIds)})`;
}

/**
 * The only mutable columns are the three seller-attribution columns. `deal_id`,
 * `won_at`, and `created_at` are intentionally absent from the SET clause.
 * The state predicate makes a repeated apply a zero-row, idempotent operation.
 */
export function sellerSnapshotInvalidationSql(dealIds: readonly string[]) {
  return `UPDATE deal_sales_snapshots SET manager_id = NULL, manager_name = NULL, attribution_source = 'UNKNOWN' WHERE deal_id IN (${idList(dealIds)}) AND (${needsInvalidation})`;
}
