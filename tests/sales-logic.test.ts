import assert from "node:assert/strict";
import test from "node:test";
import { classifyLossReasonGroup, classifySalesStatus, fieldDisplayValue } from "../lib/sales-logic";
import { buildAnalyticsRecords, type RawStageHistory } from "../lib/analytics";
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
