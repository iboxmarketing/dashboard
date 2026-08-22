import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../lib/business-time";
import { buildCurrentStageRecords, reconcileCurrentStages } from "../lib/current-stages";
import type { AnalyticsRecord, CurrentStageRecord } from "../lib/types";

test("joriy stage snapshot DATE_CREATE eski bo‘lsa ham ochiq dealni saqlaydi", () => {
  const rows = buildCurrentStageRecords({
    deals: [{ ID: "42", TITLE: "Eski aktiv deal", DATE_CREATE: "2025-01-01T09:00:00+05:00", MOVED_TIME: "2026-08-20T09:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: "3", STAGE_ID: "UC_ABC" }],
    settings: { ...defaultSettings, selectedPipelineIds: ["3"], stageLimits: { UC_ABC: 24 } },
    pipelines: new Map([["3", "IBOX Sales"]]),
    stages: new Map([["3:UC_ABC", "ОБРАБОТКА"]]),
    users: new Map([["7", "Sotuvchi"]]), domain: "example.bitrix24.com",
    now: new Date("2026-08-21T10:00:00+05:00"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "ОБРАБОТКА");
  assert.equal(rows[0].assignedManager, "Sotuvchi");
  assert.equal(rows[0].stageAgeHours, 25);
  assert.equal(rows[0].stageOverdue, true);
});

test("reconciliation Bitrix 91 va cache 57 orasidagi 34 ta farqni ko‘rsatadi", () => {
  const live = Array.from({ length: 91 }, (_, index) => ({ dealId: String(index + 1), stageId: "PROCESS" }) as CurrentStageRecord);
  const cached = Array.from({ length: 57 }, (_, index) => ({ dealId: String(index + 1), stageId: "PROCESS" }) as AnalyticsRecord);
  const result = reconcileCurrentStages(live, cached, "2026-08-21T00:00:00.000Z");
  assert.equal(result.liveCount, 91);
  assert.equal(result.cachedCount, 57);
  assert.equal(result.missingCount, 34);
  assert.equal(result.staleCount, 0);
});

const SALES_FUNNEL = "3";
const POST_SALE_FUNNEL = "13";

function liveOpen(dealId: string, stageId: string) {
  return { dealId, stageId } as CurrentStageRecord;
}
function cachedRecord(dealId: string, stageId: string, salesStatus: AnalyticsRecord["salesStatus"], categoryId = SALES_FUNNEL) {
  return { dealId, stageId, salesStatus, categoryId } as AnalyticsRecord;
}
function reconcile(live: CurrentStageRecord[], cached: AnalyticsRecord[]) {
  return reconcileCurrentStages(live, cached, "2026-08-21T00:00:00.000Z", { operationalCategoryIds: [SALES_FUNNEL] });
}

test("live ochiq va cache ACTIVE bir xil stage — hech qanday farq yo‘q", () => {
  const result = reconcile([liveOpen("1", "PROCESS")], [cachedRecord("1", "PROCESS", "ACTIVE")]);
  assert.equal(result.missingCount, 0);
  assert.equal(result.staleCount, 0);
  assert.equal(result.stageMismatchCount, 0);
});

test("Oplata olingan ochiq deal WON bo‘lsa ham missing hisoblanmaydi", () => {
  // Bitrix CLOSED=N, analytics salesStatus=WON. The WON classification alone
  // must never make a live open deal look absent from the cache.
  const result = reconcile([liveOpen("1", "PAYMENT")], [cachedRecord("1", "PAYMENT", "WON")]);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(result.missingDealIds, []);
  assert.equal(result.staleCount, 0);
  assert.equal(result.stageMismatchCount, 0);
  assert.equal(result.cachedCount, 1);
});

test("bir xil deal ikkala tomonda, lekin stage farq qilsa stageMismatch oshadi", () => {
  const result = reconcile([liveOpen("1", "PAYMENT")], [cachedRecord("1", "PROCESS", "ACTIVE")]);
  assert.equal(result.stageMismatchCount, 1);
  assert.equal(result.missingCount, 0);
  assert.equal(result.staleCount, 0);
});

test("faqat Bitrix’da bor deal missing hisoblanadi", () => {
  const result = reconcile([liveOpen("1", "PROCESS"), liveOpen("2", "PROCESS")], [cachedRecord("1", "PROCESS", "ACTIVE")]);
  assert.equal(result.missingCount, 1);
  assert.deepEqual(result.missingDealIds, ["2"]);
});

test("faqat cache’da ochiq deal stale hisoblanadi", () => {
  const result = reconcile([liveOpen("1", "PROCESS")], [cachedRecord("1", "PROCESS", "ACTIVE"), cachedRecord("2", "PROCESS", "ACTIVE")]);
  assert.equal(result.staleCount, 1);
  assert.deepEqual(result.staleDealIds, ["2"]);
  assert.equal(result.missingCount, 0);
});

test("post-sale funnel’dagi cache yozuvi Sales reconciliation’ini ifloslantirmaydi", () => {
  const result = reconcile(
    [liveOpen("1", "PROCESS")],
    [cachedRecord("1", "PROCESS", "ACTIVE"), cachedRecord("99", "OBUCHENIE", "WON", POST_SALE_FUNNEL)],
  );
  assert.equal(result.cachedCount, 1);
  assert.equal(result.missingCount, 0);
  assert.equal(result.staleCount, 0);
  assert.equal(result.stageMismatchCount, 0);
});

test("yopilgan WON/LOST cache yozuvlari stale sifatida ko‘rsatilmaydi", () => {
  // Guard against over-correcting: a deal the cache knows is finished and that
  // Bitrix no longer returns as open is simply closed, not stale.
  const result = reconcile(
    [liveOpen("1", "PROCESS")],
    [cachedRecord("1", "PROCESS", "ACTIVE"), cachedRecord("2", "PAYMENT", "WON"), cachedRecord("3", "CLOSED_LOST", "LOST")],
  );
  assert.equal(result.staleCount, 0);
  assert.equal(result.missingCount, 0);
  assert.equal(result.cachedCount, 3);
});

test("boshqa funnel’dagi cache yozuvlari hisobga olinmaydi", () => {
  const result = reconcile([liveOpen("1", "PROCESS")], [cachedRecord("1", "PROCESS", "ACTIVE"), cachedRecord("500", "X", "ACTIVE", "77")]);
  assert.equal(result.cachedCount, 1);
  assert.equal(result.staleCount, 0);
});
