import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import {
  classifyLegacySalesOwner, evidenceStillHolds, isAutoConfirm, summarizeLegacySalesOwners,
  type LegacySellerRow,
} from "../lib/legacy-seller-autoconfirm";
import { FUNNEL_REVIEW_KEY, FUNNEL_UNKNOWN_KEY, funnelOwnerKey, resolveFunnelOwner } from "../lib/funnel-owner";
import { buildManagers, prepareSalesRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import { defaultSettings } from "../lib/business-time";
import {
  OWNER_APPROVED_SELLER_NAMES, directoryUsers, normalizeRosterName, resolveRoster, withinOneEdit,
} from "../lib/seller-roster";
import { writeSalesOwnerAtWon } from "../lib/seller-writeback";
import { SALES_OWNER_AT_WON_FIELD } from "../lib/stable-seller-field";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/**
 * Legacy Sales Owner auto-confirmation, and the funnel-ownership correction.
 *
 * The roster is resolved to user IDs once; every rule below compares IDs. An
 * observer outside the roster is never a seller, two roster observers are never
 * guessed between, and the current Responsible person is usable only when there
 * is no observer at all.
 */

/* --------------------------------------------------------------- the roster */

const DIRECTORY = directoryUsers([
  { ID: "17", NAME: "Po'latxon", LAST_NAME: "Ashuraliyev", ACTIVE: "1" },
  { ID: "25", NAME: "Abdulaziz", LAST_NAME: "Abdurahmonov", ACTIVE: "1" },
  { ID: "35", NAME: "Hoshimxon", LAST_NAME: "Ashuraliyev", ACTIVE: "1" },
  { ID: "95", NAME: "Muhamadrasul", LAST_NAME: "Dadaxonov", ACTIVE: "1" },
  { ID: "207", NAME: "Soxib", LAST_NAME: "Bazaraliyev", ACTIVE: "1" },
  { ID: "239", NAME: "Sardor", LAST_NAME: "Juraev", ACTIVE: "1" },
  { ID: "561", NAME: "Abdulloh", LAST_NAME: "Tolanov", ACTIVE: "1" },
  { ID: "1911", NAME: "Rahmatullo", LAST_NAME: "Orifjonov", ACTIVE: "1" },
  { ID: "4151", NAME: "Sanjar", LAST_NAME: "Juraev", ACTIVE: "1" },
  { ID: "7893", NAME: "Jamoliddin", LAST_NAME: "Kamarov", ACTIVE: "1" },
  { ID: "13059", NAME: "Rahmatulloh", LAST_NAME: "Ahmadjonov", ACTIVE: "1" },
  { ID: "12961", NAME: "Operator", LAST_NAME: "One", ACTIVE: "1" },
  { ID: "13061", NAME: "Customer", LAST_NAME: "Care", ACTIVE: "1" },
]);
const ROSTER = resolveRoster(OWNER_APPROVED_SELLER_NAMES, DIRECTORY);
const APPROVED = ROSTER.approvedSellerIds;

const SELLER = "1911";          // Rahmatullo Orifjonov
const SECOND_SELLER = "207";    // Soxib Bazaraliyev
const OPERATOR = "12961";       // not on the roster
const CARE = "13061";           // not on the roster

test("10. the roster resolves owner names to user IDs, and ambiguity is never guessed", () => {
  assert.equal(ROSTER.needsReview.length, 0, "every owner-provided name resolves");
  assert.deepEqual(
    ROSTER.entries.map((entry) => `${entry.providedName}=${entry.userId}`),
    [
      "Abdulaziz Abdurahmonov=25", "Soxib Bazaraliyev=207", "Abdulloh Tolanov=561",
      "Rahmatullo Orifjonov=1911", "Po'latxon Ashuraliyev=17", "Jamoliddin Kamarov=7893",
      "Sanjar Juraev=4151", "Rahmatulloh Ahmadjonov=13059", "Muhamadrasul Dadaxonov=95",
    ],
  );
  // Similar names must not collide: same surname, different person; same first
  // name, different surname; one letter apart.
  assert.equal(ROSTER.entries.find((entry) => entry.userId === "17")?.canonicalName, "Po'latxon Ashuraliyev");
  assert.equal(ROSTER.approvedSellerIds.has("35"), false, "Hoshimxon Ashuraliyev is not on the roster");
  assert.equal(ROSTER.approvedSellerIds.has("239"), false, "Sardor Juraev is not Sanjar Juraev");
  assert.ok(withinOneEdit("rahmatullo", "rahmatulloh"));
  assert.equal(withinOneEdit("sanjar", "sardor"), false);

  // Spelling and capitalisation variants of the same person still resolve.
  for (const variant of ["po'latxon ashuraliyev", "Poʻlatxon  Ashuraliyev", "ASHURALIYEV Po'latxon", "Polatxon Ashuraliyev"]) {
    const entry = resolveRoster([variant], DIRECTORY).entries[0];
    assert.equal(entry.status, "RESOLVED", variant);
    assert.equal(entry.userId, "17", variant);
  }
  assert.equal(normalizeRosterName("ASHURALIYEV Po'latxon"), normalizeRosterName("po‘latxon ashuraliyev"));

  // A name matching two different users is review, never a coin toss.
  const twins = directoryUsers([
    { ID: "501", NAME: "Sanjar", LAST_NAME: "Juraev", ACTIVE: "1" },
    { ID: "502", NAME: "Sanjar", LAST_NAME: "Juraev", ACTIVE: "1" },
  ]);
  const ambiguous = resolveRoster(["Sanjar Juraev"], twins).entries[0];
  assert.equal(ambiguous.status, "ROSTER_MAPPING_REVIEW");
  assert.equal(ambiguous.userId, null);
  assert.equal(resolveRoster(["Sanjar Juraev"], twins).approvedSellerIds.size, 0);
  assert.equal(resolveRoster(["Nobody Here"], DIRECTORY).entries[0].status, "NOT_FOUND");
});

/* ------------------------------------------------------------- rules 1 to 4 */

const legacy = (over: Partial<LegacySellerRow> = {}): LegacySellerRow => ({
  dealId: "900", title: "Sale", wonAt: "2026-09-10T04:00:00.000Z", opportunity: 1_000, currencyId: "UZS",
  salesStatus: "WON", projectLeadMembership: "INCLUDED", currentScope: null,
  assignedManagerId: OPERATOR, observerIds: [], salesOwnerAtWonId: null, ...over,
});
const classify = (over: Partial<LegacySellerRow> = {}) => classifyLegacySalesOwner(legacy(over), { approvedSellerIds: APPROVED });

test("1. one observer who is on the roster is auto-confirmed", () => {
  const decision = classify({ observerIds: [SELLER] });
  assert.equal(decision.status, "AUTO_CONFIRM_OBSERVER");
  assert.equal(decision.rule, "RULE_2_OBSERVER");
  assert.equal(decision.chosenSellerId, SELLER);
  assert.equal(decision.needsManualReview, false);
  assert.ok(isAutoConfirm(decision));
});

test("2. one observer who is an operator is never used", () => {
  const decision = classify({ observerIds: [CARE] });
  assert.equal(decision.status, "REVIEW_REQUIRED_NO_SELLER_OBSERVER");
  assert.equal(decision.chosenSellerId, null);
  assert.deepEqual(decision.outsideRoster, [CARE]);
  assert.ok(decision.needsManualReview);
  assert.equal(isAutoConfirm(decision), false);
});

test("3. a seller plus an operator resolves to the seller", () => {
  const decision = classify({ observerIds: [OPERATOR, SELLER, CARE] });
  assert.equal(decision.status, "AUTO_CONFIRM_OBSERVER");
  assert.equal(decision.chosenSellerId, SELLER);
  assert.deepEqual(decision.sellerObserverCandidates, [SELLER]);
  // Order must never decide: the reversed list gives the same answer.
  assert.equal(classify({ observerIds: [CARE, SELLER, OPERATOR] }).chosenSellerId, SELLER);
});

test("4. two roster observers go to manual review, in either order", () => {
  for (const observers of [[SELLER, SECOND_SELLER], [SECOND_SELLER, SELLER], [OPERATOR, SELLER, SECOND_SELLER]]) {
    const decision = classify({ observerIds: observers });
    assert.equal(decision.status, "REVIEW_REQUIRED_MULTIPLE_SELLERS", observers.join(","));
    assert.equal(decision.chosenSellerId, null);
    assert.equal(decision.sellerObserverCandidates.length, 2);
  }
});

test("5. no observers and a roster Responsible person is auto-confirmed", () => {
  const decision = classify({ observerIds: [], assignedManagerId: SELLER });
  assert.equal(decision.status, "AUTO_CONFIRM_CURRENT_RESPONSIBLE_NO_OBSERVER");
  assert.equal(decision.rule, "RULE_3_NO_OBSERVER_RESPONSIBLE");
  assert.equal(decision.chosenSellerId, SELLER);
  assert.ok(isAutoConfirm(decision));
});

test("6. no observers and a non-roster Responsible person stays in review", () => {
  const operator = classify({ observerIds: [], assignedManagerId: OPERATOR });
  assert.equal(operator.status, "REVIEW_REQUIRED_NON_SALES_RESPONSIBLE");
  assert.equal(operator.chosenSellerId, null);
  assert.deepEqual(operator.outsideRoster, [OPERATOR]);
  const nobody = classify({ observerIds: [], assignedManagerId: null });
  assert.equal(nobody.status, "REVIEW_REQUIRED_NON_SALES_RESPONSIBLE");
  assert.equal(nobody.reason, "NO_OBSERVER_NO_RESPONSIBLE");
});

test("6b. the Responsible fallback is forbidden while any observer exists", () => {
  // The Responsible person is a roster seller, but an observer exists: RULE 3
  // may not be reached, so this is review rather than a free auto-confirm.
  const decision = classify({ observerIds: [CARE], assignedManagerId: SELLER });
  assert.equal(decision.status, "REVIEW_REQUIRED_NO_SELLER_OBSERVER");
  assert.equal(decision.chosenSellerId, null);
});

test("7. a field already holding a roster seller is certified, never rewritten", () => {
  const decision = classify({ salesOwnerAtWonId: SELLER, observerIds: [SECOND_SELLER] });
  assert.equal(decision.status, "CERTIFIED_EXISTING_FIELD");
  assert.equal(decision.rule, "RULE_1_EXISTING_FIELD");
  assert.equal(decision.chosenSellerId, SELLER, "the existing value stands");
  assert.equal(isAutoConfirm(decision), false, "nothing is written");
  assert.equal(decision.needsManualReview, false);
});

test("8. a field holding a non-roster user is flagged, not cleared", () => {
  const decision = classify({ salesOwnerAtWonId: OPERATOR, observerIds: [SELLER] });
  assert.equal(decision.status, "REVIEW_REQUIRED_NON_SALES_OWNER");
  assert.equal(decision.existingOwnerId, OPERATOR, "the value is reported, not erased");
  assert.equal(decision.chosenSellerId, null, "and never replaced automatically");
  assert.deepEqual(decision.outsideRoster, [OPERATOR]);
});

test("9. evidence that moved between dry-run and write is skipped", () => {
  const planned = classify({ observerIds: [SELLER] });
  assert.deepEqual(evidenceStillHolds(planned, planned), { ok: true, reason: "EVIDENCE_UNCHANGED" });
  const populated = classify({ observerIds: [SELLER], salesOwnerAtWonId: SECOND_SELLER });
  assert.deepEqual(evidenceStillHolds(planned, populated), { ok: false, reason: "SKIP_ALREADY_SET" });
  const moreObservers = classify({ observerIds: [SELLER, SECOND_SELLER] });
  assert.equal(evidenceStillHolds(planned, moreObservers).ok, false);
  assert.equal(evidenceStillHolds(planned, moreObservers).reason, "SKIP_STATUS_CHANGED_REVIEW_REQUIRED_MULTIPLE_SELLERS");
  const otherObserver = classify({ observerIds: [SECOND_SELLER] });
  assert.equal(evidenceStillHolds(planned, otherObserver).reason, "SKIP_SELLER_CHANGED");
  const responsibleMoved = classify({ observerIds: [SELLER], assignedManagerId: CARE });
  assert.equal(evidenceStillHolds(planned, responsibleMoved).reason, "SKIP_RESPONSIBLE_CHANGED");
});

test("11. a failed Bitrix write certifies nothing", async () => {
  const call = (async (method: string) => {
    if (method === "crm.deal.get") return { result: { ID: "900" } };
    throw Object.assign(new Error("denied"), { code: "ACCESS_DENIED" });
  }) as never;
  const result = await writeSalesOwnerAtWon({ dealId: "900", sellerId: SELLER, field: SALES_OWNER_AT_WON_FIELD }, { call, maxAttempts: 1 });
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "ACCESS_DENIED");
});

test("12. a repeated run writes nothing the second time", async () => {
  const calls: string[] = [];
  const call = (async (method: string) => {
    calls.push(method);
    if (method === "crm.deal.get") return { result: { ID: "900", [SALES_OWNER_AT_WON_FIELD]: SELLER } };
    return { result: true };
  }) as never;
  const result = await writeSalesOwnerAtWon({ dealId: "900", sellerId: SELLER, field: SALES_OWNER_AT_WON_FIELD }, { call, maxAttempts: 1 });
  assert.equal(result.status, "ALREADY_SET");
  assert.equal(calls.includes("crm.deal.update"), false);
  // And the classifier now reports it as an existing certified field, so it
  // leaves the auto-confirm set entirely.
  assert.equal(classify({ salesOwnerAtWonId: SELLER, observerIds: [SELLER] }).status, "CERTIFIED_EXISTING_FIELD");
});

test("a deleted, excluded or unsold Deal is never classified", () => {
  assert.equal(classify({ currentScope: "DELETED" }).status, "NOT_ELIGIBLE");
  assert.equal(classify({ projectLeadMembership: "EXCLUDED" }).status, "NOT_ELIGIBLE");
  assert.equal(classify({ salesStatus: "LOST" }).status, "NOT_ELIGIBLE");
  assert.equal(classify({ wonAt: null }).status, "NOT_ELIGIBLE");
});

test("the dry-run summary reconciles to the classified population", () => {
  const decisions = [
    classify({ observerIds: [SELLER] }),
    classify({ observerIds: [SELLER, SECOND_SELLER] }),
    classify({ observerIds: [CARE] }),
    classify({ observerIds: [], assignedManagerId: SELLER }),
    classify({ observerIds: [], assignedManagerId: OPERATOR }),
    classify({ salesOwnerAtWonId: SELLER }),
    classify({ salesOwnerAtWonId: OPERATOR }),
    classify({ currentScope: "DELETED" }),
  ];
  const summary = summarizeLegacySalesOwners(decisions);
  assert.equal(summary.eligible, 7);
  assert.equal(summary.notEligible, 1);
  assert.equal(summary.alreadyPopulated, 2);
  assert.equal(summary.emptyField, 5);
  assert.equal(summary.autoConfirmObserver, 1);
  assert.equal(summary.autoConfirmCurrentResponsibleNoObserver, 1);
  assert.equal(summary.multipleSalesObservers, 1);
  assert.equal(summary.observerButNoSalesperson, 1);
  assert.equal(summary.noObserverNonSalesResponsible, 1);
  assert.equal(summary.certifiedExistingField, 1);
  assert.equal(summary.existingFieldNonSalesOwner, 1);
  assert.equal(summary.autoConfirmTotal, 2);
  assert.equal(summary.manualReviewTotal, 4);
  assert.equal(
    summary.autoConfirmTotal + summary.manualReviewTotal + summary.certifiedExistingField,
    summary.eligible,
  );
});

/* -------------------------------------------- 13. the manager funnel itself */

const settings = (): DashboardSettings => ({
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  salesStaffIds: [...APPROVED],
});

const record = (over: Partial<DashboardRecord>): DashboardRecord => ({
  dealId: "1", title: "Deal", createdAt: "2026-09-02T09:00:00.000Z", wonAt: null, salesStatus: "ACTIVE",
  qualified: false, lossReasonGroup: "NONE", lossReason: "", opportunity: 0, currencyId: "UZS",
  categoryId: "3", originCategoryId: "3", pipeline: "IBOX Sales", originPipeline: "IBOX Sales",
  projectLeadMembership: "INCLUDED", stage: "ОБРАБОТКА", stageHistoryCount: 1,
  assignedManagerId: SELLER, assignedManager: "Rahmatullo Orifjonov",
  salesManagerId: null, salesManager: null, salesManagerAttribution: "UNKNOWN",
  processingBusinessMinutes: 10, slaStatus: "ON_TIME", source: "CRM-форма",
  ...over,
} as unknown as DashboardRecord);

const QUERY = {
  from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "",
  period: "", sla: "", processing: "", search: "",
} as SalesQuery;

test("13. the manager funnel keeps open work, Not Relevant and Sales Lost — and the KPI totals do not move", () => {
  const rows = [
    // One proven sale, attributed by the canonical field.
    record({
      dealId: "won", qualified: true, salesStatus: "WON", wonAt: "2026-09-12T09:00:00.000Z", opportunity: 500_000,
      salesManagerId: SELLER, salesManager: "Rahmatullo Orifjonov", salesManagerAttribution: "SALES_OWNER_AT_WON",
      sellerCertification: "CERTIFIED", categoryId: "13", assignedManagerId: CARE, assignedManager: "Customer Care",
    }),
    // Their open, Not Relevant and Sales Lost work: theirs by current responsibility.
    record({ dealId: "open", qualified: true }),
    record({ dealId: "nr", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING", lossReason: "Campaign" }),
    record({ dealId: "lost", qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES", lossReason: "Otsrochka" }),
    // An operator's lead may never land on a Sales scorecard.
    record({ dealId: "operator", qualified: true, assignedManagerId: OPERATOR, assignedManager: "Operator One" }),
  ];
  const prepared = prepareSalesRecords(rows, settings(), new Date("2026-09-30T00:00:00Z"));
  const populations = salesPopulations(prepared, QUERY);
  const managers = buildManagers(populations.cohort, populations.won);
  const seller = managers.find((row) => row.id === SELLER);

  assert.ok(seller, "the seller has a row");
  assert.equal(seller.periodSales, 1, "one sale");
  assert.equal(seller.revenue, 500_000);
  assert.equal(seller.leads, 4, "the sale plus their open, NR and lost work — not 1");
  assert.equal(seller.notRelevant, 1, "Not Relevant did not disappear");
  assert.equal(seller.salesLost, 1, "Sales Lost did not disappear");
  assert.equal(seller.sql, 3, "the sale, the open SQL and the loss");
  assert.notEqual(seller.sqlToSale, 100, "no automatic 100% conversion");
  assert.equal(seller.sqlToSale, 33);

  // The operator's lead is visible, credited to nobody.
  assert.equal(managers.some((row) => row.id === OPERATOR), false, "no operator row");
  const review = managers.find((row) => row.id === FUNNEL_REVIEW_KEY);
  assert.equal(review?.leads, 1, "the operator's lead sits in the review bucket");

  // Core KPI totals are decided by the funnel rules, not by attribution.
  const total = buildDashboardMetrics(populations.cohort, populations.won);
  assert.equal(total.counts.leads, 5);
  assert.equal(total.counts.period_sales, 1);
  assert.equal(total.money.revenue, 500_000);
  assert.equal(
    managers.reduce((sum, row) => sum + row.leads, 0), total.counts.leads,
    "every Lead is attributed exactly once, review bucket included",
  );
  assert.equal(managers.reduce((sum, row) => sum + row.notRelevant, 0), total.counts.not_relevant);
  assert.equal(managers.reduce((sum, row) => sum + row.salesLost, 0), total.counts.sales_lost);
  assert.equal(managers.reduce((sum, row) => sum + row.revenue, 0), total.money.revenue);
});

test("a post-sale Deal never belongs to the customer-care person holding it", () => {
  const owner = resolveFunnelOwner(
    {
      salesStatus: "ACTIVE", categoryId: "13", assignedManagerId: CARE, assignedManager: "Customer Care",
      salesManagerId: SELLER, salesManager: "Seller", sellerCertification: "CERTIFIED",
    },
    { roster: APPROVED, postSaleCategoryIds: new Set(["13"]) },
  );
  assert.equal(owner.ownerId, SELLER);
  assert.equal(owner.basis, "SALES_OWNER_AT_WON");

  // …and an uncertified post-sale Deal reaches nobody at all.
  const unprovenRow = {
    salesStatus: "WON", categoryId: "13", assignedManagerId: CARE, salesManagerId: OPERATOR,
    sellerCertification: "REVIEW_REQUIRED" as const,
  };
  const unproven = resolveFunnelOwner(unprovenRow, { roster: APPROVED, postSaleCategoryIds: new Set(["13"]) });
  assert.equal(unproven.ownerId, null);
  assert.equal(unproven.basis, "REVIEW_REQUIRED_UNPROVEN_SALE");
  assert.equal(funnelOwnerKey(unprovenRow, { roster: APPROVED, postSaleCategoryIds: new Set(["13"]) }), FUNNEL_REVIEW_KEY);
  const namelessRow = { salesStatus: "WON", salesManagerId: null };
  assert.equal(resolveFunnelOwner(namelessRow, { roster: APPROVED }).basis, "REVIEW_REQUIRED_NO_SELLER");
  assert.equal(funnelOwnerKey(namelessRow), FUNNEL_UNKNOWN_KEY);
});

test("an unconfigured roster does not empty the funnel", () => {
  // No roster configured: operational ownership is still the best evidence, so
  // open work keeps its Responsible person instead of vanishing into review.
  const owner = resolveFunnelOwner({ salesStatus: "ACTIVE", assignedManagerId: OPERATOR }, { roster: new Set() });
  assert.equal(owner.ownerId, OPERATOR);
  assert.equal(owner.basis, "CURRENT_RESPONSIBLE_IN_ROSTER");
});
