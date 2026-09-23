import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { dealLifecycle, countsCurrently, lifecycleBreakdown } from "../lib/deal-lifecycle";
import { buildManagerProfile } from "../lib/manager-profile";
import { buildManagers, prepareSalesRecords, salesPopulations, type SalesQuery } from "../lib/sales-sections";
import { isEligibleCohortDeal, isSalesLost } from "../lib/sales-logic";
import {
  REVIEW_SELLER_KEY, UNKNOWN_SELLER_KEY, certifySeller, countsForScorecard, scorecardSellerKey,
} from "../lib/seller-evidence";
import type { AnalyticsRecord, DashboardSettings } from "../lib/types";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { SalesSnapshot } from "../lib/storage";
import type { OwnerSellerOverride } from "../lib/seller-overrides";

/*
 * Employee evaluation accuracy.
 *
 * The seller is the Sales person responsible when the Deal first became a
 * canonical sale. Bitrix offers no history of `ASSIGNED_BY_ID`, and
 * `crm.stagehistory.list` rows carry no actor at all, so that person is provable
 * only from: an owner confirmation, a configured stable seller field, or the
 * approved single post-sale observer handoff. Anything else — the current
 * assignee, whoever moved the card, a legacy call — names somebody without
 * proving they sold, and must not reach a scorecard.
 */

const IBOX = "3", POST_SALE = "13", SD = "5";
const SELLER = "700", OPERATOR = "900", ONBOARDING = "901", SECOND = "702";
const SELLER_FIELD = "UF_CRM_1740741551";

const STAGES = new Map([
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ"], ["C3:SQL", "ОБРАБОТКА"], ["C3:WON", "Оплата получена"],
  ["C3:NR", "Not relevant"], ["C3:LOST", "Сделка провалена"], ["C13:START", "Обучение"],
]);
const USERS = new Map([[SELLER, "Seller One"], [OPERATOR, "Operator Two"], [ONBOARDING, "Onboarding Three"], [SECOND, "Seller Two"]]);

function settings(over: Partial<DashboardSettings> = {}): DashboardSettings {
  return {
    ...defaultSettings, selectedPipelineIds: [IBOX], postSalePipelineIds: [POST_SALE],
    qualifiedStageIds: ["C3:SQL"], lowQualityStageIds: ["C3:NR"], paymentStageIds: ["C3:WON"], closedLostStageIds: ["C3:LOST"],
    failureReasonField: "UF_CRM_R", ...over,
  };
}

type Case = {
  deal?: Record<string, unknown>;
  categoryId?: string;
  stageId?: string;
  history?: { stageId: string; clock: string; categoryId?: string }[];
  observers?: number[];
  snapshot?: Partial<SalesSnapshot>;
  override?: OwnerSellerOverride;
  settings?: Partial<DashboardSettings>;
  historyAvailable?: boolean;
};

const at = (clock: string) => `2026-09-10T${clock}:00+05:00`;

function build(input: Case): AnalyticsRecord {
  const categoryId = input.categoryId ?? IBOX;
  const deal: RawDeal = {
    ID: "5001", TITLE: "Deal", DATE_CREATE: "2026-09-09T10:00:00+05:00", ASSIGNED_BY_ID: OPERATOR,
    CATEGORY_ID: categoryId, STAGE_ID: input.stageId ?? "C3:NEW", MOVED_TIME: at("18:00"), SOURCE_ID: "WEBFORM",
    OPPORTUNITY: "500000", CURRENCY_ID: "UZS", observers: input.observers ?? [], ...input.deal,
  } as RawDeal;
  const stageHistories: RawStageHistory[] = (input.history ?? []).map((row) => ({
    OWNER_ID: "5001", CATEGORY_ID: row.categoryId ?? categoryId, STAGE_ID: row.stageId, CREATED_TIME: at(row.clock),
  } as RawStageHistory));
  return buildAnalyticsRecords({
    deals: [deal], stageHistories, activities: [], callStats: [], providerRules: {},
    settings: settings(input.settings), users: USERS,
    pipelines: new Map([[IBOX, "IBOX sales"], [POST_SALE, "IBOX Обучение"], [SD, "SD sales"]]),
    stages: STAGES, sources: new Map([["WEBFORM", "CRM-форма"]]),
    snapshots: input.snapshot ? new Map([["5001", { dealId: "5001", wonAt: at("18:00"), managerId: null, managerName: null, attributionSource: "UNKNOWN", ...input.snapshot } as SalesSnapshot]]) : undefined,
    ownerOverrides: input.override ? new Map([[input.override.dealId, input.override]]) : new Map(),
    fieldOptions: new Map(), domain: null, activitiesAvailable: true,
    stageHistoryAvailable: input.historyAvailable ?? true,
  })[0];
}

// The Deal's life in IBOX Sales, whatever funnel it sits in now.
const WON_PATH = [
  { stageId: "C3:NEW", clock: "10", categoryId: IBOX },
  { stageId: "C3:SQL", clock: "12", categoryId: IBOX },
  { stageId: "C3:WON", clock: "14", categoryId: IBOX },
];
const iso = (clock: string) => new Date(at(clock)).toISOString();
const ownerOverride: OwnerSellerOverride = {
  dealId: "5001", sellerId: SECOND, sellerName: "Seller Two", attributionSource: "OWNER_CONFIRMED",
  confirmedBy: "business owner", confirmedAt: "2026-09-20", evidence: "reviewed", scope: "SELLER_ATTRIBUTION_ONLY",
};

/* ---------------------------------------------------- 1-9: sale attribution */

test("1. a seller responsible through the sale is certified from the configured seller field", () => {
  const record = build({
    stageId: "C3:WON", history: WON_PATH, settings: { salesManagerField: SELLER_FIELD },
    deal: { [SELLER_FIELD]: SELLER, ASSIGNED_BY_ID: SELLER },
  });
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.salesManagerId, SELLER);
  assert.equal(record.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(record.sellerCertification, "CERTIFIED");
  assert.equal(record.sellerEvidenceReason, "CONFIGURED_SELLER_FIELD");
  assert.equal(countsForScorecard(record.sellerCertification), true);
});

test("2. a Deal handed to onboarding after the sale credits the seller, never the new owner", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER), Number(ONBOARDING)],
    deal: { ASSIGNED_BY_ID: ONBOARDING },
    history: [...WON_PATH, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.salesManagerId, SELLER, "the single observer distinct from the support owner");
  assert.equal(record.salesManagerAttribution, "POST_SALE_OBSERVER");
  assert.equal(record.sellerCertification, "CERTIFIED");
  assert.notEqual(record.salesManagerId, ONBOARDING);
  assert.equal(record.assignedManagerId, ONBOARDING, "the current owner is still recorded, as audit evidence");
});

test("3. an operator who only moved the card is never credited", () => {
  const record = build({ stageId: "C3:WON", history: WON_PATH, deal: { MOVED_BY_ID: OPERATOR } });
  assert.equal(record.salesManagerId, OPERATOR, "the mover is shown…");
  assert.equal(record.salesManagerAttribution, "STAGE_MOVER");
  assert.equal(record.sellerCertification, "REVIEW_REQUIRED", "…but never counted");
  assert.equal(record.sellerEvidenceReason, "MOVER_IS_NOT_SELLER");
  assert.equal(scorecardSellerKey(record), REVIEW_SELLER_KEY);
});

test("4. a responsible change just before the sale cannot be proven, so nobody is credited", () => {
  // Bitrix keeps no assignment history: all we know is who owns it now.
  const record = build({ stageId: "C3:WON", history: WON_PATH, deal: { ASSIGNED_BY_ID: SECOND, MOVED_BY_ID: "" } });
  assert.equal(record.sellerCertification, "UNKNOWN");
  assert.equal(record.salesManagerId, null, "the current owner is not promoted to seller");
  assert.equal(scorecardSellerKey(record), UNKNOWN_SELLER_KEY);
});

test("5. a responsible change just after the sale does not move the credit", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER)],
    deal: { ASSIGNED_BY_ID: SECOND },
    history: [...WON_PATH, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesManagerId, SELLER);
  assert.equal(record.sellerCertification, "CERTIFIED");
});

test("6. the category 3 to 13 handoff is a sale with the observer as seller", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER)], deal: { ASSIGNED_BY_ID: ONBOARDING },
    history: [{ stageId: "C3:NEW", clock: "10", categoryId: IBOX }, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.projectLeadMembership, "INCLUDED");
  assert.equal(record.salesManagerId, SELLER);
  assert.equal(record.sellerCertification, "CERTIFIED");
});

test("7. a seller observer plus an operator observer is ambiguous, so it stays unknown", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER), Number(SECOND)],
    deal: { ASSIGNED_BY_ID: ONBOARDING },
    history: [...WON_PATH, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesManagerId, null);
  assert.equal(record.sellerCertification, "UNKNOWN");
});

test("8. many observers never resolve a seller by picking one", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER), Number(SECOND), Number(OPERATOR)],
    deal: { ASSIGNED_BY_ID: ONBOARDING },
    history: [...WON_PATH, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesManagerId, null);
  assert.deepEqual(record.observerIds, [SELLER, SECOND, OPERATOR], "every observer is kept for the audit trail");
});

test("9. an owner confirmation outranks every CRM signal, including a frozen snapshot", () => {
  const record = build({
    stageId: "C3:WON", history: WON_PATH, override: ownerOverride,
    snapshot: { managerId: OPERATOR, managerName: "Operator Two", attributionSource: "CUSTOM_FIELD" },
    deal: { MOVED_BY_ID: OPERATOR },
  });
  assert.equal(record.salesManagerId, SECOND);
  assert.equal(record.salesManagerAttribution, "OWNER_CONFIRMED");
  assert.equal(record.sellerCertification, "OWNER_CONFIRMED");
  assert.equal(countsForScorecard(record.sellerCertification), true);
});

/* ------------------------------------------------- 10-12: losses and quality */

test("10. a direct ordinary loss is SQL and Sales Lost, with an unproven loss owner", () => {
  const record = build({ stageId: "C3:LOST", history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:LOST", clock: "14" }], deal: { UF_CRM_R: "qimmat" } });
  assert.equal(record.qualified, true, "the canonical SQL rule is untouched");
  assert.equal(isSalesLost(record), true);
  assert.equal(record.lostOwnerCertification, "UNKNOWN");
  assert.equal(record.lostOwnerId, null, "the current owner is not blamed for the loss");
});

test("11. a loss after a manager change is still not blamed on the current owner", () => {
  const record = build({
    stageId: "C3:LOST", deal: { ASSIGNED_BY_ID: SECOND, MOVED_BY_ID: SECOND, UF_CRM_R: "dorogo" },
    history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:SQL", clock: "11" }, { stageId: "C3:LOST", clock: "14" }],
  });
  assert.equal(isSalesLost(record), true);
  assert.equal(record.lostOwnerCertification, "UNKNOWN");
  // With a configured seller field the loss owner becomes provable.
  const withField = build({
    stageId: "C3:LOST", settings: { salesManagerField: SELLER_FIELD },
    deal: { ASSIGNED_BY_ID: SECOND, [SELLER_FIELD]: SELLER, UF_CRM_R: "dorogo" },
    history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:LOST", clock: "14" }],
  });
  assert.equal(withField.lostOwnerId, SELLER);
  assert.equal(withField.lostOwnerCertification, "CERTIFIED");
});

test("12. Not Relevant after an SQL stage is not SQL and credits nobody", () => {
  const record = build({ stageId: "C3:NR", history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:SQL", clock: "11" }, { stageId: "C3:NR", clock: "13" }] });
  assert.equal(record.qualified, false);
  assert.equal(record.lossReasonGroup, "MARKETING");
  assert.equal(record.salesStatus, "LOW_QUALITY");
  assert.equal(record.lostOwnerCertification, null, "a marketing rejection has no Sales loss owner");
});

/* ------------------------------------------- 13-15: reopen and transfer cases */

test("13. a reopened loss is active again and carries no loss owner", () => {
  const record = build({
    stageId: "C3:SQL",
    history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:LOST", clock: "12" }, { stageId: "C3:SQL", clock: "15" }],
  });
  assert.equal(record.salesStatus, "ACTIVE", "the current outcome follows the current stage");
  assert.equal(record.lostOwnerCertification, null);
  assert.equal(record.qualified, true, "its SQL evidence survives the reopen");
});

test("14. a reopened sale keeps its first canonical sale date and its proven seller", () => {
  const record = build({
    stageId: "C3:SQL", observers: [Number(SELLER)],
    snapshot: { wonAt: iso("14"), managerId: SELLER, managerName: "Seller One", attributionSource: "POST_SALE_OBSERVER" },
    history: [...WON_PATH, { stageId: "C3:SQL", clock: "16" }],
  });
  assert.equal(record.wonAt, iso("14"), "the first canonical sale is frozen");
  assert.equal(record.salesManagerId, SELLER);
  assert.equal(record.sellerCertification, "CERTIFIED", "a frozen observer snapshot stays proven");
  assert.equal(record.salesStatus, "WON", "payment history still makes it a sale");
});

test("15. a Deal transferred to another project leaves the population but keeps its evidence", () => {
  const record = build({
    categoryId: SD, stageId: "C3:SQL",
    history: [{ stageId: "C3:NEW", clock: "10" }, { stageId: "C3:SQL", clock: "11", categoryId: SD }],
  });
  assert.equal(record.projectLeadMembership, "EXCLUDED");
  assert.equal(dealLifecycle(record), "EXCLUDED_OTHER_PROJECT");
  assert.equal(isEligibleCohortDeal(record), false);
});

/* ------------------------------------- 16-20: deleted, missing and odd history */

test("16. a deleted Deal counts nowhere and is still kept as evidence", () => {
  const record = { ...build({ stageId: "C3:WON", history: WON_PATH, observers: [Number(SELLER)] }), currentScope: "DELETED" as const };
  assert.equal(dealLifecycle(record), "DELETED");
  assert.equal(countsCurrently(record), false);
  assert.equal(isEligibleCohortDeal(record), false);
  const query = { from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;
  const populations = salesPopulations(prepareSalesRecords([record as unknown as DashboardRecord], settings(), new Date("2026-09-30T00:00:00Z")), query);
  assert.equal(populations.won.length, 0, "not a Period Sale");
  assert.equal(populations.cohort.filter(isEligibleCohortDeal).length, 0, "not a Lead");
  assert.equal(lifecycleBreakdown([record]).DELETED, 1, "and visible in Diagnostics");
});

test("17. missing stage history leaves membership unresolved and invents no seller", () => {
  const record = build({ categoryId: SD, stageId: "C3:NEW", history: [], historyAvailable: false });
  assert.equal(record.projectLeadMembership, "UNRESOLVED");
  assert.equal(dealLifecycle(record), "UNRESOLVED");
  assert.equal(record.sellerCertification, "UNKNOWN");
});

test("18. a stale field snapshot is shown but not counted once no seller field is configured", () => {
  const record = build({
    stageId: "C3:WON", history: WON_PATH,
    snapshot: { managerId: OPERATOR, managerName: "Operator Two", attributionSource: "CUSTOM_FIELD" },
  });
  assert.equal(record.salesManagerId, OPERATOR, "the frozen value is still visible");
  assert.equal(record.sellerCertification, "REVIEW_REQUIRED");
  assert.equal(record.sellerEvidenceReason, "NO_CONFIGURED_SELLER_FIELD");
  // Corroborated by the field that is configured now, the same snapshot counts.
  const corroborated = build({
    stageId: "C3:WON", history: WON_PATH, settings: { salesManagerField: SELLER_FIELD },
    deal: { [SELLER_FIELD]: SELLER },
    snapshot: { managerId: SELLER, managerName: "Seller One", attributionSource: "CUSTOM_FIELD" },
  });
  assert.equal(corroborated.sellerCertification, "CERTIFIED");
  assert.equal(corroborated.sellerEvidenceReason, "SNAPSHOT_CORROBORATED_BY_FIELD");
});

test("19. an imported Deal with no history is judged by its current funnel", () => {
  const record = build({ stageId: "C3:NEW", history: [] });
  assert.equal(record.projectLeadMembership, "INCLUDED", "it sits in IBOX Sales now");
  assert.equal(record.sellerCertification, "REVIEW_REQUIRED", "its current owner is not evidence");
  assert.equal(record.sellerEvidenceReason, "CURRENT_OWNER_IS_NOT_EVIDENCE");
});

test("20. a duplicated timeline event does not double-count the sale", () => {
  const record = build({
    stageId: "C3:WON", observers: [Number(SELLER)],
    history: [...WON_PATH, { stageId: "C3:WON", clock: "14" }],
  });
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.wonAt, iso("14"), "the first payment entry is the sale date");
  const query = { from: "2026-09-01", to: "2026-09-30", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;
  const populations = salesPopulations(prepareSalesRecords([record as unknown as DashboardRecord], settings(), new Date("2026-09-30T00:00:00Z")), query);
  assert.equal(populations.won.length, 1);
  assert.equal(populations.detail.length, 1, "one Deal ID, one row");
});

/* -------------------------------------------------- scorecards and roster */

test("only proven sales reach an employee scorecard; the rest sit in a visible bucket", () => {
  const sale = (over: Partial<DashboardRecord>) => ({
    ...build({ stageId: "C3:WON", history: WON_PATH }), ...over,
  }) as unknown as DashboardRecord;
  const rows = [
    sale({ dealId: "1", salesManagerId: SELLER, salesManager: "Seller One", sellerCertification: "CERTIFIED", opportunity: 500_000 }),
    sale({ dealId: "2", salesManagerId: SECOND, salesManager: "Seller Two", sellerCertification: "OWNER_CONFIRMED", opportunity: 400_000 }),
    sale({ dealId: "3", salesManagerId: OPERATOR, salesManager: "Operator Two", sellerCertification: "REVIEW_REQUIRED", opportunity: 300_000 }),
    sale({ dealId: "4", salesManagerId: null, salesManager: null, sellerCertification: "UNKNOWN", opportunity: 200_000 }),
  ];
  const managers = buildManagers(rows, rows);
  const byId = new Map(managers.map((row) => [row.id, row]));
  assert.equal(byId.get(SELLER)?.periodSales, 1);
  assert.equal(byId.get(SELLER)?.revenue, 500_000);
  assert.equal(byId.get(SECOND)?.periodSales, 1);
  assert.equal(byId.get(OPERATOR), undefined, "the operator gets no row of their own");
  assert.equal(byId.get(REVIEW_SELLER_KEY)?.periodSales, 1, "their sale is visible in the review bucket");
  assert.equal(byId.get(REVIEW_SELLER_KEY)?.name, "Tekshiruv kerak (tasdiqlanmagan)");
  assert.equal(byId.get(UNKNOWN_SELLER_KEY)?.periodSales, 1);
  // The KPI total is unchanged by attribution: 4 sales either way.
  assert.equal(buildDashboardMetrics(rows, rows).counts.period_sales, 4);
  assert.equal(managers.reduce((sum, row) => sum + row.periodSales, 0), 4, "buckets still sum to the KPI");
  // A profile opened for the operator shows their proven work only.
  assert.equal(buildManagerProfile(rows, rows, OPERATOR).periodSales.length, 0);
});

test("the Sales roster only ever flags an attribution; it never decides or erases one", () => {
  const roster = new Set([SELLER]);
  const base = { sellerId: SELLER, fromSnapshot: false, hasConfiguredSellerField: true, fieldSellerId: SELLER, knownUser: true };
  assert.equal(certifySeller({ ...base, attribution: "CUSTOM_FIELD", salesRoster: roster }).status, "CERTIFIED");
  const outsider = certifySeller({ ...base, attribution: "CUSTOM_FIELD", sellerId: SECOND, fieldSellerId: SECOND, salesRoster: roster });
  assert.equal(outsider.status, "REVIEW_REQUIRED", "evidence pointing outside the roster goes to a human");
  assert.equal(outsider.reason, "OUTSIDE_SALES_ROSTER");
  assert.equal(outsider.outsideRoster, true);
  // An owner confirmation outranks the roster, and a leaver keeps their sales.
  const confirmed = certifySeller({ ...base, attribution: "OWNER_CONFIRMED", sellerId: SECOND, salesRoster: roster });
  assert.equal(confirmed.status, "OWNER_CONFIRMED");
  assert.equal(certifySeller({ ...base, attribution: "CUSTOM_FIELD", salesRoster: new Set() }).status, "CERTIFIED", "no roster configured, no flagging");
  // An id that is not a real user is unknown, never a person.
  assert.equal(certifySeller({ ...base, attribution: "STAGE_MOVER", sellerId: "0", knownUser: false }).status, "UNKNOWN");
  assert.equal(certifySeller({ ...base, attribution: "CUSTOM_FIELD", sellerId: "12345", knownUser: false }).reason, "UNKNOWN_USER");
});

test("the audit trail can answer why a Deal counts, for whom, and on what evidence", () => {
  const record = build({
    categoryId: POST_SALE, stageId: "C13:START", observers: [Number(SELLER), Number(ONBOARDING)],
    deal: { ASSIGNED_BY_ID: ONBOARDING, MOVED_BY_ID: OPERATOR },
    history: [...WON_PATH, { stageId: "C13:START", clock: "16", categoryId: POST_SALE }],
  });
  assert.equal(record.salesManagerId, SELLER);              // for whom
  assert.equal(record.sellerCertification, "CERTIFIED");    // is it countable
  assert.equal(record.sellerEvidenceReason, "OBSERVER_HANDOFF"); // on what evidence
  assert.equal(record.wonAt, iso("14"));                    // at what timestamp
  assert.equal(record.categoryId, POST_SALE);               // which category
  assert.equal(record.stage, "Обучение");                   // which stage
  assert.equal(record.assignedManagerId, ONBOARDING);       // who is current assignee
  assert.equal(record.movedById, OPERATOR);                 // who moved the stage
  assert.deepEqual(record.observerIds, [SELLER, ONBOARDING]); // observers
  assert.equal(record.postSaleObserverId, SELLER);
  assert.equal(record.projectLeadMembership, "INCLUDED");
  assert.equal(dealLifecycle(record), "ACTIVE");            // was it transferred or deleted
  // Every one of those fields travels to the Deal report for a human to read.
  const source = readFileSync(new URL("../lib/sales-sections.ts", import.meta.url), "utf8");
  for (const field of ["sellerCertification", "sellerEvidenceReason", "movedById", "observerIds", "postSaleObserverId", "lostOwnerCertification"]) {
    assert.ok(source.includes(`"${field}"`), `${field} is part of the Deal report`);
  }
});
