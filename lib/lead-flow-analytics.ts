import { buildDashboardMetrics } from "./dashboard-metrics";
import type { MetricRecord } from "./dashboard-record";
import { isEligibleCohortDeal } from "./sales-logic";

/**
 * Incoming-load analytics for staffing.
 *
 * The question is not "when do many leads arrive" but "when do many leads
 * arrive AND processing quality drops", so every bucket carries volume and
 * processing quality side by side. Each bucket runs the canonical
 * `buildDashboardMetrics`, so SLA, overdue and processing mean exactly what
 * they mean elsewhere.
 *
 * Sales outcomes are deliberately absent: this page is about capacity, not
 * revenue.
 */

export const WEEKDAY_LABELS = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];
export const BUCKET_COUNT = 12;
export const BUCKET_HOURS = 2;

export type LeadFlowMetricId = "volume" | "overdue_rate" | "sla" | "avg_processing";

export const LEAD_FLOW_METRICS: { id: LeadFlowMetricId; label: string; group: string; unit: "count" | "percent" | "minutes" }[] = [
  { id: "volume", label: "Lead hajmi", group: "YUKLAMA", unit: "count" },
  { id: "overdue_rate", label: "Muddati o'tgan %", group: "ISHLOV", unit: "percent" },
  { id: "sla", label: "SLA %", group: "ISHLOV", unit: "percent" },
  { id: "avg_processing", label: "Avg saralash", group: "ISHLOV", unit: "minutes" },
];
export const DEFAULT_LEAD_FLOW_METRIC: LeadFlowMetricId = "volume";

/** Weekday (Mon=0) and hour in Asia/Tashkent — never the browser's zone. */
export function tashkentParts(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent", weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { weekday: weekdays[parts.weekday] ?? 0, hour: Number(parts.hour) };
}

export function bucketLabel(bucket: number) {
  const start = String(bucket * BUCKET_HOURS).padStart(2, "0");
  const end = String((bucket + 1) * BUCKET_HOURS).padStart(2, "0");
  return `${start}:00–${end}:00`;
}

export type LeadFlowStats = {
  leads: number;
  share: number;
  overdue: number;
  /** null when there are no leads at all — not a 0% success story. */
  overdueRate: number | null;
  slaRate: number | null;
  slaOnTime: number;
  slaDenominator: number;
  avgProcessing: number | null;
  /** How many of the bucket's leads actually carry a processing observation. */
  processingKnown: number;
};

function statsFor(rows: MetricRecord[], total: number): LeadFlowStats {
  const metrics = buildDashboardMetrics(rows, []);
  const leads = metrics.counts.leads;
  return {
    leads,
    share: total ? Math.round((leads / total) * 1000) / 10 : 0,
    overdue: metrics.sla.overdue,
    overdueRate: leads ? Math.round((metrics.sla.overdue / leads) * 100) : null,
    slaRate: metrics.sla.denominator ? metrics.sla.rate : null,
    slaOnTime: metrics.sla.onTime,
    slaDenominator: metrics.sla.denominator,
    avgProcessing: metrics.timing.avg_processing,
    processingKnown: metrics.eligible.filter((row) => row.processingBusinessMinutes !== null).length,
  };
}

export type LeadFlowCell = LeadFlowStats & { weekday: number; bucket: number };
export type LeadFlowGroup = LeadFlowStats & { key: string; label: string };
export type LeadFlowSignal = {
  id: "peak_bucket" | "busiest_weekday" | "after_hours";
  label: string;
  stats: LeadFlowStats;
};

export type LeadFlow = {
  total: number;
  cells: LeadFlowCell[];
  weekdays: LeadFlowGroup[];
  buckets: LeadFlowGroup[];
  afterHours: LeadFlowStats;
  peakBucket: LeadFlowGroup | null;
  /** The three highest-volume 2-hour buckets, and their combined stats. */
  topBuckets: LeadFlowGroup[];
  peakRisk: LeadFlowStats;
  busiestWeekday: LeadFlowGroup | null;
  /** At most three deterministic observations, all referencing the aggregates above. */
  staffingSignals: LeadFlowSignal[];
};

/**
 * Routed deals never enter any figure here: they left the funnel and were
 * never this team's load to process.
 */
export function buildLeadFlow(records: MetricRecord[]): LeadFlow {
  const eligible = records.filter(isEligibleCohortDeal);
  const total = eligible.length;
  const byCell = new Map<string, MetricRecord[]>();
  const byWeekday = new Map<number, MetricRecord[]>();
  const byBucket = new Map<number, MetricRecord[]>();
  for (const row of eligible) {
    const { weekday, hour } = tashkentParts(row.createdAt);
    const bucket = Math.floor(hour / BUCKET_HOURS);
    byCell.set(`${weekday}:${bucket}`, [...(byCell.get(`${weekday}:${bucket}`) ?? []), row]);
    byWeekday.set(weekday, [...(byWeekday.get(weekday) ?? []), row]);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row]);
  }

  const cells: LeadFlowCell[] = [];
  for (let weekday = 0; weekday < WEEKDAY_LABELS.length; weekday += 1) {
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
      cells.push({ weekday, bucket, ...statsFor(byCell.get(`${weekday}:${bucket}`) ?? [], total) });
    }
  }
  const weekdays = WEEKDAY_LABELS.map((label, weekday) => ({
    key: String(weekday), label, ...statsFor(byWeekday.get(weekday) ?? [], total),
  }));
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, bucket) => ({
    key: String(bucket), label: bucketLabel(bucket), ...statsFor(byBucket.get(bucket) ?? [], total),
  }));

  const ranked = [...buckets].sort((a, b) => b.leads - a.leads || Number(a.key) - Number(b.key));
  const topBuckets = ranked.filter((entry) => entry.leads > 0).slice(0, 3);
  const peakBucket = topBuckets[0] ?? null;
  const peakRiskRows = topBuckets.flatMap((entry) => byBucket.get(Number(entry.key)) ?? []);
  const afterHoursRows = eligible.filter((row) => row.creationPeriod === "AFTER_HOURS");
  const afterHoursStats = statsFor(afterHoursRows, total);
  const busiestWeekday = [...weekdays].sort((a, b) => b.leads - a.leads || Number(a.key) - Number(b.key))[0];
  const busiest = busiestWeekday?.leads ? busiestWeekday : null;
  const staffingSignals: LeadFlowSignal[] = [];
  if (peakBucket) staffingSignals.push({ id: "peak_bucket", label: peakBucket.label, stats: peakBucket });
  if (busiest) staffingSignals.push({ id: "busiest_weekday", label: busiest.label, stats: busiest });
  if (total) staffingSignals.push({ id: "after_hours", label: "After-hours", stats: afterHoursStats });

  return {
    total, cells, weekdays, buckets,
    afterHours: afterHoursStats,
    peakBucket,
    topBuckets,
    peakRisk: statsFor(peakRiskRows, total),
    busiestWeekday: busiest,
    staffingSignals,
  };
}

export function leadFlowValue(stats: LeadFlowStats, id: LeadFlowMetricId): number | null {
  switch (id) {
    case "volume": return stats.leads;
    case "overdue_rate": return stats.overdueRate;
    case "sla": return stats.slaRate;
    case "avg_processing": return stats.avgProcessing;
  }
}

/** Higher is worse for load, overdue and processing time; better for SLA. */
export function higherIsHealthier(id: LeadFlowMetricId) {
  return id === "sla";
}
