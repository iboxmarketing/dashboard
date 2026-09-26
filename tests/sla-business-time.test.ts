import assert from "node:assert/strict";
import test from "node:test";

import { buildAnalyticsRecords } from "../lib/analytics";
import { businessSlaMinutes, defaultSettings, elapsedCalendarMinutes } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { elapsedSlaMinutes, resolveSlaState } from "../lib/sla";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";
import type { RawStageHistory } from "../lib/analytics";

/**
 * The employee SLA: scheduled working minutes between distribution and the
 * seller's first move out of the distributed stage.
 *
 * Owner rules being locked here (2026-09-26):
 *  - official hours 10:00–18:00 Asia/Tashkent, Sunday and holidays closed;
 *  - the clock pauses outside the working period, it never runs overnight;
 *  - a voluntary off-hours response closes at 0 minutes, never negative and
 *    never "wait for Monday and charge the weekend";
 *  - no call tracking — the stage timeline is the only evidence;
 *  - the team average is the average of every completed Deal value, NOT the
 *    average of per-seller averages.
 */

/**
 * The production calendar, verified against app_settings on 2026-09-26:
 * Mon–Fri 10:00–18:00 Asia/Tashkent, Saturday and Sunday closed. The holiday
 * below stands in for the configured one so the holiday case is deterministic.
 */
const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  timezone: "Asia/Tashkent",
  schedule: {
    0: { enabled: false, start: "10:00", end: "18:00" },
    1: { enabled: true, start: "10:00", end: "18:00" },
    2: { enabled: true, start: "10:00", end: "18:00" },
    3: { enabled: true, start: "10:00", end: "18:00" },
    4: { enabled: true, start: "10:00", end: "18:00" },
    5: { enabled: true, start: "10:00", end: "18:00" },
    6: { enabled: false, start: "10:00", end: "18:00" },
  },
  holidays: ["2026-09-24"],
  slaMinutes: 240,
};

/** Asia/Tashkent is UTC+5 all year: no DST to reason about. */
const at = (local: string) => `${local}+05:00`;
const sla = (start: string, stop: string) => businessSlaMinutes(at(start), at(stop), SETTINGS);

// 2026-09-20 is a Sunday; 21–26 are Mon–Sat; 2026-09-24 (Thursday) is a holiday.

test("1. same working day: the full gap counts", () => {
  assert.equal(sla("2026-09-21T10:05:00", "2026-09-21T10:35:00"), 30);
  assert.equal(sla("2026-09-21T11:00:00", "2026-09-21T17:00:00"), 360);
});

test("2. crossing 18:00: the evening is not charged, the next morning is", () => {
  // 17:30 -> 18:00 = 30 min, then 10:00 -> 10:10 next day = 10 min.
  assert.equal(sla("2026-09-21T17:30:00", "2026-09-22T10:10:00"), 40);
  // A stop after 18:00 on the same day stops the clock at 18:00.
  assert.equal(sla("2026-09-21T17:40:00", "2026-09-21T23:50:00"), 20);
});

test("3. before 10:00: the clock starts at the opening bell", () => {
  assert.equal(sla("2026-09-21T08:00:00", "2026-09-21T10:30:00"), 30);
  // Answered before opening: voluntary, so zero working minutes elapsed.
  assert.equal(sla("2026-09-21T07:00:00", "2026-09-21T08:15:00"), 0);
});

test("4. overnight: only the two working fragments count", () => {
  // Distributed 20:00 Monday, answered 10:20 Tuesday: 20 working minutes.
  assert.equal(sla("2026-09-21T20:00:00", "2026-09-22T10:20:00"), 20);
  // Distributed 09:00 Monday, answered 11:00 Tuesday: Mon 10:00-18:00 (480)
  // + Tue 10:00-11:00 (60).
  assert.equal(sla("2026-09-21T09:00:00", "2026-09-22T11:00:00"), 540);
});

test("5. Sunday -> Monday: the closed day contributes nothing", () => {
  // Distributed Sunday 12:00, answered Monday 10:45 => 45 minutes.
  assert.equal(sla("2026-09-20T12:00:00", "2026-09-21T10:45:00"), 45);
});

test("6. a voluntary Sunday response is 0 minutes, never negative", () => {
  assert.equal(sla("2026-09-20T09:00:00", "2026-09-20T14:00:00"), 0);
  assert.equal(sla("2026-09-20T09:00:00", "2026-09-20T23:59:00"), 0);
  // And the calendar span is still reported honestly beside it.
  assert.equal(elapsedCalendarMinutes(at("2026-09-20T09:00:00"), at("2026-09-20T14:00:00")), 300);
});

test("7. a holiday is skipped and the next working day is charged", () => {
  // Distributed Wednesday 17:50, Thursday is a holiday, answered Friday 10:30.
  assert.equal(sla("2026-09-23T17:50:00", "2026-09-25T10:30:00"), 40);
  // Answered during the holiday itself: voluntary, 0 minutes.
  assert.equal(sla("2026-09-24T09:00:00", "2026-09-24T16:00:00"), 0);
});

test("8. a multi-day delay accumulates whole working days", () => {
  // Mon 10:00 -> Wed 10:00 = two full days.
  assert.equal(sla("2026-09-21T10:00:00", "2026-09-23T10:00:00"), 960);
  // Mon 10:00 -> Fri 12:00 crosses the holiday: Mon+Tue+Wed (1440), Thu skipped,
  // Fri 10:00-12:00 (120).
  assert.equal(sla("2026-09-21T10:00:00", "2026-09-25T12:00:00"), 1560);
});

test("9. no stop event: pending, never a fabricated duration", () => {
  assert.equal(businessSlaMinutes(at("2026-09-21T10:00:00"), null, SETTINGS), null);
  assert.equal(businessSlaMinutes(null, at("2026-09-21T10:00:00"), SETTINGS), null);
  assert.equal(businessSlaMinutes(null, null, SETTINGS), null);
  assert.equal(businessSlaMinutes(at("2026-09-21T10:00:00"), undefined, SETTINGS), null);
  assert.equal(elapsedCalendarMinutes(at("2026-09-21T10:00:00"), null), null);
});

test("10. stop before start, and malformed timestamps, are handled safely", () => {
  assert.equal(sla("2026-09-21T12:00:00", "2026-09-21T11:00:00"), 0, "never negative");
  assert.equal(sla("2026-09-21T12:00:00", "2026-09-21T12:00:00"), 0);
  assert.equal(businessSlaMinutes("not-a-date", at("2026-09-21T12:00:00"), SETTINGS), null);
  assert.equal(businessSlaMinutes(at("2026-09-21T12:00:00"), "not-a-date", SETTINGS), null);
  assert.equal(elapsedCalendarMinutes(at("2026-09-21T12:00:00"), at("2026-09-21T11:00:00")), 0);
  assert.equal(elapsedCalendarMinutes("not-a-date", "also-not"), null);
});

// ---- Evidence: which two timestamps the builder picks -----------------------

const DISTRIBUTION = "C3:NEW";
const stageMeta = new Map([
  [DISTRIBUTION, { sort: 10, categoryId: "3" }],
  ["C3:UC_NOANSWER", { sort: 20, categoryId: "3" }],
  ["C3:UC_FIRST", { sort: 30, categoryId: "3" }],
  ["C3:UC_PROCESS", { sort: 40, categoryId: "3" }],
]);

function build(histories: { stage: string; at: string }[], dealId = "1") {
  return buildAnalyticsRecords({
    deals: [{
      ID: dealId, TITLE: `Deal ${dealId}`, DATE_CREATE: at(histories[0].at), ASSIGNED_BY_ID: "25",
      CATEGORY_ID: "3", STAGE_ID: histories.at(-1)!.stage,
    }],
    stageHistories: histories.map((row) => ({
      OWNER_ID: dealId, CATEGORY_ID: "3", STAGE_ID: row.stage, CREATED_TIME: at(row.at),
    })) as RawStageHistory[],
    settings: { ...SETTINGS, selectedPipelineIds: ["3"] },
    users: new Map([["25", "Abdulaziz Abdurahmonov"]]), pipelines: new Map([["3", "IBOX Sales"]]),
    stages: new Map([[DISTRIBUTION, "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"], ["C3:UC_NOANSWER", "НЕТ ОТВЕТА"], ["C3:UC_FIRST", "Первое касание"], ["C3:UC_PROCESS", "ОБРАБОТКА"]]),
    sources: new Map(), stageMeta, domain: null, stageHistoryAvailable: true,
  })[0];
}

test("evidence: the clock starts on entry to the distributed stage", () => {
  const row = build([
    { stage: DISTRIBUTION, at: "2026-09-21T10:00:00" },
    { stage: "C3:UC_PROCESS", at: "2026-09-21T10:25:00" },
  ]);
  assert.equal(row.slaStartAt, new Date(at("2026-09-21T10:00:00")).toISOString());
  assert.equal(row.slaBusinessMinutes, 25);
  assert.equal(row.slaElapsedMinutes, 25);
  assert.equal(row.slaStopStage, "ОБРАБОТКА");
});

test("evidence: НЕТ ОТВЕТА and Первое касание stop the clock exactly as ОБРАБОТКА does", () => {
  for (const [stage, name, minutes] of [["C3:UC_NOANSWER", "НЕТ ОТВЕТА", 15], ["C3:UC_FIRST", "Первое касание", 15]] as const) {
    const row = build([
      { stage: DISTRIBUTION, at: "2026-09-21T10:00:00" },
      { stage, at: "2026-09-21T10:15:00" },
      { stage: "C3:UC_PROCESS", at: "2026-09-22T11:00:00" },
    ]);
    assert.equal(row.slaStopStage, name, "the FIRST move out wins");
    assert.equal(row.slaBusinessMinutes, minutes);
  }
});

test("evidence: a Deal still sitting in distribution has no SLA value yet", () => {
  const row = build([{ stage: DISTRIBUTION, at: "2026-09-21T10:00:00" }]);
  assert.equal(row.slaStartAt, new Date(at("2026-09-21T10:00:00")).toISOString());
  assert.equal(row.slaStopAt, null);
  assert.equal(row.slaBusinessMinutes, null, "no duration is invented while the Deal waits");
  assert.equal(row.slaElapsedMinutes, null);
  // Pending or overdue depending only on how much working time has passed — and
  // measured from distribution, exactly where a completed SLA is measured from.
  const pendingRow = { slaBusinessMinutes: null, slaStartAt: row.slaStartAt, processingBusinessMinutes: null, processingSource: "NO_PROCESSING" as const };
  assert.equal(resolveSlaState(pendingRow, SETTINGS, new Date(at("2026-09-21T12:00:00"))), "PENDING", "120 working minutes of a 240 limit");
  assert.equal(resolveSlaState(pendingRow, SETTINGS, new Date(at("2026-09-22T15:00:00"))), "OVERDUE_UNPROCESSED");
  assert.equal(elapsedSlaMinutes(pendingRow, SETTINGS, new Date(at("2026-09-21T12:00:00"))), 120);
  // A Sunday distribution that nobody has touched yet has burned no SLA at all.
  assert.equal(elapsedSlaMinutes({ ...pendingRow, slaStartAt: new Date(at("2026-09-20T11:00:00")).toISOString() }, SETTINGS, new Date(at("2026-09-20T18:00:00"))), 0);
});

test("evidence: a re-entry into distribution does not restart or stop the clock", () => {
  const row = build([
    { stage: DISTRIBUTION, at: "2026-09-21T10:00:00" },
    { stage: DISTRIBUTION, at: "2026-09-21T10:05:00" },
    { stage: "C3:UC_PROCESS", at: "2026-09-21T10:30:00" },
  ]);
  assert.equal(row.slaStartAt, new Date(at("2026-09-21T10:00:00")).toISOString(), "the first entry is the start");
  assert.equal(row.slaBusinessMinutes, 30);
});

// ---- Aggregation: never an average of averages ------------------------------

function metricsRow(over: Partial<DashboardRecord>): DashboardRecord {
  return {
    dealId: "1", title: "Deal", createdAt: "2026-09-21T05:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: true, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    categoryId: "3", originCategoryId: "3", pipeline: "IBOX Sales", originPipeline: "IBOX Sales",
    projectLeadMembership: "INCLUDED", stage: "ОБРАБОТКА", stageHistoryCount: 2,
    processingBusinessMinutes: 10, slaStatus: "ON_TIME", source: "CRM-форма",
    ...over,
  } as unknown as DashboardRecord;
}

test("team average SLA averages Deals, not seller averages", () => {
  // Seller A answered 10 Deals at 10 minutes; seller B answered one at 1000.
  const rows: DashboardRecord[] = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push(metricsRow({ dealId: `a-${index}`, salesManagerId: "25", slaBusinessMinutes: 10, slaElapsedMinutes: 10 }));
  }
  rows.push(metricsRow({ dealId: "b-1", salesManagerId: "207", slaBusinessMinutes: 1000, slaElapsedMinutes: 4000 }));
  // Pending Deals must not be counted as zero.
  rows.push(metricsRow({ dealId: "c-1", salesManagerId: "561", slaBusinessMinutes: null, slaElapsedMinutes: null, slaStatus: "PENDING" }));

  const metrics = buildDashboardMetrics(rows, []);
  assert.equal(metrics.timing.sla_completed, 11, "only completed Deals enter the average");
  assert.equal(metrics.timing.sla_avg, (10 * 10 + 1000) / 11);
  const averageOfAverages = (10 + 1000) / 2;
  assert.notEqual(metrics.timing.sla_avg, averageOfAverages, "an average of seller averages would read 505");
  assert.equal(metrics.timing.sla_median, 10, "the median resists the single outlier");
  assert.equal(metrics.timing.sla_elapsed_avg, (10 * 10 + 4000) / 11);
});

test("the median is the middle Deal value, not a rate", () => {
  const rows = [5, 15, 25, 35].map((minutes, index) => metricsRow({
    dealId: `d-${index}`, salesManagerId: "25", slaBusinessMinutes: minutes, slaElapsedMinutes: minutes,
  }));
  const metrics = buildDashboardMetrics(rows, []);
  assert.equal(metrics.timing.sla_median, 20, "even count averages the two middle values");
  assert.equal(metrics.timing.sla_avg, 20);
});
