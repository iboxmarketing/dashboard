import { buildDashboardMetrics } from "./dashboard-metrics";
import type { MetricRecord } from "./dashboard-record";
import { isSalesLost, MISSING_LOSS_REASON, salesManagerKey } from "./sales-logic";

/**
 * Individual seller profile.
 *
 * Every figure runs through the canonical `buildDashboardMetrics`, the same
 * helper behind the Dashboard cards and the manager funnel table, so a profile
 * reconciles with the row that was clicked to open it. There is deliberately no
 * third set of formulas here.
 */

export type ManagerProfile = ReturnType<typeof buildManagerProfile>;

export function managerRecords(records: MetricRecord[], managerId: string) {
  return records.filter((row) => salesManagerKey(row) === managerId);
}

export function buildManagerProfile(cohortRecords: MetricRecord[], salesRecords: MetricRecord[], managerId: string) {
  const cohort = managerRecords(cohortRecords, managerId);
  const periodSales = managerRecords(salesRecords, managerId);
  return { cohort, periodSales, metrics: buildDashboardMetrics(cohort, periodSales) };
}

/** Median, not mean: one outlier seller should not move the team line. */
export function medianOf(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

/**
 * Team median for a seller-controlled metric.
 *
 * `eligible` excludes managers for whom the metric is undefined rather than
 * bad — a seller with no SQL has no closing rate, and counting them as 0%
 * would drag the benchmark down and flatter everyone above it.
 */
export function teamMedian<T>(rows: T[], value: (row: T) => number | null, eligible: (row: T) => boolean) {
  return medianOf(rows.filter(eligible).map(value).filter((entry): entry is number => entry !== null));
}

/** One reason line: share is always of its own population, never of all losses. */
export type ReasonRow = { reason: string; count: number; share: number };

export function reasonBreakdown(rows: { lossReason?: string | null }[]): ReasonRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = (row.lossReason || "").trim() || MISSING_LOSS_REASON;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const total = rows.length;
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, share: total ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Canonical Not Relevant population — marketing rejections only. */
export function notRelevantRecords(cohort: MetricRecord[]) {
  return cohort.filter((row) => row.lossReasonGroup === "MARKETING");
}

/** Canonical Sales Lost — qualified and lost by sales. Pre-SQL closures excluded. */
export function salesLostRecords(cohort: MetricRecord[]) {
  return cohort.filter(isSalesLost);
}

/**
 * A record presenting as Not Relevant while carrying a non-MARKETING loss
 * group. Canonically impossible, so a non-zero count is a data or config
 * problem to report — never something to paper over by moving the record.
 */
export function notRelevantSemanticMismatches(cohort: MetricRecord[]) {
  return cohort.filter((row) => row.salesStatus === "LOW_QUALITY" && row.lossReasonGroup !== "MARKETING");
}

/** Sales-group records whose reason text claims Not Relevant — a labelling smell. */
export function reasonTextMismatches(cohort: MetricRecord[]) {
  return cohort.filter((row) =>
    row.lossReasonGroup === "SALES" && /not\s*relevant|не\s*релевант/i.test(String(row.lossReason ?? "")));
}

export type SourceFunnelRow = {
  source: string;
  leads: number; classified: number; coverage: number;
  sql: number; qualityAcceptedRate: number;
  notRelevant: number; lowQualityRate: number;
  cohortSales: number; leadToSale: number; cohortRevenue: number;
  sqlToSale: number; salesLost: number; salesLostRate: number;
  currency: string;
};

/**
 * Per-source created-cohort funnel.
 *
 * Period sales are deliberately absent: this table answers "what did each
 * source produce from the leads created in this period", and a sale won in the
 * period may belong to a lead created before it. Mixing the two time axes here
 * is what made the previous table unreadable.
 */
export function sourceFunnelRows(cohort: MetricRecord[]): SourceFunnelRow[] {
  const bySource = new Map<string, MetricRecord[]>();
  for (const row of cohort) {
    const key = row.source || "Aniqlanmagan";
    bySource.set(key, [...(bySource.get(key) ?? []), row]);
  }
  return [...bySource.entries()].flatMap(([source, rows]) => {
    const metrics = buildDashboardMetrics(rows, []);
    // Grouping happens before canonical eligibility, so a routing-only source
    // exists in the Map but must not become a visible zero-Lead row.
    if (metrics.counts.leads === 0) return [];
    return [{
      source,
      leads: metrics.counts.leads,
      classified: metrics.counts.classified_leads,
      coverage: metrics.rates.classification_coverage,
      sql: metrics.counts.sql,
      qualityAcceptedRate: metrics.rates.quality_accepted_rate,
      notRelevant: metrics.counts.not_relevant,
      lowQualityRate: metrics.rates.low_quality_rate,
      cohortSales: metrics.counts.cohort_sales,
      leadToSale: metrics.rates.lead_to_sale,
      cohortRevenue: metrics.money.cohort_revenue,
      sqlToSale: metrics.rates.sql_to_sale,
      salesLost: metrics.counts.sales_lost,
      salesLostRate: metrics.rates.sales_lost,
      currency: metrics.money.currency,
    }];
  }).sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));
}

export type StageWorkloadRow = { stage: string; active: number; overdue: number; overdueRate: number };

/** Live open deals, ordered so the stages with a problem surface first. */
export function stageWorkloadRows(rows: { stage: string; stageOverdue?: boolean }[]): StageWorkloadRow[] {
  const byStage = new Map<string, { active: number; overdue: number }>();
  for (const row of rows) {
    const entry = byStage.get(row.stage) ?? { active: 0, overdue: 0 };
    entry.active += 1;
    if (row.stageOverdue) entry.overdue += 1;
    byStage.set(row.stage, entry);
  }
  return [...byStage.entries()]
    .map(([stage, entry]) => ({
      stage, active: entry.active, overdue: entry.overdue,
      overdueRate: entry.active ? Math.round((entry.overdue / entry.active) * 100) : 0,
    }))
    .sort((a, b) => b.overdue - a.overdue || b.active - a.active || a.stage.localeCompare(b.stage));
}
