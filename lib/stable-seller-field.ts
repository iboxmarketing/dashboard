import { canonicalDealFieldKey } from "./crm-fields";

/**
 * System-owned Bitrix fields that must never masquerade as a stable seller.
 *
 * The actual safety rule is stricter than this list: only a Deal custom field
 * (`UF_CRM_*`) is accepted. Keeping the known names explicit makes diagnostics
 * and regression tests document the incident class without relying on an
 * inevitably incomplete denylist.
 */
/**
 * The canonical seller field going forward (owner decision, 2026-09-24).
 *
 * A Bitrix automation writes the current Responsible person into it when a Deal
 * enters `Оплата получена` and the field is still empty — i.e. BEFORE the
 * operator/onboarding reassignment that used to destroy the evidence. It is
 * therefore the only CRM field that records who sold the deal at the moment of
 * sale, and it is never overwritten once populated.
 */
export const SALES_OWNER_AT_WON_FIELD = "UF_CRM_1790230512";

/**
 * Deal fields that may never be offered or accepted as seller evidence, beyond
 * the structural `UF_CRM_*` rule.
 *
 * `UF_CRM_1740741551` ("Первый sales") looks like a seller field and is not:
 * the owner confirmed it carries no seller meaning, and an earlier audit found
 * it mirrored whoever held the card. Rejecting it here keeps it out of the
 * automatic suggestion, out of Settings and out of every backfill.
 */
export const REJECTED_SELLER_FIELDS = ["UF_CRM_1740741551"] as const;

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
  if (isRejectedSellerField(canonical)) return null;
  return /^UF_CRM_[A-Z0-9][A-Z0-9_]*$/i.test(canonical) ? canonical : null;
}

/** A field the owner has ruled out as seller evidence, whatever its shape. */
export function isRejectedSellerField(fieldKey: unknown): boolean {
  const canonical = canonicalDealFieldKey(typeof fieldKey === "string" ? fieldKey : "");
  return REJECTED_SELLER_FIELDS.some((field) => field.toUpperCase() === canonical.toUpperCase());
}

/**
 * The configured "Sales Owner at Won" field, or null.
 *
 * Same structural safety as any stable seller field — a Deal custom field, never
 * a system owner field — plus the rejected-field rule.
 */
export function normalizeSalesOwnerAtWonField(fieldKey: unknown): string | null {
  return normalizeSafeStableSellerField(fieldKey);
}

export function isSafeStableSellerField(fieldKey: unknown): boolean {
  if (fieldKey === null || fieldKey === undefined) return true;
  if (typeof fieldKey !== "string" || !fieldKey.trim()) return true;
  return normalizeSafeStableSellerField(fieldKey) !== null;
}
