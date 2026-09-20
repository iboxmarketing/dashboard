#!/usr/bin/env node

// Observer-based seller-recovery audit (read-only, evidence lane).
//
// Owner-confirmed IBOX handoff: once a Deal is sold and moves from Sales
// category 3 to Обучение/Сопровождение category 13, the onboarding/operator
// becomes ASSIGNED_BY_ID and the original Sales Manager becomes/remains an
// Observer. So in category 13 ASSIGNED_BY_ID is the operational owner and the
// observer may preserve seller identity.
//
// The rule is confirmed for category 13 ONLY. It is deliberately not applied to
// category 17 or any other funnel.
//
// Observers are not cached yet: `crm.deal.fields` does not expose them at all —
// only `crm.item.fields` (entityTypeId 2) does, as `observers` (type `user`,
// "Наблюдатели"). Capture therefore needs a `crm.item` read path, not a new
// column on the existing `crm.deal.list` select. Until that lands and a staging
// refresh caches the values, every function here reports absent evidence rather
// than guessing a seller.
//
// This module classifies only. It opens no database, calls no API, mutates
// nothing, and performs no repair.

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Observer states, per the approved audit contract. */
export const OBSERVER_STATE = Object.freeze({
  NOT_CACHED: "OBSERVER_NOT_CACHED",
  NONE: "NO_OBSERVER",
  EXACT_ONE: "EXACT_ONE_SELLER_CANDIDATE",
  MULTIPLE: "MULTIPLE_SELLER_CANDIDATES",
  ASSIGNEE_ONLY: "OBSERVER_EQUALS_ASSIGNEE_ONLY",
  INVALID: "INVALID_OBSERVER_ID",
});

/** Seller-evidence outcome, resolved in the approved priority order. */
export const EVIDENCE_SOURCE = Object.freeze({
  TRUSTWORTHY_SNAPSHOT: "TRUSTWORTHY_SNAPSHOT",
  PAYMENT_MOVER: "PAYMENT_STAGE_MOVER",
  OBSERVER: "CATEGORY_13_OBSERVER",
  AMBIGUOUS: "AMBIGUOUS_MULTIPLE_OBSERVERS",
  NONE: "NO_SELLER_EVIDENCE",
});

/** Final disposition of a historical snapshot. No repair is performed. */
export const DISPOSITION = Object.freeze({
  KEEP: "KEEP_TRUSTWORTHY",
  RECOVER_MOVER: "INVALIDATE_THEN_RECOVER_PAYMENT_MOVER",
  RECOVER_OBSERVER: "INVALIDATE_THEN_RECOVER_OBSERVER",
  TO_UNKNOWN: "INVALIDATE_TO_UNKNOWN",
  REVIEW: "HUMAN_REVIEW_REQUIRED",
});

export const OBSERVER_KEYS = Object.freeze(["observers", "OBSERVER_IDS", "observerIds", "OBSERVERS"]);

/**
 * Observer ids out of whatever shape the capture lands in.
 *
 * `crm.item.*` returns `observers: [12, 34]`; a deal-shaped payload could use
 * `OBSERVER_IDS`, possibly `user_12` strings or a delimited list. An entry with
 * no usable numeric id is reported as invalid and never silently dropped — a
 * malformed observer must not read as "no observer".
 *
 * `present: false` means the key is absent entirely, which is NOT the same as an
 * explicitly empty list.
 */
export function parseObservers(deal) {
  if (!deal || typeof deal !== "object") return { present: false, ids: [], invalid: [] };
  const key = OBSERVER_KEYS.find((candidate) => candidate in deal);
  if (key === undefined) return { present: false, ids: [], invalid: [] };
  const raw = deal[key];
  const entries = Array.isArray(raw) ? raw : str(raw) ? str(raw).split(/[,;]/) : [];
  const ids = [];
  const invalid = [];
  for (const entry of entries) {
    const value = entry && typeof entry === "object" ? (entry.ID ?? entry.id ?? entry.value) : entry;
    const id = str(value).match(/^(?:user_)?(\d+)$/i)?.[1];
    if (id && id !== "0") ids.push(id);
    else if (str(value)) invalid.push(str(value));
  }
  return { present: true, ids: [...new Set(ids)], invalid };
}

/**
 * Seller candidates = valid observer ids MINUS the current ASSIGNED_BY_ID.
 *
 * The operator is expected to remain an observer as well, so subtracting the
 * assignee is what turns `[seller, operator]` into a single candidate rather
 * than an ambiguous pair.
 *
 * `knownUserIds`, when supplied, is the cached Bitrix user directory: an
 * observer id that is not a real user is invalid evidence, not a seller.
 */
export function classifyObservers({ deal, assignedById, knownUserIds = null }) {
  const parsed = parseObservers(deal);
  if (!parsed.present) return { state: OBSERVER_STATE.NOT_CACHED, candidates: [], observerIds: [], invalid: [] };
  const unknown = knownUserIds ? parsed.ids.filter((id) => !knownUserIds.has(id)) : [];
  const valid = knownUserIds ? parsed.ids.filter((id) => knownUserIds.has(id)) : parsed.ids;
  if (parsed.invalid.length || unknown.length) {
    return { state: OBSERVER_STATE.INVALID, candidates: [], observerIds: valid, invalid: [...parsed.invalid, ...unknown] };
  }
  if (!valid.length) return { state: OBSERVER_STATE.NONE, candidates: [], observerIds: [], invalid: [] };
  const candidates = valid.filter((id) => id !== str(assignedById));
  if (!candidates.length) return { state: OBSERVER_STATE.ASSIGNEE_ONLY, candidates: [], observerIds: valid, invalid: [] };
  if (candidates.length === 1) return { state: OBSERVER_STATE.EXACT_ONE, candidates, observerIds: valid, invalid: [] };
  return { state: OBSERVER_STATE.MULTIPLE, candidates, observerIds: valid, invalid: [] };
}

/**
 * Seller evidence for one snapshot, in the approved priority order:
 *
 *   1. trustworthy existing seller snapshot
 *   2. payment-stage mover evidence
 *   3. category-13 post-sale observer evidence
 *   4. Unknown
 *
 * Payment-stage evidence deliberately outranks the observer: it is contemporaneous
 * with the sale, whereas the observer list is current state that anyone could have
 * edited since. Observer evidence applies only while the Deal is in category 13.
 *
 * Several candidates are ambiguous, full stop. A job-title hint is attached for
 * the human reviewer but never used to pick a seller.
 */
export function resolveSellerEvidence({
  snapshot, record, observerVerdict, paymentStageIds = [], postSaleCategoryId = "13",
  priorTrustworthy = false, users = new Map(), roleOf = null,
}) {
  const flags = [];
  const currentCategoryId = str(record?.categoryId);
  const inPostSale = currentCategoryId === str(postSaleCategoryId);
  const atPaymentStage = Boolean(record && paymentStageIds.includes(str(record.stageId)));
  const moverId = str(record?.movedBy);
  const state = observerVerdict?.state ?? OBSERVER_STATE.NOT_CACHED;
  const candidates = observerVerdict?.candidates ?? [];

  // 1. An existing trustworthy snapshot is never overridden.
  if (priorTrustworthy) {
    if (state === OBSERVER_STATE.EXACT_ONE && candidates[0] !== snapshot?.managerId) {
      flags.push(`OBSERVER_DISAGREES_WITH_TRUSTED_SNAPSHOT:${candidates[0]}`);
    }
    return { source: EVIDENCE_SOURCE.TRUSTWORTHY_SNAPSHOT, sellerId: snapshot?.managerId ?? null, disposition: DISPOSITION.KEEP, observerState: state, flags };
  }

  // 2. Payment-stage mover: contemporaneous with the sale. Never in post-sale,
  //    where MOVED_BY_ID is the operator who performed the handoff.
  if (atPaymentStage && moverId && !inPostSale) {
    if (state === OBSERVER_STATE.EXACT_ONE && candidates[0] !== moverId) {
      flags.push(`OBSERVER_DISAGREES_WITH_PAYMENT_MOVER:${candidates[0]}`);
    }
    return { source: EVIDENCE_SOURCE.PAYMENT_MOVER, sellerId: moverId, disposition: DISPOSITION.RECOVER_MOVER, observerState: state, flags };
  }

  // 3. Observer evidence — category 13 only. The handoff rule is confirmed for
  //    that funnel alone, so an observer anywhere else is not seller evidence.
  if (!inPostSale) {
    if (candidates.length) flags.push(`OBSERVER_IGNORED_OUTSIDE_CATEGORY_${str(postSaleCategoryId)}:category=${currentCategoryId || "unknown"}`);
    return { source: EVIDENCE_SOURCE.NONE, sellerId: null, disposition: DISPOSITION.TO_UNKNOWN, observerState: state, flags };
  }

  if (state === OBSERVER_STATE.EXACT_ONE) {
    const sellerId = candidates[0];
    if (roleOf) {
      const role = roleOf(users.get(str(sellerId)));
      if (role.role === "NON_SELLER") flags.push(`OBSERVER_HAS_NON_SELLER_ROLE:${role.basis}`);
    }
    return { source: EVIDENCE_SOURCE.OBSERVER, sellerId, disposition: DISPOSITION.RECOVER_OBSERVER, observerState: state, flags };
  }

  if (state === OBSERVER_STATE.MULTIPLE) {
    // Hint only. The outcome stays ambiguous: no seller is guessed.
    if (roleOf) {
      const sellerRole = candidates.filter((id) => roleOf(users.get(str(id))).role === "SELLER");
      if (sellerRole.length) flags.push(`HINT_CANDIDATES_WITH_SELLER_JOB_TITLE:${sellerRole.join(",")}`);
    }
    return { source: EVIDENCE_SOURCE.AMBIGUOUS, sellerId: null, disposition: DISPOSITION.REVIEW, observerState: state, flags };
  }

  if (state === OBSERVER_STATE.INVALID) {
    return { source: EVIDENCE_SOURCE.NONE, sellerId: null, disposition: DISPOSITION.REVIEW, observerState: state, flags: [...flags, `INVALID_OBSERVER_IDS:${(observerVerdict?.invalid ?? []).join(",")}`] };
  }

  // NO_OBSERVER, OBSERVER_EQUALS_ASSIGNEE_ONLY, or not cached at all.
  return { source: EVIDENCE_SOURCE.NONE, sellerId: null, disposition: DISPOSITION.TO_UNKNOWN, observerState: state, flags };
}

/** Rollup. The seller breakdown counts evidence-backed sellers only. */
export function summarizeRecovery(rows) {
  const tally = (key) => {
    const counts = new Map();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  };
  const evidenced = rows.filter((row) => row.sellerId);
  const breakdown = new Map();
  for (const row of evidenced) {
    const key = `${row.sellerId} ${row.sellerName ?? ""}`.trim();
    breakdown.set(key, (breakdown.get(key) ?? 0) + 1);
  }
  return {
    deals: rows.length,
    trustworthy: rows.filter((r) => r.source === EVIDENCE_SOURCE.TRUSTWORTHY_SNAPSHOT).length,
    paymentMover: rows.filter((r) => r.source === EVIDENCE_SOURCE.PAYMENT_MOVER).length,
    observerRecovered: rows.filter((r) => r.source === EVIDENCE_SOURCE.OBSERVER).length,
    ambiguous: rows.filter((r) => r.source === EVIDENCE_SOURCE.AMBIGUOUS).length,
    unknown: rows.filter((r) => r.source === EVIDENCE_SOURCE.NONE).length,
    // Diagnostic, NOT one of the five exclusive classes above: a payment-mover
    // row can also have no observer, so this deliberately overlaps them.
    noObserverEvidenceDiagnostic: rows.filter((r) => r.observerState === OBSERVER_STATE.NONE || r.observerState === OBSERVER_STATE.ASSIGNEE_ONLY).length,
    byObserverState: tally((r) => r.observerState),
    byDisposition: tally((r) => r.disposition),
    sellerBreakdownFromEvidenceOnly: Object.fromEntries([...breakdown].sort((a, b) => b[1] - a[1])),
  };
}

/** True only once a cached export actually carries the observer key. */
export function observerDataPresent(deals) {
  return deals.some((deal) => parseObservers(deal).present);
}

/**
 * Final manifest payloads, in the approved on-disk shape.
 *
 * `reviewed` asserts that the invalidate list was produced from complete
 * evidence. While observers are uncached that is false by construction, so the
 * list stays empty and says what it is waiting for — an unreviewed list must
 * never be handed on wearing `reviewed: true`.
 */
export function buildFinalManifest({ rows, observerDataAvailable }) {
  const ids = (predicate) => rows.filter(predicate).map((row) => row.dealId);
  const invalidateDispositions = [DISPOSITION.RECOVER_MOVER, DISPOSITION.RECOVER_OBSERVER, DISPOSITION.TO_UNKNOWN];
  return {
    reviewedInvalidate: {
      reviewed: Boolean(observerDataAvailable),
      dealIds: observerDataAvailable ? ids((row) => invalidateDispositions.includes(row.disposition)) : [],
      ...(observerDataAvailable ? {} : { pendingEvidence: OBSERVER_STATE.NOT_CACHED, note: "Observer capture plus a staging refresh must land before this list can be reviewed. Left empty on purpose." }),
    },
    keepTrustworthy: rows.filter((row) => row.disposition === DISPOSITION.KEEP),
    humanReview: rows.filter((row) => row.disposition === DISPOSITION.REVIEW),
  };
}
