import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import { summarizeDataQuality, stageHistoryLength } from "../lib/diagnostics";
import { countSalesLost, isEligibleCohortDeal, isPreSqlClosed, isSalesLost } from "../lib/sales-logic";
import { DASHBOARD_OMITTED_FIELDS, STAGE_FUNNEL_FIELDS, dashboardRemovedPaths } from "../lib/dashboard-record";
import type { AnalyticsRecord } from "../lib/types";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function deal(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", title: "t", createdAt: "2026-08-05T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
    qualified: false, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
    processingBusinessMinutes: 10, salesCycleHours: null, slaStatus: "ON_TIME", processingSource: "QUALIFICATION_STAGE",
    stage: "Распределение", stageId: "C3:NEW", currentScope: null, categoryId: "3", originCategoryId: "3",
    originPipeline: "IBOX sales", pipeline: "IBOX sales", source: "CRM-форма", sourceId: "WEBFORM",
    assignedManagerId: "7", assignedManager: "M", salesManagerId: "7", salesManager: "M",
    salesManagerAttribution: "SALES_STAGE", analyticsVersion: 6,
    customerKey: null, duplicateOfDealId: null, stageTimeline: [], stageAgeHours: 1, stageLimitHours: 24,
    ...over,
  } as unknown as AnalyticsRecord;
}
const tl = (n: number) => Array.from({ length: n }, (_, i) => ({
  categoryId: "3", pipeline: "IBOX sales", stageId: `C3:S${i}`, stage: `S${i}`,
  enteredAt: "2026-08-05T09:00:00.000Z", exitedAt: null, durationHours: 1,
}));

/** Exactly what the SQL projection produces, expressed in JS for the tests. */
function project(rows: AnalyticsRecord[]) {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row, stageHistoryCount: row.stageTimeline?.length ?? 0 };
    for (const field of [...DASHBOARD_OMITTED_FIELDS, "stageTimeline"]) delete out[field];
    return out;
  });
}

/** A cohort covering every population the dashboard reports. */
const COHORT = [
  deal({ dealId: "sql", qualified: true, stage: "ОБРАБОТКА", stageTimeline: tl(3) }),
  deal({ dealId: "won", qualified: true, salesStatus: "WON", wonAt: "2026-08-10T09:00:00.000Z", opportunity: 900, salesCycleHours: 12, stageTimeline: tl(4) }),
  deal({ dealId: "nr", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", stage: "Not relevant", stageTimeline: tl(2) }),
  deal({ dealId: "lost", salesStatus: "LOST", qualified: true, lossReasonGroup: "SALES", stageTimeline: tl(3) }),
  deal({ dealId: "presql", salesStatus: "LOST", qualified: false, lossReasonGroup: "SALES", stageTimeline: tl(2) }),
  deal({ dealId: "routing", salesStatus: "LOST", lossReasonGroup: "ROUTING", stageTimeline: tl(2) }),
  deal({ dealId: "active", stageTimeline: [] }),
  deal({ dealId: "nohist", qualified: true, stageTimeline: [] }),
];
const WON = COHORT.filter((r) => r.salesStatus === "WON");

test("metric parity: every dashboard number is identical on the compact payload", () => {
  const before = buildDashboardMetrics(COHORT, WON);
  const after = buildDashboardMetrics(project(COHORT) as never, project(WON) as never);
  assert.deepEqual(after.counts, before.counts, "counts must not move");
  assert.deepEqual(after.rates, before.rates, "rates must not move");
  assert.deepEqual(after.money, before.money, "money must not move");
  assert.deepEqual(after.timing, before.timing, "timing must not move");
  assert.equal(after.classificationConflicts, before.classificationConflicts);
  // Named explicitly so a future change cannot quietly drop one from the sweep.
  for (const key of ["leads","sql","not_relevant","sales_lost","cohort_sales","period_sales","duplicates",
    "duplicates_eligible","unique_ish_leads","classified_leads","unclassified_leads","pre_sql_closed","active_cohort"] as const)
    assert.equal(after.counts[key], before.counts[key], `count ${key}`);
  for (const key of ["lead_to_sql","lead_to_sale","sql_to_sale","sales_lost","not_relevant","not_relevant_of_leads",
    "quality_accepted_rate","low_quality_rate","classification_coverage","sla"] as const)
    assert.equal(after.rates[key], before.rates[key], `rate ${key}`);
});

test("invariants hold on the compact payload", () => {
  const m = buildDashboardMetrics(project(COHORT) as never, project(WON) as never);
  assert.equal(m.counts.leads, m.counts.classified_leads + m.counts.unclassified_leads);
  assert.equal(m.counts.classified_leads, m.counts.sql + m.counts.not_relevant);
  assert.ok(m.counts.sales_lost <= m.counts.sql, "Sales Lost <= SQL");
  assert.equal(m.salesLost.every((r) => r.qualified === true), true);
  assert.equal(m.preSqlClosed.some((r) => r.qualified === true), false, "no preSqlClosed is SQL");
  assert.equal(m.preSqlClosed.some((r) => isSalesLost(r)), false, "no preSqlClosed is Sales Lost");
  assert.equal(m.sql.some((r) => r.lossReasonGroup === "MARKETING"), false, "no Not Relevant is SQL");
  assert.equal(m.eligible.some((r) => r.lossReasonGroup === "ROUTING"), false, "routing excluded");
  assert.equal(m.eligible.filter((r) => r.salesStatus === "WON").every((r) => r.qualified), true);
  assert.deepEqual(m.preSqlClosed.map((r) => r.dealId), ["presql"]);
});

test("missingStageHistory is preserved, including records that genuinely have none", () => {
  const before = summarizeDataQuality(COHORT);
  const after = summarizeDataQuality(project(COHORT) as never);
  assert.equal(before.missingStageHistory, 2, "two fixtures have empty timelines");
  assert.equal(after.missingStageHistory, before.missingStageHistory);
  assert.deepEqual(after, before, "no diagnostic changes at all");
  // The helper reads whichever shape it is given and never invents history.
  assert.equal(stageHistoryLength({ stageTimeline: tl(3) }), 3);
  assert.equal(stageHistoryLength({ stageHistoryCount: 3 }), 3);
  assert.equal(stageHistoryLength({ stageTimeline: [] }), 0);
  assert.equal(stageHistoryLength({ stageHistoryCount: 0 }), 0);
  assert.equal(stageHistoryLength({}), 0);
  // A compact record must not be read as "history missing" just because the
  // array is gone — that is the failure mode Step 4 forbids.
  const withHistory = project([deal({ stageTimeline: tl(5) })])[0];
  assert.equal("stageTimeline" in withHistory, false);
  assert.equal(stageHistoryLength(withHistory as never), 5);
});

test("filters and drilldowns still work on the compact payload", () => {
  const compact = project(COHORT) as never as AnalyticsRecord[];
  assert.equal(compact.filter((r) => r.assignedManagerId === "7").length, COHORT.length, "manager filter");
  assert.equal(compact.filter((r) => r.source === "CRM-форма").length, COHORT.length, "source filter");
  assert.equal(compact.filter((r) => r.originPipeline === "IBOX sales").length, COHORT.length, "pipeline filter");
  assert.equal(compact.filter((r) => r.stage === "ОБРАБОТКА").length, 1, "stage filter");
  assert.equal(compact.filter((r) => r.slaStatus === "ON_TIME").length, COHORT.length, "SLA filter");
  assert.equal(compact.every((r) => r.title && r.dealId), true, "deal table fields present");
  assert.equal(compact.filter(isEligibleCohortDeal).length, 7, "routing still excluded");
  assert.equal(countSalesLost(compact), 1);
  assert.equal(compact.filter(isPreSqlClosed).length, 1);
  const pop = selectPeriodPopulations(compact, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-31T23:59:59Z"));
  assert.equal(pop.cohort.length, COHORT.length, "date filter");
  assert.equal(pop.periodSales.length, 1);
});

test("the funnel's minimal record carries exactly what that view reads", () => {
  // Its own filters (manager, pipeline, search) plus the funnel inputs.
  for (const field of ["dealId", "title", "assignedManagerId", "salesManagerId", "originPipeline", "originCategoryId", "salesStatus", "stageTimeline"])
    assert.ok((STAGE_FUNNEL_FIELDS as readonly string[]).includes(field), `${field} missing from the funnel projection`);
  assert.equal(STAGE_FUNNEL_FIELDS.length, 8, "nothing extra is shipped to the funnel");
});

test("the dashboard route projects in SQL and never parses the records", () => {
  const route = code("../app/api/dashboard/route.ts");
  assert.doesNotMatch(route, /listAnalyticsRecords/, "must not use the full-table loader");
  assert.match(route, /listDashboardRecordJson/);
  assert.doesNotMatch(route, /JSON\.parse/, "records must not be parsed in the Worker");
  assert.match(route, /rows\.join\(","\)/, "rows are concatenated, not re-serialised");

  const storage = code("../lib/storage.ts");
  assert.match(storage, /json_remove\(payload/, "fields are dropped in SQLite");
  // Built from the shared constants, so assert the composition rather than a literal.
  assert.match(storage, /json_array_length\(payload, '\$\.\$\{DASHBOARD_TIMELINE_FIELD\}'\)/, "history count comes from the real timeline");
  assert.match(storage, /json_set\(json_remove\(payload/, "count is added to the projected row");
  assert.match(storage, /WHERE json_valid\(payload\)/, "a corrupt row is skipped, as the old try/catch did");
  // Every omitted field is actually passed to json_remove.
  assert.equal(dashboardRemovedPaths().length, DASHBOARD_OMITTED_FIELDS.length + 1);
  assert.ok(dashboardRemovedPaths().includes("$.stageTimeline"));
});

test("the stage funnel is not fetched on the dashboard's initial load", () => {
  const client = code("../app/dashboard-client.tsx");
  assert.match(client, /loadStageFunnel/);
  // It is triggered by navigating to Stage Control, not by the bootstrap path
  // that already fires loadCurrentStages/loadProjects/loadPages/loadShares.
  assert.match(client, /next === "stages" && !stageFunnelLoaded\) void loadStageFunnel\(\)/);
  const bootstrap = client.slice(client.indexOf("void loadCurrentStages(); void loadProjects()"), client.indexOf("void loadCurrentStages(); void loadProjects()") + 160);
  assert.doesNotMatch(bootstrap, /loadStageFunnel/, "must not run on initial load");
  assert.doesNotMatch(client, /stageTimeline: row\.stageTimeline/, "the dashboard record no longer carries a timeline");
});
