import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { defaultSettings } from "../lib/business-time";
import { dealSalesSnapshots } from "../db/schema";
import { buildStageRules } from "../scripts/ibox-sql-evidence.mjs";
import { classifyWonEvidence } from "../scripts/ibox-sales-evidence.mjs";
import { buildRevenueReference, parseOpportunity } from "../scripts/ibox-revenue-evidence.mjs";

/**
 * Revenue ("Sotuv summasi") audit vs the real dashboard pipeline: same
 * Bitrix-shaped Deals through buildAnalyticsRecords -> selectPeriodPopulations ->
 * buildDashboardMetrics, compared with the live reference. Findings are asserted
 * so they cannot silently disappear.
 */
const STAGES: [string, string, number][] = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:WON", "Оплата получена", 100],
];
const stages = new Map(STAGES.map(([id, name]) => [id, name]));
const stageMeta = new Map(STAGES.map(([id, , sort]) => [id, { sort, categoryId: "3" }]));
const rules = buildStageRules(STAGES.map(([STATUS_ID, NAME, SORT]) => ({ STATUS_ID, NAME, SORT })));
const settings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"], postSalePipelineIds: ["13"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], paymentStageIds: ["C3:WON"], failureReasonField: "",
};
const FROM = Date.parse("2026-09-01T00:00:00+05:00");
const TO = Date.parse("2026-09-19T23:59:59.999+05:00");

type Sale = { id: string; created: string; paid: string; opportunity?: unknown; currency?: string };
const raw = (deal: Sale) => ({
  ID: deal.id, TITLE: "t", CATEGORY_ID: "3", STAGE_ID: "C3:WON", DATE_CREATE: deal.created, DATE_MODIFY: "2026-09-19T09:00:00+05:00",
  MOVED_TIME: deal.paid, ASSIGNED_BY_ID: "7", CURRENCY_ID: deal.currency ?? "UZS",
  ...(deal.opportunity === undefined ? {} : { OPPORTUNITY: deal.opportunity }),
});

function records(sales: Sale[], snapshots = new Map()) {
  return buildAnalyticsRecords({
    deals: sales.map(raw),
    stageHistories: sales.flatMap((deal) => [
      { OWNER_ID: deal.id, CATEGORY_ID: "3", STAGE_ID: "C3:NEW", CREATED_TIME: deal.created },
      { OWNER_ID: deal.id, CATEGORY_ID: "3", STAGE_ID: "C3:WON", CREATED_TIME: deal.paid },
    ]),
    settings: settings as never, users: new Map([["7", "Menejer"]]),
    pipelines: new Map([["3", "IBOX sales"], ["13", "Post-sale"]]), stages, stageMeta,
    sources: new Map(), fieldOptions: new Map(), snapshots, domain: null, stageHistoryAvailable: true,
  } as never);
}
const metricsFor = (recs: ReturnType<typeof records>) => {
  const populations = selectPeriodPopulations(recs as never, FROM, TO);
  return { populations, metrics: buildDashboardMetrics(populations.cohort as never, populations.periodSales as never) };
};

const OLD_LEAD: Sale = { id: "40099", created: "2026-08-20T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "4000000" };
const NEW_LEAD_PAID_LATER: Sale = { id: "2", created: "2026-09-10T09:00:00+05:00", paid: "2026-10-05T10:00:00+05:00", opportunity: "700000" };
const NEW_LEAD_PAID_IN_RANGE: Sale = { id: "3", created: "2026-09-10T09:00:00+05:00", paid: "2026-09-12T10:00:00+05:00", opportunity: "1500000.50" };

test("period revenue is keyed on wonAt, not DATE_CREATE: an old lead paid in the period contributes", () => {
  const { populations, metrics } = metricsFor(records([OLD_LEAD, NEW_LEAD_PAID_LATER, NEW_LEAD_PAID_IN_RANGE]));
  assert.deepEqual(populations.periodSales.map((row) => row.dealId).sort(), ["3", "40099"]);
  assert.equal(metrics.money.revenue, 5500000.5, "the August lead paid in September counts, the October payment does not");
});

test("cohort revenue and period revenue are separate populations", () => {
  const { populations, metrics } = metricsFor(records([OLD_LEAD, NEW_LEAD_PAID_LATER, NEW_LEAD_PAID_IN_RANGE]));
  assert.deepEqual(populations.cohort.map((row) => row.dealId).sort(), ["2", "3"]);
  assert.equal(metrics.money.cohort_revenue, 2200000.5);
  assert.notEqual(metrics.money.cohort_revenue, metrics.money.revenue);
});

test("the live reference agrees with the dashboard revenue for the same Deals when no snapshot interferes", () => {
  const sales = [OLD_LEAD, NEW_LEAD_PAID_LATER, NEW_LEAD_PAID_IN_RANGE];
  const { metrics } = metricsFor(records(sales));
  const referenceRows = sales.flatMap((deal) => {
    const evidence = classifyWonEvidence({
      deal: { CATEGORY_ID: "3", STAGE_ID: "C3:WON", MOVED_TIME: deal.paid },
      history: [{ STAGE_ID: "C3:NEW", CREATED_TIME: deal.created }, { STAGE_ID: "C3:WON", CREATED_TIME: deal.paid }],
      postSaleHistory: [], categoryId: "3", postSaleCategoryId: "13", rules,
    });
    const inPeriod = evidence.wonAt !== null && Date.parse(evidence.wonAt) >= FROM && Date.parse(evidence.wonAt) <= TO;
    return inPeriod ? [{ dealId: deal.id, sourceId: "", sourceLabel: "", currency: deal.currency ?? "UZS", ...parseOpportunity(deal.opportunity) }] : [];
  });
  assert.equal(Number(buildRevenueReference(referenceRows).total.exact), metrics.money.revenue);
});

test("FINDING: a missing or non-numeric OPPORTUNITY is stored as 0, a negative one subtracts, and zeros enter the average", () => {
  const sales: Sale[] = [
    { id: "1", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "1000" },
    { id: "2", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00" },
    { id: "3", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "1 500" },
    { id: "4", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "-300" },
  ];
  const recs = records(sales);
  const byId = new Map(recs.map((row) => [row.dealId, row]));
  assert.equal(byId.get("2")!.opportunity, 0, "missing -> 0");
  assert.equal(byId.get("3")!.opportunity, 0, "non-numeric -> 0");
  assert.equal(byId.get("4")!.opportunity, -300);
  const { metrics } = metricsFor(recs);
  assert.equal(metrics.money.revenue, 700, "1000 + 0 + 0 - 300");
  assert.equal(metrics.money.avg_check, 175, "the average includes the zero-valued sales");
  // The reference reads the same Deals and can tell the states apart.
  assert.deepEqual(sales.map((sale) => parseOpportunity(sale.opportunity).state), ["POSITIVE", "MISSING", "INVALID", "NEGATIVE"]);
});

test("FINDING: multiple currencies are summed into one number and labelled with the first sale's currency", () => {
  const sales: Sale[] = [
    { id: "1", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "1000000", currency: "UZS" },
    { id: "2", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-06T10:00:00+05:00", opportunity: "100", currency: "USD" },
  ];
  const { metrics } = metricsFor(records(sales));
  assert.equal(metrics.money.revenue, 1000100, "UZS and USD are added without conversion");
  assert.equal(metrics.money.currency, "UZS", "the label is periodSales[0].currencyId, not a check that one currency was used");
});

test("FINDING: an empty CURRENCY_ID has no currency guard; the client falls back to UZS for display", async () => {
  const { metrics } = metricsFor(records([{ id: "1", created: "2026-09-02T09:00:00+05:00", paid: "2026-09-05T10:00:00+05:00", opportunity: "500", currency: "" }]));
  assert.equal(metrics.money.currency, "");
  const client = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  assert.match(client, /metrics\.money\.currency \|\| "UZS"/);
});

test("FINDING: the frozen snapshot holds wonAt only, so a stale snapshot date moves a sale out of the period while live history says it is in", () => {
  assert.deepEqual(Object.keys(dealSalesSnapshots).filter((key) => ["dealId", "wonAt", "managerId", "managerName", "attributionSource", "createdAt", "opportunity", "currencyId"].includes(key)).sort(),
    ["attributionSource", "createdAt", "dealId", "managerId", "managerName", "wonAt"], "no amount or currency is frozen, only the date and the seller");

  const sale = NEW_LEAD_PAID_IN_RANGE;
  const live = metricsFor(records([sale])).metrics.money.revenue;
  const snapshots = new Map([[sale.id, { dealId: sale.id, wonAt: "2026-08-30T10:00:00+05:00", managerId: "7", managerName: "Menejer", attributionSource: "STAGE_MOVER" }]]);
  const frozen = metricsFor(records([sale], snapshots as never)).metrics.money.revenue;
  assert.equal(live, 1500000.5);
  assert.equal(frozen, 0, "the snapshot date (before the range) wins over live history, so the sale drops out of period revenue");
});

test("FINDING: the amount follows the Deal at the last sync, not the payment: changing OPPORTUNITY changes revenue with no change to wonAt", () => {
  const before = metricsFor(records([{ ...NEW_LEAD_PAID_IN_RANGE, opportunity: "1000000" }])).metrics.money.revenue;
  const after = metricsFor(records([{ ...NEW_LEAD_PAID_IN_RANGE, opportunity: "9000000" }])).metrics.money.revenue;
  assert.equal(before, 1000000);
  assert.equal(after, 9000000, "OPPORTUNITY is an editable Deal amount, not a payment record");
});
