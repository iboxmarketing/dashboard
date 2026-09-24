import { isRejectedSellerField } from "./stable-seller-field";
import type { SellerCertification, SellerEvidenceReason } from "./seller-evidence";

/**
 * One-time legacy backfill classifier for the canonical Sales Owner at Won field.
 *
 * Read-first by construction: this module decides nothing about Bitrix, it only
 * answers "does this old sale already carry proof of who sold it?". A verdict of
 * SAFE_TO_BACKFILL means the existing evidence is deterministic under the seller
 * rules the owner already approved (lib/seller-evidence.ts) — an attested
 * per-Deal fact, or a certification this build produced from CRM evidence.
 *
 * Deliberately NOT deterministic, and therefore never written automatically:
 *
 *   - a legacy CUSTOM_FIELD value with no configured seller field behind it
 *     (that era mislabelled `ASSIGNED_BY_ID` values as a custom field),
 *   - FIRST_CALL alone, STAGE_MOVER alone, the current assignee,
 *   - anything derived from a job title,
 *   - `UF_CRM_1740741551` "Первый sales", which is rejected outright.
 *
 * Those become REVIEW_REQUIRED or UNKNOWN and wait for a human in the dashboard
 * review queue. Nothing here guesses.
 */

export type BackfillVerdict =
  | "ALREADY_SET"
  | "OWNER_CONFIRMED"
  | "SAFE_TO_BACKFILL"
  | "REVIEW_REQUIRED"
  | "UNKNOWN"
  | "NOT_ELIGIBLE";

/** Certification reasons that prove a seller without a human in the loop. */
export const DETERMINISTIC_REASONS: readonly SellerEvidenceReason[] = [
  "OWNER_REGISTRY",
  "MANUAL_OWNER_CONFIRMATION",
  "OBSERVER_HANDOFF",
  "CONFIGURED_SELLER_FIELD",
  "SNAPSHOT_CORROBORATED_BY_FIELD",
];

export type BackfillRow = {
  dealId: string;
  title?: string | null;
  wonAt?: string | null;
  opportunity?: number;
  salesStatus?: string;
  projectLeadMembership?: string | null;
  currentScope?: string | null;
  salesManagerId?: string | null;
  salesManager?: string | null;
  salesManagerAttribution?: string | null;
  sellerCertification?: SellerCertification | null;
  sellerEvidenceReason?: string | null;
  salesOwnerAtWonId?: string | null;
  assignedManagerId?: string | null;
  movedById?: string | null;
  postSaleObserverId?: string | null;
  observerIds?: string[];
};

export type BackfillDecision = {
  dealId: string;
  verdict: BackfillVerdict;
  reason: string;
  /** The seller a write would carry. Null whenever nothing may be written. */
  sellerId: string | null;
  sellerName: string | null;
  evidenceType: string | null;
  /** Everything the record said before, kept for the local audit trail. */
  priorEvidence: {
    attribution: string | null;
    certification: string | null;
    certificationReason: string | null;
    sellerId: string | null;
    assignedManagerId: string | null;
    movedById: string | null;
    postSaleObserverId: string | null;
  };
};

const EMPLOYEE_ID = /^[1-9]\d*$/;
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

export type BackfillContext = {
  /** Deal ids with an attested seller: the reviewed registry plus stored confirmations. */
  attested?: ReadonlyMap<string, { sellerId: string; sellerName: string | null }>;
  /** The configured seller field, only to refuse a rejected one outright. */
  configuredSellerField?: string | null;
};

export function classifyBackfill(row: BackfillRow, context: BackfillContext = {}): BackfillDecision {
  const priorEvidence = {
    attribution: row.salesManagerAttribution ?? null,
    certification: row.sellerCertification ?? null,
    certificationReason: row.sellerEvidenceReason ?? null,
    sellerId: row.salesManagerId ?? null,
    assignedManagerId: row.assignedManagerId ?? null,
    movedById: row.movedById ?? null,
    postSaleObserverId: row.postSaleObserverId ?? null,
  };
  const decision = (verdict: BackfillVerdict, reason: string, sellerId: string | null = null, evidenceType: string | null = null): BackfillDecision => ({
    dealId: row.dealId, verdict, reason, sellerId,
    sellerName: sellerId && sellerId === text(row.salesManagerId) ? row.salesManager ?? null : sellerId ? context.attested?.get(row.dealId)?.sellerName ?? null : null,
    evidenceType, priorEvidence,
  });

  // A Deal Bitrix no longer serves, or one that belongs to another project, is
  // not this project's sale and cannot be written to.
  if (row.currentScope === "DELETED" || row.currentScope === "UNAVAILABLE") return decision("NOT_ELIGIBLE", `DEAL_${row.currentScope}`);
  if (row.projectLeadMembership === "EXCLUDED") return decision("NOT_ELIGIBLE", "EXCLUDED_OTHER_PROJECT");
  if (row.salesStatus !== "WON" || !row.wonAt) return decision("NOT_ELIGIBLE", "NOT_A_SALE");

  // Already captured — by the robot on a new sale, or by an earlier backfill.
  const existing = text(row.salesOwnerAtWonId);
  if (existing && EMPLOYEE_ID.test(existing)) return decision("ALREADY_SET", "FIELD_ALREADY_POPULATED", existing, "SALES_OWNER_AT_WON");

  const attested = context.attested?.get(row.dealId);
  if (attested && EMPLOYEE_ID.test(text(attested.sellerId))) {
    return { ...decision("OWNER_CONFIRMED", "ATTESTED_PER_DEAL_FACT", text(attested.sellerId), "OWNER_CONFIRMED"), sellerName: attested.sellerName ?? null };
  }

  const sellerId = text(row.salesManagerId);
  if (!sellerId || !EMPLOYEE_ID.test(sellerId)) return decision("UNKNOWN", "NO_SELLER_ON_RECORD");
  if (isRejectedSellerField(context.configuredSellerField)) return decision("REVIEW_REQUIRED", "REJECTED_SELLER_FIELD_CONFIGURED", null);

  const certification = row.sellerCertification ?? null;
  const reason = (row.sellerEvidenceReason ?? "") as SellerEvidenceReason;
  if (certification === "OWNER_CONFIRMED") return decision("OWNER_CONFIRMED", reason || "OWNER_CONFIRMED", sellerId, reason || "OWNER_CONFIRMED");
  if (certification === "CERTIFIED" && DETERMINISTIC_REASONS.includes(reason)) {
    return decision("SAFE_TO_BACKFILL", reason, sellerId, reason);
  }
  if (certification === "CERTIFIED") return decision("REVIEW_REQUIRED", `CERTIFIED_BUT_NOT_DETERMINISTIC_${reason || "NO_REASON"}`);
  if (certification === "UNKNOWN") return decision("UNKNOWN", reason || "UNKNOWN_SELLER");
  return decision("REVIEW_REQUIRED", reason || "UNCERTIFIED_EVIDENCE");
}

export type BackfillSummary = {
  eligible: number;
  notEligible: number;
  alreadySet: number;
  ownerConfirmed: number;
  safeToBackfill: number;
  reviewRequired: number;
  unknown: number;
  writable: number;
  reasons: [string, number][];
};

/** A verdict that may be written to Bitrix: an attested fact or proven evidence. */
export function isWritable(decision: BackfillDecision) {
  return (decision.verdict === "OWNER_CONFIRMED" || decision.verdict === "SAFE_TO_BACKFILL") && Boolean(decision.sellerId);
}

export function summarizeBackfill(decisions: BackfillDecision[]): BackfillSummary {
  const count = (verdict: BackfillVerdict) => decisions.filter((entry) => entry.verdict === verdict).length;
  const reasons = new Map<string, number>();
  for (const entry of decisions) reasons.set(`${entry.verdict}/${entry.reason}`, (reasons.get(`${entry.verdict}/${entry.reason}`) ?? 0) + 1);
  return {
    eligible: decisions.filter((entry) => entry.verdict !== "NOT_ELIGIBLE").length,
    notEligible: count("NOT_ELIGIBLE"),
    alreadySet: count("ALREADY_SET"),
    ownerConfirmed: count("OWNER_CONFIRMED"),
    safeToBackfill: count("SAFE_TO_BACKFILL"),
    reviewRequired: count("REVIEW_REQUIRED"),
    unknown: count("UNKNOWN"),
    writable: decisions.filter(isWritable).length,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
  };
}
