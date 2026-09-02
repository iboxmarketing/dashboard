import { buildDashboardMetrics } from "./dashboard-metrics";
import type { MetricRecord } from "./dashboard-record";

/**
 * Daily created-cohort trend.
 *
 * Every point runs the canonical `buildDashboardMetrics` over one Tashkent
 * calendar day's records, so a day in the chart means exactly what the same
 * number means on a card — there is no second set of formulas here.
 *
 * Sales outcomes are deliberately absent. The average sales cycle is 5–6 days,
 * so a deal won today usually belongs to a cohort created days earlier. Lead
 * metrics are keyed on `createdAt` and sales on `wonAt`; plotting them on one
 * `createdAt` axis would put unrelated populations side by side and invite the
 * reader to divide one by the other. A matured-cohort view is a separate job.
 */

export type TrendMetricId =
  | "leads" | "classified" | "sql" | "not_relevant"
  | "coverage" | "quality_accepted" | "low_quality"
  | "avg_processing" | "median_processing" | "sla" | "overdue";

export type TrendUnit = "count" | "percent" | "minutes";

export type TrendMetric = {
  id: TrendMetricId;
  label: string;
  group: "LEAD OQIMI" | "LEAD SIFATI" | "OPERATSIYA";
  unit: TrendUnit;
  /** Quality rates need their cohort's classification coverage shown alongside. */
  needsCoverage?: boolean;
};

export const TREND_METRICS: TrendMetric[] = [
  { id: "leads", label: "Leadlar", group: "LEAD OQIMI", unit: "count" },
  { id: "classified", label: "Saralangan", group: "LEAD OQIMI", unit: "count" },
  { id: "sql", label: "SQL", group: "LEAD OQIMI", unit: "count" },
  { id: "not_relevant", label: "Not Relevant", group: "LEAD OQIMI", unit: "count" },
  { id: "coverage", label: "Saralash qamrovi", group: "LEAD SIFATI", unit: "percent" },
  { id: "quality_accepted", label: "Sifatli lead %", group: "LEAD SIFATI", unit: "percent", needsCoverage: true },
  { id: "low_quality", label: "Sifatsiz lead %", group: "LEAD SIFATI", unit: "percent", needsCoverage: true },
  { id: "avg_processing", label: "Avg saralash", group: "OPERATSIYA", unit: "minutes" },
  { id: "median_processing", label: "Median saralash", group: "OPERATSIYA", unit: "minutes" },
  { id: "sla", label: "SLA %", group: "OPERATSIYA", unit: "percent" },
  { id: "overdue", label: "Ishlov muddati o‘tgan", group: "OPERATSIYA", unit: "count" },
];

export const DEFAULT_TREND_METRIC: TrendMetricId = "leads";

/** Deliberately unavailable here — see the module docblock. */
export const EXCLUDED_SALES_METRIC_IDS = [
  "period_sales", "revenue", "cohort_sales", "cohort_revenue", "lead_to_sale", "sql_to_sale", "sales_cycle",
] as const;

export function isTrendMetricId(value: string): value is TrendMetricId {
  return TREND_METRICS.some((metric) => metric.id === value);
}
export function trendMetric(id: TrendMetricId) {
  return TREND_METRICS.find((metric) => metric.id === id) ?? TREND_METRICS[0];
}

/** Zero is an exact count, not a tiny positive bar; null remains no data. */
export function trendBarHeight(value: number | null, max: number) {
  if (value === null || value <= 0) return 0;
  return Math.max(3, (value / Math.max(1, max)) * 100);
}

/** Calendar day in Asia/Tashkent — never the UTC date. */
export function tashkentDayKey(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
}

export type TrendBounds = { from: string; to: string };

/**
 * Every calendar date from `from` to `to` inclusive.
 *
 * The keys are plain `YYYY-MM-DD` strings, so stepping them as UTC midnights is
 * calendar arithmetic on the label itself — no instant is converted and no
 * local offset can shift a boundary. Tashkent has no DST, so a day is always a
 * day here.
 */
export function calendarSpine({ from, to }: TrendBounds): string[] {
  if (!from || !to || from > to) return [];
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime() && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Everything one day contributes, so the tooltip never recomputes anything. */
export type TrendDay = {
  date: string;
  leads: number; classified: number; sql: number; notRelevant: number;
  coverage: number | null;
  qualityAccepted: number | null; lowQuality: number | null;
  avgProcessing: number | null; medianProcessing: number | null;
  slaRate: number | null; slaOnTime: number; slaDenominator: number;
  overdue: number; overdueRate: number | null;
};

const percent = (value: number, total: number) => (total ? Math.round((value / total) * 100) : null);

function medianOf(values: (number | null)[]) {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

/**
 * Builds one point per calendar day in the selected period.
 *
 * The axis comes from the period, not from the data. Deriving it from the
 * records dropped any day nobody happened to create a lead on, which silently
 * shortened the series, shifted the previous-period alignment and made a
 * 7-calendar-day average span more than seven calendar days.
 *
 * A rate whose denominator is zero is `null`, not `0`: "no classified leads"
 * and "0% were accepted" are different statements, and a zero-height bar would
 * assert the second. A zero *count*, by contrast, is a real business fact.
 */
export function buildTrendDays(records: MetricRecord[], bounds?: TrendBounds): TrendDay[] {
  const byDay = new Map<string, MetricRecord[]>();
  for (const row of records) {
    if (!row.createdAt) continue;
    const key = tashkentDayKey(row.createdAt);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  const dates = bounds
    ? calendarSpine(bounds)
    : [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  return dates.map((date) => {
    const rows = byDay.get(date) ?? [];
    const metrics = buildDashboardMetrics(rows, []);
    const eligible = metrics.eligible;
    return {
      date,
      leads: metrics.counts.leads,
      classified: metrics.counts.classified_leads,
      sql: metrics.counts.sql,
      notRelevant: metrics.counts.not_relevant,
      coverage: percent(metrics.counts.classified_leads, metrics.counts.leads),
      qualityAccepted: percent(metrics.counts.sql, metrics.counts.classified_leads),
      lowQuality: percent(metrics.counts.not_relevant, metrics.counts.classified_leads),
      avgProcessing: metrics.timing.avg_processing,
      // Same eligible population the average uses — routed deals excluded.
      medianProcessing: medianOf(eligible.map((row) => row.processingBusinessMinutes ?? null)),
      slaRate: metrics.sla.denominator ? metrics.sla.rate : null,
      slaOnTime: metrics.sla.onTime,
      slaDenominator: metrics.sla.denominator,
      overdue: metrics.sla.overdue,
      overdueRate: percent(metrics.sla.overdue, metrics.counts.leads),
    };
  });
}

export function trendValue(day: TrendDay, id: TrendMetricId): number | null {
  switch (id) {
    case "leads": return day.leads;
    case "classified": return day.classified;
    case "sql": return day.sql;
    case "not_relevant": return day.notRelevant;
    case "coverage": return day.coverage;
    case "quality_accepted": return day.qualityAccepted;
    case "low_quality": return day.lowQuality;
    case "avg_processing": return day.avgProcessing;
    case "median_processing": return day.medianProcessing;
    case "sla": return day.slaRate;
    case "overdue": return day.overdue;
  }
}

/**
 * A moving average is only drawn for counts and durations. Averaging daily
 * percentages weights a 3-lead day the same as a 40-lead one, so the line would
 * not be the period's rate — better to omit it than to label a wrong line.
 */
export function supportsMovingAverage(id: TrendMetricId) {
  return trendMetric(id).unit !== "percent";
}

/**
 * Trailing 7-day average over the values already on screen. Missing days are
 * skipped rather than treated as zero, and the window never reaches forward.
 */
export function movingAverage(values: (number | null)[], window = 7): (number | null)[] {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - window + 1), index + 1)
      .filter((value): value is number => value !== null);
    if (!slice.length) return null;
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

export type TrendPoint = TrendDay & {
  value: number | null;
  average: number | null;
  previous: number | null;
  /** Cohort still being worked; the rate is real but not yet representative. */
  immature: boolean;
};

export const MATURITY_COVERAGE_THRESHOLD = 70;

/**
 * Current and previous periods align by RELATIVE CALENDAR DAY: both spines are
 * built from their own bounds, so day 1 compares with day 1 even when either
 * period contains days on which nobody created a lead.
 */
export function buildTrendSeries(
  records: MetricRecord[],
  previousRecords: MetricRecord[],
  id: TrendMetricId,
  bounds?: TrendBounds,
  previousBounds?: TrendBounds,
): { points: TrendPoint[]; hasPrevious: boolean } {
  const days = buildTrendDays(records, bounds);
  const previousDays = buildTrendDays(previousRecords, previousBounds);
  const values = days.map((day) => trendValue(day, id));
  const averages = supportsMovingAverage(id) ? movingAverage(values) : values.map(() => null);
  const needsCoverage = Boolean(trendMetric(id).needsCoverage);
  const points = days.map((day, index) => ({
    ...day,
    value: values[index],
    average: averages[index],
    // Same metric, same formula, one period earlier.
    previous: previousDays[index] ? trendValue(previousDays[index], id) : null,
    immature: needsCoverage && day.coverage !== null && day.coverage < MATURITY_COVERAGE_THRESHOLD,
  }));
  // With no historical coverage at all there is nothing to compare against.
  const hasPrevious = previousDays.some((day) => day.leads > 0);
  return { points: points.map((point) => (hasPrevious ? point : { ...point, previous: null })), hasPrevious };
}
