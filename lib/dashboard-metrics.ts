import { countDuplicates } from "./duplicates";
import { isEligibleCohortDeal, isSalesLost } from "./sales-logic";
import { summarizeSla } from "./sla";
import type { AnalyticsRecord } from "./types";

/**
 * Canonical dashboard metric definitions.
 *
 * Every card reads its number from here, so no card can derive its value from
 * another card's rendered text. The same helper backs the dashboard, the
 * manager views, the tests and `docs/METRICS.md`.
 *
 * Two populations, deliberately different:
 *  - cohort  : deals CREATED inside the selected range, minus routed deals
 *  - period  : deals WON inside the selected range, whatever their creation date
 */

export type DashboardMetricId =
  | "leads" | "sql" | "not_relevant" | "sales_lost" | "cohort_sales" | "period_sales"
  | "revenue" | "lead_to_sql" | "lead_to_sale" | "sql_to_sale" | "avg_processing"
  | "sla" | "avg_check" | "median_check" | "sales_cycle" | "duplicates" | "active_cohort";

/** Stable ids; user-facing labels may change without breaking saved settings. */
export const DASHBOARD_METRICS: { id: DashboardMetricId; label: string }[] = [
  { id: "leads", label: "Leadlar" },
  { id: "sql", label: "SQL" },
  { id: "not_relevant", label: "Not Relevant" },
  { id: "sales_lost", label: "Sotilmadi" },
  { id: "cohort_sales", label: "Kelgan leadlardan sotuv" },
  { id: "period_sales", label: "Shu davrdagi sotuvlar" },
  { id: "revenue", label: "Sotuv summasi" },
  { id: "avg_processing", label: "Leadni saralash vaqti" },
  { id: "sla", label: "SLA" },
  { id: "lead_to_sql", label: "Lead → SQL %" },
  { id: "lead_to_sale", label: "Lead → Sotuv %" },
  { id: "sql_to_sale", label: "SQL → Sotuv %" },
  { id: "avg_check", label: "O‘rtacha chek" },
  { id: "median_check", label: "Median chek" },
  { id: "sales_cycle", label: "Savdo sikli" },
  { id: "duplicates", label: "Takroriy lead" },
  { id: "active_cohort", label: "Aktiv leadlar" },
];

export const DEFAULT_DASHBOARD_METRIC_IDS: DashboardMetricId[] = [
  "leads", "sql", "not_relevant", "sales_lost", "cohort_sales",
  "period_sales", "revenue", "avg_processing", "sla",
];

export function isDashboardMetricId(value: string): value is DashboardMetricId {
  return DASHBOARD_METRICS.some((metric) => metric.id === value);
}

/** Keeps saved ids valid and ordered as the registry declares them. */
export function resolveDashboardMetricIds(saved: unknown): DashboardMetricId[] {
  const selected = Array.isArray(saved) ? saved.map(String).filter(isDashboardMetricId) : [];
  if (!selected.length) return DEFAULT_DASHBOARD_METRIC_IDS;
  return DASHBOARD_METRICS.map((metric) => metric.id).filter((id) => selected.includes(id));
}

const percent = (value: number, total: number) => (total ? Math.round((value / total) * 100) : 0);
const average = (values: (number | null)[]) => {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
};
const median = (values: (number | null)[]) => {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
};

export type DashboardMetrics = ReturnType<typeof buildDashboardMetrics>;

/**
 * @param cohortRecords deals created inside the selected range (routing still present)
 * @param periodSales   deals whose trustworthy wonAt falls inside the selected range
 */
export function buildDashboardMetrics(cohortRecords: AnalyticsRecord[], periodSales: AnalyticsRecord[]) {
  const eligible = cohortRecords.filter(isEligibleCohortDeal);
  const sql = eligible.filter((row) => row.qualified);
  const notRelevant = eligible.filter((row) => row.lossReasonGroup === "MARKETING");
  const salesLost = eligible.filter(isSalesLost);
  const cohortSales = eligible.filter((row) => row.salesStatus === "WON");
  const sla = summarizeSla(eligible);

  return {
    eligible, sql, notRelevant, salesLost, cohortSales, periodSales, sla,
    counts: {
      leads: eligible.length,
      sql: sql.length,
      not_relevant: notRelevant.length,
      sales_lost: salesLost.length,
      cohort_sales: cohortSales.length,
      period_sales: periodSales.length,
      duplicates: countDuplicates(cohortRecords),
      active_cohort: eligible.filter((row) => row.salesStatus === "ACTIVE").length,
    },
    rates: {
      lead_to_sql: percent(sql.length, eligible.length),
      not_relevant: percent(notRelevant.length, eligible.length),
      sales_lost: percent(salesLost.length, sql.length),
      lead_to_sale: percent(cohortSales.length, eligible.length),
      sql_to_sale: percent(cohortSales.length, sql.length),
      sla: sla.rate,
    },
    money: {
      revenue: periodSales.reduce((sum, row) => sum + row.opportunity, 0),
      avg_check: average(periodSales.map((row) => row.opportunity)),
      median_check: median(periodSales.map((row) => row.opportunity)),
      currency: periodSales[0]?.currencyId ?? "",
    },
    timing: {
      avg_processing: average(eligible.map((row) => row.processingBusinessMinutes)),
      sales_cycle: average(periodSales.map((row) => row.salesCycleHours)),
    },
  };
}

/**
 * Splits records into the two populations `buildDashboardMetrics` expects.
 * Shared so Custom Pages compute Sales numbers from the same definitions as
 * the Sales dashboard rather than re-deriving them.
 */
export function selectPeriodPopulations(records: AnalyticsRecord[], fromMs: number, toMs: number) {
  const inRange = (value: string | null) => {
    if (!value) return false;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time >= fromMs && time <= toMs;
  };
  return {
    cohort: records.filter((row) => inRange(row.createdAt)),
    periodSales: records.filter((row) => row.salesStatus === "WON" && inRange(row.wonAt)),
  };
}

/** Presentation accessor over an already-computed metrics object. */
export function resolveDashboardMetric(metrics: DashboardMetrics, id: DashboardMetricId): { label: string; value: string } {
  const label = DASHBOARD_METRICS.find((metric) => metric.id === id)?.label ?? id;
  const number = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("uz-UZ"));
  switch (id) {
    case "leads": case "sql": case "not_relevant": case "sales_lost":
    case "cohort_sales": case "period_sales": case "duplicates": case "active_cohort":
      return { label, value: String(metrics.counts[id]) };
    case "lead_to_sql": case "lead_to_sale": case "sql_to_sale": case "sla":
      return { label, value: `${metrics.rates[id]}%` };
    case "revenue": return { label, value: metrics.money.revenue.toLocaleString("uz-UZ") };
    case "avg_check": return { label, value: number(metrics.money.avg_check) };
    case "median_check": return { label, value: number(metrics.money.median_check) };
    case "avg_processing": return { label, value: number(metrics.timing.avg_processing) };
    case "sales_cycle": return { label, value: number(metrics.timing.sales_cycle) };
    default: return { label, value: "—" };
  }
}
