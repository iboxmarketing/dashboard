import { ANALYTICS_VERSION, buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "./analytics";
import { buildFieldOptionMap, buildStatusMaps, buildUserMap } from "./analytics-dictionaries";
import { getBitrixDomain } from "./bitrix";
import { backfillProgress, type BackfillState } from "./backfill-plan";
import { getD1 } from "@/db";
import { getDictionary, getSalesSnapshots, getSettings, upsertAnalyticsRecords } from "./storage";
import type { CrmFieldOption } from "./types";

/**
 * Analytics-only historical backfill.
 *
 * Recomputes `analytics_records` from data already in D1 — `raw_deals`,
 * `raw_stage_history`, the cached dictionaries, settings and sales snapshots —
 * using the same `buildAnalyticsRecords` the sync uses. It exists because
 * `qualified` is *stored*, so a change to the qualification rule leaves every
 * existing record reporting the old semantics until it is rebuilt.
 *
 * Deliberately makes NO Bitrix calls: there is no `bitrixList`/`bitrixCall`
 * import here, and `getBitrixDomain()` only reads the configured host string to
 * build deal links. That is what makes this safe to run without a Full Sync.
 *
 * It never deletes a raw row, never writes a management table, and never moves
 * a sync checkpoint. Records are written with INSERT OR REPLACE keyed on
 * `deal_id`, so the row count cannot grow and re-running is a no-op.
 */

/**
 * Deals rebuilt per batch.
 *
 * Measured, not guessed: 60 deals with four batches per request (240 in one
 * invocation) reproducibly returned Error 1102 on staging within ~0.5s — a
 * memory limit, since each deal carries its raw payload, its stage history and
 * the rebuilt record's JSON at once. 25 keeps a single invocation's working set
 * far below that even when the isolate is already serving page traffic.
 */
export const BACKFILL_BATCH_SIZE = 25;

/**
 * Rebuilds one bounded page of records.
 *
 * Paging is by `deal_id` rather than by a sync run id: the whole stored dataset
 * is the scope, so no second time boundary is invented. Only this page's deals,
 * their history and their snapshots are ever in memory.
 */
export async function runAnalyticsBackfillBatch(state: BackfillState): Promise<BackfillState> {
  const db = getD1();
  const settings = await getSettings();

  const dealRows = (await db
    .prepare(`SELECT deal_id, payload FROM raw_deals ORDER BY deal_id LIMIT ${BACKFILL_BATCH_SIZE} OFFSET ?`)
    .bind(state.cursor)
    .all<{ deal_id: string; payload: string }>()).results ?? [];

  if (!dealRows.length) {
    return { ...state, status: "success", progress: 100, message: "Analitika qayta hisoblandi" };
  }

  const ids = dealRows.map((row: { deal_id: string }) => row.deal_id);
  const placeholders = ids.map(() => "?").join(", ");
  const historyRows = (await db
    .prepare(`SELECT payload FROM raw_stage_history WHERE deal_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ payload: string }>()).results ?? [];

  // Reconciliation writes currentScope onto the stored record; the builder does
  // not produce it. Read the existing marks for exactly these deals and put
  // them back, so a rebuild cannot erase an UNAVAILABLE/OUT_OF_SCOPE decision.
  const scopeRows = (await db
    .prepare(`SELECT deal_id, json_extract(payload, '$.currentScope') AS currentScope FROM analytics_records WHERE deal_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ deal_id: string; currentScope: string | null }>()).results ?? [];
  const scopeByDeal = new Map(scopeRows
    .filter((row: { currentScope: string | null }) => row.currentScope)
    .map((row: { deal_id: string; currentScope: string | null }) => [row.deal_id, String(row.currentScope)]));

  const [userRows, statusRows, pipelineRows, crmFields, snapshots] = await Promise.all([
    getDictionary<Record<string, unknown>[]>("users", []),
    getDictionary<Record<string, unknown>[]>("statuses", []),
    getDictionary<{ id: string; name: string }[]>("pipelines", []),
    getDictionary<CrmFieldOption[]>("crmFields", []),
    getSalesSnapshots(ids),
  ]);

  const { stages, sources, stageMeta } = buildStatusMaps(statusRows);
  const records = buildAnalyticsRecords({
    deals: dealRows.map((row: { payload: string }) => JSON.parse(row.payload) as RawDeal),
    stageHistories: historyRows.map((row: { payload: string }) => JSON.parse(row.payload) as RawStageHistory),
    settings,
    users: buildUserMap(userRows),
    pipelines: new Map(pipelineRows.map((row: { id: string; name: string }) => [String(row.id), String(row.name)])),
    stages, sources, stageMeta,
    fieldOptions: buildFieldOptionMap(crmFields),
    snapshots,
    domain: getBitrixDomain(),
    // The raw history in D1 is what the last successful sync stored. Treating
    // it as available is what lets the corrected rule read "history exists and
    // contains no SQL" as evidence rather than as an unknown.
    stageHistoryAvailable: true,
  });

  for (const record of records) {
    const scope = scopeByDeal.get(record.dealId);
    if (scope) record.currentScope = scope as never;
  }
  await upsertAnalyticsRecords(records);

  const cursor = state.cursor + dealRows.length;
  return {
    ...state,
    cursor,
    rebuilt: state.rebuilt + records.length,
    status: dealRows.length < BACKFILL_BATCH_SIZE ? "success" : "running",
    progress: backfillProgress(cursor, state.total),
    message: `${cursor} / ${state.total} ta Deal qayta hisoblandi`,
    version: ANALYTICS_VERSION,
  };
}

/** Total is read once, so progress does not thrash if a sync lands mid-run. */
export async function startAnalyticsBackfill(): Promise<BackfillState> {
  const row = await getD1().prepare("SELECT COUNT(*) AS n FROM raw_deals").first<{ n: number }>();
  const total = Number(row?.n ?? 0);
  return { status: total ? "running" : "success", cursor: 0, total, rebuilt: 0, progress: total ? 0 : 100, message: total ? "Analitika qayta hisoblanmoqda…" : "Qayta hisoblash uchun ma’lumot yo‘q", version: ANALYTICS_VERSION, lastError: null };
}
