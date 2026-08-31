import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { canInferQualificationFromOutcome, isPreSqlClosed, isSalesLost } from "../lib/sales-logic";
import { defaultSettings } from "../lib/business-time";
import type { AnalyticsRecord } from "../lib/types";

/** Category 3 stage dictionary, mirroring the live IBOX Sales funnel. */
const STAGES: [string, string, number][] = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_05P04E", "НЕТ ОТВЕТА", 20],
  ["C3:UC_L52PGZ", "Первое касаниe", 40],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:PREPARATION", "ВСТРЕЧА НАЗНАЧЕНА", 60],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110],
  ["C3:UC_C0725V", "Not relevant", 120],
];
const stages = new Map(STAGES.map(([id, name]) => [id, name]));
const stageMeta = new Map(STAGES.map(([id, , sort]) => [id, { sort, categoryId: "3" }]));

const settings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"], postSalePipelineIds: ["13"],
  qualifiedStageIds: ["C3:UC_9SUEMM"], lowQualityStageIds: ["C3:UC_C0725V"],
  closedLostStageIds: ["C3:LOSE"], paymentStageIds: ["C3:WON"],
  routingReasonPatterns: ["idoko", "sd"],
};

/**
 * Builds one record through the real pipeline. `path` is the stage history as
 * Bitrix would return it; an empty path means the history source produced
 * nothing for this deal.
 */
function build(opts: {
  path: string[]; current?: string; reason?: string; categoryId?: string;
  stageHistoryAvailable?: boolean; opportunity?: number;
}): AnalyticsRecord {
  const current = opts.current ?? opts.path[opts.path.length - 1] ?? "C3:NEW";
  const deals = [{
    ID: "1", TITLE: "t", CATEGORY_ID: opts.categoryId ?? "3", STAGE_ID: current,
    DATE_CREATE: "2026-08-05T09:00:00+03:00", DATE_MODIFY: "2026-08-10T09:00:00+03:00",
    MOVED_TIME: "2026-08-10T09:00:00+03:00", CLOSEDATE: "2026-08-10T09:00:00+03:00",
    ASSIGNED_BY_ID: "7", OPPORTUNITY: String(opts.opportunity ?? 0), CURRENCY_ID: "UZS",
    ...(opts.reason ? { UF_CRM_LOSS: opts.reason } : {}),
  }] as unknown as Parameters<typeof buildAnalyticsRecords>[0]["deals"];
  const stageHistories = opts.path.map((stageId, index) => ({
    OWNER_ID: "1", CATEGORY_ID: "3", STAGE_ID: stageId,
    CREATED_TIME: `2026-08-0${5 + index}T09:00:00+03:00`,
  })) as unknown as Parameters<typeof buildAnalyticsRecords>[0]["stageHistories"];
  const [record] = buildAnalyticsRecords({
    deals, stageHistories,
    settings: { ...settings, failureReasonField: opts.reason ? "UF_CRM_LOSS" : "" } as never,
    users: new Map([["7", "Menejer"]]),
    pipelines: new Map([["3", "IBOX sales"], ["13", "Post-sale"]]),
    stages, stageMeta, sources: new Map(), fieldOptions: new Map(), snapshots: new Map(),
    domain: null, stageHistoryAvailable: opts.stageHistoryAvailable ?? true,
  } as never);
  return record;
}

test("A: SQL history then LOST -> qualified, canonical Sales Lost", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "Ushli konkurentam" });
  assert.equal(row.qualified, true);
  assert.equal(row.salesStatus, "LOST");
  assert.equal(row.lossReasonGroup, "SALES");
  assert.equal(isSalesLost(row), true);
  assert.equal(isPreSqlClosed(row), false);
  assert.equal(row.qualifiedStageId, "C3:UC_9SUEMM", "timing comes from the real SQL stage");
});

test("B: downstream history then LOST -> qualified, canonical Sales Lost", () => {
  const row = build({ path: ["C3:NEW", "C3:PREPARATION", "C3:LOSE"], reason: "otsrochka" });
  assert.equal(row.qualified, true);
  assert.equal(isSalesLost(row), true);
  assert.equal(isPreSqlClosed(row), false);
  assert.equal(row.qualifiedStageId, "C3:PREPARATION");
});

test("C: NEW -> Нет ответа -> LOST with complete history -> NOT qualified", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" });
  assert.equal(row.qualified, false, "read history showing no SQL is evidence against, not absence of evidence");
  assert.equal(row.salesStatus, "LOST");
  assert.equal(row.lossReasonGroup, "SALES");
  assert.equal(isSalesLost(row), false);
  assert.equal(isPreSqlClosed(row), true);
  assert.equal(row.qualifiedAt, null);
  assert.equal(row.qualifiedStageId, null);
});

test("D: NEW -> Первое касание -> LOST with complete history -> NOT qualified", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_L52PGZ", "C3:LOSE"], reason: "ne klient" });
  assert.equal(row.qualified, false);
  assert.equal(isSalesLost(row), false);
  assert.equal(isPreSqlClosed(row), true);
  assert.equal(row.qualifiedAt, null);
});

test("E: LOST with genuinely unavailable history keeps the safe fallback", () => {
  // The permission itself failed, so we cannot know whether SQL happened.
  const unavailable = build({ path: [], current: "C3:LOSE", reason: "otsrochka", stageHistoryAvailable: false });
  assert.equal(unavailable.qualified, true, "unknown evidence keeps the backward-safe upgrade");
  assert.equal(isSalesLost(unavailable), true);
  // ...but it must not invent a qualification moment.
  assert.equal(unavailable.qualifiedAt, null);
  assert.equal(unavailable.qualifiedStageId, null);

  // History was readable and simply had no rows for this deal: also unobservable.
  assert.equal(canInferQualificationFromOutcome({ stageHistoryAvailable: true, historyRowCount: 0 }), true);
  // History was readable and had rows: observable, so no fallback.
  assert.equal(canInferQualificationFromOutcome({ stageHistoryAvailable: true, historyRowCount: 3 }), false);
  assert.equal(canInferQualificationFromOutcome({ stageHistoryAvailable: false, historyRowCount: 3 }), true);
});

test("F: WON without SQL history stays qualified", () => {
  const row = build({ path: ["C3:NEW", "C3:WON"], opportunity: 500 });
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.qualified, true, "an actual sale proves acceptance");
  assert.equal(isPreSqlClosed(row), false);
});

test("G: Not Relevant after historical SQL stays unqualified and is never Sales Lost", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"] });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.qualified, false);
  assert.equal(row.lossReasonGroup, "MARKETING");
  assert.equal(isSalesLost(row), false);
  assert.equal(isPreSqlClosed(row), false);
});

test("H: routed after SQL is excluded from every eligible metric", () => {
  const row = build({ path: ["C3:NEW", "C3:PREPARATION", "C3:LOSE"], reason: "peredano Idokon" });
  assert.equal(row.lossReasonGroup, "ROUTING");
  const metrics = buildDashboardMetrics([row], []);
  assert.equal(metrics.counts.leads, 0);
  assert.equal(metrics.counts.sql, 0);
  assert.equal(metrics.counts.pre_sql_closed, 0);
  assert.equal(metrics.counts.sales_lost, 0);
});

test("I: LOST with SALES reason but no SQL evidence never reaches the SQL card", () => {
  const preSql = build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" });
  const realSql = build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "otsrochka" });
  const metrics = buildDashboardMetrics([{ ...preSql, dealId: "p" }, { ...realSql, dealId: "r" }], []);
  assert.equal(metrics.counts.leads, 2);
  assert.equal(metrics.counts.sql, 1);
  assert.equal(metrics.counts.sales_lost, 1);
  assert.equal(metrics.counts.pre_sql_closed, 1);
  assert.deepEqual(metrics.sql.map((row) => row.dealId), ["r"]);
  assert.deepEqual(metrics.preSqlClosed.map((row) => row.dealId), ["p"]);
});

test("12: invariants hold over a mixed cohort", () => {
  const rows = [
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "otsrochka" }), dealId: "a" },
    { ...build({ path: ["C3:NEW", "C3:PREPARATION", "C3:LOSE"], reason: "otsrochka" }), dealId: "b" },
    { ...build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" }), dealId: "c" },
    { ...build({ path: ["C3:NEW", "C3:UC_L52PGZ", "C3:LOSE"], reason: "ignorit" }), dealId: "d" },
    { ...build({ path: ["C3:NEW", "C3:WON"], opportunity: 100 }), dealId: "e" },
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"] }), dealId: "f" },
    { ...build({ path: ["C3:NEW", "C3:PREPARATION", "C3:LOSE"], reason: "peredano Idokon" }), dealId: "g" },
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM"] }), dealId: "h" },
  ];
  const m = buildDashboardMetrics(rows, rows.filter((row) => row.salesStatus === "WON"));
  assert.ok(m.counts.sql <= m.counts.leads, "SQL <= Leadlar");
  assert.ok(m.counts.sales_lost <= m.counts.sql, "Sales Lost <= SQL");
  assert.equal(m.salesLost.every((row) => row.qualified === true), true, "every Sales Lost is qualified");
  assert.equal(m.preSqlClosed.some((row) => row.qualified === true), false, "no preSqlClosed is SQL");
  assert.equal(m.preSqlClosed.some((row) => isSalesLost(row)), false, "no preSqlClosed is Sales Lost");
  assert.equal(m.sql.some((row) => row.lossReasonGroup === "MARKETING"), false, "no Not Relevant is SQL");
  assert.equal(m.sql.some((row) => row.lossReasonGroup === "ROUTING"), false, "no Routing in SQL");
  assert.equal(m.eligible.filter((row) => row.salesStatus === "WON").every((row) => row.qualified), true, "every eligible WON is qualified");
  // A complete pre-SQL history ending in LOST never fabricates qualification.
  assert.deepEqual(m.preSqlClosed.map((row) => row.dealId).sort(), ["c", "d"]);
  // qualifiedAt never points at a pre-SQL or terminal LOST stage.
  const preSqlOrTerminal = new Set(["C3:NEW", "C3:UC_05P04E", "C3:UC_L52PGZ", "C3:LOSE", "C3:UC_C0725V"]);
  for (const row of m.sql) assert.equal(preSqlOrTerminal.has(row.qualifiedStageId ?? ""), false, `${row.dealId} qualifiedStageId=${row.qualifiedStageId}`);
});
