import type { SalesManagerAttribution } from "./types";

/**
 * Whether a sale may be credited to an employee.
 *
 * This dashboard evaluates people, so an attribution is either proven or it is
 * not counted. Bitrix's REST API exposes no history of `ASSIGNED_BY_ID`, and
 * `crm.stagehistory.list` rows carry stage, category, semantic, type and time
 * but NO actor — so "who was responsible at the moment of sale" cannot be
 * reconstructed from stage history alone. What remains is:
 *
 *   SALES_OWNER_AT_WON  the canonical evidence going forward: a Bitrix robot
 *                       writes the Responsible person into the Sales Owner at
 *                       Won field when the Deal reaches payment and the field is
 *                       still empty — i.e. before the operator handoff. It is
 *                       captured at sale time, never overwritten, and outranks
 *                       every inferred signal.
 *   MANUAL_CONFIRMATION an admin named the seller in the review queue and the
 *                       choice was written back to the same Bitrix field.
 *   OWNER_CONFIRMED     an explicit reviewed per-Deal decision (lib/seller-overrides.ts).
 *   POST_SALE_OBSERVER  the approved handoff evidence: a won Deal in the paired
 *                       post-sale funnel whose observer list holds exactly one
 *                       valid user distinct from the current (support) assignee.
 *   CUSTOM_FIELD        a configured stable seller field — evidence only while
 *                       such a field is actually configured, and for a frozen
 *                       snapshot only when the field still corroborates it.
 *
 * Everything else names somebody without proving they sold anything:
 *
 *   STAGE_MOVER         MOVED_BY_ID is whoever moved the card, which may be an
 *                       operator or an automation.
 *   CURRENT_RESPONSIBLE the current owner, which after a sale is routinely
 *                       onboarding or support — the misattribution this model exists to stop.
 *   FIRST_CALL          legacy call-derived attribution; calls are no longer a data source.
 *
 * Those become REVIEW_REQUIRED: the seller is still shown on the Deal for a
 * human to judge, but no scorecard counts it. A missing or unknown user is
 * UNKNOWN. Job titles are never evidence, and the Sales roster only ever
 * downgrades (flags) — it can never make an unproven attribution countable.
 */

export type SellerCertification = "OWNER_CONFIRMED" | "CERTIFIED" | "REVIEW_REQUIRED" | "UNKNOWN";

/** Why an attribution landed where it did — the audit trail's machine-readable reason. */
export type SellerEvidenceReason =
  | "SALES_OWNER_AT_WON_FIELD"
  | "MANUAL_OWNER_CONFIRMATION"
  | "OWNER_REGISTRY"
  | "OBSERVER_HANDOFF"
  | "CONFIGURED_SELLER_FIELD"
  | "SNAPSHOT_CORROBORATED_BY_FIELD"
  | "SNAPSHOT_FIELD_NOT_CORROBORATED"
  | "NO_CONFIGURED_SELLER_FIELD"
  | "MOVER_IS_NOT_SELLER"
  | "CURRENT_OWNER_IS_NOT_EVIDENCE"
  | "LEGACY_CALL_EVIDENCE"
  | "OUTSIDE_SALES_ROSTER"
  | "UNKNOWN_USER"
  | "NO_SELLER";

export type SellerEvidence = {
  status: SellerCertification;
  reason: SellerEvidenceReason;
  /** True when the named person is not on the approved Sales roster (validation only). */
  outsideRoster: boolean;
};

export type SellerEvidenceInput = {
  attribution: SalesManagerAttribution;
  sellerId: string | null | undefined;
  /** The attribution came from a frozen snapshot rather than evidence read on this build. */
  fromSnapshot: boolean;
  /** A safe stable seller field is configured right now. */
  hasConfiguredSellerField: boolean;
  /** That field's current value on this Deal, when configured. */
  fieldSellerId?: string | null;
  /** The id resolves to a real Bitrix user. */
  knownUser: boolean;
  /** Approved Sales staff. Empty means "no roster configured": no flagging. */
  salesRoster?: ReadonlySet<string>;
};

const VALID_ID = /^[1-9]\d*$/u;

export function certifySeller(input: SellerEvidenceInput): SellerEvidence {
  const sellerId = String(input.sellerId ?? "").trim();
  const outsideRoster = Boolean(sellerId) && Boolean(input.salesRoster?.size) && !input.salesRoster?.has(sellerId);
  const flag = (status: SellerCertification, reason: SellerEvidenceReason): SellerEvidence => {
    // The roster never decides who sold: it can only send an INFERRED countable
    // attribution to a human. It may not touch evidence the owner has reviewed —
    // an owner confirmation, a manual confirmation, or the canonical Sales Owner
    // at Won field. Historical seller attribution and the CURRENT active Sales
    // roster are two different things (owner decision, 2026-09-24): a former Sales
    // employee keeps the sales they made, and the roster only decides who owns
    // today's open, Not Relevant and Sales Lost work.
    const ownerReviewed = reason === "SALES_OWNER_AT_WON_FIELD" || reason === "MANUAL_OWNER_CONFIRMATION" || reason === "OWNER_REGISTRY";
    if (outsideRoster && status === "CERTIFIED" && !ownerReviewed) {
      return { status: "REVIEW_REQUIRED", reason: "OUTSIDE_SALES_ROSTER", outsideRoster };
    }
    return { status, reason, outsideRoster };
  };

  if (!sellerId) return { status: "UNKNOWN", reason: "NO_SELLER", outsideRoster: false };
  if (!VALID_ID.test(sellerId) || !input.knownUser) return { status: "UNKNOWN", reason: "UNKNOWN_USER", outsideRoster };
  if (input.attribution === "OWNER_CONFIRMED") return flag("OWNER_CONFIRMED", "OWNER_REGISTRY");
  // An admin confirmation is an attested per-Deal fact, written back to Bitrix,
  // so it ranks with an owner confirmation and the roster cannot demote it.
  if (input.attribution === "MANUAL_CONFIRMATION") return flag("OWNER_CONFIRMED", "MANUAL_OWNER_CONFIRMATION");
  // The robot-written field IS the seller at the moment of sale. It is never
  // corroborated against anything else, because nothing else is stronger: not
  // the current assignee, not the mover, not an observer, not a legacy snapshot.
  if (input.attribution === "SALES_OWNER_AT_WON") return flag("CERTIFIED", "SALES_OWNER_AT_WON_FIELD");
  if (input.attribution === "POST_SALE_OBSERVER") return flag("CERTIFIED", "OBSERVER_HANDOFF");

  if (input.attribution === "CUSTOM_FIELD") {
    if (!input.hasConfiguredSellerField) return flag("REVIEW_REQUIRED", "NO_CONFIGURED_SELLER_FIELD");
    if (!input.fromSnapshot) return flag("CERTIFIED", "CONFIGURED_SELLER_FIELD");
    return String(input.fieldSellerId ?? "") === sellerId
      ? flag("CERTIFIED", "SNAPSHOT_CORROBORATED_BY_FIELD")
      : flag("REVIEW_REQUIRED", "SNAPSHOT_FIELD_NOT_CORROBORATED");
  }

  if (input.attribution === "STAGE_MOVER") return flag("REVIEW_REQUIRED", "MOVER_IS_NOT_SELLER");
  if (input.attribution === "CURRENT_RESPONSIBLE") return flag("REVIEW_REQUIRED", "CURRENT_OWNER_IS_NOT_EVIDENCE");
  // FIRST_CALL only ever reaches here from a frozen legacy snapshot: calls were
  // removed as a data source, so the current builder never emits it.
  if (String(input.attribution) === "FIRST_CALL") return flag("REVIEW_REQUIRED", "LEGACY_CALL_EVIDENCE");
  return { status: "UNKNOWN", reason: "NO_SELLER", outsideRoster };
}

/** Countable in an employee scorecard. Everything else is shown, never scored. */
export function countsForScorecard(status: SellerCertification | undefined) {
  return status === "CERTIFIED" || status === "OWNER_CONFIRMED";
}

export const REVIEW_SELLER_KEY = "review";
export const UNKNOWN_SELLER_KEY = "unknown";

/**
 * The bucket an employee-sensitive aggregation must use. A proven sale goes to
 * its seller; an unproven one goes to a visible review bucket instead of a
 * person, so the rows still sum to the KPI total without crediting anybody.
 */
export function scorecardSellerKey(row: {
  salesManagerId?: string | null;
  sellerCertification?: SellerCertification;
}) {
  if (countsForScorecard(row.sellerCertification)) return row.salesManagerId || UNKNOWN_SELLER_KEY;
  return row.sellerCertification === "REVIEW_REQUIRED" ? REVIEW_SELLER_KEY : UNKNOWN_SELLER_KEY;
}

export const SELLER_BUCKET_LABELS: Record<string, string> = {
  [REVIEW_SELLER_KEY]: "Tekshiruv kerak (tasdiqlanmagan)",
  [UNKNOWN_SELLER_KEY]: "Aniqlanmagan",
};

/**
 * Certification for a STORED record that predates version 13 and therefore
 * carries no certification of its own. Only the attribution source survives on
 * such a record, so the corroboration the builder does (comparing a frozen
 * snapshot against the configured field on the raw Deal) is impossible here:
 * a legacy CUSTOM_FIELD value cannot be told apart from the ASSIGNED_BY_ID
 * values that era mislabelled as one, so it goes to review rather than to a
 * person. A Full Sync rebuild replaces this with the builder's own decision.
 */
export function certifyStoredAttribution(row: {
  salesManagerId?: string | null;
  salesManagerAttribution?: SalesManagerAttribution;
  sellerCertification?: SellerCertification;
  sellerEvidenceReason?: string;
}): SellerCertification {
  // A stored row written while the roster still demoted the canonical field is
  // corrected here rather than by another Full Sync: the field is owner-reviewed
  // historical evidence and a departed seller keeps their sales.
  if (row.sellerEvidenceReason === "OUTSIDE_SALES_ROSTER"
    && (row.salesManagerAttribution === "SALES_OWNER_AT_WON" || row.salesManagerAttribution === "MANUAL_CONFIRMATION")
    && row.salesManagerId) {
    return row.salesManagerAttribution === "MANUAL_CONFIRMATION" ? "OWNER_CONFIRMED" : "CERTIFIED";
  }
  if (row.sellerCertification) return row.sellerCertification;
  if (!row.salesManagerId) return "UNKNOWN";
  if (row.salesManagerAttribution === "OWNER_CONFIRMED") return "OWNER_CONFIRMED";
  if (row.salesManagerAttribution === "MANUAL_CONFIRMATION") return "OWNER_CONFIRMED";
  if (row.salesManagerAttribution === "SALES_OWNER_AT_WON") return "CERTIFIED";
  if (row.salesManagerAttribution === "POST_SALE_OBSERVER") return "CERTIFIED";
  return "REVIEW_REQUIRED";
}

/**
 * Evidence strength, for the one question the snapshot writer and the backfill
 * both ask: may this attribution replace that one? Ranks are deliberately
 * coarse — an attested per-Deal fact, the canonical robot field, then everything
 * inferred — and the SQL upsert in lib/sales-snapshots.ts mirrors them.
 */
export const ATTRIBUTION_RANK: Record<string, number> = {
  OWNER_CONFIRMED: 3,
  MANUAL_CONFIRMATION: 3,
  SALES_OWNER_AT_WON: 2,
};
export function attributionRank(attribution: string | null | undefined) {
  return ATTRIBUTION_RANK[String(attribution ?? "")] ?? 1;
}
