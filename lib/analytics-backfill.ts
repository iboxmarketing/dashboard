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
 * Measured on production, not guessed. At 25 the request still returned Error
 * 1102, because the per-deal data was never the dominant term:
 *
 *   users + statuses + crmFields   185 KB of JSON, parsed on EVERY batch
 *   25 raw deals                    11 KB
 *   ~95 stage-history rows          14 KB
 *   25 rebuilt payloads             65 KB stringified on write
 *
 * The dictionaries are a fixed cost that shrinking the batch cannot touch, and
 * parsed object graphs run several times their JSON size. So the fix is both:
 * five deals per batch, and — see below — never holding a raw dictionary array
 * alive once its lookup Map has been derived from it.
 */
export const BACKFILL_BATCH_SIZE = 5;

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

  const pageSize = dealRows.length;
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

  // Loaded one at a time and immediately reduced to the small lookup Map the
  // builder needs. `Promise.all` into destructured consts kept all four raw
  // arrays — 185 KB of JSON, far more as objects — alive for the rest of the
  // function; this way each becomes unreachable as soon as its Map exists.
  const users = buildUserMap(await getDictionary<Record<string, unknown>[]>("users", []));
  const { stages, sources, stageMeta } = buildStatusMaps(await getDictionary<Record<string, unknown>[]>("statuses", []));
  const fieldOptions = buildFieldOptionMap(await getDictionary<CrmFieldOption[]>("crmFields", []));
  const pipelines = new Map((await getDictionary<{ id: string; name: string }[]>("pipelines", []))
    .map((row: { id: string; name: string }) => [String(row.id), String(row.name)]));
  const snapshots = await getSalesSnapshots(ids);

  // Parse in place and drop the row wrappers: holding the raw payload strings
  // and their parsed objects at the same time doubled this page's footprint.
  const deals = dealRows.map((row: { payload: string }) => JSON.parse(row.payload) as RawDeal);
  const stageHistories = historyRows.map((row: { payload: string }) => JSON.parse(row.payload) as RawStageHistory);
  dealRows.length = 0;
  historyRows.length = 0;

  const records = buildAnalyticsRecords({
    deals,
    stageHistories,
    settings,
    users,
    pipelines,
    stages, sources, stageMeta,
    fieldOptions,
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

  const cursor = state.cursor + pageSize;
  return {
    ...state,
    cursor,
    rebuilt: state.rebuilt + records.length,
    status: pageSize < BACKFILL_BATCH_SIZE ? "success" : "running",
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
