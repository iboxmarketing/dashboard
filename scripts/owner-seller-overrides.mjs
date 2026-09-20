#!/usr/bin/env node

// Owner-confirmed seller overrides.
//
// A deliberately tiny, version-controlled registry of Deals whose commercial
// seller the business owner has confirmed directly. It exists because some Deals
// cannot be resolved from CRM evidence — typically several observer candidates,
// where guessing is forbidden — and a human answer is the only evidence there is.
//
// SCOPE IS SELLER ATTRIBUTION ONLY. An override may never influence wonAt,
// OPPORTUNITY, Revenue, Lead, SQL, Not Relevant, Sales Lost, Cohort/Period Sales,
// source or stage history. `assertSellerOnlyScope` enforces that shape.
//
// This is NOT a rule. It does not mean "pick the candidate with the Sales job
// title": generic multi-candidate Deals stay ambiguous. Each entry is one
// attested fact about one Deal, reviewable in git history.

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Fields an override is allowed to carry. Anything else is rejected. */
export const OVERRIDE_FIELDS = Object.freeze([
  "dealId", "sellerId", "sellerName", "confirmedBy", "confirmedAt", "evidence", "scope",
]);
export const OVERRIDE_SCOPE = "SELLER_ATTRIBUTION_ONLY";

export const OWNER_CONFIRMED_SELLERS = Object.freeze([
  Object.freeze({
    dealId: "43407",
    sellerId: "7893",
    sellerName: "Jamoliddin Kamarov",
    confirmedBy: "business owner",
    confirmedAt: "2026-09-20",
    evidence: "Owner confirmation. CRM evidence was ambiguous: observers [7893, 13053] minus assignee 12961 left two candidates, so no automatic rule could resolve it. Corroborating (not deciding): MOVED_BY_ID=7893 at the 2026-09-10T16:27:51+03:00 C3:WON transition; 7893 holds 372 category-3 cards and none post-sale; 13053 holds 18 post-sale cards and none in Sales.",
    scope: OVERRIDE_SCOPE,
  }),
]);

/** Rejects an override that reaches beyond seller attribution. */
export function assertSellerOnlyScope(entry) {
  const unknown = Object.keys(entry).filter((key) => !OVERRIDE_FIELDS.includes(key));
  if (unknown.length) throw new Error(`owner override for ${s(entry.dealId) || "(no deal)"} carries out-of-scope fields: ${unknown.join(", ")}`);
  if (entry.scope !== OVERRIDE_SCOPE) throw new Error(`owner override for ${s(entry.dealId)} must declare scope ${OVERRIDE_SCOPE}`);
  return true;
}

/**
 * Validates and indexes the registry, plus any extra entries supplied at runtime
 * (so a later confirmation can be fed in without editing this file).
 */
export function loadOwnerOverrides(extra = []) {
  const byDeal = new Map();
  for (const entry of [...OWNER_CONFIRMED_SELLERS, ...extra]) {
    assertSellerOnlyScope(entry);
    const dealId = s(entry.dealId);
    const sellerId = s(entry.sellerId);
    if (!/^\d+$/.test(dealId)) throw new Error(`owner override has an invalid dealId: ${JSON.stringify(entry.dealId)}`);
    if (!/^[1-9]\d*$/.test(sellerId)) throw new Error(`owner override for ${dealId} has an invalid sellerId: ${JSON.stringify(entry.sellerId)}`);
    if (!s(entry.confirmedBy) || !s(entry.confirmedAt)) throw new Error(`owner override for ${dealId} must record confirmedBy and confirmedAt`);
    if (byDeal.has(dealId)) throw new Error(`owner override for ${dealId} is declared twice`);
    byDeal.set(dealId, { ...entry, dealId, sellerId });
  }
  return byDeal;
}

/**
 * The override outranks CRM evidence, because the owner is the authority on who
 * sold a Deal. Any disagreement with the evidence is flagged rather than hidden,
 * so a wrong confirmation stays visible instead of quietly rewriting history.
 */
export function applyOwnerOverride({ dealId, verdict, overrides, snapshotManagerId = null, observerCandidates = [] }) {
  const override = overrides?.get(s(dealId));
  if (!override) return verdict;
  const flags = [...(verdict?.flags ?? []), `OWNER_CONFIRMED_SELLER:${override.sellerId} confirmedBy=${override.confirmedBy} on ${override.confirmedAt}`];
  if (observerCandidates.length && !observerCandidates.includes(override.sellerId)) {
    flags.push(`OWNER_SELLER_NOT_AMONG_OBSERVER_CANDIDATES:[${observerCandidates.join(",")}]`);
  }
  if (snapshotManagerId && snapshotManagerId !== override.sellerId) {
    flags.push(`OWNER_SELLER_REPLACES_FROZEN:${snapshotManagerId}`);
  }
  return {
    ...verdict,
    action: "OWNER_CONFIRMED_SELLER",
    basis: "OWNER_CONFIRMATION",
    sellerId: override.sellerId,
    // The frozen value is replaced, so it is unsafe to keep — but only when it
    // actually differs from the confirmed seller.
    provenUnsafe: Boolean(snapshotManagerId && snapshotManagerId !== override.sellerId),
    ownerConfirmed: true,
    flags,
  };
}

/** Repair-flow payload: seller attribution and provenance, nothing else. */
export function overrideManifest(overrides) {
  return {
    schemaVersion: 1,
    scope: OVERRIDE_SCOPE,
    note: "Consumed by the seller repair/rebuild flow. It sets the seller only; wonAt, OPPORTUNITY, Revenue, Lead, SQL, Not Relevant, Sales Lost, Cohort/Period Sales, source and stage history are untouched.",
    overrides: [...overrides.values()].map((o) => ({
      dealId: o.dealId, sellerId: o.sellerId, sellerName: o.sellerName ?? null,
      attributionSource: "OWNER_CONFIRMED", confirmedBy: o.confirmedBy, confirmedAt: o.confirmedAt, evidence: o.evidence ?? null,
    })),
  };
}
