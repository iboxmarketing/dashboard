import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ANALYTICS_VERSION, buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { classifyBackfill, isWritable, summarizeBackfill } from "../lib/seller-backfill";
import { attributionRank, certifySeller, certifyStoredAttribution, countsForScorecard } from "../lib/seller-evidence";
import { canConfirm, matchesQueueFilters, sortQueue, type SellerQueueRow } from "../lib/seller-review";
import { SALES_OWNER_AT_WON_FIELD, isRejectedSellerField, normalizeSalesOwnerAtWonField, normalizeSafeStableSellerField } from "../lib/stable-seller-field";
import { employeeFieldValue, writeSalesOwnerAtWon } from "../lib/seller-writeback";
import { attributionSplit } from "../lib/sales-sections";
import { SALES_SNAPSHOT_UPSERT } from "../lib/sales-snapshots";
import { SELLER_CONFIRMATION_UPSERT, writeSucceeded } from "../lib/seller-confirmation-sql";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/**
 * Sales Owner at Won: the canonical seller field.
 *
 * The rules under test are the ones an employee's pay depends on — a populated
 * field wins, the operator who holds the card now can never take the sale, an
 * ambiguous legacy Deal waits for a human, and a failed CRM write never certifies
 * anybody.
 */

const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX Sales"],
  postSalePipelineIds: ["13"], postSalePipelineNames: ["Post"],
  paymentStageIds: ["C3:WON"], qualifiedStageIds: ["C3:SQL"],
  salesOwnerAtWonField: SALES_OWNER_AT_WON_FIELD,
  salesManagerField: null,
};

const USERS = new Map([
  ["11", "Seller A"], ["22", "Operator B"], ["33", "Seller C"], ["44", "Mover D"],
]);

function build(deal: Record<string, unknown>, options: {
  settings?: DashboardSettings;
  snapshots?: Map<string, { dealId: string; wonAt: string; managerId: string | null; managerName: string | null; attributionSource: string }>;
  confirmations?: Map<string, { dealId: string; sellerId: string; sellerName: string | null; confirmedBy: string; confirmedAt: string }>;
  history?: Record<string, unknown>[];
} = {}) {
  const [record] = buildAnalyticsRecords({
    deals: [{
      ID: "900", TITLE: "Sale", DATE_CREATE: "2026-09-01T09:00:00+05:00", DATE_MODIFY: "2026-09-10T09:00:00+05:00",
      CATEGORY_ID: "3", STAGE_ID: "C3:WON", MOVED_TIME: "2026-09-10T09:00:00+05:00", OPPORTUNITY: 1000, CURRENCY_ID: "UZS",
      ASSIGNED_BY_ID: "22", SOURCE_ID: "CALL", ...deal,
    }],
    stageHistories: (options.history ?? [{
      ID: "1", DEAL_ID: "900", CATEGORY_ID: "3", STAGE_ID: "C3:WON", STAGE_SEMANTIC_ID: "S", TYPE_ID: "1",
      CREATED_TIME: "2026-09-10T09:00:00+05:00",
    }]) as never,
    settings: options.settings ?? SETTINGS, users: USERS,
    pipelines: new Map([["3", "IBOX Sales"], ["13", "Post"]]),
    stages: new Map([["C3:WON", "Оплата получена"]]), sources: new Map([["CALL", "Call"]]),
    stageMeta: new Map([["C3:WON", { categoryId: "3", stageId: "C3:WON", name: "Оплата получена", sort: 10, semantics: "S" }]]) as never,
    snapshots: options.snapshots as never, confirmations: options.confirmations as never,
    domain: null, stageHistoryAvailable: true,
  });
  return record;
}

test("1. a populated Sales Owner at Won field decides the seller and is certified", () => {
  const record = build({ [SALES_OWNER_AT_WON_FIELD]: "11" });
  assert.equal(record.analyticsVersion, ANALYTICS_VERSION);
  assert.equal(record.salesManagerId, "11");
  assert.equal(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
  assert.equal(record.sellerCertification, "CERTIFIED");
  assert.equal(record.sellerEvidenceReason, "SALES_OWNER_AT_WON_FIELD");
  assert.equal(record.salesOwnerAtWonId, "11");
  assert.equal(record.salesOwnerAtWonName, "Seller A");
  assert.ok(countsForScorecard(record.sellerCertification));
});

test("2. the current operator cannot overwrite the seller, whatever else points at them", () => {
  // The Deal now belongs to the operator, they moved the card, and they are the
  // only observer: the field still decides.
  const record = build({
    [SALES_OWNER_AT_WON_FIELD]: "11", ASSIGNED_BY_ID: "22", MOVED_BY_ID: "22", OBSERVER: ["22"], CATEGORY_ID: "13",
  });
  assert.equal(record.salesManagerId, "11");
  assert.equal(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
  assert.notEqual(record.salesManagerId, record.assignedManagerId);
});

test("3. a blank field leaves legacy evidence in place and uncertified", () => {
  const record = build({ MOVED_BY_ID: "44" });
  assert.equal(record.salesOwnerAtWonId, null);
  assert.equal(record.salesManagerAttribution, "STAGE_MOVER");
  assert.equal(record.sellerCertification, "REVIEW_REQUIRED");
  assert.equal(countsForScorecard(record.sellerCertification), false);
});

test("4. the field supersedes a frozen legacy snapshot", () => {
  const snapshots = new Map([["900", {
    dealId: "900", wonAt: "2026-09-10T04:00:00.000Z", managerId: "22", managerName: "Operator B", attributionSource: "CUSTOM_FIELD",
  }]]);
  const record = build({ [SALES_OWNER_AT_WON_FIELD]: "11" }, { snapshots });
  assert.equal(record.salesManagerId, "11");
  assert.equal(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
});

test("5. an admin confirmation outranks the field and certifies as OWNER_CONFIRMED", () => {
  const confirmations = new Map([["900", {
    dealId: "900", sellerId: "33", sellerName: "Seller C", confirmedBy: "admin@example.com", confirmedAt: "2026-09-24T10:00:00Z",
  }]]);
  const record = build({ [SALES_OWNER_AT_WON_FIELD]: "11" }, { confirmations });
  assert.equal(record.salesManagerId, "33");
  assert.equal(record.salesManagerAttribution, "MANUAL_CONFIRMATION");
  assert.equal(record.sellerCertification, "OWNER_CONFIRMED");
  assert.equal(record.sellerEvidenceReason, "MANUAL_OWNER_CONFIRMATION");
  assert.ok(countsForScorecard(record.sellerCertification));
});

test("6. a field value naming no known user never credits anybody", () => {
  const record = build({ [SALES_OWNER_AT_WON_FIELD]: "999" });
  assert.equal(record.salesOwnerAtWonId, "999", "the raw value is still recorded for audit");
  assert.notEqual(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
  assert.equal(countsForScorecard(record.sellerCertification), false);
});

test("7. a reopened Deal that wins again keeps the first frozen seller", () => {
  const snapshots = new Map([["900", {
    dealId: "900", wonAt: "2026-09-10T04:00:00.000Z", managerId: "11", managerName: "Seller A", attributionSource: "SALES_OWNER_AT_WON",
  }]]);
  // Won, reopened, won again under a new owner — the robot leaves a populated
  // field alone, so both the seller and the original sale date survive.
  const record = build({ [SALES_OWNER_AT_WON_FIELD]: "11", ASSIGNED_BY_ID: "33", MOVED_BY_ID: "33" }, {
    snapshots,
    history: [
      { ID: "1", DEAL_ID: "900", CATEGORY_ID: "3", STAGE_ID: "C3:WON", STAGE_SEMANTIC_ID: "S", TYPE_ID: "1", CREATED_TIME: "2026-09-10T09:00:00+05:00" },
      { ID: "2", DEAL_ID: "900", CATEGORY_ID: "3", STAGE_ID: "C3:SQL", STAGE_SEMANTIC_ID: "P", TYPE_ID: "1", CREATED_TIME: "2026-09-15T09:00:00+05:00" },
      { ID: "3", DEAL_ID: "900", CATEGORY_ID: "3", STAGE_ID: "C3:WON", STAGE_SEMANTIC_ID: "S", TYPE_ID: "1", CREATED_TIME: "2026-09-20T09:00:00+05:00" },
    ],
  });
  assert.equal(record.salesManagerId, "11");
  assert.equal(record.salesManagerAttribution, "SALES_OWNER_AT_WON");
  assert.equal(record.wonAt, "2026-09-10T04:00:00.000Z", "the frozen sale date is not moved by the second transition");
});

test("8. KPI membership and revenue are untouched by the attribution change", () => {
  const withField = build({ [SALES_OWNER_AT_WON_FIELD]: "11" });
  const withoutField = build({});
  for (const key of ["salesStatus", "wonAt", "opportunity", "currencyId", "projectLeadMembership", "qualified", "source"] as const) {
    assert.deepEqual(withField[key], withoutField[key], `${key} must not depend on seller evidence`);
  }
  assert.equal(withField.salesStatus, "WON");
  assert.equal(withField.opportunity, 1000);
});

test("9. Первый sales is rejected as seller evidence everywhere", () => {
  assert.ok(isRejectedSellerField("UF_CRM_1740741551"));
  assert.ok(isRejectedSellerField("ufCrm_1740741551"), "both Bitrix spellings");
  assert.equal(normalizeSafeStableSellerField("UF_CRM_1740741551"), null);
  assert.equal(normalizeSalesOwnerAtWonField("UF_CRM_1740741551"), null);
  assert.equal(normalizeSalesOwnerAtWonField(SALES_OWNER_AT_WON_FIELD), SALES_OWNER_AT_WON_FIELD);
  assert.equal(normalizeSalesOwnerAtWonField("ASSIGNED_BY_ID"), null);
});

test("10. certification ranks: an attested fact beats the field, the field beats inference", () => {
  assert.equal(attributionRank("OWNER_CONFIRMED"), 3);
  assert.equal(attributionRank("MANUAL_CONFIRMATION"), 3);
  assert.equal(attributionRank("SALES_OWNER_AT_WON"), 2);
  assert.equal(attributionRank("CUSTOM_FIELD"), 1);
  assert.equal(attributionRank("STAGE_MOVER"), 1);
  assert.equal(attributionRank(undefined), 1);
  assert.equal(certifySeller({
    attribution: "SALES_OWNER_AT_WON", sellerId: "11", fromSnapshot: true, hasConfiguredSellerField: false, knownUser: true,
  }).status, "CERTIFIED", "the field is never asked to corroborate itself");
  assert.equal(certifyStoredAttribution({ salesManagerId: "11", salesManagerAttribution: "SALES_OWNER_AT_WON" }), "CERTIFIED");
  assert.equal(certifyStoredAttribution({ salesManagerId: "11", salesManagerAttribution: "MANUAL_CONFIRMATION" }), "OWNER_CONFIRMED");
});

/* ------------------------------------------------------------------ backfill */

const legacy = (over: Partial<Parameters<typeof classifyBackfill>[0]> = {}) => ({
  dealId: "900", salesStatus: "WON", wonAt: "2026-09-10T04:00:00.000Z", opportunity: 1000,
  projectLeadMembership: "INCLUDED", salesManagerId: "11", salesManager: "Seller A",
  salesManagerAttribution: "CUSTOM_FIELD", sellerCertification: "REVIEW_REQUIRED" as const,
  sellerEvidenceReason: "NO_CONFIGURED_SELLER_FIELD", salesOwnerAtWonId: null, ...over,
});

test("11. a populated field is reported as already set, never rewritten", () => {
  const decision = classifyBackfill(legacy({ salesOwnerAtWonId: "11" }));
  assert.equal(decision.verdict, "ALREADY_SET");
  assert.equal(isWritable(decision), false);
});

test("12. deterministic evidence is safe to backfill; ambiguous legacy evidence is not", () => {
  const observer = classifyBackfill(legacy({
    salesManagerAttribution: "POST_SALE_OBSERVER", sellerCertification: "CERTIFIED", sellerEvidenceReason: "OBSERVER_HANDOFF",
  }));
  assert.equal(observer.verdict, "SAFE_TO_BACKFILL");
  assert.equal(observer.sellerId, "11");
  assert.ok(isWritable(observer));

  for (const reason of ["NO_CONFIGURED_SELLER_FIELD", "MOVER_IS_NOT_SELLER", "LEGACY_CALL_EVIDENCE", "CURRENT_OWNER_IS_NOT_EVIDENCE", "SNAPSHOT_FIELD_NOT_CORROBORATED"]) {
    const decision = classifyBackfill(legacy({ sellerEvidenceReason: reason }));
    assert.equal(decision.verdict, "REVIEW_REQUIRED", reason);
    assert.equal(decision.sellerId, null, `${reason} must not propose a seller`);
    assert.equal(isWritable(decision), false);
  }
});

test("13. an attested per-Deal fact is writable, a missing seller is unknown", () => {
  const attested = new Map([["900", { sellerId: "33", sellerName: "Seller C" }]]);
  const decision = classifyBackfill(legacy(), { attested });
  assert.equal(decision.verdict, "OWNER_CONFIRMED");
  assert.equal(decision.sellerId, "33");
  assert.ok(isWritable(decision));

  const none = classifyBackfill(legacy({ salesManagerId: null, salesManager: null, sellerCertification: "UNKNOWN" }));
  assert.equal(none.verdict, "UNKNOWN");
  assert.equal(isWritable(none), false);
});

test("14. deleted, excluded and non-sale Deals are never backfilled", () => {
  assert.equal(classifyBackfill(legacy({ currentScope: "DELETED" })).verdict, "NOT_ELIGIBLE");
  assert.equal(classifyBackfill(legacy({ projectLeadMembership: "EXCLUDED" })).verdict, "NOT_ELIGIBLE");
  assert.equal(classifyBackfill(legacy({ salesStatus: "LOST" })).verdict, "NOT_ELIGIBLE");
  assert.equal(classifyBackfill(legacy({ wonAt: null })).verdict, "NOT_ELIGIBLE");
});

test("15. the dry-run summary reconciles to the classified population", () => {
  const decisions = [
    classifyBackfill(legacy({ dealId: "1", salesOwnerAtWonId: "11" })),
    classifyBackfill(legacy({ dealId: "2", salesManagerAttribution: "POST_SALE_OBSERVER", sellerCertification: "CERTIFIED", sellerEvidenceReason: "OBSERVER_HANDOFF" })),
    classifyBackfill(legacy({ dealId: "3" })),
    classifyBackfill(legacy({ dealId: "4", salesManagerId: null, sellerCertification: "UNKNOWN" })),
    classifyBackfill(legacy({ dealId: "5", currentScope: "DELETED" })),
  ];
  const summary = summarizeBackfill(decisions);
  assert.equal(summary.alreadySet, 1);
  assert.equal(summary.safeToBackfill, 1);
  assert.equal(summary.reviewRequired, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.notEligible, 1);
  assert.equal(summary.eligible, 4);
  assert.equal(summary.writable, 1);
  assert.equal(summary.alreadySet + summary.safeToBackfill + summary.reviewRequired + summary.unknown + summary.ownerConfirmed, summary.eligible);
});

/* ------------------------------------------------------- Bitrix write-back */

type Call = { method: string; params: Record<string, unknown> };

function stubBitrix(handlers: { get?: () => unknown; update?: () => unknown }) {
  const calls: Call[] = [];
  const call = (async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === "crm.deal.get") return { result: handlers.get ? handlers.get() : {} };
    if (method === "crm.deal.update") return { result: handlers.update ? handlers.update() : true };
    return { result: null };
  }) as never;
  return { call, calls };
}

test("16. a write only ever touches the canonical field", async () => {
  const bitrix = stubBitrix({ get: () => ({ ID: "900" }) });
  const result = await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: SALES_OWNER_AT_WON_FIELD }, { call: bitrix.call, maxAttempts: 1 });
  assert.equal(result.status, "WRITTEN");
  const update = bitrix.calls.find((entry) => entry.method === "crm.deal.update");
  assert.ok(update);
  assert.deepEqual(Object.keys(update.params.fields as Record<string, unknown>), [SALES_OWNER_AT_WON_FIELD]);
  for (const forbidden of ["STAGE_ID", "CATEGORY_ID", "ASSIGNED_BY_ID", "OPPORTUNITY", "SOURCE_ID"]) {
    assert.equal(forbidden in (update.params.fields as Record<string, unknown>), false);
  }
});

test("17. a non-empty field is never overwritten automatically, and the same value is idempotent", async () => {
  const other = stubBitrix({ get: () => ({ ID: "900", [SALES_OWNER_AT_WON_FIELD]: "33" }) });
  const skipped = await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: SALES_OWNER_AT_WON_FIELD }, { call: other.call, maxAttempts: 1 });
  assert.equal(skipped.status, "SKIPPED_NOT_EMPTY");
  assert.equal(skipped.currentValue, "33");
  assert.equal(other.calls.some((entry) => entry.method === "crm.deal.update"), false);

  const same = stubBitrix({ get: () => ({ ID: "900", [SALES_OWNER_AT_WON_FIELD]: "11" }) });
  const repeated = await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: SALES_OWNER_AT_WON_FIELD }, { call: same.call, maxAttempts: 1 });
  assert.equal(repeated.status, "ALREADY_SET");
  assert.equal(same.calls.some((entry) => entry.method === "crm.deal.update"), false);
});

test("18. a failed Bitrix write reports FAILED and certifies nothing", async () => {
  const failing = (async (method: string) => {
    if (method === "crm.deal.get") return { result: { ID: "900" } };
    throw Object.assign(new Error("denied"), { code: "ACCESS_DENIED" });
  }) as never;
  const result = await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: SALES_OWNER_AT_WON_FIELD }, { call: failing, maxAttempts: 3 });
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "ACCESS_DENIED");
  assert.equal(result.attempts, 1, "a validation error is not retried");

  let attempts = 0;
  const limited = (async (method: string) => {
    if (method === "crm.deal.get") { attempts += 1; throw Object.assign(new Error("slow down"), { code: "QUERY_LIMIT_EXCEEDED" }); }
    return { result: true };
  }) as never;
  const rateLimited = await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: SALES_OWNER_AT_WON_FIELD },
    { call: limited, maxAttempts: 3, sleep: async () => {} });
  assert.equal(rateLimited.status, "FAILED");
  assert.equal(attempts, 3, "the rate limit is retried");
});

test("19. an unconfigured field or an invalid seller id writes nothing", async () => {
  const bitrix = stubBitrix({});
  assert.equal((await writeSalesOwnerAtWon({ dealId: "900", sellerId: "11", field: null }, { call: bitrix.call, maxAttempts: 1 })).status, "SKIPPED_NO_FIELD");
  assert.equal((await writeSalesOwnerAtWon({ dealId: "900", sellerId: "0", field: SALES_OWNER_AT_WON_FIELD }, { call: bitrix.call, maxAttempts: 1 })).status, "FAILED");
  assert.equal(bitrix.calls.length, 0);
  assert.equal(employeeFieldValue(["11"]), "11");
  assert.equal(employeeFieldValue({ ID: "11" }), "11");
  assert.equal(employeeFieldValue("0"), "");
  assert.equal(employeeFieldValue(null), "");
});

/* ------------------------------------------------------------- review queue */

const queueRow = (over: Partial<SellerQueueRow> = {}): SellerQueueRow => ({
  dealId: "900", title: "Sale", wonAt: "2026-09-10T04:00:00.000Z", opportunity: 1000, currencyId: "UZS",
  bitrixUrl: null, assignedManagerId: "22", assignedManager: "Operator B", observers: [], postSaleObserverId: null,
  postSaleObserver: null, movedById: "44", movedBy: "Mover D", snapshotSellerId: "11", snapshotSeller: "Seller A",
  snapshotAttribution: "CUSTOM_FIELD", salesOwnerAtWonId: null, salesOwnerAtWonName: null,
  certification: "REVIEW_REQUIRED", certificationReason: "NO_CONFIGURED_SELLER_FIELD",
  verdict: "REVIEW_REQUIRED", verdictReason: "NO_CONFIGURED_SELLER_FIELD", ...over,
});

test("20. the review queue sorts newest first and confirms only a real employee", () => {
  const rows = sortQueue([
    queueRow({ dealId: "1", wonAt: "2026-09-01T00:00:00.000Z" }),
    queueRow({ dealId: "2", wonAt: "2026-09-20T00:00:00.000Z" }),
  ]);
  assert.deepEqual(rows.map((row) => row.dealId), ["2", "1"]);
  assert.equal(canConfirm("11"), true);
  assert.equal(canConfirm(""), false);
  assert.equal(canConfirm("0"), false);
  assert.equal(canConfirm(undefined), false);
  assert.ok(matchesQueueFilters(queueRow(), "900", "all"));
  assert.ok(matchesQueueFilters(queueRow(), "seller a", "REVIEW_REQUIRED"));
  assert.equal(matchesQueueFilters(queueRow(), "", "UNKNOWN"), false);
});

test("21. scorecards count only certified sales, and the split still sums to the period", () => {
  const sale = (over: Partial<DashboardRecord>): DashboardRecord => ({
    ...(build({ [SALES_OWNER_AT_WON_FIELD]: "11" }) as unknown as DashboardRecord), ...over,
  });
  const split = attributionSplit([
    sale({ dealId: "1", opportunity: 100, sellerCertification: "CERTIFIED" }),
    sale({ dealId: "2", opportunity: 200, sellerCertification: "OWNER_CONFIRMED" }),
    sale({ dealId: "3", opportunity: 300, sellerCertification: "REVIEW_REQUIRED" }),
    sale({ dealId: "4", opportunity: 400, sellerCertification: "UNKNOWN" }),
  ]);
  assert.equal(split.sales, 4);
  assert.equal(split.certified, 2);
  assert.equal(split.certifiedRevenue, 300);
  assert.equal(split.reviewRequired, 1);
  assert.equal(split.reviewRevenue, 300);
  assert.equal(split.unknown, 1);
  assert.equal(split.unknownRevenue, 400);
  assert.equal(split.certified + split.reviewRequired + split.unknown, split.sales);
});

/* ------------------------------------------------------------ persistence SQL */

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

test("22. the snapshot upsert follows evidence strength", { skip: DatabaseSync ? false : "node:sqlite unavailable" }, () => {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  const save = (managerId: string, source: string) => db.prepare(SALES_SNAPSHOT_UPSERT)
    .run("1", "2026-09-10T04:00:00.000Z", managerId, `Menejer ${managerId}`, source, "2026-09-10T04:00:00.000Z");
  // node:sqlite hands back a null-prototype row; spread it so deepEqual compares values.
  const row = () => ({ ...(db.prepare("SELECT manager_id, attribution_source FROM deal_sales_snapshots").get() as Record<string, string>) });

  save("22", "CUSTOM_FIELD");
  assert.deepEqual(row(), { manager_id: "22", attribution_source: "CUSTOM_FIELD" });
  // The canonical field replaces inferred evidence...
  save("11", "SALES_OWNER_AT_WON");
  assert.deepEqual(row(), { manager_id: "11", attribution_source: "SALES_OWNER_AT_WON" });
  // ...and inferred evidence can never take it back, however the Deal moves.
  for (const source of ["CUSTOM_FIELD", "STAGE_MOVER", "POST_SALE_OBSERVER", "CURRENT_RESPONSIBLE"]) {
    save("22", source);
    assert.deepEqual(row(), { manager_id: "11", attribution_source: "SALES_OWNER_AT_WON" }, source);
  }
  // An attested fact outranks the field, and only another attested fact moves it.
  save("33", "MANUAL_CONFIRMATION");
  assert.deepEqual(row(), { manager_id: "33", attribution_source: "MANUAL_CONFIRMATION" });
  save("11", "SALES_OWNER_AT_WON");
  assert.deepEqual(row(), { manager_id: "33", attribution_source: "MANUAL_CONFIRMATION" });
  save("44", "OWNER_CONFIRMED");
  assert.deepEqual(row(), { manager_id: "44", attribution_source: "OWNER_CONFIRMED" });
});

test("23. a refused confirmation never replaces a successful one", { skip: DatabaseSync ? false : "node:sqlite unavailable" }, () => {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0011_seller_confirmations.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  const save = (sellerId: string, status: string, prior: string | null = null) => db.prepare(SELLER_CONFIRMATION_UPSERT)
    .run("900", sellerId, `Menejer ${sellerId}`, "admin@example.com", "2026-09-24T10:00:00Z", prior, status, "2026-09-24T10:00:00Z", null,
      writeSucceeded(status) ? 1 : 0);
  const row = () => ({ ...(db.prepare("SELECT seller_id, bitrix_write_status, prior_evidence FROM seller_confirmations").get() as Record<string, string | null>) });

  // A first attempt is recorded even when it failed, so the attempt is visible.
  save("11", "FAILED", "{\"attribution\":\"STAGE_MOVER\"}");
  assert.deepEqual(row(), { seller_id: "11", bitrix_write_status: "FAILED", prior_evidence: "{\"attribution\":\"STAGE_MOVER\"}" });
  // A successful confirmation replaces it and keeps the earliest prior evidence.
  save("22", "WRITTEN", "{\"attribution\":\"LATER\"}");
  assert.deepEqual(row(), { seller_id: "22", bitrix_write_status: "WRITTEN", prior_evidence: "{\"attribution\":\"STAGE_MOVER\"}" });
  // Neither a refusal nor a failure may erase it — the production bug this guards.
  for (const status of ["SKIPPED_NOT_EMPTY", "FAILED", "SKIPPED_NO_FIELD"]) {
    save("33", status);
    assert.deepEqual(row(), { seller_id: "22", bitrix_write_status: "WRITTEN", prior_evidence: "{\"attribution\":\"STAGE_MOVER\"}" }, status);
  }
  // Another successful confirmation still corrects the seller.
  save("44", "ALREADY_SET");
  assert.equal(row().seller_id, "44");
  assert.equal(writeSucceeded("SKIPPED_NOT_EMPTY"), false);
  assert.equal(writeSucceeded("ALREADY_SET"), true);
});
