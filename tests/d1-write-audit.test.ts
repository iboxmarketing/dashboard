import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  addD1WriteAuditToResponse,
  D1_WRITE_AUDIT_POINTS,
  getD1WriteAuditSummary,
  isD1WriteAuditEnabled,
  recordD1BatchMetadata,
  recordD1RunMetadata,
  withD1WriteAudit,
  withD1WriteAuditPhase,
} from "../lib/d1-write-audit";

const ROOT = new URL("../", import.meta.url).pathname;
const source = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

test("D1_WRITE_AUDIT is fail-closed and enabled only by the exact string 1", () => {
  for (const disabled of [undefined, null, "", "0", "true", "01", 1, true]) {
    assert.equal(isD1WriteAuditEnabled(disabled), false);
  }
  assert.equal(isD1WriteAuditEnabled("1"), true);
});

test("disabled auditing preserves the normal sync response object and shape", () => {
  const response = withD1WriteAudit(undefined, () => {
    const normal = { status: "running", progress: 10 };
    const returned = addD1WriteAuditToResponse(normal);
    assert.equal(returned, normal);
    return returned;
  });
  assert.deepEqual(response, { status: "running", progress: 10 });
  assert.equal("d1WriteAudit" in response, false);
});

test("one run result aggregates authoritative rows_written and secondary metadata", () => {
  const summary = withD1WriteAudit("1", () => {
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_DEALS_UPSERT, {
      rows_written: 6, rows_read: 2, changes: 1,
    });
    return getD1WriteAuditSummary();
  });
  assert.deepEqual(summary?.entries, [{
    phase: "sync.request", table: "raw_deals", operation: "insert_or_replace",
    statements: 1, rowsWritten: 6, rowsRead: 2, changes: 1,
  }]);
});

test("db.batch metadata is aggregated from every individual result", () => {
  const summary = withD1WriteAudit("1", () => {
    recordD1BatchMetadata(D1_WRITE_AUDIT_POINTS.ANALYTICS_UPSERT, [
      { rows_written: 4, rows_read: 1, changes: 1 },
      { rows_written: 8, rows_read: 2, changes: 1 },
      { rows_written: 4, rows_read: 0, changes: 1 },
    ]);
    return getD1WriteAuditSummary();
  });
  assert.deepEqual(summary?.entries[0], {
    phase: "sync.request", table: "analytics_records", operation: "insert_or_replace",
    statements: 3, rowsWritten: 16, rowsRead: 3, changes: 3,
  });
});

test("zero rows_written remains a measured zero", () => {
  const summary = withD1WriteAudit("1", () => {
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_STAGE_HISTORY_DELETE, {
      rows_written: 0, rows_read: 25, changes: 0,
    });
    return getD1WriteAuditSummary();
  });
  assert.equal(summary?.entries[0]?.rowsWritten, 0);
  assert.equal(summary?.entries[0]?.statements, 1);
});

test("phase, table, and operation labels remain separate aggregation buckets", () => {
  const summary = withD1WriteAudit("1", () => {
    withD1WriteAuditPhase("sync.stageHistory", () => {
      recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_STAGE_HISTORY_DELETE, { rows_written: 3 });
      recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_STAGE_HISTORY_INSERT, { rows_written: 5 });
    });
    withD1WriteAuditPhase("sync.start", () => {
      recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_STAGE_HISTORY_DELETE, { rows_written: 7 });
    });
    return getD1WriteAuditSummary();
  });
  assert.equal(summary?.entries.length, 3);
  assert.deepEqual(new Set(summary?.entries.map((entry) => `${entry.phase}/${entry.table}/${entry.operation}`)), new Set([
    "sync.stageHistory/raw_stage_history/delete",
    "sync.stageHistory/raw_stage_history/insert_or_replace",
    "sync.start/raw_stage_history/delete",
  ]));
});

test("concurrent request collectors cannot contaminate each other", async () => {
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstRecorded = new Promise<void>((resolve) => { announceFirst = resolve; });

  const first = withD1WriteAudit("1", async () => {
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_DEALS_UPSERT, { rows_written: 3 });
    announceFirst();
    await firstCanFinish;
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.RAW_DEALS_UPSERT, { rows_written: 2 });
    return getD1WriteAuditSummary();
  });
  await firstRecorded;
  const second = withD1WriteAudit("1", async () => {
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.ANALYTICS_UPSERT, { rows_written: 11 });
    await Promise.resolve();
    return getD1WriteAuditSummary();
  });
  releaseFirst();

  const [firstSummary, secondSummary] = await Promise.all([first, second]);
  assert.deepEqual(firstSummary?.entries.map(({ table, rowsWritten }) => ({ table, rowsWritten })), [
    { table: "raw_deals", rowsWritten: 5 },
  ]);
  assert.deepEqual(secondSummary?.entries.map(({ table, rowsWritten }) => ({ table, rowsWritten })), [
    { table: "analytics_records", rowsWritten: 11 },
  ]);
});

test("audit output accepts only fixed categories and aggregate numeric metadata", () => {
  const summary = withD1WriteAudit("1", () => {
    recordD1RunMetadata(D1_WRITE_AUDIT_POINTS.SYNC_JOB_UPSERT, {
      rows_written: 1,
      payload: "forbidden-business-data",
      bindings: ["forbidden-id"],
    } as { rows_written: number });
    return addD1WriteAuditToResponse({ status: "running" });
  });
  assert.ok("d1WriteAudit" in summary);
  assert.deepEqual(Object.keys(summary.d1WriteAudit.entries[0] ?? {}).sort(), [
    "changes", "operation", "phase", "rowsRead", "rowsWritten", "statements", "table",
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /forbidden-business-data|forbidden-id|payload|bindings/);

  const collector = source("lib/d1-write-audit.ts");
  assert.match(collector, /type D1WriteAuditMetadata = Readonly<\{\s*rows_written\?: number;\s*rows_read\?: number;\s*changes\?: number;/);
  assert.doesNotMatch(collector, /type D1WriteAuditMetadata[^}]+(?:payload|bindings|sql|url)/i);
});

test("audit uses the sync response path and no server console output", () => {
  for (const file of ["app/api/sync/route.ts", "lib/d1-write-audit.ts", "lib/storage.ts", "lib/sync.ts", "lib/post-sync-reconciliation.ts"]) {
    assert.doesNotMatch(source(file), /console\.(?:log|info|warn|error|debug|trace)/, `${file} must not log audit data`);
  }
  const route = source("app/api/sync/route.ts");
  assert.match(route, /withD1WriteAudit\(auditFlag/);
  assert.match(route, /Response\.json\(addD1WriteAuditToResponse\(value\)/);

  const client = source("app/dashboard-client.tsx");
  assert.equal((client.match(/console\.info\("D1_WRITE_AUDIT"/g) ?? []).length, 1);
  assert.match(client, /mergeD1WriteAuditSummaries/);
  assert.match(client, /if \(d1WriteAuditRef\.current\) console\.info\("D1_WRITE_AUDIT"/);
});

test("a new sync loop clears the previous D1 audit aggregate before its first request", () => {
  const client = source("app/dashboard-client.tsx");
  const loopStart = client.indexOf("async function syncLoop");
  const loopEnd = client.indexOf("async function pauseCurrentSync", loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart, "the test isolates the real syncLoop body");

  const loop = client.slice(loopStart, loopEnd);
  const reset = loop.indexOf("d1WriteAuditRef.current = null");
  const firstRequest = loop.indexOf("await postSync(");
  const finalSummary = loop.indexOf('console.info("D1_WRITE_AUDIT"');

  assert.ok(reset >= 0, "every new sync loop must discard a previous or failed run's aggregate");
  assert.ok(firstRequest > reset, "the aggregate must be reset before start/resume can return audit data");
  assert.ok(finalSummary > firstRequest, "only summaries collected after that reset can reach the final console output");
});

test("generated config is explicit opt-in, defaults off, and keeps observability off", () => {
  const config = source("scripts/cf-config.sh");
  assert.match(config, /audit_flag="\$\{D1_WRITE_AUDIT:-0\}"/);
  assert.match(config, /"vars": \{ "D1_WRITE_AUDIT": "\$\{audit_flag\}" \}/);
  assert.match(config, /"observability": \{ "enabled": false \}/);
  assert.match(config, /"\$audit_flag" != "0" && "\$audit_flag" != "1"/);
});

test("all required sync write sites consume D1 result metadata without changing SQL", () => {
  const storage = source("lib/storage.ts");
  const sync = source("lib/sync.ts");
  const reconciliation = source("lib/post-sync-reconciliation.ts");

  for (const point of [
    "SCHEMA_ENSURE", "APP_SETTINGS_UPSERT", "CRM_DICTIONARY_UPSERT", "SYNC_JOB_UPSERT",
    "SYNC_STATE_UPSERT", "ANALYTICS_UPSERT", "SALES_SNAPSHOT_UPSERT", "ANALYTICS_RECONCILIATION_UPDATE",
  ]) assert.match(storage, new RegExp(`D1_WRITE_AUDIT_POINTS\\.${point}`));
  for (const point of [
    "RAW_DEALS_UPSERT", "RAW_STAGE_HISTORY_DELETE", "RAW_STAGE_HISTORY_INSERT",
    "FULL_CLEAR_RAW_CALL_STATS", "FULL_CLEAR_RAW_ACTIVITIES", "FULL_CLEAR_RAW_STAGE_HISTORY",
    "FULL_CLEAR_ANALYTICS", "FULL_CLEAR_RAW_DEALS", "CRM_DICTIONARY_CHECKPOINT",
  ]) assert.match(sync, new RegExp(`D1_WRITE_AUDIT_POINTS\\.${point}`));
  assert.match(reconciliation, /CRM_DICTIONARY_RECONCILIATION/);
  assert.match(sync, /results\.map\(\(result\) => result\.meta\)/);
  assert.match(storage, /results\.map\(\(result\) => result\.meta\)/);
  assert.match(sync, /index \+= 40/);
  assert.match(storage, /index \+= 40/);
});
