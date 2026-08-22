import assert from "node:assert/strict";
import test from "node:test";
import { compareDealIds, countDuplicates, isDuplicate, markDuplicates } from "../lib/duplicates";
import { buildAnalyticsRecords } from "../lib/analytics";
import { defaultSettings } from "../lib/business-time";

type Row = { dealId: string; createdAt: string; customerKey: string | null; duplicateOfDealId: string | null; qualified?: boolean; salesStatus?: string; lossReasonGroup?: string };

function row(dealId: string, createdAt: string, customerKey: string | null, extra: Partial<Row> = {}): Row {
  return { dealId, createdAt, customerKey, duplicateOfDealId: null, ...extra };
}
const at = (day: string) => `2026-0${day}T10:00:00.000Z`;
const byId = (rows: Row[]) => new Map(rows.map((item) => [item.dealId, item.duplicateOfDealId]));

test("Case 1: bitta mijoz, bitta deal — takror yo‘q", () => {
  const result = markDuplicates([row("101", at("1-01"), "contact:1")]);
  assert.equal(countDuplicates(result), 0);
  assert.equal(result[0].duplicateOfDealId, null);
});

test("Case 2: bir xil Contact ID’li ikkita deal — ikkinchisi takror", () => {
  const result = markDuplicates([row("205", at("2-01"), "contact:1"), row("101", at("1-01"), "contact:1")]);
  const map = byId(result);
  assert.equal(map.get("101"), null);
  assert.equal(map.get("205"), "101");
  assert.equal(countDuplicates(result), 1);
});

test("Case 3: uchta deal — ikkitasi eng erkin originalga ishora qiladi", () => {
  const result = markDuplicates([
    row("310", at("3-01"), "contact:1"), row("101", at("1-01"), "contact:1"), row("205", at("2-01"), "contact:1"),
  ]);
  const map = byId(result);
  assert.equal(map.get("101"), null);
  assert.equal(map.get("205"), "101");
  assert.equal(map.get("310"), "101");
  assert.equal(countDuplicates(result), 2);
});

test("Case 4: Contact ID yo‘q, Company ID bo‘yicha guruhlanadi", () => {
  const result = markDuplicates([row("2", at("2-01"), "company:55"), row("1", at("1-01"), "company:55")]);
  assert.equal(byId(result).get("1"), null);
  assert.equal(byId(result).get("2"), "1");
  assert.equal(countDuplicates(result), 1);
});

test("Case 5: Contact ID Company ID’dan ustun turadi", () => {
  // customerKey priority is built in buildAnalyticsRecords; assert it directly.
  const records = buildAnalyticsRecords({
    deals: [
      { ID: "1", TITLE: "A", DATE_CREATE: at("1-01"), CATEGORY_ID: "3", STAGE_ID: "NEW", CONTACT_ID: "7", COMPANY_ID: "55" },
      { ID: "2", TITLE: "B", DATE_CREATE: at("2-01"), CATEGORY_ID: "3", STAGE_ID: "NEW", CONTACT_ID: "8", COMPANY_ID: "55" },
    ],
    activities: [], callStats: [], stageHistories: [], providerRules: {},
    settings: { ...defaultSettings, selectedPipelineIds: ["3"] },
    users: new Map(), pipelines: new Map([["3", "IBOX Sales"]]), stages: new Map(), sources: new Map(),
    domain: null, activitiesAvailable: true, stageHistoryAvailable: true,
  });
  assert.equal(records[0].customerKey, "contact:7");
  assert.equal(records[1].customerKey, "contact:8");
  // Same company, different contacts -> two distinct customers, no duplicate.
  const marked = markDuplicates(records.map((record) => ({ ...record })));
  assert.equal(countDuplicates(marked), 0);
});

test("Case 6: har xil mijozlar — takror yo‘q", () => {
  const result = markDuplicates([
    row("1", at("1-01"), "contact:1"), row("2", at("2-01"), "contact:2"), row("3", at("3-01"), "company:9"),
  ]);
  assert.equal(countDuplicates(result), 0);
  assert.ok(result.every((item) => item.duplicateOfDealId === null));
});

test("Case 7: bir xil createdAt bo‘lsa tartib deterministik — massiv tartibi hal qilmaydi", () => {
  const same = at("1-01");
  const a = markDuplicates([row("900", same, "contact:9"), row("100", same, "contact:9")]);
  const b = markDuplicates([row("100", same, "contact:9"), row("900", same, "contact:9")]);
  const original = (rows: Row[]) => rows.find((item) => item.duplicateOfDealId === null)?.dealId;
  // Numeric deal id is the secondary key, so 100 wins regardless of input order.
  assert.equal(original(a), "100");
  assert.equal(original(b), "100");
  assert.equal(byId(a).get("900"), "100");
  assert.equal(byId(b).get("900"), "100");
  // "9" < "100" numerically, not lexicographically.
  assert.ok(compareDealIds("9", "100") < 0);
  assert.ok(compareDealIds("abc", "abd") < 0);
});

test("Case 8: takrorni belgilash boshqa KPI populyatsiyalarini o‘zgartirmaydi", () => {
  const input = [
    row("1", at("1-01"), "contact:1", { qualified: true, salesStatus: "WON", lossReasonGroup: "NONE" }),
    row("2", at("2-01"), "contact:1", { qualified: true, salesStatus: "LOST", lossReasonGroup: "SALES" }),
    row("3", at("3-01"), "contact:1", { qualified: false, salesStatus: "LOW_QUALITY", lossReasonGroup: "MARKETING" }),
  ];
  const result = markDuplicates(input);
  assert.equal(result.length, input.length, "Total Leads o‘zgarmaydi");
  assert.equal(result.filter((item) => item.qualified).length, 2);
  assert.equal(result.filter((item) => item.salesStatus === "WON").length, 1);
  assert.equal(result.filter((item) => item.lossReasonGroup === "SALES").length, 1);
  assert.equal(result.filter((item) => item.lossReasonGroup === "MARKETING").length, 1);
  assert.equal(countDuplicates(result), 2);
});

test("Case 9: hech bir yozuv o‘zini takror deb ko‘rsatmaydi", () => {
  const result = markDuplicates([
    row("5", at("1-01"), "contact:1"), row("5", at("1-01"), "contact:1"),
    row("7", at("2-01"), "contact:1"), row("8", at("3-01"), null),
  ]);
  for (const item of result) assert.notEqual(item.duplicateOfDealId, item.dealId);
  assert.equal(result.find((item) => item.dealId === "8")?.duplicateOfDealId, null, "customerKey yo‘q — takror emas");
});

test("Case 10: N ta deal’li guruh max(N-1, 0) ta takror beradi", () => {
  for (const [size, expected] of [[1, 0], [2, 1], [3, 2], [5, 4]] as const) {
    const rows = Array.from({ length: size }, (_, index) => row(String(index + 1), at(`1-0${index + 1}`), "contact:1"));
    const result = markDuplicates(rows);
    assert.equal(countDuplicates(result), expected, `${size} ta deal`);
    assert.equal(result.filter((item) => item.duplicateOfDealId === null).length, 1, `${size} ta deal: bitta original`);
  }
  assert.equal(countDuplicates([]), 0);
  assert.equal(isDuplicate({ duplicateOfDealId: null }), false);
  assert.equal(isDuplicate({ duplicateOfDealId: "1" }), true);
});
