import type { DashboardRecord } from "./dashboard-record";
import type { DashboardSettings } from "./types";
import { DEFAULT_PROJECT, type ProjectKey } from "./sales-projects";

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

type BaseSettings = Pick<DashboardSettings, "selectedPipelineIds" | "postSalePipelineIds"> & Partial<Pick<DashboardSettings, "salesStaffIds">>;

/**
 * Everything the cached base depends on: the stored rows, the project, its
 * pipelines and its roster.
 *
 * The project is part of the key, not merely implied by the pipelines, so one
 * project's prepared rows can never answer the other project's request. The
 * roster is part of it because funnel ownership is decided in the base: a roster
 * edit used to be invisible until the TTL expired.
 */
export function salesCacheKey(fingerprint: SalesCacheFingerprint, settings: BaseSettings, project: ProjectKey = DEFAULT_PROJECT) {
  return JSON.stringify([
    project,
    fingerprint.rowCount, fingerprint.syncedAt, fingerprint.dictionariesAt, fingerprint.syncStateAt, fingerprint.syncJobAt,
    settings.selectedPipelineIds.map(String), settings.postSalePipelineIds.map(String),
    [...(settings.salesStaffIds ?? [])].map(String).sort(),
  ]);
}

type Entry = { key: string; storedAt: number; base: readonly DashboardRecord[] };

export function createSalesBaseCache(ttlMs = SALES_CACHE_TTL_MS) {
  // One entry PER PROJECT: switching workspaces must neither serve the other
  // project's rows nor evict them (the key carries the project as well).
  const entries = new Map<ProjectKey, Entry>();
  return {
    /** The cached base for `key`, or null when absent, for another key, or expired. */
    get(key: string, now: number, project: ProjectKey = DEFAULT_PROJECT): readonly DashboardRecord[] | null {
      const entry = entries.get(project);
      if (!entry || entry.key !== key || now - entry.storedAt >= ttlMs || now < entry.storedAt) return null;
      return entry.base;
    },
    /** One entry per project: a new dataset replaces that project's old one rather than accumulating. */
    set(key: string, base: readonly DashboardRecord[], now: number, project: ProjectKey = DEFAULT_PROJECT) {
      entries.set(project, { key, storedAt: now, base });
    },
    clear() { entries.clear(); },
  };
}

export const salesBaseCache = createSalesBaseCache();
