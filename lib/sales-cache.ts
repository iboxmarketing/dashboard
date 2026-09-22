import type { DashboardRecord } from "./dashboard-record";
import type { DashboardSettings } from "./types";

/**
 * Isolate-local cache of the prepared Sales base dataset.
 *
 * Every Sales section, Bootstrap, Diagnostics and the Pages KPI widgets start
 * from the same prepared rows: hydrated, limited to the selected project, with
 * duplicates marked. Rebuilding them meant reading and parsing every analytics
 * row on every request. The base is now kept in memory for as long as the D1
 * fingerprint (`SALES_FINGERPRINT_SQL`) and the pipeline selection are
 * unchanged, and never longer than `SALES_CACHE_TTL_MS`.
 *
 * What is cached is deliberately clock-independent. The SLA state is
 * re-resolved against the current time on every request, on fresh row objects,
 * so no request ever sees a stale PENDING/OVERDUE verdict and no request can
 * alter what the next one reads.
 *
 * Only plain data is shared between requests — never a pending promise, which
 * a Worker must not settle from another request's context.
 */

/** A safety net for writes outside the app (manual SQL), not the primary invalidation. */
export const SALES_CACHE_TTL_MS = 5 * 60_000;

export type SalesCacheFingerprint = {
  rowCount: number; syncedAt: string | null; dictionariesAt: string | null; syncStateAt: string | null; syncJobAt: string | null;
};

type BaseSettings = Pick<DashboardSettings, "selectedPipelineIds" | "postSalePipelineIds">;

/** Everything the cached base depends on: the stored rows and the project's pipelines. */
export function salesCacheKey(fingerprint: SalesCacheFingerprint, settings: BaseSettings) {
  return JSON.stringify([
    fingerprint.rowCount, fingerprint.syncedAt, fingerprint.dictionariesAt, fingerprint.syncStateAt, fingerprint.syncJobAt,
    settings.selectedPipelineIds.map(String), settings.postSalePipelineIds.map(String),
  ]);
}

type Entry = { key: string; storedAt: number; base: readonly DashboardRecord[] };

export function createSalesBaseCache(ttlMs = SALES_CACHE_TTL_MS) {
  let entry: Entry | null = null;
  return {
    /** The cached base for `key`, or null when absent, for another key, or expired. */
    get(key: string, now: number): readonly DashboardRecord[] | null {
      if (!entry || entry.key !== key || now - entry.storedAt >= ttlMs || now < entry.storedAt) return null;
      return entry.base;
    },
    /** One entry only: a new dataset replaces the old one rather than accumulating. */
    set(key: string, base: readonly DashboardRecord[], now: number) {
      entry = { key, storedAt: now, base };
    },
    clear() { entry = null; },
  };
}

export const salesBaseCache = createSalesBaseCache();
