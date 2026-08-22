import {
  formatManualValue, orderWidgets, pageRangeBounds, pageRangeLabel, resolveWidgetRange,
  selectLatestUpdates, selectProjectsListRows, widgetSource,
  type CustomPage, type PageWidget, type WidgetSource,
} from "./custom-pages";
import {
  buildDashboardMetrics, resolveDashboardMetric, selectPeriodPopulations, type DashboardMetricId,
} from "./dashboard-metrics";
import { isOverdue, latestUpdate, statusBreakdown, summarizeProjects, type Project, type ProjectUpdate } from "./projects";
import type { AnalyticsRecord } from "./types";

/**
 * The public payload boundary for shared pages.
 *
 * Everything a recipient can ever see is reduced here to rendered primitives —
 * strings and numbers. Widget ids, `config_json`, deal ids, project ids,
 * settings and analytics records exist on the input side of this function and
 * on no path out of it. That makes the privacy guarantee a property of the
 * type, not of the renderer's discipline.
 */

export type SharedWidget =
  | { kind: "SECTION_HEADER"; title: string; subtitle: string }
  | { kind: "KPI"; title: string; value: string; detail: string; source: WidgetSource }
  | { kind: "NOTE"; title: string; body: string }
  | { kind: "SUMMARY"; title: string; items: { label: string; value: string }[] }
  | { kind: "BARS"; title: string; empty: string; rows: { label: string; value: number; percent: number }[] }
  | { kind: "TABLE"; title: string; empty: string; columns: string[]; rows: { cells: string[]; alert: boolean }[] }
  | { kind: "TIMELINE"; title: string; empty: string; items: { title: string; status: string; meta: string }[] };

export type SharePayload = {
  page: { name: string; description: string; audience: string; updatedAt: string };
  widgets: SharedWidget[];
  generatedAt: string;
};

export type ShareModelInput = {
  page: CustomPage;
  widgets: PageWidget[];
  /** Widget ids this particular share exposes. Everything else is dropped. */
  allowedWidgetIds: string[];
  records: AnalyticsRecord[];
  projects: Project[];
  updates: ProjectUpdate[];
  now?: Date;
};

/** Which datasets a share actually needs — lets the route skip loading the rest. */
export function shareDataNeeds(widgets: PageWidget[], allowedWidgetIds: string[]) {
  const visible = visibleWidgets(widgets, allowedWidgetIds);
  return {
    analytics: visible.some((widget) => widget.widgetType === "SALES_KPI"),
    projects: visible.some((widget) => widgetSource(widget.widgetType) === "PROJECTS"),
  };
}

/** The allowlist, applied once, in the page's own deterministic order. */
export function visibleWidgets(widgets: PageWidget[], allowedWidgetIds: string[]) {
  const allowed = new Set(allowedWidgetIds);
  return orderWidgets(widgets.filter((widget) => allowed.has(widget.id)));
}

const dateOnly = (value: string) => (value ? String(value).slice(0, 10) : "—");

export function buildSharePayload(input: ShareModelInput): SharePayload {
  const now = input.now ?? new Date();
  const widgets = visibleWidgets(input.widgets, input.allowedWidgetIds)
    .filter((widget) => widget.pageId === input.page.id);

  return {
    page: {
      name: input.page.name,
      description: input.page.description,
      audience: input.page.audience,
      updatedAt: input.page.updatedAt,
    },
    widgets: widgets.flatMap((widget) => {
      const rendered = renderWidget(widget, input, now);
      return rendered ? [rendered] : [];
    }),
    generatedAt: now.toISOString(),
  };
}

function renderWidget(widget: PageWidget, input: ShareModelInput, now: Date): SharedWidget | null {
  const config = widget.config;
  const source = widgetSource(widget.widgetType);

  if (widget.widgetType === "SECTION_HEADER") {
    return { kind: "SECTION_HEADER", title: widget.title || "Bo‘lim", subtitle: String(config.subtitle ?? "") };
  }

  if (widget.widgetType === "SALES_KPI") {
    // The canonical path, identical to the authenticated dashboard: no shared
    // page may compute a Sales number any other way.
    const range = resolveWidgetRange(config, input.page.defaultRange);
    const bounds = pageRangeBounds(range, now);
    const populations = selectPeriodPopulations(input.records, bounds.from, bounds.to);
    const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);
    const resolved = resolveDashboardMetric(metrics, String(config.metricId) as DashboardMetricId);
    return { kind: "KPI", title: widget.title || resolved.label, value: resolved.value, detail: pageRangeLabel(range), source };
  }

  if (widget.widgetType === "MANUAL_KPI") {
    return {
      kind: "KPI", title: widget.title || String(config.label ?? "KPI"),
      value: formatManualValue(config), detail: String(config.note ?? "") || "Qo‘lda kiritilgan", source,
    };
  }

  if (widget.widgetType === "TEXT_NOTE") {
    return { kind: "NOTE", title: widget.title || "Izoh", body: String(config.body ?? "") };
  }

  if (widget.widgetType === "PROJECT_SUMMARY") {
    const summary = summarizeProjects(input.projects, now);
    return {
      kind: "SUMMARY", title: widget.title || "Loyihalar xulosasi",
      items: [
        { label: "Jami loyihalar", value: String(summary.total) },
        { label: "Deadline o‘tgan", value: String(summary.overdue) },
        { label: "Shu hafta yangilangan", value: String(summary.updatedThisWeek) },
        { label: "Shu hafta deadline", value: String(summary.deadlineThisWeek) },
      ],
    };
  }

  if (widget.widgetType === "PROJECT_STATUS_BREAKDOWN") {
    const breakdown = statusBreakdown(input.projects);
    const total = breakdown.reduce((sum, row) => sum + row.count, 0);
    return {
      kind: "BARS", title: widget.title || "Statuslar", empty: "Loyiha yo‘q.",
      rows: breakdown.map((row) => ({
        label: row.status, value: row.count, percent: total ? Math.round((row.count / total) * 100) : 0,
      })),
    };
  }

  if (widget.widgetType === "PROJECTS_LIST") {
    // Exactly the columns the in-app widget renders — descriptions stay behind.
    const rows = selectProjectsListRows(input.projects, config, now);
    return {
      kind: "TABLE", title: widget.title || "Loyihalar", empty: "Loyiha topilmadi.",
      columns: ["Loyiha", "Status", "Deadline", "Oxirgi update"],
      rows: rows.map((project) => ({
        alert: isOverdue(project, now),
        cells: [
          project.name, project.status, project.deadline ?? "—",
          latestUpdate(input.updates, project.id)?.title ?? "—",
        ],
      })),
    };
  }

  if (widget.widgetType === "LATEST_UPDATES") {
    const rows = selectLatestUpdates(input.updates, config);
    return {
      kind: "TIMELINE", title: widget.title || "Oxirgi update’lar", empty: "Update yo‘q.",
      items: rows.map((update) => ({
        title: update.title, status: update.status,
        meta: `${input.projects.find((project) => project.id === update.projectId)?.name ?? "—"} · ${dateOnly(update.createdAt)}`,
      })),
    };
  }

  return null;
}
