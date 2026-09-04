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

test("C: NEW -> Нет ответа -> LOST with complete history -> qualified anyway (direct close)", () => {
  // A seller who closes "Закрыто и нереализовано" without ever moving the
  // Deal through SQL/Обработка is a process violation, not proof the lead was
  // never worked — it must still count as SQL and canonical Sales Lost.
  const row = build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" });
  assert.equal(row.qualified, true, "an ordinary Sales closure is unconditionally qualified");
  assert.equal(row.salesStatus, "LOST");
  assert.equal(row.lossReasonGroup, "SALES");
  assert.equal(isSalesLost(row), true);
  // The diagnostic still fires: no real SQL/Обработка stage was ever recorded.
  assert.equal(isPreSqlClosed(row), true);
  // No fabricated timing: qualified is true, but there is no real evidence moment.
  assert.equal(row.qualifiedAt, null);
  assert.equal(row.qualifiedStageId, null);
});

test("D: NEW -> Первое касание -> LOST with complete history -> qualified anyway (direct close)", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_L52PGZ", "C3:LOSE"], reason: "ne klient" });
  assert.equal(row.qualified, true);
  assert.equal(isSalesLost(row), true);
  assert.equal(isPreSqlClosed(row), true);
  assert.equal(row.qualifiedAt, null);
});

test("E: LOST with genuinely unavailable history is qualified too (same unconditional rule)", () => {
  // Evidence availability no longer matters for an ordinary Sales closure —
  // it is qualified either way. canInferQualificationFromOutcome itself stays
  // correct and tested below; it is simply no longer consulted for this.
  const unavailable = build({ path: [], current: "C3:LOSE", reason: "otsrochka", stageHistoryAvailable: false });
  assert.equal(unavailable.qualified, true);
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

test("I: LOST with SALES reason but no SQL evidence reaches the SQL card too, flagged diagnostically", () => {
  const preSql = build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" });
  const realSql = build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "otsrochka" });
  const metrics = buildDashboardMetrics([{ ...preSql, dealId: "p" }, { ...realSql, dealId: "r" }], []);
  assert.equal(metrics.counts.leads, 2);
  // Both are SQL and Sales Lost now — the direct close ("p") is not exempt.
  assert.equal(metrics.counts.sql, 2);
  assert.equal(metrics.counts.sales_lost, 2);
  // The diagnostic still isolates exactly the one with no real SQL evidence.
  assert.equal(metrics.counts.pre_sql_closed, 1);
  assert.deepEqual(metrics.sql.map((row) => row.dealId).sort(), ["p", "r"]);
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
  // preSqlClosed is a diagnostic, not a KPI exclusion: c/d are direct closes,
  // so they ARE SQL and Sales Lost — the diagnostic just flags that neither
  // ever showed real SQL/Обработка evidence.
  assert.equal(m.preSqlClosed.every((row) => row.qualified === true), true, "preSqlClosed rows are still SQL");
  assert.equal(m.preSqlClosed.every((row) => isSalesLost(row)), true, "preSqlClosed rows are still Sales Lost");
  assert.equal(m.sql.some((row) => row.lossReasonGroup === "MARKETING"), false, "no Not Relevant is SQL");
  assert.equal(m.sql.some((row) => row.lossReasonGroup === "ROUTING"), false, "no Routing in SQL");
  assert.equal(m.eligible.filter((row) => row.salesStatus === "WON").every((row) => row.qualified), true, "every eligible WON is qualified");
  // c and d never showed real SQL/Обработка evidence — the diagnostic isolates
  // exactly them, independent of their (now unconditional) qualified status.
  assert.deepEqual(m.preSqlClosed.map((row) => row.dealId).sort(), ["c", "d"]);
  // qualifiedAt never points at a pre-SQL or terminal LOST stage.
  const preSqlOrTerminal = new Set(["C3:NEW", "C3:UC_05P04E", "C3:UC_L52PGZ", "C3:LOSE", "C3:UC_C0725V"]);
  for (const row of m.sql) assert.equal(preSqlOrTerminal.has(row.qualifiedStageId ?? ""), false, `${row.dealId} qualifiedStageId=${row.qualifiedStageId}`);
});

/**
 * Direct, explicit coverage of the clarified business rule — one small cohort
 * that exercises every formula the rule touches at once, rather than relying
 * on incidental coverage from the scenarios above.
 */
test("6/7: a direct close counts as Saralangan and is NOT Not Relevant", () => {
  const row = build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" });
  const m = buildDashboardMetrics([row], []);
  assert.equal(m.counts.classified_leads, 1, "6: the direct close IS Saralangan");
  assert.equal(m.counts.not_relevant, 0, "7: a direct Sales closure is never Not Relevant");
  assert.equal(row.lossReasonGroup, "SALES", "SALES precedence, not MARKETING");
});

test("12/13/14/15/16: canonical formulas hold over a cohort mixing every outcome", () => {
  const rows = [
    // Real SQL evidence, still open.
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM"] }), dealId: "sql-open" },
    // Real SQL evidence, canonical Sales Lost.
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], reason: "otsrochka" }), dealId: "sql-lost" },
    // WON.
    { ...build({ path: ["C3:NEW", "C3:WON"], opportunity: 500 }), dealId: "won" },
    // Not Relevant — authoritative regardless of prior SQL evidence.
    { ...build({ path: ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"] }), dealId: "nr" },
    // Direct close — a seller process error, still qualified/Sales Lost/Saralangan.
    { ...build({ path: ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], reason: "ignorit" }), dealId: "direct-close" },
    // Routing — excluded from the eligible cohort entirely.
    { ...build({ path: ["C3:NEW", "C3:LOSE"], reason: "peredano Idokon" }), dealId: "routed" },
    // Untouched, active pre-SQL lead — the one row that stays Saralanmagan.
    { ...build({ path: ["C3:NEW"] }), dealId: "fresh" },
  ];
  const m = buildDashboardMetrics(rows, rows.filter((row) => row.salesStatus === "WON"));

  assert.equal(m.counts.leads, 6, "routing excluded, six eligible leads");
  // Qualified: sql-open, sql-lost, won (downstream-of-SQL evidence via the
  // paid stage) and direct-close. "nr" is not (MARKETING precedence) and
  // "fresh" never reached any evidence, so it stays undecided.
  assert.equal(m.counts.sql, 4, "sql-open, sql-lost, won, direct-close");
  assert.equal(m.counts.not_relevant, 1, "nr only");
  assert.equal(m.counts.sales_lost, 2, "sql-lost and direct-close");
  assert.ok(m.counts.sales_lost <= m.counts.sql, "14: Sales Lost <= SQL");

  // 12: Saralangan = SQL + Not Relevant, exactly, with no third bucket.
  assert.equal(m.counts.classified_leads, m.counts.sql + m.counts.not_relevant, "12: Saralangan = SQL + Not Relevant");
  assert.equal(m.counts.classified_leads, 5, "4 SQL + 1 Not Relevant");
  // 13: Leadlar = Saralangan + Saralanmagan.
  assert.equal(m.counts.leads, m.counts.classified_leads + m.counts.unclassified_leads, "13: Leadlar = Saralangan + Saralanmagan");
  assert.equal(m.counts.unclassified_leads, 1, "only \"fresh\" is still undecided: 6 = 5 + 1");

  // 15: Sifatli % + Sifatsiz % use the Saralangan denominator and sum to 100%.
  assert.equal(m.rates.quality_accepted_rate, Math.round((4 / 5) * 100), "Sifatli % = SQL / Saralangan");
  assert.equal(m.rates.low_quality_rate, Math.round((1 / 5) * 100), "Sifatsiz % = Not Relevant / Saralangan");
  assert.equal(m.rates.quality_accepted_rate + m.rates.low_quality_rate, 100);

  // 16: pre_sql_closed is diagnostic-only and never subtracted from any KPI.
  assert.equal(m.counts.pre_sql_closed, 1, "direct-close is flagged");
  assert.deepEqual(m.preSqlClosed.map((row) => row.dealId), ["direct-close"]);
  assert.ok(m.sql.some((row) => row.dealId === "direct-close"), "16: still present in SQL");
  assert.ok(m.salesLost.some((row) => row.dealId === "direct-close"), "16: still present in Sales Lost");
  assert.ok(m.classified.some((row) => row.dealId === "direct-close"), "16: still present in Saralangan");
});
