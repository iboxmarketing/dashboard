import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyticsPageSql,
  safeD1WriteQuotaError,
  SAFE_D1_WRITE_QUOTA_MESSAGE,
} from "../lib/sync-recovery";
import {
  AnalyticsSingleDealRuntimeError,
  nextAnalyticsRetryBatchSize,
  planAnalyticsBatch,
} from "../lib/analytics-runtime";
import { SALES_SNAPSHOT_UPSERT } from "../lib/sales-snapshots";

type PayloadRow = { deal_id: string; payload: string };

function runtimeRows(total: number, historiesPerDeal: number) {
  const rawDeals = Array.from({ length: total }, (_, index) => ({
    deal_id: String(index + 1), payload: JSON.stringify({ ID: String(index + 1), observers: [] }),
  }));
  const stageHistories = rawDeals.flatMap((deal) => Array.from({ length: historiesPerDeal }, (_, index) => ({
    deal_id: deal.deal_id, payload: JSON.stringify({ ID: `${deal.deal_id}-${index}`, OWNER_ID: deal.deal_id }),
  })));
  return { rawDeals, stageHistories };
}

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Older Node runtimes skip SQLite proof. */ }

test("failed analytics batch retries with a stable cursor and cannot duplicate Deal IDs", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync!(":memory:");
  db.exec("CREATE TABLE raw_deals(deal_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)");
  db.exec("CREATE TABLE analytics_records(deal_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  const insertRaw = db.prepare("INSERT INTO raw_deals VALUES(?, ?, '{}', 'same-run')");
  for (let id = 1; id <= 241; id += 1) {
    // Deliberately create ties at several 80-row boundaries.
    const minute = Math.floor((id - 1) / 3).toString().padStart(2, "0");
    insertRaw.run(String(id).padStart(4, "0"), `2026-09-01T${minute}:00:00Z`);
  }

  const page = (cursor: number) => db.prepare(analyticsPageSql(80)).all("same-run", cursor) as { deal_id: string }[];
  const first = page(0).map((row) => row.deal_id);
  const failed = page(80).map((row) => row.deal_id);
  const replay = page(80).map((row) => row.deal_id);
  const next = page(160).map((row) => row.deal_id);
  assert.deepEqual(replay, failed, "the same cursor returns the identical failed batch");
  assert.equal(new Set([...first, ...failed, ...next]).size, first.length + failed.length + next.length,
    "stable pages neither skip nor overlap Deals");

  const upsert = db.prepare("INSERT OR REPLACE INTO analytics_records(deal_id, payload) VALUES(?, ?)");
  for (const dealId of failed) upsert.run(dealId, "first partial attempt");
  for (const dealId of replay) upsert.run(dealId, "successful replay");
  const stored = db.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT deal_id) AS distinct_ids FROM analytics_records").get() as { total: number; distinct_ids: number };
  assert.equal(stored.total, 80, "replaying the batch does not add rows");
  assert.equal(stored.distinct_ids, 80, "primary-key upserts cannot duplicate Deal IDs");
});

test("analytics cursor advances only after analytics and snapshot writes finish", () => {
  const source = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const analytics = source.split("async function analyticsStep")[1].split("async function")[0];
  const recordsWrite = analytics.indexOf("await upsertAnalyticsRecords(records)");
  const snapshotsWrite = analytics.indexOf("await saveSalesSnapshots(records)");
  const cursorAdvance = analytics.indexOf("const cursor = job.cursor + batchDeals.length");
  assert.ok(recordsWrite >= 0 && recordsWrite < snapshotsWrite && snapshotsWrite < cursorAdvance);
  assert.match(analytics, /analyticsPageSql\(analyticsDealBatchSize\)/);
});

test("analytics resume reads cached raw/history only and cannot refetch Bitrix observer data", () => {
  const source = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const analytics = source.split("async function analyticsStep")[1].split("export async function runSyncStep")[0];
  for (const forbidden of ["bitrixCall", "bitrixList", "bitrixPage", "enrichPostSaleObservers", "crm.deal", "crm.item", "crm.stagehistory"]) {
    assert.doesNotMatch(analytics, new RegExp(forbidden.replace(".", "\\.")), `${forbidden} is outside analytics resume`);
  }
  assert.match(analyticsPageSql(80), /FROM raw_deals/);
  assert.match(analytics, /FROM raw_stage_history/);
});

test("D1 write quota error is fixed-text safe and avoids doomed error-state writes", () => {
  const raw = new Error("D1_ERROR account=secret: free tier daily row write limit exceeded https://internal.example/token");
  const safe = safeD1WriteQuotaError(raw);
  assert.equal(safe?.message, SAFE_D1_WRITE_QUOTA_MESSAGE);
  assert.doesNotMatch(safe?.message ?? "", /secret|internal|https?:\/\//i);
  assert.equal(safeD1WriteQuotaError(new Error("ordinary D1 failure")), null);

  const source = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const catchBody = source.split("} catch (error) {").at(-1) ?? "";
  assert.ok(catchBody.indexOf("safeD1WriteQuotaError(error)") < catchBody.indexOf("saveSyncJob"),
    "quota is rethrown before generic persistence attempts");
});

test("recovery step has no deployment target and cannot start or select production", () => {
  const route = readFileSync(new URL("../app/api/sync/route.ts", import.meta.url), "utf8");
  const stepBranch = route.split('action === "step"')[1].split('action === "pause"')[0];
  assert.match(stepBranch, /runSyncSteps/);
  assert.doesNotMatch(stepBranch, /startSync|database|worker|production|target/i);
});

test("normal 80-record analytics batch keeps the normal batch size", () => {
  const rows = runtimeRows(80, 2);
  const plan = planAnalyticsBatch({ cursor: 0, ...rows });
  assert.equal(plan.batchSize, 80);
  assert.equal(plan.splitLevel, 0);
  assert.equal(plan.safeErrorClass, "NONE");
});

test("expensive analytics batch deterministically splits 80 to 40", () => {
  const rows = runtimeRows(80, 5);
  const plan = planAnalyticsBatch({ cursor: 2000, ...rows });
  assert.equal(plan.attemptedBatchSize, 80);
  assert.equal(plan.batchSize, 40);
  assert.equal(plan.splitLevel, 1);
  assert.equal(plan.safeErrorClass, "ANALYTICS_COST_SPLIT");
});

test("adaptive batches preserve the exact Deal set and advance by actual committed count", () => {
  const all = runtimeRows(160, 5);
  const committed: string[] = [];
  let cursor = 0;
  while (cursor < all.rawDeals.length) {
    const rawDeals = all.rawDeals.slice(cursor, cursor + 80);
    const pageIds = new Set(rawDeals.map((row) => row.deal_id));
    const stageHistories = all.stageHistories.filter((row) => pageIds.has(row.deal_id));
    const plan = planAnalyticsBatch({ cursor, rawDeals, stageHistories });
    const actual = rawDeals.slice(0, plan.batchSize).map((row) => row.deal_id);
    committed.push(...actual);
    cursor += actual.length;
  }
  assert.equal(cursor, 160);
  assert.deepEqual(committed, all.rawDeals.map((row) => row.deal_id));
  assert.equal(new Set(committed).size, 160);
});

test("an uncommitted adaptive attempt halves on replay and remains duplicate-safe", () => {
  const rows = runtimeRows(80, 2);
  const first = planAnalyticsBatch({ cursor: 2000, ...rows });
  const replay = planAnalyticsBatch({ cursor: 2000, ...rows, previous: first });
  assert.equal(first.batchSize, 80);
  assert.equal(replay.batchSize, 40);
  assert.equal(replay.safeErrorClass, "ANALYTICS_RUNTIME_SPLIT");

  const stored = new Map<string, string>();
  for (const row of rows.rawDeals.slice(0, first.batchSize)) stored.set(row.deal_id, "partial");
  for (const row of rows.rawDeals.slice(0, replay.batchSize)) stored.set(row.deal_id, "replay");
  assert.equal(stored.size, 80, "deal_id upserts cannot duplicate partially written rows");
});

test("a persisted runtime retry narrows the D1 history query before profiling", () => {
  const rows = runtimeRows(80, 2);
  const first = planAnalyticsBatch({ cursor: 2320, ...rows });
  const retried = { ...first, batchSize: 10, attemptedBatchSize: 20, splitLevel: 3, retryCount: 3 };
  assert.equal(nextAnalyticsRetryBatchSize({ cursor: 2320, available: 80, previous: retried }), 5);
  assert.equal(nextAnalyticsRetryBatchSize({ cursor: 2321, available: 80, previous: retried }), null,
    "a completed/advanced cursor never inherits the old retry cap");

  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const analytics = sync.split("async function analyticsStep")[1].split("export async function runSyncStep")[0];
  assert.ok(analytics.indexOf("const profiledDeals") < analytics.indexOf("SELECT deal_id, payload FROM raw_stage_history"),
    "history is queried only after the persisted retry size has narrowed the Deal IDs");
  assert.match(analytics, /const candidateIds = profiledDeals\.map/);
});

test("one pathological Deal is isolated with a safe exact Deal ID", () => {
  const rawDeals: PayloadRow[] = [{ deal_id: "40099", payload: "x".repeat(80_001) }];
  assert.throws(
    () => planAnalyticsBatch({ cursor: 2000, rawDeals, stageHistories: [] }),
    (error: unknown) => error instanceof AnalyticsSingleDealRuntimeError
      && error.dealId === "40099"
      && !/webhook|token|password|secret/i.test(error.message),
  );
});

test("repeated minimum-size runtime failure stops instead of retrying recursively", () => {
  const rows = runtimeRows(1, 0);
  const first = planAnalyticsBatch({ cursor: 2000, ...rows });
  assert.equal(first.batchSize, 1);
  assert.throws(
    () => planAnalyticsBatch({ cursor: 2000, ...rows, previous: first }),
    AnalyticsSingleDealRuntimeError,
  );
});

test("adaptive analytics resume never refetches Deal, history, or observer data", () => {
  const source = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const analytics = source.split("async function analyticsStep")[1].split("export async function runSyncStep")[0];
  for (const forbidden of ["bitrixCall", "bitrixList", "bitrixPage", "attachDealObservers", "crm.deal", "crm.item", "crm.stagehistory"]) {
    assert.doesNotMatch(analytics, new RegExp(forbidden.replace(".", "\\.")));
  }
  assert.match(analytics, /analyticsPageSql\(analyticsDealBatchSize\)/);
  assert.match(analytics, /raw_stage_history/);
});

test("seller snapshot won_at remains immutable through an adaptive replay", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync!(":memory:");
  db.exec("CREATE TABLE deal_sales_snapshots(deal_id TEXT PRIMARY KEY, won_at TEXT NOT NULL, manager_id TEXT, manager_name TEXT, attribution_source TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.prepare(SALES_SNAPSHOT_UPSERT).run("1", "2026-09-01T00:00:00Z", null, null, "UNKNOWN", "created");
  db.prepare(SALES_SNAPSHOT_UPSERT).run("1", "2026-09-19T00:00:00Z", "7", "Ali", "POST_SALE_OBSERVER", "later");
  const row = db.prepare("SELECT won_at, manager_id, attribution_source FROM deal_sales_snapshots WHERE deal_id='1'").get() as Record<string, string>;
  assert.equal(row.won_at, "2026-09-01T00:00:00Z");
  assert.equal(row.manager_id, "7");
  assert.equal(row.attribution_source, "POST_SALE_OBSERVER");
});

test("adaptive runtime changes execution size only, not analytics formulas or run identity", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const analytics = sync.split("async function analyticsStep")[1].split("export async function runSyncStep")[0];
  assert.match(analytics, /buildAnalyticsRecords\(/);
  assert.match(analytics, /await upsertAnalyticsRecords\(records\)/);
  assert.match(analytics, /await saveSalesSnapshots\(records\)/);
  assert.match(analytics, /return \{[\s\S]*\.\.\.job,/, "the same StoredSyncJob/runId is preserved");
  assert.doesNotMatch(analytics, /randomUUID|startSync|clearPipelineScope/);
  assert.doesNotMatch(readFileSync(new URL("../lib/analytics-runtime.ts", import.meta.url), "utf8"), /salesStatus|qualified|lossReason|opportunity|wonAt/);
});
