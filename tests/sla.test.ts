import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { SLA_LABELS, elapsedSlaMinutes, resolveSlaState, summarizeSla } from "../lib/sla";
import type { AnalyticsRecord, DashboardSettings, ProcessingSource, SlaStatus } from "../lib/types";

const SETTINGS: DashboardSettings = { ...defaultSettings, slaMinutes: 10, selectedPipelineIds: ["3"] };
const at = (clock: string) => `2026-08-17T${clock}:00+05:00`;          // Monday, Tashkent
const state = (minutes: number | null, source: ProcessingSource, now: string, slaStart = at("10:00")) =>
  resolveSlaState({ processingBusinessMinutes: minutes, processingSource: source, slaStart }, SETTINGS, new Date(now));
const row = (slaStatus: SlaStatus) => ({ slaStatus }) as AnalyticsRecord;
const many = (slaStatus: SlaStatus, count: number) => Array.from({ length: count }, () => row(slaStatus));

test("1: vaqtida ishlov berilgan lead ON_TIME va hisobga kiradi", () => {
  assert.equal(state(5, "QUALIFICATION_STAGE", at("10:30")), "ON_TIME");
  const summary = summarizeSla([row("ON_TIME")]);
  assert.equal(summary.denominator, 1);
  assert.equal(summary.onTime, 1);
  assert.equal(summary.rate, 100);
});

test("2: kech ishlov berilgan lead LATE, maxrajda bor, suratda yo‘q", () => {
  assert.equal(state(15, "QUALIFICATION_STAGE", at("10:30")), "LATE");
  const summary = summarizeSla([row("LATE")]);
  assert.equal(summary.denominator, 1);
  assert.equal(summary.onTime, 0);
  assert.equal(summary.rate, 0);
});

test("3: muddati tugamagan ishlovsiz lead PENDING va maxrajdan chiqariladi", () => {
  assert.equal(state(null, "NO_PROCESSING", at("10:07")), "PENDING");
  const summary = summarizeSla([row("PENDING")]);
  assert.equal(summary.denominator, 0);
  assert.equal(summary.pending, 1);
});

test("4: muddati o‘tgan ishlovsiz lead OVERDUE_UNPROCESSED va maxrajga kiradi", () => {
  assert.equal(state(null, "NO_PROCESSING", at("10:20")), "OVERDUE_UNPROCESSED");
  const summary = summarizeSla([row("OVERDUE_UNPROCESSED")]);
  assert.equal(summary.denominator, 1);
  assert.equal(summary.onTime, 0);
  assert.equal(summary.rate, 0);
});

test("5: dalil yo‘q bo‘lsa UNKNOWN_EVIDENCE — kunlar o‘tsa ham SLA’ga kirmaydi", () => {
  assert.equal(state(null, "NO_PROCESSING_EVIDENCE", at("10:20")), "UNKNOWN_EVIDENCE");
  assert.equal(state(null, "NO_PROCESSING_EVIDENCE", "2026-09-30T18:00:00+05:00"), "UNKNOWN_EVIDENCE");
  const summary = summarizeSla([row("UNKNOWN_EVIDENCE")]);
  assert.equal(summary.denominator, 0);
  assert.equal(summary.unknown, 1);
});

test("6: KPI formulasi 8 / 13 = 62%", () => {
  const summary = summarizeSla([
    ...many("ON_TIME", 8), ...many("LATE", 2), ...many("OVERDUE_UNPROCESSED", 3),
    ...many("PENDING", 4), ...many("UNKNOWN_EVIDENCE", 2),
  ]);
  assert.equal(summary.denominator, 13, "8 + 2 + 3");
  assert.equal(summary.rate, Math.round((8 / 13) * 100));
  assert.equal(summary.rate, 62);
  assert.notEqual(summary.rate, 80, "8/10 emas");
  assert.notEqual(summary.rate, 42, "8/19 emas");
});

test("7: maxraj nol bo‘lsa xavfsiz 0 — NaN yoki Infinity emas", () => {
  const summary = summarizeSla([...many("PENDING", 4), ...many("UNKNOWN_EVIDENCE", 2)]);
  assert.equal(summary.denominator, 0);
  assert.equal(summary.rate, 0);
  assert.ok(Number.isFinite(summary.rate));
  assert.equal(summarizeSla([]).rate, 0);
});

test("8: juma kechqurundan dushanba ertalabgacha ish minutlari hisoblanadi", () => {
  const fridayEvening = "2026-08-21T20:00:00+05:00";                    // after hours
  const slaStart = "2026-08-24T09:00:00+05:00";                         // Monday opening
  const pending = { processingBusinessMinutes: null, processingSource: "NO_PROCESSING" as ProcessingSource, slaStart };
  assert.equal(resolveSlaState(pending, SETTINGS, new Date("2026-08-24T09:05:00+05:00")), "PENDING");
  assert.equal(resolveSlaState(pending, SETTINGS, new Date("2026-08-24T09:20:00+05:00")), "OVERDUE_UNPROCESSED");
  // Wall clock says ~61 hours have passed; business time says 5 minutes.
  assert.equal(elapsedSlaMinutes(pending, SETTINGS, new Date("2026-08-24T09:05:00+05:00")), 5);
  assert.equal(elapsedSlaMinutes({ ...pending, slaStart: fridayEvening }, SETTINGS, new Date("2026-08-21T23:00:00+05:00")), 0);
});

test("9: bayram kuni SLA minutlarini yemaydi", () => {
  const holiday: DashboardSettings = { ...SETTINGS, holidays: ["2026-08-17"] };
  const pending = { processingBusinessMinutes: null, processingSource: "NO_PROCESSING" as ProcessingSource, slaStart: at("10:00") };
  assert.equal(elapsedSlaMinutes(pending, holiday, new Date(at("17:00"))), 0);
  assert.equal(resolveSlaState(pending, holiday, new Date(at("17:00"))), "PENDING");
});

test("10: qo‘ng‘iroq SLA’ga ta’sir qilmaydi (Sprint 10 qoidasi)", () => {
  const record = buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: at("10:00"), ASSIGNED_BY_ID: "7", CATEGORY_ID: "3", STAGE_ID: "UC_SQL" }],
    activities: [{ ID: "9", OWNER_ID: "1", OWNER_TYPE_ID: "2", BINDINGS: [{ OWNER_ID: "1", OWNER_TYPE_ID: "2" }], TYPE_ID: "2", PROVIDER_ID: "VOXIMPLANT_CALL", DIRECTION: "2", START_TIME: at("10:02"), CREATED: at("10:02"), RESPONSIBLE_ID: "5" }],
    callStats: [], stageHistories: [{ OWNER_ID: "1", CATEGORY_ID: "3", STAGE_ID: "UC_SQL", CREATED_TIME: at("10:15") }],
    providerRules: {}, settings: SETTINGS, users: new Map(), pipelines: new Map([["3", "IBOX Sales"]]),
    stages: new Map([["UC_SQL", "Обработка"]]), sources: new Map(), domain: null,
    activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
  assert.equal(record.processingBusinessMinutes, 15);
  assert.equal(record.slaStatus, "LATE");
});

test("11: yashirin ishlovsiz leadlar endi SLA’ni ko‘tarmaydi — 100% emas, 50%", () => {
  const rows = [...many("ON_TIME", 10), ...many("OVERDUE_UNPROCESSED", 10)];
  const summary = summarizeSla(rows);
  assert.equal(summary.denominator, 20);
  assert.equal(summary.rate, 50);
  // Old denominator counted only records with a processing timestamp.
  const oldRate = Math.round((10 / rows.filter((r) => r.slaStatus === "ON_TIME" || r.slaStatus === "LATE").length) * 100);
  assert.equal(oldRate, 100, "eski formula 100% ko‘rsatardi");
});

test("12: menejeri noma’lum muddati o‘tgan lead maxrajda qoladi", () => {
  const rows = [
    { slaStatus: "ON_TIME", salesManagerId: "7" }, { slaStatus: "OVERDUE_UNPROCESSED", salesManagerId: null },
  ] as AnalyticsRecord[];
  assert.equal(summarizeSla(rows).denominator, 2);
  const unknownBucket = rows.filter((r) => !r.salesManagerId);
  assert.equal(summarizeSla(unknownBucket).denominator, 1, "unknown bucket ham o‘z SLA’siga ega");
  // Per-manager buckets sum back to the total denominator.
  const known = rows.filter((r) => r.salesManagerId);
  assert.equal(summarizeSla(known).denominator + summarizeSla(unknownBucket).denominator, summarizeSla(rows).denominator);
});

test("13: UNKNOWN_EVIDENCE menejer darajasida ham maxrajdan chiqariladi", () => {
  const rows = [
    { slaStatus: "ON_TIME", salesManagerId: "7" }, { slaStatus: "UNKNOWN_EVIDENCE", salesManagerId: "7" },
  ] as AnalyticsRecord[];
  const manager = summarizeSla(rows.filter((r) => r.salesManagerId === "7"));
  assert.equal(manager.denominator, 1);
  assert.equal(manager.rate, 100);
  assert.equal(manager.unknown, 1);
});

test("14: barcha SLA ko‘rsatkichlari bitta helperdan foydalanadi", () => {
  const rows = [...many("ON_TIME", 3), ...many("LATE", 1), ...many("OVERDUE_UNPROCESSED", 1), ...many("PENDING", 5)];
  const summary = summarizeSla(rows);
  // Dashboard KPI, segment card, trend point and manager row all call summarizeSla,
  // so any subset reduces through the same formula.
  assert.equal(summary.rate, 60);
  assert.equal(summarizeSla(rows.slice(0, 4)).rate, 75);
  assert.equal(Object.keys(SLA_LABELS).length, 5);
  assert.equal(SLA_LABELS.OVERDUE_UNPROCESSED, "Ishlov muddati o‘tgan");
});
