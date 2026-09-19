import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSFER_OUT_REASONS } from "../scripts/ibox-lead-evidence.mjs";
import { buildStageRules } from "../scripts/ibox-sql-evidence.mjs";
import {
  classifyWonEvidence,
  extractIboxSalesEvidence,
  renderSalesSummary,
  writeSalesAuditOutput,
} from "../scripts/ibox-sales-evidence.mjs";

const categoryId = "3";
const postSaleCategoryId = "13";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const catalogRows = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:UC_C0725V", "Not relevant", 120],
].map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) }));
const sourceRows = [{ STATUS_ID: "CRM_FORM", NAME: "CRM-форма" }, { STATUS_ID: "REFERRAL", NAME: "Recommendation" }];
const rules = buildStageRules(catalogRows);
const config = { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" };

const at = (day, hour = 10) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+05:00`;
const row = (stageId, time, category = categoryId) => ({ STAGE_ID: stageId, CREATED_TIME: time, CATEGORY_ID: category });

function evidence(deal, history, postSaleHistory = []) {
  return classifyWonEvidence({ deal: { CATEGORY_ID: categoryId, ...deal }, history, postSaleHistory, categoryId, postSaleCategoryId, rules });
}

test("reaching the payment stage is a sale dated by the payment history row", () => {
  const result = evidence({ STAGE_ID: "C3:WON" }, [row("C3:NEW", at(10)), row("C3:WON", at(12))]);
  assert.equal(result.won, true);
  assert.equal(result.paymentEvidence, true);
  assert.equal(result.postSaleEvidence, false);
  assert.equal(result.wonAt, "2026-09-12T05:00:00.000Z");
  assert.equal(result.wonAtSource, "PAYMENT_STAGE_HISTORY");
});

test("moving into the post-sale category is a sale; payment evidence is not lost when the Deal later moved there", () => {
  const both = evidence({ CATEGORY_ID: postSaleCategoryId, STAGE_ID: "C13:NEW" }, [row("C3:NEW", at(10)), row("C3:WON", at(12))], [row("C13:NEW", at(14), postSaleCategoryId)]);
  assert.equal(both.paymentEvidence, true, "the earlier payment row still counts after the move");
  assert.equal(both.postSaleEvidence, true);
  assert.equal(both.bothEvidence, true);
  assert.equal(both.wonAtSource, "PAYMENT_STAGE_HISTORY", "the dashboard dates by payment history first");
  assert.equal(both.wonAt, "2026-09-12T05:00:00.000Z");

  const postOnly = evidence({ CATEGORY_ID: postSaleCategoryId, STAGE_ID: "C13:NEW" }, [row("C3:NEW", at(10))], [row("C13:NEW", at(15), postSaleCategoryId)]);
  assert.equal(postOnly.won, true);
  assert.equal(postOnly.wonAtSource, "POST_SALE_HISTORY");
  assert.equal(postOnly.wonAt, "2026-09-15T05:00:00.000Z");
});

test("current post-sale membership alone is valid sale evidence, but never invents a wonAt", () => {
  const result = evidence({ CATEGORY_ID: postSaleCategoryId, STAGE_ID: "C13:NEW", DATE_MODIFY: at(18), MOVED_TIME: at(18) }, [row("C3:NEW", at(10))]);
  assert.equal(result.won, true);
  assert.equal(result.postSaleEvidence, true);
  assert.equal(result.wonAt, null, "no history row, so no trustworthy date");
});

test("MOVED_TIME dates a sale only while the current stage is the payment stage, and DATE_MODIFY is never used", () => {
  const moved = evidence({ STAGE_ID: "C3:WON", MOVED_TIME: at(16) }, [row("C3:NEW", at(10))]);
  assert.equal(moved.wonAtSource, "CURRENT_PAYMENT_STAGE_MOVED_TIME");
  assert.equal(moved.wonAt, "2026-09-16T05:00:00.000Z");
  const dateModifyOnly = evidence({ STAGE_ID: "C3:WON", DATE_MODIFY: at(17) }, [row("C3:NEW", at(10))]);
  assert.equal(dateModifyOnly.won, true);
  assert.equal(dateModifyOnly.wonAt, null);
  const notPayment = evidence({ STAGE_ID: "C3:UC_9SUEMM", MOVED_TIME: at(16) }, [row("C3:NEW", at(10)), row("C3:UC_9SUEMM", at(11))]);
  assert.equal(notPayment.won, false);
  assert.equal(notPayment.wonAt, null);
});

test("Not Relevant is a sale only with provably earlier payment/post-sale evidence", () => {
  const earlier = evidence({ STAGE_ID: "C3:UC_C0725V" }, [row("C3:NEW", at(10)), row("C3:WON", at(11)), row("C3:UC_C0725V", at(12))]);
  assert.equal(earlier.currentNotRelevant, true);
  assert.equal(earlier.evidenceEarlierThanNotRelevant, true);
  assert.equal(earlier.counted, true);
  const later = evidence({ STAGE_ID: "C3:UC_C0725V" }, [row("C3:NEW", at(10)), row("C3:UC_C0725V", at(11)), row("C3:WON", at(12))]);
  assert.equal(later.won, true);
  assert.equal(later.counted, false, "evidence after the Not Relevant entry is a conflict, not a sale");
  const plain = evidence({ STAGE_ID: "C3:UC_C0725V" }, [row("C3:NEW", at(10)), row("C3:UC_C0725V", at(11))]);
  assert.equal(plain.won, false);
  assert.equal(plain.counted, false);
});

function fixture() {
  const deals = new Map();
  const cat3 = [];
  const cat13 = [];
  const add = (id, times, { current = times.at(-1)[0], category = categoryId, source = "CRM_FORM", created = at(10, 9), moved = "", post = [] } = {}) => {
    deals.set(id, {
      ID: id, CATEGORY_ID: category, STAGE_ID: current, SOURCE_ID: source, DATE_CREATE: created, ...(moved ? { MOVED_TIME: moved } : {}),
      [failureReasonField]: "",
    });
    times.forEach(([stageId, time], index) => cat3.push({ ID: `${id}-${index}`, OWNER_ID: id, CATEGORY_ID: categoryId, STAGE_ID: stageId, TYPE_ID: "2", CREATED_TIME: time }));
    post.forEach(([stageId, time], index) => cat13.push({ ID: `${id}-p${index}`, OWNER_ID: id, CATEGORY_ID: postSaleCategoryId, STAGE_ID: stageId, TYPE_ID: "5", CREATED_TIME: time }));
  };
  add("1", [["C3:NEW", at(10)], ["C3:UC_9SUEMM", at(11)], ["C3:WON", at(12)]]);
  add("2", [["C3:NEW", at(10)], ["C3:UC_9SUEMM", at(11)], ["C3:WON", at(12)]], { category: postSaleCategoryId, current: "C13:NEW", post: [["C13:NEW", at(14)]] });
  add("3", [["C3:NEW", at(10)]], { category: postSaleCategoryId, current: "C13:NEW", post: [["C13:NEW", at(15)]] });
  add("4", [["C3:NEW", at(10)]], { category: postSaleCategoryId, current: "C13:NEW" });
  add("5", [["C3:NEW", at(10)], ["C3:WON", at(13)]], { source: "REFERRAL" });
  add("6", [["C3:NEW", at(10)], ["C3:UC_9SUEMM", at(11)], ["C3:UC_C0725V", at(12)]]);
  add("7", [["C3:NEW", at(10)], ["C3:WON", at(11)], ["C3:UC_C0725V", at(12)]]);
  add("8", [["C3:NEW", at(10)], ["C3:UC_C0725V", at(11)], ["C3:WON", at(12)]], { current: "C3:UC_C0725V" });
  add("9", [["C3:NEW", at(10)], ["C3:UC_9SUEMM", at(11)]]);
  add("10", [["C3:NEW", at(10)], ["C3:WON", at(12)]], { category: "1", current: "C1:NEW" });
  add("11", [["C3:NEW", "2026-08-20T10:00:00+05:00"], ["C3:WON", at(5)]], { created: "2026-08-20T09:00:00+05:00" });
  add("12", [["C3:NEW", at(10)], ["C3:WON", "2026-10-05T10:00:00+05:00"]]);
  add("13", [["C3:NEW", at(10)]], { current: "C3:WON", moved: at(16) });
  add("14", [["C3:NEW", at(10)], ["C3:UC_MYSTERY", at(11)]]);
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.stagehistory.list") return { result: { items: params.filter.CATEGORY_ID === categoryId ? cat3 : cat13 } };
    if (method === "crm.status.list") return { result: params.filter.ENTITY_ID === "SOURCE" ? sourceRows : catalogRows };
    if (method === "crm.deal.fields") return { result: { [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] } } };
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };
  return { call, methods };
}

test("live-shaped fixture: cohort Sales, evidence split, wonAt trust, period Sales and source breakdown", async () => {
  const { call, methods } = fixture();
  const report = await extractIboxSalesEvidence({ call, config });
  const cohort = report.cohortSales;

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.lead.discovered, 14);
  assert.equal(report.lead.included, 12, "Deal 10 is in another project and Deal 11 was created before the range");

  assert.deepEqual(cohort.all.ids, ["1", "2", "3", "4", "5", "7", "12", "13"]);
  assert.equal(cohort.all.count, 8);
  assert.deepEqual(cohort.crmForm.ids, ["1", "2", "3", "4", "7", "12", "13"]);
  assert.deepEqual(cohort.bySource.map((item) => [item.sourceLabel, item.count]), [["CRM-форма", 7], ["Recommendation", 1]]);

  assert.deepEqual(cohort.evidence.paymentStage.ids, ["1", "2", "5", "7", "12", "13"]);
  assert.deepEqual(cohort.evidence.postSale.ids, ["2", "3", "4"]);
  assert.deepEqual(cohort.evidence.both.ids, ["2"]);
  assert.deepEqual(cohort.evidence.paymentOnly.ids, ["1", "5", "7", "12", "13"]);
  assert.deepEqual(cohort.evidence.postSaleOnly.ids, ["3", "4"]);

  assert.equal(cohort.wonAt.trustworthy.count, 7);
  assert.deepEqual(cohort.wonAt.missing.ids, ["4"]);
  assert.deepEqual(cohort.wonAt.bySource, { PAYMENT_STAGE_HISTORY: 5, POST_SALE_HISTORY: 1, CURRENT_PAYMENT_STAGE_MOVED_TIME: 1 });

  const period = report.periodSales;
  assert.deepEqual(period.all.ids, ["1", "2", "3", "5", "7", "11", "13"]);
  assert.deepEqual(period.crmForm.ids, ["1", "2", "3", "7", "11", "13"]);
  assert.deepEqual(period.createdInRange.ids, ["1", "2", "3", "5", "7", "13"]);
  assert.deepEqual(period.createdBeforeRange.ids, ["11"], "a sale created before the range still counts by wonAt");
  assert.ok(!period.all.ids.includes("12"), "Deal 12 was paid in October");
  assert.ok(!period.all.ids.includes("4"), "no wonAt, so invisible to period Sales");
});

test("Not Relevant / WON conflicts are listed, and only provably earlier evidence counts", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesEvidence({ call, config });
  const conflicts = report.conflicts;

  assert.deepEqual(conflicts.notRelevantWithWonEvidence.map((item) => [item.dealId, item.evidenceEarlierThanNotRelevant, item.countedAsSale]), [
    ["7", true, true],
    ["8", false, false],
  ]);
  assert.deepEqual(conflicts.countedAsSale.ids, ["7"]);
  assert.deepEqual(conflicts.notCounted.ids, ["8"]);
  assert.equal(report.dashboardComparison.dashboardCohortSales.count, 9, "the dashboard counts every WON");
  assert.equal(report.dashboardComparison.dashboardCohortSales.differenceFromReference, 1);
  assert.ok(!report.cohortSales.all.ids.includes("6"), "a plain Not Relevant is never a sale");
});

test("invariants: Sales is a subset of SQL and of the canonical Leads, disjoint from Not Relevant, each Deal once", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesEvidence({ call, config });
  const inv = report.invariants;

  assert.equal(inv.cohortSalesSubsetOfSql.holds, true);
  assert.equal(inv.cohortSalesSubsetOfCanonicalLeads.holds, true);
  assert.equal(inv.cohortSalesIntersectNotRelevant.holds, true);
  assert.deepEqual(inv.cohortSalesIntersectNotRelevant.listedConflicts, ["7"]);
  assert.equal(inv.everyDealIdOnce.holds, true);
  assert.equal(inv.salesStatusAgreesWithSqlAudit.holds, true);
  assert.deepEqual(report.reconciliation, {
    leads: 12, sql: 10, notRelevant: 1, saralangan: 11, saralanmagan: 1, note: report.reconciliation.note,
  });
});

test("Deals outside the IBOX project are not sales, and unknown evidence is unresolved", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesEvidence({ call, config });

  assert.ok(!report.cohortSales.all.ids.includes("10"));
  assert.ok(!report.periodSales.all.ids.includes("10"));
  assert.deepEqual(report.dashboardComparison.outsideProjectButPaidInPeriod.ids, ["10"]);
  assert.equal(report.unresolved.count, 1);
  assert.deepEqual(report.unresolved.rows.map((item) => [item.dealId, item.reason]), [["14", "UNKNOWN_STAGE_ID_IN_TRAIL"]]);
  assert.equal(report.result, "COMPLETE_WITH_UNRESOLVED");
});

test("the Sales audit is read-only and its output carries no webhook", async () => {
  const source = await readFile(new URL("../scripts/ibox-sales-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /\.DATE_MODIFY\b|\[["']DATE_MODIFY["']\]/, "DATE_MODIFY is never read as a payment date");

  const { call } = fixture();
  const report = await extractIboxSalesEvidence({ call, config });
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-sales-evidence-test-"));
  try {
    const files = await writeSalesAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderSalesSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.match(serialized, /Cohort Sales \(Kelgan leadlardan sotuv\), all sources: 8/);
    assert.match(serialized, /Cohort Sales, CRM-форма: 7/);
    assert.match(serialized, /cohort Sales ⊆ SQL: HOLDS/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
