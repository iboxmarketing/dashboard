import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { defaultSettings } from "../lib/business-time";
import type { AnalyticsRecord } from "../lib/types";
import { buildStageRules } from "../scripts/ibox-sql-evidence.mjs";
import { classifyWonEvidence } from "../scripts/ibox-sales-evidence.mjs";

/**
 * The live Sotuv reference (scripts/ibox-sales-evidence.mjs) against the real
 * dashboard pipeline. The same Bitrix-shaped history goes through both. The only
 * allowed differences are the documented ones asserted at the bottom.
 */
const STAGES: [string, string, number, string?][] = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:UC_C0725V", "Not relevant", 120],
];
const stages = new Map(STAGES.map(([id, name]) => [id, name]));
const stageMeta = new Map(STAGES.map(([id, , sort]) => [id, { sort, categoryId: "3" }]));
const rules = buildStageRules(STAGES.map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) })));

const settings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"], postSalePipelineIds: ["13"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"],
  closedLostStageIds: ["C3:LOSE"], paymentStageIds: ["C3:WON"], failureReasonField: "",
};

const at = (day: number, hour = 10) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+05:00`;
type Row = [stageId: string, time: string, category?: string];
type Scenario = { name: string; rows: Row[]; category?: string; current: string; moved?: string | null };

function dashboardRecord(scenario: Scenario): AnalyticsRecord {
  const deals = [{
    ID: "1", TITLE: "t", CATEGORY_ID: scenario.category ?? "3", STAGE_ID: scenario.current,
    DATE_CREATE: at(2, 9), DATE_MODIFY: at(19), CLOSEDATE: at(19),
    ...(scenario.moved === null ? {} : { MOVED_TIME: scenario.moved ?? at(19) }),
    ASSIGNED_BY_ID: "7", OPPORTUNITY: "100", CURRENCY_ID: "UZS",
  }];
  const stageHistories = scenario.rows.map(([stageId, time, category]) => ({ OWNER_ID: "1", CATEGORY_ID: category ?? "3", STAGE_ID: stageId, CREATED_TIME: time }));
  const [record] = buildAnalyticsRecords({
    deals, stageHistories, settings: settings as never, users: new Map([["7", "Menejer"]]),
    pipelines: new Map([["3", "IBOX sales"], ["13", "Post-sale"]]), stages, stageMeta,
    sources: new Map(), fieldOptions: new Map(), snapshots: new Map(), domain: null, stageHistoryAvailable: true,
  } as never);
  return record;
}

function reference(scenario: Scenario) {
  const toRow = ([stageId, time, category]: Row) => ({ STAGE_ID: stageId, CREATED_TIME: time, CATEGORY_ID: category ?? "3" });
  return classifyWonEvidence({
    deal: {
      CATEGORY_ID: scenario.category ?? "3", STAGE_ID: scenario.current,
      DATE_MODIFY: at(19), ...(scenario.moved === null ? {} : { MOVED_TIME: scenario.moved ?? at(19) }),
    },
    history: scenario.rows.filter(([, , category]) => (category ?? "3") === "3").map(toRow),
    postSaleHistory: scenario.rows.filter(([, , category]) => category === "13").map(toRow),
    categoryId: "3", postSaleCategoryId: "13", rules,
  });
}

const scenarios: Scenario[] = [
  { name: "payment history, still in Sales", rows: [["C3:NEW", at(3)], ["C3:UC_9SUEMM", at(4)], ["C3:WON", at(5)]], current: "C3:WON" },
  { name: "payment, then moved to post-sale", rows: [["C3:NEW", at(3)], ["C3:WON", at(5)], ["C13:NEW", at(7), "13"]], category: "13", current: "C13:NEW" },
  { name: "moved to post-sale without a payment stage", rows: [["C3:NEW", at(3)], ["C13:NEW", at(8), "13"]], category: "13", current: "C13:NEW" },
  { name: "currently in post-sale, no history rows there", rows: [["C3:NEW", at(3)]], category: "13", current: "C13:NEW" },
  { name: "current payment stage, no history row, has MOVED_TIME", rows: [["C3:NEW", at(3)]], current: "C3:WON", moved: at(11) },
  { name: "current payment stage, no MOVED_TIME (DATE_MODIFY exists)", rows: [["C3:NEW", at(3)]], current: "C3:WON", moved: null },
  { name: "paid, then Not Relevant (evidence earlier)", rows: [["C3:NEW", at(3)], ["C3:WON", at(5)], ["C3:UC_C0725V", at(6)]], current: "C3:UC_C0725V" },
  { name: "plain Not Relevant", rows: [["C3:NEW", at(3)], ["C3:UC_C0725V", at(4)]], current: "C3:UC_C0725V" },
  { name: "active in Обработка", rows: [["C3:NEW", at(3)], ["C3:UC_9SUEMM", at(4)]], current: "C3:UC_9SUEMM" },
  { name: "Sales Lost, never paid", rows: [["C3:NEW", at(3)], ["C3:UC_9SUEMM", at(4)], ["C3:LOSE", at(5)]], current: "C3:LOSE" },
  { name: "post-sale row earlier than payment row: payment history dates the sale", rows: [["C3:NEW", at(3)], ["C13:NEW", at(6), "13"], ["C3:WON", at(9)]], current: "C3:WON" },
];

for (const scenario of scenarios) {
  test(`parity: ${scenario.name}`, () => {
    const record = dashboardRecord(scenario);
    const ref = reference(scenario);
    assert.equal(record.salesStatus === "WON", ref.won, "WON verdict must match");
    assert.equal(record.wonAt, ref.wonAt, "wonAt must match; DATE_MODIFY is never a payment date");
    assert.equal(record.wonAt === null && record.salesStatus === "WON", ref.won && ref.wonAt === null);
  });
}

test("period and cohort sales: dashboard populations equal the reference except the documented Not Relevant case", () => {
  const fromMs = Date.parse(at(1, 0));
  const toMs = Date.parse(at(19, 23));
  for (const scenario of scenarios) {
    const record = dashboardRecord(scenario);
    const ref = reference(scenario);
    const populations = selectPeriodPopulations([record] as never, fromMs, toMs);
    const referencePeriod = ref.counted && ref.wonAt !== null && Date.parse(ref.wonAt) >= fromMs && Date.parse(ref.wonAt) <= toMs;
    assert.equal(populations.periodSales.length === 1, referencePeriod, `${scenario.name}: period sales`);
    const cohortSales = buildDashboardMetrics(populations.cohort as never, populations.periodSales as never).cohortSales.length === 1;
    assert.equal(cohortSales, ref.counted, `${scenario.name}: cohort sales`);
  }
});

test("documented difference: a Not Relevant current stage with payment evidence NOT provably earlier is a sale in the dashboard only", () => {
  const scenario: Scenario = { name: "NR then payment", rows: [["C3:NEW", at(3)], ["C3:UC_C0725V", at(4)], ["C3:WON", at(5)]], current: "C3:UC_C0725V" };
  const record = dashboardRecord(scenario);
  const ref = reference(scenario);
  assert.equal(record.salesStatus, "WON", "the dashboard gives payment evidence precedence over Not Relevant");
  assert.equal(ref.won, true);
  assert.equal(ref.currentNotRelevant, true);
  assert.equal(ref.evidenceEarlierThanNotRelevant, false);
  assert.equal(ref.counted, false, "the reference does not count it as a sale; it is listed as a conflict");
});

test("documented difference: a Deal that is WON by payment and Not Relevant keeps SQL and Sales mutually consistent in the dashboard", () => {
  const record = dashboardRecord(scenarios[6]);
  const metrics = buildDashboardMetrics([record] as never, []);
  assert.equal(metrics.sql.length, 1);
  assert.equal(metrics.cohortSales.length, 1);
  assert.equal(metrics.notRelevant.length, 0, "WON precedence removes it from Not Relevant");
});
