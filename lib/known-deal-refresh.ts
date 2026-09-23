import type { DealLookup } from "./deal-snapshot";

/**
 * Full Sync refresh of every Deal D1 already knows about.
 *
 * A Full Sync clears and re-reads only the scoped funnels (the selected Sales
 * category and its post-sale pair). A Deal that has since moved to another
 * project's funnel is not returned by those queries, so before this step its
 * stored raw row and analytics record simply stayed — written by whatever
 * analytics version last saw it, and still counted through the legacy
 * membership fallback. A sale snapshot whose Deal has no raw row at all was
 * equally invisible.
 *
 * The refresh re-reads each such Deal by ID, so it is rebuilt from current
 * Bitrix evidence by the current analytics version like every other Deal.
 * A Deal Bitrix no longer lists is asked for individually (`crm.deal.get`):
 * only a definitive NOT_FOUND marks it unavailable; anything ambiguous leaves
 * the stored record exactly as it was. Nothing is deleted.
 */

/** IDs per step: one `crm.deal.list` page, and every miss classifiable in the same step. */
export const REFRESH_BATCH_SIZE = 25;

/**
 * Candidates, in a stable order: raw Deals this run has not written, then
 * snapshot Deals with no raw row. A refreshed Deal is rewritten under the run
 * id and leaves the set; a Deal Bitrix did not return stays, so the offset is
 * the number of misses so far — they are always the lowest remaining IDs.
 *
 * Bindings: ?1 run id, ?2 limit, ?3 offset.
 */
export const REFRESH_CANDIDATES_SQL = `SELECT deal_id, origin FROM (
    SELECT deal_id, 'RAW' AS origin FROM raw_deals WHERE synced_at <> ?1
    UNION ALL
    SELECT s.deal_id, 'SNAPSHOT' AS origin FROM deal_sales_snapshots s
     WHERE NOT EXISTS (SELECT 1 FROM raw_deals r WHERE r.deal_id = s.deal_id)
  )
  ORDER BY deal_id
  LIMIT ?2 OFFSET ?3`;

export type RefreshOrigin = "RAW" | "SNAPSHOT";

/**
 *   REFRESHED        returned by crm.deal.list; rebuilt this run.
 *   NOT_FOUND        crm.deal.get answered definitively: the Deal is gone.
 *   FOUND_NOT_LISTED crm.deal.get returned it although the list did not —
 *                    a visibility question for a human, never a deletion.
 *   LOOKUP_ERROR     no definitive answer; the stored record is untouched.
 */
export type RefreshOutcome = "REFRESHED" | "NOT_FOUND" | "FOUND_NOT_LISTED" | "LOOKUP_ERROR";

export type RefreshAuditEntry = {
  dealId: string;
  origin: RefreshOrigin;
  outcome: RefreshOutcome;
  categoryId: string | null;
  stageId: string | null;
  code: string | null;
};

export type RefreshAudit = { runId: string; entries: RefreshAuditEntry[] };

export function refreshAuditKey(scopePipelineId: string) {
  return `refreshAudit:${scopePipelineId}`;
}

/** The audit for this run: the stored one if it belongs to it, else a fresh one. */
export function currentRefreshAudit(stored: RefreshAudit | null | undefined, runId: string): RefreshAudit {
  return stored && stored.runId === runId ? stored : { runId, entries: [] };
}

/** Classifies one step's candidates from the list result and the by-ID lookups of the misses. */
export function classifyRefreshStep(input: {
  candidates: { dealId: string; origin: RefreshOrigin }[];
  listed: Map<string, { categoryId: string; stageId: string }>;
  lookups: Map<string, DealLookup>;
}): RefreshAuditEntry[] {
  return input.candidates.map(({ dealId, origin }) => {
    const listed = input.listed.get(dealId);
    if (listed) return { dealId, origin, outcome: "REFRESHED", categoryId: listed.categoryId, stageId: listed.stageId, code: null };
    const lookup = input.lookups.get(dealId);
    if (!lookup) return { dealId, origin, outcome: "LOOKUP_ERROR", categoryId: null, stageId: null, code: "NOT_ATTEMPTED" };
    if (lookup.found) return { dealId, origin, outcome: "FOUND_NOT_LISTED", categoryId: lookup.deal.categoryId, stageId: lookup.deal.stageId, code: null };
    return { dealId, origin, outcome: lookup.reason === "NOT_FOUND" ? "NOT_FOUND" : "LOOKUP_ERROR", categoryId: null, stageId: null, code: lookup.code };
  });
}

/** Misses this step, i.e. how far the offset advances. */
export function refreshMisses(entries: RefreshAuditEntry[]) {
  return entries.filter((entry) => entry.outcome !== "REFRESHED").length;
}
