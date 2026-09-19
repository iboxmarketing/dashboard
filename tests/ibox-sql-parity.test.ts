import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { defaultSettings } from "../lib/business-time";
import { isEligibleCohortDeal, isPreSqlClosed } from "../lib/sales-logic";
import type { AnalyticsRecord } from "../lib/types";
import { DASHBOARD_ROUTING_PATTERNS, buildStageRules, classifySqlEvidence } from "../scripts/ibox-sql-evidence.mjs";

/**
 * Parity between the live read-only SQL reference (scripts/ibox-sql-evidence.mjs)
 * and the dashboard's real record builder. The same Bitrix-shaped scenario goes
 * through both; the only allowed differences are the two documented ones.
 */
const STAGES: [string, string, number, string?][] = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_05P04E", "НЕТ ОТВЕТА", 20],
  ["C3:UC_L52PGZ", "Первое касание", 40],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:PREPARATION", "ВСТРЕЧА НАЗНАЧЕНА", 60],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:UC_C0725V", "Not relevant", 120],
];
const stages = new Map(STAGES.map(([id, name]) => [id, name]));
const stageMeta = new Map(STAGES.map(([id, , sort]) => [id, { sort, categoryId: "3" }]));
const catalogRows = STAGES.map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) }));
const rules = buildStageRules(catalogRows);

const settings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"], postSalePipelineIds: ["13"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"],
  closedLostStageIds: ["C3:LOSE"], paymentStageIds: ["C3:WON"],
};

type Scenario = { name: string; path: string[]; current?: string; reason?: string; category?: string };

function dashboardRecord(scenario: Scenario): AnalyticsRecord {
  const current = scenario.current ?? scenario.path[scenario.path.length - 1] ?? "C3:NEW";
  const deals = [{
    ID: "1", TITLE: "t", CATEGORY_ID: scenario.category ?? "3", STAGE_ID: current,
    DATE_CREATE: "2026-09-05T09:00:00+05:00", DATE_MODIFY: "2026-09-10T09:00:00+05:00",
    MOVED_TIME: "2026-09-10T09:00:00+05:00", CLOSEDATE: "2026-09-10T09:00:00+05:00",
    ASSIGNED_BY_ID: "7", OPPORTUNITY: "0", CURRENCY_ID: "UZS",
    ...(scenario.reason ? { UF_CRM_LOSS: scenario.reason } : {}),
  }];
  const stageHistories = scenario.path.map((stageId, index) => ({
    OWNER_ID: "1", CATEGORY_ID: "3", STAGE_ID: stageId, CREATED_TIME: `2026-09-0${5 + index}T09:00:00+05:00`,
    ...(stageId === "C3:LOSE" ? { STAGE_SEMANTIC_ID: "F" } : {}),
  }));
  const [record] = buildAnalyticsRecords({
    deals, stageHistories,
    settings: { ...settings, failureReasonField: scenario.reason ? "UF_CRM_LOSS" : "" } as never,
    users: new Map([["7", "Menejer"]]),
    pipelines: new Map([["3", "IBOX sales"], ["13", "Post-sale"]]),
    stages, stageMeta, sources: new Map(), fieldOptions: new Map(), snapshots: new Map(),
    domain: null, stageHistoryAvailable: true,
  } as never);
  return record;
}

function reference(scenario: Scenario): Record<string, unknown> {
  const current = scenario.current ?? scenario.path[scenario.path.length - 1] ?? "C3:NEW";
  return classifySqlEvidence({
    dealId: "1",
    deal: {
      ID: "1", CATEGORY_ID: scenario.category ?? "3", STAGE_ID: current,
      ...(current === "C3:LOSE" ? { STAGE_SEMANTIC_ID: "F" } : {}),
      UF_CRM_LOSS: scenario.reason ?? "",
    },
    history: scenario.path.map((stageId, index) => ({ STAGE_ID: stageId, CREATED_TIME: `2026-09-0${5 + index}T09:00:00+05:00` })),
    categoryId: "3", postSaleCategoryId: "13", rules,
    failureReasonField: "UF_CRM_LOSS", failureReasonOptions: { fieldFound: true, byId: new Map() },
  });
}

const scenarios: Scenario[] = [
  { name: "plain Обработка", path: ["C3:NEW", "C3:UC_9SUEMM"] },
  { name: "downstream Встреча without Обработка", path: ["C3:NEW", "C3:PREPARATION"] },
  { name: "active, never worked", path: ["C3:NEW"] },
  { name: "no answer only", path: ["C3:NEW", "C3:UC_05P04E"] },
  { name: "Not Relevant after Обработка", path: ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"] },
  { name: "Not Relevant directly", path: ["C3:NEW", "C3:UC_C0725V"] },
  { name: "paid", path: ["C3:NEW", "C3:UC_9SUEMM", "C3:WON"] },
  { name: "paid without Обработка", path: ["C3:NEW", "C3:WON"] },
  { name: "moved to post-sale", path: ["C3:NEW"], category: "13", current: "C13:NEW" },
  { name: "Sales Lost after Обработка", path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "Ushli konkurentam" },
  { name: "direct Sales Lost (preSqlClosed)", path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" },
  { name: "direct Sales Lost, no reason", path: ["C3:NEW", "C3:LOSE"] },
  { name: "Sales Lost with orphan enum reason", path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "11151" },
];

for (const scenario of scenarios) {
  test(`parity: ${scenario.name}`, () => {
    const record = dashboardRecord(scenario);
    const ref = reference(scenario);
    assert.equal(ref.classification === "SQL", record.qualified, "SQL verdict must match the dashboard record");
    assert.equal(ref.classification === "NOT_RELEVANT", record.salesStatus === "LOW_QUALITY");
    assert.equal(Boolean(ref.preSqlClosed), isPreSqlClosed(record), "preSqlClosed diagnostic must match");
    if (ref.classification === "NOT_RELEVANT") {
      // The dashboard clears qualified* for Not Relevant; the reference keeps the
      // prior visit only as a diagnostic (hasSqlEvidence), never as SQL.
      assert.equal(record.qualifiedStageId, null);
    } else {
      assert.equal(ref.evidenceStageId, record.qualifiedStageId, "real evidence stage must match; nothing is fabricated");
      assert.equal(ref.qualifiedAt !== null, record.qualifiedAt !== null);
    }
    assert.equal(isEligibleCohortDeal(record), true, "these scenarios are not routed");
  });
}

test("documented difference 1: a routing-reason LOST Deal still in IBOX is a Lead, but the dashboard drops it from every eligible metric", () => {
  const scenario: Scenario = { name: "routing", path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "передано Idokon (Not relevant)" };
  const record = dashboardRecord(scenario);
  const ref = reference(scenario);
  assert.equal(record.lossReasonGroup, "ROUTING");
  assert.equal(record.qualified, true);
  assert.equal(isEligibleCohortDeal(record), false, "dashboard removes it from the eligible cohort");
  assert.equal(buildDashboardMetrics([record] as never, []).sql.length, 0, "dashboard SQL count is 0");
  assert.equal(ref.classification, "SQL");
  assert.equal(ref.routingReasonInIbox, true, "the reference counts it and flags it");

  const noEvidence = { ...scenario, path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"] };
  assert.equal(dashboardRecord(noEvidence).qualified, false);
  assert.equal(reference(noEvidence).classification, "NOT_SQL");
});

test("documented difference 2: paid-then-Not-Relevant is WON (SQL) in both, which reads against 'Not Relevant is never SQL'", () => {
  const scenario: Scenario = { name: "paid then NR", path: ["C3:NEW", "C3:WON", "C3:UC_C0725V"] };
  const record = dashboardRecord(scenario);
  const ref = reference(scenario);
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.qualified, true);
  assert.equal(ref.classification, "SQL");
  assert.equal(ref.notRelevantButWon, true);
});

test("the routing patterns used by the audit are exactly the dashboard defaults", () => {
  assert.deepEqual([...DASHBOARD_ROUTING_PATTERNS], defaultSettings.routingReasonPatterns);
});
