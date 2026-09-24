/**
 * Admin seller-confirmation persistence SQL.
 *
 * In its own dependency-free module for the same reason as
 * `lib/sales-snapshots.ts`: `lib/storage.ts` reaches D1 through
 * `cloudflare:workers` and cannot be loaded by the node test runner, while this
 * statement encodes a rule that must be provable — a confirmation whose Bitrix
 * write succeeded may never be replaced by one that did not.
 *
 * Bound parameters: deal_id, seller_id, seller_name, confirmed_by, confirmed_at,
 * prior_evidence, bitrix_write_status, bitrix_write_at, bitrix_error_code, and
 * finally 1 when the incoming write succeeded (0 otherwise).
 *
 * A first attempt always inserts, so a failure is still recorded and visible.
 * After that the row moves only towards a successful confirmation: the earliest
 * `prior_evidence` is kept, because it describes what the Deal claimed before any
 * human touched it.
 */
export const SELLER_CONFIRMATION_UPSERT = `
INSERT INTO seller_confirmations(deal_id, seller_id, seller_name, confirmed_by, confirmed_at, prior_evidence, bitrix_write_status, bitrix_write_at, bitrix_error_code)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(deal_id) DO UPDATE SET
  seller_id = excluded.seller_id,
  seller_name = excluded.seller_name,
  confirmed_by = excluded.confirmed_by,
  confirmed_at = excluded.confirmed_at,
  prior_evidence = COALESCE(seller_confirmations.prior_evidence, excluded.prior_evidence),
  bitrix_write_status = excluded.bitrix_write_status,
  bitrix_write_at = excluded.bitrix_write_at,
  bitrix_error_code = excluded.bitrix_error_code
WHERE ? = 1
  OR COALESCE(seller_confirmations.bitrix_write_status, '') NOT IN ('WRITTEN', 'ALREADY_SET')
`;

/** Write statuses that mean the CRM carries this seller. */
export const SUCCESSFUL_WRITE_STATUSES = ["WRITTEN", "ALREADY_SET"] as const;

export function writeSucceeded(status: string | null | undefined) {
  return SUCCESSFUL_WRITE_STATUSES.includes(String(status ?? "") as typeof SUCCESSFUL_WRITE_STATUSES[number]);
}
