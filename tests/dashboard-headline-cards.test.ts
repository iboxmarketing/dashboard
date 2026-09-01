import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDashboardMetrics, resolveDashboardMetric, DASHBOARD_METRICS, selectPeriodPopulations } from "../lib/dashboard-metrics";
import {
  DASHBOARD_HEADLINE_CARD_IDS, DEFAULT_HEADLINE_CARD_IDS, MERGED_INTO_HEADLINE,
  NON_HEADLINE_METRIC_IDS, headlineCardLabel, resolveHeadlineCardIds,
} from "../lib/dashboard-cards";
import { validateWidgetConfig } from "../lib/custom-pages";
import type { AnalyticsRecord } from "../lib/types";

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME",
    stage: "Распределение", currentScope: null, customerKey: null, duplicateOfDealId: null,
    stageHistoryCount: 1, ...over,
  } as unknown as AnalyticsRecord;
}

const COHORT = [
  deal({ dealId: "a", qualified: true, stage: "ОБРАБОТКА" }),
  deal({ dealId: "b", qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 900, salesCycleHours: 10 }),
  deal({ dealId: "c", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  deal({ dealId: "d", salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES" }),
  deal({ dealId: "e" }),
];
const WON = COHORT.filter((r) => r.salesStatus === "WON");
const M = buildDashboardMetrics(COHORT, WON);

test("A: the SQL card shows SQL / Saralangan, never Lead → SQL", () => {
  assert.equal(M.counts.sql, 3, "count unchanged: qualified includes WON and Sales Lost");
  assert.equal(M.rates.quality_accepted_rate, Math.round(M.counts.sql / M.counts.classified_leads * 100));
  const client = code("../app/dashboard-client.tsx");
  const card = client.slice(client.indexOf("    sql: {"), client.indexOf("    not_relevant: {"));
  assert.match(card, /quality_accepted_rate/, "quality rate is the secondary figure");
  assert.doesNotMatch(card, /lead_to_sql/, "the funnel rate must not sit on the SQL card");
  assert.match(card, /saralanganlardan/);
});

test("B: the Not Relevant card divides by Saralangan, not by Leadlar", () => {
  assert.equal(M.counts.not_relevant, 1);
  assert.equal(M.rates.low_quality_rate, Math.round(M.counts.not_relevant / M.counts.classified_leads * 100));
  const client = code("../app/dashboard-client.tsx");
  const card = client.slice(client.indexOf("    not_relevant: {"), client.indexOf("    sales_lost: {"));
  assert.match(card, /low_quality_rate/);
  assert.doesNotMatch(card, /not_relevant_of_leads/, "the all-leads share must not be a headline figure");
});

test("C: the Saralangan card carries coverage and the unclassified count", () => {
  assert.equal(M.counts.classified_leads, 4);
  assert.equal(M.counts.unclassified_leads, 1);
  assert.equal(M.rates.classification_coverage, Math.round(4 / 5 * 100));
  const client = code("../app/dashboard-client.tsx");
  const card = client.slice(client.indexOf("    classified_leads: {"), client.indexOf("    sql: {"));
  assert.match(card, /classification_coverage/);
  assert.match(card, /unclassified_leads/);
});

test("D/E: the two sales cards carry their own money, from different populations", () => {
  assert.equal(M.counts.period_sales, WON.length);
  assert.equal(M.money.revenue, 900);
  assert.equal(M.counts.cohort_sales, 1);
  assert.equal(M.money.cohort_revenue, 900);
  const client = code("../app/dashboard-client.tsx");
  const cohortCard = client.slice(client.indexOf("    cohort_sales: {"), client.indexOf("    period_sales: {"));
  const periodCard = client.slice(client.indexOf("    period_sales: {"), client.indexOf("    avg_check: {"));
  assert.match(cohortCard, /money\.cohort_revenue/);
  assert.doesNotMatch(cohortCard, /money\.revenue/, "cohort money must not come from periodSales");
  assert.match(periodCard, /money\.revenue/);
});

test("F: a lead created in August and sold in September splits across the two cards", () => {
  const lead = deal({ dealId: "split", qualified: true, salesStatus: "WON",
    createdAt: "2026-08-20T09:00:00.000Z", wonAt: "2026-09-04T09:00:00.000Z", opportunity: 500 });
  const all = [lead];
  const aug = selectPeriodPopulations(all, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-31T23:59:59Z"));
  const sep = selectPeriodPopulations(all, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-30T23:59:59Z"));

  const august = buildDashboardMetrics(aug.cohort, aug.periodSales);
  assert.equal(august.counts.cohort_sales, 1, "August owns the cohort sale");
  assert.equal(august.money.cohort_revenue, 500, "and its money");
  assert.equal(august.counts.period_sales, 0, "but not the period sale");
  assert.equal(august.money.revenue, 0);

  const september = buildDashboardMetrics(sep.cohort, sep.periodSales);
  assert.equal(september.counts.period_sales, 1, "September owns the period sale");
  assert.equal(september.money.revenue, 500, "and the revenue");
  assert.equal(september.counts.cohort_sales, 0, "but not the cohort sale");
  assert.equal(september.money.cohort_revenue, 0);
});

test("G/H/I: check, funnel and processing keep their formulas and travel together", () => {
  assert.equal(M.money.avg_check, 900);
  assert.equal(M.money.median_check, 900);
  const client = code("../app/dashboard-client.tsx");
  const check = client.slice(client.indexOf("    avg_check: {"), client.indexOf("    lead_to_sql: {"));
  assert.match(check, /median_check/, "median rides along with the average");
  const funnel = client.slice(client.indexOf("    lead_to_sql: {"), client.indexOf("    avg_processing: {"));
  for (const rate of ["lead_to_sql", "lead_to_sale", "sql_to_sale"]) assert.match(funnel, new RegExp(rate));
  const processing = client.slice(client.indexOf("    avg_processing: {"), client.indexOf("    sales_cycle: {"));
  assert.match(processing, /timing\.avg_processing/);
  assert.match(processing, /rates\.sla/);
  assert.match(processing, /sla\.onTime/);
});

test("J/O: merged and diagnostic metrics are absent from the headline selector", () => {
  const hidden = [...Object.keys(MERGED_INTO_HEADLINE), ...NON_HEADLINE_METRIC_IDS];
  for (const id of hidden)
    assert.equal((DASHBOARD_HEADLINE_CARD_IDS as readonly string[]).includes(id), false, `${id} must not be a headline card`);
  assert.ok(hidden.includes("not_relevant_of_leads"));
  // ...but every one still exists as a metric with a working resolver.
  for (const id of hidden) {
    assert.ok(DASHBOARD_METRICS.some((metric) => metric.id === id), `${id} must remain in the registry`);
    const resolved = resolveDashboardMetric(M, id as never);
    assert.equal(typeof resolved.value, "string");
    assert.ok(resolved.label.length > 0);
  }
  assert.equal(DASHBOARD_HEADLINE_CARD_IDS.length, 12);
  assert.equal(DEFAULT_HEADLINE_CARD_IDS.length, 11);
  assert.equal(DEFAULT_HEADLINE_CARD_IDS.includes("active_cohort" as never), false, "optional, not default");
});

test("K: the full legacy 26-id selection folds into unique headline cards", () => {
  const legacy = DASHBOARD_METRICS.map((metric) => metric.id);
  assert.equal(legacy.length, 26);
  const resolved = resolveHeadlineCardIds(legacy);
  assert.equal(new Set(resolved).size, resolved.length, "no card appears twice");
  // The order follows where each anchor first appears in the saved list;
  // classified_leads was appended to the registry in Sprint 28, so it lands last.
  assert.deepEqual(resolved, [
    "leads", "sql", "not_relevant", "sales_lost", "cohort_sales", "period_sales",
    "avg_processing", "lead_to_sql", "avg_check", "sales_cycle", "active_cohort",
    "classified_leads",
  ]);
  assert.equal(resolved.length, DASHBOARD_HEADLINE_CARD_IDS.length, "all 12 headline cards, none twice");
  // The specific pairings the brief calls out.
  assert.deepEqual(resolveHeadlineCardIds(["period_sales", "revenue"]), ["period_sales"]);
  assert.deepEqual(resolveHeadlineCardIds(["revenue", "period_sales"]), ["period_sales"]);
  assert.deepEqual(resolveHeadlineCardIds(["avg_check", "median_check"]), ["avg_check"]);
  assert.deepEqual(resolveHeadlineCardIds(["avg_processing", "sla"]), ["avg_processing"]);
  assert.deepEqual(resolveHeadlineCardIds(["lead_to_sql", "lead_to_sale", "sql_to_sale"]), ["lead_to_sql"]);
  assert.deepEqual(resolveHeadlineCardIds(["sql", "quality_accepted_rate"]), ["sql"]);
  assert.deepEqual(resolveHeadlineCardIds(["not_relevant", "low_quality_rate", "not_relevant_of_leads"]), ["not_relevant"]);
  assert.deepEqual(resolveHeadlineCardIds(["classified_leads", "unclassified_leads", "classification_coverage"]), ["classified_leads"]);
  // Diagnostics with no headline home simply drop out.
  assert.deepEqual(resolveHeadlineCardIds(["duplicates", "pre_sql_closed", "leads"]), ["leads"]);
});

test("L/M: a custom headline order survives, and invalid input falls back", () => {
  assert.deepEqual(resolveHeadlineCardIds(["period_sales", "leads", "sql"]), ["period_sales", "leads", "sql"]);
  // A legacy id folds into its anchor at the position it was saved in.
  assert.deepEqual(resolveHeadlineCardIds(["revenue", "leads"]), ["period_sales", "leads"]);
  // Uncheck / re-check lands at the end.
  const after = ["leads", "sql"].filter((id) => id !== "sql").concat("sql");
  assert.deepEqual(resolveHeadlineCardIds(after), ["leads", "sql"]);
  for (const value of [undefined, null, [], "leads", 42, ["duplicates"]])
    assert.deepEqual(resolveHeadlineCardIds(value), DEFAULT_HEADLINE_CARD_IDS, `input ${JSON.stringify(value)}`);
});

test("N: Custom Pages and the metric resolver still reach every underlying metric", () => {
  for (const metric of DASHBOARD_METRICS)
    assert.equal(validateWidgetConfig("SALES_KPI", { metricId: metric.id, range: "30" }).ok, true, `${metric.id} widget`);
  // Including the ones removed from the headline selector.
  for (const id of ["revenue", "median_check", "sla", "not_relevant_of_leads", "pre_sql_closed", "unique_ish_leads"])
    assert.equal(validateWidgetConfig("SALES_KPI", { metricId: id, range: "30" }).ok, true, `${id} still usable`);
});

test("the duplicated quality/funnel panel is gone from the main dashboard", () => {
  const client = code("../app/dashboard-client.tsx");
  assert.doesNotMatch(client, /QualityVsFunnel/, "the dead presentation component is removed");
  // The exact old rule, not any class that starts with "split": the manager
  // profile legitimately uses a two-equal-column grid of its own.
  assert.doesNotMatch(code("../app/globals.css"), /\.dashboard-grid\.split \{/, "and its layout rule with it");
});

/**
 * Pins what the main Dashboard is allowed to contain.
 *
 * The Lead sifati / Funnel konversiyasi summary panels repeated what the
 * headline cards already say, so the main view is cards plus the sections that
 * were never duplicates. Asserting the composition — not just the absence of
 * one component name — is what stops an equivalent panel reappearing later
 * under a different name.
 */
test("the main Dashboard renders cards and no duplicate summary panels", () => {
  const client = code("../app/dashboard-client.tsx");
  const view = client.slice(client.indexOf("function DashboardView("), client.indexOf("function TrendChart("));
  const body = view.slice(view.indexOf("return <>"));

  // 1-2. No summary panel repeats the quality or funnel story.
  assert.doesNotMatch(body, /Lead sifati/, "no Lead sifati summary block on the main Dashboard");
  assert.doesNotMatch(body, /className="dashboard-grid split"/, "no side-by-side quality/funnel panel");
  assert.doesNotMatch(body, /compact-kpis/, "no compact metric panel duplicating the cards");
  // "Funnel konversiyasi" survives only as a headline card label, never a panel.
  assert.doesNotMatch(body, /SectionHeader title="Funnel konversiyasi"/);
  assert.doesNotMatch(body, /SectionHeader title="Lead sifati"/);

  // 3. The headline cards still render, driven by the saved order.
  assert.match(body, /<section className="kpi-grid sales-kpis">/);
  assert.match(body, /selected\.map\(\(id\) =>/);
  assert.match(body, /<KpiCard key=\{id\}/);

  // Exactly two panels remain, and neither is a metric summary.
  const panels = [...body.matchAll(/SectionHeader title="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, ["Menejerlar performance"], "only the manager table remains as a panel");
});

test("5: the detailed consumers of those metrics are untouched", () => {
  const client = code("../app/dashboard-client.tsx");
  // Lead sifati remains its own page, now with the approved split manager diagnostics.
  assert.match(client, /function QualityView\(/);
  assert.match(client, /Lead sifati va yo‘qotish sabablari/);
  assert.match(client, /Not Relevant — menejerlar kesimida/);
  assert.match(client, /Sotilmadi — menejerlar kesimida/);
  // Diagnostics keeps the classification equations.
  assert.match(client, /function ClassificationDiagnostics\(/);
  assert.match(client, /Lead saralash diagnostikasi/);
  // Lead oqimi keeps its own view.
  assert.match(client, /function LeadFlowView\(/);
  // And every metric they read is still produced.
  const metrics = buildDashboardMetrics(COHORT, WON);
  for (const key of ["classification_coverage", "quality_accepted_rate", "low_quality_rate", "not_relevant_of_leads", "lead_to_sql", "lead_to_sale", "sql_to_sale"] as const)
    assert.equal(typeof metrics.rates[key], "number", `rates.${key} must survive`);
  for (const key of ["classified_leads", "unclassified_leads", "duplicates", "unique_ish_leads"] as const)
    assert.equal(typeof metrics.counts[key], "number", `counts.${key} must survive`);
});

test("headline labels read as decisions, not raw metric names", () => {
  assert.equal(headlineCardLabel("classified_leads"), "Saralangan");
  assert.equal(headlineCardLabel("avg_check"), "Chek");
  assert.equal(headlineCardLabel("lead_to_sql"), "Funnel konversiyasi");
  assert.equal(headlineCardLabel("avg_processing"), "Saralash tezligi");
  // Everything else keeps its registry label.
  assert.equal(headlineCardLabel("leads"), "Leadlar");
  assert.equal(headlineCardLabel("sales_cycle"), "Savdo sikli");
});
