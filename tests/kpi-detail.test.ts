import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "../lib/analytics";
import { buildStatusMaps } from "../lib/analytics-dictionaries";
import type { PermissionKey } from "../lib/auth/permissions";
import { defaultSettings } from "../lib/business-time";
import type { DashboardRecord } from "../lib/dashboard-record";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import {
  buildKpiDetail, KPI_ICP_CLASSES_SQL, KPI_METRICS, KpiDetailError, kpiIcpDealIds, parseKpiParams,
  type KpiDetail, type KpiDetailOk, type KpiDetailQuery, type KpiMetric,
} from "../lib/kpi-detail";
import { MARKETING_SCHEMA_STATEMENTS } from "../lib/marketing/schema";
import { groupDealsByProject } from "../lib/project-records";
import { MISSING_LOSS_REASON } from "../lib/sales-logic";
import {
  PROJECT_KEYS, SALES_PROJECTS, seedSalesDoctorSettings, withProjectPipelines, type ProjectKey,
} from "../lib/sales-projects";
import { buildManagers, dashboardSection, parseSalesQuery, prepareSalesRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import type { DashboardSettings } from "../lib/types";

/**
 * KPI Detail parity: for the same filters, every detail population is exactly
 * the Dashboard card's population, and every breakdown row is exactly its
 * drilldown. Records are built by the real sync builder from real stage
 * dictionaries, then prepared by the Dashboard's own loader steps.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const STATUS_ROWS = [
  ["DEAL_STAGE_3", "C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10, null], ["DEAL_STAGE_3", "C3:UC_05P04E", "НЕТ ОТВЕТА", 20, null],
  ["DEAL_STAGE_3", "C3:UC_9SUEMM", "ОБРАБОТКА", 50, null], ["DEAL_STAGE_3", "C3:WON", "Оплата получена", 100, "S"],
  ["DEAL_STAGE_3", "C3:LOSE", "Сделка провалена", 110, "F"], ["DEAL_STAGE_3", "C3:UC_C0725V", "Not relevant", 120, "F"],
  ["DEAL_STAGE_3", "C3:UC_FKITQ2", "Klient lekin programma nepodxodit", 130, "F"],
  ["DEAL_STAGE_13", "C13:NEW", "Обучение", 10, null],
  ["DEAL_STAGE_5", "C5:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10, null], ["DEAL_STAGE_5", "C5:PREPARATION", "НЕ ОТВЕЧАЕТ", 20, null],
  ["DEAL_STAGE_5", "C5:PREPAYMENT_INVOICE", "ОБРАБОТКА", 30, null], ["DEAL_STAGE_5", "C5:EXECUTING", "ВСТРЕЧА НАЗНАЧЕНА", 40, null],
  ["DEAL_STAGE_5", "C5:WON", "ЕСТЬ ЗАПУСК!", 100, "S"], ["DEAL_STAGE_5", "C5:LOSE", "ЗАКРЫТО И НЕ РЕАЛИЗОВАНО", 110, "F"],
  ["DEAL_STAGE_5", "C5:UC_X51N7T", "Not Relevant (Marketing)", 120, "F"],
  ["DEAL_STAGE_17", "C17:UC_99W1TL", "Неразобранное", 10, null], ["DEAL_STAGE_17", "C17:NEW", "Mentor bricktirildi", 20, null],
].map(([entity, id, name, sort, semantics]) => ({ ENTITY_ID: entity, STATUS_ID: id, NAME: name, SORT: sort, SEMANTICS: semantics }));
const { stages, sources, stageMeta } = buildStatusMaps([
  ...STATUS_ROWS, { ENTITY_ID: "SOURCE", STATUS_ID: "WEB", NAME: "Veb-sayt" }, { ENTITY_ID: "SOURCE", STATUS_ID: "CALL", NAME: "Qo‘ng‘iroq" },
]);

const IBOX_SELLER = "4151";
const IBOX_OTHER = "223";
const SD_SELLER = "235";
const SD_SELLER_2 = "13121";
const USERS = new Map([[IBOX_SELLER, "Sanjar Juraev"], [IBOX_OTHER, "Abubakir Rahimov"], [SD_SELLER, "Abdulla Norboyev"], [SD_SELLER_2, "Behruz Abdulazizov"]]);
const REASON_FIELD = "UF_CRM_FAIL_REASON";

const IBOX_SETTINGS: DashboardSettings = withProjectPipelines({
  ...defaultSettings,
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"], paymentStageIds: ["C3:WON"],
  closedLostStageIds: ["C3:LOSE"], productFitStageIds: ["C3:UC_FKITQ2"], distributionStageIds: ["C3:NEW"],
  salesStaffIds: [IBOX_SELLER], slaMinutes: 240, failureReasonField: REASON_FIELD,
}, "IBOX");
const SD_SETTINGS: DashboardSettings = { ...withProjectPipelines(seedSalesDoctorSettings(IBOX_SETTINGS), "SALES_DOCTOR"), failureReasonField: REASON_FIELD };
const SETTINGS: Record<ProjectKey, DashboardSettings> = { IBOX: IBOX_SETTINGS, SALES_DOCTOR: SD_SETTINGS };

const DAY = "2026-09-15"; // a Tuesday
const iso = (clock: string, day = DAY) => `${day}T${clock}:00+05:00`;
const NOW = new Date("2026-09-20T12:00:00+05:00");

type DealCase = { id: string; categoryId: string; stageId: string; responsible: string; history: [string, string][]; created?: string; reason?: string; source?: string; opportunity?: number };

function buildRecords(cases: DealCase[]) {
  const deals: RawDeal[] = cases.map((c) => ({
    ID: c.id, TITLE: `Deal ${c.id}`, DATE_CREATE: c.created ?? iso("10:01"), ASSIGNED_BY_ID: c.responsible, CATEGORY_ID: c.categoryId,
    STAGE_ID: c.stageId, MOVED_TIME: c.history[c.history.length - 1]?.[1] ?? iso("10:01"), SOURCE_ID: c.source ?? "WEB",
    OPPORTUNITY: String(c.opportunity ?? 1_000_000), CURRENCY_ID: "UZS", observers: [], ...(c.reason ? { [REASON_FIELD]: c.reason } : {}),
  } as RawDeal));
  const histories: RawStageHistory[] = cases.flatMap((c) => c.history.map(([stageId, at]) => ({
    OWNER_ID: c.id, CATEGORY_ID: /^C(\d+):/.exec(stageId)![1], STAGE_ID: stageId, CREATED_TIME: at,
  } as RawStageHistory)));
  const pipelines = new Map(PROJECT_KEYS.flatMap((key) => [
    [SALES_PROJECTS[key].salesCategoryId, SALES_PROJECTS[key].salesCategoryName],
    [SALES_PROJECTS[key].postSaleCategoryId, SALES_PROJECTS[key].postSaleCategoryName],
  ] as [string, string][]));
  const records = [];
  for (const [project, group] of groupDealsByProject(deals, histories, "IBOX")) {
    records.push(...buildAnalyticsRecords({
      deals: group.deals, stageHistories: group.histories, settings: SETTINGS[project], projectKey: project,
      users: USERS, pipelines, stages, sources, stageMeta, domain: "example.bitrix24.kz", stageHistoryAvailable: true,
    }));
  }
  return records as unknown as DashboardRecord[];
}

const D = (clock: string) => iso(clock);
const IBOX_CASES: DealCase[] = [
  { id: "101", categoryId: "3", stageId: "C3:NEW", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")]] },
  { id: "102", categoryId: "3", stageId: "C3:UC_9SUEMM", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_9SUEMM", D("10:40")]], source: "CALL" },
  { id: "103", categoryId: "3", stageId: "C3:WON", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_9SUEMM", D("11:00")], ["C3:WON", D("15:00")]], opportunity: 2_500_000 },
  { id: "104", categoryId: "3", stageId: "C3:LOSE", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_9SUEMM", D("12:00")], ["C3:LOSE", D("16:00")]], reason: "Narx" },
  { id: "105", categoryId: "3", stageId: "C3:LOSE", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_9SUEMM", D("12:30")], ["C3:LOSE", D("16:30")]] },
  { id: "106", categoryId: "3", stageId: "C3:UC_C0725V", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_C0725V", D("13:00")]], reason: "Spam" },
  { id: "107", categoryId: "3", stageId: "C3:UC_C0725V", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_C0725V", D("13:30")]] },
  { id: "108", categoryId: "3", stageId: "C3:UC_FKITQ2", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")], ["C3:UC_FKITQ2", D("14:00")]] },
  { id: "109", categoryId: "3", stageId: "C3:UC_9SUEMM", responsible: IBOX_OTHER, history: [["C3:NEW", D("10:05")], ["C3:UC_9SUEMM", D("11:30")]] },
  // Created two weeks earlier, sold inside the window: a period sale, not a cohort sale.
  { id: "110", categoryId: "3", stageId: "C3:WON", responsible: IBOX_SELLER, created: iso("09:00", "2026-09-01"),
    history: [["C3:NEW", iso("09:05", "2026-09-01")], ["C3:UC_9SUEMM", iso("12:00", "2026-09-02")], ["C3:WON", D("17:00")]], opportunity: 400_000 },
  // A Sales Doctor Deal in the same portal must never reach IBOX.
  { id: "190", categoryId: "5", stageId: "C5:NEW", responsible: SD_SELLER, history: [["C5:NEW", D("10:05")]] },
];
const SD_CASES: DealCase[] = [
  { id: "201", categoryId: "5", stageId: "C5:NEW", responsible: SD_SELLER, history: [["C5:NEW", D("10:05")]] },
  { id: "202", categoryId: "5", stageId: "C5:PREPARATION", responsible: SD_SELLER, history: [["C5:NEW", D("10:05")], ["C5:PREPARATION", D("10:30")]] },
  { id: "203", categoryId: "5", stageId: "C5:PREPAYMENT_INVOICE", responsible: SD_SELLER, history: [["C5:NEW", D("10:05")], ["C5:PREPAYMENT_INVOICE", D("11:00")]] },
  { id: "204", categoryId: "5", stageId: "C5:WON", responsible: SD_SELLER_2, history: [["C5:NEW", D("10:05")], ["C5:PREPAYMENT_INVOICE", D("11:00")], ["C5:WON", D("16:00")]] },
  { id: "205", categoryId: "5", stageId: "C5:LOSE", responsible: SD_SELLER_2, history: [["C5:NEW", D("10:05")], ["C5:PREPAYMENT_INVOICE", D("11:30")], ["C5:LOSE", D("15:00")]], reason: "Qimmat" },
  { id: "206", categoryId: "5", stageId: "C5:UC_X51N7T", responsible: SD_SELLER, history: [["C5:NEW", D("10:05")], ["C5:UC_X51N7T", D("12:00")]] },
  { id: "207", categoryId: "5", stageId: "C5:EXECUTING", responsible: SD_SELLER_2, history: [["C5:NEW", D("10:05")], ["C5:PREPAYMENT_INVOICE", D("10:50")], ["C5:EXECUTING", D("14:00")]] },
];

const ALL = buildRecords([...IBOX_CASES, ...SD_CASES]);
const prepared = (project: ProjectKey, rows = ALL) => prepareSalesRecords(rows, SETTINGS[project], NOW, project);

const allow = (...denied: PermissionKey[]) => (permission: PermissionKey) => !denied.includes(permission);
const sales = (over: Partial<SalesQuery> = {}): SalesQuery => ({ from: DAY, to: DAY, managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "", ...over });
const query = (metric: KpiMetric, over: Partial<KpiDetailQuery> = {}): KpiDetailQuery => ({
  ...sales(), metric, preset: "custom", segment: "", dimension: "", value: "", page: 1, pageSize: 100, ...over,
});
const detail = (project: ProjectKey, metric: KpiMetric, over: Partial<KpiDetailQuery> = {}, can = allow(), icpClasses?: Map<string, string>) =>
  buildKpiDetail(prepared(project), query(metric, over), { project, can, settings: SETTINGS[project], icpClasses });
const ok = (value: KpiDetail): KpiDetailOk => { assert.equal(value.status, "OK"); return value as KpiDetailOk; };
const ids = (value: KpiDetail) => ok(value).deals.rows.map((row) => row.dealId).sort();
const section = (project: ProjectKey, over: Partial<SalesQuery> = {}) =>
  dashboardSection(prepared(project), sales(over), { can: allow(), settings: SETTINGS[project], dataAsOf: null });
const canonical = (project: ProjectKey, over: Partial<SalesQuery> = {}) => {
  const pop = salesPopulations(prepared(project), sales(over));
  return buildDashboardMetrics(pop.cohort, pop.won);
};
const dealIds = (rows: { dealId: string }[]) => rows.map((row) => row.dealId).sort();

/* --------------------------------------------------------- count parity */

const COUNT_PARITY: [KpiMetric, keyof ReturnType<typeof buildDashboardMetrics>["counts"], keyof Pick<ReturnType<typeof buildDashboardMetrics>, "eligible" | "classified" | "sql" | "notRelevant" | "salesLost" | "cohortSales" | "periodSales" | "active">][] = [
  ["leads", "leads", "eligible"], ["sorted", "classified_leads", "classified"], ["sql", "sql", "sql"],
  ["not_relevant", "not_relevant", "notRelevant"], ["lost", "sales_lost", "salesLost"], ["cohort_sales", "cohort_sales", "cohortSales"],
  ["period_sales", "period_sales", "periodSales"], ["active_leads", "active_cohort", "active"],
];

for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
  test(`${project}: every count KPI's detail is exactly the Dashboard card's population`, () => {
    const card = section(project).metrics.counts;
    const m = canonical(project);
    for (const [metric, cardKey, arrayKey] of COUNT_PARITY) {
      const value = ok(detail(project, metric));
      assert.equal(value.hero.value, card[cardKey], `${metric} hero = card`);
      assert.equal(value.deals.total, card[cardKey], `${metric} Deal total = card`);
      assert.deepEqual(ids(value), dealIds(m[arrayKey]), `${metric} Deals = the card's own Deals`);
    }
  });
}

test("IBOX fixture covers every population with real, distinct Deals", () => {
  const c = section("IBOX").metrics.counts;
  assert.deepEqual(
    { leads: c.leads, sorted: c.classified_leads, sql: c.sql, nr: c.not_relevant, lost: c.sales_lost, cohort: c.cohort_sales, period: c.period_sales, active: c.active_cohort },
    { leads: 9, sorted: 7, sql: 5, nr: 2, lost: 2, cohort: 1, period: 2, active: 4 },
  );
  assert.deepEqual(ids(detail("IBOX", "period_sales")), ["103", "110"], "the earlier-created sale is a period sale");
  assert.deepEqual(ids(detail("IBOX", "cohort_sales")), ["103"]);
  assert.ok(!ids(detail("IBOX", "leads")).includes("190"), "a Sales Doctor Deal never reaches IBOX");
});

test("SD fixture: Saralangan, SQL, NR, Lost and Cohort Sale follow Sales Doctor's own stage rules", () => {
  const c = section("SALES_DOCTOR").metrics.counts;
  assert.deepEqual(
    { leads: c.leads, sorted: c.classified_leads, sql: c.sql, nr: c.not_relevant, lost: c.sales_lost, cohort: c.cohort_sales },
    { leads: 8, sorted: 5, sql: 4, nr: 1, lost: 1, cohort: 1 },
  );
  assert.ok(ids(detail("SALES_DOCTOR", "leads")).includes("190"), "the category-5 Deal is Sales Doctor's");
  assert.deepEqual(ids(detail("SALES_DOCTOR", "sorted", { segment: "unsorted" })), ["190", "201", "202"]);
});

test("rates and denominators are the card's own, and say what they divide", () => {
  for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
    const { counts, rates } = section(project).metrics;
    const hero = (metric: KpiMetric) => ok(detail(project, metric)).hero;
    assert.deepEqual([hero("sorted").denominatorValue, hero("sorted").rate, hero("sorted").rateLabel], [counts.leads, rates.classification_coverage, "Saralangan / Lead"]);
    assert.deepEqual([hero("sql").denominatorValue, hero("sql").rate, hero("sql").rateLabel], [counts.classified_leads, rates.quality_accepted_rate, "Saralangan → SQL"]);
    assert.deepEqual([hero("not_relevant").denominatorValue, hero("not_relevant").rate], [counts.classified_leads, rates.low_quality_rate]);
    assert.deepEqual([hero("lost").denominatorValue, hero("lost").rate, hero("lost").rateLabel], [counts.sql, rates.sales_lost, "SQL → Sotilmadi"]);
    assert.deepEqual([hero("cohort_sales").denominatorValue, hero("cohort_sales").rate, hero("cohort_sales").rateLabel], [counts.sql, rates.sql_to_sale, "SQL → Sotuv"]);
    assert.equal(hero("funnel_conversion").value, rates.lead_to_sql, "funnel card value is Lead → SQL");
  }
});

test("Saralangan shows both halves and the current stages composing each", () => {
  const value = ok(detail("IBOX", "sorted"));
  const summary = Object.fromEntries(value.summary.map((item) => [item.key, item.value]));
  assert.equal(summary.leads, Number(summary.sorted) + Number(summary.unsorted));
  const sortedStages = value.breakdowns.find((entry) => entry.key === "sorted:stage")!;
  const unsortedStages = value.breakdowns.find((entry) => entry.key === "unsorted:stage")!;
  assert.equal(sortedStages.total, summary.sorted);
  assert.equal(unsortedStages.total, summary.unsorted);
  assert.equal(sortedStages.rows.reduce((sum, row) => sum + row.count, 0), summary.sorted);
  for (const row of unsortedStages.rows) {
    const drilled = ok(detail("IBOX", "sorted", row.drilldown));
    assert.equal(drilled.deals.total, row.count, row.label);
    assert.ok(drilled.deals.rows.every((deal) => deal.stageName === row.key));
  }
});

/* ---------------------------------------------------------- non-counts */

test("time and money KPIs: the hero is the card's figure, the Deal list is the population it averages", () => {
  for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
    const m = canonical(project);
    const check = ok(detail(project, "average_check"));
    assert.equal(check.hero.value, m.money.avg_check);
    assert.equal(check.deals.total, m.counts.period_sales);
    const median = check.summary.find((item) => item.key === "median_check")!;
    assert.equal(median.value, m.money.median_check);

    for (const [metric, cardValue] of [
      ["sales_cycle", m.timing.sales_cycle], ["sorting_time", m.timing.avg_processing],
      ["sla_response", m.timing.sla_avg], ["calendar_response", m.timing.sla_elapsed_avg],
    ] as [KpiMetric, number | null][]) {
      const value = ok(detail(project, metric));
      assert.equal(value.hero.value, cardValue, `${project} ${metric} hero`);
      const values = value.deals.rows.map((row) => row.metricValue);
      assert.ok(values.every((entry) => typeof entry === "number"), `${metric}: only measured Deals are listed`);
      const mean = values.length ? (values as number[]).reduce((sum, entry) => sum + entry, 0) / values.length : null;
      assert.equal(mean === null ? null : Math.round(mean * 1e6), cardValue === null ? null : Math.round(cardValue * 1e6), `${metric}: the listed Deals reproduce the figure`);
      assert.equal(value.hero.denominatorValue, value.deals.total);
      // The distribution covers the same population.
      assert.equal(value.distribution!.rows.reduce((sum, row) => sum + row.count, 0), value.deals.total, `${metric} buckets`);
    }
  }
});

test("SLA: completed population for the average, rate over its own denominator, pending and unknown apart", () => {
  const m = canonical("IBOX");
  const value = ok(detail("IBOX", "sla_response"));
  const summary = Object.fromEntries(value.summary.map((item) => [item.key, item.value]));
  assert.equal(summary.included, m.timing.sla_completed);
  assert.deepEqual([summary.on_time, summary.late, summary.overdue, summary.pending, summary.unknown, summary.sla_denominator, summary.sla_rate],
    [m.sla.onTime, m.sla.late, m.sla.overdue, m.sla.pending, m.sla.unknown, m.sla.denominator, m.rates.sla]);
  assert.equal(value.hero.rate, m.rates.sla);
  const states = value.breakdowns.find((entry) => entry.dimension === "sla_status")!;
  assert.equal(states.total, m.counts.leads);
  for (const row of states.rows) assert.equal(ok(detail("IBOX", "sla_response", row.drilldown)).deals.total, row.count);
  // Calendar time is the same event's wall-clock span, never the SLA's working minutes.
  const calendar = ok(detail("IBOX", "calendar_response"));
  assert.ok(calendar.deals.rows.every((row) => row.metricFormat === "duration_minutes"));
  assert.notEqual(calendar.definition, value.definition);
});

test("funnel: four exact steps with explicit denominators, each step listing its own Deals", () => {
  for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
    const { counts, rates } = canonical(project);
    const value = ok(detail(project, "funnel_conversion"));
    assert.deepEqual(value.funnel!.map((step) => [step.key, step.count, step.rateFromPrevious ?? null, step.rateLabel ?? null]), [
      ["lead", counts.leads, null, null],
      ["sorted", counts.classified_leads, rates.classification_coverage, "Saralangan / Lead"],
      ["sql", counts.sql, rates.quality_accepted_rate, "SQL / Saralangan"],
      ["sale", counts.cohort_sales, rates.sql_to_sale, "Sotuv / SQL"],
    ]);
    for (const step of value.funnel!) assert.equal(ok(detail(project, "funnel_conversion", step.drilldown)).deals.total, step.count, `${project} ${step.key}`);
    // Manager comparison: the Managers table's own rows and rates.
    const pop = salesPopulations(prepared(project), sales());
    const managers = buildManagers(pop.cohort, pop.won, new Set(SETTINGS[project].salesStaffIds));
    const comparison = value.breakdowns.find((entry) => entry.key === "lead:owner")!;
    for (const row of comparison.rows) {
      const manager = managers.find((entry) => entry.id === row.key)!;
      const cell = (key: string) => row.cells!.find((entry) => entry.key === key)!.value;
      assert.deepEqual([row.count, cell("sorted_rate"), cell("sql_rate"), cell("sale_rate")], [manager.leads, manager.classificationCoverage, manager.qualityAcceptedRate, manager.sqlToSale]);
      assert.equal(ok(detail(project, "funnel_conversion", { segment: "lead", dimension: "owner", value: row.key })).deals.total, row.count);
    }
  }
});

/* ------------------------------------------------------------ drilldown */

test("manager drilldown: every row produces exactly its Deals, rows sum to the KPI, and match the Managers table", () => {
  for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
    const pop = salesPopulations(prepared(project), sales());
    const managers = buildManagers(pop.cohort, pop.won, new Set(SETTINGS[project].salesStaffIds));
    for (const [metric, field] of [["sql", "sql"], ["leads", "leads"], ["lost", "salesLost"], ["period_sales", "periodSales"], ["not_relevant", "notRelevant"]] as const) {
      const value = ok(detail(project, metric));
      const owners = value.breakdowns.find((entry) => entry.dimension === "owner")!;
      assert.equal(owners.rows.reduce((sum, row) => sum + row.count, 0), value.hero.value, `${project} ${metric} rows sum to the KPI`);
      for (const row of owners.rows) {
        const drilled = ok(detail(project, metric, row.drilldown));
        assert.equal(drilled.deals.total, row.count, `${project} ${metric} ${row.label}`);
        assert.ok(drilled.deals.rows.every((deal) => deal.managerId === row.key));
        assert.equal(managers.find((entry) => entry.id === row.key)?.[field], row.count, `${metric} ${row.label} = Managers table`);
      }
    }
  }
});

test("reason drilldown: Lost and NR reasons are diagnostic labels; a missing one is 'Sabab ko‘rsatilmagan'", () => {
  const lost = ok(detail("IBOX", "lost"));
  const reasons = lost.breakdowns.find((entry) => entry.dimension === "reason")!;
  assert.deepEqual(reasons.rows.map((row) => [row.label, row.count]).sort(), [["Narx", 1], [MISSING_LOSS_REASON, 1]]);
  assert.deepEqual(ids(detail("IBOX", "lost", { dimension: "reason", value: "Narx" })), ["104"]);
  assert.deepEqual(ids(detail("IBOX", "lost", { dimension: "reason", value: MISSING_LOSS_REASON })), ["105"]);
  assert.equal(lost.summary.find((item) => item.key === "missing_reason")!.value, 1);
  const nr = ok(detail("IBOX", "not_relevant"));
  assert.deepEqual(nr.breakdowns.find((entry) => entry.dimension === "reason")!.rows.map((row) => row.label).sort(), [MISSING_LOSS_REASON, "Spam"].sort());
  assert.ok(nr.deals.rows.every((row) => typeof row.lossReason === "string" && row.lossReason.length > 0));
  // The reason never decides membership: NR is the card's population whatever the reasons say.
  assert.equal(nr.deals.total, section("IBOX").metrics.counts.not_relevant);
  // An unknown reason value is an empty drilldown, not an error and not a guess.
  assert.equal(ok(detail("IBOX", "lost", { dimension: "reason", value: "Hech qachon" })).deals.total, 0);
});

test("every breakdown row of every metric drills down to exactly its count", () => {
  const icp = new Map([["102", "P1"], ["103", "OTHER"]]);
  for (const project of ["IBOX", "SALES_DOCTOR"] as const) {
    for (const metric of KPI_METRICS) {
      const value = detail(project, metric, {}, allow(), icp);
      if (value.status !== "OK") continue;
      for (const breakdown of [...value.breakdowns, ...(value.distribution ? [value.distribution] : [])]) {
        assert.equal(breakdown.rows.reduce((sum, row) => sum + row.count, 0), breakdown.total, `${project} ${metric} ${breakdown.key} sums`);
        for (const row of breakdown.rows) {
          assert.equal(ok(detail(project, metric, row.drilldown, allow(), icp)).deals.total, row.count, `${project} ${metric} ${breakdown.key} ${row.label}`);
        }
      }
    }
  }
});

/* ---------------------------------------------------- filters, paging */

test("filter preservation: manager, source, pipeline and search narrow the detail exactly as the Dashboard", () => {
  const cases: Partial<SalesQuery>[] = [{ managers: [IBOX_OTHER] }, { sources: ["Qo‘ng‘iroq"] }, { search: "104" }, { pipeline: SALES_PROJECTS.IBOX.salesCategoryName }];
  for (const filter of cases) {
    const card = section("IBOX", filter).metrics.counts;
    for (const [metric, cardKey] of COUNT_PARITY) assert.equal(ok(detail("IBOX", metric, filter)).deals.total, card[cardKey], `${JSON.stringify(filter)} ${metric}`);
  }
  const echoed = ok(detail("IBOX", "sql", { managers: [IBOX_OTHER], sources: ["Veb-sayt"] }));
  assert.deepEqual([echoed.appliedFilters.managers, echoed.appliedFilters.sources], [[IBOX_OTHER], ["Veb-sayt"]]);
  assert.deepEqual(echoed.period, { from: DAY, to: DAY, preset: "custom" });
  // The Dashboard's own parser reads the filters; the KPI parser only adds its own keys.
  const params = new URLSearchParams("metric=sql&from=2026-09-15&to=2026-09-15&manager=223&source=WEB&preset=custom");
  const parsed = parseSalesQuery(params);
  assert.ok(parsed.ok && parsed.query.managers[0] === "223" && parsed.query.sources[0] === "WEB");
  assert.deepEqual(parseKpiParams(params), { ok: true, params: { metric: "sql", preset: "custom", segment: "", dimension: "", value: "", page: 1, pageSize: 50 } });
});

test("pagination: 50 rows by default, 25/50/100 allowed, breakdowns describe the whole population", () => {
  const many = buildRecords(Array.from({ length: 120 }, (_, index) => ({
    id: String(5000 + index), categoryId: "3", stageId: "C3:NEW", responsible: IBOX_SELLER, history: [["C3:NEW", D("10:05")]] as [string, string][],
  })));
  const run = (over: Partial<KpiDetailQuery>) => ok(buildKpiDetail(prepared("IBOX", many), query("leads", { pageSize: 50, ...over }), { project: "IBOX", can: allow(), settings: IBOX_SETTINGS }));
  const first = run({});
  assert.deepEqual([first.deals.total, first.deals.page, first.deals.pageSize, first.deals.totalPages, first.deals.rows.length], [120, 1, 50, 3, 50]);
  const last = run({ page: 3 });
  assert.equal(last.deals.rows.length, 20);
  assert.equal(new Set([...first.deals.rows, ...run({ page: 2 }).deals.rows, ...last.deals.rows].map((row) => row.dealId)).size, 120, "pages never overlap");
  assert.equal(run({ page: 9 }).deals.page, 3, "a page past the end is the last page");
  assert.equal(run({ pageSize: 25 }).deals.rows.length, 25);
  assert.equal(run({ pageSize: 100, page: 2 }).deals.rows.length, 20);
  for (const breakdown of last.breakdowns) assert.equal(breakdown.total, 120, `${breakdown.key} is not the page`);
  assert.deepEqual(parseKpiParams(new URLSearchParams("metric=leads&pageSize=30")), { ok: false, error: "Sahifa hajmi 25, 50 yoki 100" });
  assert.equal(parseKpiParams(new URLSearchParams("metric=leads&page=0")).ok, false);
});

test("empty population: zero counts are real, averages are null, nothing is invented", () => {
  const empty = { from: "2026-01-01", to: "2026-01-01" };
  for (const metric of KPI_METRICS) {
    const value = detail("IBOX", metric, empty, allow(), new Map());
    assert.equal(value.status, "OK", metric);
    const okValue = value as KpiDetailOk;
    assert.equal(okValue.deals.total, 0, metric);
    assert.deepEqual(okValue.deals.rows, []);
    if (["average_check", "sales_cycle", "sla_response", "calendar_response", "sorting_time"].includes(metric)) assert.equal(okValue.hero.value, null, `${metric} has no average`);
    for (const breakdown of okValue.breakdowns) assert.deepEqual(breakdown.rows, [], `${metric} ${breakdown.key}`);
  }
  assert.equal(ok(detail("IBOX", "icp_fit", empty, allow(), new Map())).hero.rate, null, "no evaluated Lead → no fit rate");
});

/* ------------------------------------------------------------------ ICP */

test("ICP (IBOX_UZ): fit / not fit / unset over the Lead population, unset outside the denominator", () => {
  const classes = new Map([["102", "P1"], ["103", "P3"], ["104", "OTHER"], ["109", "UNSET"]]);
  const value = ok(detail("IBOX", "icp_fit", {}, allow(), classes));
  const summary = Object.fromEntries(value.summary.map((item) => [item.key, item.value]));
  const leads = section("IBOX").metrics.counts.leads;
  assert.deepEqual([summary.fit, summary.not_fit, summary.evaluated, summary.unset, summary.fit_rate], [2, 1, 3, leads - 3, 67]);
  assert.equal(summary.not_attributed, leads - 4, "Deals with no attribution row yet are counted, inside Unset");
  assert.deepEqual([value.hero.value, value.hero.denominatorValue, value.hero.rate], [2, 3, 67]);
  assert.deepEqual(ids(detail("IBOX", "icp_fit", {}, allow(), classes)), ["102", "103"]);
  assert.deepEqual(ids(detail("IBOX", "icp_fit", { segment: "not_fit" }, allow(), classes)), ["104"]);
  assert.equal(ok(detail("IBOX", "icp_fit", { segment: "lead" }, allow(), classes)).deals.total, leads);
  const tiers = value.breakdowns.find((entry) => entry.dimension === "icp")!;
  assert.deepEqual(tiers.rows.map((row) => [row.key, row.count]), [["P1", 1], ["P3", 1], ["OTHER", 1], ["UNSET", leads - 3]]);
  // The route reads classes for exactly the Lead population.
  assert.deepEqual(kpiIcpDealIds(prepared("IBOX"), sales()).sort(), dealIds(canonical("IBOX").eligible));
});

test("ICP (Sales Doctor): NOT_APPLICABLE — no zero, no rate, no Deals", () => {
  const value = detail("SALES_DOCTOR", "icp_fit", {}, allow(), new Map([["203", "P1"]]));
  assert.equal(value.status, "NOT_APPLICABLE");
  assert.equal(value.hero, null);
  assert.equal(value.deals, null);
  assert.equal(value.workspace, "SD_UZ");
});

test("the ICP read is one bound JSON array against Marketing's own table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(MARKETING_SCHEMA_STATEMENTS.join(";\n"));
  const insert = db.prepare("INSERT INTO marketing_deal_attribution (deal_id, workspace_key, channel, attribution_source, icp_class, lead_created_at, bitrix_evidence_json, created_at, updated_at) VALUES (?, 'IBOX_UZ', 'UNKNOWN', 'NONE', ?, 't', '{}', 't', 't')");
  insert.run("102", "P1"); insert.run("104", "OTHER"); insert.run("999", "P2");
  const rows = db.prepare(KPI_ICP_CLASSES_SQL).all(JSON.stringify(["102", "104", "105"])).map((row) => ({ ...row }));
  assert.deepEqual(rows.sort((a, b) => String(a.deal_id).localeCompare(String(b.deal_id))), [{ deal_id: "102", icp_class: "P1" }, { deal_id: "104", icp_class: "OTHER" }]);
  assert.doesNotMatch(KPI_ICP_CLASSES_SQL, /\b(INSERT|UPDATE|DELETE)\b/i);
});

/* --------------------------------------------------- permissions, errors */

test("no data the caller could not already see: Deal rows need `deals`, manager rows need `managers`", () => {
  const noDeals = ok(detail("IBOX", "sql", {}, allow("deals")));
  assert.equal(noDeals.deals.total, section("IBOX").metrics.counts.sql);
  assert.deepEqual(noDeals.deals.rows, []);
  assert.equal(noDeals.deals.restricted, true);
  const noManagers = ok(detail("IBOX", "sql", {}, allow("managers")));
  assert.equal(noManagers.breakdowns.some((entry) => entry.dimension === "owner"), false);
  assert.deepEqual(noManagers.restricted, ["owner"]);
  assert.throws(() => detail("IBOX", "sql", { dimension: "owner", value: IBOX_SELLER }, allow("managers")), KpiDetailError);
  assert.equal(ok(detail("IBOX", "funnel_conversion", {}, allow("managers"))).breakdowns.length, 0);
});

test("bad parameters are refused, never answered with a guess", () => {
  assert.deepEqual(parseKpiParams(new URLSearchParams("metric=revenue")), { ok: false, error: "KPI noma’lum" });
  assert.equal(parseKpiParams(new URLSearchParams("metric=sql&dimension=owner")).ok, false, "dimension needs a value");
  assert.equal(parseKpiParams(new URLSearchParams("metric=sql&dimension=colour&value=x")).ok, false);
  assert.equal(parseKpiParams(new URLSearchParams("metric=sql&preset=decade")).ok, false);
  assert.throws(() => detail("IBOX", "sql", { segment: "nope" }), KpiDetailError);
  assert.throws(() => detail("IBOX", "sql", { dimension: "sale_day", value: DAY }), KpiDetailError, "a dimension the metric does not offer");
  assert.throws(() => detail("IBOX", "leads", { dimension: "bucket", value: "b0" }), KpiDetailError);
});

test("the routes are guarded by `dashboard` and filter exactly like the Dashboard section", () => {
  for (const path of ["app/api/kpi-detail/route.ts", "app/api/kpi-detail/deals/route.ts"]) {
    const source = read(path);
    assert.ok(source.indexOf('requirePermission(request, "dashboard")') > 0 && source.indexOf('requirePermission(request, "dashboard")') < source.indexOf("kpiDetailResponse(request"), path);
  }
  const handler = read("lib/kpi-detail-http.ts");
  for (const step of ["requestProject(request)", "parseSalesQuery(params)", "parseKpiParams(params)", "filterPermissionError(parsed.query, can)", "await loadSalesRecords(", "isSalesReady("]) {
    assert.ok(handler.includes(step), step);
  }
  assert.ok(handler.indexOf("filterPermissionError(") < handler.indexOf("await loadSalesRecords("), "filters are refused before anything is read");
  // No formula in the KPI module: it reads the card's metrics object.
  const module = read("lib/kpi-detail.ts");
  assert.match(module, /const m = buildDashboardMetrics\(pop\.cohort, pop\.won\);/);
  assert.match(module, /const pop = salesPopulations\(records, query\);/);
  assert.doesNotMatch(module, /lossReasonGroup === "MARKETING"|isEligibleCohortDeal|isSalesLost|salesStatus === "WON"/, "no KPI membership rule is re-implemented");
});
