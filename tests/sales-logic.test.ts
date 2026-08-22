import assert from "node:assert/strict";
import test from "node:test";
import { classifyLossReasonGroup, classifySalesStatus, countSalesLost, fieldDisplayValue, isSalesLost, salesManagerKey } from "../lib/sales-logic";
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
