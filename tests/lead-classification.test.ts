import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardMetrics, resolveDashboardMetric, resolveDashboardMetricIds, DASHBOARD_METRICS } from "../lib/dashboard-metrics";
import {
  countClassificationConflicts, isClassifiedLead, isEligibleCohortDeal, isUnclassifiedLead,
} from "../lib/sales-logic";
import type { AnalyticsRecord } from "../lib/types";

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME",
    stage: "Распределение", currentScope: null,
    customerKey: null, duplicateOfDealId: null, ...over,
  } as unknown as AnalyticsRecord;
}

/**
 * The 17 fixtures the sprint brief enumerates, one per row, so every population
 * below is asserted against a named business situation rather than a synthetic
 * shape. `expected` is the quality verdict each row must land on.
 */
const FIXTURES: { name: string; row: AnalyticsRecord; expected: "SIFATLI" | "SIFATSIZ" | "SARALANMAGAN" | "ROUTING" }[] = [
  { name: "1 NEW / Распределение", row: deal({ dealId: "f1", stage: "Распределение" }), expected: "SARALANMAGAN" },
  { name: "2 Нет ответа", row: deal({ dealId: "f2", stage: "Нет ответа" }), expected: "SARALANMAGAN" },
  { name: "3 Первое касание", row: deal({ dealId: "f3", stage: "Первое касаниe" }), expected: "SARALANMAGAN" },
  { name: "4 SQL", row: deal({ dealId: "f4", stage: "Обработка", qualified: true }), expected: "SIFATLI" },
  { name: "5 downstream meeting", row: deal({ dealId: "f5", stage: "Встреча", qualified: true }), expected: "SIFATLI" },
  { name: "6 Not Relevant", row: deal({ dealId: "f6", stage: "Not Relevant", salesStatus: "LOW_QUALITY", qualified: false, lossReasonGroup: "MARKETING" }), expected: "SIFATSIZ" },
  { name: "7 Sales Lost", row: deal({ dealId: "f7", stage: "Закрыто не реализовано", salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES" }), expected: "SIFATLI" },
  { name: "8 WON in payment", row: deal({ dealId: "f8", stage: "Оплата получена", salesStatus: "WON", qualified: true, wonAt: "2026-08-10T09:00:00.000Z", opportunity: 500 }), expected: "SIFATLI" },
  { name: "9 WON moved to post-sale", row: deal({ dealId: "f9", stage: "Внедрение", salesStatus: "WON", qualified: true, wonAt: "2026-08-11T09:00:00.000Z", opportunity: 700 }), expected: "SIFATLI" },
  { name: "10 routed lead", row: deal({ dealId: "f10", salesStatus: "LOST", lossReasonGroup: "ROUTING" }), expected: "ROUTING" },
  { name: "11 duplicate lead", row: deal({ dealId: "f11", customerKey: "c1", duplicateOfDealId: "f4", qualified: true }), expected: "SIFATLI" },
  { name: "12 deleted / UNAVAILABLE", row: deal({ dealId: "f12", qualified: true, currentScope: "UNAVAILABLE" }), expected: "SIFATLI" },
  { name: "13 OUT_OF_SCOPE", row: deal({ dealId: "f13", qualified: true, currentScope: "OUT_OF_SCOPE" }), expected: "SIFATLI" },
  { name: "14 Not Relevant after previous SQL", row: deal({ dealId: "f14", stage: "Not Relevant", salesStatus: "LOW_QUALITY", qualified: false, lossReasonGroup: "MARKETING" }), expected: "SIFATSIZ" },
  { name: "15 WON, incomplete SQL history", row: deal({ dealId: "f15", salesStatus: "WON", qualified: true, wonAt: "2026-08-12T09:00:00.000Z", opportunity: 300, processingBusinessMinutes: null }), expected: "SIFATLI" },
  { name: "16 LOST, incomplete SQL history", row: deal({ dealId: "f16", salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", processingBusinessMinutes: null }), expected: "SIFATLI" },
  { name: "17 processing unknown, quality known", row: deal({ dealId: "f17", qualified: true, processingBusinessMinutes: null, slaStatus: "UNKNOWN_EVIDENCE" }), expected: "SIFATLI" },
];

test("24: har bir fixture kutilgan sifat populyatsiyasiga tushadi", () => {
  for (const { name, row, expected } of FIXTURES) {
    const eligible = isEligibleCohortDeal(row);
    if (expected === "ROUTING") {
      assert.equal(eligible, false, `${name}: routing Leadlardan chiqarilishi kerak`);
      continue;
    }
    assert.equal(eligible, true, `${name}: eligible bo‘lishi kerak`);
    const classified = isClassifiedLead(row);
    assert.equal(classified, expected !== "SARALANMAGAN", `${name}: saralanganlik noto‘g‘ri`);
    assert.equal(isUnclassifiedLead(row), !classified, `${name}: ikkala helper qarama-qarshi`);
    if (expected === "SIFATLI") assert.equal(row.qualified, true, `${name}: sifatli = qualified`);
    if (expected === "SIFATSIZ") {
      assert.equal(row.lossReasonGroup, "MARKETING", `${name}: sifatsiz = MARKETING`);
      assert.equal(row.qualified, false, `${name}: sifatsiz bir vaqtda sifatli bo‘lolmaydi`);
    }
  }
});

test("23: Leadlar = Saralangan + Saralanmagan, Saralangan = Sifatli + Sifatsiz", () => {
  const rows = FIXTURES.map((fixture) => fixture.row);
  const metrics = buildDashboardMetrics(rows, []);
  const { leads, classified_leads, unclassified_leads, sql, not_relevant } = metrics.counts;
  assert.equal(leads, classified_leads + unclassified_leads, "Leadlar tenglamasi");
  assert.equal(classified_leads, sql + not_relevant, "Saralangan tenglamasi");
  assert.equal(metrics.classificationConflicts, 0, "kanonik yozuvlarda ziddiyat bo‘lmaydi");
  // 17 fixtures, one of which is routing.
  assert.equal(rows.length, 17);
  assert.equal(leads, 16);
  assert.equal(unclassified_leads, 3, "Распределение, Нет ответа, Первое касание");
  assert.equal(classified_leads, 13);
  assert.equal(sql, 11);
  assert.equal(not_relevant, 2);
});

test("23: xom cohort = eligible + routing", () => {
  const rows = FIXTURES.map((fixture) => fixture.row);
  const routing = rows.filter((row) => !isEligibleCohortDeal(row));
  const eligible = rows.filter(isEligibleCohortDeal);
  assert.equal(rows.length, eligible.length + routing.length);
  assert.equal(routing.length, 1);
});

test("4-5: sifat va funnel foizlari boshqa maxrajdan hisoblanadi", () => {
  // 100 leads: 30 SQL, 10 Not Relevant, 60 still undecided.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => deal({ dealId: `s${i}`, qualified: true, stage: "Обработка" })),
    ...Array.from({ length: 10 }, (_, i) => deal({ dealId: `n${i}`, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", stage: "Not Relevant" })),
    ...Array.from({ length: 60 }, (_, i) => deal({ dealId: `u${i}`, stage: "Нет ответа" })),
  ];
  const metrics = buildDashboardMetrics(rows, []);
  assert.equal(metrics.counts.leads, 100);
  assert.equal(metrics.counts.classified_leads, 40);
  assert.equal(metrics.counts.unclassified_leads, 60);
  // Quality: judged population only.
  assert.equal(metrics.rates.quality_accepted_rate, 75, "Sifatli = 30 / 40");
  assert.equal(metrics.rates.low_quality_rate, 25, "Sifatsiz = 10 / 40");
  assert.equal(metrics.rates.classification_coverage, 40, "Qamrov = 40 / 100");
  // Funnel: every incoming lead.
  assert.equal(metrics.rates.lead_to_sql, 30, "Lead → SQL = 30 / 100");
  assert.equal(metrics.rates.not_relevant_of_leads, 10, "Not Relevant / Leadlar = 10 / 100");
  // The two must not be the same number, which is the whole point of the split.
  assert.notEqual(metrics.rates.quality_accepted_rate, metrics.rates.lead_to_sql);
  assert.notEqual(metrics.rates.low_quality_rate, metrics.rates.not_relevant_of_leads);
});

test("5-6: funnel maxraji Leadlar bo‘lib qoladi, SQL → Sotuv esa SQL", () => {
  const won = deal({ dealId: "w", salesStatus: "WON", qualified: true, wonAt: "2026-08-10T09:00:00.000Z", opportunity: 100, stage: "Оплата получена" });
  const rows = [won, deal({ dealId: "q", qualified: true }), ...Array.from({ length: 8 }, (_, i) => deal({ dealId: `p${i}` }))];
  const metrics = buildDashboardMetrics(rows, [won]);
  assert.equal(metrics.counts.leads, 10);
  assert.equal(metrics.counts.sql, 2);
  assert.equal(metrics.rates.lead_to_sale, 10, "Cohort sotuv / Leadlar = 1 / 10");
  assert.equal(metrics.rates.sql_to_sale, 50, "Cohort sotuv / SQL = 1 / 2");
  assert.equal(metrics.rates.lead_to_sql, 20);
});

test("6: SQL nolga teng bo‘lsa foizlar 0 qaytaradi, NaN emas", () => {
  const metrics = buildDashboardMetrics([deal({ dealId: "a" })], []);
  assert.equal(metrics.counts.sql, 0);
  assert.equal(metrics.counts.classified_leads, 0);
  assert.equal(metrics.rates.sql_to_sale, 0);
  assert.equal(metrics.rates.quality_accepted_rate, 0);
  assert.equal(metrics.rates.low_quality_rate, 0);
  assert.equal(metrics.rates.classification_coverage, 0);
  const empty = buildDashboardMetrics([], []);
  for (const value of Object.values(empty.rates)) assert.equal(Number.isFinite(value), true);
});

test("15: SQL'dan keyin Not Relevant bo‘lgan lead faqat sifatsiz tomonda turadi", () => {
  const row = deal({ dealId: "x", salesStatus: "LOW_QUALITY", qualified: false, lossReasonGroup: "MARKETING", stage: "Not Relevant" });
  const metrics = buildDashboardMetrics([row], []);
  assert.equal(metrics.counts.classified_leads, 1);
  assert.equal(metrics.counts.not_relevant, 1);
  assert.equal(metrics.counts.sql, 0, "bir vaqtda sifatli bo‘lib sanalmaydi");
  assert.equal(metrics.rates.low_quality_rate, 100);
  assert.equal(metrics.rates.quality_accepted_rate, 0);
});

test("11: routing hech bir sifat yoki funnel populyatsiyasiga kirmaydi", () => {
  const routed = deal({ dealId: "r", salesStatus: "LOST", lossReasonGroup: "ROUTING" });
  const kept = deal({ dealId: "k", qualified: true });
  const metrics = buildDashboardMetrics([routed, kept], []);
  assert.equal(metrics.counts.leads, 1);
  assert.equal(metrics.counts.classified_leads, 1);
  assert.equal(metrics.counts.unclassified_leads, 0);
  assert.equal(metrics.eligible.some((row) => row.dealId === "r"), false);
  assert.equal(metrics.classified.some((row) => row.dealId === "r"), false);
  assert.equal(metrics.rates.classification_coverage, 100);
});

test("17: currentScope tarixiy sifat populyatsiyasini o‘zgartirmaydi", () => {
  const base = { qualified: true, salesStatus: "ACTIVE" as const };
  const live = buildDashboardMetrics([deal({ dealId: "1", ...base })], []);
  const gone = buildDashboardMetrics([deal({ dealId: "1", ...base, currentScope: "UNAVAILABLE" })], []);
  const moved = buildDashboardMetrics([deal({ dealId: "1", ...base, currentScope: "OUT_OF_SCOPE" })], []);
  for (const metrics of [gone, moved]) {
    assert.equal(metrics.counts.leads, live.counts.leads);
    assert.equal(metrics.counts.classified_leads, live.counts.classified_leads);
    assert.equal(metrics.counts.sql, live.counts.sql);
    assert.equal(metrics.rates.quality_accepted_rate, live.rates.quality_accepted_rate);
  }
  // Only the current operational card reacts to scope.
  assert.equal(live.counts.active_cohort, 1);
  assert.equal(gone.counts.active_cohort, 0);
  assert.equal(moved.counts.active_cohort, 0);
});

test("9-10: takrorlar hech bir populyatsiyadan olib tashlanmaydi", () => {
  const rows = [
    deal({ dealId: "1", customerKey: "c", qualified: true, salesStatus: "WON", wonAt: "2026-08-09T09:00:00.000Z", opportunity: 100 }),
    deal({ dealId: "2", customerKey: "c", duplicateOfDealId: "1", qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 200 }),
    deal({ dealId: "3", customerKey: "c", duplicateOfDealId: "1", lossReasonGroup: "ROUTING", salesStatus: "LOST" }),
  ];
  const won = rows.filter((row) => row.salesStatus === "WON");
  const metrics = buildDashboardMetrics(rows, won);
  assert.equal(metrics.counts.leads, 2, "ikkala haqiqiy deal ham lead bo‘lib qoladi");
  assert.equal(metrics.counts.classified_leads, 2);
  assert.equal(metrics.counts.cohort_sales, 2);
  assert.equal(metrics.money.revenue, 300, "takror sotuv summadan chiqarilmaydi");
  // Raw counts routing, eligible does not: both are published rather than one changed.
  assert.equal(metrics.counts.duplicates, 2);
  assert.equal(metrics.counts.duplicates_eligible, 1);
  assert.equal(metrics.counts.unique_ish_leads, metrics.counts.leads - metrics.counts.duplicates_eligible);
});

test("4: bir vaqtda ikkala verdictni da'vo qilgan yozuv diagnostikaga chiqadi", () => {
  const broken = deal({ dealId: "b", qualified: true, lossReasonGroup: "MARKETING" });
  assert.equal(countClassificationConflicts([broken]), 1);
  const metrics = buildDashboardMetrics([broken], []);
  assert.equal(metrics.classificationConflicts, 1);
  // The equation genuinely breaks here, and the count is what makes it visible
  // instead of the population silently absorbing the overlap.
  assert.equal(metrics.counts.classified_leads, 1);
  assert.equal(metrics.counts.sql + metrics.counts.not_relevant, 2);
});

test("28: yangi metrik id'lar additive va eski id'lar saqlanadi", () => {
  const ids = DASHBOARD_METRICS.map((metric) => metric.id);
  for (const legacy of ["leads", "sql", "not_relevant", "sales_lost", "cohort_sales", "period_sales", "revenue", "lead_to_sql", "lead_to_sale", "sql_to_sale", "duplicates", "active_cohort", "sla", "avg_processing", "avg_check", "median_check", "sales_cycle"]) {
    assert.ok(ids.includes(legacy as never), `${legacy} saqlanishi kerak`);
  }
  for (const added of ["classified_leads", "unclassified_leads", "classification_coverage", "quality_accepted_rate", "low_quality_rate", "not_relevant_of_leads", "duplicates_eligible", "unique_ish_leads"]) {
    assert.ok(ids.includes(added as never), `${added} qo‘shilishi kerak`);
  }
  assert.equal(new Set(ids).size, ids.length, "id'lar takrorlanmaydi");
  // A saved widget referencing an old id still resolves.
  assert.deepEqual(resolveDashboardMetricIds(["sql", "not_relevant"]), ["sql", "not_relevant"]);
  // Give it a period sale so the money/timing cards have a value to render;
  // with no sales they legitimately show "—".
  const sold = deal({ dealId: "w", qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 250, salesCycleHours: 12 });
  const metrics = buildDashboardMetrics([sold], [sold]);
  for (const id of ids) {
    const resolved = resolveDashboardMetric(metrics, id);
    assert.equal(typeof resolved.value, "string");
    assert.notEqual(resolved.value, "—", `${id} qiymat qaytarishi kerak`);
    assert.ok(resolved.label.length > 0);
  }
});

test("27: sifat ko‘rsatkichlari maxrajini nomida ko‘rsatadi", () => {
  const label = (id: string) => DASHBOARD_METRICS.find((metric) => metric.id === id)?.label ?? "";
  assert.equal(label("classified_leads"), "Saralangan leadlar");
  assert.equal(label("unclassified_leads"), "Saralanmagan leadlar");
  assert.equal(label("classification_coverage"), "Saralash qamrovi");
  assert.equal(label("quality_accepted_rate"), "Sifatli lead %");
  assert.equal(label("low_quality_rate"), "Sifatsiz lead %");
  // The full-funnel Not Relevant rate stays available but names its denominator.
  assert.match(label("not_relevant_of_leads"), /Umumiy leadlardan/);
  assert.match(label("unique_ish_leads"), /taxminiy/);
});
