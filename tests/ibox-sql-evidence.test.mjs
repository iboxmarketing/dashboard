import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSFER_OUT_REASONS } from "../scripts/ibox-lead-evidence.mjs";
import {
  buildStageRules,
  classifySqlEvidence,
  extractIboxSqlEvidence,
  renderSqlSummary,
  writeSqlAuditOutput,
} from "../scripts/ibox-sql-evidence.mjs";

const categoryId = "3";
const postSaleCategoryId = "13";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const catalogRows = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_05P04E", "НЕТ ОТВЕТА", 20],
  ["C3:UC_L52PGZ", "Первое касание", 40],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:PREPARATION", "ВСТРЕЧА НАЗНАЧЕНА", 60],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:UC_C0725V", "Not relevant", 120],
].map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) }));
const rules = buildStageRules(catalogRows);
const reasonOptions = { fieldFound: true, byId: new Map([["101", TRANSFER_OUT_REASONS[0]]]) };
const sourceRows = [{ STATUS_ID: "CRM_FORM", NAME: "CRM-форма" }, { STATUS_ID: "REFERRAL", NAME: "Recommendation" }];

const row = (stageId, at = "2026-09-05T10:00:00+05:00") => ({ STAGE_ID: stageId, CREATED_TIME: at });
function classify(path, { current = path.at(-1), category = categoryId, reason = "", postSaleHistory = false, semantic } = {}) {
  return classifySqlEvidence({
    dealId: "1",
    deal: {
      ID: "1", CATEGORY_ID: category, STAGE_ID: current, ...(semantic ? { STAGE_SEMANTIC_ID: semantic } : {}),
      [failureReasonField]: reason,
    },
    history: path.map((stageId, index) => row(stageId, `2026-09-0${5 + index}T10:00:00+05:00`)),
    hasPostSaleHistory: postSaleHistory,
    categoryId, postSaleCategoryId, rules, failureReasonField, failureReasonOptions: reasonOptions,
  });
}

test("SQL stage rules come from the live stage dictionary and fail closed without an SQL stage", () => {
  assert.deepEqual(rules.sqlStageIds, ["C3:UC_9SUEMM"]);
  assert.equal(rules.thresholdSort, 50);
  assert.equal(rules.isSqlOrDownstream("C3:UC_9SUEMM"), true);
  assert.equal(rules.isSqlOrDownstream("C3:PREPARATION"), true);
  assert.equal(rules.isSqlOrDownstream("C3:UC_L52PGZ"), false);
  assert.equal(rules.isSqlOrDownstream("C3:UC_C0725V"), false, "Not Relevant is never progression");
  assert.equal(rules.isSqlOrDownstream("C3:LOSE"), false, "closed-lost is never progression");
  assert.throws(() => buildStageRules([{ STATUS_ID: "C3:NEW", NAME: "Новые", SORT: 10 }]), (error) => {
    assert.equal(error.code, "SQL_STAGE_NOT_FOUND");
    return true;
  });
});

test("Not Relevant is never SQL, even after a prior Обработка visit", () => {
  const result = classify(["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"]);
  assert.equal(result.classification, "NOT_RELEVANT");
  assert.equal(result.hasSqlEvidence, true, "the prior visit stays visible as a diagnostic");
  assert.equal(classify(["C3:NEW", "C3:UC_C0725V"]).classification, "NOT_RELEVANT");
});

test("reaching Обработка or a downstream stage is SQL with a real evidence time", () => {
  const processing = classify(["C3:NEW", "C3:UC_9SUEMM"]);
  assert.equal(processing.classification, "SQL");
  assert.equal(processing.basis, "SQL_STAGE_EVIDENCE");
  assert.equal(processing.qualifiedAt, "2026-09-06T05:00:00.000Z");

  const skipped = classify(["C3:NEW", "C3:PREPARATION"]);
  assert.equal(skipped.classification, "SQL");
  assert.equal(skipped.basis, "SQL_STAGE_EVIDENCE");
  assert.equal(skipped.evidenceStageId, "C3:PREPARATION");
});

test("WON and post-sale are SQL; without stage evidence they are inferred and get no qualifiedAt", () => {
  const paid = classify(["C3:NEW", "C3:WON"]);
  assert.equal(paid.classification, "SQL");
  assert.equal(paid.salesStatus, "WON");

  const postSale = classify(["C3:NEW"], { category: postSaleCategoryId, current: "C13:NEW" });
  assert.equal(postSale.classification, "SQL");
  assert.equal(postSale.basis, "WON_INFERRED_SQL");
  assert.equal(postSale.qualifiedAt, null);

  const returnedFromPostSale = classify(["C3:NEW"], { postSaleHistory: true });
  assert.equal(returnedFromPostSale.basis, "WON_INFERRED_SQL");
});

test("ordinary Sales Lost is SQL even when closed directly, and stays visible as preSqlClosed", () => {
  const direct = classify(["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "ignorit" });
  assert.equal(direct.classification, "SQL");
  assert.equal(direct.basis, "PRE_SQL_CLOSED_DIRECT_SALES_LOSS");
  assert.equal(direct.preSqlClosed, true);
  assert.equal(direct.qualifiedAt, null, "no qualifiedAt is fabricated");
  assert.equal(direct.evidenceStageId, null);

  const worked = classify(["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], { reason: "ignorit" });
  assert.equal(worked.basis, "SQL_STAGE_EVIDENCE");
  assert.equal(worked.preSqlClosed, false);
});

test("a routing-reason LOST Deal still in IBOX is SQL only with real evidence and is flagged for the dashboard comparison", () => {
  const withEvidence = classify(["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], { reason: "101" });
  assert.equal(withEvidence.classification, "SQL");
  assert.equal(withEvidence.routingReasonInIbox, true);
  const withoutEvidence = classify(["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "101" });
  assert.equal(withoutEvidence.classification, "NOT_SQL");
  assert.equal(withoutEvidence.preSqlClosed, undefined);
});

test("an orphan failure-reason enum ID never turns a lost Deal into routing", () => {
  const result = classify(["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "11151" });
  assert.equal(result.lossReasonGroup, "SALES");
  assert.equal(result.classification, "SQL");
});

test("a paid Deal whose current stage is Not Relevant follows the dashboard precedence and is flagged", () => {
  const result = classify(["C3:NEW", "C3:WON", "C3:UC_C0725V"]);
  assert.equal(result.salesStatus, "WON");
  assert.equal(result.classification, "SQL");
  assert.equal(result.notRelevantButWon, true);
});

test("an unknown stage ID with no other evidence is unresolved, never guessed", () => {
  const result = classify(["C3:UC_UNKNOWN"]);
  assert.equal(result.classification, "UNRESOLVED");
  assert.deepEqual(result.unknownStageIds, ["C3:UC_UNKNOWN"]);
  assert.equal(classify(["C3:UC_UNKNOWN", "C3:UC_9SUEMM"]).classification, "SQL");
  assert.equal(classify(["C3:UC_UNKNOWN", "C3:UC_C0725V"]).classification, "NOT_RELEVANT");
});

function fixture() {
  const deals = new Map();
  const histories = [];
  const add = (id, path, { current = path.at(-1), category = categoryId, source = "CRM_FORM", reason = "", semantic } = {}) => {
    deals.set(id, {
      ID: id, CATEGORY_ID: category, STAGE_ID: current, SOURCE_ID: source, DATE_CREATE: "2026-09-10T12:00:00+05:00",
      ...(semantic ? { STAGE_SEMANTIC_ID: semantic } : {}), [failureReasonField]: reason,
    });
    path.forEach((stageId, index) => histories.push({
      ID: `${id}-${index}`, OWNER_ID: id, CATEGORY_ID: categoryId, STAGE_ID: stageId, TYPE_ID: "2",
      CREATED_TIME: `2026-09-1${index}T10:00:00+05:00`,
    }));
  };
  add("1", ["C3:NEW", "C3:UC_9SUEMM"]);
  add("2", ["C3:NEW", "C3:PREPARATION"]);
  add("3", ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"]);
  add("4", ["C3:NEW", "C3:UC_C0725V"]);
  add("5", ["C3:NEW"], { category: postSaleCategoryId, current: "C13:NEW" });
  add("6", ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "ignorit", semantic: "F" });
  add("7", ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], { reason: "ignorit", semantic: "F" });
  add("8", ["C3:NEW"]);
  add("9", ["C3:NEW", "C3:UC_9SUEMM"], { category: "1", current: "C1:NEW" });
  add("10", ["C3:NEW", "C3:UC_9SUEMM"], { source: "REFERRAL" });
  add("11", ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], { reason: "101", semantic: "F" });
  add("12", ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "101", semantic: "F" });
  add("13", ["C3:UC_UNKNOWN"]);
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.stagehistory.list") {
      const wanted = params.filter.CATEGORY_ID;
      return { result: { items: wanted === categoryId ? histories : [] } };
    }
    if (method === "crm.status.list") {
      return { result: params.filter.ENTITY_ID === "SOURCE" ? sourceRows : catalogRows };
    }
    if (method === "crm.deal.fields") {
      return { result: { [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] } } };
    }
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };
  return { call, methods };
}

test("live-shaped fixture: SQL counts, source split, breakdown, Not Relevant, unresolved and dashboard comparison", async () => {
  const { call, methods } = fixture();
  const report = await extractIboxSqlEvidence({
    call,
    config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" },
  });

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.lead.discovered, 13);
  assert.equal(report.lead.included, 12, "Deal 9 sits in another project's funnel and is not a Lead");
  assert.equal(report.lead.excluded, 1);

  assert.deepEqual(report.sql.all.ids, ["1", "10", "11", "2", "5", "6", "7"].sort((a, b) => a.length - b.length || a.localeCompare(b)));
  assert.equal(report.sql.all.count, 7);
  assert.equal(report.sql.crmForm.count, 6);
  assert.deepEqual(report.sql.crmForm.ids, ["1", "2", "5", "6", "7", "11"].sort((a, b) => a.length - b.length || a.localeCompare(b)));
  assert.ok(!report.sql.all.ids.includes("9"), "a Deal currently in another project is not SQL");

  assert.deepEqual(report.sql.breakdown.realSqlOrDownstreamEvidence.ids, ["1", "2", "7", "10", "11"]);
  assert.deepEqual(report.sql.breakdown.wonOrPostSaleInferred.ids, ["5"]);
  assert.deepEqual(report.sql.breakdown.preSqlClosedDirectSalesLoss.ids, ["6"]);
  assert.equal(
    report.sql.breakdown.realSqlOrDownstreamEvidence.count + report.sql.breakdown.wonOrPostSaleInferred.count + report.sql.breakdown.preSqlClosedDirectSalesLoss.count,
    report.sql.all.count,
  );

  assert.deepEqual(report.sql.notRelevantExcluded.ids, ["3", "4"]);
  assert.deepEqual(report.sql.notRelevantExcluded.withPriorSqlEvidence.ids, ["3"]);
  assert.ok(report.sql.notRelevantExcluded.ids.every((id) => !report.sql.all.ids.includes(id)));

  assert.equal(report.unresolved.count, 1);
  assert.deepEqual(report.unresolved.rows.map((item) => item.dealId), ["13"]);
  assert.equal(report.result, "COMPLETE_WITH_UNRESOLVED");

  const routing = report.sql.dashboardComparison.routingReasonLostInIbox;
  assert.deepEqual(routing.ids, ["11"]);
  assert.equal(routing.sqlAllWithoutThem, 6);
  assert.equal(routing.sqlCrmFormWithoutThem, 5);
  assert.equal(report.sql.bySource.reduce((sum, item) => sum + item.count, 0), report.sql.all.count);
  assert.match(renderSqlSummary(report), /SQL, all sources: 7/);
  assert.match(renderSqlSummary(report), /SQL, CRM-форма: 6/);
});

test("every Deal ID is counted once even when history repeats it", async () => {
  const { call } = fixture();
  const repeating = async (method, params) => {
    const response = await call(method, params);
    if (method === "crm.stagehistory.list" && params.filter.CATEGORY_ID === categoryId) {
      return { result: { items: [...response.result.items, ...response.result.items] } };
    }
    return response;
  };
  const report = await extractIboxSqlEvidence({
    call: repeating,
    config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" },
  });
  assert.equal(new Set(report.sql.all.ids).size, report.sql.all.count);
  assert.equal(report.sql.all.count, 7);
});

test("the audit is read-only: allowlisted methods only, no D1/Sync/Backfill, no webhook in output", async () => {
  const source = await readFile(new URL("../scripts/ibox-sql-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /(?:stdout|stderr)\.write\([^)]*environment/);

  const { call } = fixture();
  const report = await extractIboxSqlEvidence({
    call, config: { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" },
  });
  const secret = "sensitive-credential-value";
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-sql-evidence-test-"));
  try {
    const files = await writeSqlAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderSqlSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.equal(path.dirname(files.jsonPath), temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
