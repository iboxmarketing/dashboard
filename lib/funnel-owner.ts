import { countsForScorecard, type SellerCertification } from "./seller-evidence";
import type { SalesManagerAttribution } from "./types";

/**
 * Who a Deal belongs to on a manager scorecard, by the Deal's own outcome.
 *
 * A production defect this module exists to fix: the manager funnel used to be
 * scoped by the *sale* seller, which is only ever resolved for WON Deals. A
 * seller with 11 proven sales therefore showed Lead 11, SQL 11, Sales 11, Not
 * Relevant 0, Sales Lost 0 and a 100% conversion — their open work, their Not
 * Relevant leads and their losses had silently left the page.
 *
 * Sale attribution and funnel ownership are different questions:
 *
 *   WON, or sitting in the paired post-sale funnel
 *     → the certified sale seller (Sales Owner at Won). After a sale the card
 *       belongs to onboarding/support, so the current Responsible person is
 *       never used here, whatever the Deal's category says.
 *
 *   still open in Sales, ordinary Sales Lost, Not Relevant
 *     → the current Responsible person, and ONLY when they are on the
 *       owner-approved Sales roster. That is live operational ownership: it is
 *       who is working the lead now, which is exactly what a manager funnel is
 *       supposed to measure.
 *
 *   anybody else — an operator, customer care, an unproven sale
 *     → REVIEW_REQUIRED. Visible in its own bucket, credited to nobody.
 *
 * `Sales Owner at Won` therefore decides sales and revenue only; it can never
 * make Not Relevant or Sales Lost disappear from a scorecard.
 */

export type FunnelOwnerBasis =
  | "SALES_OWNER_AT_WON"
  | "CURRENT_RESPONSIBLE_IN_ROSTER"
  /** A sale naming somebody the evidence does not prove: a human decides. */
  | "REVIEW_REQUIRED_UNPROVEN_SALE"
  /** A sale naming nobody at all — nothing to review yet. */
  | "REVIEW_REQUIRED_NO_SELLER"
  | "REVIEW_REQUIRED_NON_ROSTER_RESPONSIBLE"
  | "REVIEW_REQUIRED_NO_RESPONSIBLE";

export type FunnelOwner = {
  ownerId: string | null;
  ownerName: string | null;
  basis: FunnelOwnerBasis;
  /** True when nobody may be credited or blamed for this Deal. */
  review: boolean;
};

export type FunnelOwnerRow = {
  salesStatus?: string;
  categoryId?: string;
  assignedManagerId?: string | null;
  assignedManager?: string | null;
  salesManagerId?: string | null;
  salesManager?: string | null;
  salesManagerAttribution?: SalesManagerAttribution;
  sellerCertification?: SellerCertification;
};

export type FunnelOwnerContext = {
  /** Resolved approved-roster user IDs (lib/seller-roster.ts), never names. */
  roster?: ReadonlySet<string>;
  /** The paired post-sale funnel ids: a Deal there is past the sale. */
  postSaleCategoryIds?: ReadonlySet<string>;
};

/**
 * Grouping asks only "is there an id at all" — deliberately NOT a numeric Bitrix
 * id test. Whether a person may be credited is decided by certification and by
 * roster membership, both of which compare real ids; re-validating the shape here
 * would silently drop a manager whose id does not look the way we expect.
 */
const id = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

export function resolveFunnelOwner(row: FunnelOwnerRow, context: FunnelOwnerContext = {}): FunnelOwner {
  const postSale = context.postSaleCategoryIds?.has(String(row.categoryId ?? "")) ?? false;
  const sale = row.salesStatus === "WON" || postSale;
  const review = (basis: FunnelOwnerBasis): FunnelOwner => ({ ownerId: null, ownerName: null, basis, review: true });

  if (sale) {
    // Only a proven sale reaches a person. An uncertified one keeps its seller
    // visible on the Deal but counts for nobody.
    if (countsForScorecard(row.sellerCertification) && id(row.salesManagerId)) {
      return { ownerId: id(row.salesManagerId), ownerName: row.salesManager ?? null, basis: "SALES_OWNER_AT_WON", review: false };
    }
    return review(id(row.salesManagerId) ? "REVIEW_REQUIRED_UNPROVEN_SALE" : "REVIEW_REQUIRED_NO_SELLER");
  }

  const responsible = id(row.assignedManagerId);
  if (!responsible) return review("REVIEW_REQUIRED_NO_RESPONSIBLE");
  // An empty roster means "no roster configured": operational ownership is then
  // the best evidence available, and flagging every Deal would hide the funnel.
  if (!context.roster?.size || context.roster.has(responsible)) {
    return { ownerId: responsible, ownerName: row.assignedManager ?? null, basis: "CURRENT_RESPONSIBLE_IN_ROSTER", review: false };
  }
  return review("REVIEW_REQUIRED_NON_ROSTER_RESPONSIBLE");
}

export const FUNNEL_REVIEW_KEY = "review";
export const FUNNEL_UNKNOWN_KEY = "unknown";

/**
 * The grouping key every employee-sensitive aggregation must use.
 *
 * A prepared record carries `funnelOwnerId` / `funnelOwnerBasis` (set once on the
 * read side); this falls back to resolving them so a caller with raw rows still
 * gets the same answer.
 */
export function funnelOwnerKey(
  row: FunnelOwnerRow & { funnelOwnerId?: string | null; funnelOwnerBasis?: FunnelOwnerBasis },
  context: FunnelOwnerContext = {},
) {
  if (row.funnelOwnerBasis) return row.funnelOwnerId || reviewKeyFor(row.funnelOwnerBasis);
  const owner = resolveFunnelOwner(row, context);
  return owner.ownerId || reviewKeyFor(owner.basis);
}

/** Nothing named at all is "unknown"; a named person we cannot prove is "review". */
function reviewKeyFor(basis: FunnelOwnerBasis) {
  return basis === "REVIEW_REQUIRED_NO_RESPONSIBLE" || basis === "REVIEW_REQUIRED_NO_SELLER"
    ? FUNNEL_UNKNOWN_KEY
    : FUNNEL_REVIEW_KEY;
}

export const FUNNEL_OWNER_LABELS: Record<string, string> = {
  [FUNNEL_REVIEW_KEY]: "Tekshiruv kerak (tasdiqlanmagan)",
  [FUNNEL_UNKNOWN_KEY]: "Aniqlanmagan",
};

export const FUNNEL_BASIS_LABELS: Record<FunnelOwnerBasis, string> = {
  SALES_OWNER_AT_WON: "Sales Owner at Won (sotuv)",
  CURRENT_RESPONSIBLE_IN_ROSTER: "Joriy mas’ul (Sales ro‘yxatida)",
  REVIEW_REQUIRED_UNPROVEN_SALE: "Sotuv dalili tasdiqlanmagan",
  REVIEW_REQUIRED_NO_SELLER: "Sotuvchi ko‘rsatilmagan",
  REVIEW_REQUIRED_NON_ROSTER_RESPONSIBLE: "Joriy mas’ul Sales ro‘yxatida emas",
  REVIEW_REQUIRED_NO_RESPONSIBLE: "Mas’ul yo‘q",
};

/** Coverage diagnostics: how each attributed Deal earned its owner. */
export function funnelOwnerBreakdown(rows: { funnelOwnerBasis?: FunnelOwnerBasis }[]) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const basis = row.funnelOwnerBasis ?? "REVIEW_REQUIRED_NO_RESPONSIBLE";
    counts[basis] = (counts[basis] ?? 0) + 1;
  }
  return counts;
}
