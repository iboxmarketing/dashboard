/**
 * Reviewed, per-Deal seller decisions.
 *
 * Two version-controlled lists, each entry one attested fact about one Deal,
 * reviewable in git history. Neither is a rule: nothing here infers a seller
 * from a job title, an observer's department or anyone's "Sales-looking"
 * profile — previous audits showed titles go stale in both directions.
 *
 *  OWNER_CONFIRMED_SELLERS
 *    The business owner named the commercial seller of a Deal that CRM
 *    evidence could not resolve. The strongest seller source: analytics use it
 *    before any snapshot or fallback, and the snapshot upsert lets nothing
 *    else overwrite it.
 *
 *  SELLER_REVIEW_EXCLUSIONS
 *    Deals a reviewed audit placed in HUMAN_REVIEW because their automatic
 *    evidence is contradictory. If their snapshot seller is ever cleared, the
 *    fallback chain must NOT re-derive a seller for them; they stay Unknown
 *    until a human decides (an owner confirmation outranks the exclusion).
 *
 * SCOPE IS SELLER ATTRIBUTION ONLY. An entry may not carry wonAt, OPPORTUNITY,
 * revenue, sales/lead status, source or stage history; `assertSellerOnlyScope`
 * rejects any such field, so an override can never move a core KPI.
 */

export const OVERRIDE_SCOPE = "SELLER_ATTRIBUTION_ONLY" as const;
export const OWNER_CONFIRMED = "OWNER_CONFIRMED" as const;

export type OwnerSellerOverride = {
  dealId: string;
  sellerId: string;
  sellerName: string;
  attributionSource: typeof OWNER_CONFIRMED;
  confirmedBy: string;
  confirmedAt: string;
  evidence: string;
  scope: typeof OVERRIDE_SCOPE;
};

export type SellerReviewExclusion = {
  dealId: string;
  reason: string;
  reviewedAt: string;
  reference: string;
  scope: typeof OVERRIDE_SCOPE;
};

const OVERRIDE_FIELDS = ["dealId", "sellerId", "sellerName", "attributionSource", "confirmedBy", "confirmedAt", "evidence", "scope"] as const;
const EXCLUSION_FIELDS = ["dealId", "reason", "reviewedAt", "reference", "scope"] as const;

export const OWNER_CONFIRMED_SELLERS: readonly OwnerSellerOverride[] = Object.freeze([
  Object.freeze({
    dealId: "43407",
    sellerId: "7893",
    sellerName: "Jamoliddin Kamarov",
    attributionSource: OWNER_CONFIRMED,
    confirmedBy: "business owner",
    confirmedAt: "2026-09-20",
    evidence: "Owner confirmation. CRM evidence was ambiguous: observers [7893, 13053] minus assignee 12961 left two candidates, so no automatic rule could resolve it.",
    scope: OVERRIDE_SCOPE,
  }),
]);

/**
 * From the reviewed staging manifest (2026-09-21): payment-stage MOVED_BY_ID is
 * user 89, contradicted by the Deal's own evidence. Clearing these snapshots
 * and letting the mover fallback run would credit that person with the sale.
 */
const MOVER_89_REASON = "HUMAN_REVIEW: payment-stage MOVED_BY_ID is user 89, contradicted by the Deal's evidence; automatic recovery would credit the wrong person.";
export const SELLER_REVIEW_EXCLUSIONS: readonly SellerReviewExclusion[] = Object.freeze(
  ["41251", "41351", "41407", "41411"].map((dealId) => Object.freeze({
    dealId, reason: MOVER_89_REASON, reviewedAt: "2026-09-21",
    reference: ".audit/seller-repair-staging/human-review.json (audit/seller-attribution-live 352f7db)", scope: OVERRIDE_SCOPE,
  })),
);

const DEAL_ID = /^[1-9]\d*$/;

/** Rejects an entry that reaches beyond seller attribution or is malformed. */
export function assertSellerOnlyScope(entry: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(entry).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`seller override ${String(entry.dealId)} carries out-of-scope fields: ${extra.join(", ")}`);
  if (entry.scope !== OVERRIDE_SCOPE) throw new Error(`seller override ${String(entry.dealId)} must declare scope ${OVERRIDE_SCOPE}`);
  if (typeof entry.dealId !== "string" || !DEAL_ID.test(entry.dealId)) throw new Error(`seller override has an invalid dealId: ${JSON.stringify(entry.dealId)}`);
}

export function indexOwnerOverrides(entries: readonly OwnerSellerOverride[] = OWNER_CONFIRMED_SELLERS) {
  const byDeal = new Map<string, OwnerSellerOverride>();
  for (const entry of entries) {
    assertSellerOnlyScope(entry as unknown as Record<string, unknown>, OVERRIDE_FIELDS);
    if (!DEAL_ID.test(entry.sellerId)) throw new Error(`owner override ${entry.dealId} has an invalid sellerId`);
    if (entry.attributionSource !== OWNER_CONFIRMED) throw new Error(`owner override ${entry.dealId} must be ${OWNER_CONFIRMED}`);
    if (!entry.sellerName.trim() || !entry.confirmedBy.trim() || !entry.confirmedAt.trim()) throw new Error(`owner override ${entry.dealId} must record seller name, confirmedBy and confirmedAt`);
    if (byDeal.has(entry.dealId)) throw new Error(`owner override ${entry.dealId} is declared twice`);
    byDeal.set(entry.dealId, entry);
  }
  return byDeal;
}

export function indexReviewExclusions(entries: readonly SellerReviewExclusion[] = SELLER_REVIEW_EXCLUSIONS) {
  const ids = new Set<string>();
  for (const entry of entries) {
    assertSellerOnlyScope(entry as unknown as Record<string, unknown>, EXCLUSION_FIELDS);
    if (!entry.reason.trim() || !entry.reviewedAt.trim()) throw new Error(`review exclusion ${entry.dealId} must record reason and reviewedAt`);
    if (ids.has(entry.dealId)) throw new Error(`review exclusion ${entry.dealId} is declared twice`);
    ids.add(entry.dealId);
  }
  return ids;
}

/** Validated once at module load, so a bad entry fails the build and every test. */
export const OWNER_OVERRIDES = indexOwnerOverrides();
export const REVIEW_EXCLUSIONS = indexReviewExclusions();
