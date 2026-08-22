import assert from "node:assert/strict";
import test from "node:test";
import { classifyLossReasonGroup, classifySalesStatus, countSalesLost, dealOutcomeLabel, fieldDisplayValue, isSalesLost, salesLostRate, salesManagerKey } from "../lib/sales-logic";
import { buildAnalyticsRecords, type RawStageHistory } from "../lib/analytics";
import type { AnalyticsRecord } from "../lib/types";
import { defaultSettings } from "../lib/business-time";
import { resolvePostSalePipelines } from "../lib/pipelines";

test("Not Relevant marketing sifatsizligi sifatida ajratiladi", () => {
  assert.equal(classifySalesStatus({ stage: "Not Relevant", paymentReached: false, inPostSalePipeline: false }), "LOW_QUALITY");
});

test("Закрыто и не реализовано sales loss sifatida ajratiladi", () => {
  assert.equal(classifySalesStatus({ stage: "Закрыто и не реализовано", paymentReached: false, inPostSalePipeline: false }), "LOST");
});

test("Oplata yoki post-sale funnel sotuvni bir marta tasdiqlaydi", () => {
  assert.equal(classifySalesStatus({ stage: "Oplata poluchena", paymentReached: true, inPostSalePipeline: false }), "WON");
  assert.equal(classifySalesStatus({ stage: "Obucheniya", paymentReached: false, inPostSalePipeline: true }), "WON");
});

test("Причина провала enum qiymati nomga aylantiriladi", () => {
  assert.equal(fieldDisplayValue("7", new Map([["7", "Telefon noto‘g‘ri"]])), "Telefon noto‘g‘ri");
});

test("Not Relevant sababi qanday bo‘lishidan qat’i nazar marketing sifatsizligi", () => {
  assert.equal(classifyLossReasonGroup({ status: "LOW_QUALITY", reason: "IDOKO ga berildi", routingPatterns: ["idoko", "sd"] }), "MARKETING");
  assert.equal(classifyLossReasonGroup({ status: "LOW_QUALITY", reason: "SD ga o‘tkazildi", routingPatterns: ["idoko", "sd"] }), "MARKETING");
  assert.equal(classifyLossReasonGroup({ status: "LOW_QUALITY", reason: "Noto‘g‘ri raqam", routingPatterns: ["idoko", "sd"] }), "MARKETING");
  assert.equal(classifyLossReasonGroup({ status: "LOST", reason: "SD ga o‘tkazildi", routingPatterns: ["idoko", "sd"] }), "ROUTING");
});

test("IBOX va SD post-sale funnel Cyrillic nom bilan topiladi", () => {
  const rows = resolvePostSalePipelines([
    { id: "1", name: "IBOX Sales" }, { id: "2", name: "SD Sales" },
    { id: "3", name: "IBOX Обучение Сопровождение" }, { id: "4", name: "SD Обучение / Сопровождение" },
    { id: "5", name: "Call Center" },
  ], [], ["IBOX Обучение Сопровождение", "SD Обучение Сопровождение"]);
  assert.deepEqual(rows.map((row) => row.id), ["3", "4"]);
});

const SALES_FUNNEL = "3";
const POST_SALE_FUNNEL = "13";
const CREATED_AT = "2026-08-10T09:00:00+05:00";

/** Builds one analytics record for a deal in the selected Sales funnel. */
function record(deal: Record<string, unknown>, stageHistories: RawStageHistory[] = [], categoryId = SALES_FUNNEL) {
  return buildAnalyticsRecords({
    deals: [{ ID: "500", TITLE: "Sotuv", DATE_CREATE: CREATED_AT, ASSIGNED_BY_ID: "7", CATEGORY_ID: categoryId, ...deal }],
    activities: [], callStats: [], stageHistories, providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [SALES_FUNNEL], postSalePipelineIds: [POST_SALE_FUNNEL] },
    users: new Map([["7", "Aziz Karimov"]]),
    pipelines: new Map([[SALES_FUNNEL, "IBOX Sales"], [POST_SALE_FUNNEL, "IBOX Обучение Сопровождение"]]),
    stages: new Map([["NEW", "Yangi"], ["IN_PROCESS", "Обработка"], ["PAYMENT", "Оплата получена"], ["OBUCHENIE", "Boshlangan"]]),
    sources: new Map(), domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

test("Case 1: joriy stage Oplata bo‘lsa, stage history bo‘lmasa ham WON", () => {
  const row = record({ STAGE_ID: "PAYMENT", MOVED_TIME: "2026-08-12T15:00:00+05:00" }, []);
  assert.equal(row.salesStatus, "WON");
});

test("Case 2: payment history bo‘lsa tarixiy wonAt hokim bo‘lib qoladi", () => {
  const row = record(
    { STAGE_ID: "PAYMENT", MOVED_TIME: "2026-08-20T15:00:00+05:00" },
    [
      { OWNER_ID: "500", CATEGORY_ID: SALES_FUNNEL, STAGE_ID: "NEW", CREATED_TIME: CREATED_AT },
      { OWNER_ID: "500", CATEGORY_ID: SALES_FUNNEL, STAGE_ID: "PAYMENT", CREATED_TIME: "2026-08-11T10:00:00+05:00" },
    ],
  );
  assert.equal(row.salesStatus, "WON");
  // History evidence outranks the current-stage fallback.
  assert.equal(row.wonAt, new Date("2026-08-11T10:00:00+05:00").toISOString());
});

test("Case 3: joriy Oplata stage + MOVED_TIME → wonAt aynan MOVED_TIME", () => {
  const row = record({ STAGE_ID: "PAYMENT", MOVED_TIME: "2026-08-12T15:00:00+05:00" }, []);
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.wonAt, new Date("2026-08-12T15:00:00+05:00").toISOString());
  assert.equal(row.salesCycleHours, 54);
});

test("Case 4: oddiy aktiv stage va history yo‘q — ACTIVE bo‘lib qoladi", () => {
  const row = record({ STAGE_ID: "IN_PROCESS", MOVED_TIME: "2026-08-12T15:00:00+05:00" }, []);
  assert.equal(row.salesStatus, "ACTIVE");
  assert.equal(row.wonAt, null);
  assert.equal(row.salesCycleHours, null);
});

test("Case 5: joriy post-sale funnel, payment history yo‘q — WON bo‘lib qoladi", () => {
  const row = record({ STAGE_ID: "OBUCHENIE", MOVED_TIME: "2026-08-12T15:00:00+05:00" }, [], POST_SALE_FUNNEL);
  assert.equal(row.salesStatus, "WON");
});

test("Case 6: MOVED_TIME bo‘lmasa wonAt to‘qib chiqarilmaydi", () => {
  // DATE_MODIFY is any edit and CLOSEDATE is not payment entry: neither may
  // stand in for a revenue date. WON stays true, wonAt stays unknown.
  const row = record({ STAGE_ID: "PAYMENT", DATE_MODIFY: "2026-08-19T18:30:00+05:00", CLOSEDATE: "2026-08-18T12:00:00+05:00" }, []);
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.wonAt, null);
  assert.equal(row.salesCycleHours, null);
});

test("Case 7: stage-history ruxsati yo‘q holat — joriy Oplata baribir WON", () => {
  const row = buildAnalyticsRecords({
    deals: [{ ID: "501", TITLE: "Sotuv", DATE_CREATE: CREATED_AT, ASSIGNED_BY_ID: "7", CATEGORY_ID: SALES_FUNNEL, STAGE_ID: "PAYMENT", MOVED_TIME: "2026-08-12T15:00:00+05:00" }],
    activities: [], callStats: [], stageHistories: [], providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [SALES_FUNNEL], postSalePipelineIds: [POST_SALE_FUNNEL] },
    users: new Map([["7", "Aziz Karimov"]]), pipelines: new Map([[SALES_FUNNEL, "IBOX Sales"]]),
    stages: new Map([["PAYMENT", "Оплата получена"]]), sources: new Map(), domain: null,
    activitiesAvailable: false, stageHistoryAvailable: false,
  })[0];
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.wonAt, new Date("2026-08-12T15:00:00+05:00").toISOString());
});

test("joriy Oplata stage WON bo‘lgani uchun stage limitidan oshgan deb belgilanmaydi", () => {
  const row = record({ STAGE_ID: "PAYMENT", MOVED_TIME: "2025-01-01T09:00:00+05:00" }, []);
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.stageOverdue, false);
});

type LossRow = { dealId: string; lossReasonGroup: AnalyticsRecord["lossReasonGroup"]; salesStatus: AnalyticsRecord["salesStatus"]; salesManagerId: string | null };

function lossRow(dealId: string, lossReasonGroup: LossRow["lossReasonGroup"], salesStatus: LossRow["salesStatus"], salesManagerId: string | null = "7"): LossRow {
  return { dealId, lossReasonGroup, salesStatus, salesManagerId };
}
/** Mirrors buildManagers: partition by seller bucket, count Sales Lost per bucket. */
function managerLostRows(rows: LossRow[]) {
  const grouped = new Map<string, LossRow[]>();
  for (const row of rows) {
    const key = salesManagerKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.entries()].map(([id, group]) => ({ id, lost: countSalesLost(group) }));
}
const sumLost = (rows: LossRow[]) => managerLostRows(rows).reduce((total, row) => total + row.lost, 0);

test("Sales Lost 1: SALES yo‘qotish headline va menejerda bir xil", () => {
  const rows = [lossRow("1", "SALES", "LOST")];
  assert.equal(countSalesLost(rows), 1);
  assert.deepEqual(managerLostRows(rows), [{ id: "7", lost: 1 }]);
});

test("Sales Lost 2: ROUTING yozuvi Sotilmadi’ga kirmaydi", () => {
  const rows = [lossRow("1", "ROUTING", "LOST")];
  // The regression itself: the old manager column keyed on salesStatus and
  // counted this record while the headline did not.
  assert.equal(rows.filter((row) => row.salesStatus === "LOST").length, 1);
  assert.equal(countSalesLost(rows), 0);
  assert.deepEqual(managerLostRows(rows), [{ id: "7", lost: 0 }]);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "ROUTING").length, 1);
});

test("Sales Lost 3: Not Relevant hech qayerda Sotilmadi emas", () => {
  const rows = [lossRow("1", "MARKETING", "LOW_QUALITY")];
  assert.equal(countSalesLost(rows), 0);
  assert.equal(sumLost(rows), 0);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "MARKETING").length, 1);
});

test("Sales Lost 4: aralash populyatsiyada hamma joyda 2 ta", () => {
  const rows = [
    lossRow("1", "SALES", "LOST"), lossRow("2", "SALES", "LOST"),
    lossRow("3", "ROUTING", "LOST"), lossRow("4", "MARKETING", "LOW_QUALITY"),
    lossRow("5", "NONE", "WON"),
  ];
  assert.equal(countSalesLost(rows), 2);
  assert.equal(sumLost(rows), 2);
  // Untouched groups keep their existing totals.
  assert.equal(rows.filter((row) => row.lossReasonGroup === "ROUTING").length, 1);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "MARKETING").length, 1);
  assert.equal(rows.filter((row) => row.salesStatus === "WON").length, 1);
  assert.equal(rows.filter((row) => row.salesStatus === "LOST").length, 3);
});

test("Sales Lost 5: menejerlar yig‘indisi headline bilan mos, Unknown ham yo‘qolmaydi", () => {
  const rows = [
    lossRow("1", "SALES", "LOST", "7"), lossRow("2", "SALES", "LOST", "7"),
    lossRow("3", "SALES", "LOST", "9"),
    lossRow("4", "SALES", "LOST", null),
    lossRow("5", "ROUTING", "LOST", "9"), lossRow("6", "MARKETING", "LOW_QUALITY", "7"),
  ];
  const perManager = managerLostRows(rows);
  assert.equal(countSalesLost(rows), 4);
  assert.equal(sumLost(rows), 4);
  assert.deepEqual(perManager.find((row) => row.id === "7"), { id: "7", lost: 2 });
  assert.deepEqual(perManager.find((row) => row.id === "9"), { id: "9", lost: 1 });
  // The unassigned bucket is reported, not dropped to force a match.
  assert.deepEqual(perManager.find((row) => row.id === "unknown"), { id: "unknown", lost: 1 });
});

test("Sales Lost 6: isSalesLost faqat SALES guruhini tan oladi", () => {
  assert.equal(isSalesLost({ lossReasonGroup: "SALES" }), true);
  assert.equal(isSalesLost({ lossReasonGroup: "ROUTING" }), false);
  assert.equal(isSalesLost({ lossReasonGroup: "MARKETING" }), false);
  assert.equal(isSalesLost({ lossReasonGroup: "NONE" }), false);
  assert.equal(isSalesLost({}), false);
  assert.equal(salesManagerKey({ salesManagerId: null }), "unknown");
  assert.equal(salesManagerKey({ salesManagerId: "7" }), "7");
});

test("Sales Lost 7: routing sabab bilan yopilgan deal SQL sifatida qabul qilingan bo‘lib qoladi", () => {
  // Classification is untouched this sprint: a routed terminal deal is still
  // salesStatus LOST, so it still counts as quality accepted upstream.
  assert.equal(classifySalesStatus({ stage: "Закрыто и не реализовано", paymentReached: false, inPostSalePipeline: false }), "LOST");
  assert.equal(classifyLossReasonGroup({ status: "LOST", reason: "SD ga o‘tkazildi", routingPatterns: ["sd"] }), "ROUTING");
});

type RateRow = { qualified: boolean; lossReasonGroup: AnalyticsRecord["lossReasonGroup"]; salesStatus: AnalyticsRecord["salesStatus"] };

function rateRow(qualified: boolean, lossReasonGroup: RateRow["lossReasonGroup"], salesStatus: RateRow["salesStatus"]): RateRow {
  return { qualified, lossReasonGroup, salesStatus };
}
function cohort(counts: { sqlActive: number; salesLost: number; routing: number; marketing: number; won: number; unqualifiedActive: number }) {
  return [
    ...Array.from({ length: counts.sqlActive }, () => rateRow(true, "NONE", "ACTIVE")),
    ...Array.from({ length: counts.salesLost }, () => rateRow(true, "SALES", "LOST")),
    ...Array.from({ length: counts.routing }, () => rateRow(true, "ROUTING", "LOST")),
    ...Array.from({ length: counts.marketing }, () => rateRow(false, "MARKETING", "LOW_QUALITY")),
    ...Array.from({ length: counts.won }, () => rateRow(true, "NONE", "WON")),
    ...Array.from({ length: counts.unqualifiedActive }, () => rateRow(false, "NONE", "ACTIVE")),
  ];
}

test("Rate 1: 100 lead / 60 SQL / 12 Sotilmadi → 20% (lead’dan emas, SQL’dan)", () => {
  const rows = cohort({ sqlActive: 30, salesLost: 12, routing: 0, marketing: 18, won: 18, unqualifiedActive: 22 });
  assert.equal(rows.length, 100);
  assert.equal(rows.filter((row) => row.qualified).length, 60);
  assert.equal(countSalesLost(rows), 12);
  assert.equal(salesLostRate(rows), 20);
  // The old cohort denominator produced 12% for the same data.
  assert.notEqual(salesLostRate(rows), 12);
});

test("Rate 2: SQL nol bo‘lsa 0% — NaN yoki Infinity emas", () => {
  const rows = cohort({ sqlActive: 0, salesLost: 0, routing: 0, marketing: 5, won: 0, unqualifiedActive: 7 });
  const rate = salesLostRate(rows);
  assert.equal(rate, 0);
  assert.ok(Number.isFinite(rate));
  assert.equal(salesLostRate([]), 0);
});

test("Rate 3: ROUTING sotilmagan raqamga ham, foizga ham kirmaydi", () => {
  const rows = cohort({ sqlActive: 0, salesLost: 0, routing: 1, marketing: 0, won: 0, unqualifiedActive: 0 });
  assert.equal(countSalesLost(rows), 0);
  assert.equal(salesLostRate(rows), 0);
  assert.equal(rows.filter((row) => row.lossReasonGroup === "ROUTING").length, 1);
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "LOST", lossReasonGroup: "ROUTING" }), { label: "Yo‘naltirildi", tone: "neutral" });
});

test("Rate 4: kanonik Sotilmadi yozuvi “Sotilmadi” deb belgilanadi", () => {
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "LOST", lossReasonGroup: "SALES" }), { label: "Sotilmadi", tone: "danger" });
});

test("Rate 5: Not Relevant Sotilmadi’dan ajratilgan bo‘lib qoladi", () => {
  const rows = cohort({ sqlActive: 0, salesLost: 0, routing: 0, marketing: 3, won: 0, unqualifiedActive: 0 });
  assert.equal(countSalesLost(rows), 0);
  assert.equal(salesLostRate(rows), 0);
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }), { label: "Sifatsiz", tone: "warning" });
});

test("Rate 6: Lead→SQL, SQL→Sotuv va Lead→Sotuv populyatsiyalari o‘zgarmadi", () => {
  const rows = cohort({ sqlActive: 30, salesLost: 12, routing: 0, marketing: 18, won: 18, unqualifiedActive: 22 });
  const leads = rows.length; const sql = rows.filter((row) => row.qualified).length;
  const won = rows.filter((row) => row.salesStatus === "WON").length;
  assert.equal(Math.round((sql / leads) * 100), 60);
  assert.equal(Math.round((won / sql) * 100), 30);
  assert.equal(Math.round((won / leads) * 100), 18);
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "WON", lossReasonGroup: "NONE" }), { label: "Sotilgan", tone: "success" });
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "ACTIVE", lossReasonGroup: "NONE" }), { label: "Aktiv", tone: "neutral" });
});

test("Rate 7: foiz va son aynan bitta Sotilmadi populyatsiyasidan hisoblanadi", () => {
  const rows = cohort({ sqlActive: 10, salesLost: 5, routing: 4, marketing: 6, won: 5, unqualifiedActive: 0 });
  const sql = rows.filter((row) => row.qualified).length;
  assert.equal(countSalesLost(rows), 5);
  assert.equal(sql, 24);
  assert.equal(salesLostRate(rows), Math.round((countSalesLost(rows) / sql) * 100));
  assert.equal(salesLostRate(rows), 21);
  // A stale routing reason on a live deal must not be badged as terminal.
  assert.deepEqual(dealOutcomeLabel({ salesStatus: "ACTIVE", lossReasonGroup: "ROUTING" }), { label: "Aktiv", tone: "neutral" });
});
