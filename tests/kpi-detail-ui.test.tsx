import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DASHBOARD_HEADLINE_CARD_IDS } from "../lib/dashboard-cards";
import { KPI_DETAIL_METRICS, type KpiDetailResponse } from "../lib/kpi-detail-contract";
import {
  HEADLINE_KPI_DETAIL,
  activateKpiCardOnKeyDown,
  applyDealFilterSearch,
  dashboardHref,
  kpiDetailHref,
  parseDashboardFilterSearch,
  serializeDashboardFilterSearch,
  updateKpiDetailSearch,
} from "../lib/kpi-detail-routes";
import { HttpKpiDetailAdapter, KPI_DETAIL_ENDPOINT, loadKpiDetailResource } from "../app/kpi-detail/kpi-detail-adapter";
import { FixtureKpiDetailAdapter, fixtureKpiDetailResponse } from "../app/kpi-detail/kpi-detail-fixtures";
import { KpiDetailState } from "../app/kpi-detail/kpi-detail-client";
import {
  FunnelQualityDetailTemplate,
  KpiDealDrawer,
  PopulationDetailTemplate,
  SalesDetailTemplate,
  TimeDetailTemplate,
  type KpiTemplateProps,
} from "../app/kpi-detail/kpi-detail-templates";

const inherited = "range=custom&from=2026-10-01&to=2026-10-15&manager=25&manager=31&source=CRM-%D1%84%D0%BE%D1%80%D0%BC%D0%B0";
const noop = () => undefined;
const templateProps = (data: KpiDetailResponse): KpiTemplateProps => ({
  data,
  onFilter: noop,
  onDeal: noop,
  onPage: noop,
  onPageSize: noop,
  onSearch: noop,
  onSegment: noop,
  onSort: noop,
});

test("all 15 primary Dashboard cards map to stable workspace detail routes", () => {
  assert.equal(DASHBOARD_HEADLINE_CARD_IDS.length, 14);
  assert.equal(Object.keys(HEADLINE_KPI_DETAIL).length, 14);
  assert.deepEqual(new Set([...Object.values(HEADLINE_KPI_DETAIL), "icp_fit"]), new Set(KPI_DETAIL_METRICS));
  assert.deepEqual(HEADLINE_KPI_DETAIL, {
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
  });
  for (const metric of KPI_DETAIL_METRICS) {
    assert.equal(kpiDetailHref("IBOX", metric, inherited), `/ibox/kpi/${metric}?${inherited}`);
    assert.equal(kpiDetailHref("SALES_DOCTOR", metric), `/sales-doctor/kpi/${metric}`);
  }
});

test("Dashboard filter URL survives detail navigation, refresh and fallback Back link", () => {
  const fallback = { range: "30" as const, from: "", to: "", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" };
  const parsed = parseDashboardFilterSearch(inherited, fallback);
  assert.deepEqual(parsed.managers, ["25", "31"]);
  assert.deepEqual(parsed.sources, ["CRM-форма"]);
  assert.equal(parsed.range, "custom");
  const serialized = serializeDashboardFilterSearch(parsed, { from: parsed.from, to: parsed.to });
  assert.deepEqual(parseDashboardFilterSearch(serialized, fallback), parsed);

  const detailState = updateKpiDetailSearch(serialized, { page: 3, pageSize: 100, q: "48102", sort: "opportunity_desc", segment: "late", breakdown: "manager", breakdownValue: "25" });
  assert.equal(dashboardHref("IBOX", detailState), `/ibox?${serialized}`);
});

test("KPI card keeps native Enter semantics and adds Space activation", () => {
  let clicked = 0;
  let prevented = 0;
  const event = (key: string) => ({ key, preventDefault: () => { prevented += 1; }, currentTarget: { click: () => { clicked += 1; } } });
  activateKpiCardOnKeyDown(event("Enter"));
  assert.equal(clicked, 0, "anchors activate Enter natively");
  activateKpiCardOnKeyDown(event(" "));
  assert.equal(clicked, 1);
  assert.equal(prevented, 1);
});

test("HTTP adapter forwards inherited context and never lets query override route identity", async () => {
  let requested: URL | null = null;
  const response = fixtureKpiDetailResponse({ project: "IBOX", metric: "sql", search: inherited });
  const adapter = new HttpKpiDetailAdapter((async (input: RequestInfo | URL) => {
    requested = new URL(String(input), "https://dashboard.test");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  await adapter.getDetail({ project: "IBOX", metric: "sql", search: `${inherited}&project=SALES_DOCTOR&metric=lost` });
  const url = requested as unknown as URL;
  assert.equal(url.pathname, KPI_DETAIL_ENDPOINT);
  assert.equal(url.searchParams.get("project"), "IBOX");
  assert.equal(url.searchParams.get("metric"), "sql");
  assert.deepEqual(url.searchParams.getAll("manager"), ["25", "31"]);
  assert.equal(url.searchParams.get("from"), "2026-10-01");
  assert.equal(url.searchParams.get("to"), "2026-10-15");
});

test("Population, Sales, Time and Funnel templates render only API-supplied blocks", () => {
  const population = fixtureKpiDetailResponse({ project: "IBOX", metric: "not_relevant", search: inherited });
  const sales = fixtureKpiDetailResponse({ project: "IBOX", metric: "cohort_sales", search: inherited });
  const time = fixtureKpiDetailResponse({ project: "IBOX", metric: "calendar_response", search: inherited });
  const funnel = fixtureKpiDetailResponse({ project: "IBOX", metric: "funnel_conversion", search: inherited });
  const populationHtml = renderToStaticMarkup(<PopulationDetailTemplate {...templateProps(population)} />);
  assert.match(populationHtml, /data-kpi-template="population"/);
  assert.match(populationHtml, /Nega Not Relevant bo‘ldi/);
  assert.match(populationHtml, /Sabab ko‘rsatilmagan/);
  assert.match(renderToStaticMarkup(<SalesDetailTemplate {...templateProps(sales)} />), /data-kpi-template="sales"/);
  const timeHtml = renderToStaticMarkup(<TimeDetailTemplate {...templateProps(time)} />);
  assert.match(timeHtml, /data-kpi-template="time"/);
  assert.match(timeHtml, /Sahifadagi Deal soni/);
  assert.equal(time.subtitle, "Real o‘tgan vaqt — tun va dam olish kunlari ham kiradi");
  const funnelHtml = renderToStaticMarkup(<FunnelQualityDetailTemplate {...templateProps(funnel)} />);
  assert.match(funnelHtml, /data-kpi-template="funnel"/);
  assert.match(funnelHtml, /Lead → Saralangan/);
  assert.match(funnelHtml, /Saralangan → SQL/);
  assert.match(funnelHtml, /SQL → Sale/);
});

test("sorted and SLA detail populations expose server-provided Deal toggles", () => {
  const sorted = fixtureKpiDetailResponse({ project: "IBOX", metric: "sorted", search: inherited });
  const sortedHtml = renderToStaticMarkup(<PopulationDetailTemplate {...templateProps(sorted)} />);
  assert.match(sortedHtml, /Saralanmagan/);
  assert.match(sortedHtml, /aria-pressed="true"/);
  const sla = fixtureKpiDetailResponse({ project: "IBOX", metric: "sla_response", search: inherited });
  const slaHtml = renderToStaticMarkup(<TimeDetailTemplate {...templateProps(sla)} />);
  assert.match(slaHtml, /SLA buzilgan/);
  assert.match(slaHtml, /Pending/);
  assert.match(slaHtml, /Unknown/);
});

test("breakdown selection updates Deal population state and resets pagination", () => {
  const next = applyDealFilterSearch(`${inherited}&page=4&q=48102`, { key: "reason", value: "__missing__", segment: "lost" });
  const params = new URLSearchParams(next);
  assert.equal(params.get("page"), "1");
  assert.equal(params.get("q"), "48102");
  assert.equal(params.get("breakdown"), "reason");
  assert.equal(params.get("breakdownValue"), "__missing__");
  assert.equal(params.get("segment"), "lost");
  const cleared = new URLSearchParams(applyDealFilterSearch(next, null));
  assert.equal(cleared.has("breakdown"), false);
  assert.equal(cleared.has("breakdownValue"), false);
});

test("ICP NOT_APPLICABLE is distinct from zero and errors never render a zero KPI", async () => {
  const fixture = new FixtureKpiDetailAdapter();
  const state = await loadKpiDetailResource(() => fixture.getDetail({ project: "SALES_DOCTOR", metric: "icp_fit", search: inherited }));
  assert.equal(state.status, "not_applicable");
  const notApplicableHtml = renderToStaticMarkup(<KpiDetailState state="not_applicable" />);
  assert.match(notApplicableHtml, /Bu workspace uchun ICP qo‘llanilmaydi/);
  assert.doesNotMatch(notApplicableHtml, />0(?:%|<)/);

  const failed = await loadKpiDetailResource(async () => { throw new Error("Server unavailable"); });
  assert.deepEqual(failed, { status: "error", message: "Server unavailable" });
  const errorHtml = renderToStaticMarkup(<KpiDetailState state="error" message="Server unavailable" onRetry={noop} />);
  assert.match(errorHtml, /Qayta urinish/);
  assert.match(errorHtml, /Server unavailable/);
  assert.doesNotMatch(errorHtml, />0(?:%|<)/);
});

test("Deal drawer shows only available fields and an optional safe Bitrix link", () => {
  const html = renderToStaticMarkup(<KpiDealDrawer deal={{ id: "48211", title: "Instagram lead", manager: "Jasur", source: "Instagram", stage: "Not Relevant", status: "Not Relevant", opportunity: null, bitrixUrl: "https://example.bitrix24.test/crm/deal/details/48211/" }} onClose={noop} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /Deal ID/);
  assert.match(html, /Bitrix’da ochish/);
  assert.doesNotMatch(html, /Opportunity/);
  const unsafe = renderToStaticMarkup(<KpiDealDrawer deal={{ id: "1", title: "Deal", bitrixUrl: "javascript:alert(1)" }} onClose={noop} />);
  assert.doesNotMatch(unsafe, /Bitrix’da ochish/);
});

test("responsive detail styles include scrolling tables, mobile cards and full-width drawer sheet", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.kpi-deal-table-wrap \{[^}]*overflow: auto/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.drawer-panel:has\(\.kpi-deal-drawer\) \{ width: 100%/);
  assert.match(css, /\.kpi-card-link:focus-visible/);
});

test("production composition imports HTTP only and templates contain no KPI arithmetic", async () => {
  const client = await readFile(new URL("../app/kpi-detail/kpi-detail-client.tsx", import.meta.url), "utf8");
  const templates = await readFile(new URL("../app/kpi-detail/kpi-detail-templates.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(client, /kpi-detail-fixtures/);
  assert.match(client, /new HttpKpiDetailAdapter\(\)/);
  assert.doesNotMatch(templates, /\* 100|\/ 100|Math\.round/);
  assert.match(dashboard, /href=\{kpiDetailHref/);
  assert.match(dashboard, /serializeDashboardFilterSearch/);
});
