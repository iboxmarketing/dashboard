import assert from "node:assert/strict";
import test from "node:test";
import { calculateBusinessMinutes, defaultSettings, getSlaStart } from "../lib/business-time";
import { buildAnalyticsRecords } from "../lib/analytics";

function utc(local: string) {
  return new Date(`${local}:00+05:00`);
}

test("Monday 10:00 to 10:07 is 7 business minutes", () => {
  assert.equal(calculateBusinessMinutes(utc("2026-08-17T10:00"), utc("2026-08-17T10:07"), defaultSettings), 7);
});

test("after-hours SLA starts on Tuesday opening", () => {
  const created = utc("2026-08-17T22:00");
  const call = utc("2026-08-18T09:07");
  assert.equal(getSlaStart(created, defaultSettings).toISOString(), utc("2026-08-18T09:00").toISOString());
  assert.equal(calculateBusinessMinutes(getSlaStart(created, defaultSettings), call, defaultSettings), 7);
});

test("overnight working time is summed across two work periods", () => {
  assert.equal(calculateBusinessMinutes(utc("2026-08-17T17:50"), utc("2026-08-18T09:10"), defaultSettings), 20);
});

test("Friday after-hours to Monday 09:15 is 15 minutes", () => {
  const start = getSlaStart(utc("2026-08-21T20:00"), defaultSettings);
  assert.equal(calculateBusinessMinutes(start, utc("2026-08-24T09:15"), defaultSettings), 15);
});

test("Saturday Deal to Monday 09:04 is 4 minutes", () => {
  const start = getSlaStart(utc("2026-08-22T13:00"), defaultSettings);
  assert.equal(calculateBusinessMinutes(start, utc("2026-08-24T09:04"), defaultSettings), 4);
});

function analytics(overrides: { callAt?: string; stageAt?: string; failedCode?: string }) {
  const createdAt = "2026-08-17T09:00:00+05:00";
  const activities = overrides.callAt ? [{
    ID: "90", OWNER_ID: "42", OWNER_TYPE_ID: "2", BINDINGS: [{ OWNER_ID: "42", OWNER_TYPE_ID: "2" }],
    TYPE_ID: "2", PROVIDER_ID: "VOXIMPLANT_CALL", PROVIDER_TYPE_ID: "CALL", DIRECTION: "2",
    START_TIME: `${overrides.callAt}:00+05:00`, CREATED: `${overrides.callAt}:00+05:00`, RESPONSIBLE_ID: "7",
  }] : [];
  const stageHistories = overrides.stageAt ? [
    { OWNER_ID: "42", STAGE_ID: "NEW", CREATED_TIME: createdAt },
    { OWNER_ID: "42", STAGE_ID: "IN_PROCESS", CREATED_TIME: `${overrides.stageAt}:00+05:00` },
  ] : [];
  return buildAnalyticsRecords({
    deals: [{ ID: "42", TITLE: "Test Deal", DATE_CREATE: createdAt, ASSIGNED_BY_ID: "7", CATEGORY_ID: "0", STAGE_ID: "IN_PROCESS", SOURCE_ID: "WEB" }],
    activities,
    stageHistories,
    callStats: overrides.callAt ? [{ CRM_ACTIVITY_ID: "90", CALL_START_DATE: `${overrides.callAt}:00+05:00`, CALL_DURATION: "0", CALL_FAILED_CODE: overrides.failedCode ?? "304" }] : [],
    settings: defaultSettings,
    providerRules: {},
    users: new Map([["7", "Aziz Karimov"]]), pipelines: new Map([["0", "Asosiy"]]),
    stages: new Map([["IN_PROCESS", "Обработка"]]), sources: new Map([["WEB", "Web"]]),
    domain: "example.bitrix24.com", activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}

test("birinchi ishlov SQL bosqichiga o‘tganda qayd etiladi", () => {
  const row = analytics({ stageAt: "2026-08-17T09:13" });
  assert.equal(row.processingSource, "QUALIFICATION_STAGE");
  assert.equal(row.processingBusinessMinutes, 13);
});

test("qo‘ng‘iroq birinchi ishlov vaqtini to‘xtatmaydi", () => {
  // Superseded rule: the outgoing call used to win. Call coverage is uneven
  // across sellers, so only the CRM-recorded qualification outcome counts now.
  const row = analytics({ stageAt: "2026-08-17T09:13", callAt: "2026-08-17T09:04" });
  assert.equal(row.processingSource, "QUALIFICATION_STAGE");
  assert.equal(row.processingBusinessMinutes, 13);
  assert.equal(row.firstCallBusinessMinutes, null, "qo‘ng‘iroqlar endi umuman sinxronlanmaydi");
});

test("faqat qo‘ng‘iroq bo‘lsa, ishlov qayd etilmagan hisoblanadi", () => {
  const row = analytics({ callAt: "2026-08-17T09:05", failedCode: "304" });
  assert.equal(row.processingBusinessMinutes, null);
  assert.equal(row.processingSource, "NO_PROCESSING_EVIDENCE");
  assert.equal(row.firstCallOutcome, "Noma’lum", "qo‘ng‘iroq natijasi endi olinmaydi");
});

test("Not Relevant oldin Obrabotka bo‘lgan bo‘lsa ham marketing sifatsizligi bo‘lib qoladi", () => {
  const settings = { ...defaultSettings, selectedPipelineIds: ["0"] };
  const row = buildAnalyticsRecords({
    deals: [{ ID: "77", TITLE: "Historical SQL", DATE_CREATE: "2026-08-17T09:00:00+05:00", DATE_MODIFY: "2026-08-18T09:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: "0", STAGE_ID: "NOT_RELEVANT" }],
    activities: [], callStats: [], providerRules: {}, settings,
    stageHistories: [
      { OWNER_ID: "77", CATEGORY_ID: "0", STAGE_ID: "NEW", CREATED_TIME: "2026-08-17T09:00:00+05:00" },
      { OWNER_ID: "77", CATEGORY_ID: "0", STAGE_ID: "IN_PROCESS", CREATED_TIME: "2026-08-17T09:10:00+05:00" },
      { OWNER_ID: "77", CATEGORY_ID: "0", STAGE_ID: "NOT_RELEVANT", STAGE_SEMANTIC_ID: "F", CREATED_TIME: "2026-08-18T09:00:00+05:00" },
    ],
    users: new Map([["7", "Aziz Karimov"]]), pipelines: new Map([["0", "IBOX Sales"]]),
    stages: new Map([["NEW", "Yangi"], ["IN_PROCESS", "Обработка"], ["NOT_RELEVANT", "Not Relevant"]]), sources: new Map(),
    domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
  assert.equal(row.qualified, false);
  assert.equal(row.qualifiedStage, null);
  assert.equal(row.salesStatus, "LOW_QUALITY");
  assert.equal(row.lossReasonGroup, "MARKETING");
  assert.equal(row.stageTimeline.length, 3);
});
