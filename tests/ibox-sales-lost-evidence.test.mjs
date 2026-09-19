import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSFER_OUT_REASONS } from "../scripts/ibox-lead-evidence.mjs";
import {
  extractIboxSalesLostEvidence,
  renderSalesLostSummary,
  writeSalesLostAuditOutput,
} from "../scripts/ibox-sales-lost-evidence.mjs";

const categoryId = "3";
const postSaleCategoryId = "13";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const config = { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" };
const catalogRows = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:NO_ANSWER", "НЕТ ОТВЕТА", 20],
  ["C3:SQL", "ОБРАБОТКА", 50],
  ["C3:MEETING", "ВСТРЕЧА НАЗНАЧЕНА", 60],
  ["C3:WON", "Оплата получена", 100],
  ["C3:LOSE", "Сделка провалена", 110, "failure"],
  ["C3:NR", "Not relevant", 120],
].map(([STATUS_ID, NAME, SORT, SEMANTICS]) => ({ STATUS_ID, NAME, SORT, ...(SEMANTICS ? { EXTRA: { SEMANTICS } } : {}) }));
const sourceRows = [
  { STATUS_ID: "CRM_FORM", NAME: "CRM-форма" },
  { STATUS_ID: "REFERRAL", NAME: "Recommendation" },
];

function fixture() {
  const deals = new Map();
  const histories = [];
  const add = (id, stagePath, { current = stagePath.at(-1), category = categoryId, source = "CRM_FORM", reason = "" } = {}) => {
    deals.set(id, {
      ID: id,
      CATEGORY_ID: category,
      STAGE_ID: current,
      STAGE_SEMANTIC_ID: current === "C3:LOSE" ? "F" : "",
      SOURCE_ID: source,
      DATE_CREATE: "2026-09-10T12:00:00+05:00",
      [failureReasonField]: reason,
    });
    stagePath.forEach((stageId, index) => histories.push({
      ID: `${id}-${index}`,
      OWNER_ID: id,
      CATEGORY_ID: categoryId,
      STAGE_ID: stageId,
      TYPE_ID: "2",
      CREATED_TIME: `2026-09-1${index}T10:00:00+05:00`,
    }));
  };

  add("1", ["C3:NEW", "C3:SQL", "C3:LOSE"], { reason: "102" });
  add("2", ["C3:NEW", "C3:NO_ANSWER", "C3:LOSE"]); // direct, missing reason
  add("3", ["C3:NEW", "C3:LOSE"], { reason: "11151" }); // direct, orphan enum
  add("4", ["C3:NEW", "C3:SQL", "C3:LOSE"], { reason: "101" }); // routing, real SQL
  add("5", ["C3:NEW", "C3:NO_ANSWER", "C3:LOSE"], { reason: "101" }); // routing, not SQL
  add("6", ["C3:NEW", "C3:SQL", "C3:NR"]); // Not Relevant, never Sales Lost
  add("7", ["C3:NEW", "C3:MEETING"], { source: "REFERRAL" });
  add("8", ["C3:NEW", "C3:SQL", "C3:LOSE"], { source: "REFERRAL", reason: "102" });
  add("9", ["C3:NEW", "C3:SQL", "C3:LOSE"], { category: "1", current: "C1:LOSE", reason: "102" });
  add("10", ["C3:NEW"], { category: postSaleCategoryId, current: "C13:NEW" });
  add("11", ["C3:UNKNOWN"]);
  add("12", ["C3:NEW", "C3:SQL"], { reason: "102" }); // stale failure reason, not currently lost

  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.stagehistory.list") {
      return { result: { items: params.filter.CATEGORY_ID === categoryId ? histories : [] } };
    }
    if (method === "crm.status.list") {
      return { result: params.filter.ENTITY_ID === "SOURCE" ? sourceRows : catalogRows };
    }
    if (method === "crm.deal.fields") {
      return { result: { [failureReasonField]: { items: [
        { ID: "101", VALUE: TRANSFER_OUT_REASONS[0] },
        { ID: "102", VALUE: "Ушли к конкурентам" },
      ] } } };
    }
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };
  return { call, methods };
}

test("Sales Lost uses the canonical Lead/SQL pass and returns exact IDs, source and evidence breakdowns", async () => {
  const { call, methods } = fixture();
  const report = await extractIboxSalesLostEvidence({ call, config });

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.lead.discovered, 12);
  assert.equal(report.lead.included, 11, "Deal 9 is currently outside the IBOX project");
  assert.equal(report.lead.excluded, 1);
  assert.deepEqual(report.salesLost.all.ids, ["1", "2", "3", "8"]);
  assert.deepEqual(report.salesLost.crmForm.ids, ["1", "2", "3"]);
  assert.deepEqual(report.salesLost.breakdown.realSqlOrDownstreamEvidence.ids, ["1", "8"]);
  assert.deepEqual(report.salesLost.breakdown.preSqlClosedDirectSalesLoss.ids, ["2", "3"]);
  assert.deepEqual(report.salesLost.bySource.map((item) => [item.sourceLabel, item.count]), [
    ["CRM-форма", 3], ["Recommendation", 1],
  ]);
  assert.ok(!report.salesLost.all.ids.includes("4"), "routing with SQL evidence is never Sales Lost");
  assert.ok(!report.salesLost.all.ids.includes("5"), "direct routing closure is never Sales Lost");
  assert.ok(!report.salesLost.all.ids.includes("6"), "Not Relevant is never Sales Lost");
  assert.ok(!report.salesLost.all.ids.includes("9"), "outside-project Deal is outside the canonical base");
});

test("failure reasons retain missing and orphan evidence without guessing routing", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesLostEvidence({ call, config });

  assert.deepEqual(report.failureReasons.missingOrUnselected.ids, ["2"]);
  assert.deepEqual(report.failureReasons.orphanDeals, [{
    dealId: "3", orphanFailureReasonIds: ["11151"], resolvedLabels: [],
  }]);
  assert.deepEqual(report.failureReasons.breakdown.map((item) => [item.reason, item.count]), [
    ["Missing / unselected", 1],
    ["Orphan enum 11151", 1],
    ["Ушли к конкурентам", 2],
  ]);
});

test("all required Sales Lost invariants hold and unresolved evidence stays visible", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesLostEvidence({ call, config });
  for (const [name, invariant] of Object.entries(report.invariants)) {
    assert.equal(invariant.holds, true, name);
  }
  assert.equal(report.unresolved.count, 1);
  assert.deepEqual(report.unresolved.rows.map((row) => row.dealId), ["11"]);
  assert.equal(report.result, "COMPLETE_WITH_UNRESOLVED");
  assert.equal(report.verifiedInputReference.applicable, true);
  assert.equal(report.verifiedInputReference.allMatch, false, "small fixture is not the verified live population");
});

test("dashboard formula matches on canonical rows while the current branch population rule is reported as mismatched", async () => {
  const { call } = fixture();
  const report = await extractIboxSalesLostEvidence({ call, config });
  assert.equal(report.dashboardComparison.formulaOnCanonicalRows.matches, true);
  assert.equal(report.dashboardComparison.formulaOnCanonicalRows.onlyInReference.count, 0);
  assert.equal(report.dashboardComparison.formulaOnCanonicalRows.onlyInDashboard.count, 0);
  assert.equal(report.dashboardComparison.basePopulation.matches, false);
  assert.match(report.dashboardComparison.basePopulation.note, /lossReasonGroup !== ROUTING/);
});

test("the audit is read-only, writes safe local output and never exposes a webhook", async () => {
  const source = await readFile(new URL("../scripts/ibox-sales-lost-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /(?:stdout|stderr)\.write\([^)]*environment/);

  const { call } = fixture();
  const report = await extractIboxSalesLostEvidence({ call, config });
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-sales-lost-evidence-test-"));
  try {
    const files = await writeSalesLostAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderSalesLostSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.match(serialized, /Sales Lost, all sources: 4/);
    assert.match(serialized, /SALES LOST DEAL IDS/);
    assert.equal(path.dirname(files.jsonPath), temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
