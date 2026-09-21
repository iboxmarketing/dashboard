import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { SALES_SNAPSHOT_UPSERT } from "../lib/sales-snapshots";
import { sellerSnapshotInvalidationSql } from "../lib/seller-snapshot-repair";
import {
  OVERRIDE_SCOPE, OWNER_CONFIRMED_SELLERS, OWNER_OVERRIDES, REVIEW_EXCLUSIONS, SELLER_REVIEW_EXCLUSIONS,
  indexOwnerOverrides, indexReviewExclusions, type OwnerSellerOverride,
} from "../lib/seller-overrides";
import type { SalesSnapshot } from "../lib/storage";
import type { AnalyticsRecord } from "../lib/types";

const MAIN = "3";
const POST_SALE = "13";
const PAID = "2026-09-10T13:27:51.000Z";
const LATER = "2026-09-12T10:00:00.000Z";
const USERS = new Map([["7893", "Jamoliddin Kamarov"], ["13053", "Islomiddin Karimov"], ["12961", "Sarvar Tuychiyev"], ["89", "Diyorbek Samadov"], ["95", "Muhamadrasul Dadaxonov"], ["1911", "Rahmatullo Orifjonov"]]);
const SETTINGS = { ...defaultSettings, selectedPipelineIds: [MAIN], postSalePipelineIds: [POST_SALE], paymentStageIds: ["C3:WON"], salesManagerField: "" };

/** Deal 43407 as staging holds it: paid in Sales, now in post-sale, two observer candidates. */
const DEAL_43407 = {
  ID: "43407", TITLE: "43407", DATE_CREATE: "2026-09-08T10:44:01+05:00", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:UC_WGHVTR",
  MOVED_TIME: LATER, MOVED_BY_ID: "12961", ASSIGNED_BY_ID: "12961", observers: [7893, 13053, 12961],
  OPPORTUNITY: 459_000, CURRENCY_ID: "UZS", SOURCE_ID: "WEB",
};
const HISTORY_43407 = [
  { OWNER_ID: "43407", CATEGORY_ID: MAIN, STAGE_ID: "C3:NEW", CREATED_TIME: "2026-09-08T10:44:01+05:00" },
  { OWNER_ID: "43407", CATEGORY_ID: MAIN, STAGE_ID: "C3:WON", CREATED_TIME: PAID },
  { OWNER_ID: "43407", CATEGORY_ID: POST_SALE, STAGE_ID: "C13:UC_WGHVTR", CREATED_TIME: LATER },
];

type Options = { snapshots?: Map<string, SalesSnapshot>; ownerOverrides?: Map<string, OwnerSellerOverride>; reviewExclusions?: Set<string> };
function build(deals: Record<string, unknown>[], histories: Record<string, unknown>[], options: Options = {}): AnalyticsRecord[] {
  return buildAnalyticsRecords({
    deals, stageHistories: histories, settings: SETTINGS, users: USERS,
    pipelines: new Map([[MAIN, "IBOX Sales"], [POST_SALE, "Сопровождение"]]),
    stages: new Map([["C3:NEW", "Новая"], ["C3:WON", "Оплата получена"], ["C13:UC_WGHVTR", "Сопровождение"]]),
    sources: new Map([["WEB", "CRM-форма"]]), domain: null, stageHistoryAvailable: true, ...options,
  });
}
const build43407 = (options: Options = {}) => build([DEAL_43407], HISTORY_43407, options)[0];

/** A post-sale Deal with ONE observer candidate — the evidence an override must beat. */
const singleObserver = (dealId: string) => ({ ...DEAL_43407, ID: dealId, observers: [95, 12961] });
/** A Deal still at payment whose mover is user 89. */
const paymentMover = (dealId: string, mover = "89") => ({
  ID: dealId, TITLE: dealId, DATE_CREATE: "2026-08-20T10:00:00+05:00", CATEGORY_ID: MAIN, STAGE_ID: "C3:WON",
  MOVED_TIME: "2026-08-21T10:00:00+05:00", MOVED_BY_ID: mover, ASSIGNED_BY_ID: "1911", OPPORTUNITY: 300_000, CURRENCY_ID: "UZS", SOURCE_ID: "WEB",
});
const paymentHistory = (dealId: string) => [{ OWNER_ID: dealId, CATEGORY_ID: MAIN, STAGE_ID: "C3:WON", CREATED_TIME: "2026-08-21T10:00:00+05:00" }];
const historyFor = (dealId: string) => HISTORY_43407.map((row) => ({ ...row, OWNER_ID: dealId }));
const override = (dealId: string, sellerId = "7893"): OwnerSellerOverride => ({
  dealId, sellerId, sellerName: USERS.get(sellerId) ?? `User ${sellerId}`, attributionSource: "OWNER_CONFIRMED",
  confirmedBy: "business owner", confirmedAt: "2026-09-20", evidence: "test", scope: OVERRIDE_SCOPE,
});
const unknownSnapshot = (dealId: string, wonAt = PAID): Map<string, SalesSnapshot> =>
  new Map([[dealId, { dealId, wonAt, managerId: null, managerName: null, attributionSource: "UNKNOWN" }]]);

/* ------------------------------------------------------------- SQLite -- */

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

function snapshotDb() {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  return db;
}
type Db = ReturnType<typeof snapshotDb>;
const seed = (db: Db, dealId: string, managerId: string | null, source: string, wonAt = PAID, createdAt = "2026-09-20T10:49:35.175Z") =>
  db.prepare("INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(dealId, wonAt, managerId, managerId ? USERS.get(managerId) ?? managerId : null, source, createdAt);
/** The exact statement saveSalesSnapshots runs, with the same bindings. */
const persist = (db: Db, record: AnalyticsRecord) => db.prepare(SALES_SNAPSHOT_UPSERT)
  .run(record.dealId, record.wonAt, record.salesManagerId, record.salesManager, record.salesManagerAttribution, new Date().toISOString()).changes;
const upsert = (db: Db, dealId: string, managerId: string | null, source: string, wonAt = LATER) =>
  db.prepare(SALES_SNAPSHOT_UPSERT).run(dealId, wonAt, managerId, managerId ? USERS.get(managerId) ?? managerId : null, source, new Date().toISOString()).changes;
const row = (db: Db, dealId: string) => db.prepare("SELECT * FROM deal_sales_snapshots WHERE deal_id = ?").get(dealId) as Record<string, string | null>;
/** The rows getSalesSnapshots returns, as the builder receives them. */
function readSnapshots(db: Db, dealIds: string[]) {
  const result = new Map<string, SalesSnapshot>();
  for (const id of dealIds) {
    const r = row(db, id);
    if (r) result.set(id, { dealId: id, wonAt: String(r.won_at), managerId: r.manager_id, managerName: r.manager_name, attributionSource: String(r.attribution_source) });
  }
  return result;
}

/* ================================================================ tests == */

test("the registry holds exactly the approved entry and is seller-only", () => {
  assert.deepEqual([...OWNER_OVERRIDES.keys()], ["43407"]);
  const entry = OWNER_OVERRIDES.get("43407")!;
  assert.equal(entry.sellerId, "7893");
  assert.equal(entry.sellerName, "Jamoliddin Kamarov");
  assert.equal(entry.attributionSource, "OWNER_CONFIRMED");
  assert.equal(entry.scope, "SELLER_ATTRIBUTION_ONLY");
  assert.equal(OWNER_CONFIRMED_SELLERS.length, 1);
  for (const forbidden of ["wonAt", "opportunity", "OPPORTUNITY", "revenue", "salesStatus", "leadStatus", "source", "stageHistory"]) {
    assert.throws(() => indexOwnerOverrides([{ ...override("1"), [forbidden]: "x" } as OwnerSellerOverride]), /out-of-scope fields/, forbidden);
  }
  assert.throws(() => indexOwnerOverrides([override("1"), override("1")]), /declared twice/);
  assert.throws(() => indexOwnerOverrides([{ ...override("1"), scope: "EVERYTHING" } as never]), /scope/);
  assert.throws(() => indexOwnerOverrides([{ ...override("1"), attributionSource: "POST_SALE_OBSERVER" } as never]), /must be OWNER_CONFIRMED/);
  assert.throws(() => indexOwnerOverrides([{ ...override("1"), sellerId: "0" }]), /invalid sellerId/);
});

test("1. OWNER_CONFIRMED beats a single observer candidate", () => {
  const withoutOwner = build([singleObserver("500")], historyFor("500"), { snapshots: unknownSnapshot("500"), ownerOverrides: new Map() })[0];
  assert.equal(withoutOwner.salesManagerId, "95", "fixture: the observer rule alone would pick 95");
  assert.equal(withoutOwner.salesManagerAttribution, "POST_SALE_OBSERVER");
  const withOwner = build([singleObserver("500")], historyFor("500"), { snapshots: unknownSnapshot("500"), ownerOverrides: indexOwnerOverrides([override("500")]) })[0];
  assert.equal(withOwner.salesManagerId, "7893");
  assert.equal(withOwner.salesManagerAttribution, "OWNER_CONFIRMED");
});

test("2. OWNER_CONFIRMED beats the current payment-stage mover", () => {
  const withoutOwner = build([paymentMover("501")], paymentHistory("501"), { ownerOverrides: new Map(), reviewExclusions: new Set() })[0];
  assert.equal(withoutOwner.salesManagerId, "89", "fixture: the mover rule alone would pick 89");
  const withOwner = build([paymentMover("501")], paymentHistory("501"), { ownerOverrides: indexOwnerOverrides([override("501", "1911")]) })[0];
  assert.equal(withOwner.salesManagerId, "1911");
  assert.equal(withOwner.salesManager, "Rahmatullo Orifjonov");
  assert.equal(withOwner.salesManagerAttribution, "OWNER_CONFIRMED");
});

test("OWNER_CONFIRMED outranks even a trustworthy frozen snapshot in analytics", () => {
  const frozen = new Map<string, SalesSnapshot>([["43407", { dealId: "43407", wonAt: PAID, managerId: "12961", managerName: "Sarvar Tuychiyev", attributionSource: "CUSTOM_FIELD" }]]);
  const record = build43407({ snapshots: frozen });
  assert.equal(record.salesManagerId, "7893");
  assert.equal(record.salesManagerAttribution, "OWNER_CONFIRMED");
  assert.equal(record.wonAt, PAID, "wonAt comes from the Deal's payment history, untouched by the override");
});

test("3. OWNER_CONFIRMED replaces a known-bad legacy snapshot, keeping won_at and created_at", { skip: !DatabaseSync }, () => {
  for (const legacy of ["CUSTOM_FIELD", "FIRST_CALL", "STAGE_MOVER", "POST_SALE_OBSERVER", "CURRENT_RESPONSIBLE", "UNKNOWN"]) {
    const db = snapshotDb();
    seed(db, "43407", legacy === "UNKNOWN" ? null : "12961", legacy);
    const before = row(db, "43407");
    const changes = persist(db, build43407({ snapshots: readSnapshots(db, ["43407"]) }));
    const after = row(db, "43407");
    assert.equal(changes, 1, legacy);
    assert.equal(after.manager_id, "7893", legacy);
    assert.equal(after.manager_name, "Jamoliddin Kamarov", legacy);
    assert.equal(after.attribution_source, "OWNER_CONFIRMED", legacy);
    assert.equal(after.won_at, before.won_at, `${legacy}: won_at is immutable`);
    assert.equal(after.created_at, before.created_at, `${legacy}: created_at is immutable`);
  }
});

test("4. OWNER_CONFIRMED survives every later Sync source", { skip: !DatabaseSync }, () => {
  const db = snapshotDb();
  seed(db, "43407", "7893", "OWNER_CONFIRMED");
  for (const [manager, source] of [["13053", "POST_SALE_OBSERVER"], ["89", "STAGE_MOVER"], ["12961", "CUSTOM_FIELD"], ["12961", "CURRENT_RESPONSIBLE"], ["12961", "FIRST_CALL"], ["12961", "ASSIGNED_BY_ID"]]) {
    assert.equal(upsert(db, "43407", manager, source), 0, `${source} must not overwrite OWNER_CONFIRMED`);
  }
  assert.equal(upsert(db, "43407", null, "UNKNOWN"), 0);
  const after = row(db, "43407");
  assert.equal(after.manager_id, "7893");
  assert.equal(after.attribution_source, "OWNER_CONFIRMED");
  assert.equal(after.won_at, PAID);
  // And a later Sync whose registry no longer listed the Deal still reads the
  // frozen OWNER_CONFIRMED snapshot as its seller.
  const record = build43407({ snapshots: readSnapshots(db, ["43407"]), ownerOverrides: new Map() });
  assert.equal(record.salesManagerId, "7893");
  assert.equal(record.salesManagerAttribution, "OWNER_CONFIRMED");
});

test("5. repeated Backfill is idempotent and spends no writes on a stored confirmation", { skip: !DatabaseSync }, () => {
  const db = snapshotDb();
  seed(db, "43407", "12961", "CUSTOM_FIELD");
  const runs = [1, 2, 3].map(() => persist(db, build43407({ snapshots: readSnapshots(db, ["43407"]) })));
  assert.deepEqual(runs, [1, 0, 0]);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM deal_sales_snapshots").get() as { n: number }).n), 1, "no duplicate snapshot");
  assert.equal(row(db, "43407").manager_id, "7893");
});

test("6. won_at never changes, whatever the seller source", { skip: !DatabaseSync }, () => {
  const db = snapshotDb();
  seed(db, "1", null, "UNKNOWN", PAID);
  seed(db, "2", "12961", "CUSTOM_FIELD", PAID);
  upsert(db, "1", "95", "POST_SALE_OBSERVER", "2027-01-01T00:00:00.000Z");
  upsert(db, "2", "7893", "OWNER_CONFIRMED", "2027-01-01T00:00:00.000Z");
  upsert(db, "2", "7893", "OWNER_CONFIRMED", "2028-01-01T00:00:00.000Z");
  assert.equal(row(db, "1").won_at, PAID);
  assert.equal(row(db, "2").won_at, PAID);
  assert.equal(row(db, "1").manager_id, "95", "the unresolved row was still repaired");
});

test("7. Deal 43407: invalidation → Backfill rebuilds to 7893 OWNER_CONFIRMED, never Unknown", { skip: !DatabaseSync }, () => {
  const db = snapshotDb();
  seed(db, "43407", "12961", "CUSTOM_FIELD");
  // The reviewed manifest clears the seller fields only.
  assert.equal(db.prepare(sellerSnapshotInvalidationSql(["43407"])).run().changes, 1);
  assert.equal(row(db, "43407").attribution_source, "UNKNOWN");
  // Backfill: read snapshots → build → persist, with the default registry.
  const record = build43407({ snapshots: readSnapshots(db, ["43407"]) });
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.salesManagerId, "7893");
  assert.equal(record.salesManager, "Jamoliddin Kamarov");
  assert.equal(record.salesManagerAttribution, "OWNER_CONFIRMED");
  assert.equal(persist(db, record), 1);
  const stored = row(db, "43407");
  assert.deepEqual([stored.manager_id, stored.manager_name, stored.attribution_source], ["7893", "Jamoliddin Kamarov", "OWNER_CONFIRMED"]);
  assert.equal(stored.won_at, PAID);
  // Without the registry the same evidence is honestly ambiguous.
  const withoutRegistry = build43407({ snapshots: unknownSnapshot("43407"), ownerOverrides: new Map() });
  assert.equal(withoutRegistry.salesManagerId, null);
  assert.equal(withoutRegistry.salesManagerAttribution, "UNKNOWN");
});

test("8. another ambiguous-observer Deal without an override stays Unknown", () => {
  const record = build([{ ...DEAL_43407, ID: "42379" }], historyFor("42379"), { snapshots: unknownSnapshot("42379") })[0];
  assert.equal(OWNER_OVERRIDES.has("42379"), false);
  assert.equal(record.salesStatus, "WON");
  assert.equal(record.salesManagerId, null);
  assert.equal(record.salesManagerAttribution, "UNKNOWN");
});

test("9. reviewed exclusions stop automatic recovery for the HUMAN_REVIEW Deals", { skip: !DatabaseSync }, () => {
  assert.deepEqual([...REVIEW_EXCLUSIONS].sort(), ["41251", "41351", "41407", "41411"]);
  for (const dealId of ["41251", "41351", "41407", "41411"]) {
    // Without the exclusion, a cleared snapshot would recover to mover 89.
    const unguarded = build([paymentMover(dealId)], paymentHistory(dealId), { snapshots: unknownSnapshot(dealId), reviewExclusions: new Set() })[0];
    assert.equal(unguarded.salesManagerId, "89", `${dealId}: fixture reproduces the unsafe recovery`);
    const guarded = build([paymentMover(dealId)], paymentHistory(dealId), { snapshots: unknownSnapshot(dealId) })[0];
    assert.equal(guarded.salesManagerId, null, `${dealId}: stays Unknown`);
    assert.equal(guarded.salesManagerAttribution, "UNKNOWN");
    const db = snapshotDb();
    seed(db, dealId, null, "UNKNOWN");
    assert.equal(persist(db, guarded), 0, `${dealId}: nothing is persisted`);
  }
  // The exclusion never clears an existing frozen seller…
  const frozen = new Map<string, SalesSnapshot>([["41411", { dealId: "41411", wonAt: PAID, managerId: "1911", managerName: "Rahmatullo Orifjonov", attributionSource: "FIRST_CALL" }]]);
  assert.equal(build([paymentMover("41411")], paymentHistory("41411"), { snapshots: frozen })[0].salesManagerId, "1911");
  // …and an explicit owner confirmation outranks it.
  const confirmed = build([paymentMover("41411")], paymentHistory("41411"), { snapshots: unknownSnapshot("41411"), ownerOverrides: indexOwnerOverrides([override("41411", "1911")]) })[0];
  assert.equal(confirmed.salesManagerAttribution, "OWNER_CONFIRMED");
  // Exclusions are validated like overrides: explicit, seller-only.
  assert.throws(() => indexReviewExclusions([{ ...SELLER_REVIEW_EXCLUSIONS[0], wonAt: "x" } as never]), /out-of-scope/);
  // A Deal not on the list still recovers normally.
  assert.equal(build([paymentMover("600", "1911")], paymentHistory("600"), { snapshots: unknownSnapshot("600") })[0].salesManagerId, "1911");
});

test("10. no job-title or department heuristic decides a seller", () => {
  const code = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const path of ["../lib/analytics.ts", "../lib/seller-overrides.ts", "../lib/sales-snapshots.ts"]) {
    assert.doesNotMatch(code(path), /WORK_POSITION|UF_DEPARTMENT|job ?title|Sales Manager|Customer Care|оператор|\bposition\b/i, path);
  }
  // Structurally impossible too: the builder only ever receives id → name.
  const record = build([paymentMover("601", "1911")], paymentHistory("601"), { snapshots: unknownSnapshot("601") })[0];
  assert.equal(record.salesManagerId, "1911");
});

test("11. core KPIs, wonAt, OPPORTUNITY, revenue, source and stage history are exactly unchanged", (context) => {
  // Stage age and open-stage durations read the clock; freeze it so the two
  // builds can be compared field for field, stage timeline included.
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T12:00:00.000Z") });
  const deals = [
    DEAL_43407, { ...DEAL_43407, ID: "42379" }, singleObserver("500"),
    paymentMover("41411"), paymentMover("41351"), paymentMover("601", "1911"),
    { ID: "700", TITLE: "700", DATE_CREATE: "2026-09-09T10:00:00+05:00", CATEGORY_ID: MAIN, STAGE_ID: "C3:NEW", ASSIGNED_BY_ID: "95", MOVED_BY_ID: "95", SOURCE_ID: "WEB", OPPORTUNITY: 0 },
  ];
  const histories = [
    ...HISTORY_43407, ...historyFor("42379"), ...historyFor("500"),
    ...paymentHistory("41411"), ...paymentHistory("41351"), ...paymentHistory("601"),
    { OWNER_ID: "700", CATEGORY_ID: MAIN, STAGE_ID: "C3:NEW", CREATED_TIME: "2026-09-09T10:00:00+05:00" },
  ];
  const snapshots = new Map([...["43407", "42379", "500", "41411", "41351", "601"].flatMap((id) => [...unknownSnapshot(id, id === "41411" || id === "41351" || id === "601" ? "2026-08-21T05:00:00.000Z" : PAID)])]);
  const withRules = build(deals, histories, { snapshots });
  const without = build(deals, histories, { snapshots, ownerOverrides: new Map(), reviewExclusions: new Set() });
  assert.equal(withRules.length, without.length);

  const sellerFields = new Set(["salesManagerId", "salesManager", "salesManagerAttribution"]);
  for (let index = 0; index < withRules.length; index += 1) {
    for (const key of Object.keys(without[index]) as (keyof AnalyticsRecord)[]) {
      if (sellerFields.has(key)) continue;
      assert.deepEqual(withRules[index][key], without[index][key], `${withRules[index].dealId}.${key} must not change`);
    }
  }
  // The rules did change sellers — so the equality above is meaningful.
  assert.notDeepEqual(withRules.map((r) => r.salesManagerId), without.map((r) => r.salesManagerId));

  const [a, b] = [withRules, without].map((rows) => buildDashboardMetrics(rows, rows.filter((row) => row.salesStatus === "WON")));
  for (const key of ["leads", "sql", "not_relevant", "classified_leads", "unclassified_leads", "sales_lost", "cohort_sales", "period_sales", "active_cohort"] as const) {
    assert.equal(a.counts[key], b.counts[key], key);
  }
  assert.deepEqual(a.money, b.money);
  assert.deepEqual(a.rates, b.rates);
  assert.equal(a.money.revenue, 459_000 * 2 + 459_000 + 300_000 * 3, "revenue is the sum of OPPORTUNITY, unchanged");
});
