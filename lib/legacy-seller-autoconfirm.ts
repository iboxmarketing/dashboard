/**
 * Legacy Sales Owner auto-confirmation.
 *
 * One-time rule for old WON Deals whose canonical `Sales Owner at Won` field is
 * still empty. Future sales are handled by the Bitrix robot; this exists only to
 * close out history, and only where the CRM already answers the question without
 * anybody guessing.
 *
 * The evidence is the observer list, intersected with the owner-approved Sales
 * roster resolved to user IDs (`lib/seller-roster.ts`):
 *
 *   RULE 1  the field is already populated → never overwritten. Certified when
 *           the named user is on the roster, otherwise sent to review.
 *   RULE 2  exactly one roster member among the observers → that person sold it.
 *           Two or more → review; an owner-confirmed former seller among the
 *           observers counts as one of them. Observers but none on the roster →
 *           review; an observer outside the roster is never used.
 *   RULE 3  ONLY when the observer list is empty may the current Responsible be
 *           used, and only when they are on the roster. Otherwise review.
 *   RULE 4  order never decides anything: the candidate set is a set.
 *   OWNER   a git-reviewed owner confirmation for the Deal (lib/seller-overrides.ts)
 *           names the seller outright — still only into an EMPTY field (Rule 1
 *           runs first).
 *
 * An owner-confirmed alias (an old account of a current seller) is read as that
 * seller everywhere here; the raw observer ids stay in the decision for audit.
 *
 * Nothing here consults MOVED_BY_ID, FIRST_CALL, a legacy custom field,
 * `UF_CRM_1740741551`, or a job title.
 */

export type LegacySellerStatus =
  | "CERTIFIED_EXISTING_FIELD"
  | "REVIEW_REQUIRED_NON_SALES_OWNER"
  | "AUTO_CONFIRM_OBSERVER"
  | "AUTO_CONFIRM_OWNER_CONFIRMED"
  | "REVIEW_REQUIRED_MULTIPLE_SELLERS"
  | "REVIEW_REQUIRED_NO_SELLER_OBSERVER"
  | "AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER"
  | "REVIEW_REQUIRED_NON_SALES_RESPONSIBLE"
  | "NOT_ELIGIBLE";

export type LegacySellerRule = "RULE_1_EXISTING_FIELD" | "OWNER_CONFIRMED" | "RULE_2_OBSERVER" | "RULE_3_NO_OBSERVER_RESPONSIBLE" | "NONE";

export type LegacySellerRow = {
  dealId: string;
  title?: string | null;
  wonAt?: string | null;
  opportunity?: number;
  currencyId?: string;
  salesStatus?: string;
  projectLeadMembership?: string | null;
  currentScope?: string | null;
  assignedManagerId?: string | null;
  observerIds?: string[];
  salesOwnerAtWonId?: string | null;
  /** The Deal's current category — needed for a project that limits Rule 3 by funnel. */
  categoryId?: string | null;
};

export type LegacySellerDecision = {
  dealId: string;
  status: LegacySellerStatus;
  rule: LegacySellerRule;
  reason: string;
  /** The seller a write would carry. Null whenever nothing may be written. */
  chosenSellerId: string | null;
  existingOwnerId: string | null;
  observerIds: string[];
  sellerObserverCandidates: string[];
  assignedManagerId: string | null;
  /** True when a human must look at this Deal. */
  needsManualReview: boolean;
  /** Set when the chosen or current person is outside the approved roster. */
  outsideRoster: string[];
};

const VALID_ID = /^[1-9]\d*$/u;
const id = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return VALID_ID.test(text) ? text : "";
};

export type LegacySellerContext = {
  /** Resolved roster user IDs — never names. */
  approvedSellerIds: ReadonlySet<string>;
  /**
   * When set, Rule 3 may credit the current Responsible only while the Deal sits
   * in one of these (Sales) categories. Sales Doctor sets it to its Sales funnel:
   * after the transfer to category 17 the Responsible is onboarding, never the
   * historical seller (owner rule, 2026-10-01). IBOX leaves it unset, keeping its
   * accepted Rule 3 exactly as it was.
   */
  responsibleCategoryIds?: ReadonlySet<string>;
  /** Old account → current account of the same seller (owner-confirmed). */
  aliases?: Readonly<Record<string, string>>;
  /** Owner-confirmed former sellers: a valid existing field value, never a roster member. */
  historicalSellerIds?: ReadonlySet<string>;
  /** Deal id → seller id from the git-reviewed owner registry. */
  ownerConfirmed?: ReadonlyMap<string, string>;
};

export function classifyLegacySalesOwner(row: LegacySellerRow, context: LegacySellerContext): LegacySellerDecision {
  const approved = context.approvedSellerIds;
  const canonical = (value: string) => context.aliases?.[value] ?? value;
  const observerIds = [...new Set((row.observerIds ?? []).map(id).filter(Boolean))];
  const assignedManagerId = id(row.assignedManagerId) || null;
  const existingOwnerId = id(row.salesOwnerAtWonId) || null;
  // Candidates are people, not accounts: two accounts of one seller are one
  // candidate. A former seller is a candidate too — never credited from an
  // observer list alone, but enough to make a roster observer ambiguous.
  const historical = context.historicalSellerIds ?? new Set<string>();
  const sellerObserverCandidates = [...new Set(observerIds.map(canonical)
    .filter((observerId) => approved.has(observerId) || historical.has(observerId)))];
  const ownerSellerId = context.ownerConfirmed?.get(row.dealId) ?? null;
  const base = {
    dealId: row.dealId, existingOwnerId, observerIds, sellerObserverCandidates, assignedManagerId,
  };
  const decide = (
    status: LegacySellerStatus, rule: LegacySellerRule, reason: string,
    chosenSellerId: string | null, outsideRoster: string[] = [],
  ): LegacySellerDecision => ({
    ...base, status, rule, reason, chosenSellerId,
    needsManualReview: status.startsWith("REVIEW_REQUIRED"),
    outsideRoster: [...new Set(outsideRoster.filter(Boolean))],
  });

  // Not this project's sale, or a sale Bitrix no longer serves: out of scope.
  if (row.currentScope === "DELETED" || row.currentScope === "UNAVAILABLE") return decide("NOT_ELIGIBLE", "NONE", `DEAL_${row.currentScope}`, null);
  if (row.projectLeadMembership === "EXCLUDED") return decide("NOT_ELIGIBLE", "NONE", "EXCLUDED_OTHER_PROJECT", null);
  if (row.salesStatus !== "WON" || !row.wonAt) return decide("NOT_ELIGIBLE", "NONE", "NOT_A_SALE", null);

  // RULE 1 — an existing value is evidence the robot or a human already captured.
  if (existingOwnerId) {
    const holder = canonical(existingOwnerId);
    return approved.has(holder) || context.historicalSellerIds?.has(holder) || holder === ownerSellerId
      ? decide("CERTIFIED_EXISTING_FIELD", "RULE_1_EXISTING_FIELD", "FIELD_HOLDS_APPROVED_SELLER", existingOwnerId)
      : decide("REVIEW_REQUIRED_NON_SALES_OWNER", "RULE_1_EXISTING_FIELD", "FIELD_HOLDS_NON_ROSTER_USER", null, [existingOwnerId]);
  }

  // OWNER — an attested per-Deal fact outranks every CRM inference.
  if (ownerSellerId) {
    return decide("AUTO_CONFIRM_OWNER_CONFIRMED", "OWNER_CONFIRMED", "OWNER_CONFIRMED_SELLER", ownerSellerId);
  }
  // RULE 2 — the observer list, intersected with the roster. Order is irrelevant.
  if (observerIds.length) {
    if (sellerObserverCandidates.length === 1 && approved.has(sellerObserverCandidates[0])) {
      return decide("AUTO_CONFIRM_OBSERVER", "RULE_2_OBSERVER", "SINGLE_ROSTER_OBSERVER", sellerObserverCandidates[0]);
    }
    if (sellerObserverCandidates.length === 1) {
      return decide("REVIEW_REQUIRED_NO_SELLER_OBSERVER", "RULE_2_OBSERVER", "HISTORICAL_SELLER_NEEDS_OWNER", null, sellerObserverCandidates);
    }
    if (sellerObserverCandidates.length > 1) {
      return decide("REVIEW_REQUIRED_MULTIPLE_SELLERS", "RULE_2_OBSERVER", "MULTIPLE_ROSTER_OBSERVERS", null);
    }
    return decide("REVIEW_REQUIRED_NO_SELLER_OBSERVER", "RULE_2_OBSERVER", "OBSERVERS_OUTSIDE_ROSTER", null, observerIds);
  }

  // RULE 3 — allowed only because there is no observer at all, and — where the
  // project says so — only while the Deal has not left the Sales funnel.
  const handedOff = Boolean(context.responsibleCategoryIds) && !context.responsibleCategoryIds!.has(String(row.categoryId ?? ""));
  if (assignedManagerId && handedOff) {
    return decide("REVIEW_REQUIRED_NON_SALES_RESPONSIBLE", "RULE_3_NO_OBSERVER_RESPONSIBLE", "NO_OBSERVER_RESPONSIBLE_AFTER_HANDOFF", null, [assignedManagerId]);
  }
  if (assignedManagerId && approved.has(canonical(assignedManagerId))) {
    return decide("AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER", "RULE_3_NO_OBSERVER_RESPONSIBLE", "NO_OBSERVER_ROSTER_RESPONSIBLE", canonical(assignedManagerId));
  }
  return decide("REVIEW_REQUIRED_NON_SALES_RESPONSIBLE", "RULE_3_NO_OBSERVER_RESPONSIBLE",
    assignedManagerId ? "NO_OBSERVER_NON_ROSTER_RESPONSIBLE" : "NO_OBSERVER_NO_RESPONSIBLE", null,
    assignedManagerId ? [assignedManagerId] : []);
}

export function isAutoConfirm(decision: LegacySellerDecision) {
  return (decision.status === "AUTO_CONFIRM_OBSERVER" || decision.status === "AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER"
    || decision.status === "AUTO_CONFIRM_OWNER_CONFIRMED")
    && Boolean(decision.chosenSellerId);
}

export type LegacySellerSummary = {
  eligible: number;
  notEligible: number;
  emptyField: number;
  alreadyPopulated: number;
  certifiedExistingField: number;
  existingFieldNonSalesOwner: number;
  autoConfirmObserver: number;
  autoConfirmOwnerConfirmed: number;
  autoConfirmCurrentResponsibleNoObserver: number;
  multipleSalesObservers: number;
  observerButNoSalesperson: number;
  noObserverNonSalesResponsible: number;
  autoConfirmTotal: number;
  manualReviewTotal: number;
};

export function summarizeLegacySalesOwners(decisions: LegacySellerDecision[]): LegacySellerSummary {
  const count = (status: LegacySellerStatus) => decisions.filter((entry) => entry.status === status).length;
  const eligible = decisions.filter((entry) => entry.status !== "NOT_ELIGIBLE");
  const alreadyPopulated = count("CERTIFIED_EXISTING_FIELD") + count("REVIEW_REQUIRED_NON_SALES_OWNER");
  return {
    eligible: eligible.length,
    notEligible: count("NOT_ELIGIBLE"),
    emptyField: eligible.length - alreadyPopulated,
    alreadyPopulated,
    certifiedExistingField: count("CERTIFIED_EXISTING_FIELD"),
    existingFieldNonSalesOwner: count("REVIEW_REQUIRED_NON_SALES_OWNER"),
    autoConfirmObserver: count("AUTO_CONFIRM_OBSERVER"),
    autoConfirmOwnerConfirmed: count("AUTO_CONFIRM_OWNER_CONFIRMED"),
    autoConfirmCurrentResponsibleNoObserver: count("AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER"),
    multipleSalesObservers: count("REVIEW_REQUIRED_MULTIPLE_SELLERS"),
    observerButNoSalesperson: count("REVIEW_REQUIRED_NO_SELLER_OBSERVER"),
    noObserverNonSalesResponsible: count("REVIEW_REQUIRED_NON_SALES_RESPONSIBLE"),
    autoConfirmTotal: decisions.filter(isAutoConfirm).length,
    manualReviewTotal: decisions.filter((entry) => entry.needsManualReview).length,
  };
}

/**
 * Whether a live re-read still supports the classification (RULE 5).
 *
 * The same classifier is re-run against what Bitrix says right now, so a Deal
 * whose observers, Responsible person or field changed since the dry-run is
 * skipped rather than written.
 */
export function evidenceStillHolds(planned: LegacySellerDecision, live: LegacySellerDecision) {
  if (live.existingOwnerId) return { ok: false as const, reason: "SKIP_ALREADY_SET" };
  if (live.status !== planned.status) return { ok: false as const, reason: `SKIP_STATUS_CHANGED_${live.status}` };
  if (live.chosenSellerId !== planned.chosenSellerId) return { ok: false as const, reason: "SKIP_SELLER_CHANGED" };
  if (live.observerIds.join(",") !== planned.observerIds.join(",")) return { ok: false as const, reason: "SKIP_OBSERVERS_CHANGED" };
  if (live.assignedManagerId !== planned.assignedManagerId) return { ok: false as const, reason: "SKIP_RESPONSIBLE_CHANGED" };
  return { ok: true as const, reason: "EVIDENCE_UNCHANGED" };
}
