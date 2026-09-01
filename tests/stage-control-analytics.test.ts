import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCurrentStages } from "../lib/current-stages";
import { DASHBOARD_OMITTED_FIELDS, DASHBOARD_TIMELINE_FIELD, STAGE_FUNNEL_FIELDS, type StageFunnelRecord } from "../lib/dashboard-record";
import {
  buildHistorical, buildManagerMatrix, buildOverdueRows, buildReconciliationView, buildStageCatalog,
  buildStageHealth, buildSummary, humanDuration, limitRatio, overrunHours, stageKey, terminalStageKeys,
} from "../lib/stage-control-analytics";
import type { AnalyticsRecord, CurrentStageRecord, PipelineStageOption, StageTimelineEntry } from "../lib/types";

const NOW = new Date("2026-09-01T09:00:00.000Z");
const HISTORY_DAYS = 90;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// The IBOX Sales funnel, deliberately declared out of business order so nothing
// can pass by accidentally preserving array order.
const IBOX_STAGES: PipelineStageOption[] = [
  { id: "C1:SOGLASIE", name: "СОГЛАСИЕ", categoryId: "1", sort: 70, semantics: "" },
  { id: "C1:NEW", name: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", categoryId: "1", sort: 10, semantics: "" },
  { id: "C1:PAID", name: "Оплата получена", categoryId: "1", sort: 90, semantics: "S" },
  { id: "C1:MEET_DONE", name: "ВСТРЕЧА ПРОВЕДЕНА", categoryId: "1", sort: 60, semantics: "" },
  { id: "C1:NOANSWER", name: "НЕТ ОТВЕТА", categoryId: "1", sort: 20, semantics: "" },
  { id: "C1:DATA", name: "ПОЛУЧЕНИЕ ДАННЫХ/ОПЛАТА", categoryId: "1", sort: 80, semantics: "" },
  { id: "C1:TOUCH", name: "Первое касание", categoryId: "1", sort: 30, semantics: "" },
  { id: "C1:MEET_SET", name: "ВСТРЕЧА НАЗНАЧЕНА", categoryId: "1", sort: 50, semantics: "" },
  { id: "C1:WORK", name: "ОБРАБОТКА", categoryId: "1", sort: 40, semantics: "" },
  { id: "C1:NR", name: "Not Relevant", categoryId: "1", sort: 100, semantics: "F" },
  { id: "C1:LOST", name: "Sotilmadi", categoryId: "1", sort: 110, semantics: "F" },
];

const STAGE_CONFIG = { lowQualityStageIds: ["C1:NR"], closedLostStageIds: ["C1:LOST"] };

function live(over: Partial<CurrentStageRecord> = {}): CurrentStageRecord {
  const stageAgeHours = over.stageAgeHours ?? 5;
  const stageLimitHours = over.stageLimitHours ?? 24;
  return {
    dealId: "1", title: "Deal", createdAt: daysAgo(3),
    assignedManagerId: "m1", assignedManager: "Ali",
    categoryId: "1", pipeline: "IBOX sales",
    stageId: "C1:WORK", stage: "ОБРАБОТКА",
    stageEnteredAt: hoursAgo(stageAgeHours),
    stageAgeHours, stageLimitHours,
    stageOverdue: stageAgeHours > stageLimitHours,
    bitrixUrl: null,
    ...over,
  };
}

function cached(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", categoryId: "1", stageId: "C1:WORK", salesStatus: "ACTIVE", currentScope: "IN_SCOPE",
    ...over,
  } as unknown as AnalyticsRecord;
}

// ============================================================ RECONCILIATION

const LIVE_SET = [
  live({ dealId: "in-cache", createdAt: daysAgo(10) }),
  live({ dealId: "old-missing", createdAt: daysAgo(400) }),
  live({ dealId: "recent-missing", createdAt: daysAgo(5) }),
  live({ dealId: "mismatch", createdAt: daysAgo(9), stageId: "C1:MEET_SET" }),
];
const CACHE_SET = [
  cached({ dealId: "in-cache" }),
  cached({ dealId: "mismatch", stageId: "C1:WORK" }),
  cached({ dealId: "stale-open" }),
];
const RECON = reconcileCurrentStages(LIVE_SET, CACHE_SET, NOW.toISOString(), { historyDays: HISTORY_DAYS, now: NOW });

test("A: a live deal absent from the cache counts as missing", () => {
  assert.equal(RECON.missingCount, 2);
  assert.deepEqual(RECON.missingDealIds.sort(), ["old-missing", "recent-missing"]);
});

test("B: a missing deal older than the history window is an expected gap", () => {
  assert.deepEqual(RECON.missingOlderThanHistoryDealIds, ["old-missing"]);
  assert.equal(RECON.missingOlderThanHistoryCount, 1);
  // The cutoff comes from the sync's own bootstrap window, not a second rule.
  assert.equal(RECON.historyFrom, new Date(NOW.getTime() - HISTORY_DAYS * 86_400_000).toISOString());
});

test("C: a missing deal inside the history window is an unexpected cache gap", () => {
  assert.deepEqual(RECON.missingWithinHistoryDealIds, ["recent-missing"]);
  assert.equal(buildReconciliationView(RECON)?.severity, "warning");
});

test("D: a stage mismatch stays detectable", () => {
  assert.equal(RECON.stageMismatchCount, 1);
  assert.deepEqual(RECON.stageMismatchDealIds, ["mismatch"]);
});

test("E: a cache record Bitrix no longer reports open stays stale", () => {
  assert.equal(RECON.staleCount, 1);
  assert.deepEqual(RECON.staleDealIds, ["stale-open"]);
});

test("F: expected old gaps alone do not make the live snapshot untrustworthy", () => {
  const onlyOld = reconcileCurrentStages(
    [live({ dealId: "a", createdAt: daysAgo(10) }), live({ dealId: "old", createdAt: daysAgo(400) })],
    [cached({ dealId: "a" })],
    NOW.toISOString(), { historyDays: HISTORY_DAYS, now: NOW },
  );
  const view = buildReconciliationView(onlyOld)!;
  assert.equal(onlyOld.missingOlderThanHistoryCount, 1);
  assert.equal(view.severity, "ok", "old open deals outside the import window are informational");
  assert.deepEqual(view.reasons, []);
});

test("G: a truncated live snapshot does trigger a warning", () => {
  const clean = reconcileCurrentStages([live({ dealId: "a" })], [cached({ dealId: "a" })], NOW.toISOString(), { historyDays: HISTORY_DAYS, now: NOW });
  assert.equal(buildReconciliationView(clean)?.severity, "ok");
  const view = buildReconciliationView(clean, { truncated: true })!;
  assert.equal(view.severity, "warning");
  assert.ok(view.reasons.some((reason) => /to‘liq yuklanmadi/.test(reason)));
});

test("H: coverage is matched live ids over the live count", () => {
  const view = buildReconciliationView(RECON)!;
  assert.equal(view.liveCount, 4);
  assert.equal(view.matchedCount, 2);
  assert.equal(view.coverage, 50);
});

test("I: the analytics cache total is never the live denominator", () => {
  const wide = reconcileCurrentStages(
    [live({ dealId: "a", createdAt: daysAgo(2) })],
    [cached({ dealId: "a" }), ...Array.from({ length: 1472 }, (_, i) => cached({ dealId: `hist-${i}`, salesStatus: "WON" }))],
    NOW.toISOString(), { historyDays: HISTORY_DAYS, now: NOW },
  );
  const view = buildReconciliationView(wide)!;
  assert.equal(view.cachedCount, 1473, "the cache total is still reported, but only as context");
  assert.equal(view.liveCount, 1);
  assert.equal(view.coverage, 100, "1 of 1 live ids matched — not 1 of 1473");
});

// ============================================================== STAGE ORDER

const SHUFFLED_LIVE = [
  live({ dealId: "1", stageId: "C1:SOGLASIE", stage: "СОГЛАСИЕ" }),
  live({ dealId: "2", stageId: "C1:NEW", stage: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ" }),
  live({ dealId: "3", stageId: "C1:WORK", stage: "ОБРАБОТКА" }),
  live({ dealId: "4", stageId: "C1:NOANSWER", stage: "НЕТ ОТВЕТА" }),
];

test("J/K: shuffled live records still render Bitrix SORT order, not alphabetical", () => {
  const catalog = buildStageCatalog({ catalog: IBOX_STAGES, live: SHUFFLED_LIVE });
  assert.deepEqual(catalog.map((stage) => stage.name), [
    "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", "НЕТ ОТВЕТА", "Первое касание", "ОБРАБОТКА",
    "ВСТРЕЧА НАЗНАЧЕНА", "ВСТРЕЧА ПРОВЕДЕНА", "СОГЛАСИЕ", "ПОЛУЧЕНИЕ ДАННЫХ/ОПЛАТА",
    "Оплата получена", "Not Relevant", "Sotilmadi",
  ]);
  const alphabetical = [...catalog.map((s) => s.name)].sort();
  assert.notDeepEqual(catalog.map((s) => s.name), alphabetical, "K: order is not alphabetical");
});

test("L: stage id is identity — a renamed/case-changed label stays one stage", () => {
  const catalog = buildStageCatalog({
    catalog: IBOX_STAGES,
    live: [live({ dealId: "1", stageId: "C1:NR", stage: "Not Relevant" }), live({ dealId: "2", stageId: "C1:NR", stage: "Not relevant" })],
  });
  assert.equal(catalog.filter((stage) => stage.stageId === "C1:NR").length, 1);
  const health = buildStageHealth(
    [live({ dealId: "1", stageId: "C1:NR", stage: "Not Relevant" }), live({ dealId: "2", stageId: "C1:NR", stage: "Not relevant" })],
    catalog,
  );
  assert.equal(health.find((row) => row.key === "1:C1:NR")?.active, 2, "both case variants land in one row");
});

test("M: the same label in two categoryIds is never merged", () => {
  const catalog = buildStageCatalog({
    catalog: [
      { id: "S", name: "ОБРАБОТКА", categoryId: "1", sort: 40, semantics: "" },
      { id: "S", name: "ОБРАБОТКА", categoryId: "7", sort: 40, semantics: "" },
    ],
  });
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map((stage) => stage.key), ["1:S", "7:S"]);
});

test("N: an unknown/legacy stage stays visible after the known ones", () => {
  const catalog = buildStageCatalog({
    catalog: IBOX_STAGES,
    live: [live({ dealId: "9", stageId: "C1:GONE", stage: "O‘chirilgan bosqich" })],
  });
  const legacy = catalog.filter((stage) => stage.legacy);
  assert.deepEqual(legacy.map((stage) => stage.stageId), ["C1:GONE"]);
  assert.equal(catalog.at(-1)?.stageId, "C1:GONE", "legacy stages sort after the live catalog");
});

// ================================================================== MATRIX

const MATRIX_LIVE = [
  // Ali: 3 in ОБРАБОТКА (2 overdue), 1 in СОГЛАСИЕ (0 overdue) => 4 active, 2 overdue
  live({ dealId: "a1", assignedManagerId: "m1", assignedManager: "Ali", stageId: "C1:WORK", stageAgeHours: 100 }),
  live({ dealId: "a2", assignedManagerId: "m1", assignedManager: "Ali", stageId: "C1:WORK", stageAgeHours: 90 }),
  live({ dealId: "a3", assignedManagerId: "m1", assignedManager: "Ali", stageId: "C1:WORK", stageAgeHours: 2 }),
  live({ dealId: "a4", assignedManagerId: "m1", assignedManager: "Ali", stageId: "C1:SOGLASIE", stageAgeHours: 3 }),
  // Bob: 5 active, 4 overdue
  ...Array.from({ length: 4 }, (_, i) => live({ dealId: `b${i}`, assignedManagerId: "m2", assignedManager: "Bob", stageId: "C1:NEW", stageAgeHours: 200 })),
  live({ dealId: "b9", assignedManagerId: "m2", assignedManager: "Bob", stageId: "C1:NEW", stageAgeHours: 1 }),
  // Unattributed: 2 active, 0 overdue
  live({ dealId: "u1", assignedManagerId: "", assignedManager: "", stageId: "C1:WORK", stageAgeHours: 1 }),
  live({ dealId: "u2", assignedManagerId: "", assignedManager: "", stageId: "C1:WORK", stageAgeHours: 1 }),
];
const MATRIX_CATALOG = buildStageCatalog({ catalog: IBOX_STAGES, live: MATRIX_LIVE });
const MATRIX = buildManagerMatrix(MATRIX_LIVE, MATRIX_CATALOG);
const cellOf = (manager: string, key: string) => MATRIX.find((row) => row.manager === manager)!.cells.find((cell) => cell.key === key)!;

test("O/P/Q: manager-stage active, overdue and overdue rate are correct", () => {
  assert.equal(cellOf("Ali", "1:C1:WORK").active, 3);
  assert.equal(cellOf("Ali", "1:C1:WORK").overdue, 2);
  assert.equal(cellOf("Ali", "1:C1:WORK").overdueRate, 67);
  assert.equal(cellOf("Ali", "1:C1:SOGLASIE").overdueRate, 0, "0 overdue of 1 is 0%, not null");
  assert.equal(cellOf("Ali", "1:C1:NEW").overdueRate, null, "an empty cell has no rate");
});

test("R/S/T: manager totals, total overdue and overdue % are correct", () => {
  const ali = MATRIX.find((row) => row.manager === "Ali")!;
  assert.deepEqual([ali.total, ali.overdue, ali.overdueRate], [4, 2, 50]);
  const bob = MATRIX.find((row) => row.manager === "Bob")!;
  assert.deepEqual([bob.total, bob.overdue, bob.overdueRate], [5, 4, 80]);
});

test("U: default manager sort is overdue desc, then active desc, with Aniqlanmagan last", () => {
  assert.deepEqual(MATRIX.map((row) => row.manager), ["Bob", "Ali", "Aniqlanmagan"]);
  assert.equal(MATRIX.at(-1)?.isUnknown, true);
  assert.equal(MATRIX.at(-1)?.total, 2, "the attribution bucket stays visible");
});

test("matrix cells are built in one grouped pass over the snapshot", () => {
  const wide = buildManagerMatrix(MATRIX_LIVE, MATRIX_CATALOG);
  assert.equal(wide[0].cells.length, MATRIX_CATALOG.length, "every catalog stage gets a cell");
  assert.equal(wide.reduce((sum, row) => sum + row.total, 0), MATRIX_LIVE.length, "no record lost or double counted");
});

// ============================================================ STAGE HEALTH

const HEALTH = buildStageHealth(MATRIX_LIVE, MATRIX_CATALOG);
const healthOf = (key: string) => HEALTH.find((row) => row.key === key)!;

test("V: stage active count and share are correct", () => {
  assert.equal(healthOf("1:C1:WORK").active, 5);
  assert.equal(healthOf("1:C1:WORK").share, 45, "5 of 11");
  assert.equal(healthOf("1:C1:DATA").active, 0);
  assert.equal(healthOf("1:C1:DATA").share, 0);
});

test("W: stage overdue count and rate are correct", () => {
  assert.deepEqual([healthOf("1:C1:NEW").overdue, healthOf("1:C1:NEW").overdueRate], [4, 80]);
  assert.equal(healthOf("1:C1:DATA").overdueRate, null, "an empty stage has no rate");
});

test("X: median stage age is correct", () => {
  // ОБРАБОТКА ages: 100, 90, 2, 1, 1 -> sorted 1,1,2,90,100 -> median 2
  assert.equal(healthOf("1:C1:WORK").medianAgeHours, 2);
  assert.equal(healthOf("1:C1:WORK").maxAgeHours, 100);
});

test("Y: the configured limit is shown, and a conflicting limit is reported not hidden", () => {
  assert.equal(healthOf("1:C1:WORK").limitHours, 24);
  assert.equal(healthOf("1:C1:WORK").limitConflict, false);
  const mixed = buildStageHealth([
    live({ dealId: "x1", stageId: "C1:WORK", stageLimitHours: 24 }),
    live({ dealId: "x2", stageId: "C1:WORK", stageLimitHours: 48 }),
  ], MATRIX_CATALOG);
  const row = mixed.find((entry) => entry.key === "1:C1:WORK")!;
  assert.equal(row.limitConflict, true);
  assert.equal(row.limitHours, null, "no silent pick");
  assert.deepEqual(row.limits, [24, 48]);
});

test("Z: Stage Health follows funnel order, not volume order", () => {
  assert.deepEqual(HEALTH.map((row) => row.name).slice(0, 4), [
    "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", "НЕТ ОТВЕТА", "Первое касание", "ОБРАБОТКА",
  ]);
  const byVolume = [...HEALTH].sort((a, b) => b.active - a.active).map((row) => row.name);
  assert.notDeepEqual(HEALTH.map((row) => row.name), byVolume);
});

// ================================================================= OVERDUE

test("AA: only stageOverdue deals enter the overdue list", () => {
  const rows = buildOverdueRows(MATRIX_LIVE);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.stageOverdue));
});

test("AB: overrun = max(0, stageAge - limit)", () => {
  assert.equal(overrunHours(live({ stageAgeHours: 100, stageLimitHours: 24 })), 76);
  assert.equal(overrunHours(live({ stageAgeHours: 10, stageLimitHours: 24 })), 0, "never negative");
});

test("AC: the limit ratio handles a zero or invalid limit safely", () => {
  assert.equal(limitRatio(live({ stageAgeHours: 48, stageLimitHours: 24 })), 2);
  assert.equal(limitRatio(live({ stageAgeHours: 48, stageLimitHours: 0 })), null);
  assert.equal(limitRatio(live({ stageAgeHours: 48, stageLimitHours: Number.NaN })), null);
  assert.equal(limitRatio(live({ stageAgeHours: 48, stageLimitHours: -5 })), null);
});

test("AD: manager, stage and search filters work", () => {
  assert.equal(buildOverdueRows(MATRIX_LIVE, { manager: "m2" }).length, 4);
  assert.equal(buildOverdueRows(MATRIX_LIVE, { stage: stageKey("1", "C1:WORK") }).length, 2);
  assert.equal(buildOverdueRows(MATRIX_LIVE, { search: "a1" }).length, 1);
  assert.equal(buildOverdueRows(MATRIX_LIVE, { search: "Ali" }).length, 2, "search also reads the manager");
  assert.equal(buildOverdueRows(MATRIX_LIVE, { manager: "m1", stage: stageKey("1", "C1:SOGLASIE") }).length, 0);
});

test("AE: the full overdue population is returned, so a 20-row page cannot hide it", () => {
  const many = Array.from({ length: 57 }, (_, i) => live({ dealId: `o${i}`, stageAgeHours: 100 + i }));
  const rows = buildOverdueRows(many);
  assert.equal(rows.length, 57, "the helper never slices");
  assert.equal(rows[0].dealId, "o56", "sorted by overrun desc");
  assert.equal(rows.slice(0, 20).length, 20, "paging is the caller's decision, over a known total");
});

test("overdue sorts: overrun, age and ratio are distinct orders", () => {
  const rows = [
    live({ dealId: "big-overrun", stageAgeHours: 500, stageLimitHours: 240 }),
    live({ dealId: "big-ratio", stageAgeHours: 100, stageLimitHours: 2 }),
  ];
  assert.equal(buildOverdueRows(rows, {}, "overrun")[0].dealId, "big-overrun");
  assert.equal(buildOverdueRows(rows, {}, "age")[0].dealId, "big-overrun");
  assert.equal(buildOverdueRows(rows, {}, "ratio")[0].dealId, "big-ratio");
});

// ================================================================ SUMMARY

test("the KPI summary reads busiest stage and oldest deal from the live snapshot", () => {
  const summary = buildSummary(MATRIX_LIVE, MATRIX_CATALOG);
  assert.deepEqual([summary.active, summary.overdue, summary.overdueRate], [11, 6, 55]);
  assert.equal(summary.busiest?.name, "ОБРАБОТКА");
  assert.deepEqual([summary.busiest?.active, summary.busiest?.share], [5, 45]);
  assert.deepEqual([summary.busiest?.overdue, summary.busiest?.overdueRate], [2, 40]);
  assert.equal(summary.oldest?.dealId, "b0");
  assert.equal(summary.oldest?.stageAgeHours, 200);
});

test("durations read as human time, never as a raw four-digit hour count", () => {
  assert.equal(humanDuration(10254), "427 kun");
  assert.equal(humanDuration(342), "14 kun 6 soat");
  assert.equal(humanDuration(5), "5 soat");
  assert.equal(humanDuration(0.5), "30 daqiqa");
  assert.equal(humanDuration(null), "—");
});

// ============================================================== HISTORICAL

const tl = (stageId: string, stage: string, durationHours = 5): StageTimelineEntry => ({
  categoryId: "1", pipeline: "IBOX sales", stageId, stage,
  enteredAt: daysAgo(10), exitedAt: daysAgo(9), durationHours,
});

function funnel(over: Partial<StageFunnelRecord> = {}): StageFunnelRecord {
  return {
    dealId: "1", title: "Deal", assignedManagerId: "m1", salesManagerId: "m1",
    originPipeline: "IBOX sales", originCategoryId: "1",
    salesStatus: "ACTIVE", qualified: false, lossReasonGroup: "NONE",
    stageTimeline: [], ...over,
  } as StageFunnelRecord;
}

const HISTORY: StageFunnelRecord[] = [
  // Won: NEW -> WORK -> PAID
  funnel({ dealId: "won", salesStatus: "WON", qualified: true, stageTimeline: [tl("C1:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"), tl("C1:WORK", "ОБРАБОТКА"), tl("C1:PAID", "Оплата получена")] }),
  // Not Relevant: NEW -> NR (terminal). Label case varies on purpose.
  funnel({ dealId: "nr1", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", stageTimeline: [tl("C1:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"), tl("C1:NR", "Not Relevant")] }),
  funnel({ dealId: "nr2", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", stageTimeline: [tl("C1:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"), tl("C1:NR", "Not relevant")] }),
  // Canonical Sales Lost (qualified + SALES): WORK -> LOST (terminal)
  funnel({ dealId: "lost", salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", stageTimeline: [tl("C1:WORK", "ОБРАБОТКА"), tl("C1:LOST", "Sotilmadi")] }),
  // Pre-SQL closed: SALES group but never qualified
  funnel({ dealId: "presql", salesStatus: "LOST", qualified: false, lossReasonGroup: "SALES", stageTimeline: [tl("C1:WORK", "ОБРАБОТКА"), tl("C1:LOST", "Sotilmadi")] }),
  // Routing
  funnel({ dealId: "route", salesStatus: "LOST", lossReasonGroup: "ROUTING", stageTimeline: [tl("C1:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ")] }),
  // Legacy stage no longer in the live catalog
  funnel({ dealId: "legacy", stageTimeline: [tl("C1:ANCIENT", "Eski bosqich")] }),
];
const HIST_CATALOG = buildStageCatalog({ catalog: IBOX_STAGES, historical: HISTORY });
const HIST = buildHistorical(HISTORY, HIST_CATALOG, STAGE_CONFIG);
const progressionKeys = HIST.progression.map((row) => row.key);

test("AF/AG/AH: terminal Not Relevant, Sales Lost and Routing never become progression rows", () => {
  assert.equal(progressionKeys.includes("1:C1:NR"), false, "AF");
  assert.equal(progressionKeys.includes("1:C1:LOST"), false, "AG");
  assert.ok(HIST.progression.every((row) => !/Not Relevant|Sotilmadi/i.test(row.stage)), "AH: no terminal label leaks in");
});

test("AN: a terminal outcome can never display a conversion percentage", () => {
  for (const row of HIST.progression) {
    assert.equal(["1:C1:NR", "1:C1:LOST"].includes(row.key), false);
  }
  const nr = HIST.progression.find((row) => row.stage.toLowerCase().includes("not relevant"));
  assert.equal(nr, undefined, "no `Not Relevant 100% conversion` row exists at all");
});

test("AI/AJ: outcomes are classified canonically, not by stage or reason text", () => {
  const count = (key: string) => HIST.outcomes.find((row) => row.key === key)!.count;
  assert.equal(count("won"), 1);
  assert.equal(count("not_relevant"), 2);
  assert.equal(count("sales_lost"), 1, "AI: only the qualified SALES deal");
  assert.equal(count("pre_sql"), 1, "AJ: pre-SQL closure stays separate from Sales Lost");
  assert.equal(count("routing"), 1);
});

test("AK: the same stageId with a renamed/case-changed label stays one historical row", () => {
  const newRows = HIST.progression.filter((row) => row.key === "1:C1:NEW");
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0].entered, 4, "won + nr1 + nr2 + route all entered РАСПРЕДЕЛЁННЫЕ СДЕЛКИ");
});

test("AL: known progression stages follow Bitrix order", () => {
  const known = HIST.progression.filter((row) => !row.legacy).map((row) => row.stage);
  // Оплата получена is a Bitrix won stage (SEMANTICS "S"), so it is an outcome
  // rather than a progression row — the funnel ends at the last process stage.
  assert.deepEqual(known, ["РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", "ОБРАБОТКА"]);
});

test("AM: a historical stage with no live catalog match stays visible as legacy", () => {
  const legacy = HIST.progression.find((row) => row.key === "1:C1:ANCIENT");
  assert.ok(legacy, "legacy stage is not dropped");
  assert.equal(legacy!.legacy, true);
  assert.equal(HIST.progression.at(-1)?.key, "1:C1:ANCIENT", "and sorts after known stages");
});

test("progression `advanced` means a later progression stage or a canonical win", () => {
  const New = HIST.progression.find((row) => row.key === "1:C1:NEW")!;
  // Of the 4 that entered NEW: won advanced to WORK; nr1/nr2 dropped into a
  // terminal stage; route ended there. Only the win advanced.
  assert.equal(New.advanced, 1);
  assert.equal(New.dropOff, 3);
  assert.equal(New.conversion, 25);
  const work = HIST.progression.find((row) => row.key === "1:C1:WORK")!;
  assert.equal(work.entered, 3, "won + lost + presql");
  assert.equal(work.advanced, 1, "only the won deal reached a later progression stage");
});

test("AO: the stage-funnel projection stays lazy and the dashboard payload carries no timeline", () => {
  assert.equal(DASHBOARD_OMITTED_FIELDS.includes("stageTimeline" as never), false);
  assert.equal(DASHBOARD_TIMELINE_FIELD, "stageTimeline", "the dashboard strips the timeline separately");
  // The funnel DTO gained exactly the two scalars canonical outcomes need.
  assert.ok(STAGE_FUNNEL_FIELDS.includes("qualified"));
  assert.ok(STAGE_FUNNEL_FIELDS.includes("lossReasonGroup"));
  assert.equal(STAGE_FUNNEL_FIELDS.length, 10, "still a projection, not the full record");
  assert.ok(Object.keys(funnel()).length < 20);
});

test("fallback order applies only when Bitrix SORT metadata is unavailable", () => {
  // No catalog at all: every stage is legacy and must still read as the funnel,
  // not alphabetically (which would put ВСТРЕЧА ПРОВЕДЕНА before ОБРАБОТКА).
  const catalog = buildStageCatalog({
    live: [
      live({ dealId: "1", stageId: "S_WORK", stage: "ОБРАБОТКА" }),
      live({ dealId: "2", stageId: "S_NEW", stage: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ" }),
      live({ dealId: "3", stageId: "S_MEET", stage: "ВСТРЕЧА ПРОВЕДЕНА" }),
      live({ dealId: "4", stageId: "S_NOANS", stage: "НЕТ ОТВЕТА" }),
    ],
  });
  assert.deepEqual(catalog.map((stage) => stage.name), [
    "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", "НЕТ ОТВЕТА", "ОБРАБОТКА", "ВСТРЕЧА ПРОВЕДЕНА",
  ]);
  // But a real SORT always outranks the fallback.
  const withSort = buildStageCatalog({
    catalog: [
      { id: "S_MEET", name: "ВСТРЕЧА ПРОВЕДЕНА", categoryId: "1", sort: 10, semantics: "" },
      { id: "S_NEW", name: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", categoryId: "1", sort: 20, semantics: "" },
    ],
  });
  assert.deepEqual(withSort.map((stage) => stage.name), ["ВСТРЕЧА ПРОВЕДЕНА", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"]);
});

test("a Bitrix won/lost stage is terminal even when Settings has not listed it", () => {
  const catalog = buildStageCatalog({ catalog: IBOX_STAGES });
  // Nothing configured at all: Bitrix SEMANTICS alone must still end the funnel.
  const keys = terminalStageKeys(catalog, {});
  assert.equal(keys.has("1:C1:PAID"), true, "S = won stage");
  assert.equal(keys.has("1:C1:NR"), true, "F = lost stage");
  assert.equal(keys.has("1:C1:WORK"), false, "a process stage stays progression");
  const hist = buildHistorical(HISTORY, HIST_CATALOG, {});
  assert.equal(hist.progression.some((row) => row.key === "1:C1:PAID"), false,
    "the won stage no longer renders a 232/232/100% progression row");
  assert.deepEqual(hist.progression.filter((row) => !row.legacy).map((row) => row.stage),
    ["РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", "ОБРАБОТКА"]);
});

test("a process stage keeps its place even when its NAME looks terminal", () => {
  // Bitrix reports this mid-funnel stage as a normal process stage (sem: "")
  // and Settings has not classified it, so it is progression — renaming a stage
  // must never move it out of the funnel by text.
  const catalog = buildStageCatalog({
    catalog: [
      { id: "S_NEW", name: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", categoryId: "1", sort: 10, semantics: "" },
      { id: "S_NRLIKE", name: "Not Relevant", categoryId: "1", sort: 30, semantics: "" },
      { id: "S_LOSE", name: "Сделка провалена", categoryId: "1", sort: 120, semantics: "F" },
    ],
  });
  const keys = terminalStageKeys(catalog, {});
  assert.equal(keys.has("1:S_NRLIKE"), false, "not classified by display text");
  assert.equal(keys.has("1:S_LOSE"), true);
});

test("the fallback order survives Latin look-alike letters in Cyrillic names", () => {
  // Bitrix spells this stage with a Latin "e" (U+0065) as its last character.
  const bitrixName = "Первое касаниe";
  assert.equal(bitrixName.endsWith("е"), false, "the fixture really does carry the Latin homoglyph");
  const catalog = buildStageCatalog({
    live: [
      live({ dealId: "1", stageId: "S_DATA", stage: "ПОЛУЧЕНИЕ ДАННЫХ/ОПЛАТА" }),
      live({ dealId: "2", stageId: "S_TOUCH", stage: bitrixName }),
      live({ dealId: "3", stageId: "S_NEW", stage: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ" }),
    ],
  });
  assert.deepEqual(catalog.map((stage) => stage.stageId), ["S_NEW", "S_TOUCH", "S_DATA"],
    "Первое касание keeps its funnel position instead of falling to the end");
});
