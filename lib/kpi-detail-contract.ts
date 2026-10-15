import type { ProjectKey } from "./sales-projects";

/** Stable URL/API keys for the fifteen primary Dashboard KPI cards. */
export const KPI_DETAIL_METRICS = [
  "leads",
  "sorted",
  "sql",
  "not_relevant",
  "lost",
  "cohort_sales",
  "period_sales",
  "average_check",
  "sales_cycle",
  "active_leads",
  "sla_response",
  "calendar_response",
  "funnel_conversion",
  "sorting_time",
  "icp_fit",
] as const;

export type KpiDetailMetric = (typeof KPI_DETAIL_METRICS)[number];
export type KpiDetailTemplate = "population" | "sales" | "time" | "funnel";
export type KpiDetailStatus = "READY" | "EMPTY" | "NOT_APPLICABLE";

/**
 * Display values are supplied by the API, including percentages and currency.
 * Keeping them as strings makes it impossible for the templates to quietly
 * create a second set of KPI formulas in the browser.
 */
export type KpiDisplayStat = {
  id: string;
  label: string;
  value: string;
  note?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

export type KpiFilterChip = {
  id: string;
  label: string;
  value: string;
};

export type KpiHero = {
  value: string;
  unit?: string | null;
  rate?: { value: string; label: string } | null;
  comparison?: { value: string; label: string; direction?: "up" | "down" | "flat" } | null;
};

export type KpiDealFilter = {
  key: string;
  value: string;
  label?: string | null;
  /** Exact server segment owning this breakdown row. */
  segment?: string | null;
};

export type KpiFunnelStep = {
  id: string;
  label: string;
  value: string;
  transition?: { value: string; label: string } | null;
  dealFilter?: KpiDealFilter | null;
};

export type KpiBreakdownColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
};

export type KpiBreakdownRow = {
  id: string;
  cells: Record<string, string | null | undefined>;
  dealFilter?: KpiDealFilter | null;
};

export type KpiBreakdown = {
  id: string;
  title: string;
  subtitle?: string | null;
  columns: KpiBreakdownColumn[];
  rows: KpiBreakdownRow[];
};

export type KpiDistribution = {
  title: string;
  subtitle?: string | null;
  items: Array<{ id: string; label: string; value: string; share?: string | null; dealFilter?: KpiDealFilter | null }>;
};

export type KpiDeal = {
  id: string;
  title: string;
  createdAt?: string | null;
  manager?: string | null;
  source?: string | null;
  stage?: string | null;
  status?: string | null;
  opportunity?: string | null;
  bitrixUrl?: string | null;
};

export type KpiDealSegment = {
  id: string;
  label: string;
  count?: string | null;
};

export type KpiDealsBlock = {
  title: string;
  total: string;
  page: number;
  pageSize: number;
  pageCount: number;
  searchable?: boolean;
  sortableOpportunity?: boolean;
  activeSegment?: string | null;
  segments?: KpiDealSegment[];
  rows: KpiDeal[];
};

/** Frontend-owned envelope expected from the parallel KPI detail API. */
export type KpiDetailResponse = {
  project: ProjectKey;
  metric: KpiDetailMetric;
  template: KpiDetailTemplate;
  status: KpiDetailStatus;
  message?: string | null;
  title: string;
  subtitle?: string | null;
  definition?: string | null;
  period?: { from?: string | null; to?: string | null; label: string } | null;
  appliedFilters?: KpiFilterChip[];
  hero?: KpiHero | null;
  summary?: KpiDisplayStat[];
  funnel?: KpiFunnelStep[];
  breakdowns?: KpiBreakdown[];
  distribution?: KpiDistribution | null;
  deals?: KpiDealsBlock | null;
};

export type KpiDetailRequest = {
  project: ProjectKey;
  metric: KpiDetailMetric;
  /** Query string without the leading `?`; contains inherited and detail state. */
  search: string;
};

export function isKpiDetailMetric(value: string): value is KpiDetailMetric {
  return (KPI_DETAIL_METRICS as readonly string[]).includes(value);
}
