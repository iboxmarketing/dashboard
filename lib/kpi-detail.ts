import type { PermissionKey } from "./auth/permissions";
import { headlineCardLabel, type HeadlineCardId } from "./dashboard-cards";
import type { DashboardRecord, MetricRecord } from "./dashboard-record";
import { average, buildDashboardMetrics, median, type DashboardMetrics } from "./dashboard-metrics";
import { FUNNEL_OWNER_LABELS, funnelOwnerKey } from "./funnel-owner";
import { resolveManagerName } from "./manager-identity";
import { countIcp, ICP_NOT_FIT, ICP_UNSET, type IcpConfig } from "./marketing/icp";
import { workspaceForProject, workspaceIcp } from "./marketing/workspaces";
import { dateKey } from "./period";
import { dealOutcomeLabel, MISSING_LOSS_REASON } from "./sales-logic";
import type { ProjectKey } from "./sales-projects";
import { activeRoster, buildManagers, salesPopulations, type SalesQuery } from "./sales-sections";
import { SLA_LABELS } from "./sla";

/**
 * KPI Detail: what makes up one Dashboard KPI, how it is distributed, and the
 * exact Deals inside it.
 *
 * No KPI is defined here. Every population is one of the arrays
 * `buildDashboardMetrics` already returns for the Dashboard card — built from
 * the same `salesPopulations` split with the same filters — and every headline
 * figure is read from the same metrics object the card reads. ICP classes are
 * Marketing's stored classification (`marketing_deal_attribution.icp_class`,
 * written by `readIcp`), counted with Marketing's `countIcp`.
 *
 * A breakdown row and its drilldown use one key function over one population,
 * so the row's count is the drilldown's total by construction.
 *
 * Pure: the route (`app/api/kpi-detail/route.ts`) does the D1 reads.
 */

export const KPI_METRICS = [
  "leads", "sorted", "sql", "not_relevant", "lost", "cohort_sales", "period_sales", "average_check",
  "sales_cycle", "active_leads", "sla_response", "calendar_response", "funnel_conversion", "sorting_time", "icp_fit",
] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export function isKpiMetric(value: unknown): value is KpiMetric {
  return typeof value === "string" && (KPI_METRICS as readonly string[]).includes(value);
}

/** The Dashboard headline card each metric details. ICP has no Sales card; it is Marketing's. */
export const KPI_CARD: Record<KpiMetric, HeadlineCardId | null> = {
  leads: "leads", sorted: "classified_leads", sql: "sql", not_relevant: "not_relevant", lost: "sales_lost",
  cohort_sales: "cohort_sales", period_sales: "period_sales", average_check: "avg_check", sales_cycle: "sales_cycle",
  active_leads: "active_cohort", sla_response: "sla_avg", calendar_response: "sla_elapsed",
  funnel_conversion: "lead_to_sql", sorting_time: "avg_processing", icp_fit: null,
};

export type KpiTemplate = "population" | "sales" | "time" | "funnel";
export type KpiFormat = "count" | "percent" | "money" | "duration_minutes" | "duration_hours" | "text";
export type KpiDimension = "owner" | "source" | "stage" | "pipeline" | "reason" | "created_day" | "sale_day" | "bucket" | "icp" | "sla_status";

export const KPI_PAGE_SIZES = [25, 50, 100] as const;
export const KPI_DEFAULT_PAGE_SIZE = 50;
export const KPI_PRESETS = ["", "today", "yesterday", "7", "30", "month", "lastMonth", "custom"] as const;

/* ------------------------------------------------------------------ query */

export type KpiDetailQuery = SalesQuery & {
  metric: KpiMetric;
  preset: string;
  /** Which sub-population the Deal list shows (e.g. `unsorted`, `on_time`, a funnel step). Empty → the metric's own. */
  segment: string;
  /** Drilldown: one breakdown row of the segment. Both or neither. */
  dimension: KpiDimension | "";
  value: string;
  page: number;
  pageSize: number;
};

const DIMENSIONS = new Set<string>(["owner", "source", "stage", "pipeline", "reason", "created_day", "sale_day", "bucket", "icp", "sla_status"]);

/** The KPI-specific parameters, on top of the Dashboard's own `parseSalesQuery`. */
export function parseKpiParams(params: URLSearchParams):
  { ok: true; params: Omit<KpiDetailQuery, keyof SalesQuery> } | { ok: false; error: string } {
  const text = (key: string) => (params.get(key) ?? "").trim();
  const metric = text("metric");
  if (!isKpiMetric(metric)) return { ok: false, error: "KPI noma’lum" };
  const preset = text("preset");
  if (!(KPI_PRESETS as readonly string[]).includes(preset)) return { ok: false, error: "Sana oralig‘i noto‘g‘ri" };
  const dimension = text("dimension");
  const value = params.get("value") ?? "";
  if (dimension && !DIMENSIONS.has(dimension)) return { ok: false, error: "Breakdown o‘lchami noto‘g‘ri" };
  if (Boolean(dimension) !== params.has("value")) return { ok: false, error: "Drilldown uchun dimension va value birga kerak" };
  const segment = text("segment");
  if (segment.length > 40 || value.length > 200) return { ok: false, error: "Parametr juda uzun" };
  const page = text("page") ? Number(text("page")) : 1;
  const pageSize = text("pageSize") ? Number(text("pageSize")) : KPI_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1 || page > 100_000) return { ok: false, error: "Sahifa noto‘g‘ri" };
  if (!(KPI_PAGE_SIZES as readonly number[]).includes(pageSize)) return { ok: false, error: "Sahifa hajmi 25, 50 yoki 100" };
  return { ok: true, params: { metric, preset, segment, dimension: dimension as KpiDimension | "", value, page, pageSize } };
}

/* -------------------------------------------------------------- contract */

export type KpiHero = {
  value: number | null; format: KpiFormat; label: string; currency?: string;
  denominatorValue?: number; denominatorLabel?: string;
  /** Whole percent, rounded exactly as the Dashboard card rounds it. */
  rate?: number | null; rateLabel?: string;
  comparisonValue?: number | null; comparisonRate?: number | null; comparisonLabel?: string;
};
export type KpiSummaryItem = { key: string; label: string; value: number | null; format: KpiFormat; currency?: string; helpText?: string };
export type KpiDrilldown = { segment: string; dimension: KpiDimension; value: string };
export type KpiCell = { key: string; label: string; value: number | null; format: KpiFormat };
export type KpiBreakdownRow = {
  key: string; label: string; count: number;
  value?: number | null; format?: KpiFormat;
  /** Share of the breakdown's population, whole percent. */
  rate?: number; rateLabel?: string;
  cells?: KpiCell[];
  drilldown: KpiDrilldown;
};
export type KpiBreakdown = { key: string; title: string; dimension: KpiDimension; segment: string; populationLabel: string; total: number; rows: KpiBreakdownRow[] };
export type KpiFunnelStep = { key: string; label: string; count: number; rateFromPrevious?: number; rateLabel?: string; drilldown: { segment: string } };
export type KpiSegmentInfo = { key: string; label: string; count: number };
export type KpiDealRow = {
  dealId: string; title: string; createdAt: string;
  managerId: string; managerName: string;
  sourceId: string; sourceName: string;
  stageId: string; stageName: string; pipeline: string;
  statusLabel: string;
  opportunity: number; currency: string;
  wonAt: string | null;
  lossReason?: string;
  slaStatus?: string;
  icpClass?: string;
  metricValue?: number | null; metricFormat?: KpiFormat;
  bitrixUrl: string | null;
};
export type KpiDeals = {
  title: string; populationLabel: string; segment: string;
  drilldown: KpiDrilldown | null;
  total: number; page: number; pageSize: number; totalPages: number;
  /** Rows withheld because the caller lacks `deals`; `total` is still the population. */
  restricted: boolean;
  rows: KpiDealRow[];
};

type Base = {
  metric: KpiMetric; template: KpiTemplate; title: string; subtitle: string; definition: string;
  project: ProjectKey; workspace: string;
  period: { from: string; to: string; preset: string };
  appliedFilters: { managers: string[]; sources: string[]; pipeline: string; stage: string; period: string; sla: string; processing: string; search: string };
};
export type KpiDetailOk = Base & {
  status: "OK";
  hero: KpiHero;
  summary: KpiSummaryItem[];
  funnel?: KpiFunnelStep[];
  segments: KpiSegmentInfo[];
  breakdowns: KpiBreakdown[];
  distribution?: KpiBreakdown;
  deals: KpiDeals;
  /** Breakdowns left out because the caller lacks their permission. */
  restricted: string[];
};
export type KpiDetailNotApplicable = Base & { status: "NOT_APPLICABLE"; reason: string; hero: null; summary: []; breakdowns: []; deals: null };
export type KpiDetail = KpiDetailOk | KpiDetailNotApplicable;

export type KpiContext = {
  project: ProjectKey;
  can: (permission: PermissionKey) => boolean;
  settings: { salesStaffIds?: string[] };
  /** ICP class per Deal ID from Marketing's attribution store; only read for `icp_fit`. */
  icpClasses?: ReadonlyMap<string, string>;
};

export class KpiDetailError extends Error {}

/* --------------------------------------------------------------- helpers */

const percent = (value: number, total: number) => (total ? Math.round((value / total) * 100) : 0);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const NONE = "";

type Row = MetricRecord;
type Bucket = { key: string; label: string; test: (value: number) => boolean };

function buckets(edges: number[], labels: string[]): Bucket[] {
  return labels.map((label, index) => {
    const low = index === 0 ? -Infinity : edges[index - 1];
    const high = index < edges.length ? edges[index] : Infinity;
    return { key: `b${index}`, label, test: (value: number) => value >= low && value < high };
  });
}

/** Simple, stable buckets. Lower bound inclusive. Units are the metric's own. */
const BUCKETS = {
  // Money in the record's own currency, unchanged from the Dashboard.
  check: [{ key: "zero", label: "0", test: (value: number) => value === 0 }, ...buckets([500_000, 1_000_000, 2_000_000, 5_000_000], ["< 500 ming", "500 ming – 1 mln", "1 – 2 mln", "2 – 5 mln", "5 mln+"]).map((bucket, index) => (
    index === 0 ? { ...bucket, test: (value: number) => value > 0 && value < 500_000 } : bucket))],
  cycleHours: buckets([24, 72, 168, 336], ["< 1 kun", "1 – 3 kun", "3 – 7 kun", "7 – 14 kun", "14+ kun"]),
  sortingMinutes: buckets([60, 240, 480, 1440], ["< 1 soat", "1 – 4 soat", "4 – 8 soat", "8 – 24 soat", "24+ soat"]),
  slaMinutes: buckets([15, 60, 240, 480], ["< 15 daqiqa", "15 – 60 daqiqa", "1 – 4 soat", "4 – 8 soat", "8+ soat"]),
  calendarMinutes: buckets([60, 240, 1440, 4320], ["< 1 soat", "1 – 4 soat", "4 – 24 soat", "1 – 3 kun", "3+ kun"]),
  stageAgeHours: buckets([24, 72, 168, 336], ["< 1 kun", "1 – 3 kun", "3 – 7 kun", "7 – 14 kun", "14+ kun"]),
} satisfies Record<string, Bucket[]>;

/** The value each time/money metric averages, read from the same field the card averages. */
type Measure = { read: (row: Row) => number | null | undefined; format: KpiFormat; buckets: Bucket[] };
const MEASURES: Partial<Record<KpiMetric, Measure>> = {
  average_check: { read: (row) => row.opportunity, format: "money", buckets: BUCKETS.check },
  sales_cycle: { read: (row) => row.salesCycleHours, format: "duration_hours", buckets: BUCKETS.cycleHours },
  sla_response: { read: (row) => row.slaBusinessMinutes, format: "duration_minutes", buckets: BUCKETS.slaMinutes },
  calendar_response: { read: (row) => row.slaElapsedMinutes, format: "duration_minutes", buckets: BUCKETS.calendarMinutes },
  sorting_time: { read: (row) => row.processingBusinessMinutes, format: "duration_minutes", buckets: BUCKETS.sortingMinutes },
  active_leads: { read: (row) => row.stageAgeHours, format: "duration_hours", buckets: BUCKETS.stageAgeHours },
};

/* -------------------------------------------------------------- segments */

type Segment = { key: string; label: string; rows: Row[] };

/**
 * Every sub-population a metric can list, each an exact canonical array.
 * The first segment is the metric's own population.
 */
function segmentsFor(metric: KpiMetric, m: DashboardMetrics, icp: IcpView | null): Segment[] {
  const measured = (rows: Row[], read: Measure["read"]) => rows.filter((row) => finite(read(row)));
  switch (metric) {
    case "leads": return [{ key: "leads", label: "Leadlar", rows: m.eligible }];
    case "sorted": return [
      { key: "sorted", label: "Saralangan", rows: m.classified },
      { key: "unsorted", label: "Saralanmagan", rows: m.unclassified },
      { key: "leads", label: "Leadlar", rows: m.eligible },
    ];
    case "sql": return [{ key: "sql", label: "SQL", rows: m.sql }, { key: "sorted", label: "Saralangan", rows: m.classified }];
    case "not_relevant": return [{ key: "not_relevant", label: "Not Relevant", rows: m.notRelevant }, { key: "sorted", label: "Saralangan", rows: m.classified }];
    case "lost": return [{ key: "lost", label: "Sotilmadi", rows: m.salesLost }, { key: "sql", label: "SQL", rows: m.sql }];
    case "cohort_sales": return [
      { key: "sale", label: "Kelgan leadlardan sotuv", rows: m.cohortSales },
      { key: "lead", label: "Leadlar", rows: m.eligible },
      { key: "sorted", label: "Saralangan", rows: m.classified },
      { key: "sql", label: "SQL", rows: m.sql },
    ];
    case "period_sales": return [{ key: "period_sales", label: "Shu davrdagi sotuvlar", rows: m.periodSales }];
    // Average check averages every period sale's opportunity: the whole period population.
    case "average_check": return [{ key: "period_sales", label: "Shu davrdagi sotuvlar", rows: m.periodSales }];
    // Each average runs over the rows that carry the averaged value — that is
    // exactly what `average` keeps — so the list is the statistic's population.
    case "sales_cycle": return [{ key: "measured", label: "Sikli hisoblangan sotuvlar", rows: measured(m.periodSales, (row) => row.salesCycleHours) }];
    case "active_leads": return [{ key: "active", label: "Aktiv leadlar", rows: m.active }];
    case "sla_response": return [
      { key: "completed", label: "SLA yakunlangan", rows: m.slaCompleted },
      ...(["ON_TIME", "LATE", "OVERDUE_UNPROCESSED", "PENDING", "UNKNOWN_EVIDENCE"] as const).map((state) => ({
        key: state.toLowerCase(), label: SLA_LABELS[state], rows: m.eligible.filter((row) => row.slaStatus === state),
      })),
      { key: "leads", label: "Leadlar", rows: m.eligible },
    ];
    case "calendar_response": return [{ key: "measured", label: "Kalendar vaqti hisoblangan", rows: measured(m.slaCompleted, (row) => row.slaElapsedMinutes) }];
    case "sorting_time": return [
      { key: "measured", label: "Saralash vaqti hisoblangan", rows: measured(m.eligible, (row) => row.processingBusinessMinutes) },
      { key: "not_measured", label: "Vaqti noma’lum", rows: m.eligible.filter((row) => !finite(row.processingBusinessMinutes)) },
    ];
    case "funnel_conversion": return [
      { key: "lead", label: "Leadlar", rows: m.eligible },
      { key: "sorted", label: "Saralangan", rows: m.classified },
      { key: "sql", label: "SQL", rows: m.sql },
      { key: "sale", label: "Kelgan leadlardan sotuv", rows: m.cohortSales },
    ];
    case "icp_fit": {
      if (!icp) return [];
      const of = (test: (cls: string) => boolean) => m.eligible.filter((row) => test(icp.classOf(row)));
      return [
        { key: "fit", label: "ICP mos", rows: of((cls) => icp.config.enabled && icp.config.fitValues.includes(cls)) },
        { key: "not_fit", label: "ICP mos emas", rows: of((cls) => cls === ICP_NOT_FIT) },
        { key: "evaluated", label: "Baholangan", rows: of((cls) => cls === ICP_NOT_FIT || (icp.config.enabled && icp.config.fitValues.includes(cls))) },
        { key: "unset", label: "Belgilanmagan", rows: of((cls) => cls === ICP_UNSET) },
        { key: "lead", label: "Leadlar", rows: m.eligible },
      ];
    }
  }
}

/* ------------------------------------------------------------ dimensions */

type IcpView = { config: IcpConfig; classOf: (row: Row) => string; attributed: (row: Row) => boolean };

type DimensionSpec = { title: string; keyOf: (row: Row) => string; labelOf: (key: string, rows: Row[]) => string; order?: "count" | "key" | "given"; given?: string[] };

function dimensionSpec(dimension: KpiDimension, metric: KpiMetric, icp: IcpView | null): DimensionSpec {
  switch (dimension) {
    // The Managers table's partition, so a row here equals that manager's row there.
    case "owner": return { title: "Menejer", keyOf: (row) => funnelOwnerKey(row), labelOf: (key, rows) => resolveManagerName(key, rows, FUNNEL_OWNER_LABELS) };
    case "source": return { title: "Manba", keyOf: (row) => row.source || NONE, labelOf: (key) => key || "Aniqlanmagan" };
    case "stage": return { title: "Joriy stage", keyOf: (row) => row.stage || NONE, labelOf: (key) => key || "Stage ko‘rsatilmagan" };
    case "pipeline": return { title: "Pipeline", keyOf: (row) => row.originPipeline || NONE, labelOf: (key) => key || "Aniqlanmagan" };
    // Diagnostic only: the reason never decided membership, it only labels it.
    case "reason": return { title: "Sabab", keyOf: reasonKey, labelOf: (key) => key };
    case "created_day": return { title: "Kelgan kun", keyOf: (row) => dayOf(row.createdAt), labelOf: (key) => key || "Sana yo‘q", order: "key" };
    case "sale_day": return { title: "Sotuv kuni", keyOf: (row) => dayOf(row.wonAt), labelOf: (key) => key || "Sana yo‘q", order: "key" };
    case "sla_status": return { title: "SLA holati", keyOf: (row) => row.slaStatus, labelOf: (key) => SLA_LABELS[key as keyof typeof SLA_LABELS] ?? key, order: "given", given: Object.keys(SLA_LABELS) };
    case "icp": return {
      title: "ICP qiymati", keyOf: (row) => icp?.classOf(row) ?? ICP_UNSET,
      labelOf: (key) => (key === ICP_NOT_FIT ? "Other (mos emas)" : key === ICP_UNSET ? "Belgilanmagan" : key),
      order: "given", given: [...(icp?.config.enabled ? icp.config.fitValues : []), ICP_NOT_FIT, ICP_UNSET],
    };
    case "bucket": {
      const measure = MEASURES[metric];
      if (!measure) throw new KpiDetailError("Bu KPI uchun taqsimot yo‘q");
      return {
        title: "Taqsimot", order: "given", given: measure.buckets.map((bucket) => bucket.key),
        keyOf: (row) => { const value = measure.read(row); return finite(value) ? measure.buckets.find((bucket) => bucket.test(value))?.key ?? NONE : NONE; },
        labelOf: (key) => measure.buckets.find((bucket) => bucket.key === key)?.label ?? "Qiymat yo‘q",
      };
    }
  }
}

/**
 * The reason a closed Lead carries, exactly as `reasonBreakdown` groups it. The
 * builder already writes MISSING_LOSS_REASON for an empty field; an older
 * record's blank lands in the same row.
 */
const reasonKey = (row: Row) => (row.lossReason || "").trim() || MISSING_LOSS_REASON;
const missingReason = (row: Row) => reasonKey(row) === MISSING_LOSS_REASON;

function dayOf(value: string | null | undefined) {
  if (!value) return NONE;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateKey(date) : NONE;
}

/** Which breakdowns and drilldown dimensions each metric offers, per segment. */
function breakdownPlan(metric: KpiMetric): { segment: string; dimension: KpiDimension; title?: string }[] {
  const on = (segment: string, ...dims: KpiDimension[]) => dims.map((dimension) => ({ segment, dimension }));
  switch (metric) {
    case "leads": return on("leads", "owner", "source", "stage", "pipeline", "created_day");
    case "sorted": return [
      { segment: "sorted", dimension: "stage", title: "Saralangan — joriy stage’lar" },
      { segment: "unsorted", dimension: "stage", title: "Saralanmagan — joriy stage’lar" },
      ...on("sorted", "owner", "source"),
    ];
    case "sql": return on("sql", "owner", "source", "stage");
    case "not_relevant": return on("not_relevant", "reason", "owner", "source");
    case "lost": return on("lost", "reason", "owner", "source");
    case "cohort_sales": return on("sale", "owner", "source", "created_day");
    case "period_sales": return on("period_sales", "owner", "source", "sale_day");
    case "average_check": return on("period_sales", "owner", "source");
    case "sales_cycle": return on("measured", "owner", "source");
    case "active_leads": return on("active", "owner", "stage", "source");
    case "sla_response": return [...on("completed", "owner"), ...on("leads", "sla_status")];
    case "calendar_response": return on("measured", "owner");
    case "sorting_time": return on("measured", "owner", "source");
    // Shown as one comparison table (the Managers table's rows); each step drills by owner.
    case "funnel_conversion": return [];
    case "icp_fit": return on("lead", "icp", "source");
  }
}

/* ---------------------------------------------------------------- build */

function groupRows(rows: Row[], keyOf: (row: Row) => string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  return groups;
}

function buildBreakdown(segment: Segment, dimension: KpiDimension, metric: KpiMetric, icp: IcpView | null, title?: string): KpiBreakdown {
  const spec = dimensionSpec(dimension, metric, icp);
  const groups = groupRows(segment.rows, spec.keyOf);
  const measure = MEASURES[metric];
  // Time metrics compare each group's own average of the same value; counts stay counts.
  const timed = measure && dimension !== "bucket" && metric !== "active_leads" ? measure : null;
  let keys = [...groups.keys()];
  if (spec.order === "key") keys.sort();
  else if (spec.order === "given" && spec.given) keys = [...spec.given.filter((key) => groups.has(key)), ...keys.filter((key) => !spec.given!.includes(key))];
  else keys.sort((a, b) => groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  const rows = keys.map((key): KpiBreakdownRow => {
    const members = groups.get(key)!;
    return {
      key, label: spec.labelOf(key, members), count: members.length,
      ...(timed ? { value: average(members.map((row) => timed.read(row) ?? null)), format: timed.format } : {}),
      rate: percent(members.length, segment.rows.length), rateLabel: `${segment.label}dan ulushi`,
      ...(metric === "icp_fit" && dimension !== "icp" && icp ? { cells: icpCells(members, icp) } : {}),
      drilldown: { segment: segment.key, dimension, value: key },
    };
  });
  return { key: `${segment.key}:${dimension}`, title: title ?? spec.title, dimension, segment: segment.key, populationLabel: segment.label, total: segment.rows.length, rows };
}

function icpCells(rows: Row[], icp: IcpView): KpiCell[] {
  const counts = countIcp(rows.map((row) => icp.classOf(row)), icp.config);
  if (!counts) return [];
  return [
    { key: "fit", label: "Mos", value: counts.fit, format: "count" },
    { key: "not_fit", label: "Mos emas", value: counts.notFit, format: "count" },
    { key: "unset", label: "Belgilanmagan", value: counts.unset, format: "count" },
    { key: "fit_rate", label: "Mos / Baholangan", value: counts.evaluated ? Math.round((counts.fit / counts.evaluated) * 100) : null, format: "percent" },
  ];
}

function dealRows(rows: Row[], metric: KpiMetric, icp: IcpView | null): KpiDealRow[] {
  const measure = MEASURES[metric];
  const names = new Map<string, string>();
  for (const [key, members] of groupRows(rows, (row) => funnelOwnerKey(row))) names.set(key, resolveManagerName(key, members, FUNNEL_OWNER_LABELS));
  return rows.map((row) => {
    const managerId = funnelOwnerKey(row);
    return {
      dealId: row.dealId, title: row.title, createdAt: row.createdAt,
      managerId, managerName: names.get(managerId) ?? managerId,
      // The Source filter's own key. Dashboard records do not carry the raw SOURCE_ID.
      sourceId: row.source ?? "", sourceName: row.source || "Aniqlanmagan",
      stageId: row.stageId, stageName: row.stage, pipeline: row.originPipeline,
      statusLabel: dealOutcomeLabel(row).label,
      opportunity: row.opportunity, currency: row.currencyId, wonAt: row.wonAt,
      ...(metric === "not_relevant" || metric === "lost" ? { lossReason: reasonKey(row) } : {}),
      ...(metric === "sla_response" ? { slaStatus: row.slaStatus } : {}),
      ...(metric === "icp_fit" && icp ? { icpClass: icp.classOf(row) } : {}),
      ...(measure ? { metricValue: finite(measure.read(row)) ? (measure.read(row) as number) : null, metricFormat: measure.format } : {}),
      bitrixUrl: row.bitrixUrl,
    };
  });
}

const SALE_DATE_METRICS = new Set<KpiMetric>(["period_sales", "average_check", "sales_cycle"]);

function sortDeals(rows: Row[], metric: KpiMetric) {
  const at = (row: Row) => (SALE_DATE_METRICS.has(metric) ? row.wonAt ?? "" : row.createdAt ?? "");
  return [...rows].sort((a, b) => at(b).localeCompare(at(a)) || b.dealId.localeCompare(a.dealId, undefined, { numeric: true }));
}

/** The Lead population ICP is read over — the Deal IDs whose stored class the route must look up. */
export function kpiIcpDealIds(records: DashboardRecord[], query: SalesQuery) {
  return buildDashboardMetrics(salesPopulations(records, query).cohort, []).eligible.map((row) => row.dealId);
}

export function kpiIcpConfig(project: ProjectKey) {
  return workspaceIcp(workspaceForProject(project));
}

export function buildKpiDetail(records: DashboardRecord[], query: KpiDetailQuery, context: KpiContext): KpiDetail {
  const metric = query.metric;
  const workspace = workspaceForProject(context.project);
  const card = KPI_CARD[metric];
  const base: Base = {
    metric, template: TEMPLATES[metric],
    title: card ? headlineCardLabel(card) : "ICP mosligi",
    subtitle: SUBTITLES[metric], definition: DEFINITIONS[metric],
    project: context.project, workspace,
    period: { from: query.from, to: query.to, preset: query.preset },
    appliedFilters: {
      managers: [...query.managers], sources: [...query.sources], pipeline: query.pipeline ?? "", stage: query.stage ?? "",
      period: query.period ?? "", sla: query.sla ?? "", processing: query.processing ?? "", search: query.search ?? "",
    },
  };

  let icp: IcpView | null = null;
  if (metric === "icp_fit") {
    const config = kpiIcpConfig(context.project);
    if (!config.enabled) {
      return { ...base, status: "NOT_APPLICABLE", reason: `ICP ${workspace} uchun aniqlanmagan`, hero: null, summary: [], breakdowns: [], deals: null };
    }
    const classes = context.icpClasses ?? new Map<string, string>();
    icp = { config, classOf: (row) => classes.get(row.dealId) || ICP_UNSET, attributed: (row) => classes.has(row.dealId) };
  }

  // The Dashboard's own split and the Dashboard's own metrics object.
  const pop = salesPopulations(records, query);
  const m = buildDashboardMetrics(pop.cohort, pop.won);
  const previous = buildDashboardMetrics(pop.previousCohort, pop.previousWon);

  const segments = segmentsFor(metric, m, icp);
  const segmentKey = query.segment || segments[0].key;
  const segmentOf = (key: string): Segment | undefined => segments.find((entry) => entry.key === key);
  const listed = segmentOf(segmentKey);
  if (!listed) throw new KpiDetailError("Segment noma’lum");

  const canManagers = context.can("managers");
  const restricted: string[] = [];
  const plan = breakdownPlan(metric);
  const breakdowns = plan.flatMap(({ segment, dimension, title }) => {
    if (dimension === "owner" && !canManagers) { if (!restricted.includes("owner")) restricted.push("owner"); return []; }
    const from = segmentOf(segment);
    return from ? [buildBreakdown(from, dimension, metric, icp, title)] : [];
  });
  if (metric === "funnel_conversion") {
    const comparison = kpiOwnerFunnelBreakdown(pop.cohort, pop.won, context);
    if (comparison) breakdowns.push(comparison); else restricted.push("owner");
  }
  const measure = MEASURES[metric];
  const distribution = measure ? buildBreakdown(segments[0], "bucket", metric, icp, "Taqsimot") : undefined;

  // Drilldown: one row of one breakdown, by the same key function.
  let drilldown: KpiDrilldown | null = null;
  let population = listed.rows;
  if (query.dimension) {
    if (query.dimension === "owner" && !canManagers) throw new KpiDetailError("Menejer bo‘yicha drilldown uchun Menejerlar ruxsati kerak");
    const offered = plan.some((entry) => entry.dimension === query.dimension)
      || (query.dimension === "bucket" && Boolean(measure))
      // Every funnel step drills down by the comparison table's owner.
      || (metric === "funnel_conversion" && query.dimension === "owner");
    if (!offered) throw new KpiDetailError("Bu KPI uchun bunday drilldown yo‘q");
    const spec = dimensionSpec(query.dimension, metric, icp);
    population = listed.rows.filter((row) => spec.keyOf(row) === query.value);
    drilldown = { segment: listed.key, dimension: query.dimension, value: query.value };
  }

  const total = population.length;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const canDeals = context.can("deals");
  const pageRows = canDeals ? sortDeals(population, metric).slice((page - 1) * query.pageSize, page * query.pageSize) : [];
  const deals: KpiDeals = {
    title: drilldown ? `${listed.label} — ${dimensionSpec(drilldown.dimension, metric, icp).labelOf(drilldown.value, population)}` : listed.label,
    populationLabel: listed.label, segment: listed.key, drilldown,
    total, page, pageSize: query.pageSize, totalPages, restricted: !canDeals,
    rows: dealRows(pageRows, metric, icp),
  };

  const heroAndSummary = HEROES[metric](m, previous, icp);
  return {
    ...base, status: "OK",
    ...heroAndSummary,
    segments: segments.map((entry) => ({ key: entry.key, label: entry.label, count: entry.rows.length })),
    breakdowns, ...(distribution ? { distribution } : {}), deals, restricted,
  };
}

/* ------------------------------------------------- hero, summary, funnel */

type HeroBlock = { hero: KpiHero; summary: KpiSummaryItem[]; funnel?: KpiFunnelStep[] };
type HeroBuilder = (m: DashboardMetrics, previous: DashboardMetrics, icp: IcpView | null) => HeroBlock;

const count = (key: string, label: string, value: number, helpText?: string): KpiSummaryItem => ({ key, label, value, format: "count", ...(helpText ? { helpText } : {}) });
const label = (metric: KpiMetric) => (KPI_CARD[metric] ? headlineCardLabel(KPI_CARD[metric]!) : "ICP mos");
const previousLabel = "Oldingi davr (shu uzunlikdagi)";

function populationHero(metric: KpiMetric, value: number, previous: number, extra: Partial<KpiHero> = {}): KpiHero {
  return { value, format: "count", label: label(metric), comparisonValue: previous, comparisonLabel: previousLabel, ...extra };
}

function timeBlock(metric: KpiMetric, rows: Row[], read: Measure["read"], canonical: number | null, format: KpiFormat, extra: KpiSummaryItem[]): HeroBlock {
  const values = rows.map((row) => read(row) ?? null);
  return {
    hero: { value: canonical, format, label: label(metric), denominatorValue: rows.length, denominatorLabel: "Hisobga kirgan Deal’lar" },
    summary: [
      { key: "average", label: "O‘rtacha", value: canonical, format },
      { key: "median", label: "Median", value: median(values), format },
      count("included", "Hisobga kirgan Deal’lar", rows.length),
      ...extra,
    ],
  };
}

function funnelSteps(m: DashboardMetrics): KpiFunnelStep[] {
  return [
    { key: "lead", label: "Leadlar", count: m.counts.leads, drilldown: { segment: "lead" } },
    { key: "sorted", label: "Saralangan", count: m.counts.classified_leads, rateFromPrevious: m.rates.classification_coverage, rateLabel: "Saralangan / Lead", drilldown: { segment: "sorted" } },
    { key: "sql", label: "SQL", count: m.counts.sql, rateFromPrevious: m.rates.quality_accepted_rate, rateLabel: "SQL / Saralangan", drilldown: { segment: "sql" } },
    { key: "sale", label: "Sotuv", count: m.counts.cohort_sales, rateFromPrevious: m.rates.sql_to_sale, rateLabel: "Sotuv / SQL", drilldown: { segment: "sale" } },
  ];
}

const money = (key: string, labelText: string, value: number | null, currency: string): KpiSummaryItem => ({ key, label: labelText, value, format: "money", currency: currency || "UZS" });

const HEROES: Record<KpiMetric, HeroBuilder> = {
  leads: (m, p) => ({ hero: populationHero("leads", m.counts.leads, p.counts.leads), summary: [count("leads", "Leadlar", m.counts.leads), count("sorted", "Saralangan", m.counts.classified_leads), count("unsorted", "Saralanmagan", m.counts.unclassified_leads)] }),
  sorted: (m, p) => ({
    hero: populationHero("sorted", m.counts.classified_leads, p.counts.classified_leads, { denominatorValue: m.counts.leads, denominatorLabel: "Leadlar", rate: m.rates.classification_coverage, rateLabel: "Saralangan / Lead" }),
    summary: [
      count("leads", "Leadlar", m.counts.leads), count("sorted", "Saralangan", m.counts.classified_leads, "SQL + Not Relevant"),
      count("unsorted", "Saralanmagan", m.counts.unclassified_leads, "Sifat bo‘yicha qaror hali yo‘q"),
      count("sql", "SQL", m.counts.sql), count("not_relevant", "Not Relevant", m.counts.not_relevant),
      count("pre_sql_closed", "SQLgacha yopilgan", m.counts.pre_sql_closed, "Saralanmagan ichida"),
      count("product_fit", "Programma mos emas", m.counts.product_fit, "Saralanmagan ichida"),
    ],
  }),
  sql: (m, p) => ({
    hero: populationHero("sql", m.counts.sql, p.counts.sql, { denominatorValue: m.counts.classified_leads, denominatorLabel: "Saralangan", rate: m.rates.quality_accepted_rate, rateLabel: "Saralangan → SQL" }),
    summary: [count("sorted", "Saralangan", m.counts.classified_leads), count("sql", "SQL", m.counts.sql), { key: "lead_to_sql", label: "Lead → SQL", value: m.rates.lead_to_sql, format: "percent" }],
  }),
  not_relevant: (m, p) => ({
    hero: populationHero("not_relevant", m.counts.not_relevant, p.counts.not_relevant, { denominatorValue: m.counts.classified_leads, denominatorLabel: "Saralangan", rate: m.rates.low_quality_rate, rateLabel: "Saralangan → Not Relevant" }),
    summary: [
      count("sorted", "Saralangan", m.counts.classified_leads), count("not_relevant", "Not Relevant", m.counts.not_relevant),
      { key: "not_relevant_of_leads", label: "Umumiy leadlardan Not Relevant %", value: m.rates.not_relevant_of_leads, format: "percent" },
      count("missing_reason", "Sabab ko‘rsatilmagan", m.notRelevant.filter(missingReason).length, "Diagnostika; a’zolikka ta’sir qilmaydi"),
    ],
  }),
  lost: (m, p) => ({
    hero: populationHero("lost", m.counts.sales_lost, p.counts.sales_lost, { denominatorValue: m.counts.sql, denominatorLabel: "SQL", rate: m.rates.sales_lost, rateLabel: "SQL → Sotilmadi" }),
    summary: [count("sql", "SQL", m.counts.sql), count("lost", "Sotilmadi", m.counts.sales_lost),
      count("missing_reason", "Sabab ko‘rsatilmagan", m.salesLost.filter(missingReason).length, "Diagnostika; a’zolikka ta’sir qilmaydi")],
  }),
  cohort_sales: (m, p) => ({
    hero: populationHero("cohort_sales", m.counts.cohort_sales, p.counts.cohort_sales, { denominatorValue: m.counts.sql, denominatorLabel: "SQL", rate: m.rates.sql_to_sale, rateLabel: "SQL → Sotuv" }),
    summary: [
      count("leads", "Leadlar", m.counts.leads), count("sorted", "Saralangan", m.counts.classified_leads), count("sql", "SQL", m.counts.sql),
      count("cohort_sales", "Kelgan leadlardan sotuv", m.counts.cohort_sales, "Sotuv sanasi tanlangan davrdan tashqarida bo‘lishi mumkin"),
      money("cohort_revenue", "Sotuv summasi (cohort)", m.money.cohort_revenue, m.cohortSales[0]?.currencyId ?? m.money.currency),
    ],
    funnel: funnelSteps(m),
  }),
  period_sales: (m, p) => ({
    hero: populationHero("period_sales", m.counts.period_sales, p.counts.period_sales),
    summary: [count("period_sales", "Sotuvlar soni", m.counts.period_sales), money("revenue", "Sotuv summasi", m.money.revenue, m.money.currency),
      money("avg_check", "O‘rtacha chek", m.money.avg_check, m.money.currency), money("median_check", "Median chek", m.money.median_check, m.money.currency)],
  }),
  average_check: (m) => ({
    hero: { value: m.money.avg_check, format: "money", currency: m.money.currency || "UZS", label: label("average_check"), denominatorValue: m.counts.period_sales, denominatorLabel: "Shu davrdagi sotuvlar" },
    summary: [money("avg_check", "O‘rtacha", m.money.avg_check, m.money.currency), money("median_check", "Median", m.money.median_check, m.money.currency),
      count("period_sales", "Sotuvlar soni", m.counts.period_sales), money("revenue", "Sotuv summasi", m.money.revenue, m.money.currency)],
  }),
  sales_cycle: (m) => {
    const rows = m.periodSales.filter((row) => finite(row.salesCycleHours));
    return timeBlock("sales_cycle", rows, (row) => row.salesCycleHours, m.timing.sales_cycle, "duration_hours", [
      count("period_sales", "Shu davrdagi sotuvlar", m.counts.period_sales), count("not_measured", "Sikli hisoblanmagan", m.counts.period_sales - rows.length)]);
  },
  active_leads: (m, p) => ({ hero: populationHero("active_leads", m.counts.active_cohort, p.counts.active_cohort), summary: [count("leads", "Leadlar", m.counts.leads), count("active", "Aktiv leadlar", m.counts.active_cohort, "Tanlangan davrda kelib, hali yopilmagan")] }),
  sla_response: (m) => {
    const block = timeBlock("sla_response", m.slaCompleted, (row) => row.slaBusinessMinutes, m.timing.sla_avg, "duration_minutes", [
      count("on_time", SLA_LABELS.ON_TIME, m.sla.onTime), count("late", SLA_LABELS.LATE, m.sla.late), count("overdue", SLA_LABELS.OVERDUE_UNPROCESSED, m.sla.overdue),
      count("sla_denominator", "SLA bahosi maxraji", m.sla.denominator, "SLA ichida + kech + muddati o‘tgan"),
      { key: "sla_rate", label: "SLA ichida %", value: m.rates.sla, format: "percent" },
      count("pending", SLA_LABELS.PENDING, m.sla.pending, "Bahoga kirmaydi"), count("unknown", SLA_LABELS.UNKNOWN_EVIDENCE, m.sla.unknown, "Bahoga kirmaydi"),
    ]);
    return { ...block, hero: { ...block.hero, rate: m.rates.sla, rateLabel: `SLA ichida (${m.sla.onTime}/${m.sla.denominator})` } };
  },
  calendar_response: (m) => {
    const rows = m.slaCompleted.filter((row) => finite(row.slaElapsedMinutes));
    return timeBlock("calendar_response", rows, (row) => row.slaElapsedMinutes, m.timing.sla_elapsed_avg, "duration_minutes", [
      { key: "sla_avg", label: "SLA (ish vaqti) o‘rtacha", value: m.timing.sla_avg, format: "duration_minutes", helpText: "Taqqoslash uchun; bu kalendar vaqti emas" }]);
  },
  sorting_time: (m) => {
    const rows = m.eligible.filter((row) => finite(row.processingBusinessMinutes));
    return timeBlock("sorting_time", rows, (row) => row.processingBusinessMinutes, m.timing.avg_processing, "duration_minutes", [
      count("leads", "Leadlar", m.counts.leads), count("not_measured", "Vaqti noma’lum", m.counts.leads - rows.length)]);
  },
  funnel_conversion: (m) => ({
    hero: { value: m.rates.lead_to_sql, format: "percent", label: label("funnel_conversion"), denominatorValue: m.counts.leads, denominatorLabel: "Leadlar", rate: m.rates.lead_to_sql, rateLabel: "Lead → SQL" },
    summary: [
      { key: "lead_to_sql", label: "Lead → SQL", value: m.rates.lead_to_sql, format: "percent" },
      { key: "lead_to_sale", label: "Lead → Sotuv", value: m.rates.lead_to_sale, format: "percent" },
      { key: "sql_to_sale", label: "SQL → Sotuv", value: m.rates.sql_to_sale, format: "percent" },
    ],
    funnel: funnelSteps(m),
  }),
  icp_fit: (m, _p, icp) => {
    const counts = countIcp(m.eligible.map((row) => icp!.classOf(row)), icp!.config)!;
    const fitRate = counts.evaluated ? Math.round((counts.fit / counts.evaluated) * 100) : null;
    return {
      hero: { value: counts.fit, format: "count", label: "ICP mos", denominatorValue: counts.evaluated, denominatorLabel: "Baholangan (mos + mos emas)", rate: fitRate, rateLabel: "Mos / Baholangan · belgilanmaganlar maxrajga kirmaydi" },
      summary: [
        count("fit", "Mos", counts.fit), count("not_fit", "Mos emas", counts.notFit), count("evaluated", "Baholangan", counts.evaluated),
        count("unset", "Belgilanmagan", counts.unset, "Maxrajga kirmaydi"),
        { key: "fit_rate", label: "Mos %", value: fitRate, format: "percent" },
        count("not_attributed", "Attributsiya hali o‘qilmagan", m.eligible.filter((row) => !icp!.attributed(row)).length, "Belgilanmagan ichida"),
        count("leads", "Leadlar", m.counts.leads),
      ],
      funnel: [
        { key: "lead", label: "Leadlar", count: m.counts.leads, drilldown: { segment: "lead" } },
        { key: "evaluated", label: "Baholangan", count: counts.evaluated, rateFromPrevious: percent(counts.evaluated, m.counts.leads), rateLabel: "Baholangan / Lead", drilldown: { segment: "evaluated" } },
        { key: "fit", label: "Mos", count: counts.fit, rateFromPrevious: fitRate ?? undefined, rateLabel: "Mos / Baholangan", drilldown: { segment: "fit" } },
      ],
    };
  },
};

/**
 * Funnel comparison per manager — the Managers table's own rows
 * (`buildManagers`, same partition and same rates), so a manager's funnel here
 * is the one shown there. Each row drills down to that owner's Leads.
 */
function kpiOwnerFunnelBreakdown(cohort: DashboardRecord[], won: DashboardRecord[], context: KpiContext): KpiBreakdown | null {
  if (!context.can("managers")) return null;
  const managers = buildManagers(cohort, won, activeRoster(context.settings));
  return {
    key: "lead:owner", title: "Menejerlar taqqoslash", dimension: "owner", segment: "lead", populationLabel: "Leadlar",
    total: managers.reduce((sum, row) => sum + row.leads, 0),
    rows: managers.filter((row) => row.leads > 0).sort((a, b) => b.leads - a.leads).map((row) => ({
      key: row.id, label: row.name, count: row.leads,
      cells: [
        { key: "sorted", label: "Saralangan", value: row.classified, format: "count" },
        { key: "sorted_rate", label: "Saralangan / Lead", value: row.classificationCoverage, format: "percent" },
        { key: "sql", label: "SQL", value: row.sql, format: "count" },
        { key: "sql_rate", label: "SQL / Saralangan", value: row.qualityAcceptedRate, format: "percent" },
        { key: "sale", label: "Sotuv", value: row.cohortSales, format: "count" },
        { key: "sale_rate", label: "Sotuv / SQL", value: row.sqlToSale, format: "percent" },
      ],
      drilldown: { segment: "lead", dimension: "owner", value: row.id },
    })),
  };
}

/* ----------------------------------------------------------------- copy */

const TEMPLATES: Record<KpiMetric, KpiTemplate> = {
  leads: "population", sorted: "population", sql: "population", not_relevant: "population", lost: "population", active_leads: "population",
  cohort_sales: "sales", period_sales: "sales", average_check: "sales",
  sales_cycle: "time", sla_response: "time", calendar_response: "time", sorting_time: "time",
  funnel_conversion: "funnel", icp_fit: "funnel",
};

const SUBTITLES: Record<KpiMetric, string> = {
  leads: "Tanlangan davrda kelgan canonical Leadlar",
  sorted: "Sifat bo‘yicha qaror chiqarilgan Leadlar",
  sql: "Sifatli deb qabul qilingan Leadlar",
  not_relevant: "Sifatsiz deb topilgan Leadlar",
  lost: "SQL bo‘lib, sotilmagan Leadlar",
  cohort_sales: "Tanlangan davrda kelgan leadlardan sotilganlari",
  period_sales: "Sotuv sanasi tanlangan davrda",
  average_check: "Shu davrdagi sotuvlar bo‘yicha",
  sales_cycle: "Lead kelganidan sotuvgacha",
  active_leads: "Tanlangan davrda kelib, hali yopilmagan",
  sla_response: "Ish vaqti bo‘yicha birinchi javob",
  calendar_response: "Real o‘tgan vaqt · tun va dam olish kunlari ham kiradi",
  funnel_conversion: "Lead → Saralangan → SQL → Sotuv",
  sorting_time: "Leaddan sifat bo‘yicha qarorgacha",
  icp_fit: "IBOX ICP (P1/P2/P3 mos, Other mos emas)",
};

const DEFINITIONS: Record<KpiMetric, string> = {
  leads: "Yaratilgan sanasi tanlangan davrda bo‘lgan, joriy loyiha a’zoligi tasdiqlangan Deal’lar (routing chiqarilgan).",
  sorted: "Leadlar ichida SQL yoki Not Relevant qarori chiqqanlar. Saralanmagan — qaror hali yo‘q.",
  sql: "Leadlar ichida SQL dalili bor Deal’lar. Ulush maxraji — Saralangan.",
  not_relevant: "Leadlar ichida Not Relevant (Marketing) deb yopilganlar. Sabab — faqat diagnostika.",
  lost: "Leadlar ichida Sales tomonidan yo‘qotilganlar. Ulush maxraji — SQL. Sabab — faqat diagnostika.",
  cohort_sales: "Tanlangan davrda kelgan Leadlar ichidan sotilganlari; sotuv sanasi davrdan tashqarida bo‘lishi mumkin.",
  period_sales: "Sotuv sanasi tanlangan davrga tushgan, hozir ham amal qiluvchi sotuvlar; Lead qachon kelganidan qat’i nazar.",
  average_check: "Shu davrdagi sotuvlar summasining o‘rtachasi va medianasi (Deal valyutasida, Dashboard bilan bir xil).",
  sales_cycle: "Shu davrdagi sotuvlarda Lead yaratilganidan sotuvgacha o‘tgan soatlar o‘rtachasi.",
  active_leads: "Leadlar ichida hali ochiq (ACTIVE) va sync qamrovida bo‘lganlar. Stage Control live ro‘yxati emas.",
  sla_response: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ ga kirishdan keyingi birinchi o‘tishgacha, Du–Ju 10:00–18:00 (Asia/Tashkent) ish daqiqalari.",
  calendar_response: "SLA bilan bir xil hodisa, lekin real kalendar vaqti. SLA bahosiga ta’sir qilmaydi.",
  funnel_conversion: "Saralangan % = Saralangan / Lead · SQL % = SQL / Saralangan · Sotuv % = Sotuv / SQL. Karta qiymati — Lead → SQL.",
  sorting_time: "Lead kelganidan SQL yoki Not Relevant qaroriga qadar ketgan ish vaqti. SLA emas.",
  icp_fit: "Mos % = Mos / (Mos + Mos emas). Belgilanmaganlar maxrajga kirmaydi. ICP faqat IBOX_UZ uchun.",
};

/** Validates a segment name early so the route can answer 400 instead of 500. */
export function kpiSegmentKeys(metric: KpiMetric): string[] {
  const empty = buildDashboardMetrics([], []);
  const icp: IcpView = { config: { enabled: true, fieldId: "", fitValues: [], notFitValues: [] }, classOf: () => ICP_UNSET, attributed: () => false };
  return segmentsFor(metric, empty, icp).map((segment) => segment.key);
}


/**
 * Marketing's stored ICP class for the given Deals — read-only, one bound JSON
 * array. A Deal with no attribution row yet is absent and counts as UNSET.
 */
export const KPI_ICP_CLASSES_SQL = "SELECT deal_id, icp_class FROM marketing_deal_attribution WHERE deal_id IN (SELECT value FROM json_each(?))";
