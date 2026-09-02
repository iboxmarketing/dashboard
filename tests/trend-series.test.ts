import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TREND_METRIC, EXCLUDED_SALES_METRIC_IDS, MATURITY_COVERAGE_THRESHOLD, TREND_METRICS,
  buildTrendDays, buildTrendSeries, calendarSpine, movingAverage, supportsMovingAverage, tashkentDayKey, trendBarHeight, trendMetric, trendValue,
} from "../lib/trend-series";
import { summarizeSla } from "../lib/sla";
import type { AnalyticsRecord } from "../lib/types";

const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const client = code("../app/dashboard-client.tsx");

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME",
    stage: "Распределение", currentScope: null, customerKey: null, duplicateOfDealId: null,
    stageHistoryCount: 1, ...over,
  } as unknown as AnalyticsRecord;
}
const on = (date: string, over: Partial<AnalyticsRecord> = {}) => deal({ createdAt: `${date}T09:00:00.000Z`, ...over });

test("A: the default metric is Leadlar", () => {
  assert.equal(DEFAULT_TREND_METRIC, "leads");
  assert.equal(trendMetric("leads").label, "Leadlar");
  assert.match(client, /useState<TrendMetricId>\(DEFAULT_TREND_METRIC\)/);
});

test("B: days are grouped by the Asia/Tashkent calendar date, not UTC", () => {
  // 2026-08-18 21:30 UTC is already 02:30 on the 19th in Tashkent (+05:00).
  assert.equal(tashkentDayKey("2026-08-18T21:30:00.000Z"), "2026-08-19");
  assert.equal(tashkentDayKey("2026-08-18T18:59:59.000Z"), "2026-08-18", "23:59:59 local stays on the 18th");
  assert.equal(tashkentDayKey("2026-08-18T19:00:00.000Z"), "2026-08-19", "00:00 local is the next day");
  const days = buildTrendDays([
    deal({ dealId: "late", createdAt: "2026-08-18T21:30:00.000Z" }),
    deal({ dealId: "early", createdAt: "2026-08-18T05:00:00.000Z" }),
  ]);
  assert.deepEqual(days.map((day) => day.date), ["2026-08-18", "2026-08-19"]);
  assert.equal(days[0].leads, 1);
  assert.equal(days[1].leads, 1, "the late-night lead lands on the local next day");
});

test("C: routing is excluded from the daily Leadlar", () => {
  const days = buildTrendDays([
    on("2026-08-10"), on("2026-08-10"),
    on("2026-08-10", { salesStatus: "LOST", lossReasonGroup: "ROUTING" }),
  ]);
  assert.equal(days[0].leads, 2, "the routed deal is not a lead");
});

test("D/E/F/G/H: daily classification and quality use the canonical denominators", () => {
  const days = buildTrendDays([
    on("2026-08-10", { qualified: true, stage: "ОБРАБОТКА" }),
    on("2026-08-10", { qualified: true, salesStatus: "WON", wonAt: "2026-08-11T09:00:00.000Z", opportunity: 100 }),
    on("2026-08-10", { qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" }),
    on("2026-08-10", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
    on("2026-08-10"),
  ]);
  const day = days[0];
  assert.equal(day.leads, 5);
  assert.equal(day.sql, 3);
  assert.equal(day.notRelevant, 1);
  assert.equal(day.classified, day.sql + day.notRelevant, "D: Saralangan = SQL + Not Relevant");
  assert.equal(day.qualityAccepted, Math.round(day.sql / day.classified * 100), "E");
  assert.equal(day.lowQuality, Math.round(day.notRelevant / day.classified * 100), "F");
  assert.equal((day.qualityAccepted ?? 0) + (day.lowQuality ?? 0), 100, "G");
  assert.equal(day.coverage, Math.round(day.classified / day.leads * 100), "H");
  assert.equal(day.coverage, 80);
});

test("I: a low-coverage day is flagged immature without altering its rate", () => {
  // 10 leads, only 2 classified -> 20% coverage, well under the threshold.
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => on("2026-08-10", { dealId: `u${i}` })),
    on("2026-08-10", { dealId: "q", qualified: true }),
    on("2026-08-10", { dealId: "n", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  ];
  const { points } = buildTrendSeries(rows, [], "quality_accepted");
  const point = points[0];
  assert.equal(point.coverage, 20);
  assert.ok(point.coverage! < MATURITY_COVERAGE_THRESHOLD);
  assert.equal(point.immature, true, "flagged");
  assert.equal(point.value, 50, "the rate itself is untouched: 1 of 2 classified");
  // A well-covered day is not flagged, and coverage itself never is.
  const healthy = buildTrendSeries([on("2026-08-11", { qualified: true }), on("2026-08-11", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" })], [], "quality_accepted");
  assert.equal(healthy.points[0].coverage, 100);
  assert.equal(healthy.points[0].immature, false);
  assert.equal(buildTrendSeries(rows, [], "coverage").points[0].immature, false, "coverage is not a quality rate");
});

test("J/K: avg and median processing use the same eligible daily cohort", () => {
  const rows = [
    on("2026-08-10", { processingBusinessMinutes: 10 }),
    on("2026-08-10", { processingBusinessMinutes: 20 }),
    on("2026-08-10", { processingBusinessMinutes: 60 }),
    // Routed deals must influence neither statistic.
    on("2026-08-10", { processingBusinessMinutes: 100000, salesStatus: "LOST", lossReasonGroup: "ROUTING" }),
  ];
  const day = buildTrendDays(rows)[0];
  assert.equal(day.avgProcessing, 30, "(10+20+60)/3");
  assert.equal(day.medianProcessing, 20);
  assert.equal(day.leads, 3);
});

test("L/M: SLA uses the canonical rate; overdue counts only OVERDUE_UNPROCESSED", () => {
  const rows = [
    on("2026-08-10", { slaStatus: "ON_TIME" }), on("2026-08-10", { slaStatus: "ON_TIME" }),
    on("2026-08-10", { slaStatus: "LATE" }),
    on("2026-08-10", { slaStatus: "OVERDUE_UNPROCESSED" }),
    on("2026-08-10", { slaStatus: "PENDING" }),
  ];
  const day = buildTrendDays(rows)[0];
  const canonical = summarizeSla(rows);
  assert.equal(day.slaRate, canonical.rate);
  assert.equal(day.slaOnTime, 2);
  assert.equal(day.slaDenominator, 4, "ON_TIME + LATE + OVERDUE_UNPROCESSED");
  assert.equal(day.overdue, 1, "LATE is not currently-overdue");
  assert.equal(day.overdueRate, Math.round(1 / day.leads * 100));
});

test("N: a day with no usable evidence is null, never a misleading zero", () => {
  const rows = [on("2026-08-10", { processingBusinessMinutes: null, slaStatus: "PENDING" })];
  const day = buildTrendDays(rows)[0];
  assert.equal(day.avgProcessing, null, "no processing observation is not 0 minutes");
  assert.equal(day.medianProcessing, null);
  assert.equal(day.slaRate, null, "an empty SLA denominator is not 0%");
  assert.equal(day.leads, 1, "but the lead count is a genuine 1");
  // An unclassified day has no quality rate at all.
  assert.equal(day.classified, 0);
  assert.equal(day.qualityAccepted, null);
  assert.equal(day.lowQuality, null);
  assert.equal(day.coverage, 0, "0% classified is a real statement");
  // The bar renders as empty rather than as a zero value.
  assert.match(client, /point\.value === null \? "trend-empty" : undefined/);
});

test("O: values format with their unit", () => {
  assert.equal(trendMetric("leads").unit, "count");
  assert.equal(trendMetric("quality_accepted").unit, "percent");
  assert.equal(trendMetric("avg_processing").unit, "minutes");
  assert.equal(trendMetric("overdue").unit, "count");
  assert.match(client, /if \(definition\.unit === "minutes"\) return fmtMinutes\(value\)/);
  assert.match(client, /return `\$\{Math\.round\(value\)\}%`/);
  assert.match(client, /return `\$\{Math\.round\(value\)\} ta`/);
  assert.match(client, /if \(value === null\) return "—"/);
  // The tooltip names the day and the metric, and adds only related context.
  assert.match(client, /Saralash qamrovi: /);
  assert.match(client, /leadlardan/);
  assert.match(client, /Oldingi davr: /);
});

test("P: the 7-day moving average trails, skips gaps and never looks forward", () => {
  assert.deepEqual(movingAverage([1, 2, 3], 7), [1, 1.5, 2], "uses available trailing days at the start");
  const eight = movingAverage([1, 1, 1, 1, 1, 1, 1, 8], 7);
  assert.equal(eight[6], 1);
  assert.equal(eight[7], (1 * 6 + 8) / 7, "the window is the last 7 only");
  assert.deepEqual(movingAverage([null, null], 7), [null, null], "no values, no line");
  assert.deepEqual(movingAverage([4, null, 6], 7), [4, 4, 5], "a gap is skipped, not read as zero");
  // Percentage metrics deliberately have no line.
  assert.equal(supportsMovingAverage("leads"), true);
  assert.equal(supportsMovingAverage("avg_processing"), true);
  for (const id of ["coverage", "quality_accepted", "low_quality", "sla"] as const)
    assert.equal(supportsMovingAverage(id), false, `${id} must not get a moving average`);
});

test("Q/R: the previous period aligns by relative day and uses the same formula", () => {
  const current = [on("2026-08-10"), on("2026-08-10"), on("2026-08-11")];
  const previous = [on("2026-07-11"), on("2026-07-12"), on("2026-07-12"), on("2026-07-12")];
  const { points, hasPrevious } = buildTrendSeries(current, previous, "leads");
  assert.equal(hasPrevious, true);
  assert.equal(points[0].date, "2026-08-10");
  assert.equal(points[0].value, 2);
  assert.equal(points[0].previous, 1, "day 1 vs day 1, not calendar date vs calendar date");
  assert.equal(points[1].previous, 3, "day 2 vs day 2");
  // The previous value is the same metric computed the same way.
  const previousDays = buildTrendDays(previous);
  assert.equal(points[0].previous, trendValue(previousDays[0], "leads"));
  // Quality uses the previous day's own classified denominator.
  const q = buildTrendSeries(
    [on("2026-08-10", { qualified: true }), on("2026-08-10", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" })],
    [on("2026-07-11", { qualified: true }), on("2026-07-11", { qualified: true }), on("2026-07-11", { salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" })],
    "quality_accepted");
  assert.equal(q.points[0].value, 50, "1 of 2 classified");
  assert.equal(q.points[0].previous, 67, "2 of 3 classified — its own denominator");
  // No history: the comparison disappears rather than showing zeros.
  const none = buildTrendSeries(current, [], "leads");
  assert.equal(none.hasPrevious, false);
  assert.equal(none.points[0].previous, null);
});

test("S: sales metrics are absent from the created-cohort trend", () => {
  const ids = TREND_METRICS.map((entry) => entry.id) as string[];
  for (const excluded of EXCLUDED_SALES_METRIC_IDS)
    assert.equal(ids.includes(excluded), false, `${excluded} must not be selectable here`);
  for (const label of ["Davr sotuv", "Sotuv summasi", "Cohort sotuv", "Lead → Sotuv", "SQL → Sotuv", "Savdo sikli"])
    assert.equal(TREND_METRICS.some((entry) => entry.label === label), false, `${label} must not be a trend metric`);
  assert.equal(TREND_METRICS.length, 11);
  assert.deepEqual([...new Set(TREND_METRICS.map((entry) => entry.group))], ["LEAD OQIMI", "LEAD SIFATI", "OPERATSIYA"]);
  // The reason is written down where the next person will look.
  const source = readFileSync(new URL("../lib/trend-series.ts", import.meta.url), "utf8");
  assert.match(source, /average sales cycle is 5–6 days/i);
  assert.match(source, /`createdAt`/);
  assert.match(source, /`wonAt`/);
});

test("the selector groups metrics and the chart draws all three layers", () => {
  const chart = client.slice(client.indexOf("function TrendChart("), client.indexOf("function ManagerDetailView("));
  assert.match(chart, /<optgroup key=\{group\} label=\{group\}>/);
  assert.match(chart, /trend-average/); assert.match(chart, /trend-previous/);
  assert.match(chart, /supportsMovingAverage\(metric\)/);
  assert.match(chart, /buildTrendSeries\(records, previousRecords, metric, bounds \?\? undefined, previousBounds \?\? undefined\)/, "no per-chart formulas");
  assert.match(client, /<TrendChart records=\{cohortFiltered\} previousRecords=\{previousCohortFiltered\} bounds=\{trendBounds\} previousBounds=\{previousTrendBounds\} \/>/);
});

// ------------------------------------------------- calendar spine (bounds) ---

test("A/B/C: a day with no records still exists, as a real zero with null rates", () => {
  const days = buildTrendDays(
    [on("2026-08-01"), on("2026-08-01"), on("2026-08-03", { qualified: true })],
    { from: "2026-08-01", to: "2026-08-03" },
  );
  assert.equal(days.length, 3, "A: the axis comes from the period, not the data");
  assert.deepEqual(days.map((d) => d.date), ["2026-08-01", "2026-08-02", "2026-08-03"]);

  const empty = days[1];
  assert.equal(empty.leads, 0, "B: zero leads is a real business fact");
  assert.equal(empty.classified, 0);
  assert.equal(empty.sql, 0);
  assert.equal(empty.notRelevant, 0);
  assert.equal(empty.overdue, 0);
  // C: no denominator, no evidence -> null, never a misleading zero.
  assert.equal(empty.coverage, null);
  assert.equal(empty.qualityAccepted, null);
  assert.equal(empty.lowQuality, null);
  assert.equal(empty.slaRate, null);
  assert.equal(empty.avgProcessing, null);
  assert.equal(empty.medianProcessing, null);
  assert.equal(empty.overdueRate, null);
});

test("I/J: leading and trailing zero days survive", () => {
  const days = buildTrendDays([on("2026-08-03")], { from: "2026-08-01", to: "2026-08-05" });
  assert.equal(days.length, 5);
  assert.deepEqual(days.map((d) => d.leads), [0, 0, 1, 0, 0], "leading and trailing zeros kept");
  // Without bounds the old behaviour would have collapsed this to one point.
  assert.equal(buildTrendDays([on("2026-08-03")]).length, 1);
});

test("H: a 30-day filter produces 30 calendar positions", () => {
  assert.equal(calendarSpine({ from: "2026-08-03", to: "2026-09-01" }).length, 30);
  assert.equal(calendarSpine({ from: "2026-08-01", to: "2026-08-01" }).length, 1, "Bugun");
  assert.equal(calendarSpine({ from: "2026-08-26", to: "2026-09-01" }).length, 7, "Oxirgi 7 kun");
  assert.equal(calendarSpine({ from: "2026-09-01", to: "2026-09-01" }).length, 1, "Kecha/Bugun");
  assert.equal(calendarSpine({ from: "2026-07-01", to: "2026-07-31" }).length, 31, "O‘tgan oy");
  // Month and year rollovers step correctly.
  assert.deepEqual(calendarSpine({ from: "2026-08-30", to: "2026-09-02" }), ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  assert.deepEqual(calendarSpine({ from: "2026-12-31", to: "2027-01-01" }), ["2026-12-31", "2027-01-01"]);
  assert.deepEqual(calendarSpine({ from: "2028-02-28", to: "2028-03-01" }), ["2028-02-28", "2028-02-29", "2028-03-01"], "leap day");
  assert.deepEqual(calendarSpine({ from: "2026-08-05", to: "2026-08-01" }), [], "an inverted range is empty, not infinite");
});

test("D: a zero calendar day participates in a count moving average", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => on("2026-08-01", { dealId: `a${i}` })),
    ...Array.from({ length: 8 }, (_, i) => on("2026-08-03", { dealId: `c${i}` })),
  ];
  const { points } = buildTrendSeries(rows, [], "leads", { from: "2026-08-01", to: "2026-08-03" });
  assert.deepEqual(points.map((p) => p.value), [10, 0, 8]);
  assert.deepEqual(points.map((p) => p.average), [10, 5, 6], "(10)/1, (10+0)/2, (10+0+8)/3");
});

test("a numeric zero has zero bar height while a small positive value stays visible", () => {
  assert.equal(trendBarHeight(0, 100), 0, "zero cannot look like a positive count");
  assert.equal(trendBarHeight(null, 100), 0, "null remains the no-data state");
  assert.equal(trendBarHeight(1, 100), 3, "a real small positive value may use the visible minimum");
  assert.equal(trendBarHeight(50, 100), 50);
  assert.match(client, /trendBarHeight\(value, max\)/, "the rendered bars use the tested scale");
  const css = code("../app/globals.css");
  const barRule = css.match(/\.trend-column > span \{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(barRule, /min-height/, "CSS cannot force a zero-height bar back into view");
});

test("E: a null-evidence day is still skipped by the processing moving average", () => {
  const rows = [
    on("2026-08-01", { processingBusinessMinutes: 10 }),
    on("2026-08-03", { processingBusinessMinutes: 20 }),
  ];
  const { points } = buildTrendSeries(rows, [], "avg_processing", { from: "2026-08-01", to: "2026-08-03" });
  assert.deepEqual(points.map((p) => p.value), [10, null, 20], "the empty day has no measurement");
  assert.deepEqual(points.map((p) => p.average), [10, 10, 15], "null is skipped, not read as 0 minutes");
});

test("F/G: relative alignment holds when either period has a zero-lead day", () => {
  const current = { from: "2026-08-01", to: "2026-08-03" };
  const previous = { from: "2026-07-01", to: "2026-07-03" };
  // F: current has the gap, previous does not.
  const f = buildTrendSeries(
    [on("2026-08-01"), on("2026-08-03")],
    [on("2026-07-01"), on("2026-07-02"), on("2026-07-02"), on("2026-07-03")],
    "leads", current, previous);
  assert.deepEqual(f.points.map((p) => p.value), [1, 0, 1]);
  assert.deepEqual(f.points.map((p) => p.previous), [1, 2, 1], "day 2 still compares with day 2");
  // G: previous has the gap, current does not.
  const g = buildTrendSeries(
    [on("2026-08-01"), on("2026-08-02"), on("2026-08-03")],
    [on("2026-07-01"), on("2026-07-03")],
    "leads", current, previous);
  assert.deepEqual(g.points.map((p) => p.value), [1, 1, 1]);
  assert.deepEqual(g.points.map((p) => p.previous), [1, 0, 1], "the previous gap is a real zero");
  // No history at all still hides the comparison.
  const none = buildTrendSeries([on("2026-08-01")], [], "leads", current, previous);
  assert.equal(none.hasPrevious, false);
  assert.deepEqual(none.points.map((p) => p.previous), [null, null, null]);
});

test("L: a zero-lead day is never labelled an immature cohort", () => {
  const { points } = buildTrendSeries(
    [on("2026-08-01", { qualified: true })],
    [], "quality_accepted", { from: "2026-08-01", to: "2026-08-02" });
  const zeroDay = points[1];
  assert.equal(zeroDay.leads, 0);
  assert.equal(zeroDay.value, null);
  assert.equal(zeroDay.coverage, null);
  assert.equal(zeroDay.immature, false, "there is no cohort that day to be immature");
  // The warning still fires where it should: leads > 0 and coverage below threshold.
  const low = buildTrendSeries(
    [...Array.from({ length: 9 }, (_, i) => on("2026-08-01", { dealId: `u${i}` })), on("2026-08-01", { dealId: "q", qualified: true })],
    [], "quality_accepted", { from: "2026-08-01", to: "2026-08-01" });
  assert.equal(low.points[0].coverage, 10);
  assert.equal(low.points[0].immature, true);
});

test("K: the Tashkent boundary still decides which calendar slot a lead lands in", () => {
  const days = buildTrendDays(
    [deal({ createdAt: "2026-08-18T21:30:00.000Z" })],
    { from: "2026-08-18", to: "2026-08-19" },
  );
  assert.deepEqual(days.map((d) => d.leads), [0, 1], "02:30 Tashkent belongs to the 19th");
  const edge = buildTrendDays(
    [deal({ createdAt: "2026-08-18T18:59:59.000Z" })],
    { from: "2026-08-18", to: "2026-08-19" },
  );
  assert.deepEqual(edge.map((d) => d.leads), [1, 0], "23:59:59 Tashkent stays on the 18th");
});
