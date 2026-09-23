import type { DashboardRecord } from "./dashboard-record";
import { buildDashboardMetrics, selectPeriodPopulations, resolveDashboardMetric, type DashboardMetricId, type DashboardMetrics } from "./dashboard-metrics";
import { countDuplicates, markDuplicates } from "./duplicates";
import { stageConfigReadiness, summarizeDataQuality } from "./diagnostics";
import { stageConfigConflicts } from "./stage-config";
import { buildLeadFlow, type LeadFlow } from "./lead-flow-analytics";
import { buildManagerProfile, notRelevantRecords, reasonBreakdown, salesLostRecords, sourceFunnelRows, teamMedian, type ReasonRow, type SourceFunnelRow } from "./manager-profile";
import { boundsFromKeys, dateKey } from "./period";
import { buildQualityAnalytics, type QualityAnalytics } from "./quality-analytics";
import { dedupeByDealId, filterHistoricalRecords, historicalManagerOptions, type SalesFilterSelection } from "./record-filters";
import { countClassificationConflicts, isClassifiedLead, isEligibleCohortDeal, isPreSqlClosed, isUnclassifiedLead, resolveProjectMembership, salesManagerKey } from "./sales-logic";
import { SLA_LABELS, resolveSlaState } from "./sla";
import { TREND_METRICS, buildTrendSeriesSet, type TrendMetricId, type TrendPoint } from "./trend-series";
import type { DashboardSettings, SyncProgressState } from "./types";
import type { PermissionKey } from "./auth/permissions";
import { ANALYTICS_VERSION } from "./analytics";

/**
 * Server-side Sales sections.
 *
 * Each Sales permission is its own section, answered by its own endpoint, and
 * each endpoint returns the finished view model for that section and nothing
 * else. The browser never receives the analytics record population: a member
 * with only `dashboard` gets KPI numbers and a trend, not rows from which the
 * manager table, the lead-flow heatmap, the quality breakdown or the Deal list
 * could be rebuilt.
 *
 * No formula lives here. Every figure comes from the same functions the
 * dashboard used when it computed in the browser — `buildDashboardMetrics`,
 * `buildTrendSeries`, `buildLeadFlow`, `buildQualityAnalytics`,
 * `buildManagerProfile` — called with the same populations, built by the same
 * filter predicate. What moved is where they run, not what they compute.
 *
 * This module is pure: the D1 reads live in `lib/sales-http.ts`, so every
 * section can be tested without a Worker.
 */

export const SALES_SECTIONS = ["dashboard", "managers", "manager", "leadFlow", "quality", "deals"] as const;
export type SalesSection = (typeof SALES_SECTIONS)[number];

/** Exactly one permission per section. The manager profile belongs to `managers`. */
export const SALES_SECTION_PERMISSION: Record<SalesSection, PermissionKey> = {
  dashboard: "dashboard",
  managers: "managers",
  manager: "managers",
  leadFlow: "leadFlow",
  quality: "quality",
  deals: "deals",
};

export const SALES_PERMISSIONS: PermissionKey[] = ["dashboard", "managers", "leadFlow", "quality", "stages", "deals"];

/* ------------------------------------------------------------------ query */

export type SalesQuery = SalesFilterSelection & {
  /** Tashkent calendar dates, resolved by the browser from its range picker. */
  from: string;
  to: string;
  managers: string[];
  sources: string[];
  managerId?: string;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;
const PERIODS = new Set(["", "WORK_HOURS", "AFTER_HOURS"]);
/** The SLA filter offers exactly the labelled states, so it accepts exactly those. */
const SLA_STATES = new Set(["", ...Object.keys(SLA_LABELS)]);
const PROCESSING = new Set(["", "QUALIFICATION_STAGE", "NO_PROCESSING", "NO_PROCESSING_EVIDENCE"]);
const MAX_VALUES = 200;
const MAX_TEXT = 200;

export type ParsedSalesQuery = { ok: true; query: SalesQuery } | { ok: false; error: string };

/** Validates the query string; anything outside the known shapes is refused. */
export function parseSalesQuery(params: URLSearchParams): ParsedSalesQuery {
  const text = (key: string) => (params.get(key) ?? "").trim();
  const list = (key: string) => params.getAll(key).map((value) => value.trim()).filter(Boolean);
  const from = text("from");
  const to = text("to");
  if ((from && !DATE_KEY.test(from)) || (to && !DATE_KEY.test(to))) return { ok: false, error: "Sana formati noto‘g‘ri" };
  const managers = list("manager");
  const sources = list("source");
  if (managers.length > MAX_VALUES || sources.length > MAX_VALUES) return { ok: false, error: "Filtr qiymatlari juda ko‘p" };
  const fields = { pipeline: text("pipeline"), stage: text("stage"), period: text("period"), sla: text("sla"), processing: text("processing"), search: text("search"), managerId: text("managerId") };
  if ([...managers, ...sources, ...Object.values(fields)].some((value) => value.length > MAX_TEXT)) return { ok: false, error: "Filtr qiymati juda uzun" };
  if (!PERIODS.has(fields.period) || !SLA_STATES.has(fields.sla) || !PROCESSING.has(fields.processing)) return { ok: false, error: "Filtr qiymati noto‘g‘ri" };
  return { ok: true, query: { from, to, managers, sources, ...fields, managerId: fields.managerId || undefined } };
}

/**
 * Filters that would let one section answer another section's question.
 *
 * Filtering the Dashboard to one seller turns its KPI cards into that seller's
 * report, so the Manager filter needs `managers`. Searching by Deal ID or title
 * lets a caller probe single Deals through the totals, so search needs `deals`.
 */
export function filterPermissionError(query: SalesQuery, can: (permission: PermissionKey) => boolean): string | null {
  if (query.managers.length && !can("managers")) return "Menejer filtri uchun Menejerlar ruxsati kerak";
  if (query.search && !can("deals")) return "Deal qidiruvi uchun Deal’lar ruxsati kerak";
  return null;
}

/* ---------------------------------------------------------------- records */

/** Fills fields older records may lack. Moved verbatim from the dashboard client. */
export function hydrateRecord(row: DashboardRecord): DashboardRecord {
  return {
    ...row,
    analyticsVersion: Number(row.analyticsVersion ?? 1),
    originCategoryId: row.originCategoryId ?? row.categoryId,
    originPipeline: row.originPipeline ?? row.pipeline,
    operationalPipeline: row.operationalPipeline ?? true,
    stageEnteredAt: row.stageEnteredAt ?? row.createdAt,
    stageAgeHours: Number(row.stageAgeHours ?? 0),
    stageLimitHours: Number(row.stageLimitHours ?? 24),
    stageOverdue: row.stageOverdue ?? false,
    salesStatus: row.salesStatus ?? "ACTIVE",
    qualified: row.qualified ?? true,
    qualifiedAt: row.qualifiedAt ?? (row.qualified ? row.createdAt : null),
    qualifiedStageId: row.qualifiedStageId ?? null,
    qualifiedStage: row.qualifiedStage ?? null,
    wonAt: row.wonAt ?? null,
    salesCycleHours: row.salesCycleHours ?? (row.wonAt ? Math.max(0, (new Date(row.wonAt).getTime() - new Date(row.createdAt).getTime()) / 3_600_000) : null),
    opportunity: Number(row.opportunity ?? 0),
    currencyId: row.currencyId ?? "",
    lossReason: row.lossReason ?? "",
    lossReasonGroup: row.lossReasonGroup ?? (row.salesStatus === "LOW_QUALITY" ? "MARKETING" : row.salesStatus === "LOST" ? "SALES" : "NONE"),
    contactId: row.contactId ?? null,
    companyId: row.companyId ?? null,
    customerKey: row.customerKey ?? null,
    duplicateOfDealId: row.duplicateOfDealId ?? null,
    stageHistoryCount: Number(row.stageHistoryCount ?? 0),
    salesManagerId: row.salesManagerId ?? null,
    salesManager: row.salesManager ?? null,
    salesManagerAttribution: row.salesManagerAttribution ?? "UNKNOWN",
  };
}

/**
 * The dataset every Sales section starts from — the same steps, in the same
 * order, as the dashboard's load: hydrate, keep the selected project's
 * pipelines, re-resolve SLA against the clock, mark duplicates.
 */
export function prepareSalesRecords(rows: DashboardRecord[], settings: DashboardSettings, now: Date = new Date()): DashboardRecord[] {
  return resolveSalesSla(prepareSalesBase(rows, settings), settings, now);
}

/**
 * The clock-independent part of `prepareSalesRecords`: hydrate, keep the
 * selected project's pipelines, mark duplicates. It depends only on the stored
 * rows and the pipeline selection, which is what makes it cacheable between
 * requests (see `lib/sales-cache.ts`).
 *
 * Duplicate marking reads only `createdAt`, `dealId` and `customerKey`, and
 * sorts stably, so marking before or after the SLA pass yields the same rows
 * in the same order.
 */
export function prepareSalesBase(rows: DashboardRecord[], settings: Pick<DashboardSettings, "selectedPipelineIds" | "postSalePipelineIds">): DashboardRecord[] {
  return markDuplicates(projectScopedRecords(rows.map(hydrateRecord), settings));
}

/**
 * The selected project's records, each carrying a decided membership. Every
 * reader of stored records — the Sales sections, a public share, the Stage
 * funnel — goes through here, so no path can count a record the others would
 * not.
 *
 * Kept: a record that started in a selected Sales funnel or sits in a project
 * funnel now. Membership: the builder's decision, or for an older record that
 * has none, `resolveProjectMembership` — never the bare legacy fallback.
 */
export function projectScopedRecords<T extends Pick<DashboardRecord, "originCategoryId" | "categoryId" | "projectLeadMembership" | "lossReasonGroup" | "membershipBasis">>(
  rows: T[], settings: Pick<DashboardSettings, "selectedPipelineIds" | "postSalePipelineIds">,
): T[] {
  const selectedOrigins = new Set(settings.selectedPipelineIds.map(String));
  const projectCategories = new Set([...settings.selectedPipelineIds, ...settings.postSalePipelineIds].map(String));
  return rows
    .filter((row) => !selectedOrigins.size || selectedOrigins.has(String(row.originCategoryId ?? row.categoryId)) || projectCategories.has(String(row.categoryId)))
    .map((row) => {
      const { membership, basis } = resolveProjectMembership(row, projectCategories);
      return { ...row, projectLeadMembership: membership, membershipBasis: basis };
    });
}

/** The per-request part: SLA re-resolved against the clock, on fresh row objects. */
export function resolveSalesSla(base: readonly DashboardRecord[], settings: DashboardSettings, now: Date = new Date()): DashboardRecord[] {
  return base.map((row) => ({ ...row, slaStatus: resolveSlaState(row, settings, now) }));
}

/** Tashkent calendar date, as the dashboard has always keyed its days. */
export const localDateKey = (date: Date) => dateKey(date);

export type SalesPopulations = {
  cohort: DashboardRecord[];
  won: DashboardRecord[];
  previousCohort: DashboardRecord[];
  previousWon: DashboardRecord[];
  trendBounds: { from: string; to: string } | null;
  previousTrendBounds: { from: string; to: string } | null;
  detail: DashboardRecord[];
};

/** The dashboard's population split, moved verbatim from its `useMemo`. */
export function salesPopulations(records: DashboardRecord[], query: SalesQuery): SalesPopulations {
  const from = query.from ? boundsFromKeys({ from: query.from, to: query.from }).from : -Infinity;
  const to = query.to ? boundsFromKeys({ from: query.to, to: query.to }).to : Infinity;
  const base = filterHistoricalRecords(records, query);
  const cohort = base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= from && created <= to; });
  const won = base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= from && new Date(row.wonAt).getTime() <= to);
  const span = Number.isFinite(from) && Number.isFinite(to) ? Math.max(86_400_000, to - from + 1) : 0;
  const previousTo = from - 1; const previousFrom = previousTo - span + 1;
  const previousCohort = span ? base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= previousFrom && created <= previousTo; }) : [];
  const previousWon = span ? base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= previousFrom && new Date(row.wonAt).getTime() <= previousTo) : [];
  const trendBounds = query.from && query.to ? { from: query.from, to: query.to } : null;
  const previousTrendBounds = span && trendBounds
    ? { from: localDateKey(new Date(previousFrom)), to: localDateKey(new Date(previousTo)) }
    : null;
  return { cohort, won, previousCohort, previousWon, trendBounds, previousTrendBounds, detail: dedupeByDealId(cohort, won) };
}

/* ---------------------------------------------------------------- metrics */

/**
 * The numbers from `buildDashboardMetrics`, without the record arrays it also
 * returns (`eligible`, `sql`, `periodSales`, …). Those arrays are what would
 * turn a KPI payload back into a record dump.
 */
export type PublicMetrics = Pick<DashboardMetrics, "counts" | "rates" | "money" | "timing"> & {
  sla: Pick<DashboardMetrics["sla"], "onTime" | "late" | "overdue" | "pending" | "unknown" | "denominator" | "rate">;
};

export function publicMetrics(metrics: DashboardMetrics): PublicMetrics {
  const { onTime, late, overdue, pending, unknown, denominator, rate } = metrics.sla;
  return {
    counts: { ...metrics.counts }, rates: { ...metrics.rates }, money: { ...metrics.money }, timing: { ...metrics.timing },
    sla: { onTime, late, overdue, pending, unknown, denominator, rate },
  };
}

function pct(value: number, total: number) { return total ? Math.round((value / total) * 100) : 0; }

export type ManagerRow = {
  id: string; name: string;
  leads: number; leadShare: number;
  classified: number; classificationCoverage: number;
  sql: number; qualityAcceptedRate: number;
  notRelevant: number; lowQualityRate: number;
  cohortSales: number; leadToSale: number; cohortRevenue: number;
  sqlToSale: number;
  salesLost: number; salesLostRate: number;
  periodSales: number; revenue: number;
  active: number;
  avgProcessing: number | null;
  overdueUnprocessed: number; overdueRate: number;
  // Carried for the profile's team benchmarks; the table does not show them.
  slaRate: number | null; slaDenominator: number; salesCycleHours: number | null;
  currency: string;
};

/**
 * Manager rows built from the canonical metric helper. Moved verbatim from the
 * dashboard client: partitioned by `salesManagerKey`, so every deal lands in
 * exactly one row and the rows sum back to the dashboard's own totals.
 */
export function buildManagers(records: DashboardRecord[], wonRecords: DashboardRecord[] = records.filter((row) => row.salesStatus === "WON")): ManagerRow[] {
  const cohortByManager = new Map<string, DashboardRecord[]>();
  const wonByManager = new Map<string, DashboardRecord[]>();
  const add = (map: Map<string, DashboardRecord[]>, record: DashboardRecord) => {
    const key = salesManagerKey(record);
    const rows = map.get(key);
    if (rows) rows.push(record); else map.set(key, [record]);
  };
  for (const record of records) add(cohortByManager, record);
  for (const record of wonRecords) add(wonByManager, record);
  const ids = new Set([...cohortByManager.keys(), ...wonByManager.keys()]);
  const built = [...ids].map((id) => {
    const cohort = cohortByManager.get(id) ?? [];
    const won = wonByManager.get(id) ?? [];
    const metrics = buildDashboardMetrics(cohort, won);
    return {
      id,
      name: cohort[0]?.salesManager ?? won[0]?.salesManager ?? "Aniqlanmagan",
      leads: metrics.counts.leads,
      leadShare: 0,
      classified: metrics.counts.classified_leads,
      classificationCoverage: metrics.rates.classification_coverage,
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
      periodSales: metrics.counts.period_sales,
      revenue: metrics.money.revenue,
      active: metrics.counts.active_cohort,
      avgProcessing: metrics.timing.avg_processing,
      overdueUnprocessed: metrics.sla.overdue,
      overdueRate: pct(metrics.sla.overdue, metrics.counts.leads),
      slaRate: metrics.sla.denominator ? metrics.rates.sla : null,
      slaDenominator: metrics.sla.denominator,
      salesCycleHours: metrics.timing.sales_cycle,
      currency: metrics.money.currency,
    } satisfies ManagerRow;
  });
  const totalLeads = built.reduce((sum, row) => sum + row.leads, 0);
  return built
    .map((row) => ({ ...row, leadShare: pct(row.leads, totalLeads) }))
    .sort((a, b) => b.periodSales - a.periodSales || b.cohortSales - a.cohortSales);
}

/* --------------------------------------------------------------- sections */

export type FilterOptions = {
  sources: { id: string; name: string }[];
  pipelines: string[];
  stages: string[];
  /** Empty unless the caller holds `managers`. */
  managers: { id: string; name: string }[];
};

/** Filter-bar options, built from the whole project dataset as before. */
export function filterOptions(records: DashboardRecord[], can: (permission: PermissionKey) => boolean): FilterOptions {
  return {
    sources: [...new Set(records.map((row) => row.source))].sort().map((value) => ({ id: value, name: value })),
    pipelines: [...new Set(records.map((row) => row.originPipeline))].sort(),
    stages: [...new Set(records.map((row) => row.stage))].sort(),
    managers: can("managers") ? historicalManagerOptions(records) : [],
  };
}

/** The earliest synced lead day, only when the chosen range starts before it. */
export function coverageStart(records: DashboardRecord[], from: string): string | null {
  if (!from || !records.length) return null;
  const earliest = records.reduce((min, row) => (row.createdAt && row.createdAt < min ? row.createdAt : min), records[0].createdAt);
  if (!earliest) return null;
  const earliestDay = earliest.slice(0, 10);
  return from >= earliestDay ? null : earliestDay;
}

export type SectionContext = {
  can: (permission: PermissionKey) => boolean;
  settings: DashboardSettings;
  dataAsOf: string | null;
};

type Common = { ready: true; dataAsOf: string | null; options: FilterOptions; coverageStart: string | null };

export type DashboardSection = Common & {
  leadCount: number;
  metrics: PublicMetrics;
  previousMetrics: PublicMetrics;
  metricIds: string[];
  trend: Record<TrendMetricId, { points: TrendPoint[]; hasPrevious: boolean }>;
  /** Present only for a caller who also holds `managers`. */
  managers: ManagerRow[] | null;
};
export type ManagersSection = Common & { managers: ManagerRow[] };
export type ManagerSection = Common & {
  manager: { id: string; name: string };
  metrics: PublicMetrics;
  teamLeads: number;
  medians: { sqlToSale: number | null; salesLostRate: number | null; processing: number | null; sla: number | null; cycle: number | null };
  sources: SourceFunnelRow[];
  notRelevant: { count: number; reasons: ReasonRow[] };
  salesLost: { count: number; reasons: ReasonRow[] };
};
export type LeadFlowSection = Common & { flow: LeadFlow };
export type QualitySection = Common & { analytics: QualityAnalytics };

/** What the Deal report renders and exports — nothing the table does not show. */
export const DEAL_ROW_FIELDS = [
  "dealId", "title", "createdAt", "assignedManager", "originPipeline", "pipeline", "stage",
  "stageAgeHours", "stageLimitHours", "stageOverdue", "salesStatus", "qualified", "qualifiedAt",
  "salesManager", "salesManagerAttribution", "wonAt", "salesCycleHours", "opportunity", "currencyId",
  "lossReasonGroup", "lossReason", "source", "duplicateOfDealId", "processingAt", "processingSource",
  "processingBusinessMinutes", "slaStatus", "bitrixUrl",
] as const;
export type DealRow = Pick<DashboardRecord, (typeof DEAL_ROW_FIELDS)[number]>;
export type DealsSection = Common & { deals: DealRow[] };

export type NotReady = { ready: false };

function common(records: DashboardRecord[], query: SalesQuery, context: SectionContext): Common {
  return { ready: true, dataAsOf: context.dataAsOf, options: filterOptions(records, context.can), coverageStart: coverageStart(records, query.from) };
}

export function dashboardSection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): DashboardSection {
  const pop = salesPopulations(records, query);
  const trend = buildTrendSeriesSet(pop.cohort, pop.previousCohort, TREND_METRICS.map((entry) => entry.id),
    pop.trendBounds ?? undefined, pop.previousTrendBounds ?? undefined) as DashboardSection["trend"];
  return {
    ...common(records, query, context),
    leadCount: pop.cohort.filter(isEligibleCohortDeal).length,
    metrics: publicMetrics(buildDashboardMetrics(pop.cohort, pop.won)),
    previousMetrics: publicMetrics(buildDashboardMetrics(pop.previousCohort, pop.previousWon)),
    metricIds: context.settings.dashboardMetricIds,
    trend,
    managers: context.can("managers") ? buildManagers(pop.cohort, pop.won) : null,
  };
}

export function managersSection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): ManagersSection {
  const pop = salesPopulations(records, query);
  return { ...common(records, query, context), managers: buildManagers(pop.cohort, pop.won) };
}

export function managerSection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): ManagerSection {
  const pop = salesPopulations(records, query);
  const managerId = query.managerId ?? "unknown";
  const { cohort, metrics } = buildManagerProfile(pop.cohort, pop.won, managerId);
  const team = buildManagers(pop.cohort, pop.won);
  const benchmarkTeam = team.filter((row) => row.id !== "unknown");
  const withSql = (row: ManagerRow) => row.sql > 0;
  const own = team.find((row) => row.id === managerId);
  const name = own?.name ?? historicalManagerOptions(records).find((option) => option.id === managerId)?.name ?? "Aniqlanmagan";
  const notRelevant = notRelevantRecords(cohort);
  const salesLost = salesLostRecords(cohort);
  return {
    ...common(records, query, context),
    manager: { id: managerId, name },
    metrics: publicMetrics(metrics),
    teamLeads: team.reduce((sum, row) => sum + row.leads, 0),
    medians: {
      sqlToSale: teamMedian(benchmarkTeam, (row) => row.sqlToSale, withSql),
      salesLostRate: teamMedian(benchmarkTeam, (row) => row.salesLostRate, withSql),
      processing: teamMedian(benchmarkTeam, (row) => row.avgProcessing, (row) => row.avgProcessing !== null),
      sla: teamMedian(benchmarkTeam, (row) => row.slaRate, (row) => row.slaDenominator > 0),
      cycle: teamMedian(benchmarkTeam, (row) => row.salesCycleHours, (row) => row.salesCycleHours !== null),
    },
    sources: sourceFunnelRows(cohort),
    notRelevant: { count: notRelevant.length, reasons: reasonBreakdown(notRelevant) },
    salesLost: { count: salesLost.length, reasons: reasonBreakdown(salesLost) },
  };
}

export function leadFlowSection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): LeadFlowSection {
  return { ...common(records, query, context), flow: buildLeadFlow(salesPopulations(records, query).cohort) };
}

export function qualitySection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): QualitySection {
  return { ...common(records, query, context), analytics: buildQualityAnalytics(salesPopulations(records, query).cohort) };
}

export function dealRow(record: DashboardRecord): DealRow {
  return Object.fromEntries(DEAL_ROW_FIELDS.map((field) => [field, record[field]])) as DealRow;
}

export function dealsSection(records: DashboardRecord[], query: SalesQuery, context: SectionContext): DealsSection {
  return { ...common(records, query, context), deals: salesPopulations(records, query).detail.map(dealRow) };
}

export function buildSalesSection(section: SalesSection, records: DashboardRecord[], query: SalesQuery, context: SectionContext) {
  switch (section) {
    case "dashboard": return dashboardSection(records, query, context);
    case "managers": return managersSection(records, query, context);
    case "manager": return managerSection(records, query, context);
    case "leadFlow": return leadFlowSection(records, query, context);
    case "quality": return qualitySection(records, query, context);
    case "deals": return dealsSection(records, query, context);
  }
}

/** Sales has nothing to show until there is a webhook and at least one sync. */
export function isSalesReady(configured: boolean, recordCount: number, syncStatus: string) {
  return configured && (recordCount > 0 || syncStatus === "success");
}

/* ------------------------------------------------------------ diagnostics */

function groupedCount<T>(records: T[], key: (row: T) => string) {
  const counts = new Map<string, number>();
  for (const row of records) { const label = key(row) || "Ko‘rsatilmagan"; counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/** Lead-classification diagnostics, moved verbatim from the dashboard client. */
export function classificationDiagnostics(records: DashboardRecord[]) {
  const excluded = records.filter((row) => !isEligibleCohortDeal(row));
  const eligible = records.filter(isEligibleCohortDeal);
  const classified = eligible.filter(isClassifiedLead);
  const unclassified = eligible.filter(isUnclassifiedLead);
  const sql = eligible.filter((row) => row.qualified);
  const notRelevant = eligible.filter((row) => row.lossReasonGroup === "MARKETING");
  const preSql = eligible.filter(isPreSqlClosed);
  return {
    rows: [
      { label: "Xom cohort", value: String(records.length), hint: `${eligible.length} canonical + ${excluded.length} chiqarilgan` },
      { label: "Leadlar", value: String(eligible.length), hint: "Sales kirishi + joriy loyiha funneli" },
      { label: "Saralangan", value: String(classified.length), hint: `${sql.length} SQL + ${notRelevant.length} Not Relevant` },
      { label: "Saralanmagan", value: String(unclassified.length), hint: "Aktiv pre-SQL + SQLgacha yopilgan" },
      { label: "SQLgacha yopilgan", value: String(preSql.length), hint: "Sales’da yopilgan, SQL dalili yo‘q" },
      { label: "Saralash qamrovi", value: `${pct(classified.length, eligible.length)}%`, hint: "Saralangan / Leadlar" },
      { label: "Takroriy (xom cohort)", value: String(countDuplicates(records)), hint: "Canonical tashqarisidagi yozuvlar ham kiradi" },
      { label: "Takroriy (Leadlar ichida)", value: String(countDuplicates(eligible)), hint: "Leadlar bilan solishtirish uchun" },
    ],
    partitionMismatch: records.length !== eligible.length + excluded.length,
    conflicts: countClassificationConflicts(eligible),
    unclassifiedCount: unclassified.length,
    unclassifiedStages: groupedCount(unclassified, (row) => row.stage || "Stage ko‘rsatilmagan"),
    preSqlCount: preSql.length,
    preSqlReasons: groupedCount(preSql, (row) => row.lossReason || "Sabab ko‘rsatilmagan").slice(0, 12),
  };
}

/**
 * Records older than project membership (pre-version 8), by how the read side
 * resolved them. All three are zero once a Full Sync has rebuilt every known
 * Deal; a non-zero `needsRefresh` means Leads are being kept on legacy evidence.
 */
export function membershipDiagnostics(records: Pick<DashboardRecord, "membershipBasis">[]) {
  const count = (basis: DashboardRecord["membershipBasis"]) => records.filter((row) => row.membershipBasis === basis).length;
  return { needsRefresh: count("LEGACY_NEEDS_REFRESH"), legacyOtherProject: count("LEGACY_OTHER_PROJECT"), legacyRouting: count("LEGACY_ROUTING") };
}

/** Which authority decided each record's Source (lib/source-authority.ts); `legacy` predates version 12. */
export function sourceAuthorityDiagnostics(records: Pick<DashboardRecord, "sourceAuthority">[]) {
  return {
    marketingChannel: records.filter((row) => row.sourceAuthority === "MARKETING_CHANNEL").length,
    sourceId: records.filter((row) => row.sourceAuthority === "SOURCE_ID").length,
    legacy: records.filter((row) => !row.sourceAuthority).length,
  };
}

export function diagnosticsDataSection(records: DashboardRecord[]) {
  return {
    recordCount: records.length, dataQuality: summarizeDataQuality(records), classification: classificationDiagnostics(records),
    membership: membershipDiagnostics(records), sourceAuthority: sourceAuthorityDiagnostics(records),
  };
}

/* ------------------------------------------------------------------ pages */

/**
 * SALES_KPI widget values for a Custom Page, computed here so the page never
 * needs the record population. The same `selectPeriodPopulations` →
 * `buildDashboardMetrics` → `resolveDashboardMetric` chain the page used.
 */
export function salesKpiValue(records: DashboardRecord[], fromMs: number, toMs: number, metricId: string) {
  const populations = selectPeriodPopulations(records, fromMs, toMs);
  const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);
  return resolveDashboardMetric(metrics, metricId as DashboardMetricId);
}

/** What `/api/diagnostics` returns: sync health plus aggregates, never records. */
export function diagnosticsPayload(records: DashboardRecord[], settings: DashboardSettings, sync: Pick<SyncProgressState, "permissions" | "counts" | "safeError" | "lastSyncAt">) {
  return {
    sync: { permissions: sync.permissions, counts: sync.counts, safeError: sync.safeError, lastSyncAt: sync.lastSyncAt },
    ...diagnosticsDataSection(records),
    readiness: stageConfigReadiness(settings),
    conflicts: stageConfigConflicts(settings),
    marketingChannelField: settings.marketingChannelField ?? null,
  };
}
export type DiagnosticsData = ReturnType<typeof diagnosticsPayload>;

/* -------------------------------------------------------------- bootstrap */

/**
 * `/api/bootstrap` body. Operational configuration — CRM settings, sync state,
 * provider diagnostics, the CRM domain — belongs to `settings`; everyone else
 * gets `{}`, and the caller must not even load the data for them.
 */
export function bootstrapPayload(canSettings: boolean, load: () => {
  configured: boolean; domain: string | null; settings: DashboardSettings; sync: unknown; providers: unknown; records: DashboardRecord[];
}) {
  if (!canSettings) return {};
  const { configured, domain, settings, sync, providers, records } = load();
  return {
    configured, domain, settings, sync, providers,
    recordCount: records.length,
    legacyData: records.some((record) => record.analyticsVersion < ANALYTICS_VERSION),
  };
}
