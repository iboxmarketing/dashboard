import { buildDashboardMetrics } from "./dashboard-metrics";
import type { MetricRecord } from "./dashboard-record";
import { notRelevantRecords, reasonBreakdown, salesLostRecords, type ReasonRow } from "./manager-profile";
import { salesManagerKey } from "./sales-logic";

/**
 * Lead Quality diagnostics over the selected created-at cohort.
 *
 * The helper intentionally has no UI concerns. Every population is selected by
 * the existing canonical predicates before it is grouped by reason or seller,
 * so presentation changes cannot redefine Not Relevant, Sales Lost or Routing.
 */

const percent = (value: number, total: number): number | null =>
  total ? Math.round((value / total) * 100) : null;

const isMissingReason = (row: { lossReason?: string | null }) =>
  !(row.lossReason ?? "").trim();

export type MarketingManagerDiagnostic = {
  id: string;
  name: string;
  isUnknown: boolean;
  classified: number;
  notRelevant: number;
  notRelevantRate: number | null;
  topReason: ReasonRow | null;
  topReasons: ReasonRow[];
  missingReasons: number;
  reasonFillRate: number | null;
  smallSample: boolean;
};

export type SalesManagerDiagnostic = {
  id: string;
  name: string;
  isUnknown: boolean;
  sql: number;
  salesLost: number;
  salesLostRate: number | null;
  sqlToSale: number | null;
  topReason: ReasonRow | null;
  topReasons: ReasonRow[];
  missingReasons: number;
  smallSample: boolean;
};

export type QualitySummary = {
  leads: number;
  classified: number;
  unclassified: number;
  classificationCoverage: number | null;
  notRelevant: number;
  notRelevantRate: number | null;
  salesLost: number;
  salesLostRate: number | null;
  missingReasons: number;
  missingReasonPopulation: number;
  missingReasonRate: number | null;
  topMarketingReason: ReasonRow | null;
  topSalesReason: ReasonRow | null;
  routing: number;
};

export type QualityAnalytics = {
  summary: QualitySummary;
  marketingReasons: ReasonRow[];
  salesReasons: ReasonRow[];
  routingReasons: ReasonRow[];
  marketingManagers: MarketingManagerDiagnostic[];
  salesManagers: SalesManagerDiagnostic[];
};

function managerGroups(rows: MetricRecord[]) {
  const grouped = new Map<string, MetricRecord[]>();
  for (const row of rows) {
    const id = salesManagerKey(row);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return [...grouped.entries()];
}

function managerName(id: string, rows: MetricRecord[]) {
  if (id === "unknown") return "Aniqlanmagan";
  return rows.find((row) => row.salesManager?.trim())?.salesManager?.trim() || "Aniqlanmagan";
}

/**
 * Stable real-seller samples lead the default diagnostic order. Small samples
 * stay visible below them, and `unknown` is always last because it is an
 * attribution bucket rather than a seller ranking candidate.
 */
function diagnosticOrder<T extends { isUnknown: boolean; smallSample: boolean }>(
  rows: T[],
  rate: (row: T) => number | null,
  count: (row: T) => number,
) {
  const tier = (row: T) => row.isUnknown ? 2 : row.smallSample ? 1 : 0;
  return rows.sort((a, b) =>
    tier(a) - tier(b)
    || (rate(b) ?? -1) - (rate(a) ?? -1)
    || count(b) - count(a));
}

export function buildQualityAnalytics(cohort: MetricRecord[]): QualityAnalytics {
  const metrics = buildDashboardMetrics(cohort, []);
  const notRelevant = notRelevantRecords(cohort);
  const salesLost = salesLostRecords(cohort);
  const routing = cohort.filter((row) => row.lossReasonGroup === "ROUTING");
  const marketingReasons = reasonBreakdown(notRelevant);
  const salesReasons = reasonBreakdown(salesLost);
  const routingReasons = reasonBreakdown(routing);
  const missingPopulation = [...notRelevant, ...salesLost];
  const missingReasons = missingPopulation.filter(isMissingReason).length;

  // Group the already-eligible population. A manager represented only by
  // Routing records therefore cannot appear in either manager table.
  const groups = managerGroups(metrics.eligible);
  const marketingManagers = diagnosticOrder(groups.map(([id, rows]) => {
    const managerMetrics = buildDashboardMetrics(rows, []);
    const managerNotRelevant = notRelevantRecords(rows);
    const reasons = reasonBreakdown(managerNotRelevant);
    const missing = managerNotRelevant.filter(isMissingReason).length;
    return {
      id,
      name: managerName(id, rows),
      isUnknown: id === "unknown",
      classified: managerMetrics.counts.classified_leads,
      notRelevant: managerMetrics.counts.not_relevant,
      notRelevantRate: percent(managerMetrics.counts.not_relevant, managerMetrics.counts.classified_leads),
      topReason: reasons[0] ?? null,
      topReasons: reasons.slice(0, 3),
      missingReasons: missing,
      reasonFillRate: percent(managerNotRelevant.length - missing, managerNotRelevant.length),
      smallSample: managerMetrics.counts.classified_leads < 3,
    } satisfies MarketingManagerDiagnostic;
  }), (row) => row.notRelevantRate, (row) => row.notRelevant);

  const salesManagers = diagnosticOrder(groups.map(([id, rows]) => {
    const managerMetrics = buildDashboardMetrics(rows, []);
    const managerSalesLost = salesLostRecords(rows);
    const reasons = reasonBreakdown(managerSalesLost);
    return {
      id,
      name: managerName(id, rows),
      isUnknown: id === "unknown",
      sql: managerMetrics.counts.sql,
      salesLost: managerMetrics.counts.sales_lost,
      salesLostRate: percent(managerMetrics.counts.sales_lost, managerMetrics.counts.sql),
      sqlToSale: percent(managerMetrics.counts.cohort_sales, managerMetrics.counts.sql),
      topReason: reasons[0] ?? null,
      topReasons: reasons.slice(0, 3),
      missingReasons: managerSalesLost.filter(isMissingReason).length,
      smallSample: managerMetrics.counts.sql < 3,
    } satisfies SalesManagerDiagnostic;
  }), (row) => row.salesLostRate, (row) => row.salesLost);

  return {
    summary: {
      leads: metrics.counts.leads,
      classified: metrics.counts.classified_leads,
      unclassified: metrics.counts.unclassified_leads,
      classificationCoverage: percent(metrics.counts.classified_leads, metrics.counts.leads),
      notRelevant: metrics.counts.not_relevant,
      notRelevantRate: percent(metrics.counts.not_relevant, metrics.counts.classified_leads),
      salesLost: metrics.counts.sales_lost,
      salesLostRate: percent(metrics.counts.sales_lost, metrics.counts.sql),
      missingReasons,
      missingReasonPopulation: missingPopulation.length,
      missingReasonRate: percent(missingReasons, missingPopulation.length),
      topMarketingReason: marketingReasons[0] ?? null,
      topSalesReason: salesReasons[0] ?? null,
      routing: routing.length,
    },
    marketingReasons,
    salesReasons,
    routingReasons,
    marketingManagers,
    salesManagers,
  };
}
