import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANALYTICS_EXPORT_QUERY,
  CERTIFIED_REFERENCE,
  buildCertificationReport,
  buildManagerCertification,
  buildSourceCertification,
  calculateCertificationMetrics,
  compareSellerMutationIsolation,
  parseCertificationInput,
} from "../scripts/validate-data-certification.mjs";
import { buildMonthlyComparison } from "../scripts/monthly-comparison.mjs";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics.ts";
import { boundsFromKeys } from "../lib/period.ts";

function deal(over = {}) {
  return {
    analyticsVersion: 10,
    dealId: "1",
    createdAt: "2026-09-02T04:00:00.000Z",
    wonAt: null,
    salesStatus: "ACTIVE",
    qualified: false,
    lossReasonGroup: "NONE",
    opportunity: 0,
    currencyId: "UZS",
    projectLeadMembership: "INCLUDED",
    currentScope: "IN_SCOPE",
    salesManagerId: "7",
    salesManager: "Ali",
    salesManagerAttribution: "CUSTOM_FIELD",
    sourceId: "WEBFORM",
    source: "CRM-форма",
    processingBusinessMinutes: null,
    salesCycleHours: null,
    slaStatus: "PENDING",
    customerKey: null,
    duplicateOfDealId: null,
    ...over,
  };
}

function certifiedFixture() {
  const rows = [];
  for (let index = 0; index < 209; index += 1) {
    const won = index < 41;
    const lost = index >= 41 && index < 121;
    rows.push(deal({
      dealId: `sql-${index}`,
      qualified: true,
      salesStatus: won ? "WON" : lost ? "LOST" : "ACTIVE",
      lossReasonGroup: lost ? "SALES" : "NONE",
      wonAt: won ? "2026-09-10T07:00:00.000Z" : null,
      opportunity: index === 0 ? 18_303_500 : 0,
      salesManagerAttribution: index % 2 ? "STAGE_MOVER" : "CUSTOM_FIELD",
    }));
  }
  for (let index = 0; index < 230; index += 1) {
    rows.push(deal({ dealId: `nr-${index}`, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }));
  }
  for (let index = 0; index < 31; index += 1) rows.push(deal({ dealId: `unclassified-${index}` }));
  rows.push(deal({
    dealId: "40099",
    createdAt: "2026-08-20T04:00:00.000Z",
    wonAt: "2026-09-11T08:00:00.000Z",
    salesStatus: "WON",
    qualified: true,
    opportunity: 559_000,
    salesManagerId: "9",
    salesManager: "Dilshod",
    salesManagerAttribution: "OWNER_CONFIRMED",
  }));
  return rows;
}

test("certified September reference reconciles every KPI and Deal 40099", () => {
  const report = buildCertificationReport(certifiedFixture());
  assert.equal(report.certificationStatus, "PASS");
  assert.deepEqual(report.metrics.values, {
    lead: 470,
    sql: 209,
    notRelevant: 230,
    saralangan: 439,
    saralanmagan: 31,
    salesLost: 80,
    cohortSales: 41,
    periodSales: 42,
    periodRevenue: 18_862_500,
    cohortRevenue: 18_303_500,
    periodCurrency: "UZS",
    cohortCurrency: "UZS",
    leadToSql: 44,
    sqlToSale: 20,
    leadToSale: 9,
  });
  assert.ok(report.reference.checks.every((check) => check.status === "PASS"));
  assert.equal(CERTIFIED_REFERENCE.deal.dealId, "40099");
});

test("toolkit formulas cross-check the canonical dashboard helper", () => {
  const rows = [
    deal({ dealId: "sql", qualified: true }),
    deal({ dealId: "nr", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
    deal({ dealId: "lost", qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" }),
    deal({ dealId: "won", qualified: true, salesStatus: "WON", wonAt: "2026-09-05T10:00:00.000Z", opportunity: 50 }),
    deal({ dealId: "waiting" }),
  ];
  const bounds = boundsFromKeys({ from: "2026-09-01", to: "2026-09-19" });
  const canonicalPopulations = selectPeriodPopulations(rows, bounds.from, bounds.to);
  const canonical = buildDashboardMetrics(canonicalPopulations.cohort, canonicalPopulations.periodSales);
  const audit = calculateCertificationMetrics(rows, { from: "2026-09-01", to: "2026-09-19" });
  assert.equal(audit.values.lead, canonical.counts.leads);
  assert.equal(audit.values.sql, canonical.counts.sql);
  assert.equal(audit.values.notRelevant, canonical.counts.not_relevant);
  assert.equal(audit.values.salesLost, canonical.counts.sales_lost);
  assert.equal(audit.values.cohortSales, canonical.counts.cohort_sales);
  assert.equal(audit.values.periodSales, canonical.counts.period_sales);
  assert.equal(audit.values.periodRevenue, canonical.money.revenue);
});

test("duplicate Deal IDs and SQL/Not Relevant conflicts fail instead of inflating counts", () => {
  const conflict = deal({ dealId: "conflict", qualified: true, lossReasonGroup: "MARKETING", salesStatus: "LOW_QUALITY" });
  const report = buildCertificationReport([conflict, { ...conflict }], { reference: false });
  assert.equal(report.certificationStatus, "FAIL");
  assert.deepEqual(report.input.duplicateDealIds, ["conflict"]);
  assert.equal(report.invariants.find((row) => row.id === "one_input_row_per_deal").status, "FAIL");
  assert.equal(report.invariants.find((row) => row.id === "not_relevant_not_sql").status, "FAIL");
  assert.equal(report.metrics.values.lead, 1, "calculation is deduplicated while the input defect remains fatal");
});

test("mixed currency blocks one revenue total and reports each currency subtotal", () => {
  const rows = [
    deal({ dealId: "uzs", qualified: true, salesStatus: "WON", wonAt: "2026-09-10T00:00:00Z", opportunity: 100, currencyId: "UZS" }),
    deal({ dealId: "usd", qualified: true, salesStatus: "WON", wonAt: "2026-09-10T00:00:00Z", opportunity: 2, currencyId: "USD" }),
  ];
  const report = buildCertificationReport(rows, { reference: false });
  assert.equal(report.metrics.values.periodRevenue, null);
  assert.deepEqual(report.metrics.money.period.byCurrency, { UZS: 100, USD: 2 });
  assert.equal(report.invariants.find((row) => row.id === "no_mixed_period_currency").status, "FAIL");
});

test("period and cohort sales stay separate and may legitimately overlap", () => {
  const rows = [
    deal({ dealId: "both", qualified: true, salesStatus: "WON", wonAt: "2026-09-05T00:00:00Z", opportunity: 10 }),
    deal({ dealId: "cohort-only", qualified: true, salesStatus: "WON", wonAt: "2026-10-05T00:00:00Z", opportunity: 20 }),
    deal({ dealId: "period-only", createdAt: "2026-08-05T00:00:00Z", qualified: true, salesStatus: "WON", wonAt: "2026-09-06T00:00:00Z", opportunity: 30 }),
  ];
  const metrics = calculateCertificationMetrics(rows, { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(metrics.populations.cohortSales.dealIds, ["both", "cohort-only"]);
  assert.deepEqual(metrics.populations.periodSales.dealIds, ["both", "period-only"]);
  assert.equal(metrics.values.cohortRevenue, 30);
  assert.equal(metrics.values.periodRevenue, 40);
});

test("Tashkent calendar boundaries drive the August and September comparison", () => {
  const rows = [
    deal({ dealId: "aug-last", createdAt: "2026-08-31T18:59:59.999Z", sourceId: "A", source: "A" }),
    deal({ dealId: "sep-first", createdAt: "2026-08-31T19:00:00.000Z", sourceId: "B", source: "B" }),
    deal({ dealId: "sep-last", createdAt: "2026-09-30T18:59:59.999Z", sourceId: "C", source: "C" }),
    deal({ dealId: "oct-first", createdAt: "2026-09-30T19:00:00.000Z", sourceId: "D", source: "D" }),
  ];
  const report = buildMonthlyComparison(rows);
  assert.equal(report.months[0].lead, 1);
  assert.equal(report.months[1].lead, 2);
  assert.equal(report.timezone, "Asia/Tashkent");
});

test("seller-only changes preserve all metric-bearing facts", () => {
  const before = [deal({ dealId: "sale", qualified: true, salesStatus: "WON", wonAt: "2026-09-05T00:00:00Z", opportunity: 900 })];
  const after = before.map((row) => ({ ...row, salesManagerId: "88", salesManager: "New seller", salesManagerAttribution: "OWNER_CONFIRMED" }));
  assert.equal(compareSellerMutationIsolation(before, after).status, "PASS");
  assert.equal(compareSellerMutationIsolation(before, [{ ...after[0], wonAt: "2026-09-06T00:00:00Z" }]).status, "FAIL");
});

test("manager report distinguishes certified, unknown, legacy and human-review sales", () => {
  const rows = [
    deal({ dealId: "owner", salesStatus: "WON", qualified: true, salesManagerAttribution: "OWNER_CONFIRMED", opportunity: 10 }),
    deal({ dealId: "unknown", salesStatus: "WON", qualified: true, salesManagerId: null, salesManager: null, salesManagerAttribution: "UNKNOWN", opportunity: 20 }),
    deal({ dealId: "legacy", salesStatus: "WON", qualified: true, salesManagerAttribution: "FIRST_CALL", opportunity: 30 }),
    deal({ dealId: "review", salesStatus: "WON", qualified: true, salesManagerAttribution: "STAGE_MOVER", sellerReviewStatus: "HUMAN_REVIEW_REQUIRED", opportunity: 40 }),
  ];
  const report = buildManagerCertification(rows);
  assert.equal(report.rows.find((row) => row.attributionSource === "OWNER_CONFIRMED").certification, "CERTIFIED");
  assert.equal(report.rows.find((row) => row.attributionSource === "UNKNOWN").unknownCount, 1);
  assert.equal(report.rows.find((row) => row.attributionSource === "FIRST_CALL").certification, "UNCERTIFIED");
  const review = report.rows.find((row) => row.attributionSource === "STAGE_MOVER");
  assert.equal(review.humanReviewCount, 1);
  assert.equal(review.certification, "UNCERTIFIED");
});

test("source audit preserves raw rows and only flags duplicate spellings", () => {
  const rows = [
    deal({ dealId: "a", qualified: true, sourceId: "A", source: "CRM-форма" }),
    deal({ dealId: "b", salesStatus: "WON", qualified: true, sourceId: "B", source: "CRM форма", opportunity: 100 }),
    deal({ dealId: "c", sourceId: "", source: "Aniqlanmagan" }),
    deal({ dealId: "d", sourceId: "RAW_UNKNOWN", source: "RAW_UNKNOWN" }),
    deal({ dealId: "e", sourceId: "IG", source: "Instagram Direct - SD instagram" }),
  ];
  const report = buildSourceCertification(rows);
  assert.equal(report.rows.length, 5, "raw source ID+label rows are never merged");
  assert.equal(report.rows.find((row) => row.rawSourceId === "A").normalizedSource, "CRM-forma");
  assert.equal(report.rows.find((row) => row.rawSourceId === "B").normalizedSource, "CRM-forma");
  assert.deepEqual(report.duplicateSpellings, [{ comparisonKey: "crm форма", rawSources: ["CRM форма", "CRM-форма"] }]);
  assert.equal(report.rows.find((row) => row.rawSourceId === "").classification, "MISSING_SOURCE");
  assert.equal(report.rows.find((row) => row.rawSourceId === "RAW_UNKNOWN").classification, "UNKNOWN_SOURCE");
  assert.equal(report.rows.find((row) => row.rawSourceId === "IG").classification, "UNMAPPED");
});

test("D1 parser surfaces invalid JSON instead of filtering it away", () => {
  const parsed = parseCertificationInput([{
    results: [
      { deal_id: "1", payload_valid: 1, payload: JSON.stringify(deal({ dealId: "1" })) },
      { deal_id: "2", payload_valid: 0, payload: "{" },
    ],
  }]);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.issues, [{ index: 1, dealId: "2", error: "INVALID_JSON_PAYLOAD" }]);
});

test("machine-readable matrix covers every requested KPI and query stays SELECT-only", async () => {
  const matrix = JSON.parse(await readFile(new URL("../docs/data-certification-matrix.json", import.meta.url), "utf8"));
  assert.deepEqual(matrix.metrics.map((metric) => metric.id), [
    "lead", "sql", "not_relevant", "saralangan", "saralanmagan", "sales_lost",
    "cohort_sales", "period_sales", "revenue", "manager_attribution", "source_attribution",
  ]);
  for (const metric of matrix.metrics) {
    for (const field of ["businessDefinition", "authoritativeCrmEvidence", "dateField", "timezone", "inclusionRules", "exclusionRules", "deduplicationRule", "funnelCategoryBehavior", "expectedInvariants", "knownEdgeCases", "exactValidator"])
      assert.ok(metric[field] !== undefined, `${metric.id}.${field}`);
  }
  assert.match(ANALYTICS_EXPORT_QUERY, /^SELECT\b/i);
  assert.doesNotMatch(ANALYTICS_EXPORT_QUERY, /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i);
  assert.equal(matrix.readOnlyAnalyticsQuery, ANALYTICS_EXPORT_QUERY);
});
