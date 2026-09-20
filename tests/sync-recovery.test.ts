import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyticsPageSql,
  safeD1WriteQuotaError,
  SAFE_D1_WRITE_QUOTA_MESSAGE,
} from "../lib/sync-recovery";

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
  const cursorAdvance = analytics.indexOf("const cursor = job.cursor + rawDeals.length");
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
