import { formatDurationMinutes } from "./format-duration";
import type {
  KpiBreakdown as ApiBreakdown,
  KpiBreakdownRow as ApiBreakdownRow,
  KpiDealFilter,
  KpiDetailResponse,
  KpiDisplayStat,
} from "./kpi-detail-contract";
import type {
  KpiBreakdown,
  KpiBreakdownRow,
  KpiDealRow,
  KpiDetail,
  KpiDetailOk,
  KpiDrilldown,
  KpiFormat,
  KpiSummaryItem,
} from "./kpi-detail";

/** Empty grouping keys need a non-empty URL representation. */
export const KPI_EMPTY_BREAKDOWN_VALUE = "__empty__";

const number = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 1 });

function displayNumber(value: number) {
  return number.format(value);
}

export function formatKpiValue(value: number | null, format: KpiFormat, currency = ""): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "percent": return `${displayNumber(value)}%`;
    case "money": return `${displayNumber(value)} ${currency || "UZS"}`;
    case "duration_minutes": return formatDurationMinutes(value);
    case "duration_hours": return formatDurationMinutes(value * 60);
    case "count": return Math.round(value).toLocaleString("uz-UZ");
    case "text": return displayNumber(value);
  }
}

function dateLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function periodLabel(from: string, to: string) {
  if (from && to) return `${dateLabel(from)} — ${dateLabel(to)}`;
  if (from) return `${dateLabel(from)} dan`;
  if (to) return `${dateLabel(to)} gacha`;
  return "Barcha davr";
}

function filterValue(value: string) {
  return value || KPI_EMPTY_BREAKDOWN_VALUE;
}

function dealFilter(drilldown: KpiDrilldown, label?: string): KpiDealFilter {
  return {
    key: drilldown.dimension,
    value: filterValue(drilldown.value),
    segment: drilldown.segment,
    ...(label ? { label } : {}),
  };
}

function summaryItem(item: KpiSummaryItem): KpiDisplayStat {
  return {
    id: item.key,
    label: item.label,
    value: formatKpiValue(item.value, item.format, item.currency),
    ...(item.helpText ? { note: item.helpText } : {}),
  };
}

function breakdownColumns(breakdown: KpiBreakdown) {
  const extra = new Map<string, string>();
  for (const row of breakdown.rows) {
    for (const cell of row.cells ?? []) extra.set(cell.key, cell.label);
  }
  return [
    { key: breakdown.dimension, label: breakdown.title },
    { key: "count", label: "Deal", align: "right" as const },
    ...(breakdown.rows.some((row) => row.value !== undefined)
      ? [{ key: "value", label: "O‘rtacha", align: "right" as const }]
      : []),
    ...[...extra].map(([key, label]) => ({ key, label, align: "right" as const })),
    ...(breakdown.rows.some((row) => row.rate !== undefined)
      ? [{ key: "rate", label: "Ulush", align: "right" as const }]
      : []),
  ];
}

function breakdownRow(breakdown: KpiBreakdown, row: KpiBreakdownRow): ApiBreakdownRow {
  const cells: ApiBreakdownRow["cells"] = {
    [breakdown.dimension]: row.label,
    count: formatKpiValue(row.count, "count"),
  };
  if (row.value !== undefined) cells.value = formatKpiValue(row.value ?? null, row.format ?? "count");
  for (const cell of row.cells ?? []) cells[cell.key] = formatKpiValue(cell.value, cell.format);
  if (row.rate !== undefined) cells.rate = formatKpiValue(row.rate, "percent");
  return {
    id: `${breakdown.key}:${filterValue(row.key)}`,
    cells,
    dealFilter: dealFilter(row.drilldown, row.label),
  };
}

function presentBreakdown(breakdown: KpiBreakdown): ApiBreakdown {
  return {
    id: breakdown.key,
    title: breakdown.title,
    subtitle: `${breakdown.populationLabel}: ${formatKpiValue(breakdown.total, "count")}`,
    columns: breakdownColumns(breakdown),
    rows: breakdown.rows.map((row) => breakdownRow(breakdown, row)),
  };
}

function presentDeal(row: KpiDealRow) {
  return {
    id: row.dealId,
    title: row.title,
    createdAt: row.createdAt,
    manager: row.managerName,
    source: row.sourceName,
    stage: row.stageName,
    status: row.statusLabel,
    opportunity: formatKpiValue(row.opportunity, "money", row.currency),
    bitrixUrl: row.bitrixUrl,
  };
}

function appliedFilters(detail: KpiDetail) {
  const chips = [];
  for (const manager of detail.appliedFilters.managers) chips.push({ id: `manager:${manager}`, label: "Menejer", value: manager });
  for (const source of detail.appliedFilters.sources) chips.push({ id: `source:${source}`, label: "Manba", value: source });
  for (const [id, label, value] of [
    ["pipeline", "Pipeline", detail.appliedFilters.pipeline],
    ["stage", "Stage", detail.appliedFilters.stage],
    ["period", "Vaqt", detail.appliedFilters.period],
    ["sla", "SLA", detail.appliedFilters.sla],
    ["processing", "Saralash", detail.appliedFilters.processing],
    ["search", "Qidiruv", detail.appliedFilters.search],
  ] as const) {
    if (value) chips.push({ id, label, value });
  }
  return chips;
}

function metricPopulation(detail: KpiDetailOk) {
  if (detail.metric === "icp_fit") return detail.segments.find((segment) => segment.key === "lead")?.count ?? 0;
  return detail.deals.total;
}

/**
 * Thin presentation adapter for the completed UI contract. It formats already
 * computed values and maps server drilldown keys; it never classifies a Deal
 * or recalculates a KPI.
 */
export function presentKpiDetail(detail: KpiDetail): KpiDetailResponse {
  const base = {
    project: detail.project,
    metric: detail.metric,
    template: detail.template,
    title: detail.title,
    subtitle: detail.subtitle,
    definition: detail.definition,
    period: { from: detail.period.from || null, to: detail.period.to || null, label: periodLabel(detail.period.from, detail.period.to) },
    appliedFilters: appliedFilters(detail),
  } satisfies Pick<KpiDetailResponse, "project" | "metric" | "template" | "title" | "subtitle" | "definition" | "period" | "appliedFilters">;

  if (detail.status === "NOT_APPLICABLE") {
    return { ...base, status: "NOT_APPLICABLE", message: detail.reason };
  }

  return {
    ...base,
    status: metricPopulation(detail) === 0 ? "EMPTY" : "READY",
    hero: {
      value: formatKpiValue(detail.hero.value, detail.hero.format, detail.hero.currency),
      rate: detail.hero.rate === undefined || detail.hero.rate === null
        ? null
        : { value: formatKpiValue(detail.hero.rate, "percent"), label: detail.hero.rateLabel ?? "Ulush" },
      comparison: detail.hero.comparisonValue === undefined || detail.hero.comparisonValue === null
        ? null
        : { value: formatKpiValue(detail.hero.comparisonValue, detail.hero.format, detail.hero.currency), label: detail.hero.comparisonLabel ?? "Oldingi davr" },
    },
    summary: detail.summary.map(summaryItem),
    funnel: detail.funnel?.map((step) => ({
      id: step.key,
      label: step.label,
      value: formatKpiValue(step.count, "count"),
      transition: step.rateFromPrevious === undefined
        ? null
        : { value: formatKpiValue(step.rateFromPrevious, "percent"), label: step.rateLabel ?? "O‘tish" },
      dealFilter: { key: "population", value: step.drilldown.segment, segment: step.drilldown.segment, label: step.label },
    })),
    breakdowns: detail.breakdowns.map(presentBreakdown),
    distribution: detail.distribution ? {
      title: detail.distribution.title,
      subtitle: `${detail.distribution.populationLabel}: ${formatKpiValue(detail.distribution.total, "count")}`,
      items: detail.distribution.rows.map((row) => ({
        id: filterValue(row.key),
        label: row.label,
        value: formatKpiValue(row.count, "count"),
        share: row.rate === undefined ? null : formatKpiValue(row.rate, "percent"),
        dealFilter: dealFilter(row.drilldown, row.label),
      })),
    } : null,
    deals: {
      title: detail.deals.title,
      total: formatKpiValue(detail.deals.total, "count"),
      page: detail.deals.page,
      pageSize: detail.deals.pageSize,
      pageCount: detail.deals.totalPages,
      searchable: !detail.deals.restricted,
      sortableOpportunity: detail.metric === "average_check" && !detail.deals.restricted,
      activeSegment: detail.deals.segment,
      segments: detail.segments.map((segment) => ({ id: segment.key, label: segment.label, count: formatKpiValue(segment.count, "count") })),
      rows: detail.deals.rows.map(presentDeal),
    },
  };
}
