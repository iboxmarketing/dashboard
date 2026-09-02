import { DASHBOARD_METRICS, type DashboardMetricId } from "./dashboard-metrics";

/**
 * Which metrics get a headline card on the main Dashboard.
 *
 * The principle is one business question per card. The semantic registry in
 * `dashboard-metrics.ts` stays complete — every formula remains available to
 * Custom Pages, Diagnostics, Lead Quality, manager views and the tests — but
 * the main Dashboard only offers this curated set, and several cards now carry
 * a secondary figure that used to occupy a card of its own.
 */

export const DASHBOARD_HEADLINE_CARD_IDS = [
  "leads", "classified_leads", "sql", "not_relevant", "sales_lost",
  "cohort_sales", "period_sales", "avg_check", "lead_to_sql",
  "avg_processing", "sales_cycle", "active_cohort",
] as const satisfies readonly DashboardMetricId[];

export type HeadlineCardId = (typeof DASHBOARD_HEADLINE_CARD_IDS)[number];

/** Selected out of the box. `active_cohort` stays available but off by default. */
export const DEFAULT_HEADLINE_CARD_IDS: HeadlineCardId[] = [
  "leads", "classified_leads", "sql", "not_relevant", "sales_lost",
  "cohort_sales", "period_sales", "avg_check", "lead_to_sql",
  "avg_processing", "sales_cycle",
];

/**
 * Where a metric that used to be its own card now lives.
 *
 * Saved settings still contain the old ids, so reading them must fold each one
 * into the card that now shows it — and must not produce that card twice when
 * both halves were selected, which is why the resolver dedupes.
 */
export const MERGED_INTO_HEADLINE: Partial<Record<DashboardMetricId, HeadlineCardId>> = {
  revenue: "period_sales",
  median_check: "avg_check",
  sla: "avg_processing",
  lead_to_sale: "lead_to_sql",
  sql_to_sale: "lead_to_sql",
  classification_coverage: "classified_leads",
  unclassified_leads: "classified_leads",
  quality_accepted_rate: "sql",
  low_quality_rate: "not_relevant",
  not_relevant_of_leads: "not_relevant",
};

/**
 * Diagnostics with no headline home. They keep their formulas and stay usable
 * elsewhere; they simply are not offered as main Dashboard cards.
 */
export const NON_HEADLINE_METRIC_IDS: DashboardMetricId[] = [
  "duplicates", "duplicates_eligible", "unique_ish_leads", "pre_sql_closed",
];

export function isHeadlineCardId(value: string): value is HeadlineCardId {
  return (DASHBOARD_HEADLINE_CARD_IDS as readonly string[]).includes(value);
}

/**
 * Saved metric ids → the headline cards to render, in the saved order.
 *
 * Legacy ids fold into their anchor, unsupported ids drop out, and duplicates
 * collapse to their first occurrence so `period_sales + revenue` yields one
 * card rather than two. Order is otherwise untouched, so a user's arrangement
 * survives the consolidation.
 */
export function resolveHeadlineCardIds(saved: unknown): HeadlineCardId[] {
  const raw = Array.isArray(saved) ? saved.map(String) : [];
  const legacyDefault = DASHBOARD_METRICS.map((metric) => metric.id);
  if (raw.length === legacyDefault.length && raw.every((value, index) => value === legacyDefault[index])) {
    return DEFAULT_HEADLINE_CARD_IDS;
  }
  const mapped = raw.flatMap((value) => {
    if (isHeadlineCardId(value)) return [value];
    const anchor = MERGED_INTO_HEADLINE[value as DashboardMetricId];
    return anchor ? [anchor] : [];
  });
  const ordered = [...new Set(mapped)];
  return ordered.length ? ordered : DEFAULT_HEADLINE_CARD_IDS;
}

/** Display label for a headline card; some differ from the raw metric label. */
const HEADLINE_LABELS: Partial<Record<HeadlineCardId, string>> = {
  classified_leads: "Saralangan",
  avg_check: "Chek",
  lead_to_sql: "Funnel konversiyasi",
  avg_processing: "Saralash tezligi",
};

export function headlineCardLabel(id: HeadlineCardId) {
  return HEADLINE_LABELS[id] ?? DASHBOARD_METRICS.find((metric) => metric.id === id)?.label ?? id;
}
