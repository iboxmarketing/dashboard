import { salesManagerKey } from "./sales-logic";

/**
 * Sales-analytics filter semantics, kept out of the React component so the
 * OR/AND rules are testable on their own.
 *
 * - **OR inside one dimension**: `sources: ["CRM-форма", "Сарафан"]` matches a
 *   record whose source is either one.
 * - **AND across dimensions**: the selected sources AND the selected managers
 *   AND the date range AND everything else must all hold.
 * - **An empty selection means "all"**, never "none" — clearing a filter widens
 *   the view instead of emptying it.
 */

/** Bucket for a record with no seller, matching `salesManagerKey` and ManagerTable. */
export const UNASSIGNED_MANAGER_KEY = "unknown";

export type Selection = readonly string[];

/**
 * Accepts the old scalar shape as well as the current array.
 *
 * Filter state has never been persisted to a URL or to storage, but a scalar can
 * still reach this code from an older cached bundle or a hand-written link, and a
 * single value must keep behaving exactly like a one-item selection.
 */
export function normalizeSelection(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.filter((item): item is string => typeof item === "string" && item !== ""))];
}

/** OR within a dimension; an empty selection matches everything. */
export function matchesSelection(selected: Selection, value: string | null | undefined) {
  if (!selected.length) return true;
  return value !== null && value !== undefined && selected.includes(value);
}

/** Immutable checkbox toggle for the multi-select UI. */
export function toggleSelection(selected: Selection, value: string): string[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
}

/**
 * Seller identity for **historical** analytics: `salesManagerId` only.
 *
 * `assignedManagerId` is deliberately not consulted. It is the card's current
 * responsible person, so a post-sale or customer-care assignee who never sold
 * the deal would otherwise be credited with someone else's history. The Managers
 * table already partitions by `salesManagerKey`, so filtering on the same key is
 * what keeps a filtered manager row and the manager filter agreeing.
 */
export function historicalManagerKey(row: { salesManagerId?: string | null }) {
  return salesManagerKey(row);
}

/** Seller identity for the **live** stage/workload views: the current assignee. */
export function liveManagerKey(row: { assignedManagerId?: string | null }) {
  return row.assignedManagerId || UNASSIGNED_MANAGER_KEY;
}

export type SalesFilterSelection = {
  managers?: Selection;
  sources?: Selection;
  pipeline?: string;
  stage?: string;
  period?: string;
  sla?: string;
  processing?: string;
  search?: string;
};

export type HistoricalFilterRow = {
  dealId: string;
  title?: string;
  salesManagerId?: string | null;
  source?: string;
  originPipeline?: string;
  stage?: string;
  creationPeriod?: string;
  slaStatus?: string;
  processingSource?: string;
};

function matchesSearch(row: { dealId: string; title?: string }, search: string | undefined) {
  const query = (search ?? "").trim().toLowerCase();
  if (!query) return true;
  return `${row.dealId} ${row.title ?? ""}`.toLowerCase().includes(query);
}

/**
 * Every non-date predicate for a historical record, in one place.
 *
 * The cohort population and the period-sales population must not diverge, so
 * both are derived from this same predicate and only their date key differs.
 */
export function matchesHistoricalFilters(row: HistoricalFilterRow, filters: SalesFilterSelection) {
  if (!matchesSelection(filters.managers ?? [], historicalManagerKey(row))) return false;
  if (!matchesSelection(filters.sources ?? [], row.source)) return false;
  if (filters.pipeline && row.originPipeline !== filters.pipeline) return false;
  if (filters.stage && row.stage !== filters.stage) return false;
  if (filters.period && row.creationPeriod !== filters.period) return false;
  if (filters.sla && row.slaStatus !== filters.sla) return false;
  if (filters.processing && row.processingSource !== filters.processing) return false;
  return matchesSearch(row, filters.search);
}

export function filterHistoricalRecords<T extends HistoricalFilterRow>(rows: readonly T[], filters: SalesFilterSelection) {
  return rows.filter((row) => matchesHistoricalFilters(row, filters));
}

/**
 * Live open-stage rows. Keyed on the current assignee by design — this view
 * answers "who is holding this card right now", not "who sold it".
 */
export function matchesCurrentStageFilters(
  row: { dealId: string; title?: string; assignedManagerId?: string | null; pipeline?: string; stage?: string },
  filters: SalesFilterSelection,
) {
  if (!matchesSelection(filters.managers ?? [], liveManagerKey(row))) return false;
  if (filters.pipeline && row.pipeline !== filters.pipeline) return false;
  if (filters.stage && row.stage !== filters.stage) return false;
  return matchesSearch(row, filters.search);
}

export function filterCurrentStageRecords<T extends { dealId: string; title?: string; assignedManagerId?: string | null; pipeline?: string; stage?: string }>(
  rows: readonly T[],
  filters: SalesFilterSelection,
) {
  return rows.filter((row) => matchesCurrentStageFilters(row, filters));
}

/**
 * Historical stage-funnel rows. Manager and Source use the same historical
 * identities as every other Sales view. Stage/SLA/processing do not apply
 * because this minimal projection intentionally does not carry those fields.
 */
export function matchesStageHistoryFilters(
  row: { dealId: string; title?: string; salesManagerId?: string | null; source?: string; originPipeline?: string },
  filters: SalesFilterSelection,
) {
  if (!matchesSelection(filters.managers ?? [], historicalManagerKey(row))) return false;
  if (!matchesSelection(filters.sources ?? [], row.source)) return false;
  if (filters.pipeline && row.originPipeline !== filters.pipeline) return false;
  return matchesSearch(row, filters.search);
}

export function filterStageHistoryRecords<T extends { dealId: string; title?: string; salesManagerId?: string | null; source?: string; originPipeline?: string }>(
  rows: readonly T[],
  filters: SalesFilterSelection,
) {
  return rows.filter((row) => matchesStageHistoryFilters(row, filters));
}

/** One row per Deal ID. Cohort and period-sales populations overlap by design. */
export function dedupeByDealId<T extends { dealId: string }>(...groups: readonly T[][]) {
  return [...new Map(groups.flat().map((row) => [row.dealId, row])).values()];
}

/**
 * Seller options for the historical filter: the same keys the filter compares
 * against, so no option can ever match zero records for the wrong reason.
 */
export function historicalManagerOptions(rows: readonly { salesManagerId?: string | null; salesManager?: string | null }[]) {
  const names = new Map<string, string>();
  for (const row of rows) {
    const key = historicalManagerKey(row);
    const name = row.salesManager || "Aniqlanmagan";
    if (!names.has(key) || (names.get(key) === "Aniqlanmagan" && name !== "Aniqlanmagan")) names.set(key, name);
  }
  return [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function liveManagerOptions(rows: readonly { assignedManagerId?: string | null; assignedManager?: string | null }[]) {
  const names = new Map<string, string>();
  for (const row of rows) {
    const key = liveManagerKey(row);
    if (!names.has(key)) names.set(key, row.assignedManager || "Aniqlanmagan");
  }
  return [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** How many dimensions are narrowing the view, for the "other filters" badge. */
export function activeFilterCount(filters: SalesFilterSelection) {
  return [
    (filters.managers ?? []).length > 0,
    (filters.sources ?? []).length > 0,
    Boolean(filters.pipeline),
    Boolean(filters.stage),
    Boolean(filters.period),
    Boolean(filters.sla),
    Boolean(filters.processing),
  ].filter(Boolean).length;
}

/**
 * Button text for a multi-select: the label itself while nothing is chosen, one
 * name when it is unambiguous, otherwise a count so the control never stretches.
 */
export function selectionSummary(selected: Selection, allLabel: string, labelOf: (value: string) => string) {
  if (!selected.length) return allLabel;
  if (selected.length === 1) return labelOf(selected[0]);
  return `${selected.length} tanlandi`;
}
