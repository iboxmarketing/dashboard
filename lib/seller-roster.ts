/**
 * The owner-approved Sales roster, resolved once to Bitrix user IDs.
 *
 * Owner-provided names are free text: they carry apostrophe variants
 * (`Po'latxon` / `Poʻlatxon`), transliteration drift and capitalisation
 * differences. Attribution must never match on that text, so this module does the
 * resolution ONCE — provided name → exact Bitrix user → user id + canonical name
 * — and everything downstream compares user IDs only.
 *
 * Matching is deliberately conservative:
 *
 *   EXACT   the normalised token set is identical (apostrophes, diacritics,
 *           punctuation and name order folded away). One candidate → resolved.
 *   NEAR    every token matches within a single character edit — enough for
 *           `Rahmatullo` / `Rahmatulloh`, not enough to confuse `Sanjar Juraev`
 *           with `Sardor Juraev`.
 *
 * Two candidates in the same tier, or none at all, is never guessed: the entry
 * becomes ROSTER_MAPPING_REVIEW / NOT_FOUND and is excluded from the approved id
 * set, so no automatic decision can rest on it.
 */

/** Owner-provided roster, 2026-09-24. Names as the owner wrote them. */
export const OWNER_APPROVED_SELLER_NAMES = [
  "Abdulaziz Abdurahmonov",
  "Soxib Bazaraliyev",
  "Abdulloh Tolanov",
  "Rahmatullo Orifjonov",
  "Po'latxon Ashuraliyev",
  "Jamoliddin Kamarov",
  "Sanjar Juraev",
  "Rahmatulloh Ahmadjonov",
  "Muhamadrasul Dadaxonov",
] as const;

export type DirectoryUser = { id: string; name: string; active?: boolean };

export type RosterStatus = "RESOLVED" | "ROSTER_MAPPING_REVIEW" | "NOT_FOUND";

export type RosterResolution = {
  providedName: string;
  status: RosterStatus;
  userId: string | null;
  canonicalName: string | null;
  matchKind: "EXACT" | "NEAR" | null;
  /** Everybody who matched in the winning tier — the review evidence. */
  candidates: DirectoryUser[];
};

const APOSTROPHES = /['’‘`´ʻʼ]/gu;

/** Case, diacritics, apostrophes, punctuation and name order folded away. */
export function normalizeRosterName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(APOSTROPHES, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function tokens(value: string) {
  return normalizeRosterName(value).split(" ").filter(Boolean);
}

/** Single-edit distance check, short-circuited at 1 — no full matrix needed. */
export function withinOneEdit(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let index = 0;
  let offset = 0;
  let edits = 0;
  while (index + offset < long.length && index < short.length) {
    if (short[index] === long[index + offset]) { index += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (short.length === long.length) index += 1; else offset += 1;
  }
  return edits + (long.length - index - offset) + (short.length - index) <= 1;
}

function nearMatch(provided: string[], candidate: string[]) {
  if (provided.length !== candidate.length) return false;
  const remaining = [...candidate];
  for (const token of provided) {
    const index = remaining.findIndex((other) => withinOneEdit(token, other));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function resolveRosterName(providedName: string, users: readonly DirectoryUser[]): RosterResolution {
  const wanted = tokens(providedName);
  const base = { providedName, userId: null, canonicalName: null, matchKind: null, candidates: [] as DirectoryUser[] };
  if (!wanted.length) return { ...base, status: "NOT_FOUND" };

  const exact = users.filter((user) => normalizeRosterName(user.name) === wanted.join(" "));
  const tier: [DirectoryUser[], "EXACT" | "NEAR"] | null = exact.length
    ? [exact, "EXACT"]
    : (() => {
      const near = users.filter((user) => nearMatch(wanted, tokens(user.name)));
      return near.length ? [near, "NEAR" as const] : null;
    })();
  if (!tier) return { ...base, status: "NOT_FOUND" };

  const [candidates, matchKind] = tier;
  // Same person listed twice in the directory is not an ambiguity; two different
  // ids are, and are never resolved automatically.
  const distinct = [...new Map(candidates.map((user) => [user.id, user])).values()];
  if (distinct.length !== 1) return { ...base, status: "ROSTER_MAPPING_REVIEW", matchKind, candidates: distinct };
  const [user] = distinct;
  return { providedName, status: "RESOLVED", userId: user.id, canonicalName: user.name, matchKind, candidates: distinct };
}

export type ResolvedRoster = {
  entries: RosterResolution[];
  /** The only set any attribution rule may consult. */
  approvedSellerIds: Set<string>;
  needsReview: RosterResolution[];
};

export function resolveRoster(
  providedNames: readonly string[] = OWNER_APPROVED_SELLER_NAMES,
  users: readonly DirectoryUser[] = [],
): ResolvedRoster {
  const entries = providedNames.map((name) => resolveRosterName(name, users));
  return {
    entries,
    approvedSellerIds: new Set(entries.filter((entry) => entry.status === "RESOLVED" && entry.userId).map((entry) => entry.userId as string)),
    needsReview: entries.filter((entry) => entry.status !== "RESOLVED"),
  };
}

/** Bitrix directory rows (`crm_dictionaries` key `users`) as this module wants them. */
export function directoryUsers(rows: readonly Record<string, unknown>[]): DirectoryUser[] {
  const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());
  return rows
    .map((row) => ({
      id: text(row.ID),
      name: [text(row.NAME), text(row.LAST_NAME)].filter(Boolean).join(" "),
      active: text(row.ACTIVE) === "1" || row.ACTIVE === true,
    }))
    .filter((user) => /^[1-9]\d*$/.test(user.id) && user.name);
}
