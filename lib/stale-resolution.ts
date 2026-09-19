import type { DealLookup } from "./deal-lookup";

/**
 * Classifies a cached project Deal that has vanished from the live all-status
 * Sales + post-sale membership snapshot, using a direct by-ID lookup.
 *
 * Historical identity (especially original DATE_CREATE) is never rewritten.
 * Current location is nevertheless canonical Lead-membership evidence, so this
 * records only definitive moves/deletions and leaves ambiguous lookups alone.
 */

export type StaleResolution =
  | "REFRESH_IN_SCOPE"      // still an open deal in a selected sales funnel
  | "CLOSED_IN_SCOPE"       // closed inside the sales funnel — canonical rules classify it
  | "MOVED_TO_POST_SALE"    // now in the configured paired post-sale funnel
  | "MOVED_OUT_OF_SCOPE"    // some other category: neither selected sales nor paired post-sale
  | "UNAVAILABLE"           // Bitrix answered definitively: deleted or unreadable
  | "LOOKUP_ERROR";         // no answer — decide nothing, retry on a later sync

/**
 * Current location, stored additively on the analytics record.
 *
 * `IN_SCOPE` covers selected sales and paired post-sale funnels — everything
 * the sync passes actually cover. Anything else can never be refreshed again
 * by the incremental query, which filters on the selected category ids.
 */
export type CurrentScope = "IN_SCOPE" | "OUT_OF_SCOPE" | "UNAVAILABLE";

export type ScopeConfig = {
  selectedPipelineIds: string[];
  postSalePipelineIds: string[];
};

export function resolveStaleDeal(lookup: DealLookup, config: ScopeConfig): StaleResolution {
  // Only a definitive answer may conclude "gone"; an unanswered lookup leaves
  // the record exactly as it was.
  if (!lookup.found) return lookup.reason === "NOT_FOUND" ? "UNAVAILABLE" : "LOOKUP_ERROR";
  const category = String(lookup.deal.categoryId);
  const selected = new Set((config.selectedPipelineIds ?? []).map(String));
  const postSale = new Set((config.postSalePipelineIds ?? []).map(String));

  if (selected.has(category)) return lookup.deal.closed ? "CLOSED_IN_SCOPE" : "REFRESH_IN_SCOPE";
  if (postSale.has(category)) return "MOVED_TO_POST_SALE";
  return "MOVED_OUT_OF_SCOPE";
}

/** `null` means "make no change" — the only safe answer to an unanswered lookup. */
export function currentScopeFor(resolution: StaleResolution): CurrentScope | null {
  if (resolution === "LOOKUP_ERROR") return null;
  if (resolution === "UNAVAILABLE") return "UNAVAILABLE";
  if (resolution === "MOVED_OUT_OF_SCOPE") return "OUT_OF_SCOPE";
  return "IN_SCOPE";
}

/**
 * A deal outside the sync scope is not a routed deal.
 *
 * Routing is decided by the accepted failure-reason rules
 * (`classifyLossReasonGroup`), never by the fact that a card moved. Inventing
 * a ROUTING group here would silently move deals out of Sotilmadi and change a
 * headline metric.
 */
export function impliesRouting(_resolution: StaleResolution): false {
  return false;
}

/**
 * Whether a record still sits in the canonical project's operational scope.
 */
export function countsAsOperational(scope: CurrentScope | undefined): boolean {
  return (scope ?? "IN_SCOPE") === "IN_SCOPE";
}
