import { getDealsByIds } from "./deal-lookup";
import { emptyReconcileState, reconcileStateKey, selectStaleCandidates, type ReconcileState } from "./reconcile-plan";
import { currentScopeFor, resolveStaleDeal, type StaleResolution } from "./stale-resolution";
import { getDictionary, listReconcileCandidates, saveDictionary, setAnalyticsCurrentScope } from "./storage";
import { bitrixList, safeBitrixMessage } from "./bitrix";
import type { RawCurrentStageDeal } from "./current-stages";
import type { DashboardSettings } from "./types";

/**
 * Reconciles cached-ACTIVE deals that have vanished from the live open-sales
 * snapshot, and runs automatically at the end of every successful incremental
 * sync — manual or scheduled, since both finish through the same code path.
 *
 * It only ever writes `currentScope`. Historical identity — createdAt, origin
 * funnel, qualified, lossReasonGroup, salesStatus, wonAt, seller snapshots — is
 * never touched, because where a deal sits today says nothing about which
 * cohort it belonged to.
 */

/**
 * Runs after a successful sync. Never throws and never turns a successful sync
 * into a failed one: a reconciliation problem is recorded in its own state, not
 * folded into the sync result.
 */
export async function runPostSyncReconciliation(settings: DashboardSettings): Promise<ReconcileState> {
  const categoryIds = [...new Set((settings.selectedPipelineIds ?? []).map(String).filter(Boolean))];
  const pipelineId = categoryIds[0] ?? "unknown";
  const state: ReconcileState = emptyReconcileState();
  if (!categoryIds.length) return state;

  try {
    const [live, records] = await Promise.all([
      bitrixList<RawCurrentStageDeal>("crm.deal.list", {
        order: { ID: "ASC" },
        filter: {
          ...(categoryIds.length === 1 ? { CATEGORY_ID: categoryIds[0] } : { "@CATEGORY_ID": categoryIds }),
          CLOSED: "N",
        },
        select: ["ID"],
      }, { maxPages: 100 }),
      listReconcileCandidates(categoryIds),
    ]);
    const liveIds = new Set(live.map((row) => String((row as Record<string, unknown>).ID ?? "")));
    const { batch, pending } = selectStaleCandidates(records, liveIds, categoryIds);
    state.pending = pending;
    state.checked = batch.length;
    // Persist even with nothing to do, so lastRunAt reflects the real last run
    // rather than the last run that happened to find work.
    if (!batch.length) {
      await saveDictionary(reconcileStateKey(pipelineId), state);
      return state;
    }

    const lookups = await getDealsByIds(batch);
    const config = { selectedPipelineIds: categoryIds, postSalePipelineIds: settings.postSalePipelineIds ?? [] };

    for (const dealId of batch) {
      const lookup = lookups.get(dealId);
      if (!lookup) { state.lookupErrors += 1; continue; }
      const resolution: StaleResolution = resolveStaleDeal(lookup, config);
      const scope = currentScopeFor(resolution);
      // null means the lookup gave no answer — leave the record untouched.
      if (scope === null) { state.lookupErrors += 1; continue; }
      if (scope === "IN_SCOPE") continue;  // the normal sync will refresh it
      await setAnalyticsCurrentScope(dealId, scope);
      if (scope === "OUT_OF_SCOPE") state.resolvedOutOfScope += 1;
      else state.resolvedUnavailable += 1;
    }
  } catch (error) {
    state.safeError = safeBitrixMessage(error);
  }

  await saveDictionary(reconcileStateKey(pipelineId), state);
  return state;
}

export async function readReconcileState(pipelineId: string) {
  return await getDictionary<ReconcileState | null>(reconcileStateKey(pipelineId), null);
}

export { reconcileStateKey, RECONCILE_BATCH_LIMIT, selectStaleCandidates } from "./reconcile-plan";
export type { ReconcileState } from "./reconcile-plan";
