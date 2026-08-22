import { DASHBOARD_METRICS, type DashboardMetricId } from "./dashboard-metrics";
import { filterProjects, projectUpdates, type Project, type ProjectUpdate } from "./projects";

/**
 * Custom Pages — audience-specific management dashboards (CEO, Marketing,
 * Sales, Product…) assembled from a fixed widget registry.
 *
 * Deliberately not a formula language: a widget names an existing canonical
 * metric or a project helper, or carries a value the owner typed by hand. No
 * widget can invent a calculation, so Sales numbers on a CEO page are always
 * the same numbers as the Sales dashboard.
 */

export type WidgetSource = "BITRIX" | "PROJECTS" | "MANUAL";

export type WidgetType =
  | "SECTION_HEADER" | "SALES_KPI" | "PROJECT_SUMMARY" | "PROJECT_STATUS_BREAKDOWN"
  | "PROJECTS_LIST" | "LATEST_UPDATES" | "MANUAL_KPI" | "TEXT_NOTE";

export const WIDGET_REGISTRY: { type: WidgetType; label: string; source: WidgetSource; hint: string }[] = [
  { type: "SECTION_HEADER", label: "Bo‘lim sarlavhasi", source: "MANUAL", hint: "Marketing / Sales / Projects kabi guruhlash" },
  { type: "SALES_KPI", label: "Sales KPI", source: "BITRIX", hint: "Mavjud kanonik ko‘rsatkichdan o‘qiladi" },
  { type: "PROJECT_SUMMARY", label: "Loyihalar xulosasi", source: "PROJECTS", hint: "Jami, deadline o‘tgan, shu hafta" },
  { type: "PROJECT_STATUS_BREAKDOWN", label: "Loyiha statuslari", source: "PROJECTS", hint: "Ma’lumotdagi haqiqiy statuslar" },
  { type: "PROJECTS_LIST", label: "Loyihalar ro‘yxati", source: "PROJECTS", hint: "Status va deadline bo‘yicha filtr" },
  { type: "LATEST_UPDATES", label: "Oxirgi update’lar", source: "PROJECTS", hint: "Eng yangi update’lar" },
  { type: "MANUAL_KPI", label: "Qo‘lda KPI", source: "MANUAL", hint: "Qo‘lda kiritiladi — Bitrix’dan olinmaydi" },
  { type: "TEXT_NOTE", label: "Matn / izoh", source: "MANUAL", hint: "Haftalik xulosa, risklar, qarorlar" },
];

export const WIDGET_SOURCE_LABELS: Record<WidgetSource, string> = {
  BITRIX: "Bitrix",
  PROJECTS: "Loyihalar",
  MANUAL: "Qo‘lda kiritilgan",
};

export function isWidgetType(value: unknown): value is WidgetType {
  return WIDGET_REGISTRY.some((widget) => widget.type === value);
}

export function widgetSource(type: WidgetType): WidgetSource {
  return WIDGET_REGISTRY.find((widget) => widget.type === type)?.source ?? "MANUAL";
}

export const PAGE_RANGES = [
  { id: "7", label: "Oxirgi 7 kun" },
  { id: "30", label: "Oxirgi 30 kun" },
  { id: "month", label: "Shu oy" },
  { id: "custom", label: "Custom" },
] as const;

export type PageRange = (typeof PAGE_RANGES)[number]["id"];
export function isPageRange(value: unknown): value is PageRange {
  return PAGE_RANGES.some((range) => range.id === value);
}

export const MANUAL_KPI_FORMATS = ["text", "integer", "decimal", "percentage", "currency"] as const;
export type ManualKpiFormat = (typeof MANUAL_KPI_FORMATS)[number];

export type CustomPage = {
  id: string;
  name: string;
  description: string;
  audience: string;
  defaultRange: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type PageWidget = {
  id: string;
  pageId: string;
  widgetType: WidgetType;
  title: string;
  position: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const NAME_LIMIT = 200;
const TEXT_LIMIT = 4000;
const SHORT_LIMIT = 120;
const text = (value: unknown, limit: number) => String(value ?? "").trim().slice(0, limit);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validatePageInput(payload: unknown): ValidationResult<{
  name: string; description: string; audience: string; defaultRange: string;
}> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Sahifa nomi kerak" };
  const range = input.defaultRange === undefined || input.defaultRange === "" ? "30" : input.defaultRange;
  if (!isPageRange(range)) return { ok: false, error: "Sana oralig‘i noto‘g‘ri" };
  return {
    ok: true,
    // Audience is free text: departments name their own audiences.
    value: { name, description: text(input.description, TEXT_LIMIT), audience: text(input.audience, SHORT_LIMIT), defaultRange: range },
  };
}

/** Per-type config validation. An unknown type is rejected outright. */
export function validateWidgetConfig(type: unknown, rawConfig: unknown): ValidationResult<Record<string, unknown>> {
  if (!isWidgetType(type)) return { ok: false, error: "Widget turi noma’lum" };
  const config = (rawConfig ?? {}) as Record<string, unknown>;

  if (type === "SALES_KPI") {
    const metricId = text(config.metricId, 60);
    if (!DASHBOARD_METRICS.some((metric) => metric.id === metricId)) return { ok: false, error: "Ko‘rsatkich noto‘g‘ri" };
    const range = config.range === undefined || config.range === "" ? "" : config.range;
    if (range !== "" && !isPageRange(range)) return { ok: false, error: "Widget sana oralig‘i noto‘g‘ri" };
    return { ok: true, value: { metricId, range } };
  }

  if (type === "MANUAL_KPI") {
    const label = text(config.label, SHORT_LIMIT);
    if (!label) return { ok: false, error: "KPI nomi kerak" };
    const format = MANUAL_KPI_FORMATS.includes(config.format as ManualKpiFormat) ? (config.format as ManualKpiFormat) : "text";
    return {
      ok: true,
      value: { label, value: text(config.value, SHORT_LIMIT), unit: text(config.unit, 24), note: text(config.note, SHORT_LIMIT), format },
    };
  }

  if (type === "TEXT_NOTE") return { ok: true, value: { body: text(config.body, TEXT_LIMIT) } };
  if (type === "SECTION_HEADER") return { ok: true, value: { subtitle: text(config.subtitle, SHORT_LIMIT) } };

  if (type === "PROJECTS_LIST") {
    return {
      ok: true,
      value: {
        status: text(config.status, 60),
        deadline: ["", "OVERDUE", "SOON", "NONE"].includes(String(config.deadline ?? "")) ? String(config.deadline ?? "") : "",
        includeArchived: config.includeArchived === true,
        limit: clampLimit(config.limit, 10),
      },
    };
  }

  if (type === "LATEST_UPDATES") {
    return {
      ok: true,
      value: { projectId: text(config.projectId, 64), status: text(config.status, 60), limit: clampLimit(config.limit, 5) },
    };
  }

  return { ok: true, value: {} };
}

function clampLimit(value: unknown, fallback: number) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : fallback;
}

export function validateWidgetInput(payload: unknown): ValidationResult<{
  pageId: string; widgetType: WidgetType; title: string; position: number; config: Record<string, unknown>;
}> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const pageId = text(input.pageId, 64);
  if (!pageId) return { ok: false, error: "Sahifa tanlanmagan" };
  if (!isWidgetType(input.widgetType)) return { ok: false, error: "Widget turi noma’lum" };
  const parsed = validateWidgetConfig(input.widgetType, input.config);
  if (!parsed.ok) return parsed;
  const position = Number(input.position);
  return {
    ok: true,
    value: {
      pageId, widgetType: input.widgetType, title: text(input.title, NAME_LIMIT),
      position: Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0, config: parsed.value,
    },
  };
}

/** Deterministic order: position, then creation, then id. */
export function orderWidgets(widgets: PageWidget[]) {
  return [...widgets].sort((a, b) =>
    a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function pageWidgets(widgets: PageWidget[], pageId: string) {
  return orderWidgets(widgets.filter((widget) => widget.pageId === pageId));
}

/**
 * Swaps a widget with its neighbour and renumbers the page densely, so
 * positions stay stable integers no matter how often things move.
 */
export function moveWidget(widgets: PageWidget[], pageId: string, widgetId: string, direction: "up" | "down") {
  const ordered = pageWidgets(widgets, pageId);
  const index = ordered.findIndex((widget) => widget.id === widgetId);
  if (index < 0) return ordered.map((widget, position) => ({ id: widget.id, position }));
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ordered.length) return ordered.map((widget, position) => ({ id: widget.id, position }));
  const reordered = [...ordered];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered.map((widget, position) => ({ id: widget.id, position }));
}

export function filterPages(pages: CustomPage[], options: { includeArchived?: boolean; search?: string } = {}) {
  const search = String(options.search ?? "").trim().toLowerCase();
  return pages.filter((page) => {
    if (!options.includeArchived && page.archivedAt) return false;
    if (search && !`${page.name} ${page.audience} ${page.description}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

/** Formats a hand-entered value. Never implies the number came from Bitrix. */
export function formatManualValue(config: Record<string, unknown>) {
  const raw = String(config.value ?? "").trim();
  const unit = String(config.unit ?? "").trim();
  const format = String(config.format ?? "text") as ManualKpiFormat;
  if (!raw) return "—";
  const numeric = Number(raw.replace(/\s/g, "").replace(",", "."));
  const shown = Number.isFinite(numeric) && format !== "text"
    ? format === "integer" ? Math.round(numeric).toLocaleString("uz-UZ")
      : format === "currency" ? Math.round(numeric).toLocaleString("uz-UZ")
        : numeric.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })
    : raw;
  if (format === "percentage") return `${shown}%`;
  return unit ? `${shown} ${unit}` : shown;
}

/**
 * Resolves a range id to absolute bounds. Shared by the authenticated builder
 * and the public share renderer so a shared KPI covers exactly the same window
 * as the same widget inside the app.
 */
export function pageRangeBounds(range: string, now: Date = new Date()) {
  const start = range === "7" ? new Date(now.getTime() - 6 * 86_400_000)
    : range === "month" ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getTime() - 29 * 86_400_000);
  return { from: start.getTime(), to: now.getTime() };
}

/** A widget range of "" means "inherit the page range". */
export function resolveWidgetRange(config: Record<string, unknown>, pageRange: string) {
  return String(config.range || "") || pageRange;
}

export function pageRangeLabel(range: string) {
  return PAGE_RANGES.find((item) => item.id === range)?.label ?? range;
}

/** Row selection for PROJECTS_LIST — one implementation, two renderers. */
export function selectProjectsListRows(projects: Project[], config: Record<string, unknown>, now: Date = new Date()) {
  return filterProjects(projects, {
    status: String(config.status ?? ""),
    deadline: String(config.deadline ?? ""),
    includeArchived: config.includeArchived === true,
  }, now).slice(0, Number(config.limit ?? 10));
}

/** Row selection for LATEST_UPDATES — newest first, optional project/status filter. */
export function selectLatestUpdates(updates: ProjectUpdate[], config: Record<string, unknown>) {
  const projectId = String(config.projectId ?? "");
  const status = String(config.status ?? "");
  const scoped = projectId
    ? projectUpdates(updates, projectId)
    : [...updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return scoped.filter((update) => !status || update.status === status).slice(0, Number(config.limit ?? 5));
}

export type TemplateWidget = { widgetType: WidgetType; title: string; config: Record<string, unknown> };

const salesKpi = (metricId: DashboardMetricId): TemplateWidget => ({
  widgetType: "SALES_KPI",
  title: DASHBOARD_METRICS.find((metric) => metric.id === metricId)?.label ?? metricId,
  config: { metricId, range: "" },
});

/** Starter layouts only — every widget is editable afterwards. */
export const PAGE_TEMPLATES: { id: string; name: string; audience: string; label: string; widgets: TemplateWidget[] }[] = [
  {
    id: "ceo", name: "CEO Overview", audience: "CEO", label: "CEO Overview yaratish",
    widgets: [
      { widgetType: "SECTION_HEADER", title: "Marketing", config: { subtitle: "Qo‘lda kiritiladigan ko‘rsatkichlar" } },
      { widgetType: "MANUAL_KPI", title: "Spend", config: { label: "Spend", value: "", unit: "", note: "", format: "currency" } },
      { widgetType: "MANUAL_KPI", title: "CPL", config: { label: "CPL", value: "", unit: "", note: "", format: "decimal" } },
      { widgetType: "SECTION_HEADER", title: "Sales", config: { subtitle: "Bitrix’dan avtomatik" } },
      salesKpi("leads"), salesKpi("sql"), salesKpi("cohort_sales"),
      salesKpi("period_sales"), salesKpi("revenue"), salesKpi("sql_to_sale"),
      { widgetType: "SECTION_HEADER", title: "Projects", config: { subtitle: "Ichki loyihalar holati" } },
      { widgetType: "PROJECT_SUMMARY", title: "Loyihalar xulosasi", config: {} },
      { widgetType: "LATEST_UPDATES", title: "Oxirgi update’lar", config: { projectId: "", status: "", limit: 5 } },
      { widgetType: "PROJECTS_LIST", title: "Deadline o‘tgan loyihalar", config: { status: "", deadline: "OVERDUE", includeArchived: false, limit: 10 } },
      { widgetType: "SECTION_HEADER", title: "Risks / Notes", config: { subtitle: "Qarorlar va risklar" } },
      { widgetType: "TEXT_NOTE", title: "Izoh", config: { body: "" } },
    ],
  },
  {
    id: "sales", name: "Sales Overview", audience: "Sales", label: "Sales Overview yaratish",
    widgets: [
      { widgetType: "SECTION_HEADER", title: "Sales", config: { subtitle: "" } },
      salesKpi("leads"), salesKpi("sql"), salesKpi("lead_to_sql"), salesKpi("sales_lost"),
      salesKpi("cohort_sales"), salesKpi("sql_to_sale"), salesKpi("avg_processing"), salesKpi("sla"),
    ],
  },
  {
    id: "marketing", name: "Marketing Overview", audience: "Marketing", label: "Marketing Overview yaratish",
    widgets: [
      { widgetType: "SECTION_HEADER", title: "Marketing", config: { subtitle: "Qo‘lda kiritiladigan ko‘rsatkichlar" } },
      { widgetType: "MANUAL_KPI", title: "Spend", config: { label: "Spend", value: "", unit: "", note: "", format: "currency" } },
      { widgetType: "MANUAL_KPI", title: "CPL", config: { label: "CPL", value: "", unit: "", note: "", format: "decimal" } },
      { widgetType: "SECTION_HEADER", title: "Lead sifati", config: { subtitle: "Bitrix’dan avtomatik" } },
      salesKpi("leads"), salesKpi("not_relevant"), salesKpi("lead_to_sql"), salesKpi("duplicates"),
    ],
  },
  {
    id: "projects", name: "Project Overview", audience: "Product", label: "Project Overview yaratish",
    widgets: [
      { widgetType: "SECTION_HEADER", title: "Projects", config: { subtitle: "" } },
      { widgetType: "PROJECT_SUMMARY", title: "Loyihalar xulosasi", config: {} },
      { widgetType: "PROJECT_STATUS_BREAKDOWN", title: "Statuslar", config: {} },
      { widgetType: "PROJECTS_LIST", title: "Loyihalar", config: { status: "", deadline: "", includeArchived: false, limit: 20 } },
      { widgetType: "LATEST_UPDATES", title: "Oxirgi update’lar", config: { projectId: "", status: "", limit: 10 } },
    ],
  },
];

export function templateById(id: string) {
  return PAGE_TEMPLATES.find((template) => template.id === id) ?? null;
}
