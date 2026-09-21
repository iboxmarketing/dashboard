import { SafeBitrixError } from "./safe-bitrix-error";
import { SAFE_D1_WRITE_QUOTA_MESSAGE, safeD1WriteQuotaError } from "./sync-recovery";

/**
 * The only error text Sync and Backfill may return or store.
 *
 * A message passes through only if it is one of the fixed, pre-written safe
 * messages: a SafeBitrixError, or the D1 write-quota notice. Everything else —
 * SQL text, stack-ish runtime messages, driver errors — becomes the caller's
 * fixed fallback, so no raw Error.message ever reaches a response or D1.
 */
export function safeOperationMessage(error: unknown, fallback: string) {
  if (error instanceof SafeBitrixError) return error.message;
  if (error instanceof Error && error.message === SAFE_D1_WRITE_QUOTA_MESSAGE) return SAFE_D1_WRITE_QUOTA_MESSAGE;
  if (safeD1WriteQuotaError(error)) return SAFE_D1_WRITE_QUOTA_MESSAGE;
  return fallback;
}

export const SYNC_FAILED_MESSAGE = "Sinxronizatsiya bajarilmadi. Diagnostikani tekshirib qayta urinib ko‘ring.";
export const BACKFILL_FAILED_MESSAGE = "Analytics Backfill bajarilmadi. Diagnostikani tekshirib qayta urinib ko‘ring.";
