import { canonicalDealFieldKey } from "./crm-fields";

/**
 * System-owned Bitrix fields that must never masquerade as a stable seller.
 *
 * The actual safety rule is stricter than this list: only a Deal custom field
 * (`UF_CRM_*`) is accepted. Keeping the known names explicit makes diagnostics
 * and regression tests document the incident class without relying on an
 * inevitably incomplete denylist.
 */
export const UNSAFE_STABLE_SELLER_FIELDS = [
  "ASSIGNED_BY_ID",
  "MOVED_BY_ID",
  "CREATED_BY_ID",
  "MODIFY_BY_ID",
  "LAST_ACTIVITY_BY",
  "LAST_ACTIVITY_BY_ID",
  "OBSERVER",
  "OBSERVERS",
  "OBSERVER_IDS",
  "OBSERVERS_IDS",
] as const;

/** Null/blank means automatic evidence resolution and is deliberately safe. */
export function normalizeSafeStableSellerField(fieldKey: unknown): string | null {
  if (fieldKey === null || fieldKey === undefined) return null;
  if (typeof fieldKey !== "string") return null;
  const canonical = canonicalDealFieldKey(fieldKey);
  if (!canonical) return null;
  return /^UF_CRM_[A-Z0-9][A-Z0-9_]*$/i.test(canonical) ? canonical : null;
}

export function isSafeStableSellerField(fieldKey: unknown): boolean {
  if (fieldKey === null || fieldKey === undefined) return true;
  if (typeof fieldKey !== "string" || !fieldKey.trim()) return true;
  return normalizeSafeStableSellerField(fieldKey) !== null;
}
