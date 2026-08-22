import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../lib/business-time";
import { hasManagerIdZero, isMissingSalesManager, isWonWithoutSaleDate, stageConfigReadiness, summarizeDataQuality } from "../lib/diagnostics";
import { summarizeSla } from "../lib/sla";
import type { AnalyticsRecord, DashboardSettings } from "../lib/types";

function record(over: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    dealId: "1", salesStatus: "ACTIVE", wonAt: null, salesManagerId: "7", salesManagerAttribution: "CUSTOM_FIELD",
    processingSource: "QUALIFICATION_STAGE", stageTimeline: [{ stageId: "S" }], lossReason: "", lossReasonGroup: "NONE",
    dataUnavailable: false, duplicateOfDealId: null, customerKey: null, createdAt: "2026-01-01T09:00:00.000Z",
    slaStatus: "ON_TIME", ...over,
  } as unknown as AnalyticsRecord;
}
const config = (over: Partial<DashboardSettings> = {}): DashboardSettings => ({ ...defaultSettings, ...over });

test("1: wonAt bor WON diagnostikaga tushmaydi", () => {
  assert.equal(isWonWithoutSaleDate(record({ salesStatus: "WON", wonAt: "2026-01-05T10:00:00.000Z" })), false);
  assert.equal(summarizeDataQuality([record({ salesStatus: "WON", wonAt: "2026-01-05T10:00:00.000Z" })]).wonWithoutSaleDate, 0);
});

test("2: wonAt yo‘q WON aynan bir marta hisoblanadi", () => {
  const rows = [record({ dealId: "1", salesStatus: "WON", wonAt: null })];
  assert.equal(isWonWithoutSaleDate(rows[0]), true);
  assert.equal(summarizeDataQuality(rows).wonWithoutSaleDate, 1);
});

test("3: ACTIVE + wonAt yo‘q hisoblanmaydi", () => {
  assert.equal(summarizeDataQuality([record({ salesStatus: "ACTIVE", wonAt: null })]).wonWithoutSaleDate, 0);
});

test("4: LOST + wonAt yo‘q hisoblanmaydi", () => {
  assert.equal(summarizeDataQuality([record({ salesStatus: "LOST", wonAt: null })]).wonWithoutSaleDate, 0);
});

test("5: diagnostika yozuvni o‘zgartirmaydi — cohort sotuvda qoladi, davr sotuvidan tashqarida", () => {
  const won = record({ salesStatus: "WON", wonAt: null });
  const snapshot = JSON.stringify(won);
  const summary = summarizeDataQuality([won]);
  assert.equal(summary.wonWithoutSaleDate, 1);
  assert.equal(JSON.stringify(won), snapshot, "yozuv mutatsiya qilinmadi");
  // Cohort Sales keys on salesStatus; Period Sales keys on wonAt.
  assert.equal([won].filter((row) => row.salesStatus === "WON").length, 1);
  assert.equal([won].filter((row) => row.salesStatus === "WON" && row.wonAt).length, 0);
});

test("6: manager id “0” alohida hisoblanadi va qiymati o‘zgarmaydi", () => {
  const zero = record({ salesManagerId: "0" });
  const summary = summarizeDataQuality([zero]);
  assert.equal(summary.managerIdZero, 1);
  assert.equal(zero.salesManagerId, "0", "qiymat null’ga aylantirilmaydi");
  assert.equal(summary.missingSalesManager, 0, "“0” yo‘q deb hisoblanmaydi");
});

test("7: sotuvchisi yo‘q yozuv “0” bilan aralashtirilmaydi", () => {
  const summary = summarizeDataQuality([record({ salesManagerId: null }), record({ salesManagerId: "0" })]);
  assert.equal(summary.missingSalesManager, 1);
  assert.equal(summary.managerIdZero, 1);
  assert.equal(isMissingSalesManager(record({ salesManagerId: null })), true);
  assert.equal(hasManagerIdZero(record({ salesManagerId: null })), false);
});

test("8: to‘rt massiv to‘ldirilgan bo‘lsa tayyorlik 4/4", () => {
  const readiness = stageConfigReadiness(config({
    qualifiedStageIds: ["A"], lowQualityStageIds: ["B"], paymentStageIds: ["C"], closedLostStageIds: ["D"],
  }));
  assert.equal(readiness.configured, 4);
  assert.equal(readiness.total, 4);
  assert.equal(readiness.complete, true);
  assert.deepEqual(readiness.missing, []);
});

test("9: faqat SQL + Payment sozlangan bo‘lsa 2/4 va yetishmaganlar ro‘yxati", () => {
  const readiness = stageConfigReadiness(config({ qualifiedStageIds: ["A"], paymentStageIds: ["C"] }));
  assert.equal(readiness.configured, 2);
  assert.equal(readiness.complete, false);
  assert.deepEqual(readiness.missing, ["Not Relevant", "Sotilmadi"]);
});

test("10: bo‘sh konfiguratsiya 0/4 — bu xato emas, zaxira aniqlash saqlanadi", () => {
  const readiness = stageConfigReadiness(config());
  assert.equal(readiness.configured, 0);
  assert.equal(readiness.missing.length, 4);
  assert.equal(defaultSettings.qualifiedStageIds.length, 0, "zaxira nom bo‘yicha aniqlash o‘zgarmadi");
});

test("11: NO_PROCESSING_EVIDENCE diagnostikasi saqlanadi va SLA’ga ta’sir qilmaydi", () => {
  const rows = [record({ processingSource: "NO_PROCESSING_EVIDENCE", slaStatus: "UNKNOWN_EVIDENCE" }), record({ slaStatus: "ON_TIME" })];
  assert.equal(summarizeDataQuality(rows).unknownProcessingTime, 1);
  const sla = summarizeSla(rows);
  assert.equal(sla.denominator, 1, "UNKNOWN_EVIDENCE maxrajga kirmaydi");
  assert.equal(sla.rate, 100);
});

test("12: bitta yozuv bir nechta diagnostikaga qonuniy hissa qo‘shishi mumkin", () => {
  const rows = [
    record({ dealId: "1", salesStatus: "WON", wonAt: null, salesManagerId: "0" }),
    record({ dealId: "2", salesManagerId: null, processingSource: "NO_PROCESSING_EVIDENCE" }),
    record({ dealId: "3", salesStatus: "LOST", lossReason: "Sabab ko‘rsatilmagan", stageTimeline: [] }),
  ];
  const summary = summarizeDataQuality(rows);
  assert.equal(summary.wonWithoutSaleDate, 1);
  assert.equal(summary.managerIdZero, 1);
  assert.equal(summary.missingSalesManager, 1);
  assert.equal(summary.unknownProcessingTime, 1);
  assert.equal(summary.missingFailureReason, 1);
  assert.equal(summary.missingStageHistory, 1);
});

test("13: diagnostikadan keyin funnel jamlari o‘zgarmaydi", () => {
  const rows = [
    record({ dealId: "1", salesStatus: "WON", wonAt: null }),
    record({ dealId: "2", salesStatus: "WON", wonAt: "2026-01-05T10:00:00.000Z" }),
    record({ dealId: "3", salesStatus: "LOST", lossReasonGroup: "SALES" }),
    record({ dealId: "4", salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  ];
  const before = JSON.stringify(rows);
  summarizeDataQuality(rows);
  stageConfigReadiness(config());
  assert.equal(JSON.stringify(rows), before, "hech bir yozuv o‘zgarmadi");
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.salesStatus === "WON").length, 2);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "SALES").length, 1);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "MARKETING").length, 1);
});
