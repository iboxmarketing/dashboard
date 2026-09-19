import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAnalyticsRecords, type RawStageHistory } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import {
  buildPeriodSalesDiscoveryRequest,
  nextDealDiscoveryScope,
  uniqueDiscoveryIds,
} from "../lib/period-sales-coverage";
import type { AnalyticsRecord } from "../lib/types";

const SALES = "3";
const POST_SALE = "13";
const PAYMENT = "C3:PAYMENT";
const SEPT_FROM = Date.parse("2026-08-31T19:00:00.000Z");
const SEPT_TO = Date.parse("2026-09-19T18:59:59.999Z");

function history(dealId: string, categoryId: string, stageId: string, at: string): RawStageHistory {
  return { OWNER_ID: dealId, CATEGORY_ID: categoryId, STAGE_ID: stageId, CREATED_TIME: at };
}

function records(
  deals: Record<string, unknown>[],
  stageHistories: RawStageHistory[],
): AnalyticsRecord[] {
  return buildAnalyticsRecords({
    deals,
    stageHistories,
    settings: {
      ...defaultSettings,
      selectedPipelineIds: [SALES],
      postSalePipelineIds: [POST_SALE],
      paymentStageIds: [PAYMENT],
    },
    users: new Map(),
    pipelines: new Map([[SALES, "IBOX Sales"], [POST_SALE, "IBOX Post-sale"], ["1", "IDOKON"]]),
    stages: new Map([["C3:NEW", "New"], [PAYMENT, "Оплата получена"], ["C13:NEW", "Post-sale"], ["C1:NEW", "IDOKON"]]),
    sources: new Map(),
    domain: null,
    stageHistoryAvailable: true,
  });
}

function deal(id: string, createdAt: string, movedAt: string, categoryId = SALES, stageId = PAYMENT) {
  return {
    ID: id,
    TITLE: `Deal ${id}`,
    DATE_CREATE: createdAt,
    DATE_MODIFY: "2026-09-18T12:00:00+05:00",
    MOVED_TIME: movedAt,
    CATEGORY_ID: categoryId,
    STAGE_ID: stageId,
    OPPORTUNITY: "100",
    CURRENCY_ID: "UZS",
  };
}

test("A/B/C: creation cohort and wonAt period stay independent on the real metric path", () => {
  const rows = records([
    deal("40099", "2026-08-20T09:00:00+05:00", "2026-09-05T10:00:00+05:00"),
    deal("september-sale", "2026-09-10T09:00:00+05:00", "2026-09-15T10:00:00+05:00"),
    deal("october-sale", "2026-09-15T09:00:00+05:00", "2026-10-05T10:00:00+05:00"),
  ], [
    history("40099", SALES, PAYMENT, "2026-09-05T10:00:00+05:00"),
    history("september-sale", SALES, PAYMENT, "2026-09-15T10:00:00+05:00"),
    history("october-sale", SALES, PAYMENT, "2026-10-05T10:00:00+05:00"),
  ]);
  const populations = selectPeriodPopulations(rows, SEPT_FROM, SEPT_TO);
  const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);

  assert.deepEqual(populations.cohort.map((row) => row.dealId), ["september-sale", "october-sale"]);
  assert.deepEqual(metrics.cohortSales.map((row) => row.dealId), ["september-sale", "october-sale"],
    "a September Lead sold in October remains a September cohort sale");
  assert.deepEqual(metrics.periodSales.map((row) => row.dealId), ["40099", "september-sale"],
    "the older-created Deal is present only through its September wonAt");
  assert.equal(metrics.counts.cohort_sales, 2);
  assert.equal(metrics.counts.period_sales, 2);
});

test("D: DATE_MODIFY never becomes wonAt", () => {
  const [row] = records([{
    ...deal("no-payment-date", "2026-08-20T09:00:00+05:00", ""),
    DATE_MODIFY: "2026-09-05T10:00:00+05:00",
  }], []);
  assert.equal(row.salesStatus, "WON", "the current payment stage still proves the sale");
  assert.equal(row.wonAt, null, "an unrelated edit cannot date revenue");
  assert.equal(selectPeriodPopulations([row], SEPT_FROM, SEPT_TO).periodSales.length, 0);
});

test("E: payment plus post-sale evidence produces one Deal and one period sale", () => {
  const rows = records([
    deal("both", "2026-08-20T09:00:00+05:00", "2026-09-06T10:00:00+05:00", POST_SALE, "C13:NEW"),
  ], [
    history("both", SALES, "C3:NEW", "2026-08-20T09:00:00+05:00"),
    history("both", SALES, PAYMENT, "2026-09-05T10:00:00+05:00"),
    history("both", POST_SALE, "C13:NEW", "2026-09-06T10:00:00+05:00"),
  ]);
  const populations = selectPeriodPopulations(rows, SEPT_FROM, SEPT_TO);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wonAt, new Date("2026-09-05T10:00:00+05:00").toISOString(), "first trustworthy sale evidence wins");
  assert.deepEqual(populations.periodSales.map((row) => row.dealId), ["both"]);
});

test("F: current out-of-IBOX location excludes the Lead cohort but not a proven IBOX period sale", () => {
  const rows = records([
    deal("moved-out", "2026-09-02T09:00:00+05:00", "2026-09-10T10:00:00+05:00", "1", "C1:NEW"),
  ], [
    history("moved-out", SALES, "C3:NEW", "2026-09-02T09:00:00+05:00"),
    history("moved-out", SALES, PAYMENT, "2026-09-05T10:00:00+05:00"),
  ]);
  const populations = selectPeriodPopulations(rows, SEPT_FROM, SEPT_TO);
  const metrics = buildDashboardMetrics(populations.cohort, populations.periodSales);

  assert.equal(rows[0].projectLeadMembership, "EXCLUDED");
  assert.equal(metrics.counts.leads, 0);
  assert.equal(metrics.counts.cohort_sales, 0);
  assert.equal(metrics.counts.period_sales, 1,
    "period Sales is an outcome-date population; IBOX payment history remains explicit evidence");
});

test("Full and incremental sync discover sale events independently from DATE_CREATE", () => {
  const base = {
    salesCategoryIds: [SALES],
    postSaleCategoryIds: [POST_SALE],
    paymentStageIds: [PAYMENT],
    fromIso: "2026-08-31T19:00:00.000Z",
    toIso: "2026-09-19T18:59:59.999Z",
    dealSelect: ["ID", "DATE_CREATE", "MOVED_TIME", "STAGE_ID"],
  };
  const payment = buildPeriodSalesDiscoveryRequest({ ...base, scope: "paymentHistory" })!;
  const current = buildPeriodSalesDiscoveryRequest({ ...base, scope: "currentPayment" })!;
  const postSale = buildPeriodSalesDiscoveryRequest({ ...base, scope: "postSale" })!;

  assert.equal(payment.method, "crm.stagehistory.list");
  assert.deepEqual(payment.params.filter, {
    CATEGORY_ID: SALES,
    STAGE_ID: PAYMENT,
    ">=CREATED_TIME": base.fromIso,
    "<=CREATED_TIME": base.toIso,
  });
  assert.equal(current.method, "crm.deal.list");
  assert.deepEqual(current.params.filter, {
    CATEGORY_ID: SALES,
    STAGE_ID: PAYMENT,
    ">=MOVED_TIME": base.fromIso,
    "<=MOVED_TIME": base.toIso,
  });
  assert.deepEqual(postSale.params.filter, {
    CATEGORY_ID: POST_SALE,
    TYPE_ID: 5,
    ">=CREATED_TIME": base.fromIso,
    "<=CREATED_TIME": base.toIso,
  });
  assert.doesNotMatch(JSON.stringify([
    payment.params.filter,
    current.params.filter,
    postSale.params.filter,
  ]), /DATE_MODIFY|DATE_CREATE/);
});

test("discovery scopes and IDs are bounded and deduplicated before canonical persistence", () => {
  assert.equal(nextDealDiscoveryScope("main", { hasPaymentStages: true, hasPostSale: true }), "paymentHistory");
  assert.equal(nextDealDiscoveryScope("paymentHistory", { hasPaymentStages: true, hasPostSale: true }), "currentPayment");
  assert.equal(nextDealDiscoveryScope("currentPayment", { hasPaymentStages: true, hasPostSale: true }), "postSale");
  assert.equal(nextDealDiscoveryScope("postSale", { hasPaymentStages: true, hasPostSale: true }), null);
  assert.equal(nextDealDiscoveryScope("main", { hasPaymentStages: false, hasPostSale: true }), "postSale");
  assert.equal(nextDealDiscoveryScope("paymentHistory", { hasPaymentStages: false, hasPostSale: true }), "postSale",
    "a settings change while resuming cannot loop the job back to main");
  assert.deepEqual(uniqueDiscoveryIds([{ OWNER_ID: "40099" }, { OWNER_ID: "40099" }, { OWNER_ID: "41" }], "OWNER_ID"), ["40099", "41"]);

  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /buildPeriodSalesDiscoveryRequest/);
  assert.match(sync, /idsNotFetchedInRun/);
  assert.match(sync, /upsertRaw\("raw_deals"/,
    "period-sale candidates enter the existing raw/history/analytics path, not a parallel metric");
});
