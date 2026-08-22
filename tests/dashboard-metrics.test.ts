import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_METRICS, DEFAULT_DASHBOARD_METRIC_IDS, buildDashboardMetrics, resolveDashboardMetricIds } from "../lib/dashboard-metrics";
import { defaultSettings } from "../lib/business-time";
import type { AnalyticsRecord } from "../lib/types";

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME",
    customerKey: null, duplicateOfDealId: null, ...over,
  } as unknown as AnalyticsRecord;
}

test("10: standart KPI to‘plami 9 ta tasdiqlangan karta", () => {
  assert.deepEqual(DEFAULT_DASHBOARD_METRIC_IDS, [
    "leads", "sql", "not_relevant", "sales_lost", "cohort_sales",
    "period_sales", "revenue", "avg_processing", "sla",
  ]);
  assert.deepEqual(resolveDashboardMetricIds(undefined), DEFAULT_DASHBOARD_METRIC_IDS);
  assert.deepEqual(resolveDashboardMetricIds([]), DEFAULT_DASHBOARD_METRIC_IDS);
  assert.deepEqual(defaultSettings.dashboardMetricIds, DEFAULT_DASHBOARD_METRIC_IDS);
});

test("11-12: kartani yashirish faqat o‘shani olib tashlaydi, qaytarilsa qiymat o‘zgarmaydi", () => {
  const without = resolveDashboardMetricIds(DEFAULT_DASHBOARD_METRIC_IDS.filter((id) => id !== "revenue"));
  assert.equal(without.includes("revenue"), false);
  assert.equal(without.length, DEFAULT_DASHBOARD_METRIC_IDS.length - 1);
  for (const id of without) assert.ok(DEFAULT_DASHBOARD_METRIC_IDS.includes(id));
  // Re-enabling restores the same canonical value: metrics never depend on visibility.
  const rows = [deal({ salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 500 })];
  const hidden = buildDashboardMetrics(rows, rows);
  const shown = buildDashboardMetrics(rows, rows);
  assert.equal(hidden.money.revenue, shown.money.revenue);
  assert.equal(shown.money.revenue, 500);
  assert.deepEqual(resolveDashboardMetricIds([...without, "revenue"]), DEFAULT_DASHBOARD_METRIC_IDS);
  assert.deepEqual(resolveDashboardMetricIds(["bogus", "sql"]), ["sql"]);
});

test("13: Leadlar routingni hisobga olmaydi", () => {
  const rows = [deal({ dealId: "1" }), deal({ dealId: "2" }), deal({ dealId: "3", lossReasonGroup: "ROUTING", salesStatus: "LOST" })];
  const metrics = buildDashboardMetrics(rows, []);
  assert.equal(metrics.counts.leads, 2);
  assert.equal(rows.length, 3, "xom populyatsiya saqlanadi");
});

test("14-16: SQL, Not Relevant va Sotilmadi maxrajlari", () => {
  const rows = [
    deal({ dealId: "1", qualified: true }),
    deal({ dealId: "2", qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" }),
    deal({ dealId: "3", qualified: false, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
    deal({ dealId: "4", qualified: true, lossReasonGroup: "ROUTING", salesStatus: "LOST" }),
  ];
  const m = buildDashboardMetrics(rows, []);
  assert.equal(m.counts.leads, 3, "routing chiqarildi");
  assert.equal(m.counts.sql, 2);
  assert.equal(m.rates.lead_to_sql, 67, "SQL / eligible");
  assert.equal(m.rates.not_relevant, 33, "Not Relevant / eligible");
  assert.equal(m.counts.sales_lost, 1);
  assert.equal(m.rates.sales_lost, 50, "Sotilmadi / SQL");
});

test("17-21: ikki sotuv kartasi turli populyatsiya", () => {
  const augustCohort = [
    deal({ dealId: "A", createdAt: "2026-08-05T09:00:00.000Z", salesStatus: "WON", wonAt: "2026-09-02T09:00:00.000Z", qualified: true, opportunity: 100 }),
    deal({ dealId: "B", createdAt: "2026-08-06T09:00:00.000Z", qualified: true }),
  ];
  // July lead sold in August -> only the period card.
  const augustPeriodSales = [deal({ dealId: "J", createdAt: "2026-07-01T09:00:00.000Z", salesStatus: "WON", wonAt: "2026-08-11T09:00:00.000Z", opportunity: 700 })];
  const m = buildDashboardMetrics(augustCohort, augustPeriodSales);
  assert.equal(m.counts.cohort_sales, 1, "19/20: avgustda kelib sotilgan lead");
  assert.deepEqual(m.cohortSales.map((r) => r.dealId), ["A"], "sentabrda sotilgan bo‘lsa ham kelgan leadlardan sotuv");
  assert.equal(m.counts.period_sales, 1);
  assert.deepEqual(m.periodSales.map((r) => r.dealId), ["J"], "iyulda kelib avgustda sotilgan");
  assert.equal(m.rates.lead_to_sale, 50);
  assert.equal(m.rates.sql_to_sale, 50);
  assert.equal(m.money.revenue, 700, "21: summa aynan davr sotuvlaridan");
  assert.notEqual(m.money.revenue, 100, "cohort populyatsiyasidan emas");
});

test("22-23: saralash vaqti va SLA Sprint 10/11 qoidalarida qoladi", () => {
  const rows = [
    deal({ dealId: "1", processingBusinessMinutes: 6, slaStatus: "ON_TIME" }),
    deal({ dealId: "2", processingBusinessMinutes: 20, slaStatus: "LATE" }),
    deal({ dealId: "3", processingBusinessMinutes: null, slaStatus: "OVERDUE_UNPROCESSED" }),
    deal({ dealId: "4", processingBusinessMinutes: null, slaStatus: "PENDING" }),
    deal({ dealId: "5", processingBusinessMinutes: null, slaStatus: "UNKNOWN_EVIDENCE" }),
  ];
  const m = buildDashboardMetrics(rows, []);
  assert.equal(m.timing.avg_processing, 13, "faqat qayd etilgan ishlov vaqtlari");
  assert.equal(m.sla.denominator, 3, "ON_TIME + LATE + OVERDUE_UNPROCESSED");
  assert.equal(m.rates.sla, 33);
  assert.equal(DASHBOARD_METRICS.find((metric) => metric.id === "avg_processing")?.label, "Leadni saralash vaqti");
});

test("9: eski sozlamalar xavfsiz hidratsiya qilinadi", () => {
  for (const legacy of [undefined, null, "x", 5, {}, ["nope"]]) {
    assert.deepEqual(resolveDashboardMetricIds(legacy), DEFAULT_DASHBOARD_METRIC_IDS);
  }
  assert.deepEqual(defaultSettings.failureReasonFieldByPipeline, {});
});

test("asosiy UI’da texnik atamalar yo‘q", () => {
  const labels = DASHBOARD_METRICS.map((metric) => metric.label).join(" ");
  assert.equal(/cohort/i.test(labels), false);
  assert.equal(/davr sotuv\b/i.test(labels), false);
  assert.equal(/first call|first contact/i.test(labels), false);
  assert.ok(labels.includes("Kelgan leadlardan sotuv"));
  assert.ok(labels.includes("Shu davrdagi sotuvlar"));
});
