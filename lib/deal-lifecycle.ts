/**
 * Explicit Deal lifecycle, so "does this Deal count?" is one answer with one name.
 *
 *   ACTIVE                  in the project, counts everywhere.
 *   EXCLUDED_OTHER_PROJECT  currently in another project's funnel: out of Leads
 *                           and cohort Sales, while a sale already proven in
 *                           IBOX keeps its Period Sale (BUSINESS_RULES §4).
 *   DELETED                 Bitrix answered definitively that the Deal is gone.
 *                           Never counted in a current KPI, an employee score or
 *                           the live workload — and never erased: the record,
 *                           its history and any sale snapshot stay as audit
 *                           evidence, visibly non-counting.
 *   UNAVAILABLE             the Deal could not be read (permission, transport).
 *                           Ambiguous, so it is not counted, and it is not
 *                           called deleted either.
 *   UNRESOLVED              membership could not be decided yet (an older record
 *                           awaiting a Full Sync rebuild). Kept in the
 *                           population and reported, never silently dropped.
 */

export type DealLifecycle = "ACTIVE" | "EXCLUDED_OTHER_PROJECT" | "DELETED" | "UNAVAILABLE" | "UNRESOLVED";

export type LifecycleInput = {
  projectLeadMembership?: "INCLUDED" | "EXCLUDED" | "UNRESOLVED" | null;
  currentScope?: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNAVAILABLE" | "DELETED" | null;
};

export function dealLifecycle(row: LifecycleInput): DealLifecycle {
  if (row.currentScope === "DELETED") return "DELETED";
  if (row.currentScope === "UNAVAILABLE") return "UNAVAILABLE";
  if (row.currentScope === "OUT_OF_SCOPE" || row.projectLeadMembership === "EXCLUDED") return "EXCLUDED_OTHER_PROJECT";
  if (row.projectLeadMembership === "UNRESOLVED") return "UNRESOLVED";
  return "ACTIVE";
}

/**
 * Whether the Deal may appear in any current operational figure — a KPI, an
 * employee score, the live workload. A deleted or unreadable Deal may not; an
 * other-project Deal is judged per metric by the membership rules, so it passes
 * here and is filtered by those.
 */
export function countsCurrently(row: LifecycleInput) {
  const lifecycle = dealLifecycle(row);
  return lifecycle !== "DELETED" && lifecycle !== "UNAVAILABLE";
}

export const LIFECYCLE_LABELS: Record<DealLifecycle, string> = {
  ACTIVE: "Aktiv",
  EXCLUDED_OTHER_PROJECT: "Boshqa loyihada",
  DELETED: "Bitrix’da o‘chirilgan",
  UNAVAILABLE: "O‘qib bo‘lmadi",
  UNRESOLVED: "Aniqlanmagan (yangilash kerak)",
};

/** Lifecycle counts for Diagnostics: deleted and unavailable Deals must be visible, not hidden. */
export function lifecycleBreakdown(rows: LifecycleInput[]) {
  const counts: Record<DealLifecycle, number> = { ACTIVE: 0, EXCLUDED_OTHER_PROJECT: 0, DELETED: 0, UNAVAILABLE: 0, UNRESOLVED: 0 };
  for (const row of rows) counts[dealLifecycle(row)] += 1;
  return counts;
}
