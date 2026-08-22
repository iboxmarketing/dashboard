/**
 * Duplicate-lead detection.
 *
 * Analytical warning only. A duplicate is never removed from Total Leads, SQL,
 * Sales or any other population, and Bitrix deals are never merged or deleted:
 * one Bitrix deal id stays one lead. The metric answers a single question —
 * how many extra deals appear to belong to a customer we had already seen.
 *
 * Kept free of React and Cloudflare imports so the rule is directly testable.
 */

export type DuplicateCandidate = {
  dealId: string;
  createdAt: string;
  customerKey: string | null;
  duplicateOfDealId?: string | null;
};

/**
 * Deal-id tie-break. Bitrix ids are non-negative integer strings, so comparing
 * length first and then lexicographically orders them numerically ("9" < "100")
 * without ever converting to a float. Non-numeric ids fall back to codepoint
 * order; `localeCompare` is avoided because its result is locale-dependent and
 * the original of a group must not vary between environments.
 */
export function compareDealIds(a: string, b: string) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical ordering: oldest first, deal id as the deterministic secondary key.
 * `createdAt` is always an ISO-8601 UTC string from buildAnalyticsRecords, so
 * lexicographic order is chronological order.
 */
export function compareDuplicateOrder(a: DuplicateCandidate, b: DuplicateCandidate) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return compareDealIds(a.dealId, b.dealId);
}

/**
 * Flags every deal after the earliest one sharing a customer key.
 *
 * The earliest deal of a group is the ORIGINAL and always keeps
 * `duplicateOfDealId: null`; a record can never point at itself. A group of N
 * deals therefore yields exactly max(N - 1, 0) duplicates, and a deal with no
 * customer key is never a duplicate.
 *
 * Returns newest-first, matching the order the dashboard stores records in.
 */
export function markDuplicates<T extends DuplicateCandidate>(rows: T[]): T[] {
  const originalByCustomer = new Map<string, string>();
  return [...rows]
    .sort(compareDuplicateOrder)
    .map((row) => {
      if (!row.customerKey) return { ...row, duplicateOfDealId: null } as T;
      const original = originalByCustomer.get(row.customerKey);
      if (original === undefined) {
        originalByCustomer.set(row.customerKey, row.dealId);
        return { ...row, duplicateOfDealId: null } as T;
      }
      // A repeated deal id is the same deal, not a second one for that customer.
      // Guarding here makes "never points at itself" structural rather than a
      // side effect of deal ids happening to be unique.
      return { ...row, duplicateOfDealId: original === row.dealId ? null : original } as T;
    })
    .sort((a, b) => compareDuplicateOrder(b, a));
}

export function isDuplicate(row: { duplicateOfDealId?: string | null }) {
  return Boolean(row.duplicateOfDealId);
}

export function countDuplicates(rows: { duplicateOfDealId?: string | null }[]) {
  return rows.filter(isDuplicate).length;
}
