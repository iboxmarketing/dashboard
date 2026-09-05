import { countDuplicates } from "./duplicates";
import { countsAsOperational } from "./stale-resolution";
import { countClassificationConflicts, isClassifiedLead, isEligibleCohortDeal, isPreSqlClosed, isSalesLost, isUnclassifiedLead } from "./sales-logic";
import { summarizeSla } from "./sla";
import type { MetricRecord } from "./dashboard-record";

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
 *
 * Inside the cohort there is a second, independent split that must never be
 * confused with the first:
 *  - classified   : quality already decided (accepted as SQL, or rejected as
 *                   Not Relevant). This is the denominator for QUALITY rates.
 *  - unclassified : quality not decided yet. Unknown, not bad.
 *
 * FUNNEL rates (Lead → SQL, Lead → Sotuv) keep the full eligible cohort as
 * their denominator, because they measure how much of everything that arrived
 * got through. QUALITY rates (Sifatli/Sifatsiz) use the classified population,
 * because they measure the verdicts we have actually reached. Swapping the two
 * makes a young cohort look low quality and a picked-over one look excellent.
 */

export type DashboardMetricId =
  | "leads" | "sql" | "not_relevant" | "sales_lost" | "cohort_sales" | "period_sales"
  | "revenue" | "lead_to_sql" | "lead_to_sale" | "sql_to_sale" | "avg_processing"
  | "sla" | "avg_check" | "median_check" | "sales_cycle" | "duplicates" | "active_cohort"
  | "classified_leads" | "unclassified_leads" | "classification_coverage"
  | "quality_accepted_rate" | "low_quality_rate" | "not_relevant_of_leads"
  | "duplicates_eligible" | "unique_ish_leads" | "pre_sql_closed";

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
  // Added additively so every saved widget and saved card selection keeps its
  // meaning; no existing id changed what it counts.
  { id: "classified_leads", label: "Saralangan leadlar" },
  { id: "unclassified_leads", label: "Saralanmagan leadlar" },
  { id: "classification_coverage", label: "Saralash qamrovi" },
  { id: "quality_accepted_rate", label: "Sifatli lead %" },
  { id: "low_quality_rate", label: "Sifatsiz lead %" },
  { id: "not_relevant_of_leads", label: "Umumiy leadlardan Not Relevant %" },
  { id: "duplicates_eligible", label: "Takroriy lead (eligible)" },
  { id: "unique_ish_leads", label: "Takrorsiz lead (taxminiy)" },
  { id: "pre_sql_closed", label: "SQLgacha yopilgan" },
];

export const DEFAULT_DASHBOARD_METRIC_IDS: DashboardMetricId[] = [
  "leads", "sql", "not_relevant", "sales_lost", "cohort_sales",
  "period_sales", "revenue", "avg_processing", "sla",
];

export function isDashboardMetricId(value: string): value is DashboardMetricId {
  return DASHBOARD_METRICS.some((metric) => metric.id === value);
}

/**
 * Keeps saved ids valid while preserving the order they were saved in.
 *
 * The array is now both the selection AND the presentation order, so this must
 * not re-sort by the registry: doing so was why the Settings checkboxes could
 * only ever toggle visibility. Invalid ids are dropped and duplicates collapse
 * to their first occurrence, neither of which disturbs the surviving order.
 *
 * Existing saved settings were written in registry order, so they resolve to
 * exactly the same sequence as before — no dashboard reorders on deploy.
 */
export function resolveDashboardMetricIds(saved: unknown): DashboardMetricId[] {
  const raw = Array.isArray(saved) ? saved.map(String).filter(isDashboardMetricId) : [];
  const ordered = [...new Set(raw)];
  if (!ordered.length) return DEFAULT_DASHBOARD_METRIC_IDS;
  return ordered;
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
export function buildDashboardMetrics(cohortRecords: MetricRecord[], periodSales: MetricRecord[]) {
  const eligible = cohortRecords.filter(isEligibleCohortDeal);
  const sql = eligible.filter((row) => row.qualified);
  const notRelevant = eligible.filter((row) => row.lossReasonGroup === "MARKETING");
  const salesLost = eligible.filter(isSalesLost);
  const cohortSales = eligible.filter((row) => row.salesStatus === "WON");
  const classified = eligible.filter(isClassifiedLead);
  // Closed inside the Sales funnel without ever producing SQL evidence. A
  // workflow signal, not a KPI: it is in none of SQL, Sifatli, Sifatsiz or
  // Sotilmadi, and sits inside Saralanmagan because no verdict was reached.
  const preSqlClosed = eligible.filter(isPreSqlClosed);
  const unclassified = eligible.filter(isUnclassifiedLead);
  const sla = summarizeSla(eligible);
  // Duplicates are reported over both populations. The historical metric counts
  // the raw cohort, which includes routed deals that Leadlar excludes, so the
  // two are published side by side rather than one being changed underneath a
  // label that has been read the same way for months.
  const duplicatesRaw = countDuplicates(cohortRecords);
  const duplicatesEligible = countDuplicates(eligible);
  /** Non-zero means a record asserts both verdicts; Diagnostics shows it. */
  const classificationConflicts = countClassificationConflicts(eligible);

  const qualityAcceptedRate = percent(sql.length, classified.length);
  // Sifatli % and Sifatsiz % are displayed as a pair and read as complementary
  // shares of Saralangan. Rounding each independently can land both sides on
  // a .5 boundary and round up together — 195/312 and 117/312 are 62.5% and
  // 37.5%, which independently round to 63 + 38 = 101%. When SQL and Not
  // Relevant cleanly partition `classified` (no classification conflict),
  // Sifatsiz % is defined as the remainder instead of rounded on its own, so
  // the displayed pair always sums to exactly 100%. A conflict means SQL and
  // Not Relevant no longer exhaustively/exclusively cover `classified`, so
  // subtracting would silently paper over that; the independent rate is kept
  // so Diagnostics still shows the real mismatch.
  const lowQualityRate = classified.length > 0 && classificationConflicts === 0
    ? 100 - qualityAcceptedRate
    : percent(notRelevant.length, classified.length);

  return {
    eligible, sql, notRelevant, salesLost, cohortSales, periodSales, sla,
    classified, unclassified, preSqlClosed,
    classificationConflicts,
    counts: {
      leads: eligible.length,
      sql: sql.length,
      not_relevant: notRelevant.length,
      sales_lost: salesLost.length,
      cohort_sales: cohortSales.length,
      period_sales: periodSales.length,
      duplicates: duplicatesRaw,
      duplicates_eligible: duplicatesEligible,
      // Diagnostic estimate only. Never a substitute for Leadlar: one Bitrix
      // deal id is one lead, and a repeat customer may be a real second deal.
      unique_ish_leads: eligible.length - duplicatesEligible,
      pre_sql_closed: preSqlClosed.length,
      classified_leads: classified.length,
      unclassified_leads: unclassified.length,
      // Aktiv leadlar is a *current operational* figure, so it excludes deals
      // that have left the sync scope or vanished from Bitrix. Every other
      // metric here is historical-cohort based and deliberately ignores
      // currentScope — a lead still belongs to its creation month's population
      // regardless of where the card sits today.
      active_cohort: eligible.filter((row) => row.salesStatus === "ACTIVE" && countsAsOperational(row.currentScope)).length,
    },
    rates: {
      // Funnel: denominator is every incoming eligible lead.
      lead_to_sql: percent(sql.length, eligible.length),
      lead_to_sale: percent(cohortSales.length, eligible.length),
      // Quality: denominator is the leads we have actually judged.
      quality_accepted_rate: qualityAcceptedRate,
      low_quality_rate: lowQualityRate,
      classification_coverage: percent(classified.length, eligible.length),
      // Kept for the explicitly-labelled full-funnel card. `not_relevant` is
      // retained as an alias so no existing consumer silently changes meaning.
      not_relevant_of_leads: percent(notRelevant.length, eligible.length),
      not_relevant: percent(notRelevant.length, eligible.length),
      sales_lost: percent(salesLost.length, sql.length),
      sql_to_sale: percent(cohortSales.length, sql.length),
      sla: sla.rate,
    },
    money: {
      revenue: periodSales.reduce((sum, row) => sum + row.opportunity, 0),
      // The money the *cohort* produced: exactly the deals created in the
      // selected period that were later won, whenever that happened. Summed
      // over `cohortSales`, never over `periodSales` — the two populations are
      // deliberately different and an August lead sold in September belongs to
      // August's cohort revenue and September's revenue.
      cohort_revenue: cohortSales.reduce((sum, row) => sum + row.opportunity, 0),
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
export function selectPeriodPopulations(records: MetricRecord[], fromMs: number, toMs: number) {
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
    case "classified_leads": case "unclassified_leads": case "duplicates_eligible":
    case "unique_ish_leads": case "pre_sql_closed":
      return { label, value: String(metrics.counts[id]) };
    case "lead_to_sql": case "lead_to_sale": case "sql_to_sale": case "sla":
    case "classification_coverage": case "quality_accepted_rate":
    case "low_quality_rate": case "not_relevant_of_leads":
      return { label, value: `${metrics.rates[id]}%` };
    case "revenue": return { label, value: metrics.money.revenue.toLocaleString("uz-UZ") };
    case "avg_check": return { label, value: number(metrics.money.avg_check) };
    case "median_check": return { label, value: number(metrics.money.median_check) };
    case "avg_processing": return { label, value: number(metrics.timing.avg_processing) };
    case "sales_cycle": return { label, value: number(metrics.timing.sales_cycle) };
    default: return { label, value: "—" };
  }
}
