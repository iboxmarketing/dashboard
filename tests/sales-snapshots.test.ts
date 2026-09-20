import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { SALES_SNAPSHOT_UPSERT } from "../lib/sales-snapshots";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import {
  parseSellerSnapshotRepairManifest,
  sellerSnapshotInvalidationSql,
  sellerSnapshotRepairPreviewSql,
} from "../lib/seller-snapshot-repair";
import type { SalesSnapshot } from "../lib/storage";

const MAIN = "3";
const POST_SALE = "13";
const CREATED = "2026-01-01T09:00:00+05:00";
const JAN_10 = new Date("2026-01-10T12:00:00+05:00").toISOString();
const JAN_12 = new Date("2026-01-12T12:00:00+05:00").toISOString();
const SELLER_FIELD = "UF_CRM_SELLER";

function snapshot(managerId: string | null, wonAt = JAN_10): Map<string, SalesSnapshot> {
  return new Map([["1", {
    dealId: "1", wonAt, managerId,
    managerName: managerId ? `Menejer ${managerId}` : null,
    attributionSource: managerId ? "CUSTOM_FIELD" : "UNKNOWN",
  }]]);
}

function attributedSnapshot(managerId: string, attributionSource: string): Map<string, SalesSnapshot> {
  return new Map([["1", { dealId: "1", wonAt: JAN_10, managerId, managerName: `Menejer ${managerId}`, attributionSource }]]);
}

/** Real analytics build for a deal whose current stage proves payment. */
function build(deal: Record<string, unknown>, snapshots?: Map<string, SalesSnapshot>, activities: Record<string, unknown>[] = [], salesManagerField = SELLER_FIELD) {
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, CATEGORY_ID: MAIN, STAGE_ID: "PAYMENT", MOVED_TIME: JAN_12, ...deal }],
    activities, callStats: [],
    stageHistories: [{ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: "PAYMENT", CREATED_TIME: JAN_12 }],
    providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN], salesManagerField },
    users: new Map([["7", "Aziz"], ["9", "Bobur"], ["12", "Doston"], ["5", "Call"]]),
    pipelines: new Map([[MAIN, "IBOX Sales"]]), stages: new Map([["PAYMENT", "Оплата получена"]]),
    sources: new Map(), snapshots, domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

/** Real analytics build for a Deal first observed after it reached post-sale. */
function buildPostSale(deal: Record<string, unknown>, snapshots?: Map<string, SalesSnapshot>, salesManagerField = SELLER_FIELD) {
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, CATEGORY_ID: POST_SALE, STAGE_ID: "SUPPORT", MOVED_TIME: JAN_12, ...deal }],
    stageHistories: [
      { OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: "PAYMENT", CREATED_TIME: JAN_10 },
      { OWNER_ID: "1", CATEGORY_ID: POST_SALE, STAGE_ID: "SUPPORT", CREATED_TIME: JAN_12 },
    ],
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN], postSalePipelineIds: [POST_SALE], salesManagerField },
    users: new Map([["7", "Ali"], ["9", "Sanjar"], ["20", "Madina"]]),
    pipelines: new Map([[MAIN, "IBOX Sales"], [POST_SALE, "IBOX Обучение/Сопровождение"]]),
    stages: new Map([["PAYMENT", "Оплата получена"], ["SUPPORT", "Сопровождение"]]),
    sources: new Map(), snapshots, domain: null, stageHistoryAvailable: true,
  })[0];
}

const call = (responsibleId: string) => ({
  ID: "90", OWNER_ID: "1", OWNER_TYPE_ID: "2", BINDINGS: [{ OWNER_ID: "1", OWNER_TYPE_ID: "2" }],
  TYPE_ID: "2", PROVIDER_ID: "VOXIMPLANT_CALL", DIRECTION: "2",
  START_TIME: "2026-01-05T10:00:00+05:00", CREATED: "2026-01-05T10:00:00+05:00", RESPONSIBLE_ID: responsibleId,
});

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

/** Applies the real production upsert to a real SQLite table from the migration. */
function withDb(seed?: { managerId: string | null; wonAt: string; createdAt: string }) {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  if (seed) {
    db.prepare("INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run("1", seed.wonAt, seed.managerId, seed.managerId ? `Menejer ${seed.managerId}` : null, seed.managerId ? "CUSTOM_FIELD" : "UNKNOWN", seed.createdAt);
  }
  const save = (managerId: string | null, wonAt: string, source: string, createdAt = "2026-06-01T00:00:00.000Z") =>
    db.prepare(SALES_SNAPSHOT_UPSERT).run("1", wonAt, managerId, managerId ? `Menejer ${managerId}` : null, source, createdAt);
  const row = () => db.prepare("SELECT deal_id, won_at, manager_id, manager_name, attribution_source, created_at FROM deal_sales_snapshots").get()! as Record<string, string | null>;
  return { save, row };
}

test("Case 1: aniqlangan sotuvchi snapshot’i o‘zgarmas bo‘lib qoladi", () => {
  const row = build({ [SELLER_FIELD]: "9", ASSIGNED_BY_ID: "9", MOVED_BY_ID: "9" }, snapshot("7"));
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(row.wonAt, JAN_10);
});

test("CUSTOM_FIELD seller attribution reads both canonical and legacy camelCase field keys", () => {
  const canonical = build({ UF_CRM_123: "9" }, undefined, [], "UF_CRM_123");
  const legacy = build({ UF_CRM_123: "9" }, undefined, [], "ufCrm_123");
  assert.equal(canonical.salesManagerId, "9");
  assert.equal(canonical.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(legacy.salesManagerId, "9", "stored camelCase setting reads the canonical Deal payload");
  assert.equal(legacy.salesManagerAttribution, "CUSTOM_FIELD");
});

test("Case 2: null sotuvchili snapshot fallback zanjiriga yo‘l beradi", () => {
  const row = build({ [SELLER_FIELD]: "9" }, snapshot(null));
  assert.equal(row.salesManagerId, "9");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(row.wonAt, JAN_10, "snapshot wonAt hokim bo‘lib qoladi");
});

test("Case 3: null manager’li qator ta’mirlanadi, won_at va created_at saqlanadi", { skip: !DatabaseSync }, () => {
  const db = withDb({ managerId: null, wonAt: JAN_10, createdAt: "2026-01-10T13:00:00.000Z" });
  db.save("9", JAN_12, "CUSTOM_FIELD");
  const row = db.row();
  assert.equal(row.manager_id, "9");
  assert.equal(row.manager_name, "Menejer 9");
  assert.equal(row.attribution_source, "CUSTOM_FIELD");
  assert.equal(row.won_at, JAN_10, "won_at qayta hisoblangan sanaga almashmaydi");
  assert.equal(row.created_at, "2026-01-10T13:00:00.000Z");
});

test("Case 4: ta’mirlangan sotuvchi keyin qayta yozilmaydi", { skip: !DatabaseSync }, () => {
  const db = withDb({ managerId: null, wonAt: JAN_10, createdAt: "2026-01-10T13:00:00.000Z" });
  db.save("9", JAN_10, "CUSTOM_FIELD");
  db.save("12", JAN_12, "CURRENT_RESPONSIBLE");
  const row = db.row();
  assert.equal(row.manager_id, "9");
  assert.equal(row.attribution_source, "CUSTOM_FIELD");
  assert.equal(row.won_at, JAN_10);
});

test("Case 4a: legacy current-owner snapshot kuchli custom-field dalili bilan ta’mirlanadi", { skip: !DatabaseSync }, () => {
  // Seed directly so the legacy attribution_source is controlled precisely.
  const raw = new DatabaseSync!(":memory:");
  raw.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  raw.prepare("INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run("1", JAN_10, "20", "Madina", "CURRENT_RESPONSIBLE", "2026-01-10T13:00:00.000Z");
  raw.prepare(SALES_SNAPSHOT_UPSERT).run("1", JAN_12, "7", "Ali", "CUSTOM_FIELD", "2026-06-01T00:00:00.000Z");
  const row = raw.prepare("SELECT * FROM deal_sales_snapshots").get()! as Record<string, string>;
  assert.equal(row.manager_id, "7");
  assert.equal(row.attribution_source, "CUSTOM_FIELD");
  assert.equal(row.won_at, JAN_10);
  assert.equal(row.created_at, "2026-01-10T13:00:00.000Z");
});

test("Case 4b: legacy current-owner snapshot analytics’da hokim emas", () => {
  const repaired = buildPostSale({ [SELLER_FIELD]: "7", MOVED_BY_ID: "20", ASSIGNED_BY_ID: "20" }, attributedSnapshot("20", "CURRENT_RESPONSIBLE"));
  assert.equal(repaired.salesManagerId, "7");
  assert.equal(repaired.salesManagerAttribution, "CUSTOM_FIELD");
  const unknown = buildPostSale({ MOVED_BY_ID: "20", ASSIGNED_BY_ID: "20" }, attributedSnapshot("20", "CURRENT_RESPONSIBLE"));
  assert.equal(unknown.salesManagerId, null, "onboarding employee is removed, not preserved as seller");
  assert.equal(unknown.salesManagerAttribution, "UNKNOWN");
});

test("Case 5: manba topilmasa null xavfsiz saqlanadi, soxta atribut yaratilmaydi", { skip: !DatabaseSync }, () => {
  const db = withDb({ managerId: null, wonAt: JAN_10, createdAt: "2026-01-10T13:00:00.000Z" });
  db.save(null, JAN_12, "UNKNOWN");
  const row = db.row();
  assert.equal(row.manager_id, null);
  assert.equal(row.attribution_source, "UNKNOWN");
  assert.equal(row.won_at, JAN_10);
  const record = build({}, snapshot(null));
  assert.equal(record.salesManagerId, null);
  assert.equal(record.salesManagerAttribution, "UNKNOWN");
  assert.equal(record.wonAt, JAN_10);
});

test("Case 6: wonAt manager holatidan qat’i nazar o‘zgarmas", { skip: !DatabaseSync }, () => {
  // Analytics: raw evidence says Jan 12, snapshot says Jan 10.
  assert.equal(build({ [SELLER_FIELD]: "9" }, snapshot(null)).wonAt, JAN_10);
  assert.equal(build({ [SELLER_FIELD]: "9" }, snapshot("7")).wonAt, JAN_10);
  // Storage: neither the repair path nor the no-op path touches won_at.
  for (const seeded of [null, "7"] as const) {
    const db = withDb({ managerId: seeded, wonAt: JAN_10, createdAt: "2026-01-10T13:00:00.000Z" });
    db.save("9", JAN_12, "CUSTOM_FIELD");
    assert.equal(db.row().won_at, JAN_10);
  }
});

test("Case 7: won fallback faqat joriy payment mover’ini sale-time dalil deb oladi", () => {
  const nullSnap = () => snapshot(null);
  assert.equal(build({ [SELLER_FIELD]: "9", MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap(), [call("5")]).salesManagerAttribution, "CUSTOM_FIELD");
  // CALL was removed from the chain in Sprint 16: a call no longer wins here.
  assert.equal(build({ MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap(), [call("5")]).salesManagerAttribution, "STAGE_MOVER");
  assert.equal(build({ MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap()).salesManagerAttribution, "STAGE_MOVER");
  assert.equal(build({ ASSIGNED_BY_ID: "7" }, nullSnap()).salesManagerAttribution, "UNKNOWN", "current assignee is not sale-time evidence");
  assert.equal(build({}, nullSnap()).salesManagerAttribution, "UNKNOWN");
});

test("Case 7a: Ali sotadi, post-sale’da Madina owner bo‘ladi — Ali saqlanadi", () => {
  const row = buildPostSale({ [SELLER_FIELD]: "7", MOVED_BY_ID: "20", ASSIGNED_BY_ID: "20" });
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManager, "Ali");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(row.assignedManagerId, "20");
  assert.equal(row.assignedManager, "Madina");
});

test("Case 7b: first sync post-sale’dan keyin bo‘lsa onboarding owner sotuvchi deb taxmin qilinmaydi", () => {
  const row = buildPostSale({ MOVED_BY_ID: "20", ASSIGNED_BY_ID: "20" });
  assert.equal(row.salesManagerId, null);
  assert.equal(row.salesManager, null);
  assert.equal(row.salesManagerAttribution, "UNKNOWN");
  assert.equal(row.assignedManagerId, "20", "operational owner alohida saqlanadi");
});

test("unsafe ASSIGNED_BY_ID config post-sale onboarding owner’ini CUSTOM_FIELD sotuvchi qila olmaydi", () => {
  const row = buildPostSale(
    { ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20", OPPORTUNITY: 559_000 },
    undefined,
    "ASSIGNED_BY_ID",
  );
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.assignedManager, "Madina", "live operational owner remains available");
  assert.equal(row.salesManagerId, null);
  assert.equal(row.salesManagerAttribution, "UNKNOWN");
});

test("Case 7c: oldin to‘g‘ri muzlatilgan Ali post-sale owner bilan qayta yozilmaydi", () => {
  const row = buildPostSale({ MOVED_BY_ID: "20", ASSIGNED_BY_ID: "20" }, snapshot("7"));
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
});

test("observer A: Ali sotadi, post-sale observer Ali va assignee Madina — seller Ali", () => {
  const row = buildPostSale({ observers: [7], ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20" }, snapshot(null));
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManager, "Ali");
  assert.equal(row.salesManagerAttribution, "POST_SALE_OBSERVER");
  assert.equal(row.assignedManagerId, "20");
});

test("observer B: observer va current assignee bir odam bo‘lsa handoff dalili emas", () => {
  const row = buildPostSale({ observers: [7], ASSIGNED_BY_ID: "7", MOVED_BY_ID: "7" });
  assert.equal(row.salesManagerId, null);
  assert.equal(row.salesManagerAttribution, "UNKNOWN");
});

test("observer C: observer yo‘q bo‘lsa Unknown", () => {
  const row = buildPostSale({ observers: [], ASSIGNED_BY_ID: "20" });
  assert.equal(row.salesManagerId, null);
  assert.equal(row.salesManagerAttribution, "UNKNOWN");
});

test("observer D: bir nechta observer bo‘lsa taxmin qilinmaydi", () => {
  const row = buildPostSale({ observers: [7, 9], ASSIGNED_BY_ID: "20" });
  assert.equal(row.salesManagerId, null);
  assert.equal(row.salesManagerAttribution, "UNKNOWN");
});

test("observer E: trustworthy payment snapshot current observer’dan ustun", () => {
  const trustedPayment = new Map<string, SalesSnapshot>([["1", {
    dealId: "1", wonAt: JAN_10, managerId: "7", managerName: "Ali", attributionSource: "STAGE_MOVER",
  }]]);
  const row = buildPostSale(
    { observers: [9], ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20" },
    trustedPayment,
  );
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManager, "Ali");
  assert.equal(row.salesManagerAttribution, "STAGE_MOVER");
});

test("approved stable custom seller field observer’dan ustun", () => {
  const row = buildPostSale({ [SELLER_FIELD]: "9", observers: [7], ASSIGNED_BY_ID: "20" });
  assert.equal(row.salesManagerId, "9");
  assert.equal(row.salesManager, "Sanjar");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
});

test("observer F: unsafe ASSIGNED_BY_ID config observer dalilini bosib ketmaydi", () => {
  const row = buildPostSale(
    { observers: [7], ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20" },
    undefined,
    "ASSIGNED_BY_ID",
  );
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManagerAttribution, "POST_SALE_OBSERVER");
  assert.notEqual(row.salesManagerId, row.assignedManagerId);
});

test("observer G: seller recovery Lead/SQL/NR/Lost/Sales/wonAt/Opportunity/Revenue’ni o‘zgartirmaydi", () => {
  const deal = { ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20", OPPORTUNITY: 559_000, CURRENCY_ID: "UZS" };
  const before = buildPostSale({ ...deal, observers: [] }, snapshot(null));
  const after = buildPostSale({ ...deal, observers: [7] }, snapshot(null));
  const beforeMetrics = buildDashboardMetrics([before], [before]);
  const afterMetrics = buildDashboardMetrics([after], [after]);

  assert.deepEqual(afterMetrics.counts, beforeMetrics.counts,
    "Lead, SQL, Not Relevant, Sales Lost and both Sales populations are unchanged");
  assert.deepEqual(afterMetrics.money, beforeMetrics.money, "revenue is unchanged");
  assert.equal(after.wonAt, before.wonAt);
  assert.equal(after.opportunity, before.opportunity);
  assert.equal(after.salesManagerId, "7");
  assert.equal(before.salesManagerId, null);
});

test("observer evidence can upgrade only an untrusted CURRENT_RESPONSIBLE snapshot", { skip: !DatabaseSync }, () => {
  const raw = new DatabaseSync!(":memory:");
  raw.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  raw.prepare("INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run("1", JAN_10, "20", "Madina", "CURRENT_RESPONSIBLE", "2026-01-10T13:00:00.000Z");
  raw.prepare(SALES_SNAPSHOT_UPSERT)
    .run("1", JAN_12, "7", "Ali", "POST_SALE_OBSERVER", "2026-06-01T00:00:00.000Z");
  const row = raw.prepare("SELECT * FROM deal_sales_snapshots").get()! as Record<string, string>;
  assert.equal(row.manager_id, "7");
  assert.equal(row.attribution_source, "POST_SALE_OBSERVER");
  assert.equal(row.won_at, JAN_10);
});

test("Case 8: Full Sync eski A5 qatorlarini ta’mirlaydi (uchtan-uchi)", { skip: !DatabaseSync }, () => {
  const db = withDb({ managerId: null, wonAt: JAN_10, createdAt: "2026-01-10T13:00:00.000Z" });
  // Rebuild 1: analytics reads the broken snapshot and resolves a real seller.
  const rebuilt = build({ [SELLER_FIELD]: "9" }, snapshot(null));
  assert.equal(rebuilt.salesManagerId, "9");
  assert.equal(rebuilt.wonAt, JAN_10);
  // Persist exactly what saveSalesSnapshots would persist.
  db.save(rebuilt.salesManagerId, rebuilt.wonAt!, rebuilt.salesManagerAttribution);
  assert.equal(db.row().manager_id, "9");
  assert.equal(db.row().won_at, JAN_10);
  // Rebuild 2 reads the repaired snapshot — and holds even if raw evidence vanishes.
  const repaired = new Map<string, SalesSnapshot>([["1", {
    dealId: "1", wonAt: String(db.row().won_at), managerId: String(db.row().manager_id),
    managerName: String(db.row().manager_name), attributionSource: String(db.row().attribution_source),
  }]]);
  const second = build({}, repaired);
  assert.equal(second.salesManagerId, "9");
  assert.equal(second.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(second.wonAt, JAN_10);
});

test("Case 9: sotuv summasi va sanasi ta’mirdan ta’sirlanmaydi", () => {
  const before = build({}, snapshot(null));
  const after = build({ [SELLER_FIELD]: "9" }, snapshot(null));
  for (const row of [before, after]) {
    assert.equal(row.salesStatus, "WON");
    assert.equal(row.wonAt, JAN_10, "Period Sales kaliti o‘zgarmaydi");
    assert.equal(row.createdAt, new Date(CREATED).toISOString(), "Cohort Sales kaliti o‘zgarmaydi");
  }
  assert.equal(before.salesManagerId, null);
  assert.equal(after.salesManagerId, "9");
  assert.equal(before.opportunity, after.opportunity);
  assert.equal(before.salesCycleHours, after.salesCycleHours);
});

test("manager id “0” faqat current payment mover bo‘lsa qabul qilinadi", () => {
  assert.equal(build({ MOVED_BY_ID: "0", ASSIGNED_BY_ID: "7" }, snapshot(null)).salesManagerId, "0");
  assert.equal(build({ MOVED_BY_ID: "0", ASSIGNED_BY_ID: "7" }, snapshot(null)).salesManagerAttribution, "STAGE_MOVER");
  assert.equal(buildPostSale({ MOVED_BY_ID: "0", ASSIGNED_BY_ID: "0" }, snapshot(null)).salesManagerId, null);
  assert.equal(build({ ASSIGNED_BY_ID: "" }, snapshot(null)).salesManagerId, null);
});

test("reviewed seller snapshot invalidation is targeted, seller-only and idempotent", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0002_flawless_king_cobra.sql", import.meta.url), "utf8").replace(/-->.*$/gm, ""));
  const insert = db.prepare("INSERT INTO deal_sales_snapshots(deal_id, won_at, manager_id, manager_name, attribution_source, created_at) VALUES(?, ?, ?, ?, ?, ?)");
  insert.run("1", JAN_10, "20", "Madina", "FIRST_CALL", "2026-01-10T13:00:00.000Z");
  insert.run("2", JAN_10, "7", "Ali", "CUSTOM_FIELD", "2026-01-10T13:00:00.000Z");

  const manifest = parseSellerSnapshotRepairManifest({ reviewed: true, dealIds: ["1", "1"] });
  assert.deepEqual(manifest.dealIds, ["1"], "manifest is explicit and deduplicated");
  const preview = db.prepare(sellerSnapshotRepairPreviewSql(manifest.dealIds)).get()! as Record<string, number>;
  assert.equal(Number(preview.matched), 1);
  assert.equal(Number(preview.would_change), 1);

  const before = db.prepare("SELECT COUNT(*) AS deals, COUNT(won_at) AS sales FROM deal_sales_snapshots").get()! as Record<string, number>;
  const first = db.prepare(sellerSnapshotInvalidationSql(manifest.dealIds)).run();
  assert.equal(first.changes, 1);
  const repaired = db.prepare("SELECT * FROM deal_sales_snapshots WHERE deal_id = '1'").get()! as Record<string, string | null>;
  assert.equal(repaired.manager_id, null);
  assert.equal(repaired.manager_name, null);
  assert.equal(repaired.attribution_source, "UNKNOWN");
  assert.equal(repaired.won_at, JAN_10, "won_at is outside the repair SET clause");
  assert.equal(repaired.created_at, "2026-01-10T13:00:00.000Z");

  const trusted = db.prepare("SELECT * FROM deal_sales_snapshots WHERE deal_id = '2'").get()! as Record<string, string | null>;
  assert.equal(trusted.manager_id, "7", "unlisted trustworthy snapshot is untouched");
  assert.equal(trusted.manager_name, "Ali");
  assert.equal(trusted.attribution_source, "CUSTOM_FIELD");

  const second = db.prepare(sellerSnapshotInvalidationSql(manifest.dealIds)).run();
  assert.equal(second.changes, 0, "repeated invalidation is a no-op");
  const after = db.prepare("SELECT COUNT(*) AS deals, COUNT(won_at) AS sales FROM deal_sales_snapshots").get()! as Record<string, number>;
  assert.deepEqual(after, before, "Deal and Sale row counts are preserved");
});

test("Backfill semantics after invalidation keep the sale and revenue but may honestly leave seller Unknown", () => {
  const badSnapshot = attributedSnapshot("20", "FIRST_CALL");
  const deal = { ASSIGNED_BY_ID: "20", MOVED_BY_ID: "20", OPPORTUNITY: 559_000, CURRENCY_ID: "UZS" };
  const before = buildPostSale(deal, badSnapshot, "ASSIGNED_BY_ID");
  const invalidated = new Map<string, SalesSnapshot>([["1", {
    dealId: "1", wonAt: JAN_10, managerId: null, managerName: null, attributionSource: "UNKNOWN",
  }]]);
  const after = buildPostSale(deal, invalidated, "ASSIGNED_BY_ID");

  assert.equal(before.salesManagerId, "20", "fixture proves the reviewed legacy snapshot was previously trusted");
  assert.equal(after.salesManagerId, null);
  assert.equal(after.salesManagerAttribution, "UNKNOWN");
  assert.equal(after.wonAt, before.wonAt);
  assert.equal(after.opportunity, before.opportunity);

  const beforeMetrics = buildDashboardMetrics([before], [before]);
  const afterMetrics = buildDashboardMetrics([after], [after]);
  assert.equal(afterMetrics.counts.leads, beforeMetrics.counts.leads);
  assert.equal(afterMetrics.counts.cohort_sales, beforeMetrics.counts.cohort_sales);
  assert.equal(afterMetrics.counts.period_sales, beforeMetrics.counts.period_sales);
  assert.equal(afterMetrics.money.revenue, 559_000);
  assert.equal(afterMetrics.money.revenue, beforeMetrics.money.revenue);
});

test("seller repair manifest refuses implicit or unreviewed targets", () => {
  assert.throws(() => parseSellerSnapshotRepairManifest({ dealIds: ["1"] }), /reviewed/);
  assert.throws(() => parseSellerSnapshotRepairManifest({ reviewed: true, dealIds: [] }), /explicit/);
  assert.throws(() => parseSellerSnapshotRepairManifest({ reviewed: true, dealIds: ["1 OR 1=1"] }), /positive integer/);
});
