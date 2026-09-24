/**
 * One identity for a manager row: the Bitrix user ID.
 *
 * A production defect this module exists to prevent: a row's display name was
 * resolved with an UNBOUND lookup — "the first row that happens to carry a seller
 * name" — so two different user IDs could render the same name, and clicking the
 * duplicate opened a third person's profile. Aggregation, the displayed name and
 * the navigation target must all come from the same ID.
 *
 * Every candidate below is matched against the row's OWN id fields. Nothing here
 * falls back to another row's name, to array order, or to a name string: an id
 * with no name in the data reads as `Menejer #<id>`, which is still that id.
 */

export type ManagerNameRow = {
  funnelOwnerId?: string | null;
  funnelOwnerName?: string | null;
  salesManagerId?: string | null;
  salesManager?: string | null;
  assignedManagerId?: string | null;
  assignedManager?: string | null;
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

/** `Menejer #7` — honest about the identity when no name is available. */
export function managerFallbackLabel(id: string) {
  return `Menejer #${id}`;
}

/**
 * The name that belongs to `id`, or a label naming that id.
 *
 * `bucketLabels` covers the non-person buckets (review / unknown), which are keys
 * rather than user IDs and therefore have fixed labels.
 */
export function resolveManagerName(
  id: string,
  rows: readonly ManagerNameRow[],
  bucketLabels: Record<string, string> = {},
): string {
  if (bucketLabels[id]) return bucketLabels[id];
  const wanted = text(id);
  if (!wanted) return bucketLabels.unknown ?? "Aniqlanmagan";
  for (const row of rows) {
    if (text(row.funnelOwnerId) === wanted && text(row.funnelOwnerName)) return text(row.funnelOwnerName);
  }
  for (const row of rows) {
    if (text(row.salesManagerId) === wanted && text(row.salesManager)) return text(row.salesManager);
  }
  for (const row of rows) {
    if (text(row.assignedManagerId) === wanted && text(row.assignedManager)) return text(row.assignedManager);
  }
  return managerFallbackLabel(wanted);
}

/**
 * Guard for tests and diagnostics: does every row's name belong to its own id?
 *
 * Returns the rows where a name appears under an id that no record associates it
 * with — the shape of the duplicate-row defect.
 */
export function unboundManagerNames(
  built: readonly { id: string; name: string }[],
  rows: readonly ManagerNameRow[],
  bucketLabels: Record<string, string> = {},
) {
  return built.filter((entry) => entry.name !== resolveManagerName(entry.id, rows, bucketLabels));
}
