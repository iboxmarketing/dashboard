import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultSettings } from "../lib/business-time";
import { DEFAULT_HEADLINE_CARD_IDS, headlineCardLabel, resolveHeadlineCardIds } from "../lib/dashboard-cards";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { durationGap, formatDurationMinutes, teamComparisonLabel } from "../lib/format-duration";
import { managerSection, prepareSalesRecords, type SalesQuery } from "../lib/sales-sections";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/**
 * The response-time group is THREE cards, one question each:
 *
 *   SLA — javob vaqti      working minutes from distribution to the first move
 *   Kalendar javob vaqti   the same interval on the wall clock — informational
 *   Saralash vaqti         lead → quality verdict, a different measure entirely
 *
 * They were one card carrying five numbers, which nobody could read. These tests
 * keep them apart, keep the SLA Deal-weighted, and keep the seller profile saying
 * the same thing as the team dashboard.
 */

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const slice = (from: string, to: string) => client.slice(client.indexOf(from), client.indexOf(to));

const SELLERS: [string, string][] = [["25", "Abdulaziz"], ["207", "Soxib"], ["561", "Abdulloh"]];
const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  salesStaffIds: SELLERS.map(([id]) => id), slaMinutes: 240,
};
const QUERY = {
  from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "",
  period: "", sla: "", processing: "", search: "",
} as SalesQuery;

function record(over: Partial<DashboardRecord>): DashboardRecord {
  return {
    dealId: "1", title: "Deal", createdAt: "2026-09-07T05:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: true, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    categoryId: "3", originCategoryId: "3", pipeline: "IBOX Sales", originPipeline: "IBOX Sales",
    projectLeadMembership: "INCLUDED", stage: "ОБРАБОТКА", stageHistoryCount: 2,
    processingBusinessMinutes: 600, slaStatus: "ON_TIME", source: "CRM-форма",
    // Version-16 records carry their own SLA evidence; the runtime re-resolves the
    // state from it, so a fixture that omits it would be read as a legacy row.
    slaStartAt: "2026-09-07T05:10:00.000Z", slaStopStage: "ОБРАБОТКА",
    salesManagerId: null, salesManager: null, salesManagerAttribution: "UNKNOWN",
    ...over,
  } as unknown as DashboardRecord;
}

/**
 * Seller 25 answers ten Deals in 10 minutes; seller 207 answers one in 1000;
 * seller 561 has one Deal still waiting and one with no distribution evidence.
 */
function population() {
  const rows: DashboardRecord[] = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push(record({
      dealId: `a-${index}`, assignedManagerId: "25", assignedManager: "Abdulaziz",
      slaBusinessMinutes: 10, slaElapsedMinutes: 30, slaStatus: "ON_TIME",
    }));
  }
  rows.push(record({
    dealId: "b-1", assignedManagerId: "207", assignedManager: "Soxib",
    slaBusinessMinutes: 1000, slaElapsedMinutes: 4000, slaStatus: "LATE",
  }));
  rows.push(record({
    dealId: "c-1", assignedManagerId: "561", assignedManager: "Abdulloh",
    slaBusinessMinutes: null, slaElapsedMinutes: null, slaStatus: "OVERDUE_UNPROCESSED", stage: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ",
  }));
  rows.push(record({
    dealId: "c-2", assignedManagerId: "561", assignedManager: "Abdulloh",
    slaBusinessMinutes: null, slaElapsedMinutes: null, slaStatus: "UNKNOWN_EVIDENCE",
    slaStartAt: null, slaStopStage: null,
  }));
  return prepareSalesRecords(rows, SETTINGS, new Date("2026-09-30T00:00:00Z"));
}

test("the SLA card carries no calendar and no qualification clutter", () => {
  const sla = slice("    sla_avg: {", "    sla_elapsed: {");
  assert.match(sla, /timing\.sla_avg/, "the working-time average is the value");
  assert.match(sla, /timing\.sla_median/);
  assert.match(sla, /SLA ichida \{metrics\.rates\.sla\}%/);
  assert.match(sla, /\{metrics\.sla\.onTime\}\/\{metrics\.sla\.denominator\}/);
  assert.doesNotMatch(sla, /sla_elapsed_avg/, "calendar elapsed is a card of its own");
  assert.doesNotMatch(sla, /timing\.avg_processing/, "qualification time is a card of its own");
  assert.match(sla, /hint: SLA_WORK_TIME_HINT/, "how it is measured is a tooltip, not a fourth line");
  assert.match(client, /const SLA_WORK_TIME_HINT = "Faqat rasmiy ish vaqti 10:00–18:00 hisoblanadi\. Dam olish va ish vaqtidan tashqari vaqt SLAga qo‘shilmaydi\."/);
});

test("Kalendar javob vaqti is separate, and informational only", () => {
  const calendar = slice("    sla_elapsed: {", "    avg_processing: {");
  assert.match(calendar, /timing\.sla_elapsed_avg/);
  assert.match(calendar, /Real o‘tgan vaqt · tun va dam olish kunlari ham kiradi/);
  assert.doesNotMatch(calendar, /rates\.sla|timing\.sla_avg|sla\.onTime/,
    "it must not touch the SLA score or the ranking");
  assert.match(calendar, /SLA bahosiga va xodimlar reytingiga ta’sir qilmaydi/);
});

test("Saralash vaqti is separate, and keeps its own formula", () => {
  const processing = slice("    avg_processing: {", "    sales_cycle: {");
  assert.match(processing, /timing\.avg_processing/);
  assert.match(processing, /Leaddan sifat bo‘yicha qarorgacha/);
  assert.doesNotMatch(processing, /rates\.sla|sla_elapsed_avg|timing\.sla_avg/);
  assert.equal(headlineCardLabel("avg_processing"), "Saralash vaqti");
});

test("the three cards are offered by default, in one order, and nothing else was added", () => {
  const response = DEFAULT_HEADLINE_CARD_IDS.filter((id) => ["sla_avg", "sla_elapsed", "avg_processing"].includes(id));
  assert.deepEqual(response, ["sla_avg", "sla_elapsed", "avg_processing"]);
  // A dashboard still holding the old single card gets exactly these three.
  assert.deepEqual(resolveHeadlineCardIds(["leads", "avg_processing"]), ["leads", "sla_avg", "sla_elapsed", "avg_processing"]);
  // Production's stored layout, as read from app_settings on 2026-09-26.
  const stored = ["leads", "classified_leads", "sql", "not_relevant", "sales_lost", "cohort_sales",
    "period_sales", "avg_check", "sales_cycle", "active_cohort", "avg_processing", "lead_to_sql"];
  assert.deepEqual(resolveHeadlineCardIds(stored).filter((id) => id.startsWith("sla_") || id === "avg_processing"),
    ["sla_avg", "sla_elapsed", "avg_processing"]);
  assert.equal(resolveHeadlineCardIds(stored).length, stored.length + 2, "three cards where one stood");
});

test("the seller profile shows the same three cards, with exactly one team comparison", () => {
  const profile = slice("A. Joriy Sales natijalari", "Source funnel");
  for (const label of ["SLA — javob vaqti", "Kalendar javob vaqti", "Saralash vaqti"]) {
    assert.equal(profile.split(`label="${label}"`).length - 1, 1, `${label} appears once`);
  }
  const slaCard = profile.slice(profile.indexOf('label="SLA — javob vaqti"'), profile.indexOf('label="Kalendar javob vaqti"'));
  assert.match(slaCard, /teamComparisonLabel\(metrics\.timing\.sla_avg, teamSla\.avg\)/);
  assert.equal(slaCard.split("teamComparisonLabel").length - 1, 1, "one comparison sentence, not several");
  assert.match(slaCard, /SLA ichida \{metrics\.rates\.sla\}%/);
  assert.doesNotMatch(slaCard, /sla_elapsed_avg|timing\.avg_processing/);
  const calendarCard = profile.slice(profile.indexOf('label="Kalendar javob vaqti"'), profile.indexOf('label="Saralash vaqti"'));
  assert.doesNotMatch(calendarCard, /teamComparisonLabel|jamoa/i, "no comparison on the informational card");
  // Same wording as the team dashboard, from the same constant.
  assert.equal(slaCard.includes("hint={SLA_WORK_TIME_HINT}"), true);
});

test("the team average is Deal-weighted, and a seller's is over their own Deals", () => {
  const records = population();
  const section = managerSection(records, { ...QUERY, managerId: "25" }, { can: () => true, settings: SETTINGS, dataAsOf: null });
  const team = buildDashboardMetrics(records, []);
  assert.equal(section.teamSla.avg, team.timing.sla_avg, "the profile compares against the dashboard's own number");
  assert.equal(team.timing.sla_avg, (10 * 10 + 1000) / 11, "sum of Deal values / completed Deals");
  assert.notEqual(team.timing.sla_avg, (10 + 1000) / 2, "never the average of seller averages");
  assert.equal(section.metrics.timing.sla_avg, 10, "seller 25: ten Deals at ten minutes");
  assert.equal(team.timing.sla_median, 10, "median resists the single outlier");
  assert.equal(section.metrics.timing.sla_median, 10);
  assert.equal(team.timing.sla_completed, 11, "pending and unknown are not completed SLAs");
  assert.equal(team.timing.sla_elapsed_avg, (10 * 30 + 4000) / 11, "calendar averages the same Deals");
});

test("pending and unknown evidence are excluded, never counted as zero", () => {
  const records = population();
  const team = buildDashboardMetrics(records, []);
  assert.equal(team.timing.sla_completed, 11);
  assert.equal(team.sla.pending + team.sla.overdue, 1, "the Deal still in distribution");
  assert.equal(team.sla.unknown, 1, "the Deal with no distribution evidence");
  // Were they read as 0, the average would drop; it must not.
  assert.equal(team.timing.sla_avg, (10 * 10 + 1000) / 11);
  const asZero = (10 * 10 + 1000) / 13;
  assert.notEqual(team.timing.sla_avg, asZero);
  const section = managerSection(records, { ...QUERY, managerId: "561" }, { can: () => true, settings: SETTINGS, dataAsOf: null });
  assert.equal(section.metrics.timing.sla_avg, null, "a seller with no completed SLA shows no number");
  assert.equal(formatDurationMinutes(section.metrics.timing.sla_avg), "—");
});

test("a 0-minute off-hours response is a valid completed SLA", () => {
  const rows = [
    record({ dealId: "z-1", assignedManagerId: "25", assignedManager: "Abdulaziz", slaBusinessMinutes: 0, slaElapsedMinutes: 300, slaStatus: "ON_TIME" }),
    record({ dealId: "z-2", assignedManagerId: "25", assignedManager: "Abdulaziz", slaBusinessMinutes: 20, slaElapsedMinutes: 20, slaStatus: "ON_TIME" }),
  ];
  const metrics = buildDashboardMetrics(prepareSalesRecords(rows, SETTINGS, new Date("2026-09-30T00:00:00Z")), []);
  assert.equal(metrics.timing.sla_completed, 2, "the Sunday response counts as completed");
  assert.equal(metrics.timing.sla_avg, 10);
  assert.equal(metrics.timing.sla_median, 10);
  assert.equal(formatDurationMinutes(0), "0 min", "and it reads as a real zero, not as missing");
});

test("durations read the same way everywhere", () => {
  assert.equal(formatDurationMinutes(0), "0 min");
  assert.equal(formatDurationMinutes(42), "42 min");
  assert.equal(formatDurationMinutes(59.4), "59 min");
  assert.equal(formatDurationMinutes(60), "1 s");
  assert.equal(formatDurationMinutes(78), "1 s 18 min");
  assert.equal(formatDurationMinutes(233), "3 s 53 min");
  assert.equal(formatDurationMinutes(1196), "19 s 56 min");
  assert.equal(formatDurationMinutes(1440), "1 kun");
  assert.equal(formatDurationMinutes(1640), "1 kun 3 s 20 min");
  assert.equal(formatDurationMinutes(849), "14 s 9 min");
  assert.equal(formatDurationMinutes(null), "—");
  assert.equal(formatDurationMinutes(undefined), "—");
  assert.equal(formatDurationMinutes(Number.NaN), "—");
  assert.equal(formatDurationMinutes(-5), "0 min", "never a negative duration");
  // No seconds field the data does not have, and no raw minute counts.
  for (const value of [0, 42, 60, 233, 1196, 1640]) {
    assert.doesNotMatch(formatDurationMinutes(value), /sec|00 min|^\d+$/);
  }
  assert.equal(client.includes("function fmtMinutes(value: number | null) {"), false,
    "the client uses the shared formatter, not a private copy");
});

test("the seller comparison line names the right direction", () => {
  assert.equal(teamComparisonLabel(10, 233), "Jamoa avg: 3 s 53 min · 3 s 43 min tezroq");
  assert.equal(teamComparisonLabel(300, 233), "Jamoa avg: 3 s 53 min · 1 s 7 min sekinroq");
  assert.equal(teamComparisonLabel(233, 233), "Jamoa avg: 3 s 53 min · jamoa darajasida");
  assert.equal(teamComparisonLabel(null, 233), null, "no comparison without the seller's own number");
  assert.equal(teamComparisonLabel(10, null), null, "and none without a team number");
  assert.deepEqual(durationGap(10, 233), { minutes: 223, faster: true });
  assert.deepEqual(durationGap(300, 233), { minutes: 67, faster: false });
});
