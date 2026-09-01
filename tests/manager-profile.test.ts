import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { isPreSqlClosed, isSalesLost, salesManagerKey } from "../lib/sales-logic";
import {
  buildManagerProfile, medianOf, notRelevantRecords, notRelevantSemanticMismatches,
  reasonBreakdown, reasonTextMismatches, salesLostRecords, sourceFunnelRows, stageWorkloadRows, teamMedian,
} from "../lib/manager-profile";
import type { AnalyticsRecord } from "../lib/types";

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const client = code("../app/dashboard-client.tsx");
const profile = client.slice(client.indexOf("function ManagerDetailView("), client.indexOf("function LeadFlowView("));
const pct = (value: number, total: number) => (total ? Math.round((value / total) * 100) : 0);

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME", source: "CRM-форма",
    stage: "Распределение", currentScope: null, customerKey: null, duplicateOfDealId: null,
    salesManagerId: "7", salesManager: "Ali", assignedManagerId: "7", assignedManager: "Ali",
    stageHistoryCount: 1, ...over,
  } as unknown as AnalyticsRecord;
}
const ALI = { salesManagerId: "7", salesManager: "Ali" };
const BOB = { salesManagerId: "9", salesManager: "Bob" };

const COHORT = [
  deal({ dealId: "a1", ...ALI, qualified: true, stage: "ОБРАБОТКА" }),
  deal({ dealId: "a2", ...ALI, qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 700, salesCycleHours: 24 }),
  deal({ dealId: "a3", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Man qoldirmadim" }),
  deal({ dealId: "a4", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "" }),
  deal({ dealId: "a5", ...ALI, salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", lossReason: "Otsrochka" }),
  // Pre-SQL closure: SALES group but never qualified — must stay out of Sotilmadi.
  deal({ dealId: "a6", ...ALI, salesStatus: "LOST", qualified: false, lossReasonGroup: "SALES", lossReason: "Ignorit" }),
  // Routing: excluded from the cohort entirely.
  deal({ dealId: "a7", ...ALI, salesStatus: "LOST", lossReasonGroup: "ROUTING", lossReason: "Idokon" }),
  deal({ dealId: "a8", ...ALI, slaStatus: "OVERDUE_UNPROCESSED", source: "Telegram" }),
  deal({ dealId: "b1", ...BOB, qualified: true }),
  deal({ dealId: "b2", ...BOB }),
];
const WON = COHORT.filter((r) => r.salesStatus === "WON");
const { cohort, metrics } = buildManagerProfile(COHORT, WON, "7");

test("A: profile counts equal the clicked row's canonical values", () => {
  const rowMetrics = buildDashboardMetrics(COHORT.filter((r) => salesManagerKey(r) === "7"), WON.filter((r) => salesManagerKey(r) === "7"));
  assert.equal(metrics.counts.leads, rowMetrics.counts.leads);
  assert.equal(metrics.counts.sql, rowMetrics.counts.sql);
  assert.equal(metrics.counts.cohort_sales, rowMetrics.counts.cohort_sales);
  assert.equal(metrics.money.cohort_revenue, rowMetrics.money.cohort_revenue);
  assert.match(profile, /buildManagerProfile\(cohortRecords, salesRecords, manager\.id\)/, "one canonical build");
});

test("B: lead share divides by every manager, not a displayed subset", () => {
  assert.match(profile, /buildManagers\(cohortRecords, salesRecords\)/, "the whole team");
  assert.match(profile, /team\.reduce\(\(sum, row\) => sum \+ row\.leads, 0\)/);
  assert.match(profile, /jamoa leadlaridan/);
  assert.doesNotMatch(profile, /slice\(0, 8\)/, "never a top-8 denominator");
});

test("C/D/E: classification and quality use canonical denominators", () => {
  assert.equal(metrics.counts.leads, 7, "8 Ali records minus the routed one");
  assert.equal(metrics.counts.classified_leads, 5, "3 qualified + 2 Not Relevant");
  assert.equal(metrics.rates.classification_coverage, pct(5, 7));
  assert.equal(metrics.counts.unclassified_leads, 2);
  assert.equal(metrics.counts.sql, 3);
  assert.equal(metrics.rates.quality_accepted_rate, pct(3, 5));
  assert.equal(metrics.counts.not_relevant, 2);
  assert.equal(metrics.rates.low_quality_rate, pct(2, 5));
  assert.equal(metrics.rates.quality_accepted_rate + metrics.rates.low_quality_rate, 100);
});

test("F/G/H/I/J/K/L: result, workload and speed cards are canonical", () => {
  assert.equal(metrics.counts.cohort_sales, 1);
  assert.equal(metrics.money.cohort_revenue, 700);
  assert.equal(metrics.rates.lead_to_sale, pct(1, 7));
  assert.equal(metrics.rates.sql_to_sale, pct(1, 3));
  assert.equal(metrics.counts.sales_lost, 1, "a5 only — the pre-SQL a6 is excluded");
  assert.equal(metrics.rates.sales_lost, pct(1, 3));
  assert.equal(metrics.counts.period_sales, 1);
  assert.equal(metrics.money.revenue, 700);
  assert.equal(metrics.counts.active_cohort, metrics.eligible.filter((r) => r.salesStatus === "ACTIVE").length);
  assert.equal(typeof metrics.timing.avg_processing, "number");
  assert.equal(metrics.sla.overdue, 1);
  assert.equal(metrics.timing.sales_cycle, 24);
  for (const source of ["counts.active_cohort", "timing.avg_processing", "rates.sla", "sla.onTime", "sla.denominator", "sla.overdue", "timing.sales_cycle", "money.revenue", "money.cohort_revenue"])
    assert.ok(profile.includes(`metrics.${source}`), `${source} must come from the canonical metrics`);
});

test("M/N: the SQL card holds no funnel rate, and period sales carry their money", () => {
  const sqlCard = profile.slice(profile.indexOf('label="SQL"'), profile.indexOf('label="Not Relevant"'));
  assert.match(sqlCard, /quality_accepted_rate/);
  assert.doesNotMatch(sqlCard, /lead_to_sql/, "no Lead → SQL on a quality card");
  const periodCard = profile.slice(profile.indexOf('label="Shu davrdagi sotuv"'), profile.indexOf('label="Aktiv leadlar"'));
  assert.match(periodCard, /counts\.period_sales/);
  assert.match(periodCard, /money\.revenue/, "one card, count and money");
  assert.doesNotMatch(profile, /label="Sotuv summasi"/, "no separate revenue card");
  assert.doesNotMatch(profile, /label="Marketing sifatsiz"/, "renamed to Not Relevant");
});

test("O/P/Q: the source table is a created-cohort funnel with no period sales", () => {
  const rows = sourceFunnelRows(cohort);
  const main = rows.find((row) => row.source === "CRM-форма")!;
  const telegram = rows.find((row) => row.source === "Telegram")!;
  assert.equal(main.leads + telegram.leads, metrics.counts.leads, "sources partition the cohort");
  assert.equal(main.sqlToSale, pct(main.cohortSales, main.sql), "P");
  assert.equal(main.leadToSale, pct(main.cohortSales, main.leads));
  assert.equal(main.qualityAcceptedRate, pct(main.sql, main.classified));
  assert.equal(main.salesLostRate, pct(main.salesLost, main.sql));
  assert.equal(main.cohortRevenue, 700, "the sum of that source's own cohort sales");
  assert.equal("periodSales" in main, false, "Q: no period sales in this table");
  assert.equal("revenue" in main, false);
  const table = profile.slice(profile.indexOf('title="Source funnel"'), profile.indexOf('title="Joriy stage yuklamasi"'));
  assert.doesNotMatch(table, /period_sales|money\.revenue/, "Q: and none rendered");
});

test("Source Funnel hides a routing-only source instead of rendering zero Leadlar", () => {
  const rows = sourceFunnelRows([
    deal({ dealId: "eligible-source", source: "CRM-форма" }),
    deal({ dealId: "routing-source", source: "Faqat routing", salesStatus: "LOST", lossReasonGroup: "ROUTING" }),
  ]);
  assert.deepEqual(rows.map((row) => row.source), ["CRM-форма"]);
  assert.equal(rows[0].leads, 1);
  assert.equal(rows.some((row) => row.leads === 0), false);
});

test("R/S: stage workload shows overdue count and rate, problems first", () => {
  const rows = stageWorkloadRows([
    { stage: "ОБРАБОТКА", stageOverdue: true }, { stage: "ОБРАБОТКА", stageOverdue: true }, { stage: "ОБРАБОТКА" },
    { stage: "НЕТ ОТВЕТА", stageOverdue: true },
    { stage: "Первое касание" }, { stage: "Первое касание" }, { stage: "Первое касание" }, { stage: "Первое касание" },
  ]);
  assert.deepEqual(rows.map((row) => row.stage), ["ОБРАБОТКА", "НЕТ ОТВЕТА", "Первое касание"], "S: overdue first, then active");
  assert.deepEqual(rows[0], { stage: "ОБРАБОТКА", active: 3, overdue: 2, overdueRate: 67 });
  assert.equal(rows[2].overdue, 0);
  assert.equal(rows[2].active, 4, "a busy but healthy stage ranks below a problem one");
  const block = profile.slice(profile.indexOf('title="Joriy stage yuklamasi"'), profile.indexOf('title="Chek"'));
  assert.match(block, /muddati o‘tgan/); assert.doesNotMatch(block, /overdue</i);
  assert.match(block, /Bitrix’dagi joriy ochiq deal’lar/, "labelled as live workload");
});

test("T/U/Y: Not Relevant reasons are marketing-only and share their own denominator", () => {
  const rows = notRelevantRecords(cohort);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.lossReasonGroup === "MARKETING"), true, "T");
  assert.equal(rows.some((row) => row.lossReasonGroup === "ROUTING"), false, "Y: routing absent");
  assert.equal(rows.some(isSalesLost), false);
  const reasons = reasonBreakdown(rows);
  assert.deepEqual(reasons.map((row) => [row.reason, row.count, row.share]),
    [["Man qoldirmadim", 1, 50], ["Sabab ko‘rsatilmagan", 1, 50]], "U: % of Not Relevant, and a blank reason is named");
  assert.equal(reasons.reduce((sum, row) => sum + row.count, 0), rows.length);
});

test("V/W/X/Y: Sales Lost reasons exclude pre-SQL closures and routing", () => {
  const rows = salesLostRecords(cohort);
  assert.equal(rows.length, 1, "a5 only");
  assert.equal(rows.every(isSalesLost), true, "V");
  assert.equal(rows.some(isPreSqlClosed), false, "X: a6 is a pre-SQL closure, not a sales loss");
  assert.equal(cohort.filter(isPreSqlClosed).length, 1, "and it does exist in the cohort");
  assert.equal(rows.some((row) => row.lossReasonGroup === "ROUTING"), false, "Y");
  const reasons = reasonBreakdown(rows);
  assert.deepEqual(reasons, [{ reason: "Otsrochka", count: 1, share: 100 }], "W");
});

test("Z/AA: processing is not repeated at the bottom, and Chek uses period sales", () => {
  const chek = profile.slice(profile.indexOf('title="Chek"'), profile.indexOf('title="Not Relevant sabablari"'));
  assert.match(chek, /money\.avg_check/); assert.match(chek, /money\.median_check/);
  assert.match(chek, /counts\.period_sales/, "AA: the basis is stated");
  assert.doesNotMatch(chek, /Ishlov qayd etilgan/, "Z: processing lives in the top card only");
  assert.doesNotMatch(chek, /SLA ichida/);
  assert.doesNotMatch(profile, /title="Chek va ishlov sifati"/);
  assert.doesNotMatch(profile, /title="Sabablar profili"/, "the mixed reason panel is gone");
});

test("AB/AC: benchmarks are team medians over eligible real sellers only", () => {
  assert.equal(medianOf([10, 20, 30]), 20);
  assert.equal(medianOf([10, 20]), 15);
  assert.equal(medianOf([]), null);
  // A seller with no SQL has no closing rate; counting them as 0% would drag
  // the benchmark down and flatter everyone above it.
  const rows = [{ sql: 4, sqlToSale: 50 }, { sql: 2, sqlToSale: 10 }, { sql: 0, sqlToSale: 0 }];
  assert.equal(teamMedian(rows, (row) => row.sqlToSale, (row) => row.sql > 0), 30, "AC: excludes the SQL=0 manager");
  assert.equal(teamMedian(rows, (row) => row.sqlToSale, () => true), 10, "including it would say 10");
  assert.match(profile, /const benchmarkTeam = team\.filter\(\(row\) => row\.id !== "unknown"\)/);
  assert.match(profile, /teamMedian\(benchmarkTeam, \(row\) => row\.sqlToSale, withSql\)/);
  assert.match(profile, /teamMedian\(benchmarkTeam, \(row\) => row\.salesLostRate, withSql\)/);
  assert.match(profile, /row\.slaDenominator > 0/, "SLA median needs a valid denominator");
  assert.match(profile, /Jamoa medianasi/);
  assert.doesNotMatch(profile, /Manager Score|Ball|Reyting ball/i, "no score is invented");
  // Not Relevant is source quality, not seller performance — never benchmarked.
  const nrCard = profile.slice(profile.indexOf('label="Not Relevant"'), profile.indexOf('label="Kelgan leadlardan sotuv"'));
  assert.doesNotMatch(nrCard, /Jamoa medianasi/);
});

test("unknown stays in lead share but is excluded from every performance median", () => {
  const team = [
    { id: "seller-a", leads: 10, sql: 10, sqlToSale: 30, salesLostRate: 20, avgProcessing: 10, slaRate: 80, slaDenominator: 10, salesCycleHours: 20 },
    { id: "seller-b", leads: 10, sql: 10, sqlToSale: 50, salesLostRate: 40, avgProcessing: 20, slaRate: 60, slaDenominator: 10, salesCycleHours: 40 },
    { id: "unknown", leads: 5, sql: 5, sqlToSale: 100, salesLostRate: 100, avgProcessing: 100, slaRate: 0, slaDenominator: 5, salesCycleHours: 100 },
  ];
  const benchmarkTeam = team.filter((row) => row.id !== "unknown");
  const teamLeads = team.reduce((sum, row) => sum + row.leads, 0);

  assert.equal(teamLeads, 25, "A: unattributed leads remain in the denominator");
  assert.equal(pct(team[0].leads, teamLeads), 40, "B: seller A lead share remains 10 / all 25 leads");
  assert.equal(teamMedian(team, (row) => row.sqlToSale, (row) => row.sql > 0), 50, "old SQL→Sale median included unknown");
  assert.equal(teamMedian(benchmarkTeam, (row) => row.sqlToSale, (row) => row.sql > 0), 40, "C: 30% and 50% median to 40%");
  assert.equal(teamMedian(benchmarkTeam, (row) => row.salesLostRate, (row) => row.sql > 0), 30, "D");
  assert.equal(teamMedian(benchmarkTeam, (row) => row.avgProcessing, (row) => row.avgProcessing !== null), 15, "E");
  assert.equal(teamMedian(benchmarkTeam, (row) => row.slaRate, (row) => row.slaDenominator > 0), 70, "F");
  assert.equal(teamMedian(benchmarkTeam, (row) => row.salesCycleHours, (row) => row.salesCycleHours !== null), 30, "G");

  assert.match(profile, /const teamLeads = team\.reduce\(\(sum, row\) => sum \+ row\.leads, 0\)/, "lead share still reads team");
  for (const metric of ["sqlToSale", "salesLostRate", "avgProcessing", "slaRate", "salesCycleHours"])
    assert.match(profile, new RegExp(`teamMedian\\(benchmarkTeam, \\(row\\) => row\\.${metric}`), `${metric} reads benchmarkTeam`);
});

test("semantic mismatch detectors report rather than silently reclassify", () => {
  // Canonically impossible: LOW_QUALITY always yields MARKETING.
  assert.equal(notRelevantSemanticMismatches(cohort).length, 0);
  const broken = [deal({ salesStatus: "LOW_QUALITY", lossReasonGroup: "SALES" })];
  assert.equal(notRelevantSemanticMismatches(broken).length, 1, "a mismatch is detected, not hidden");
  // A SALES record whose reason text merely mentions Not Relevant stays a
  // sales loss — the text is not evidence of classification.
  const textual = [deal({ salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", lossReason: "игнорить (Not relevant)" })];
  assert.equal(reasonTextMismatches(textual).length, 1);
  assert.equal(notRelevantRecords(textual).length, 0, "it is not moved into Not Relevant");
  assert.equal(salesLostRecords(textual).length, 1, "it stays where its group puts it");
});
