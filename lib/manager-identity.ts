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
 * A stored label that carries no name: the fallback the writer uses when its user
 * lookup missed (`Menejer #<id>`), or the unknown marker. Such a label never wins
 * over a real name for the same id.
 */
export function isPlaceholderManagerName(name: unknown) {
  const value = text(name);
  return !value || /^Menejer #\S+$/u.test(value) || value === "Aniqlanmagan";
}

/**
 * The current canonical names, by Bitrix user ID, for ONE project:
 *  roster — that project's owner-approved Sales roster (its own spelling);
 *  users  — the Bitrix users directory as last synced.
 * Neither ever holds a placeholder.
 */
export type ManagerNameDirectory = { roster: ReadonlyMap<string, string>; users: ReadonlyMap<string, string> };

export const EMPTY_MANAGER_DIRECTORY: ManagerNameDirectory = { roster: new Map(), users: new Map() };

export function managerNameDirectory(input: {
  /** Stored roster resolutions (`salesRoster` / `salesRoster:<PROJECT>`). */
  rosterEntries?: readonly { userId?: string | null; providedName?: string | null; status?: string | null }[];
  /** Static, owner-confirmed id → name pairs of the project, when it has them. */
  staticRoster?: readonly { id: string; name: string }[];
  /** The Bitrix users directory rows (`users`). */
  userRows?: readonly Record<string, unknown>[];
}): ManagerNameDirectory {
  const roster = new Map<string, string>();
  for (const entry of input.staticRoster ?? []) if (text(entry.id) && !isPlaceholderManagerName(entry.name)) roster.set(text(entry.id), text(entry.name));
  for (const entry of input.rosterEntries ?? []) {
    const id = text(entry.userId);
    if (id && entry.status === "RESOLVED" && !isPlaceholderManagerName(entry.providedName) && !roster.has(id)) roster.set(id, text(entry.providedName));
  }
  const users = new Map<string, string>();
  for (const row of input.userRows ?? []) {
    const id = text(row.ID);
    const name = [text(row.NAME), text(row.LAST_NAME)].filter(Boolean).join(" ");
    if (id && !isPlaceholderManagerName(name)) users.set(id, name);
  }
  return { roster, users };
}

/**
 * The display name for a manager id — the one rule every manager-facing view uses:
 *
 *   1. the project's Sales roster name for that id
 *   2. the Bitrix users directory name for that id
 *   3. a real (non-placeholder) name stored on a row bound to that id
 *   4. `Menejer #<id>`
 *
 * Display only: the id — and therefore every grouping, count and attribution —
 * is untouched. `bucketLabels` covers the non-person buckets (review / unknown),
 * which are keys rather than user IDs and therefore have fixed labels.
 */
export function resolveManagerDisplayName(
  id: string,
  options: { directory?: ManagerNameDirectory; rows?: readonly ManagerNameRow[]; bucketLabels?: Record<string, string> } = {},
): string {
  const bucketLabels = options.bucketLabels ?? {};
  if (bucketLabels[id]) return bucketLabels[id];
  const wanted = text(id);
  if (!wanted) return bucketLabels.unknown ?? "Aniqlanmagan";
  const known = options.directory?.roster.get(wanted) ?? options.directory?.users.get(wanted);
  if (known) return known;
  const rows = options.rows ?? [];
  for (const [idField, nameField] of [["funnelOwnerId", "funnelOwnerName"], ["salesManagerId", "salesManager"], ["assignedManagerId", "assignedManager"]] as const) {
    for (const row of rows) {
      if (text(row[idField]) === wanted && !isPlaceholderManagerName(row[nameField])) return text(row[nameField]);
    }
  }
  return managerFallbackLabel(wanted);
}

/**
 * The name that belongs to `id`, or a label naming that id. Every candidate is
 * bound to the row's OWN id fields; a placeholder never beats a real name.
 */
export function resolveManagerName(
  id: string,
  rows: readonly ManagerNameRow[],
  bucketLabels: Record<string, string> = {},
  directory?: ManagerNameDirectory,
): string {
  return resolveManagerDisplayName(id, { directory, rows, bucketLabels });
}

/**
 * Rewrites the stored display names of every row to the canonical name of its
 * own id — `assignedManager`, `salesManager` and `funnelOwnerName` only, and only
 * where the row carries that id. Ids, owners and every other field (including
 * the Sales Owner at Won evidence) are returned unchanged, so no population,
 * count or attribution can move.
 */
export function canonicalizeManagerNames<T extends ManagerNameRow>(rows: readonly T[], directory: ManagerNameDirectory = EMPTY_MANAGER_DIRECTORY): T[] {
  const cache = new Map<string, string>();
  const nameOf = (id: string) => {
    let name = cache.get(id);
    if (name === undefined) { name = resolveManagerDisplayName(id, { directory, rows }); cache.set(id, name); }
    return name;
  };
  return rows.map((row) => {
    const next = { ...row };
    if (text(row.assignedManagerId)) next.assignedManager = nameOf(text(row.assignedManagerId));
    if (text(row.salesManagerId)) next.salesManager = nameOf(text(row.salesManagerId));
    if (text(row.funnelOwnerId)) next.funnelOwnerName = nameOf(text(row.funnelOwnerId));
    return next;
  });
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
