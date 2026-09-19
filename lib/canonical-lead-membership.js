/**
 * @typedef {"INCLUDED" | "EXCLUDED" | "UNRESOLVED"} CanonicalLeadMembership
 * @typedef {"FOUND" | "DELETED" | "UNRESOLVED"} CanonicalLeadLookupStatus
 */

/**
 * One canonical decision shared by the read-only audit and persisted dashboard
 * records. Source and failure reason are deliberately absent: they are useful
 * breakdown/evidence fields, never membership authority.
 *
 * `enteredSalesCategory` is tri-state. `undefined` means the entry evidence
 * could not be read, which must stay unresolved instead of becoming exclusion.
 * Callers decide which evidence they can trust: the audit requires an explicit
 * history row, while the analytics builder can also prove entry from a Deal
 * currently sitting in the selected Sales category.
 *
 * @param {{
 *   enteredSalesCategory: boolean | undefined;
 *   currentCategoryId?: unknown;
 *   salesCategoryIds: Iterable<unknown>;
 *   postSaleCategoryIds: Iterable<unknown>;
 *   lookupStatus?: CanonicalLeadLookupStatus;
 * }} input
 * @returns {CanonicalLeadMembership}
 */
export function decideCanonicalLeadMembership(input) {
  const lookupStatus = input.lookupStatus ?? "FOUND";
  if (lookupStatus === "DELETED") return "EXCLUDED";
  if (lookupStatus === "UNRESOLVED") return "UNRESOLVED";

  const currentCategoryId = String(input.currentCategoryId ?? "").trim();
  if (!currentCategoryId) return "UNRESOLVED";

  const sales = new Set([...input.salesCategoryIds].map(String));
  const postSale = new Set([...input.postSaleCategoryIds].map(String));
  if (input.enteredSalesCategory === undefined) return "UNRESOLVED";
  if (!input.enteredSalesCategory) return "EXCLUDED";
  return sales.has(currentCategoryId) || postSale.has(currentCategoryId)
    ? "INCLUDED"
    : "EXCLUDED";
}
