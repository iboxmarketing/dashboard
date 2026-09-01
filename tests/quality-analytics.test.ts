import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { buildQualityAnalytics } from "../lib/quality-analytics";
import { isPreSqlClosed, isSalesLost, MISSING_LOSS_REASON } from "../lib/sales-logic";
import type { AnalyticsRecord } from "../lib/types";

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null,
    salesStatus: "ACTIVE", qualified: false, lossReasonGroup: "NONE", lossReason: "",
    opportunity: 0, currencyId: "UZS", processingBusinessMinutes: null,
    salesCycleHours: null, slaStatus: "PENDING", source: "CRM-форма",
    stage: "Распределение", currentScope: null, customerKey: null, duplicateOfDealId: null,
    salesManagerId: "a", salesManager: "Ali", assignedManagerId: "a", assignedManager: "Ali",
    stageHistoryCount: 1, ...over,
  } as unknown as AnalyticsRecord;
}

const ALI = { salesManagerId: "a", salesManager: "Ali" };
const BOB = { salesManagerId: "b", salesManager: "Bob" };

const FIXTURE = [
  // Ali: 3 SQL (one sale, one Sales Lost, one active) + 2 Not Relevant.
  deal({ dealId: "a-won", ...ALI, qualified: true, salesStatus: "WON", wonAt: "2026-08-08T09:00:00.000Z" }),
  deal({ dealId: "a-lost", ...ALI, qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "Отсрочка" }),
  deal({ dealId: "a-sql", ...ALI, qualified: true }),
  deal({ dealId: "a-nr-filled", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Campaign" }),
  deal({ dealId: "a-nr-blank", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "" }),
  // A closed card that never reached SQL stays outside canonical Sales Lost.
  deal({ dealId: "a-pre-sql", ...ALI, salesStatus: "LOST", qualified: false, lossReasonGroup: "SALES", lossReason: "Игнорить" }),

  // Bob: 4 SQL (one sale, three Sales Lost) + one Not Relevant.
  deal({ dealId: "b-won", ...BOB, qualified: true, salesStatus: "WON", wonAt: "2026-08-09T09:00:00.000Z" }),
  deal({ dealId: "b-lost-1", ...BOB, qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "Дорого" }),
  deal({ dealId: "b-lost-2", ...BOB, qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "Дорого" }),
  deal({ dealId: "b-lost-blank", ...BOB, qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "" }),
  deal({ dealId: "b-nr", ...BOB, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Organic" }),

  // No classification evidence: both manager rates must stay unavailable.
  deal({ dealId: "c-open", salesManagerId: "c", salesManager: "Cora" }),

  // SALES semantics win over misleading Bitrix reason text.
  deal({ dealId: "unknown-sales", salesManagerId: null, salesManager: null, qualified: true,
    salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "Игнорить (Not relevant)" }),
  deal({ dealId: "unknown-nr", salesManagerId: null, salesManager: null,
    salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "" }),

  // Routing-only manager must be visible only in Routing diagnostics.
  deal({ dealId: "route", salesManagerId: "route", salesManager: "Router", salesStatus: "LOST",
    lossReasonGroup: "ROUTING", lossReason: "Idokon" }),
];

const analytics = buildQualityAnalytics(FIXTURE);
const marketing = (id: string) => analytics.marketingManagers.find((row) => row.id === id)!;
const sales = (id: string) => analytics.salesManagers.find((row) => row.id === id)!;

test("A/B/C/D: canonical populations separate Routing, Marketing and Sales Lost", () => {
  assert.equal(analytics.summary.leads, FIXTURE.length - 1, "A: Routing is excluded from Leadlar");
  assert.equal(analytics.summary.routing, 1, "Routing remains separately diagnosable");
  assert.equal(analytics.summary.notRelevant, 4, "B: only MARKETING records are Not Relevant");
  assert.equal(analytics.summary.salesLost, 5, "C: canonical isSalesLost population");
  assert.equal(FIXTURE.filter(isPreSqlClosed).length, 1);
  assert.equal(FIXTURE.filter(isSalesLost).some((row) => row.dealId === "a-pre-sql"), false, "D: pre-SQL closed is absent");
});

test("E/F: global top-reason shares use their own canonical population", () => {
  assert.deepEqual(analytics.summary.topMarketingReason, { reason: "Sabab ko‘rsatilmagan", count: 2, share: 50 },
    "E: top Marketing denominator is four Not Relevant records");
  assert.deepEqual(analytics.summary.topSalesReason, { reason: "Дорого", count: 2, share: 40 },
    "F: top Sales denominator is five canonical Sales Lost records");
  assert.equal(analytics.marketingReasons.reduce((sum, row) => sum + row.count, 0), analytics.summary.notRelevant);
  assert.equal(analytics.salesReasons.reduce((sum, row) => sum + row.count, 0), analytics.summary.salesLost);
});

test("G/H: missing-reason discipline uses only Not Relevant plus Sales Lost", () => {
  assert.equal(analytics.summary.missingReasons, 3, "two NR blanks plus one Sales Lost blank");
  assert.equal(analytics.summary.missingReasonPopulation, 9, "G: NR + canonical Sales Lost only");
  assert.equal(analytics.summary.missingReasonRate, 33, "H: 3 / 9");
  assert.equal(analytics.summary.missingReasonPopulation,
    analytics.summary.notRelevant + analytics.summary.salesLost);
});

test("I/J/K/L/U: Marketing manager diagnostics use classified and manager NR only", () => {
  assert.deepEqual([marketing("a").notRelevant, marketing("a").classified, marketing("a").notRelevantRate], [2, 5, 40], "I");
  assert.equal(marketing("c").notRelevantRate, null, "J: classified=0 is unavailable");
  assert.deepEqual(marketing("a").topReason, { reason: "Campaign", count: 1, share: 50 }, "K: Ali's own NR only");
  assert.deepEqual([marketing("a").missingReasons, marketing("a").reasonFillRate], [1, 50], "L");
  assert.equal(marketing("c").smallSample, true, "U: classified < 3");
  assert.equal(marketing("a").smallSample, false);
});

test("M/N/O/P/Q/V: Sales manager diagnostics use SQL and canonical manager metrics", () => {
  assert.deepEqual([sales("b").salesLost, sales("b").sql, sales("b").salesLostRate], [3, 4, 75], "M");
  assert.deepEqual([sales("c").salesLostRate, sales("c").sqlToSale], [null, null], "N: SQL=0 is unavailable");
  const bobMetrics = buildDashboardMetrics(FIXTURE.filter((row) => row.salesManagerId === "b"), []);
  assert.equal(sales("b").sqlToSale, bobMetrics.rates.sql_to_sale, "O: SQL→Sale is canonical");
  assert.deepEqual(sales("b").topReason, { reason: "Дорого", count: 2, share: 67 }, "P: Bob's Sales Lost only");
  assert.equal(sales("a").salesLost, 1, "Q: Ali's pre-SQL closure does not enter Sales Lost");
  assert.equal(sales("a").topReasons.some((row) => row.reason === "Игнорить"), false, "pre-SQL reason absent");
  assert.equal(sales("c").smallSample, true, "V: SQL < 3");
  assert.equal(sales("b").smallSample, false);
});

test("R/S/T: Routing and reason text cannot cross canonical boundaries", () => {
  assert.equal(analytics.marketingManagers.some((row) => row.id === "route"), false, "R: no Routing-only manager in Marketing table");
  assert.equal(analytics.salesManagers.some((row) => row.id === "route"), false, "R: no Routing-only manager in Sales table");
  const misleading = FIXTURE.find((row) => row.dealId === "unknown-sales")!;
  assert.equal(isSalesLost(misleading), true, "S: SALES + qualified stays Sales Lost despite text");
  assert.equal(analytics.salesReasons.some((row) => row.reason.includes("(Not relevant)")), true);
  assert.equal(analytics.marketingReasons.some((row) => row.reason.includes("(Not relevant)")), false);
  assert.deepEqual([marketing("unknown").name, sales("unknown").name], ["Aniqlanmagan", "Aniqlanmagan"], "T");
  assert.equal(analytics.marketingManagers.at(-1)?.id, "unknown", "unknown is below seller rankings");
  assert.equal(analytics.salesManagers.at(-1)?.id, "unknown");
});

test("Y: Routing reasons stay out of both reason panels", () => {
  assert.equal(analytics.routingReasons.some((row) => row.reason === "Idokon"), true, "Y: Routing keeps its own breakdown");
  assert.equal(analytics.marketingReasons.some((row) => row.reason === "Idokon"), false, "Y: Routing absent from the Marketing panel");
  assert.equal(analytics.salesReasons.some((row) => row.reason === "Idokon"), false, "Y: Routing absent from the Sales Lost panel");
});

test("zero and null presentation inputs stay distinct", () => {
  assert.equal(marketing("c").notRelevant, 0, "real count zero stays zero");
  assert.equal(marketing("c").reasonFillRate, null, "no NR denominator is unavailable");
  assert.equal(sales("c").salesLost, 0);
  const empty = buildQualityAnalytics([]).summary;
  assert.equal(empty.classificationCoverage, null);
  assert.equal(empty.missingReasonRate, null);
});

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const view = client.slice(client.indexOf("function QualityView("), client.indexOf("function StageControlView("));

test("W/X: old mixed ranking is gone and Routing is no longer a headline KPI", () => {
  assert.doesNotMatch(view, /Qaysi sabab qaysi menejerda ko‘p/, "W");
  const headline = view.slice(view.indexOf("quality-kpis"), view.indexOf("quality-reasons"));
  assert.doesNotMatch(headline, /label="Routing"/, "X");
  assert.match(view, /title="Routing"/);
});

test("missing-reason discipline counts the sentinel the sync actually stores", () => {
  // Bitrix leaves the reason blank on many closed deals and lib/analytics.ts
  // stamps MISSING_LOSS_REASON into lossReason before it is persisted, so a
  // check that only tests for "" reports zero missing reasons on real data.
  const cohort = [
    deal({ dealId: "s-1", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: MISSING_LOSS_REASON }),
    deal({ dealId: "s-2", ...ALI, qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: MISSING_LOSS_REASON }),
    deal({ dealId: "s-3", ...ALI, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Campaign" }),
  ];
  const out = buildQualityAnalytics(cohort);
  assert.equal(out.summary.missingReasonPopulation, 3);
  assert.equal(out.summary.missingReasons, 2, "stored sentinel counts as missing");
  assert.equal(out.summary.missingReasonRate, 67);
  assert.equal(out.marketingManagers[0].missingReasons, 1);
  assert.equal(out.marketingManagers[0].reasonFillRate, 50, "fill rate must not read 100%");
  assert.equal(out.salesManagers[0].missingReasons, 1);
});
