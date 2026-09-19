import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSFER_OUT_REASONS } from "../scripts/ibox-lead-evidence.mjs";
import {
  extractIboxNotRelevantEvidence,
  failureReasonDiagnostic,
  renderNotRelevantSummary,
  writeNotRelevantAuditOutput,
} from "../scripts/ibox-not-relevant-evidence.mjs";

const categoryId = "3";
const postSaleCategoryId = "13";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const catalogRows = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_05P04E", "НЕТ ОТВЕТА", 20],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:UC_C0725V", "Not relevant", 120],
].map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) }));
const sourceRows = [{ STATUS_ID: "CRM_FORM", NAME: "CRM-форма" }, { STATUS_ID: "REFERRAL", NAME: "Recommendation" }];
const options = { fieldFound: true, byId: new Map([["101", TRANSFER_OUT_REASONS[0]]]) };

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
  add("1", ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_C0725V"]);
  add("2", ["C3:NEW", "C3:UC_C0725V"], { reason: "11151" });
  add("3", ["C3:NEW", "C3:UC_C0725V"], { source: "REFERRAL", reason: "101" });
  add("4", ["C3:NEW", "C3:UC_9SUEMM"]);
  add("5", ["C3:NEW", "C3:UC_05P04E", "C3:LOSE"], { reason: "ignorit", semantic: "F" });
  add("6", ["C3:NEW"]);
  add("7", ["C3:NEW", "C3:UC_C0725V"], { category: "1", current: "C1:NEW" });
  add("8", ["C3:NEW", "C3:WON", "C3:UC_C0725V"]);
  add("9", ["C3:NEW", "C3:UC_9SUEMM", "C3:LOSE"], { reason: "101", semantic: "F" });
  add("10", ["C3:NEW", "C3:UC_MYSTERY"]);
  add("11", ["C3:NEW", "C3:UC_9SUEMM", "C3:UC_MYSTERY"]);
  add("12", ["C3:NEW"], { category: postSaleCategoryId, current: "C13:NEW" });
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.stagehistory.list") return { result: { items: params.filter.CATEGORY_ID === categoryId ? histories : [] } };
    if (method === "crm.status.list") return { result: params.filter.ENTITY_ID === "SOURCE" ? sourceRows : catalogRows };
    if (method === "crm.deal.fields") return { result: { [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] } } };
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };
  return { call, methods };
}

const config = { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" };

test("failure-reason diagnostics describe the field without ever classifying", () => {
  const deal = (value) => ({ [failureReasonField]: value });
  assert.equal(failureReasonDiagnostic(deal(""), failureReasonField, options).state, "NOT_SELECTED");
  assert.equal(failureReasonDiagnostic({}, failureReasonField, options).state, "FIELD_ABSENT_ON_DEAL");
  assert.deepEqual(failureReasonDiagnostic(deal("11151"), failureReasonField, options), { state: "ORPHAN_ENUM_ID", orphanIds: ["11151"] });
  assert.equal(failureReasonDiagnostic(deal("101"), failureReasonField, options).state, "RESOLVED");
  assert.equal(failureReasonDiagnostic(deal(["101", "11151"]), failureReasonField, options).state, "RESOLVED_WITH_ORPHAN");
  assert.equal(failureReasonDiagnostic(deal("11151"), failureReasonField, { fieldFound: true, byId: new Map() }).state, "DICTIONARY_EMPTY");
  assert.equal(failureReasonDiagnostic(deal("101"), failureReasonField, { fieldFound: false, byId: new Map() }).state, "FIELD_NOT_IN_DICTIONARY");
});

test("Not Relevant is stage-authoritative: counts, source split, prior SQL history and exact ID set", async () => {
  const { call, methods } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  const nr = report.notRelevant;

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.lead.discovered, 12);
  assert.equal(report.lead.included, 11, "Deal 7 sits in another project and is not a Lead");

  assert.deepEqual(nr.all.ids, ["1", "2", "3"]);
  assert.equal(nr.all.count, 3);
  assert.deepEqual(nr.crmForm.ids, ["1", "2"]);
  assert.deepEqual(nr.bySource.map((item) => [item.sourceLabel, item.count]), [["CRM-форма", 2], ["Recommendation", 1]]);
  assert.deepEqual(nr.withPriorSqlDownstreamHistory.ids, ["1"], "a prior Обработка visit does not make it SQL");
  assert.deepEqual(nr.withoutPriorSqlDownstreamHistory.ids, ["2", "3"]);
  assert.equal(nr.crmFormWithPriorSqlDownstreamHistory.count, 1);
  assert.equal(nr.crmFormWithoutPriorSqlDownstreamHistory.count, 1);
  assert.ok(!nr.all.ids.includes("7"), "a Deal currently outside IBOX is not counted");
});

test("the failure reason never decides Not Relevant, but orphan and transfer labels stay visible", async () => {
  const { call } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  const diag = report.failureReasonDiagnostics;

  assert.deepEqual(diag.byState, { NOT_SELECTED: 1, ORPHAN_ENUM_ID: 1, RESOLVED: 1 });
  assert.deepEqual(diag.orphanDeals, [{ dealId: "2", orphanFailureReasonIds: ["11151"] }]);
  assert.deepEqual(diag.routingStyleReasonStillNotRelevant.ids, ["3"], "a transfer-style reason on a Not Relevant stage is still Not Relevant");
  // Deal 9 carries the transfer label but sits in the closed-lost stage: not Not Relevant.
  assert.ok(!report.notRelevant.all.ids.includes("9"));
  // Deal 2's orphan enum did not exclude it.
  assert.ok(report.notRelevant.all.ids.includes("2"));
});

test("invariants: SQL and Not Relevant are disjoint, subset of Leads, each Deal once, and the Lead partition adds up", async () => {
  const { call } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  const inv = report.invariants;

  assert.deepEqual(inv.sqlIntersectNotRelevant, { count: 0, ids: [], holds: true });
  assert.equal(inv.notRelevantSubsetOfCanonicalLeads.holds, true);
  assert.equal(inv.everyDealIdOnce.holds, true);
  assert.deepEqual(inv.leadPartition, {
    leads: 11, sql: 6, notRelevant: 3, neitherSqlNorNotRelevant: 1, sqlEvidenceUnresolved: 1, holds: true,
  });
  assert.equal(report.sqlReference.all, 6);
  assert.equal(report.sqlReference.crmForm, 6, "every SQL Deal in this fixture is CRM-форма");
});

test("paid-then-Not-Relevant follows the dashboard precedence (SQL, not Not Relevant) and is reported as a comparison item", async () => {
  const { call } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  assert.ok(!report.notRelevant.all.ids.includes("8"));
  assert.deepEqual(report.dashboardComparison.notRelevantCurrentStageButWon.ids, ["8"]);
  assert.equal(report.invariants.sqlIntersectNotRelevant.holds, true);
});

test("unknown evidence is unresolved and counted, never guessed into Not Relevant", async () => {
  const { call } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  assert.equal(report.result, "COMPLETE_WITH_UNRESOLVED");
  assert.equal(report.unresolved.count, 2);
  assert.deepEqual(report.unresolved.rows.map((row) => [row.dealId, row.stage]).sort(), [["10", "SQL_EVIDENCE"], ["11", "NOT_RELEVANT_CURRENT_STAGE"]]);
  assert.ok(!report.notRelevant.all.ids.includes("10") && !report.notRelevant.all.ids.includes("11"));
});

test("the Not Relevant audit is read-only and its output carries no webhook", async () => {
  const source = await readFile(new URL("../scripts/ibox-not-relevant-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);

  const { call } = fixture();
  const report = await extractIboxNotRelevantEvidence({ call, config });
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-nr-evidence-test-"));
  try {
    const files = await writeNotRelevantAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderNotRelevantSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.match(serialized, /Not Relevant, all sources: 3/);
    assert.match(serialized, /Not Relevant, CRM-форма: 2/);
    assert.match(serialized, /SQL ∩ Not Relevant = empty: HOLDS/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
