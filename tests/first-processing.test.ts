import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRecords } from "../lib/analytics";
import { calculateBusinessMinutes, defaultSettings, getSlaStart } from "../lib/business-time";
import type { DashboardSettings } from "../lib/types";

const MAIN = "3";
const CREATED = "2026-08-17T10:00:00+05:00";           // Monday 10:00 Tashkent
const at = (clock: string) => `2026-08-17T${clock}:00+05:00`;
const SQL_ID = "UC_SQL", NR_ID = "UC_NR", NOANSWER_ID = "UC_NOANSWER", MEETING_ID = "UC_MEETING";

const call = (clock: string) => ({
  ID: "90", OWNER_ID: "1", OWNER_TYPE_ID: "2", BINDINGS: [{ OWNER_ID: "1", OWNER_TYPE_ID: "2" }],
  TYPE_ID: "2", PROVIDER_ID: "VOXIMPLANT_CALL", DIRECTION: "2",
  START_TIME: at(clock), CREATED: at(clock), RESPONSIBLE_ID: "5",
});

function build(o: {
  stageId: string; stageName?: string; movedTime?: string;
  history?: { stageId: string; clock: string }[]; calls?: string[];
  config?: Partial<DashboardSettings>; stages?: [string, string][];
}) {
  return buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: CREATED, ASSIGNED_BY_ID: "7", CATEGORY_ID: MAIN, STAGE_ID: o.stageId, ...(o.movedTime ? { MOVED_TIME: at(o.movedTime) } : {}) }],
    activities: (o.calls ?? []).map(call), callStats: [],
    stageHistories: (o.history ?? []).map((row) => ({ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: row.stageId, CREATED_TIME: at(row.clock) })),
    providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: [MAIN], ...o.config },
    users: new Map([["7", "Aziz"], ["5", "Call operator"]]), pipelines: new Map([[MAIN, "IBOX Sales"]]),
    stages: new Map<string, string>([[SQL_ID, "Обработка"], [NR_ID, "Not Relevant"], [NOANSWER_ID, "No Answer"], [MEETING_ID, "Uchrashuv"], ...(o.stages ?? [])]),
    sources: new Map(), domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
}
const minutes = (clock: string) => calculateBusinessMinutes(getSlaStart(new Date(CREATED), defaultSettings), new Date(at(clock)), defaultSettings);

test("1: SQL bosqichiga o‘tish birinchi ishlovni qayd etadi", () => {
  const row = build({ stageId: SQL_ID, history: [{ stageId: "NEW", clock: "10:00" }, { stageId: SQL_ID, clock: "10:07" }] });
  assert.equal(row.processingAt, new Date(at("10:07")).toISOString());
  assert.equal(row.processingSource, "QUALIFICATION_STAGE");
  assert.equal(row.processingBusinessMinutes, 7);
});

test("2: Not Relevant bosqichiga o‘tish ham birinchi ishlov", () => {
  const row = build({ stageId: NR_ID, history: [{ stageId: "NEW", clock: "10:00" }, { stageId: NR_ID, clock: "10:04" }] });
  assert.equal(row.processingAt, new Date(at("10:04")).toISOString());
  assert.equal(row.processingBusinessMinutes, 4);
});

test("3: SQL’dan oldingi qo‘ng‘iroq taymerni to‘xtatmaydi", () => {
  const row = build({ stageId: SQL_ID, calls: ["10:02"], history: [{ stageId: "NEW", clock: "10:00" }, { stageId: SQL_ID, clock: "10:08" }] });
  assert.equal(row.processingBusinessMinutes, 8);
  assert.equal(row.firstCallBusinessMinutes, null, "qo‘ng‘iroq ma’lumoti umuman olinmaydi");
});

test("4: SQL’dan keyingi qo‘ng‘iroq ishlov vaqtini o‘zgartirmaydi", () => {
  const row = build({ stageId: SQL_ID, calls: ["10:20"], history: [{ stageId: "NEW", clock: "10:00" }, { stageId: SQL_ID, clock: "10:03" }] });
  assert.equal(row.processingBusinessMinutes, 3);
});

test("5: No Answer kabi oraliq bosqich taymerni to‘xtatmaydi", () => {
  const row = build({ stageId: SQL_ID, history: [{ stageId: "NEW", clock: "10:00" }, { stageId: NOANSWER_ID, clock: "10:02" }, { stageId: SQL_ID, clock: "10:15" }] });
  assert.equal(row.processingAt, new Date(at("10:15")).toISOString());
  assert.equal(row.processingBusinessMinutes, 15);
});

test("6: tarix yo‘q, joriy stage SQL → MOVED_TIME ishlatiladi", () => {
  const row = build({ stageId: SQL_ID, movedTime: "10:06", history: [] });
  assert.equal(row.processingAt, new Date(at("10:06")).toISOString());
  assert.equal(row.processingBusinessMinutes, 6);
  assert.equal(row.processingSource, "QUALIFICATION_STAGE");
});

test("7: tarix yo‘q, joriy stage Not Relevant → MOVED_TIME ishlatiladi", () => {
  const row = build({ stageId: NR_ID, movedTime: "10:05", history: [] });
  assert.equal(row.processingAt, new Date(at("10:05")).toISOString());
  assert.equal(row.processingBusinessMinutes, 5);
});

test("8: tarix yo‘q, joriy stage keyingi bosqich → ishlov vaqti to‘qib chiqarilmaydi", () => {
  const row = build({ stageId: MEETING_ID, movedTime: "14:00", history: [] });
  assert.equal(row.processingAt, null);
  assert.equal(row.processingBusinessMinutes, null);
  assert.equal(row.processingSource, "NO_PROCESSING_EVIDENCE");
  assert.equal(row.slaStatus, "UNKNOWN_EVIDENCE", "dalil yo‘q — SLA maxrajiga kirmaydi");
});

test("9: nomi o‘zgargan bosqichlar sozlangan ID bilan aniqlanadi", () => {
  const renamed: [string, string][] = [["X_SQL", "Первичный контакт"], ["X_NR", "Некачественный лид"]];
  const sql = build({ stageId: "X_SQL", stages: renamed, config: { qualifiedStageIds: ["X_SQL"] }, history: [{ stageId: "NEW", clock: "10:00" }, { stageId: "X_SQL", clock: "10:09" }] });
  assert.equal(sql.processingBusinessMinutes, 9);
  const nr = build({ stageId: "X_NR", stages: renamed, config: { lowQualityStageIds: ["X_NR"] }, history: [{ stageId: "NEW", clock: "10:00" }, { stageId: "X_NR", clock: "10:11" }] });
  assert.equal(nr.processingBusinessMinutes, 11);
  // Without configuration the renamed stages are not recognised.
  assert.equal(build({ stageId: "X_SQL", stages: renamed, history: [{ stageId: "X_SQL", clock: "10:09" }] }).processingBusinessMinutes, null);
});

test("10: ish vaqti, bayram va Asia/Tashkent qoidalari saqlanadi", () => {
  // Saturday creation -> SLA starts Monday 09:00; SQL entered Monday 09:12.
  const weekend = buildAnalyticsRecords({
    deals: [{ ID: "1", TITLE: "T", DATE_CREATE: "2026-08-22T13:00:00+05:00", ASSIGNED_BY_ID: "7", CATEGORY_ID: MAIN, STAGE_ID: SQL_ID }],
    activities: [], callStats: [],
    stageHistories: [{ OWNER_ID: "1", CATEGORY_ID: MAIN, STAGE_ID: SQL_ID, CREATED_TIME: "2026-08-24T09:12:00+05:00" }],
    providerRules: {}, settings: { ...defaultSettings, selectedPipelineIds: [MAIN] },
    users: new Map(), pipelines: new Map([[MAIN, "IBOX Sales"]]), stages: new Map([[SQL_ID, "Обработка"]]),
    sources: new Map(), domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  })[0];
  assert.equal(weekend.processingBusinessMinutes, 12, "dam olish kunlari hisoblanmaydi");
  const holiday = build({ stageId: SQL_ID, history: [{ stageId: SQL_ID, clock: "10:07" }], config: { holidays: ["2026-08-17"] } });
  assert.equal(holiday.processingBusinessMinutes, 0, "bayram kuni ish minutlari hisoblanmaydi");
});

test("11: SLA endi SQL bosqichiga ko‘ra hisoblanadi", () => {
  // Call at minute 2, SQL at minute 15, SLA target 10.
  const row = build({ stageId: SQL_ID, calls: ["10:02"], history: [{ stageId: "NEW", clock: "10:00" }, { stageId: SQL_ID, clock: "10:15" }] });
  assert.equal(row.processingBusinessMinutes, 15);
  assert.equal(row.slaStatus, "LATE", "eski call-priority mantiqi ON_TIME ko‘rsatar edi");
  assert.equal(minutes("10:02"), 2, "qo‘ng‘iroq vaqti hali ham hisoblanadi, lekin SLA’ni to‘xtatmaydi");
});

test("12: qo‘ng‘iroq endi sotuvchi atributsiyasiga ta’sir qilmaydi", () => {
  // Sprint 16 removed CALL from the chain; the next valid fallback wins.
  const row = build({ stageId: SQL_ID, calls: ["10:02"], history: [{ stageId: SQL_ID, clock: "10:07" }] });
  assert.equal(row.salesManagerId, "7", "ASSIGNED_BY_ID fallback");
  assert.equal(row.salesManagerAttribution, "CURRENT_RESPONSIBLE");
  assert.equal(row.outgoingCallCount, 0, "qo‘ng‘iroqlar sinxronlanmaydi");
});
