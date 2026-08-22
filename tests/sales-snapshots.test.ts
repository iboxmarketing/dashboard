import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { SALES_SNAPSHOT_UPSERT } from "../lib/sales-snapshots";
import type { SalesSnapshot } from "../lib/storage";

const MAIN = "3";
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

/** Real analytics build for a deal whose current stage proves payment. */
function build(deal: Record<string, unknown>, snapshots?: Map<string, SalesSnapshot>, activities: Record<string, unknown>[] = []) {
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, CATEGORY_ID: MAIN, STAGE_ID: "PAYMENT", MOVED_TIME: JAN_12, ...deal }],
    activities, callStats: [],
    stageHistories: [{ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: "PAYMENT", CREATED_TIME: JAN_12 }],
    providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN], salesManagerField: SELLER_FIELD },
    users: new Map([["7", "Aziz"], ["9", "Bobur"], ["12", "Doston"], ["5", "Call"]]),
    pipelines: new Map([[MAIN, "IBOX Sales"]]), stages: new Map([["PAYMENT", "Оплата получена"]]),
    sources: new Map(), snapshots, domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

const call = (responsibleId: string) => ({
  ID: "90", OWNER_ID: "1", OWNER_TYPE_ID: "2", BINDINGS: [{ OWNER_ID: "1", OWNER_TYPE_ID: "2" }],
  TYPE_ID: "2", PROVIDER_ID: "VOXIMPLANT_CALL", DIRECTION: "2",
  START_TIME: "2026-01-05T10:00:00+05:00", CREATED: "2026-01-05T10:00:00+05:00", RESPONSIBLE_ID: responsibleId,
});

let DatabaseSync: (new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: (string | null)[]): unknown; get(): Record<string, string | null> | undefined };
}) | null = null;
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
  const row = () => db.prepare("SELECT deal_id, won_at, manager_id, manager_name, attribution_source, created_at FROM deal_sales_snapshots").get()!;
  return { save, row };
}

test("Case 1: aniqlangan sotuvchi snapshot’i o‘zgarmas bo‘lib qoladi", () => {
  const row = build({ [SELLER_FIELD]: "9", ASSIGNED_BY_ID: "9", MOVED_BY_ID: "9" }, snapshot("7"));
  assert.equal(row.salesManagerId, "7");
  assert.equal(row.salesManagerAttribution, "CUSTOM_FIELD");
  assert.equal(row.wonAt, JAN_10);
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

test("Case 7: fallback tartibi o‘zgarmagan", () => {
  const nullSnap = () => snapshot(null);
  assert.equal(build({ [SELLER_FIELD]: "9", MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap(), [call("5")]).salesManagerAttribution, "CUSTOM_FIELD");
  // CALL was removed from the chain in Sprint 16: a call no longer wins here.
  assert.equal(build({ MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap(), [call("5")]).salesManagerAttribution, "STAGE_MOVER");
  assert.equal(build({ MOVED_BY_ID: "12", ASSIGNED_BY_ID: "7" }, nullSnap()).salesManagerAttribution, "STAGE_MOVER");
  assert.equal(build({ ASSIGNED_BY_ID: "7" }, nullSnap()).salesManagerAttribution, "CURRENT_RESPONSIBLE");
  assert.equal(build({}, nullSnap()).salesManagerAttribution, "UNKNOWN");
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

test("manager id “0” hozircha aniqlangan qiymat sifatida qabul qilinadi", () => {
  // Documented, deliberately unchanged in this sprint: "0" is truthy, so it
  // resolves as CURRENT_RESPONSIBLE and would also block snapshot repair.
  assert.equal(build({ ASSIGNED_BY_ID: "0" }, snapshot(null)).salesManagerId, "0");
  assert.equal(build({ ASSIGNED_BY_ID: "0" }, snapshot(null)).salesManagerAttribution, "CURRENT_RESPONSIBLE");
  assert.equal(build({ ASSIGNED_BY_ID: "" }, snapshot(null)).salesManagerId, null);
});
