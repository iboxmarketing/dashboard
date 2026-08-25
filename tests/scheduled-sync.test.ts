import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ABANDONED_JOB_MINUTES, scheduledDecision } from "../lib/sync-schedule";
import { countsAsOperational, currentScopeFor, impliesRouting, resolveStaleDeal } from "../lib/stale-resolution";
import { toDealSnapshot, LOOKUP_BATCH_LIMIT } from "../lib/deal-snapshot";
import { reconcileCurrentStages } from "../lib/current-stages";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import type { AnalyticsRecord, CurrentStageRecord } from "../lib/types";

/**
 * Sprint 27 — server-side scheduled sync and stale reconciliation.
 *
 * Background refresh used to depend on an open browser tab; one unattended
 * night left the cache 14 hours stale.
 */

const NOW = new Date("2026-08-25T12:00:00.000Z");
const base = { autoSyncMinutes: 15, selectedPipelineIds: ["3"], now: NOW };
const job = (over: Record<string, unknown> = {}) => ({ status: "success", heartbeatAt: NOW.toISOString(), ...over });

// ------------------------------------------------------------- scheduler ---

test("a scheduled tick starts an incremental sync and never a full one", () => {
  assert.deepEqual(scheduledDecision({ ...base, job: null }), { run: true, action: "START" });
  assert.deepEqual(scheduledDecision({ ...base, job: job({ status: "success" }) }), { run: true, action: "START" });

  const source = readFileSync(new URL("../lib/scheduled-sync.ts", import.meta.url), "utf8");
  assert.match(source, /startSync\(\{ pipelineId: settings\.selectedPipelineIds\[0\] \}\)/);
  assert.doesNotMatch(source, /full:\s*true/, "a scheduled run may never request a full sync");
  assert.doesNotMatch(source, /days:/, "no bespoke window; the checkpoint decides");
  // It drives the existing state machine rather than a second implementation.
  assert.match(source, /import \{ resumeSync, runSyncSteps, startSync \} from "\.\/sync"/);
});

test("a running job is never overlapped", () => {
  const fresh = job({ status: "running", heartbeatAt: new Date(NOW.getTime() - 60_000).toISOString() });
  assert.deepEqual(scheduledDecision({ ...base, job: fresh }), { run: false, reason: "JOB_RUNNING" });

  // Just inside the abandonment threshold is still "in flight".
  const nearly = job({ status: "running", heartbeatAt: new Date(NOW.getTime() - (ABANDONED_JOB_MINUTES - 1) * 60_000).toISOString() });
  assert.deepEqual(scheduledDecision({ ...base, job: nearly }), { run: false, reason: "JOB_RUNNING" });
});

test("an abandoned job is resumed, not restarted", () => {
  const dead = job({ status: "running", heartbeatAt: new Date(NOW.getTime() - (ABANDONED_JOB_MINUTES + 5) * 60_000).toISOString() });
  assert.deepEqual(scheduledDecision({ ...base, job: dead }), { run: true, action: "RESUME" },
    "resuming keeps the cursor; restarting would redo the whole window");
  // A job with no heartbeat at all counts as abandoned rather than blocking forever.
  assert.deepEqual(scheduledDecision({ ...base, job: { status: "running" } }), { run: true, action: "RESUME" });
});

test("a recorded failure or a deliberate pause is left alone", () => {
  assert.deepEqual(scheduledDecision({ ...base, job: job({ status: "error" }) }), { run: false, reason: "PREVIOUS_ERROR" },
    "a retry would overwrite safeError and hide the failure");
  assert.deepEqual(scheduledDecision({ ...base, job: job({ status: "paused" }) }), { run: false, reason: "PAUSED" });
});

test("autoSyncMinutes is the runtime on/off switch", () => {
  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 0, job: null }), { run: false, reason: "DISABLED" });
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 15, job: null }).run, true);
  for (const minutes of [10, 30, 60]) {
    assert.equal(scheduledDecision({ ...base, autoSyncMinutes: minutes, job: null }).run, true, `${minutes} enables`);
  }
  // Nothing to sync without a configured funnel.
  assert.deepEqual(scheduledDecision({ ...base, selectedPipelineIds: [], job: null }), { run: false, reason: "NOT_CONFIGURED" });
});

test("the worker exposes scheduled() and the deploy config carries the cron", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledSync\(\)/);
  assert.doesNotMatch(worker, /console\.(log|warn|error)/, "a scheduled run logs nothing");

  const config = readFileSync(new URL("../scripts/cf-config.sh", import.meta.url), "utf8");
  assert.match(config, /"triggers":\s*\{\s*"crons":\s*\["\*\/15 \* \* \* \*"\]\s*\}/);
  assert.match(config, /"observability":\s*\{\s*"enabled":\s*false\s*\}/, "observability stays off");
});

test("the 10-minute checkpoint overlap is untouched", () => {
  const window = readFileSync(new URL("../lib/sync-window.ts", import.meta.url), "utf8");
  assert.match(window, /SYNC_OVERLAP_MINUTES = 10/);
});

// --------------------------------------------------------- stale resolver ---

const scope = { selectedPipelineIds: ["3"], postSalePipelineIds: ["13"] };
const deal = (over: Record<string, unknown> = {}) =>
  ({ found: true as const, deal: toDealSnapshot({ ID: "1", CATEGORY_ID: "3", STAGE_ID: "C3:NEW", CLOSED: "N", ...over }) });

test("a stale deal still open in the sales funnel is just a refresh gap", () => {
  assert.equal(resolveStaleDeal(deal(), scope), "REFRESH_IN_SCOPE");
  assert.equal(currentScopeFor("REFRESH_IN_SCOPE"), "IN_SCOPE");
});

test("a stale deal closed inside the sales funnel is rebuilt by canonical rules", () => {
  const closed = deal({ CLOSED: "Y", STAGE_ID: "C3:LOSE" });
  assert.equal(resolveStaleDeal(closed, scope), "CLOSED_IN_SCOPE");
  assert.equal(currentScopeFor("CLOSED_IN_SCOPE"), "IN_SCOPE",
    "still in scope, so the normal incremental refreshes it — no bespoke rebuild");
  // CLOSED is evidence only; nothing here decides won or lost.
  const resolution = readFileSync(new URL("../lib/stale-resolution.ts", import.meta.url), "utf8");
  assert.doesNotMatch(resolution, /"WON"|"LOST"|salesStatus/, "classification stays with the canonical rules");
});

test("a stale deal moved to the paired post-sale funnel resolves in scope", () => {
  assert.equal(resolveStaleDeal(deal({ CATEGORY_ID: "13" }), scope), "MOVED_TO_POST_SALE");
  assert.equal(currentScopeFor("MOVED_TO_POST_SALE"), "IN_SCOPE");
});

test("a deal moved to an unrelated category leaves sync scope and is NOT routing", () => {
  const moved = deal({ CATEGORY_ID: "0" });
  assert.equal(resolveStaleDeal(moved, scope), "MOVED_OUT_OF_SCOPE");
  assert.equal(currentScopeFor("MOVED_OUT_OF_SCOPE"), "OUT_OF_SCOPE");
  // The whole point: moving out is not a routing outcome.
  assert.equal(impliesRouting("MOVED_OUT_OF_SCOPE"), false);
  assert.equal(countsAsOperational("OUT_OF_SCOPE"), false, "no longer inflates operational ACTIVE");
});

test("a deleted or unreadable deal is recorded, never silently dropped", () => {
  const gone = { found: false as const, reason: "NOT_FOUND" as const, code: "NOT_FOUND" };
  assert.equal(resolveStaleDeal(gone, scope), "UNAVAILABLE");
  assert.equal(currentScopeFor("UNAVAILABLE"), "UNAVAILABLE");
  assert.equal(countsAsOperational("UNAVAILABLE"), false);
  const route = readFileSync(new URL("../app/api/reconcile/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /DELETE FROM|deleteAnalytics/, "history is never deleted by reconciliation");
});

test("an unmarked record keeps its existing meaning", () => {
  assert.equal(countsAsOperational(undefined), true, "absent currentScope must default to IN_SCOPE");
});

// ------------------------------------------------- cohort history intact ---

const record = (over: Partial<AnalyticsRecord> = {}): AnalyticsRecord => ({
  dealId: "1", createdAt: "2026-08-10T00:00:00.000Z", wonAt: null, opportunity: 0, currencyId: "UZS",
  salesStatus: "ACTIVE", qualified: true, lossReasonGroup: null, categoryId: "3", originCategoryId: "3",
  stageId: "C3:NEW", processingBusinessMinutes: 10, slaStatus: "ON_TIME", salesCycleHours: null,
  ...over,
} as unknown as AnalyticsRecord);

test("marking a deal out of scope does not remove it from historical cohorts", () => {
  const from = new Date("2026-08-01T00:00:00.000Z").getTime();
  const to = new Date("2026-08-31T23:59:59.999Z").getTime();
  const inScope = [record({ dealId: "a" }), record({ dealId: "b" })];
  const movedOut = [record({ dealId: "a" }), record({ dealId: "b", currentScope: "OUT_OF_SCOPE" } as Partial<AnalyticsRecord>)];

  const before = buildDashboardMetrics(...Object.values(selectPeriodPopulations(inScope, from, to)) as [AnalyticsRecord[], AnalyticsRecord[]]);
  const after = buildDashboardMetrics(...Object.values(selectPeriodPopulations(movedOut, from, to)) as [AnalyticsRecord[], AnalyticsRecord[]]);
  assert.equal(after.counts.leads, before.counts.leads, "Leadlar unchanged");
  assert.equal(after.counts.sql, before.counts.sql, "SQL unchanged");
  assert.equal(after.counts.sales_lost, before.counts.sales_lost, "Sotilmadi unchanged");
  assert.equal(after.counts.cohort_sales, before.counts.cohort_sales);
  assert.equal(after.money.revenue, before.money.revenue, "Sotuv summasi unchanged");

  // Sprint 27.1 gave Aktiv leadlar an approved operational filter, so the file
  // does reference currentScope — but only there. Every cohort figure must
  // still ignore where the deal sits today.
  const metrics = readFileSync(new URL("../lib/dashboard-metrics.ts", import.meta.url), "utf8");
  const counts = metrics.slice(metrics.indexOf("counts: {"), metrics.indexOf("rates: {"));
  const cohortLines = counts.split("\n")
    .filter((line) => !line.trim().startsWith("//"))          // comments explain the rule, they are not the rule
    .filter((line) => !line.includes("active_cohort"));
  assert.equal(cohortLines.some((line) => line.includes("currentScope")), false,
    "no cohort count reads current location");
  const rates = metrics.slice(metrics.indexOf("rates: {"), metrics.indexOf("money: {"));
  assert.doesNotMatch(rates, /currentScope/, "no rate reads current location");
  assert.doesNotMatch(metrics.slice(metrics.indexOf("money: {")), /currentScope/, "money and timing unaffected");
  const salesLogic = readFileSync(new URL("../lib/sales-logic.ts", import.meta.url), "utf8");
  assert.doesNotMatch(salesLogic, /currentScope/);
});

test("an out-of-scope deal stops being reported stale, an in-scope one does not", () => {
  const live: CurrentStageRecord[] = [];
  const cached = [
    record({ dealId: "in" }),
    record({ dealId: "out", currentScope: "OUT_OF_SCOPE" } as Partial<AnalyticsRecord>),
    record({ dealId: "gone", currentScope: "UNAVAILABLE" } as Partial<AnalyticsRecord>),
  ];
  const result = reconcileCurrentStages(live, cached, "2026-08-25T12:00:00.000Z", { operationalCategoryIds: ["3"] });
  assert.deepEqual(result.staleDealIds, ["in"], "only the genuinely refreshable deal is flagged");
  assert.equal(result.staleCount, 1);
});

// ------------------------------------------------------------- by-id fetch ---

test("the by-id lookup selects the fields reconciliation needs", () => {
  const snapshot = toDealSnapshot({
    ID: "41577", TITLE: "x", CATEGORY_ID: "0", STAGE_ID: "C0:NEW", CLOSED: "Y",
    CLOSEDATE: "2026-08-25T00:00:00+05:00", DATE_CREATE: "2026-08-01T00:00:00+05:00",
    DATE_MODIFY: "2026-08-24T00:00:00+05:00", MOVED_TIME: "2026-08-24T00:00:00+05:00",
    ASSIGNED_BY_ID: "561", OPPORTUNITY: "1000", CURRENCY_ID: "UZS",
  });
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.categoryId, "0");
  assert.equal(snapshot.opportunity, 1000);
  assert.equal(toDealSnapshot({ CLOSED: "N" }).closed, false);
  assert.equal(toDealSnapshot({}).closed, false, "a missing flag means open");
  assert.ok(LOOKUP_BATCH_LIMIT > 0 && LOOKUP_BATCH_LIMIT <= 50, "lookups stay bounded");

  const lookup = readFileSync(new URL("../lib/deal-lookup.ts", import.meta.url), "utf8");
  assert.match(lookup, /crm\.deal\.get/);
  assert.doesNotMatch(lookup, /https?:\/\/|BITRIX24_WEBHOOK_URL/, "no credential or endpoint literal here");
});

test("CLOSED is fetched by the canonical sync select", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const select = sync.slice(sync.indexOf("const select = ["), sync.indexOf("const select = [") + 400);
  assert.match(select, /"CLOSED"/, "raw_deals can now answer whether a deal is closed");
  assert.match(select, /"CLOSEDATE"/);
  // CLOSED must remain diagnostic: nothing derives sales status from it.
  const analytics = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  assert.doesNotMatch(analytics, /deal\.CLOSED\b(?!ATE)/, "salesStatus stays stage-and-history driven");
});
