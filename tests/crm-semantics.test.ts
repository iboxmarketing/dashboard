import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";
import { classifyLossReasonGroup, isEligibleCohortDeal, isSqlOrDownstreamStage } from "../lib/sales-logic";
import { sqlThresholdsByCategory, type StageMeta } from "../lib/stage-config";
import type { AnalyticsRecord, DashboardSettings } from "../lib/types";

const IBOX = "3", SD = "5";
const CREATED = "2026-08-17T10:00:00+05:00";
const at = (clock: string) => `2026-08-17T${clock}:00+05:00`;

// Live IBOX pipeline order, as crm.status.list returns it (SORT ascending).
const STAGE_META = new Map<string, StageMeta>([
  ["C3:NEW", { sort: 10, categoryId: IBOX }],
  ["C3:NOANSWER", { sort: 20, categoryId: IBOX }],
  ["C3:SQL", { sort: 30, categoryId: IBOX }],
  ["C3:VSTRECHA", { sort: 40, categoryId: IBOX }],
  ["C3:SOGLASIE", { sort: 50, categoryId: IBOX }],
  ["C3:PAYMENT", { sort: 60, categoryId: IBOX }],
  ["C3:NR", { sort: 70, categoryId: IBOX }],
  ["C3:LOST", { sort: 80, categoryId: IBOX }],
  ["C5:SQL", { sort: 30, categoryId: SD }],
]);
const STAGE_NAMES = new Map<string, string>([
  ["C3:NEW", "Yangi"], ["C3:NOANSWER", "No Answer"], ["C3:SQL", "Обработка"],
  ["C3:VSTRECHA", "Встреча"], ["C3:SOGLASIE", "Согласие"], ["C3:PAYMENT", "Оплата получена"],
  ["C3:NR", "Not Relevant"], ["C3:LOST", "Закрыто и не реализовано"], ["C5:SQL", "Обработка"],
]);
const SOURCES = new Map([["1", "CRM-форма"], ["7", "Холодный звонок"], ["12", "Сарафан"]]);

const IBOX_REASON = "UF_CRM_1748329407554";
const SD_REASON = "UF_CRM_1742389301";
const FIELD_OPTIONS = new Map([
  [IBOX_REASON, new Map([["7087", "передано SD"], ["7091", "дорого"]])],
  [SD_REASON, new Map([["6891", "Передали ibox"], ["6895", "дорого"]])],
]);

function settings(over: Partial<DashboardSettings> = {}): DashboardSettings {
  return {
    ...defaultSettings, selectedPipelineIds: [IBOX, SD], qualifiedStageIds: ["C3:SQL", "C5:SQL"],
    lowQualityStageIds: ["C3:NR"], paymentStageIds: ["C3:PAYMENT"], closedLostStageIds: ["C3:LOST"],
    failureReasonFieldByPipeline: { [IBOX]: IBOX_REASON, [SD]: SD_REASON },
    routingReasonPatterns: ["idoko", "sd", "передан"], ...over,
  };
}

function build(o: { stageId: string; history?: { stageId: string; clock: string }[]; deal?: Record<string, unknown>; categoryId?: string; over?: Partial<DashboardSettings>; stages?: Map<string, string> }) {
  const categoryId = o.categoryId ?? IBOX;
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, ASSIGNED_BY_ID: "7", CATEGORY_ID: categoryId, STAGE_ID: o.stageId, MOVED_TIME: at("12:00"), ...o.deal }],
    activities: [], callStats: [],
    stageHistories: (o.history ?? []).map((row) => ({ OWNER_ID: "1", CATEGORY_ID: categoryId, STAGE_ID: row.stageId, CREATED_TIME: at(row.clock) })),
    providerRules: {}, settings: settings(o.over), users: new Map([["7", "Aziz"]]),
    pipelines: new Map([[IBOX, "IBOX Sales"], [SD, "SD Sales"]]),
    stages: o.stages ?? STAGE_NAMES, stageMeta: STAGE_META, sources: SOURCES,
    fieldOptions: FIELD_OPTIONS, domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

test("1: SOURCE_ID lug‘at orqali o‘qiladigan nomga aylanadi", () => {
  assert.equal(build({ stageId: "C3:SQL", deal: { SOURCE_ID: "1" } }).source, "CRM-форма");
  assert.equal(build({ stageId: "C3:SQL", deal: { SOURCE_ID: "12" } }).source, "Сарафан");
  assert.equal(build({ stageId: "C3:SQL", deal: { SOURCE_ID: "1" } }).sourceId, "1");
});

test("2: Source filtri bo‘yicha ajratish — faqat mos deal’lar", () => {
  const rows = [
    build({ stageId: "C3:SQL", deal: { ID: "1", SOURCE_ID: "1" } }),
    build({ stageId: "C3:SQL", deal: { ID: "2", SOURCE_ID: "7" } }),
  ];
  assert.deepEqual(rows.filter((r) => r.source === "CRM-форма").map((r) => r.source), ["CRM-форма"]);
  assert.equal(rows.filter((r) => r.source === "Холодный звонок").length, 1);
});

test("3: SOURCE_ID yo‘q bo‘lsa Aniqlanmagan", () => {
  assert.equal(build({ stageId: "C3:SQL", deal: { SOURCE_ID: "" } }).source, "Aniqlanmagan");
});

test("4: IBOX provala sababi enum ID → nom", () => {
  const row = build({ stageId: "C3:LOST", deal: { [IBOX_REASON]: "7087" } });
  assert.equal(row.lossReason, "передано SD");
});

test("5: SD provala sababi o‘z maydonidan o‘qiladi", () => {
  const row = build({ stageId: "C5:SQL", categoryId: SD, deal: { [SD_REASON]: "6891" }, stages: STAGE_NAMES });
  assert.equal(row.lossReason, "Передали ibox");
});

test("6: sabab matni emas, bosqich hokim", () => {
  const nr = build({ stageId: "C3:NR", deal: { [IBOX_REASON]: "7091" } });
  assert.equal(nr.salesStatus, "LOW_QUALITY");
  assert.equal(nr.lossReasonGroup, "MARKETING");
  const lost = build({ stageId: "C3:LOST", deal: { [IBOX_REASON]: "7091" } });
  assert.equal(lost.salesStatus, "LOST");
  assert.equal(lost.lossReasonGroup, "SALES");
});

test("7: routing deal eligible cohort maxrajidan chiqariladi", () => {
  const rows = [
    { lossReasonGroup: "NONE" }, { lossReasonGroup: "MARKETING" }, { lossReasonGroup: "ROUTING" },
  ] as AnalyticsRecord[];
  assert.equal(rows.filter(isEligibleCohortDeal).length, 2);
  assert.equal(isEligibleCohortDeal({ lossReasonGroup: "ROUTING" }), false);
});

test("8: routing deal xom/diagnostika populyatsiyasida qoladi", () => {
  const routed = build({ stageId: "C3:LOST", deal: { [IBOX_REASON]: "7087" } });
  assert.equal(classifyLossReasonGroup({ status: "LOST", reason: "передано SD", routingPatterns: ["передан"] }), "ROUTING");
  assert.equal(routed.dealId, "1", "yozuv o‘chirilmaydi");
  assert.equal(routed.lossReason, "передано SD");
});

test("9: oddiy Обработка → qualified", () => {
  const row = build({ stageId: "C3:SQL", history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:SQL", clock: "10:07" }] });
  assert.equal(row.qualified, true);
});

test("10: Обработка o‘tkazib yuborilib Встреча → qualified", () => {
  const row = build({ stageId: "C3:VSTRECHA", history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:VSTRECHA", clock: "10:07" }] });
  assert.equal(row.qualified, true);
});

test("11: Обработка o‘tkazib yuborilib Оплата → qualified va WON", () => {
  const row = build({ stageId: "C3:PAYMENT", history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:PAYMENT", clock: "10:09" }] });
  assert.equal(row.qualified, true);
  assert.equal(row.salesStatus, "WON");
});

test("12: Not Relevant hech qachon qualified emas", () => {
  const row = build({ stageId: "C3:NR", history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:SQL", clock: "10:05" }, { stageId: "C3:NR", clock: "11:00" }] });
  assert.equal(row.qualified, false);
  assert.equal(row.salesStatus, "LOW_QUALITY");
});

test("13: downstream aniqlash SORT/ID bo‘yicha, nom bo‘yicha emas", () => {
  const thresholds = sqlThresholdsByCategory(["C3:SQL"], STAGE_META);
  assert.equal(thresholds.get(IBOX), 30);
  const base = { thresholds, stageMeta: STAGE_META, config: { lowQualityStageIds: ["C3:NR"], closedLostStageIds: ["C3:LOST"] } };
  assert.equal(isSqlOrDownstreamStage({ ...base, stageId: "C3:VSTRECHA", stage: "Zzz", categoryId: IBOX }), true);
  assert.equal(isSqlOrDownstreamStage({ ...base, stageId: "C3:NOANSWER", stage: "Zzz", categoryId: IBOX }), false, "SQL’dan oldingi bosqich");
  assert.equal(isSqlOrDownstreamStage({ ...base, stageId: "C3:NR", stage: "Zzz", categoryId: IBOX }), false, "Not Relevant");
  assert.equal(isSqlOrDownstreamStage({ ...base, stageId: "C3:VSTRECHA", stage: "Zzz", categoryId: SD }), false, "boshqa pipeline chegarasi");
});

test("14: nomi o‘zgargan downstream bosqich baribir qualified", () => {
  const renamed = new Map(STAGE_NAMES); renamed.set("C3:VSTRECHA", "Первичная демонстрация");
  const row = build({ stageId: "C3:VSTRECHA", stages: renamed, history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:VSTRECHA", clock: "10:07" }] });
  assert.equal(row.qualified, true);
});

test("15-17: eligible cohort maxraji Lead→SQL, Not Relevant va Lead→Sotuv uchun", () => {
  const rows = [
    { qualified: true, salesStatus: "WON", lossReasonGroup: "NONE" },
    { qualified: true, salesStatus: "ACTIVE", lossReasonGroup: "NONE" },
    { qualified: false, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" },
    { qualified: true, salesStatus: "LOST", lossReasonGroup: "ROUTING" },
    { qualified: true, salesStatus: "LOST", lossReasonGroup: "ROUTING" },
  ] as AnalyticsRecord[];
  const eligible = rows.filter(isEligibleCohortDeal);
  assert.equal(rows.length, 5, "xom populyatsiya saqlanadi");
  assert.equal(eligible.length, 3);
  assert.equal(Math.round((eligible.filter((r) => r.qualified).length / eligible.length) * 100), 67, "Lead→SQL");
  assert.equal(Math.round((eligible.filter((r) => r.lossReasonGroup === "MARKETING").length / eligible.length) * 100), 33, "Not Relevant rate");
  assert.equal(Math.round((eligible.filter((r) => r.salesStatus === "WON").length / eligible.length) * 100), 33, "Lead→Sotuv");
});

test("18: Обработка o‘tkazib yuborilganda birinchi ishlov downstream bosqich vaqti", () => {
  const row = build({ stageId: "C3:VSTRECHA", history: [{ stageId: "C3:NEW", clock: "10:00" }, { stageId: "C3:VSTRECHA", clock: "10:07" }] });
  assert.equal(row.processingAt, new Date(at("10:07")).toISOString());
  assert.equal(row.processingBusinessMinutes, 7);
  assert.equal(row.qualifiedStageId, "C3:VSTRECHA", "soxta Обработка hodisasi yaratilmaydi");
  // An intermediate pre-SQL stage still does not stop the timer.
  const noanswer = build({ stageId: "C3:VSTRECHA", history: [{ stageId: "C3:NOANSWER", clock: "10:02" }, { stageId: "C3:VSTRECHA", clock: "10:15" }] });
  assert.equal(noanswer.processingBusinessMinutes, 15);
});

test("Sprint 16: sync qo‘ng‘iroq/telephony API’larini chaqirmaydi", async () => {
  const sync = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/sync.ts", import.meta.url), "utf8"));
  for (const method of ["crm.activity.list", "voximplant.statistic.get", "telephony."]) {
    assert.equal(sync.includes(method), false, `${method} chaqirilmasligi kerak`);
  }
  for (const step of ["activityStep", "telephonyStep"]) {
    assert.equal(sync.includes(step), false, `${step} olib tashlanishi kerak`);
  }
  // Deals, stage history, users and dictionaries remain.
  for (const method of ["crm.deal.list", "crm.stagehistory.list", "user.get", "crm.status.list"]) {
    assert.ok(sync.includes(method), `${method} saqlanishi kerak`);
  }
});

test("Sprint 16: diagnostika Telephony ruxsatini talab qilmaydi", async () => {
  const ui = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"));
  assert.equal(/permissions\.telephony/.test(ui), false);
  assert.equal(/permissions\.activities/.test(ui), false);
  assert.equal(ui.includes("Call providers"), false);
});

test("Sprint 16: Source filtri o‘qiladigan nomlarni ishlatadi", () => {
  const rows = [
    build({ stageId: "C3:SQL", deal: { ID: "1", SOURCE_ID: "1" } }),
    build({ stageId: "C3:SQL", deal: { ID: "2", SOURCE_ID: "" } }),
  ];
  const options = [...new Set(rows.map((r) => r.source))].sort();
  assert.deepEqual(options, ["Aniqlanmagan", "CRM-форма"]);
  assert.equal(options.some((option) => /^\d+$/.test(option)), false, "xom SOURCE_ID ko‘rsatilmaydi");
});

test("17.1: UF_CRM kalitlari kanonik shaklga keltiriladi", async () => {
  const { canonicalDealFieldKey, canonicalizeFieldOptions, isCustomDealField } = await import("../lib/crm-fields");
  assert.equal(canonicalDealFieldKey("ufCrm_1748329407554"), "UF_CRM_1748329407554");
  assert.equal(canonicalDealFieldKey("UF_CRM_1748329407554"), "UF_CRM_1748329407554");
  assert.equal(canonicalDealFieldKey("ufcrm1742389301"), "UF_CRM_1742389301");
  assert.equal(canonicalDealFieldKey("SOURCE_ID"), "SOURCE_ID", "standart maydon o‘zgarmaydi");
  assert.equal(isCustomDealField("ufCrm_x"), true);
  assert.equal(isCustomDealField("TITLE"), false);

  // Both spellings collapse to ONE option carrying the richer metadata.
  const collapsed = canonicalizeFieldOptions([
    { key: "ufCrm_1748329407554", title: "причина провала", type: "enumeration", options: [{ id: "7087", value: "передано SD" }] },
    { key: "UF_CRM_1748329407554", title: "Custom field UF_CRM_1748329407554", type: "unknown", options: [] },
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].key, "UF_CRM_1748329407554");
  assert.equal(collapsed[0].title, "причина провала");
  assert.equal(collapsed[0].options.length, 1);
});

test("17.1: eski camelCase sozlama bilan ham sabab o‘qiladi", () => {
  // Legacy settings hold ufCrm_...; the deal payload only ever has UF_CRM_...
  const row = build({
    stageId: "C3:LOST",
    deal: { UF_CRM_1748329407554: "7087" },
    over: { failureReasonFieldByPipeline: {}, failureReasonField: "ufCrm_1748329407554" },
  });
  assert.equal(row.lossReason, "передано SD");
});
