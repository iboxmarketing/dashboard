import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { backfillBatchCount, backfillProgress } from "../lib/backfill-plan";
import { buildFieldOptionMap, buildStatusMaps, buildUserMap } from "../lib/analytics-dictionaries";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/**
 * Guards below assert on behaviour, so they must read code and not prose — the
 * modules describe in comments exactly what they refuse to do, and matching
 * that text would fail the very files that document the guarantee.
 */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("3/9: the backfill makes no Bitrix network calls", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  const route = code("../app/api/backfill/route.ts");
  for (const [name, source] of [["analytics-backfill", backfill], ["backfill route", route]] as const) {
    assert.doesNotMatch(source, /\bbitrixList\b/, `${name} must not list from Bitrix`);
    assert.doesNotMatch(source, /\bbitrixCall\b/, `${name} must not call Bitrix`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${name} must not make requests`);
  }
  // The only Bitrix import is the domain accessor, which parses the configured
  // URL to build deal links and never performs a request.
  const bitrixImports = backfill.match(/import \{([^}]*)\} from "\.\/bitrix";/);
  assert.deepEqual(bitrixImports?.[1].split(",").map((name) => name.trim()), ["getBitrixDomain"]);
});

test("3: the backfill never deletes raw data, checkpoints or management tables", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  assert.doesNotMatch(backfill, /DELETE|DROP|TRUNCATE/i, "no destructive statement");
  for (const table of ["projects", "project_updates", "custom_pages", "custom_page_widgets", "page_share_tokens", "page_share_widgets"]) {
    assert.doesNotMatch(backfill, new RegExp(`\\b${table}\\b`), `${table} must never be touched`);
  }
  assert.doesNotMatch(backfill, /syncScope|saveSyncState|saveSyncJob/, "sync checkpoints must not move");
  // raw tables are read-only here.
  assert.match(backfill, /SELECT deal_id, payload FROM raw_deals/);
  assert.match(backfill, /SELECT payload FROM raw_stage_history/);
  assert.doesNotMatch(backfill, /INSERT[\s\S]{0,40}raw_deals/i);
  assert.doesNotMatch(backfill, /INSERT[\s\S]{0,40}raw_stage_history/i);
});

test("4/6: paging is bounded and idempotent by construction", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  // A bounded page, never the whole table.
  assert.match(backfill, /LIMIT \$\{BACKFILL_BATCH_SIZE\} OFFSET \?/);
  assert.doesNotMatch(backfill, /listAnalyticsRecords/, "must not load every analytics payload");
  // Stable ordering keeps OFFSET paging deterministic across runs.
  assert.match(backfill, /ORDER BY deal_id/);
  // Writes go through the shared upsert, which is INSERT OR REPLACE on deal_id,
  // so re-running cannot duplicate a row or change a deal id.
  assert.match(backfill, /upsertAnalyticsRecords\(records\)/);
  const storage = read("../lib/storage.ts");
  assert.match(storage, /INSERT OR REPLACE INTO analytics_records\(deal_id/);

  const route = code("../app/api/backfill/route.ts");
  assert.doesNotMatch(route, /for\s*\(|while\s*\(/, "the route must not loop over batches");
  assert.match(route, /if \(state\.status === "running"\) state = await runAnalyticsBackfillBatch\(state\);/,
    "exactly one batch per request");
});

test("5: currentScope written by reconciliation survives a rebuild", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  assert.match(backfill, /json_extract\(payload, '\$\.currentScope'\) AS currentScope FROM analytics_records/);
  assert.match(backfill, /if \(scope\) record\.currentScope = scope as never;/);
  // The builder itself never produces currentScope, which is why it must be
  // re-applied rather than left to the rebuild.
  assert.doesNotMatch(code("../lib/analytics.ts"), /currentScope:/);
});

test("6: progress arithmetic is clamped and total-safe", () => {
  assert.equal(backfillProgress(0, 100), 0);
  assert.equal(backfillProgress(50, 100), 50);
  assert.equal(backfillProgress(100, 100), 100);
  // A dataset that grew mid-run must not report above 100 or below 0.
  assert.equal(backfillProgress(150, 100), 100);
  assert.equal(backfillProgress(-5, 100), 0);
  assert.equal(backfillProgress(0, 0), 100, "nothing to do is complete, not divide-by-zero");
  assert.equal(backfillBatchCount(0, 60), 0);
  assert.equal(backfillBatchCount(60, 60), 1);
  assert.equal(backfillBatchCount(61, 60), 2);
  assert.equal(backfillBatchCount(100, 0), 0);
});

test("3: sync and backfill build analytics inputs from the same shared helpers", () => {
  const sync = code("../lib/sync.ts");
  const backfill = code("../lib/analytics-backfill.ts");
  for (const helper of ["buildStatusMaps", "buildUserMap", "buildFieldOptionMap"]) {
    assert.match(sync, new RegExp(helper), `sync must use ${helper}`);
    assert.match(backfill, new RegExp(helper), `backfill must use ${helper}`);
  }
  // Neither may hand-roll the stage/source maps again.
  for (const source of [sync, backfill]) {
    assert.doesNotMatch(source, /entity === "SOURCE"/, "source map is built in one place only");
  }
});

test("dictionary builders derive stage ordering from SORT, never from names", () => {
  const { stages, sources, stageMeta } = buildStatusMaps([
    { STATUS_ID: "C3:NEW", NAME: "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", ENTITY_ID: "DEAL_STAGE_3", SORT: 10 },
    { STATUS_ID: "C3:UC_9SUEMM", NAME: "ОБРАБОТКА", ENTITY_ID: "DEAL_STAGE_3", SORT: 50 },
    { STATUS_ID: "NEW", NAME: "Yangi", ENTITY_ID: "DEAL_STAGE", SORT: 5 },
    { STATUS_ID: "WEBFORM", NAME: "CRM-форма", ENTITY_ID: "SOURCE", SORT: 25 },
  ]);
  assert.equal(stages.get("C3:UC_9SUEMM"), "ОБРАБОТКА");
  assert.deepEqual(stageMeta.get("C3:UC_9SUEMM"), { sort: 50, categoryId: "3" });
  assert.deepEqual(stageMeta.get("NEW"), { sort: 5, categoryId: "0" }, "the default funnel maps to category 0");
  assert.equal(sources.get("WEBFORM"), "CRM-форма");
  assert.equal(stages.has("WEBFORM"), false, "a source is never a stage");

  assert.equal(buildUserMap([{ ID: "7", NAME: "Ali", LAST_NAME: "Valiyev" }]).get("7"), "Ali Valiyev");
  assert.equal(buildUserMap([{ ID: "9" }]).get("9"), "Menejer #9", "an unnamed user still gets a stable label");
  const options = buildFieldOptionMap([{ key: "UF_X", options: [{ id: "1", value: "Bir" }] }]);
  assert.equal(options.get("UF_X")?.get("1"), "Bir");
});

test("9: one request rebuilds at most 5 deals, in exactly one batch", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  const route = code("../app/api/backfill/route.ts");
  const batchSize = Number(backfill.match(/BACKFILL_BATCH_SIZE = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(batchSize));
  // Production returned Error 1102 at 25 deals in a single batch. Raising this
  // again requires deliberately editing this test, which is the point.
  assert.ok(batchSize <= 5, `BACKFILL_BATCH_SIZE is ${batchSize}; production 1102'd at 25`);
  assert.doesNotMatch(route, /for\s*\(|while\s*\(/, "no batch loop in the request handler");
  assert.equal((route.match(/runAnalyticsBackfillBatch\(/g) ?? []).length, 1, "exactly one batch call site per request");
});

test("2/3: no raw dictionary array is retained once its Map is built", () => {
  const backfill = code("../lib/analytics-backfill.ts");
  // Promise.all into destructured consts kept users+statuses+crmFields (185 KB
  // of JSON, far more as objects) alive for the whole function. Each dictionary
  // must now be reduced to its Map in the same expression that loads it.
  assert.doesNotMatch(backfill, /Promise\.all/, "dictionaries must not be loaded into a retained tuple");
  for (const call of [
    /buildUserMap\(await getDictionary/,
    /buildStatusMaps\(await getDictionary/,
    /buildFieldOptionMap\(await getDictionary/,
  ]) assert.match(backfill, call);
  // The raw page rows are released before the records are built.
  assert.match(backfill, /dealRows\.length = 0;/);
  assert.match(backfill, /historyRows\.length = 0;/);
  // Only this page's deals are ever queried.
  assert.match(backfill, /getSalesSnapshots\(ids\)/);
});

test("4: the response carries progress metadata only", () => {
  const route = code("../app/api/backfill/route.ts");
  assert.doesNotMatch(route, /backfill: state/, "must not echo the full state object");
  assert.doesNotMatch(route, /records/, "must never return rebuilt records");
  for (const field of ["status:", "cursor:", "total:", "progress:"]) assert.ok(route.includes(field), `${field} missing`);
});
