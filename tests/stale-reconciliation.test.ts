import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scheduledDecision } from "../lib/sync-schedule";
import { classifyLookupFailure, DEFINITIVE_MISSING_CODES, TRANSIENT_CODES, toDealSnapshot } from "../lib/deal-snapshot";
import { currentScopeFor, resolveStaleDeal, countsAsOperational } from "../lib/stale-resolution";
import { selectStaleCandidates, RECONCILE_BATCH_LIMIT, reconcileStateKey } from "../lib/reconcile-plan";
import { buildDashboardMetrics, selectPeriodPopulations } from "../lib/dashboard-metrics";
import type { AnalyticsRecord } from "../lib/types";

/**
 * Sprint 27.1 — reconciliation now *writes*, so a wrong "gone forever" is far
 * more expensive than a wrong "retry later".
 */

const scope = { selectedPipelineIds: ["3"], postSalePipelineIds: ["13"] };

// ------------------------------------------------- transient vs definitive ---

test("only a definitive Bitrix answer may conclude a deal is gone", () => {
  for (const code of DEFINITIVE_MISSING_CODES) {
    const lookup = classifyLookupFailure(code);
    assert.equal(lookup.found, false);
    if (lookup.found) continue;
    assert.equal(lookup.reason, "NOT_FOUND", `${code} is definitive`);
    assert.equal(resolveStaleDeal(lookup, scope), "UNAVAILABLE");
    assert.equal(currentScopeFor("UNAVAILABLE"), "UNAVAILABLE");
  }
});

test("a transient failure never marks a record", () => {
  const transient = [...TRANSIENT_CODES, "HTTP_500", "HTTP_502", "HTTP_503", "UNKNOWN", "SOMETHING_NEW", ""];
  for (const code of transient) {
    const lookup = classifyLookupFailure(code);
    if (lookup.found) throw new Error("a failure classification must not report found");
    assert.equal(lookup.reason, "LOOKUP_ERROR", `${code || "(empty)"} must be transient`);
    assert.equal(resolveStaleDeal(lookup, scope), "LOOKUP_ERROR");
    assert.equal(currentScopeFor("LOOKUP_ERROR"), null,
      "null is the instruction to change nothing — a timeout must not brand a live deal UNAVAILABLE");
  }
});

test("HTTP_400 is the verified missing signature; 5xx stays transient", () => {
  // Verified on the portal: crm.deal.get for a deleted deal answers HTTP 400
  // with an empty error code, and an id that never existed (99999999) gives the
  // identical signature. That reproducibility is what makes it definitive.
  const four = classifyLookupFailure("HTTP_400");
  assert.equal(four.found, false);
  if (!four.found) assert.equal(four.reason, "NOT_FOUND");
  assert.equal(resolveStaleDeal(four, scope), "UNAVAILABLE");

  for (const code of ["HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504"]) {
    const l = classifyLookupFailure(code);
    if (l.found) throw new Error("unreachable");
    assert.equal(l.reason, "LOOKUP_ERROR", `${code} is a server fault, not a verdict on the deal`);
  }
});

test("an empty Bitrix error code falls through to the HTTP status", () => {
  // `??` preserved "" and erased the signal; `||` falls through.
  const bitrix = readFileSync(new URL("../lib/bitrix.ts", import.meta.url), "utf8");
  assert.match(bitrix, /const safeCode = payload\.error \|\| `HTTP_\$\{response\.status\}`;/);
  assert.doesNotMatch(bitrix, /payload\.error \?\? `HTTP_/);
});

test("an unrecognised code is treated as transient, not as gone", () => {
  // A wrong "retry later" costs one sync cycle; a wrong "gone" corrupts a record.
  const reasonOf = (code: string) => { const l = classifyLookupFailure(code); return l.found ? "FOUND" : l.reason; };
  assert.equal(reasonOf("BRAND_NEW_BITRIX_CODE"), "LOOKUP_ERROR");
  assert.equal(reasonOf("HTTP_504"), "LOOKUP_ERROR");
  // …but a code Bitrix defines as missing still resolves definitively.
  assert.equal(reasonOf("NOT_FOUND"), "NOT_FOUND");
});

test("the reconciler skips a lookup it could not answer", () => {
  const source = readFileSync(new URL("../lib/post-sync-reconciliation.ts", import.meta.url), "utf8");
  assert.match(source, /if \(scope === null\) \{ state\.lookupErrors \+= 1; continue; \}/);
  assert.match(source, /if \(scope === "IN_SCOPE"\) continue;/, "in-scope deals are left to the normal sync");
});

// ------------------------------------------------------ common completion ---

test("reconciliation is hooked into the one shared completion point", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /await runPostSyncReconciliation\(await getSettings\(\)\);/);

  // It must sit inside the success branch, after the checkpoint is written.
  const completion = sync.slice(sync.indexOf('status: "success", phase: "done"'), sync.indexOf("return finished;"));
  assert.match(completion, /saveSyncState\(\{ status: "success"/);
  assert.equal((sync.match(/await runPostSyncReconciliation\(/g) ?? []).length, 1,
    "exactly one call site — not duplicated per sync path");

  // The scheduled path must not carry its own copy.
  const scheduled = readFileSync(new URL("../lib/scheduled-sync.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scheduled, /runPostSyncReconciliation/,
    "cron gets reconciliation by finishing the same state machine, not by calling it itself");
});

test("reconciliation only runs on success, never on failure, pause or mid-run", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const call = sync.indexOf("await runPostSyncReconciliation");
  const branchStart = sync.lastIndexOf("if (!rawDeals.length)", call);
  assert.ok(branchStart !== -1 && branchStart < call,
    "the call sits inside the drained-batch success branch, so an unfinished, failed or paused job never reaches it");
  // A still-running job returns from analyticsStep before this point.
  assert.ok(sync.indexOf("return finished;", call) > call);
});

test("a reconciliation failure never downgrades a successful sync", () => {
  const source = readFileSync(new URL("../lib/post-sync-reconciliation.ts", import.meta.url), "utf8");
  assert.match(source, /catch \(error\) \{\s*state\.safeError = safeBitrixMessage\(error\);/);
  assert.doesNotMatch(source, /saveSyncState\(/, "it must not rewrite the sync result");
  assert.doesNotMatch(source, /status: "error"/);
  // The partial failure is still visible.
  assert.match(source, /saveDictionary\(reconcileStateKey\(pipelineId\), state\)/);
  assert.equal(reconcileStateKey("3"), "reconcileState:3");
});

// -------------------------------------------------------------- selection ---

const rec = (over: Partial<AnalyticsRecord> = {}) => ({
  dealId: "1", categoryId: "3", salesStatus: "ACTIVE", ...over,
} as unknown as AnalyticsRecord);

test("candidate selection is bounded and skips already-decided records", () => {
  const records = [
    rec({ dealId: "stale" }),
    rec({ dealId: "live" }),
    rec({ dealId: "closed", salesStatus: "LOST" }),
    rec({ dealId: "other", categoryId: "13" }),
    rec({ dealId: "decided", currentScope: "UNAVAILABLE" } as Partial<AnalyticsRecord>),
  ];
  const { batch } = selectStaleCandidates(records, new Set(["live"]), ["3"]);
  assert.deepEqual(batch, ["stale"], "only an ACTIVE, in-scope, undecided, absent deal is a candidate");

  const many = Array.from({ length: 40 }, (_, i) => rec({ dealId: `d${i}` }));
  const bounded = selectStaleCandidates(many, new Set(), ["3"]);
  assert.equal(bounded.batch.length, RECONCILE_BATCH_LIMIT);
  assert.equal(bounded.pending, 40 - RECONCILE_BATCH_LIMIT, "the remainder is reported, not silently dropped");
});

// ----------------------------------------------------- persistence safety ---

test("the scope write touches one field and nothing else", () => {
  const storage = readFileSync(new URL("../lib/storage.ts", import.meta.url), "utf8");
  const fn = storage.slice(storage.indexOf("export async function setAnalyticsCurrentScope"), storage.indexOf("export async function getProviderRules"));
  assert.match(fn, /record\.currentScope = scope;/);
  assert.match(fn, /if \(record\.currentScope === scope\) return true;/, "idempotent");
  assert.match(fn, /UPDATE analytics_records SET payload = \? WHERE deal_id = \?/, "updates in place — no duplicate row");
  assert.doesNotMatch(fn, /INSERT|DELETE/, "never inserts or deletes");
  for (const field of ["createdAt", "qualified", "lossReasonGroup", "salesStatus", "wonAt", "originCategoryId"]) {
    assert.doesNotMatch(fn, new RegExp(`record\\.${field}\\s*=`), `${field} is never rewritten`);
  }
});

test("a rebuilt record recovers automatically when a deal returns to the funnel", () => {
  // The canonical builder writes a fresh payload with no currentScope key, and
  // an absent key means IN_SCOPE — so recovery needs no special-case code.
  const analytics = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  assert.doesNotMatch(analytics, /currentScope/, "the builder never emits the field");
  assert.equal(countsAsOperational(undefined), true);
  const rebuilt = rec({ dealId: "back" });
  assert.equal(countsAsOperational((rebuilt as AnalyticsRecord).currentScope), true,
    "a record rebuilt by a later sync behaves as IN_SCOPE again");
});

// -------------------------------------------------------- Aktiv leadlar ----

const cohort = (over: Partial<AnalyticsRecord> = {}): AnalyticsRecord => ({
  dealId: "c1", createdAt: "2026-08-10T00:00:00.000Z", wonAt: null, opportunity: 0, currencyId: "UZS",
  salesStatus: "ACTIVE", qualified: true, lossReasonGroup: null, categoryId: "3", originCategoryId: "3",
  stageId: "C3:NEW", processingBusinessMinutes: 10, slaStatus: "ON_TIME", salesCycleHours: null, ...over,
} as unknown as AnalyticsRecord);

const metricsFor = (records: AnalyticsRecord[]) => {
  const from = new Date("2026-08-01T00:00:00.000Z").getTime();
  const to = new Date("2026-08-31T23:59:59.999Z").getTime();
  const p = selectPeriodPopulations(records, from, to);
  return buildDashboardMetrics(p.cohort, p.periodSales);
};

test("Aktiv leadlar excludes unavailable and out-of-scope deals only", () => {
  const inScope = cohort({ dealId: "a" });
  const undecided = cohort({ dealId: "b" });                                            // no currentScope
  const movedOut = cohort({ dealId: "c", currentScope: "OUT_OF_SCOPE" } as Partial<AnalyticsRecord>);
  const gone = cohort({ dealId: "d", currentScope: "UNAVAILABLE" } as Partial<AnalyticsRecord>);
  const m = metricsFor([inScope, undecided, movedOut, gone]);

  assert.equal(m.counts.active_cohort, 2, "only the IN_SCOPE and the unmarked (backward-compatible) deals count");
  assert.equal(m.counts.leads, 4, "Leadlar unchanged — all four remain in the historical cohort");
  assert.equal(m.counts.sql, 4, "SQL unchanged for qualified deals");
});

test("marking a deal changes Aktiv leadlar and nothing else", () => {
  const before = metricsFor([cohort({ dealId: "a" }), cohort({ dealId: "b" })]);
  const after = metricsFor([cohort({ dealId: "a" }), cohort({ dealId: "b", currentScope: "UNAVAILABLE" } as Partial<AnalyticsRecord>)]);

  assert.equal(before.counts.active_cohort - after.counts.active_cohort, 1, "Aktiv leadlar drops by exactly one");
  for (const key of ["leads", "sql", "not_relevant", "sales_lost", "cohort_sales", "period_sales", "duplicates"] as const) {
    assert.equal(after.counts[key], before.counts[key], `${key} unchanged`);
  }
  for (const key of ["lead_to_sql", "lead_to_sale", "sql_to_sale", "not_relevant", "sales_lost", "sla"] as const) {
    assert.equal(after.rates[key], before.rates[key], `rate ${key} unchanged`);
  }
  assert.equal(after.money.revenue, before.money.revenue, "Sotuv summasi unchanged");
  assert.deepEqual(after.timing, before.timing, "processing and cycle timing unchanged");
});

test("only the active-leads metric reads currentScope", () => {
  const metrics = readFileSync(new URL("../lib/dashboard-metrics.ts", import.meta.url), "utf8");
  assert.equal((metrics.match(/countsAsOperational\(/g) ?? []).length, 1, "exactly one consumer");
  assert.match(metrics, /active_cohort: eligible\.filter\(\(row\) => row\.salesStatus === "ACTIVE" && countsAsOperational\(row\.currentScope\)\)/);
  const salesLogic = readFileSync(new URL("../lib/sales-logic.ts", import.meta.url), "utf8");
  assert.doesNotMatch(salesLogic, /currentScope/, "cohort and loss classification never consult it");
  const docs = readFileSync(new URL("../docs/METRICS.md", import.meta.url), "utf8");
  assert.match(docs, /operationally\s+`IN_SCOPE`/);
});

// ------------------------------------------------------------- diagnostics ---

test("the diagnostics endpoint stays read-only", () => {
  const route = readFileSync(new URL("../app/api/reconcile/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /export async function POST/, "no mutation verb");
  assert.doesNotMatch(route, /setAnalyticsCurrentScope|saveDictionary|UPDATE |DELETE /, "it writes nothing");
  assert.match(route, /export async function GET/);
});

test("the by-id snapshot still carries the fields reconciliation needs", () => {
  const snap = toDealSnapshot({ ID: "1", CATEGORY_ID: "0", STAGE_ID: "C0:NEW", CLOSED: "Y", OPPORTUNITY: "500" });
  assert.equal(snap.closed, true);
  assert.equal(snap.categoryId, "0");
  assert.equal(snap.opportunity, 500);
});

// ------------------------------------------- incident 1102 scale hardening ---

test("reconciliation selects candidates without loading full analytics payloads", () => {
  const recon = readFileSync(new URL("../lib/post-sync-reconciliation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(recon, /listAnalyticsRecords/,
    "the full-table parse must not run inside the sync's final step");
  assert.match(recon, /listReconcileCandidates\(categoryIds\)/);

  const storage = readFileSync(new URL("../lib/storage.ts", import.meta.url), "utf8");
  const fn = storage.slice(storage.indexOf("export async function listReconcileCandidates"), storage.indexOf("export async function setAnalyticsCurrentScope"));
  // Only the four fields candidate selection needs, extracted in SQLite.
  assert.match(fn, /json_extract\(payload, '\$\.salesStatus'\)/);
  assert.match(fn, /json_extract\(payload, '\$\.currentScope'\)/);
  assert.doesNotMatch(fn, /JSON\.parse/, "no payload is parsed in JS");
  assert.doesNotMatch(fn, /SELECT payload FROM analytics_records/, "the whole payload is never selected");
  assert.match(fn, /WHERE category_id IN/, "scoped to the synced funnels, not the whole table");
});

test("reconcileState is persisted even when there is nothing to do", () => {
  const recon = readFileSync(new URL("../lib/post-sync-reconciliation.ts", import.meta.url), "utf8");
  const empty = recon.slice(recon.indexOf("if (!batch.length)"), recon.indexOf("const lookups"));
  assert.match(empty, /saveDictionary\(reconcileStateKey\(pipelineId\), state\)/,
    "lastRunAt must reflect the real last run, not the last run that found work");
});

test("autoSyncMinutes controls the interval, not just on/off", () => {
  const base = { selectedPipelineIds: ["3"], job: null, now: new Date("2026-08-30T12:00:00.000Z") };
  const ago = (minutes: number) => new Date(base.now.getTime() - minutes * 60_000).toISOString();

  // The incident: 60 was treated as "enabled" and ran on every 15-minute tick.
  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: ago(15) }), { run: false, reason: "TOO_SOON" });
  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: ago(30) }), { run: false, reason: "TOO_SOON" });
  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: ago(45) }), { run: false, reason: "TOO_SOON" });
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: ago(61) }).run, true, "runs once an hour");

  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 30, lastSyncAt: ago(15) }), { run: false, reason: "TOO_SOON" });
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 30, lastSyncAt: ago(31) }).run, true);

  // 15 matches the cron cadence, so every eligible tick runs.
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 15, lastSyncAt: ago(15) }).run, true);
  assert.deepEqual(scheduledDecision({ ...base, autoSyncMinutes: 0, lastSyncAt: ago(999) }), { run: false, reason: "DISABLED" });
});

test("cron jitter does not skip a run that is essentially due", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const base = { selectedPipelineIds: ["3"], job: null, now };
  // Cloudflare fires up to ~a minute late; 59m50s must still count as 60.
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: new Date(now.getTime() - 59 * 60_000).toISOString() }).run, true);
  // A first run with no recorded sync is never blocked.
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: null }).run, true);
  assert.equal(scheduledDecision({ ...base, autoSyncMinutes: 60, lastSyncAt: "not-a-date" }).run, true);
});

test("existing scheduled semantics are unchanged by the interval gate", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const stale = new Date(now.getTime() - 999 * 60_000).toISOString();
  const base = { autoSyncMinutes: 15, selectedPipelineIds: ["3"], lastSyncAt: stale, now };
  assert.deepEqual(scheduledDecision({ ...base, job: { status: "running", heartbeatAt: new Date(now.getTime() - 60_000).toISOString() } }), { run: false, reason: "JOB_RUNNING" });
  assert.deepEqual(scheduledDecision({ ...base, job: { status: "error" } }), { run: false, reason: "PREVIOUS_ERROR" });
  assert.deepEqual(scheduledDecision({ ...base, job: { status: "paused" } }), { run: false, reason: "PAUSED" });
  assert.deepEqual(scheduledDecision({ ...base, job: { status: "running", heartbeatAt: new Date(now.getTime() - 30 * 60_000).toISOString() } }), { run: true, action: "RESUME" });
  assert.deepEqual(scheduledDecision({ ...base, selectedPipelineIds: [], job: null }), { run: false, reason: "NOT_CONFIGURED" });
});
