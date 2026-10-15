import type { HeadlineCardId } from "./dashboard-cards";
import type { KpiDetailMetric } from "./kpi-detail-contract";
import { SALES_PROJECTS, type ProjectKey } from "./sales-projects";

export const HEADLINE_KPI_DETAIL: Record<HeadlineCardId, Exclude<KpiDetailMetric, "icp_fit">> = {
  leads: "leads",
  classified_leads: "sorted",
  sql: "sql",
  not_relevant: "not_relevant",
  sales_lost: "lost",
  cohort_sales: "cohort_sales",
  period_sales: "period_sales",
  avg_check: "average_check",
  lead_to_sql: "funnel_conversion",
  sla_avg: "sla_response",
  sla_elapsed: "calendar_response",
  avg_processing: "sorting_time",
  sales_cycle: "sales_cycle",
  active_cohort: "active_leads",
};

export type DashboardRange = "today" | "yesterday" | "7" | "30" | "month" | "lastMonth" | "custom";
export type DashboardUrlFilters = {
  range: DashboardRange;
  from: string;
  to: string;
  managers: string[];
  sources: string[];
  pipeline: string;
  stage: string;
  period: string;
  sla: string;
  processing: string;
  search: string;
};

const DASHBOARD_RANGES = ["today", "yesterday", "7", "30", "month", "lastMonth", "custom"] as const;
const DETAIL_ONLY_KEYS = ["page", "q", "segment", "breakdown", "breakdownValue", "sort"] as const;

function cleanSearch(search: string) {
  return search.startsWith("?") ? search.slice(1) : search;
}
export function kpiDetailHref(project: ProjectKey, metric: KpiDetailMetric, search = "") {
  const query = cleanSearch(search);
  return `/${SALES_PROJECTS[project].slug}/kpi/${metric}${query ? `?${query}` : ""}`;
}

/** Fallback Back link: detail-only controls never leak into the Dashboard. */
export function dashboardHref(project: ProjectKey, search = "") {
  const params = new URLSearchParams(cleanSearch(search));
  for (const key of DETAIL_ONLY_KEYS) params.delete(key);
  const query = params.toString();
  return `/${SALES_PROJECTS[project].slug}${query ? `?${query}` : ""}`;
}

/** URL state transition used by pagination, search, tabs and breakdown rows. */
export function updateKpiDetailSearch(search: string, patch: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams(cleanSearch(search));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  return params.toString();
}

export function applyDealFilterSearch(search: string, filter: { key: string; value: string } | null) {
  return updateKpiDetailSearch(search, {
    page: 1,
    breakdown: filter?.key ?? null,
    breakdownValue: filter?.value ?? null,
  });
}

/** A native link already handles Enter; this adds the expected Space behavior. */
export function activateKpiCardOnKeyDown(event: {
  key: string;
  preventDefault: () => void;
  currentTarget: { click: () => void };
}) {
  if (event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.click();
}

export function serializeDashboardFilterSearch(filters: DashboardUrlFilters, resolved: { from: string; to: string }) {
  const params = new URLSearchParams();
  params.set("range", filters.range);
  if (resolved.from) params.set("from", resolved.from);
  if (resolved.to) params.set("to", resolved.to);
  for (const manager of filters.managers) params.append("manager", manager);
  for (const source of filters.sources) params.append("source", source);
  for (const key of ["pipeline", "stage", "period", "sla", "processing"] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.search.trim()) params.set("search", filters.search.trim());
  return params.toString();
}

export function parseDashboardFilterSearch(search: string, fallback: DashboardUrlFilters): DashboardUrlFilters {
  const params = new URLSearchParams(cleanSearch(search));
  const range = params.get("range");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const parsedRange = (DASHBOARD_RANGES as readonly string[]).includes(range ?? "")
    ? range as DashboardRange
    : from || to ? "custom" : fallback.range;
  return {
    range: parsedRange,
    from,
    to,
    managers: params.getAll("manager").filter(Boolean),
    sources: params.getAll("source").filter(Boolean),
    pipeline: params.get("pipeline") ?? "",
    stage: params.get("stage") ?? "",
    period: params.get("period") ?? "",
    sla: params.get("sla") ?? "",
    processing: params.get("processing") ?? "",
    search: params.get("search") ?? "",
  };
}
