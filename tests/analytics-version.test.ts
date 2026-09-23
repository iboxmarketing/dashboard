import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ANALYTICS_VERSION, buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";

const MAIN = "3";
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Mirrors the dashboard's stale-data check. */
const isStale = (analyticsVersion: number) => analyticsVersion < ANALYTICS_VERSION;

function record() {
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: "2026-08-17T10:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: MAIN, STAGE_ID: "UC_SQL" }],
    stageHistories: [{ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: "UC_SQL", CREATED_TIME: "2026-08-17T10:07:00+05:00" }],
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN] },
    users: new Map(), pipelines: new Map([[MAIN, "IBOX Sales"]]),
    stages: new Map([["UC_SQL", "Обработка"]]), sources: new Map(),
    domain: null, stageHistoryAvailable: true,
  })[0];
}

test("1: analyticsVersion 4 yozuvi eskirgan deb hisoblanadi", () => {
  assert.equal(isStale(4), true, "Sprint 15/16 semantikasidan oldingi yozuv qayta qurilishi kerak");
  assert.equal(isStale(1), true);
  assert.equal(isStale(3), true);
});

test("2: analyticsVersion 13 joriy, 12 esa atributsiya sertifikatsiyasisiz eskirgan", () => {
  assert.equal(ANALYTICS_VERSION, 13);
  assert.equal(isStale(12), true, "version 12 xodim atributsiyasini sertifikatlamagan va Source’ni kanal maydonidan olgan");
  assert.equal(isStale(11), true, "version 11 Source’ni faqat SOURCE_ID’dan olgan");
  assert.equal(isStale(10), true, "version 10 raw Deal observer evidence’ini ishlatmagan");
  assert.equal(isStale(9), true, "version 9 could read ASSIGNED_BY_ID as a CUSTOM_FIELD seller");
  assert.equal(isStale(13), false);
  assert.equal(isStale(8), true, "version 8 could freeze a post-sale assignee as seller");
  assert.equal(isStale(7), true, "version 7 has no persisted canonical Lead membership");
  // Version 6 was written under the old pre-SQL exclusion — a direct close
  // was unqualified there, so it reports different SQL, Sotilmadi and
  // Saralangan numbers until it is rebuilt.
  assert.equal(isStale(6), true);
  assert.equal(isStale(5), true);
});

test("3: yangi qurilgan yozuvlar 13-versiya bilan saqlanadi", () => {
  assert.equal(record().analyticsVersion, 13);
  assert.equal(record().analyticsVersion, ANALYTICS_VERSION);
  assert.equal(record().projectLeadMembership, "INCLUDED");
});

test("4: Full Sync yo‘li yozuvlarni aynan shu builder orqali qayta quradi", () => {
  const sync = read("../lib/sync.ts");
  assert.ok(sync.includes("buildAnalyticsRecords("), "analyticsStep buildAnalyticsRecords chaqiradi");
  assert.ok(sync.includes("upsertAnalyticsRecords(records)"), "natija analytics_records’ga yoziladi");
  // No second version constant can drift from the builder.
  assert.equal(/analyticsVersion\s*[:=]\s*\d/.test(sync), false, "sync o‘z versiya raqamini yozmaydi");
  const ui = read("../app/dashboard-client.tsx");
  assert.equal(/analyticsVersion\s*<\s*\d/.test(ui), false, "UI qattiq raqam emas, ANALYTICS_VERSION ishlatadi");
  // The comparison runs server-side now; the banner reads the resulting flag.
  const bootstrap = read("../lib/sales-sections.ts");
  assert.equal(/analyticsVersion\s*<\s*\d/.test(bootstrap), false);
  assert.ok(bootstrap.includes("record.analyticsVersion < ANALYTICS_VERSION"));
  assert.ok(ui.includes("setLegacyData(bootstrap.legacyData === true)"));
  assert.match(ui, /Post-sale observer seller dalilini yuklash[\s\S]*To‘liq qayta sync/,
    "v11 observer evidence requires a Full Sync");
  assert.match(ui, /Analytics Backfill observer’ni Bitrix’dan yuklamaydi/);
});

test("5: versiya migratsiya talab qilmaydi — payload ichida saqlanadi", () => {
  const schema = read("../db/schema.ts");
  assert.equal(/analytics_version|analyticsVersion/.test(schema), false, "alohida ustun yo‘q");
  assert.ok(schema.includes('payload: text("payload").notNull()'), "versiya JSON payload ichida");
  const storage = read("../lib/storage.ts");
  assert.ok(storage.includes("JSON.stringify(record)"), "to‘liq yozuv payload sifatida saqlanadi");
  for (const file of ["../drizzle/0000_fat_gauntlet.sql", "../drizzle/0001_tired_meltdown.sql", "../drizzle/0002_flawless_king_cobra.sql"]) {
    assert.equal(/analytics_version/.test(read(file)), false, `${file} versiya ustunini qo‘shmaydi`);
  }
});
