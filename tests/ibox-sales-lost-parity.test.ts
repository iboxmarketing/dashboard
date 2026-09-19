import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { isEligibleCohortDeal, isPreSqlClosed, isSalesLost } from "../lib/sales-logic";
import type { AnalyticsRecord } from "../lib/types";

function deal(over: Partial<AnalyticsRecord>): AnalyticsRecord {
  return {
    dealId: "1",
    createdAt: "2026-09-10T07:00:00.000Z",
    wonAt: null,
    salesStatus: "LOST",
    qualified: true,
    qualifiedStageId: "C3:SQL",
    lossReasonGroup: "SALES",
    opportunity: 0,
    currencyId: "UZS",
    processingBusinessMinutes: 10,
    salesCycleHours: null,
    slaStatus: "ON_TIME",
    customerKey: null,
    duplicateOfDealId: null,
    ...over,
  } as unknown as AnalyticsRecord;
}

test("dashboard Sales Lost formula matches the live reference for worked and direct ordinary closures", () => {
  const worked = deal({ dealId: "worked" });
  const direct = deal({ dealId: "direct", qualifiedStageId: null });
  const routing = deal({ dealId: "routing", lossReasonGroup: "ROUTING" });
  const notRelevant = deal({ dealId: "nr", salesStatus: "LOW_QUALITY", qualified: false, lossReasonGroup: "MARKETING" });

  assert.equal(isSalesLost(worked), true);
  assert.equal(isSalesLost(direct), true, "a direct ordinary closure is still Sales Lost");
  assert.equal(isPreSqlClosed(direct), true, "the same Deal remains visible as preSqlClosed");
  assert.equal(isSalesLost(routing), false);
  assert.equal(isSalesLost(notRelevant), false);

  const metrics = buildDashboardMetrics([worked, direct, routing, notRelevant], []);
  assert.deepEqual(metrics.salesLost.map((row) => row.dealId), ["worked", "direct"]);
  assert.deepEqual(metrics.preSqlClosed.map((row) => row.dealId), ["direct"]);
  assert.equal(metrics.salesLost.every((row) => metrics.sql.includes(row)), true, "Sales Lost is a strict SQL subset");
  assert.equal(metrics.salesLost.some((row) => metrics.notRelevant.includes(row)), false);
});

test("current dashboard mismatch is population scope, not the Sales Lost formula", () => {
  const movedToAnotherProject = deal({ dealId: "moved", currentScope: "OUT_OF_SCOPE" });
  assert.equal(isEligibleCohortDeal(movedToAnotherProject), true,
    "this branch still ignores current project membership unless the failure reason is ROUTING");
  const metrics = buildDashboardMetrics([movedToAnotherProject], []);
  assert.equal(metrics.counts.sales_lost, 1,
    "live canonical reference excludes this Deal before Sales Lost; dashboard can retain it until Lead membership is wired");
});
