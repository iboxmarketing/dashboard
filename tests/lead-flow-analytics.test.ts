import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LEAD_FLOW_METRICS, buildLeadFlow, leadFlowValue, tashkentParts,
} from "../lib/lead-flow-analytics";
import type { AnalyticsRecord, CreationPeriod, SlaStatus } from "../lib/types";

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-03T05:05:00.000Z", creationPeriod: "WORK_HOURS",
    wonAt: null, salesStatus: "ACTIVE", qualified: false, lossReasonGroup: "NONE",
    opportunity: 0, currencyId: "UZS", processingBusinessMinutes: null,
    salesCycleHours: null, slaStatus: "PENDING", customerKey: null,
    duplicateOfDealId: null, ...over,
  } as unknown as AnalyticsRecord;
}

function row(
  dealId: string,
  createdAt: string,
  slaStatus: SlaStatus,
  processingBusinessMinutes: number | null,
  creationPeriod: CreationPeriod = "WORK_HOURS",
) {
  return deal({ dealId, createdAt, slaStatus, processingBusinessMinutes, creationPeriod });
}

// Times below are UTC; Asia/Tashkent is UTC+5. Aggregate 2-hour buckets are:
// 10:00–12:00 = 4, 14:00–16:00 = 3, 18:00–20:00 = 2, 08:00–10:00 = 1.
const FIXTURE = [
  row("m10-on", "2026-08-03T05:05:00.000Z", "ON_TIME", 10, "AFTER_HOURS"),
  row("m10-late", "2026-08-03T05:30:00.000Z", "LATE", 30),
  row("m10-overdue", "2026-08-03T06:55:00.000Z", "OVERDUE_UNPROCESSED", null),
  row("t10-pending", "2026-08-04T05:10:00.000Z", "PENDING", null),
  row("m14-on-1", "2026-08-03T09:05:00.000Z", "ON_TIME", 6),
  row("m14-on-2", "2026-08-03T09:50:00.000Z", "ON_TIME", 12),
  row("w14-unknown", "2026-08-05T10:55:00.000Z", "UNKNOWN_EVIDENCE", null),
  row("m18-overdue", "2026-08-03T13:10:00.000Z", "OVERDUE_UNPROCESSED", null, "AFTER_HOURS"),
  row("t18-late", "2026-08-04T13:40:00.000Z", "LATE", 50),
  row("m08-pending", "2026-08-03T03:15:00.000Z", "PENDING", null),
  // Would inflate both volume and overdue if canonical ROUTING exclusion failed.
  row("routing", "2026-08-03T05:45:00.000Z", "OVERDUE_UNPROCESSED", null),
];
FIXTURE.at(-1)!.lossReasonGroup = "ROUTING";
FIXTURE.at(-1)!.salesStatus = "LOST";

const flow = buildLeadFlow(FIXTURE);
const cell = (weekday: number, bucket: number) => flow.cells.find((entry) => entry.weekday === weekday && entry.bucket === bucket)!;

test("A: Lead Flow excludes canonical ROUTING from every population", () => {
  assert.equal(FIXTURE.length, 11);
  assert.equal(flow.total, 10);
  assert.equal(flow.peakBucket?.leads, 4, "the routed overdue row did not inflate the peak");
  assert.equal(flow.peakBucket?.overdue, 1, "the routed overdue row did not inflate pressure");
});

test("B/C: weekday and 2-hour boundaries use Asia/Tashkent, never browser local time", () => {
  assert.deepEqual(tashkentParts("2026-08-02T19:30:00.000Z"), { weekday: 0, hour: 0 }, "UTC Sunday is Tashkent Monday");
  assert.equal(tashkentParts("2026-08-03T04:59:59.000Z").hour, 9);
  assert.equal(tashkentParts("2026-08-03T05:00:00.000Z").hour, 10);
  assert.equal(tashkentParts("2026-08-03T06:59:59.000Z").hour, 11);
  assert.equal(tashkentParts("2026-08-03T07:00:00.000Z").hour, 12);
  assert.equal(cell(0, 4).leads, 1, "09:xx belongs to 08:00–10:00");
  assert.equal(cell(0, 5).leads, 3, "10:xx and 11:xx belong to 10:00–12:00");
});

test("D/E/F: peak, busiest weekday and after-hours shares use eligible Leadlar", () => {
  assert.deepEqual([flow.peakBucket?.label, flow.peakBucket?.leads, flow.peakBucket?.share], ["10:00–12:00", 4, 40]);
  assert.deepEqual([flow.busiestWeekday?.label, flow.busiestWeekday?.leads, flow.busiestWeekday?.share], ["Dushanba", 7, 70]);
  assert.deepEqual([flow.afterHours.leads, flow.afterHours.share], [2, 20], "creationPeriod, not inferred clock time");
});

test("G/H: top-three peak risk counts only OVERDUE_UNPROCESSED", () => {
  assert.deepEqual(flow.topBuckets.map((entry) => [entry.label, entry.leads]), [
    ["10:00–12:00", 4], ["14:00–16:00", 3], ["18:00–20:00", 2],
  ]);
  assert.equal(flow.peakRisk.leads, 9);
  assert.equal(flow.peakRisk.overdue, 2, "ordinary LATE records are not overdue-unprocessed");
  assert.equal(flow.peakRisk.overdueRate, 22);
});

test("I/J/K/L: heatmap Leadlar and overdue zero/null behavior are explicit", () => {
  assert.equal(cell(0, 5).leads, 3);
  assert.equal(cell(0, 5).overdue, 1);
  assert.equal(cell(0, 5).overdueRate, 33, "OVERDUE_UNPROCESSED / Leadlar");
  assert.equal(cell(6, 0).overdueRate, null, "no leads means unavailable, not 0%");
  assert.equal(cell(0, 4).leads, 1);
  assert.equal(cell(0, 4).overdueRate, 0, "a real lead with zero overdue is 0%");
});

test("M/N: SLA uses the canonical resolved-evidence denominator", () => {
  assert.equal(cell(0, 5).slaDenominator, 3, "ON_TIME + LATE + OVERDUE_UNPROCESSED");
  assert.equal(cell(0, 5).slaRate, 33);
  assert.equal(cell(0, 4).slaDenominator, 0, "PENDING is outside the denominator");
  assert.equal(cell(0, 4).slaRate, null, "no resolved SLA evidence is unavailable");
});

test("O/P: Avg saralash averages only recorded processing evidence", () => {
  assert.equal(cell(0, 5).processingKnown, 2);
  assert.equal(cell(0, 5).avgProcessing, 20);
  assert.equal(cell(0, 4).processingKnown, 0);
  assert.equal(cell(0, 4).avgProcessing, null);
});

test("Q/R: selector exposes exactly four capacity metrics and no sales metric", () => {
  assert.deepEqual(LEAD_FLOW_METRICS.map(({ id, label }) => ({ id, label })), [
    { id: "volume", label: "Lead hajmi" },
    { id: "overdue_rate", label: "Muddati o'tgan %" },
    { id: "sla", label: "SLA %" },
    { id: "avg_processing", label: "Avg saralash" },
  ]);
  assert.equal(LEAD_FLOW_METRICS.some((entry) => /sale|sales|sotuv|revenue/i.test(`${entry.id} ${entry.label}`)), false);
  assert.equal(leadFlowValue(cell(6, 0), "volume"), 0, "zero volume stays a numeric zero");
  assert.equal(leadFlowValue(cell(6, 0), "sla"), null, "unavailable evidence stays null");
});

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const view = client.slice(client.indexOf("function LeadFlowView("), client.indexOf("function QualityView("));

test("S/T/U: Lead Flow removes the daily, hourly and duplicate weekday charts", () => {
  assert.doesNotMatch(view, /Kunlik Deal dinamikasi/);
  assert.doesNotMatch(view, /Soatlik lead hajmi/);
  assert.doesNotMatch(view, /<BarList/);
  assert.doesNotMatch(view, /daily-flow-chart|hour-chart/);
});

test("V: at most three deterministic staffing signals reuse the same aggregates", () => {
  assert.deepEqual(flow.staffingSignals.map((signal) => signal.id), ["peak_bucket", "busiest_weekday", "after_hours"]);
  assert.equal(flow.staffingSignals.length, 3);
  assert.equal(flow.staffingSignals[0].stats, flow.peakBucket);
  assert.equal(flow.staffingSignals[1].stats, flow.busiestWeekday);
  assert.equal(flow.staffingSignals[2].stats, flow.afterHours);
  assert.match(view, /flow\.staffingSignals\.map/);
});

test("heatmap renders missing evidence as an em dash", () => {
  assert.match(view, /\{format\(value\)\}/);
  assert.match(view, /if \(value === null\) return "—"/);
});

test("SLA legend describes low SLA as the darker risk state", () => {
  assert.doesNotMatch(view, /och rang = SLA past/);
  assert.match(view, /to‘q rang = SLA past · och rang = SLA yuqori/);
});
