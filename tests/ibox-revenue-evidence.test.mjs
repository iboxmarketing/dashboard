import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TRANSFER_OUT_REASONS } from "../scripts/ibox-lead-evidence.mjs";
import {
  buildRevenueReference,
  decideVerdicts,
  extractIboxRevenueEvidence,
  findAmountFieldCandidates,
  parseOpportunity,
  renderRevenueSummary,
  writeRevenueAuditOutput,
} from "../scripts/ibox-revenue-evidence.mjs";

const categoryId = "3";
const postSaleCategoryId = "13";
const failureReasonField = "UF_CRM_FAILURE_REASON";
const config = { categoryId, postSaleCategoryId, failureReasonField, from: "2026-09-01", to: "2026-09-19" };
const catalogRows = [
  ["C3:NEW", "РАСПРЕДЕЛЁННЫЕ СДЕЛКИ", 10],
  ["C3:UC_9SUEMM", "ОБРАБОТКА", 50],
  ["C3:WON", "Оплата получена", 100],
].map(([STATUS_ID, NAME, SORT]) => ({ STATUS_ID, NAME, SORT }));
const sourceRows = [{ STATUS_ID: "CRM_FORM", NAME: "CRM-форма" }, { STATUS_ID: "REFERRAL", NAME: "Recommendation" }];
const at = (day, hour = 10) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+05:00`;

test("OPPORTUNITY reads as missing, zero, negative, invalid or positive, and shows what the dashboard stores", () => {
  assert.deepEqual(parseOpportunity("1500000.00"), { state: "POSITIVE", value: 1500000, dashboardValue: 1500000 });
  assert.deepEqual(parseOpportunity(0), { state: "ZERO", value: 0, dashboardValue: 0 });
  assert.deepEqual(parseOpportunity("-500000"), { state: "NEGATIVE", value: -500000, dashboardValue: -500000 });
  assert.deepEqual(parseOpportunity(undefined), { state: "MISSING", value: null, dashboardValue: 0 });
  assert.deepEqual(parseOpportunity(null), { state: "MISSING", value: null, dashboardValue: 0 });
  assert.deepEqual(parseOpportunity("  "), { state: "MISSING", value: null, dashboardValue: 0 });
  assert.deepEqual(parseOpportunity("1 500 000"), { state: "INVALID", value: null, dashboardValue: 0 }, "a non-numeric amount silently becomes 0 in the dashboard");
});

test("the exact sum is reconciled and differs from the floating-point dashboard sum where floats drift", () => {
  const rows = [0.1, 0.2].map((value, index) => ({ dealId: String(index + 1), sourceId: "CRM_FORM", sourceLabel: "CRM-форма", currency: "UZS", ...parseOpportunity(value) }));
  const reference = buildRevenueReference(rows);
  assert.equal(reference.total.dashboardFormulaFloat, 0.30000000000000004);
  assert.equal(reference.total.exact, "0.30");
  assert.equal(reference.reconciliation.holds, true);
  assert.equal(reference.reconciliation.sumOfListedDealValues, "0.30");
});

function fixture() {
  const deals = new Map();
  const cat3 = [];
  const add = (id, { opportunity, currency = "UZS", source = "CRM_FORM", created = at(2, 9), paid = at(12), category = categoryId, extra = {} }) => {
    deals.set(id, {
      ID: id, CATEGORY_ID: category, STAGE_ID: category === categoryId ? "C3:WON" : "C1:NEW", SOURCE_ID: source, DATE_CREATE: created,
      ...(opportunity === undefined ? {} : { OPPORTUNITY: opportunity }), ...(currency === null ? {} : { CURRENCY_ID: currency }),
      [failureReasonField]: "", ...extra,
    });
    cat3.push({ ID: `${id}-0`, OWNER_ID: id, CATEGORY_ID: categoryId, STAGE_ID: "C3:NEW", TYPE_ID: "2", CREATED_TIME: created });
    cat3.push({ ID: `${id}-1`, OWNER_ID: id, CATEGORY_ID: categoryId, STAGE_ID: "C3:WON", TYPE_ID: "2", CREATED_TIME: paid });
  };
  add("1", { opportunity: "1500000.00", extra: { UF_CRM_PAID: "1000000" } });
  add("2", { opportunity: "2500000" });
  add("3", { opportunity: "1000000.50", source: "REFERRAL" });
  add("4", { opportunity: "0" });
  add("5", { opportunity: undefined });
  add("6", { opportunity: "abc" });
  add("7", { opportunity: "-500000" });
  add("8", { opportunity: "100", currency: "USD" });
  add("9", { opportunity: "300", currency: null });
  add("10", { opportunity: "4000000", created: "2026-08-20T09:00:00+05:00", paid: at(5) });
  add("11", { opportunity: "700000", paid: "2026-10-05T10:00:00+05:00" });
  add("13", { opportunity: "999", category: "1" });
  deals.set("12", { ID: "12", CATEGORY_ID: categoryId, STAGE_ID: "C3:UC_9SUEMM", SOURCE_ID: "CRM_FORM", DATE_CREATE: at(3, 9), OPPORTUNITY: "999", CURRENCY_ID: "UZS", [failureReasonField]: "" });
  cat3.push({ ID: "12-0", OWNER_ID: "12", CATEGORY_ID: categoryId, STAGE_ID: "C3:NEW", TYPE_ID: "2", CREATED_TIME: at(3, 9) });
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === "crm.stagehistory.list") return { result: { items: params.filter.CATEGORY_ID === categoryId ? cat3 : [] } };
    if (method === "crm.status.list") return { result: params.filter.ENTITY_ID === "SOURCE" ? sourceRows : catalogRows };
    if (method === "crm.deal.fields") {
      return { result: {
        OPPORTUNITY: { type: "double", title: "Сумма" },
        UF_CRM_PAID: { type: "double", formLabel: "Сумма первой оплаты" },
        UF_CRM_NOTE: { type: "string", formLabel: "Комментарий" },
        [failureReasonField]: { items: [{ ID: "101", VALUE: TRANSFER_OUT_REASONS[0] }] },
      } };
    }
    if (method === "crm.deal.get") return { result: deals.get(params.id) };
    throw new Error(`unexpected method ${method}`);
  };
  return { call, methods };
}

test("period revenue reproduces the dashboard formula over the verified period Sales with an exact reconciliation", async () => {
  const { call, methods } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const period = report.periodRevenue;

  assert.deepEqual([...new Set(methods)].sort(), ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"]);
  assert.equal(report.reconciliation.periodSales, 10);
  assert.deepEqual(period.dealValues.map((row) => row.dealId), ["1", "10", "2", "3", "4", "5", "6", "7", "8", "9"].sort((a, b) => a.length - b.length || a.localeCompare(b)));
  assert.equal(period.total.count, 10);
  assert.equal(period.total.exact, "8500400.50");
  assert.equal(period.total.dashboardFormulaFloat, 8500400.5);
  assert.equal(period.reconciliation.holds, true);

  assert.equal(period.crmForm.count, 9);
  assert.equal(period.crmForm.exact, "7500400.00");
  assert.deepEqual(period.bySource.map((item) => [item.sourceLabel, item.count, item.exact]), [["CRM-форма", 9, "7500400.00"], ["Recommendation", 1, "1000000.50"]]);
  assert.ok(!period.dealValues.some((row) => ["11", "12", "13"].includes(row.dealId)), "October sale, active Deal and other-project Deal are not period sales");
});

test("data-quality diagnostics count and list missing, zero, negative, invalid amounts and missing currency", async () => {
  const { call } = fixture();
  const quality = (await extractIboxRevenueEvidence({ call, config })).periodRevenue.dataQuality;

  assert.deepEqual(quality.missing.ids, ["5"]);
  assert.deepEqual(quality.zero.ids, ["4"]);
  assert.deepEqual(quality.negative, { count: 1, ids: ["7"], value: "-500000.00" });
  assert.deepEqual(quality.invalidNonNumeric.ids, ["6"]);
  assert.deepEqual(quality.noCurrency.ids, ["9"]);
  assert.equal(quality.positive.count, 6);
});

test("average and median follow the dashboard basis (zeros included) and are also reported over positive amounts", async () => {
  const { call } = fixture();
  const stats = (await extractIboxRevenueEvidence({ call, config })).periodRevenue.stats;
  assert.deepEqual(stats.dashboardFormula, { basis: stats.dashboardFormula.basis, average: 850040.05, median: 200 });
  assert.deepEqual(stats.positiveOnly, { basis: stats.positiveOnly.basis, count: 6, average: 1500066.75, median: 1250000.25 });
});

test("currencies are reported separately; the dashboard-style single total across them is flagged as not meaningful", async () => {
  const { call } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const diagnostics = report.currencyDiagnostics.period;

  assert.equal(diagnostics.mixed, true);
  assert.deepEqual(diagnostics.byCurrency, [
    { currency: "(no CURRENCY_ID)", count: 1, exact: "300.00" },
    { currency: "USD", count: 1, exact: "100.00" },
    { currency: "UZS", count: 8, exact: "8500000.50" },
  ]);
  assert.match(renderRevenueSummary(report), /mixed currencies: YES/);
});

test("the created-before-range sale contributes to period revenue and is shown on its own", async () => {
  const { call } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const before = report.periodRevenue.createdBeforeRange;

  assert.deepEqual(before.ids, ["10"]);
  assert.equal(before.total.exact, "4000000.00");
  assert.ok(report.periodRevenue.dealValues.some((row) => row.dealId === "10"));
  assert.ok(!report.cohortRevenue.dealValues.some((row) => row.dealId === "10"), "it is not a cohort sale: created before the range");
});

test("cohort revenue is a separate population: cohort Sales by DATE_CREATE, never added to period revenue", async () => {
  const { call } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const cohort = report.cohortRevenue;

  assert.equal(cohort.total.count, 10);
  assert.equal(cohort.total.exact, "5200400.50");
  assert.equal(cohort.crmForm.exact, "4200400.00");
  assert.ok(cohort.dealValues.some((row) => row.dealId === "11"), "sold in October, created in range: cohort only");
  assert.deepEqual(report.periodAndCohortOverlap.ids, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.match(report.periodAndCohortOverlap.note, /must not be added/);
});

test("OPPORTUNITY is not first-payment revenue: amount-like fields are listed for review but never used, verdict (b) is NO-GO", async () => {
  const { call } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const candidates = report.opportunitySemantics.amountFieldCandidates;

  assert.deepEqual(candidates.map((item) => item.key), ["OPPORTUNITY", "UF_CRM_PAID"]);
  assert.equal(candidates.find((item) => item.key === "UF_CRM_PAID").populatedOnSales, 1);
  assert.equal(report.verdicts.firstPaymentOrCashRevenue.verdict, "NO-GO");
  assert.ok(report.verdicts.firstPaymentOrCashRevenue.reasons.some((item) => /Billing\/SMPRO/.test(item)));
  assert.equal(report.periodRevenue.total.exact, "8500400.50", "the candidate field never changes the reference sum");
});

test("verdict (a): blockers for mixed currency, invalid or negative amounts; caveats for missing or zero; clean data is GO", () => {
  const rows = (items) => items.map(([value, currency], index) => ({ dealId: String(index + 1), sourceId: "CRM_FORM", sourceLabel: "CRM-форма", currency, ...parseOpportunity(value) }));
  const verdictFor = (items, unresolvedCount = 0) => decideVerdicts({ period: buildRevenueReference(rows(items)), unresolvedCount, candidates: [] }).opportunityBasedSalesValue;

  assert.equal(verdictFor([["100", "UZS"], ["200", "UZS"]]).verdict, "GO");
  assert.equal(verdictFor([["100", "UZS"], ["0", "UZS"]]).verdict, "GO WITH CAVEATS");
  assert.equal(verdictFor([["100", "UZS"], [undefined, "UZS"]]).verdict, "GO WITH CAVEATS");
  assert.equal(verdictFor([["100", "UZS"]], 1).verdict, "GO WITH CAVEATS");
  assert.equal(verdictFor([["100", "UZS"], ["5", "USD"]]).verdict, "NO-GO as a single total");
  assert.equal(verdictFor([["100", "UZS"], ["abc", "UZS"]]).verdict, "NO-GO as a single total");
  assert.equal(verdictFor([["100", "UZS"], ["-5", "UZS"]]).verdict, "NO-GO as a single total");
  assert.match(verdictFor([["100", "UZS"]]).label, /NOT cash received/);
});

test("amount-field discovery matches titles only and reports how many sales populate each field", () => {
  const fields = { OPPORTUNITY: { title: "Сумма" }, UF_CRM_A: { formLabel: "Первый платёж" }, UF_CRM_B: { formLabel: "Источник" } };
  const found = findAmountFieldCandidates(fields, [{ OPPORTUNITY: "5", UF_CRM_A: "" }, { OPPORTUNITY: "0", UF_CRM_A: "7" }]);
  assert.deepEqual(found.map((item) => [item.key, item.populatedOnSales]), [["OPPORTUNITY", 1], ["UF_CRM_A", 1]]);
});

test("the Revenue audit is read-only, keeps raw Deal payloads out of the report, and never carries a webhook", async () => {
  const source = await readFile(new URL("../scripts/ibox-revenue-evidence.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|raw_deals|analytics_records)\b/);
  assert.doesNotMatch(source, /\b(?:startSync|runSync|Backfill|backfill)\b/);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /(?:stdout|stderr)\.write\([^)]*environment/);

  const { call } = fixture();
  const report = await extractIboxRevenueEvidence({ call, config });
  const temp = await mkdtemp(path.join(tmpdir(), "ibox-revenue-evidence-test-"));
  try {
    const files = await writeRevenueAuditOutput(report, temp);
    const serialized = `${JSON.stringify(report)}\n${renderRevenueSummary(report)}\n${await readFile(files.jsonPath, "utf8")}\n${await readFile(files.summaryPath, "utf8")}`;
    assert.doesNotMatch(serialized, /\/rest\/\d+\//);
    assert.doesNotMatch(serialized, /"DATE_CREATE"/, "no raw Deal payload in the report");
    assert.match(serialized, /VERDICT \(b\) true first-payment \/ cash revenue: NO-GO/);
    assert.match(serialized, /PERIOD REVENUE = SUM\(OPPORTUNITY\), all sources: 8,500,400.5/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
