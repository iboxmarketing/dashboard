/** Stable ordering is mandatory because analytics resumes by OFFSET cursor. */
export const ANALYTICS_PAGE_ORDER_BY = "created_at DESC, deal_id DESC";

export function analyticsPageSql(batchSize: number) {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  return `SELECT deal_id, payload FROM raw_deals WHERE synced_at = ? ORDER BY ${ANALYTICS_PAGE_ORDER_BY} LIMIT ${safeBatchSize} OFFSET ?`;
}

export const SAFE_D1_WRITE_QUOTA_MESSAGE =
  "D1_WRITE_QUOTA_EXHAUSTED: D1 kunlik yozuv limiti tugagan; mavjud analytics checkpoint saqlandi va shu run kvota yangilangach davom ettirilishi mumkin.";

/**
 * A quota failure cannot itself be persisted because every attempted write is
 * rejected. Detect it before the generic error recorder tries two more writes,
 * and surface only a fixed, credential-free operator message.
 */
export function safeD1WriteQuotaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!/D1(?:_ERROR)?.*?(?:daily row write limit|free tier daily row write limit|write quota)/i.test(message)) return null;
  return new Error(SAFE_D1_WRITE_QUOTA_MESSAGE);
}
