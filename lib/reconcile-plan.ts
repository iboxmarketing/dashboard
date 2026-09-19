import { LOOKUP_BATCH_LIMIT } from "./deal-snapshot";
import type { CurrentScope } from "./stale-resolution";

/**
 * Candidate selection and reconciliation bookkeeping.
 *
 * Pure by design — no Cloudflare or D1 imports — so batching, skip rules and
 * state shape are testable directly. The applier lives in
 * `post-sync-reconciliation.ts`.
 */

/** Bounded so one completed sync can never fan out into an unbounded REST sweep. */
export const RECONCILE_BATCH_LIMIT = LOOKUP_BATCH_LIMIT;

export type ReconcileState = {
  lastRunAt: string;
  checked: number;
  resolvedOutOfScope: number;
  resolvedUnavailable: number;
  lookupErrors: number;
  pending: number;
  safeError: string | null;
};

export const reconcileStateKey = (pipelineId: string) => `reconcileState:${pipelineId}`;

export function emptyReconcileState(now: Date = new Date()): ReconcileState {
  return {
    lastRunAt: now.toISOString(),
    checked: 0, resolvedOutOfScope: 0, resolvedUnavailable: 0, lookupErrors: 0, pending: 0, safeError: null,
  };
}

/**
 * Which cached canonical candidates deserve a by-id lookup: stored in one of
 * the project funnels, not already definitively decided, and absent from the
 * live all-status Sales + post-sale membership snapshot. Closed and post-sale
 * rows must participate because either can later move to another project.
 */
export function selectStaleCandidates(
  records: { dealId: string; categoryId: string; currentScope?: CurrentScope }[],
  liveIds: Set<string>,
  categoryIds: string[],
  limit = RECONCILE_BATCH_LIMIT,
) {
  const scoped = new Set(categoryIds.map(String));
  const all = records
    .filter((row) => scoped.has(String(row.categoryId)))
    // Already-decided records are not re-examined on every run.
    .filter((row) => (row.currentScope ?? "IN_SCOPE") === "IN_SCOPE")
    .filter((row) => !liveIds.has(row.dealId))
    .map((row) => row.dealId);
  return { batch: all.slice(0, limit), pending: Math.max(0, all.length - limit) };
}
