import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_TEMPLATES, WIDGET_REGISTRY, filterPages, formatManualValue, moveWidget, orderWidgets,
  pageWidgets, templateById, validatePageInput, validateWidgetConfig, validateWidgetInput,
  widgetSource, type CustomPage, type PageWidget, type WidgetType,
} from "../lib/custom-pages";
import { DASHBOARD_METRICS, buildDashboardMetrics, resolveDashboardMetric, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { statusBreakdown, summarizeProjects, type Project } from "../lib/projects";
import type { AnalyticsRecord } from "../lib/types";

const iso = (day: string) => `2026-08-${day}T09:00:00.000Z`;
function page(over: Partial<CustomPage> = {}): CustomPage {
  return { id: "pg1", name: "CEO Overview", description: "", audience: "CEO", defaultRange: "30",
    createdAt: iso("01"), updatedAt: iso("20"), archivedAt: null, ...over };
}
function widget(id: string, position: number, over: Partial<PageWidget> = {}): PageWidget {
  return { id, pageId: "pg1", widgetType: "MANUAL_KPI" as WidgetType, title: id, position,
    config: {}, createdAt: iso("01"), updatedAt: iso("01"), ...over };
}

test("create/edit page validated; audience is free text", () => {
  const parsed = validatePageInput({ name: " CEO Overview ", audience: "Board of Directors", defaultRange: "7" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.name, "CEO Overview");
    assert.equal(parsed.value.audience, "Board of Directors");
    assert.equal(parsed.value.defaultRange, "7");
  }
  assert.deepEqual(validatePageInput({ audience: "CEO" }), { ok: false, error: "Sahifa nomi kerak" });
  assert.deepEqual(validatePageInput({ name: "X", defaultRange: "99" }), { ok: false, error: "Sana oralig‘i noto‘g‘ri" });
  assert.equal(validatePageInput({ name: "X" }).ok, true, "range defaults to 30");
});

test("archived page hidden by default", () => {
  const rows = [page({ id: "a" }), page({ id: "b", archivedAt: iso("21") })];
  assert.deepEqual(filterPages(rows).map((p) => p.id), ["a"]);
  assert.deepEqual(filterPages(rows, { includeArchived: true }).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(filterPages(rows, { search: "ceo" }).map((p) => p.id), ["a"]);
});

test("unknown widget type rejected", () => {
  assert.deepEqual(validateWidgetConfig("SOMETHING_ELSE", {}), { ok: false, error: "Widget turi noma’lum" });
  assert.deepEqual(validateWidgetInput({ pageId: "pg1", widgetType: "NOPE" }), { ok: false, error: "Widget turi noma’lum" });
  assert.deepEqual(validateWidgetInput({ widgetType: "TEXT_NOTE" }), { ok: false, error: "Sahifa tanlanmagan" });
});

test("malformed widget config rejected", () => {
  assert.deepEqual(validateWidgetConfig("SALES_KPI", { metricId: "not_a_metric" }), { ok: false, error: "Ko‘rsatkich noto‘g‘ri" });
  assert.deepEqual(validateWidgetConfig("SALES_KPI", { metricId: "leads", range: "99" }), { ok: false, error: "Widget sana oralig‘i noto‘g‘ri" });
  assert.deepEqual(validateWidgetConfig("MANUAL_KPI", { value: "5" }), { ok: false, error: "KPI nomi kerak" });
  const limits = validateWidgetConfig("PROJECTS_LIST", { limit: 9999, deadline: "BOGUS" });
  assert.equal(limits.ok, true);
  if (limits.ok) { assert.equal(limits.value.limit, 50, "limit clamped"); assert.equal(limits.value.deadline, ""); }
});

test("Sales KPI widget reads the canonical metric helper — no duplicated formula", () => {
  const records = [
    { createdAt: iso("05"), salesStatus: "WON", wonAt: iso("10"), qualified: true, lossReasonGroup: "NONE", opportunity: 100, processingBusinessMinutes: 5, slaStatus: "ON_TIME", customerKey: null, duplicateOfDealId: null },
    { createdAt: iso("06"), salesStatus: "ACTIVE", wonAt: null, qualified: true, lossReasonGroup: "NONE", opportunity: 0, processingBusinessMinutes: 5, slaStatus: "ON_TIME", customerKey: null, duplicateOfDealId: null },
    { createdAt: iso("07"), salesStatus: "LOST", wonAt: null, qualified: true, lossReasonGroup: "ROUTING", opportunity: 0, processingBusinessMinutes: 5, slaStatus: "ON_TIME", customerKey: null, duplicateOfDealId: null },
  ] as unknown as AnalyticsRecord[];
  const bounds = { from: Date.parse(iso("01")), to: Date.parse(iso("28")) };
  const populations = selectPeriodPopulations(records, bounds.from, bounds.to);
  const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);
  // Routing exclusion and every other rule come from the shared helper.
  assert.equal(resolveDashboardMetric(metrics, "leads").value, "2");
  assert.equal(resolveDashboardMetric(metrics, "cohort_sales").value, "1");
  assert.equal(resolveDashboardMetric(metrics, "revenue").value, (100).toLocaleString("uz-UZ"));
  assert.equal(resolveDashboardMetric(metrics, "sql_to_sale").value, "50%");
  assert.equal(resolveDashboardMetric(metrics, "leads").label, "Leadlar");
  // Contract: SALES_KPI exposes the canonical registry in full — no second,
  // hand-curated metric list may drift from it.
  for (const metric of DASHBOARD_METRICS) {
    assert.equal(typeof resolveDashboardMetric(metrics, metric.id).value, "string", metric.id);
    assert.equal(validateWidgetConfig("SALES_KPI", { metricId: metric.id, range: "" }).ok, true, metric.id);
  }
  assert.ok(DASHBOARD_METRICS.some((metric) => metric.label === "Median chek"), "Median chek selectable");
});

test("project widgets reuse Sprint 19 helpers incl. dynamic statuses", () => {
  const projects = [
    { id: "p1", name: "A", description: "", status: "CEO approval", deadline: "2026-08-01", createdAt: iso("01"), updatedAt: iso("20"), archivedAt: null },
    { id: "p2", name: "B", description: "", status: "Kutilyapti", deadline: null, createdAt: iso("02"), updatedAt: iso("02"), archivedAt: null },
  ] as Project[];
  const now = new Date("2026-08-22T12:00:00.000Z");
  assert.equal(summarizeProjects(projects, now).total, 2);
  assert.equal(summarizeProjects(projects, now).overdue, 1);
  assert.deepEqual(statusBreakdown(projects).map((r) => r.status).sort(), ["CEO approval", "Kutilyapti"], "no hard-coded statuses");
});

test("widget ordering is deterministic and move up/down renumbers densely", () => {
  const rows = [widget("c", 2), widget("a", 0), widget("b", 1)];
  assert.deepEqual(orderWidgets(rows).map((w) => w.id), ["a", "b", "c"]);
  assert.deepEqual(moveWidget(rows, "pg1", "c", "up"), [{ id: "a", position: 0 }, { id: "c", position: 1 }, { id: "b", position: 2 }]);
  assert.deepEqual(moveWidget(rows, "pg1", "a", "down"), [{ id: "b", position: 0 }, { id: "a", position: 1 }, { id: "c", position: 2 }]);
  // Edges are no-ops that still return a dense order.
  assert.deepEqual(moveWidget(rows, "pg1", "a", "up").map((w) => w.id), ["a", "b", "c"]);
  assert.deepEqual(moveWidget(rows, "pg1", "c", "down").map((w) => w.id), ["a", "b", "c"]);
  // Ties fall back to createdAt then id.
  assert.deepEqual(orderWidgets([widget("z", 0), widget("y", 0)]).map((w) => w.id), ["y", "z"]);
  assert.deepEqual(pageWidgets([...rows, widget("x", 0, { pageId: "other" })], "pg1").map((w) => w.id), ["a", "b", "c"]);
});

test("Manual KPI persists its value and never claims to be synced", () => {
  const parsed = validateWidgetConfig("MANUAL_KPI", { label: "Meta Spend", value: "12500", format: "currency", unit: "UZS", note: "Iyul" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.value, "12500");
  assert.equal(parsed.value.label, "Meta Spend");
  assert.equal(widgetSource("MANUAL_KPI"), "MANUAL");
  assert.equal(formatManualValue({ value: "12500", format: "currency", unit: "UZS" }), `${(12500).toLocaleString("uz-UZ")} UZS`);
  assert.equal(formatManualValue({ value: "12.5", format: "percentage" }), `${(12.5).toLocaleString("uz-UZ")}%`);
  assert.equal(formatManualValue({ value: "", format: "text" }), "—");
  assert.equal(formatManualValue({ value: "NPS good", format: "text" }), "NPS good");
});

test("Text widget persists content; section header persists subtitle", () => {
  const note = validateWidgetConfig("TEXT_NOTE", { body: "Haftalik xulosa" });
  assert.equal(note.ok && String(note.value.body), "Haftalik xulosa");
  const header = validateWidgetConfig("SECTION_HEADER", { subtitle: "Marketing" });
  assert.equal(header.ok && String(header.value.subtitle), "Marketing");
  const long = validateWidgetConfig("TEXT_NOTE", { body: "x".repeat(9000) });
  assert.equal(long.ok && String(long.value.body).length, 4000, "length capped");
});

test("CEO template creates the expected widget structure", () => {
  const ceo = templateById("ceo");
  assert.ok(ceo);
  if (!ceo) return;
  assert.equal(ceo.audience, "CEO");
  const sections = ceo.widgets.filter((w) => w.widgetType === "SECTION_HEADER").map((w) => w.title);
  assert.deepEqual(sections, ["Marketing", "Sales", "Projects", "Risks / Notes"]);
  const salesMetrics = ceo.widgets.filter((w) => w.widgetType === "SALES_KPI").map((w) => String(w.config.metricId));
  assert.deepEqual(salesMetrics, ["leads", "sql", "cohort_sales", "period_sales", "revenue", "sql_to_sale"]);
  assert.equal(ceo.widgets.filter((w) => w.widgetType === "MANUAL_KPI").length, 2, "Spend + CPL");
  assert.ok(ceo.widgets.some((w) => w.widgetType === "PROJECT_SUMMARY"));
  assert.ok(ceo.widgets.some((w) => w.widgetType === "LATEST_UPDATES"));
  assert.ok(ceo.widgets.some((w) => w.widgetType === "PROJECTS_LIST" && w.config.deadline === "OVERDUE"));
  assert.ok(ceo.widgets.some((w) => w.widgetType === "TEXT_NOTE"));
  // No template hard-codes a value.
  for (const w of ceo.widgets.filter((x) => x.widgetType === "MANUAL_KPI")) assert.equal(w.config.value, "");
  // Every template widget passes validation.
  for (const template of PAGE_TEMPLATES) {
    for (const w of template.widgets) assert.equal(validateWidgetConfig(w.widgetType, w.config).ok, true, `${template.id}/${w.widgetType}`);
  }
});

test("every registry widget declares a source; manual is never labelled Bitrix", () => {
  assert.equal(WIDGET_REGISTRY.length, 8);
  for (const entry of WIDGET_REGISTRY) assert.ok(["BITRIX", "PROJECTS", "MANUAL"].includes(entry.source), entry.type);
  assert.equal(widgetSource("SALES_KPI"), "BITRIX");
  assert.equal(widgetSource("PROJECT_SUMMARY"), "PROJECTS");
  assert.equal(widgetSource("TEXT_NOTE"), "MANUAL");
});

test("existing Sales dashboard definitions unchanged", () => {
  assert.equal(DASHBOARD_METRICS.length, 17);
  assert.deepEqual(DASHBOARD_METRICS.slice(0, 3).map((m) => m.label), ["Leadlar", "SQL", "Not Relevant"]);
});
