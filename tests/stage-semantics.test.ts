import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { classifySalesStatus } from "../lib/sales-logic";
import { stageConfigConflicts, stageIdList } from "../lib/stage-config";
import type { DashboardSettings } from "../lib/types";

const MAIN = "3";
const CREATED = "2026-01-01T09:00:00+05:00";
const ENTERED = "2026-01-05T12:00:00+05:00";

/** Real analytics build; stage ID is held constant while the NAME varies. */
function build(o: { stageId: string; stageName: string; semantic?: string; config?: Partial<DashboardSettings>; history?: boolean }) {
  const histories = o.history === false ? [] : [{ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: o.stageId, CREATED_TIME: ENTERED, ...(o.semantic ? { STAGE_SEMANTIC_ID: o.semantic } : {}) }];
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, ASSIGNED_BY_ID: "7", CATEGORY_ID: MAIN, STAGE_ID: o.stageId, MOVED_TIME: ENTERED }],
    activities: [], callStats: [], stageHistories: histories, providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN], ...o.config },
    users: new Map([["7", "A"]]), pipelines: new Map([[MAIN, "IBOX Sales"]]),
    stages: new Map([[o.stageId, o.stageName]]), sources: new Map(),
    domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

test("Low quality 1: tanilgan nom, ID sozlanmagan → LOW_QUALITY", () => {
  const row = build({ stageId: "UC_NR", stageName: "Not Relevant" });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.lossReasonGroup, "MARKETING");
});

test("Low quality 2: nomi o‘zgargan, ID lowQualityStageIds’da → LOW_QUALITY", () => {
  const row = build({ stageId: "UC_NR", stageName: "Некачественный лид", config: { lowQualityStageIds: ["UC_NR"] } });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.lossReasonGroup, "MARKETING");
  assert.equal(row.qualified, false);
});

test("Low quality 3: semantic F bo‘lsa ham sozlangan ID marketing sifatsizligini saqlaydi", () => {
  const row = build({ stageId: "UC_NR", stageName: "Некачественный лид", semantic: "F", config: { lowQualityStageIds: ["UC_NR"] } });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.lossReasonGroup, "MARKETING");
  assert.equal(row.qualified, false);
});

test("Payment 4: tanilgan nom, ID sozlanmagan → WON", () => {
  assert.equal(build({ stageId: "UC_PAY", stageName: "Оплата получена" }).salesStatus, "WON");
});

test("Payment 5: nomi o‘zgargan, ID paymentStageIds’da → WON", () => {
  const row = build({ stageId: "UC_PAY", stageName: "Счёт оплачен", config: { paymentStageIds: ["UC_PAY"] } });
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.qualified, true);
});

test("Payment 6: nomi o‘zgargan + MOVED_TIME → wonAt Sprint 3 qoidasi bo‘yicha", () => {
  const row = build({ stageId: "UC_PAY", stageName: "Счёт оплачен", config: { paymentStageIds: ["UC_PAY"] }, history: false });
  assert.equal(row.salesStatus, "WON");
  assert.equal(row.wonAt, new Date(ENTERED).toISOString());
});

test("Closed lost 7: tanilgan nom, ID sozlanmagan → LOST / SALES", () => {
  const row = build({ stageId: "UC_LOST", stageName: "Закрыто и не реализовано" });
  assert.equal(row.salesStatus, "LOST");
  assert.equal(row.lossReasonGroup, "SALES");
});

test("Closed lost 8: nomi o‘zgargan, ID closedLostStageIds’da → LOST / SALES", () => {
  const row = build({ stageId: "UC_LOST", stageName: "Сделка провалена", config: { closedLostStageIds: ["UC_LOST"] } });
  assert.equal(row.salesStatus, "LOST");
  assert.equal(row.lossReasonGroup, "SALES");
});

test("Closed lost 9: ID sozlanmagan bo‘lsa semantic F fallback ishlaydi", () => {
  assert.equal(build({ stageId: "UC_LOST", stageName: "Сделка провалена", semantic: "F" }).salesStatus, "LOST");
  assert.equal(build({ stageId: "UC_LOST", stageName: "Сделка провалена" }).salesStatus, "ACTIVE");
});

test("SQL 10: nomi o‘zgargan bosqich qualifiedStageIds bilan SQL bo‘lib qoladi", () => {
  assert.equal(build({ stageId: "UC_SQL", stageName: "Первичный контакт", config: { qualifiedStageIds: ["UC_SQL"] } }).qualified, true);
  assert.equal(build({ stageId: "UC_SQL", stageName: "Первичный контакт" }).qualified, false);
});

test("SQL 11: Not Relevant bosqichi qualifiedStageIds’ga tushib qolsa ham SQL bo‘lmaydi", () => {
  const row = build({ stageId: "UC_NR", stageName: "Некачественный лид", config: { lowQualityStageIds: ["UC_NR"], qualifiedStageIds: ["UC_NR"] } });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.qualified, false);
});

test("Backward compat 12: bo‘sh massivlar bilan tasniflash o‘zgarmaydi", () => {
  const cases: [string, string, string][] = [
    ["UC_NR", "Not Relevant", "LOW_QUALITY"], ["UC_PAY", "Оплата получена", "WON"],
    ["UC_LOST", "Закрыто и не реализовано", "LOST"], ["UC_SQL", "Обработка", "ACTIVE"],
    ["UC_X", "Некачественный лид", "ACTIVE"], ["UC_Y", "Счёт оплачен", "ACTIVE"],
  ];
  for (const [stageId, stageName, expected] of cases) {
    assert.equal(build({ stageId, stageName }).salesStatus, expected, `${stageName}`);
  }
  assert.equal(build({ stageId: "UC_SQL", stageName: "Обработка" }).qualified, true);
  // Historical payment still outranks a later low-quality stage, exactly as before.
  assert.equal(classifySalesStatus({ stage: "Not Relevant", paymentReached: true, inPostSalePipeline: false }), "WON");
});

test("Conflict 13: bir ID lowQuality + payment’da bo‘lsa LOW_QUALITY ustun", () => {
  const row = build({ stageId: "UC_DUP", stageName: "Aralash", config: { lowQualityStageIds: ["UC_DUP"], paymentStageIds: ["UC_DUP"] } });
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.wonAt, null);
});

test("Conflict 14: bir ID payment + closedLost’da bo‘lsa WON ustun", () => {
  const row = build({ stageId: "UC_DUP", stageName: "Aralash", config: { paymentStageIds: ["UC_DUP"], closedLostStageIds: ["UC_DUP"] } });
  assert.equal(row.salesStatus, "WON");
});

test("Settings 15: uchala yangi massiv normallashtiriladi va konflikt aniqlanadi", () => {
  assert.deepEqual(stageIdList(["A", "A", "", "B", 7]), ["A", "B", "7"]);
  assert.deepEqual(stageConfigConflicts({ lowQualityStageIds: ["X"], paymentStageIds: ["X"], closedLostStageIds: ["Y"] }),
    [{ stageId: "X", groups: ["Not Relevant", "Sotuv / To‘lov"] }]);
  assert.deepEqual(stageConfigConflicts({ lowQualityStageIds: ["X"], paymentStageIds: ["Y"] }), []);
});

test("Settings 16: eski sozlamalarda maydonlar yo‘q bo‘lsa xavfsiz [] bo‘ladi", () => {
  for (const legacy of [undefined, null, "not-an-array", {}, 5]) {
    assert.deepEqual(stageIdList(legacy), []);
  }
  assert.deepEqual(defaultSettings.lowQualityStageIds, []);
  assert.deepEqual(defaultSettings.paymentStageIds, []);
  assert.deepEqual(defaultSettings.closedLostStageIds, []);
  assert.deepEqual(stageConfigConflicts({}), []);
});
