import assert from "node:assert/strict";
import test from "node:test";

import { ANALYTICS_VERSION } from "../lib/analytics";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { boundsFromKeys } from "../lib/period";
import {
  filterCurrentStageRecords, filterHistoricalRecords, filterStageHistoryRecords,
} from "../lib/record-filters";
import type { AnalyticsRecord } from "../lib/types";

const CRM = "CRM-форма";
const SEPTEMBER = boundsFromKeys({ from: "2026-09-01", to: "2026-09-19" });

function deal(index: number, over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    analyticsVersion: ANALYTICS_VERSION,
    dealId: String(50_000 + index), title: `Deal ${index}`,
    createdAt: "2026-09-10T09:00:00+05:00", creationPeriod: "WORK_HOURS",
    source: CRM, salesManagerId: "ali", salesManager: "Ali",
    assignedManagerId: "ali", assignedManager: "Ali",
    originPipeline: "IBOX Sales", projectLeadMembership: "INCLUDED", currentScope: "IN_SCOPE",
    salesStatus: "ACTIVE", qualified: false, qualifiedStageId: null,
    lossReasonGroup: "NONE", lossReason: "", wonAt: null,
    opportunity: 0, currencyId: "UZS", processingBusinessMinutes: null,
    salesCycleHours: null, slaStatus: "PENDING", customerKey: null, duplicateOfDealId: null,
    ...over,
  } as unknown as AnalyticsRecord;
}

/**
 * Controlled acceptance fixture matching the approved live-reference totals.
 * These constants assert outputs only; production formulas remain exclusively
 * in buildDashboardMetrics and no application code contains these numbers.
 */
function referenceFixture() {
  let index = 0;
  const cohort: AnalyticsRecord[] = [];

  for (let n = 0; n < 41; n += 1) cohort.push(deal(index++, {
    salesStatus: "WON", qualified: true, wonAt: "2026-09-10T12:00:00+05:00",
    opportunity: n === 40 ? 2_303_500 : 400_000,
    ...(n === 0 ? { assignedManagerId: "madina", assignedManager: "Madina" } : {}),
  }));
  for (let n = 0; n < 80; n += 1) cohort.push(deal(index++, {
    salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", lossReason: "Ordinary sales loss",
  }));
  for (let n = 0; n < 88; n += 1) cohort.push(deal(index++, { qualified: true }));
  for (let n = 0; n < 230; n += 1) cohort.push(deal(index++, {
    salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Not Relevant",
  }));
  for (let n = 0; n < 31; n += 1) cohort.push(deal(index++));

  // The approved all-source cohort has a 448-record CRM-form subset. Source is
  // assigned after outcomes so it remains a filter/breakdown, never membership.
  cohort.forEach((row, position) => { row.source = position < 448 ? CRM : "Referral"; });

  const oldCreatedPeriodSale = deal(index++, {
    dealId: "40099", createdAt: "2026-08-20T09:00:00+05:00",
    salesStatus: "WON", qualified: true, wonAt: "2026-09-05T12:00:00+05:00",
    opportunity: 559_000, assignedManagerId: "madina", assignedManager: "Madina",
  });
  const excludedOtherProject = deal(index++, {
    dealId: "outside", projectLeadMembership: "EXCLUDED", source: CRM,
  });
  return { records: [...cohort, oldCreatedPeriodSale, excludedOtherProject], oldCreatedPeriodSale };
}

test("approved Lead, quality, loss, sales and revenue references coexist after integration", () => {
  const { records, oldCreatedPeriodSale } = referenceFixture();
  const unfiltered = filterHistoricalRecords(records, { managers: [], sources: [] });
  const populations = selectPeriodPopulations(unfiltered, SEPTEMBER.from, SEPTEMBER.to);
  const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);

  // The approved KPI reference is unchanged by the canonical seller field: the
  // version moves, every number below it does not.
  assert.equal(ANALYTICS_VERSION, 15);
  assert.equal(metrics.counts.leads, 470);
  assert.equal(metrics.counts.sql, 209);
  assert.equal(metrics.counts.not_relevant, 230);
  assert.equal(metrics.counts.classified_leads, 439);
  assert.equal(metrics.counts.unclassified_leads, 31);
  assert.equal(metrics.counts.sales_lost, 80);
  assert.equal(metrics.counts.cohort_sales, 41);
  assert.equal(metrics.counts.period_sales, 42);
  assert.equal(metrics.money.cohort_revenue, 18_303_500);
  assert.equal(metrics.money.revenue, 18_862_500);
  const crmMetrics = buildDashboardMetrics(
    filterHistoricalRecords(populations.cohort, { sources: [CRM] }),
    filterHistoricalRecords(populations.periodSales, { sources: [CRM] }),
  );
  assert.equal(crmMetrics.counts.leads, 448, "Source is a subset filter, not Lead membership authority");
  assert.equal(populations.cohort.some((row) => row.dealId === oldCreatedPeriodSale.dealId), false);
  assert.equal(populations.periodSales.filter((row) => row.dealId === oldCreatedPeriodSale.dealId).length, 1);
  assert.equal(metrics.eligible.some((row) => row.dealId === "outside"), false,
    "definitive non-membership stays authoritative regardless of Source");
});

test("historical Manager + Source share seller-only OR/AND semantics across records and Stage Funnel", () => {
  const handedOver = deal(1, {
    dealId: "sold-by-ali", salesStatus: "WON", qualified: true,
    wonAt: "2026-09-05T12:00:00+05:00", salesManagerId: "ali", salesManager: "Ali",
    assignedManagerId: "madina", assignedManager: "Madina", source: CRM,
  });
  const sanjar = deal(2, { dealId: "sanjar-referral", salesManagerId: "sanjar", salesManager: "Sanjar", source: "Referral" });
  const dilnoza = deal(3, { dealId: "dilnoza-crm", salesManagerId: "dilnoza", salesManager: "Dilnoza", source: CRM });
  const rows = [handedOver, sanjar, dilnoza];

  assert.deepEqual(filterHistoricalRecords(rows, { managers: ["ali", "sanjar"], sources: [CRM, "Referral"] }).map((row) => row.dealId),
    ["sold-by-ali", "sanjar-referral"], "OR within dimensions, AND across them");
  assert.deepEqual(filterHistoricalRecords(rows, { managers: ["madina"] }), [],
    "post-sale assignee is not a historical seller");
  assert.deepEqual(filterStageHistoryRecords(rows, { managers: ["ali"], sources: [CRM] }).map((row) => row.dealId),
    ["sold-by-ali"], "historical Stage Funnel uses the same seller and Source predicate");
  assert.deepEqual(filterCurrentStageRecords(rows, { managers: ["madina"] }).map((row) => row.dealId),
    ["sold-by-ali"], "live workload remains keyed by current assignee");
});
