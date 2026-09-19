#!/usr/bin/env node

// Read-only IBOX Revenue / "Sotuv summasi" live reference.
//
// Reuses the Sales audit (and through it the canonical Lead / SQL cohort) for the
// verified populations: period Sales by wonAt and cohort Sales by DATE_CREATE.
// Then reproduces the CURRENT dashboard formula, SUM(OPPORTUNITY), over exactly
// those Deals and reports its data quality. It does not claim the sum is cash
// received or a first payment: OPPORTUNITY is the Deal amount, and this script
// reads no payment, invoice or billing data. Read-only Bitrix methods only; no
// D1, no data-refresh jobs, no webhook in output.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceError, TIMEZONE, createBitrixClient, callWithTransientRetry, parseCliArgs } from "./ibox-lead-evidence.mjs";
import { DASHBOARD_ROUTING_PATTERNS, collectIboxLeadSqlRows, normalizeName } from "./ibox-sql-evidence.mjs";
import { summarizeSales } from "./ibox-sales-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REVENUE_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-revenue-evidence");

function scalar(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

const NO_CURRENCY = "(no CURRENCY_ID)";

/**
 * How ONE raw OPPORTUNITY reads. `dashboardValue` is exactly what
 * lib/analytics.ts stores: Number(OPPORTUNITY ?? 0), and 0 when that is not
 * finite — so a missing or non-numeric amount silently becomes 0 there. `state`
 * says what the amount really was.
 */
export function parseOpportunity(raw) {
  const asNumber = Number(raw ?? 0);
  const dashboardValue = Number.isFinite(asNumber) ? asNumber : 0;
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (raw === undefined || raw === null || text === "") return { state: "MISSING", value: null, dashboardValue };
  const value = Number(text);
  if (!Number.isFinite(value)) return { state: "INVALID", value: null, dashboardValue };
  return { state: value < 0 ? "NEGATIVE" : value === 0 ? "ZERO" : "POSITIVE", value, dashboardValue };
}

const toCents = (value) => Math.round(value * 100);
const fromCents = (cents) => (cents / 100).toFixed(2);

/** Mirrors `average` / `median` in lib/dashboard-metrics.ts (zeros included). */
function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const rounded = (value) => (value === null ? null : Math.round(value * 100) / 100);

function idsWhere(rows, predicate) {
  const ids = rows.filter(predicate).map((row) => row.dealId).sort(compareIds);
  return { count: ids.length, ids };
}

const isCrmForm = (row) => normalizeName(row.sourceLabel) === normalizeName("CRM-форма");

function sumBlock(rows) {
  const dashboardFormulaFloat = rows.reduce((sum, row) => sum + row.dashboardValue, 0);
  const exactCents = rows.reduce((sum, row) => sum + toCents(row.dashboardValue), 0);
  return {
    count: rows.length,
    dashboardFormulaFloat,
    exact: fromCents(exactCents),
    floatMinusExact: rounded(dashboardFormulaFloat - exactCents / 100),
  };
}

function statsBlock(rows) {
  const all = rows.map((row) => row.dashboardValue);
  const positive = rows.filter((row) => row.state === "POSITIVE").map((row) => row.dashboardValue);
  return {
    dashboardFormula: { basis: "every Deal, zeros included (as the dashboard averages)", average: rounded(average(all)), median: rounded(median(all)) },
    positiveOnly: { basis: "Deals with a positive OPPORTUNITY", count: positive.length, average: rounded(average(positive)), median: rounded(median(positive)) },
  };
}

/** Revenue reference for ONE population of won Deals. */
export function buildRevenueReference(rows) {
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  const byCurrency = currencies.map((currency) => {
    const inCurrency = rows.filter((row) => row.currency === currency);
    return { currency, ...sumBlock(inCurrency), stats: statsBlock(inCurrency) };
  });
  const sources = new Map();
  for (const row of rows) {
    const key = `${row.sourceId}\u0000${row.sourceLabel}`;
    const item = sources.get(key) ?? { sourceId: row.sourceId, sourceLabel: row.sourceLabel, rows: [] };
    item.rows.push(row);
    sources.set(key, item);
  }
  const negative = rows.filter((row) => row.state === "NEGATIVE");
  return {
    total: sumBlock(rows),
    crmForm: (() => { const crm = rows.filter(isCrmForm); return { ...sumBlock(crm), stats: statsBlock(crm), byCurrency: [...new Set(crm.map((row) => row.currency))].sort().map((currency) => ({ currency, ...sumBlock(crm.filter((row) => row.currency === currency)) })) }; })(),
    bySource: [...sources.values()]
      .map((item) => ({
        sourceId: item.sourceId, sourceLabel: item.sourceLabel, ...sumBlock(item.rows),
        byCurrency: [...new Set(item.rows.map((row) => row.currency))].sort().map((currency) => ({ currency, ...sumBlock(item.rows.filter((row) => row.currency === currency)) })),
      }))
      .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel) || left.sourceId.localeCompare(right.sourceId)),
    byCurrency,
    currencies,
    stats: statsBlock(rows),
    dataQuality: {
      positive: idsWhere(rows, (row) => row.state === "POSITIVE"),
      missing: idsWhere(rows, (row) => row.state === "MISSING"),
      zero: idsWhere(rows, (row) => row.state === "ZERO"),
      negative: { ...idsWhere(rows, (row) => row.state === "NEGATIVE"), value: fromCents(negative.reduce((sum, row) => sum + toCents(row.value), 0)) },
      invalidNonNumeric: idsWhere(rows, (row) => row.state === "INVALID"),
      noCurrency: idsWhere(rows, (row) => row.currency === NO_CURRENCY),
    },
    dealValues: [...rows].sort((left, right) => compareIds(left.dealId, right.dealId)).map((row) => ({
      dealId: row.dealId, opportunity: row.value === null ? null : row.value, state: row.state, currency: row.currency,
      sourceLabel: row.sourceLabel, dashboardValue: row.dashboardValue,
    })),
    reconciliation: {
      sumOfListedDealValues: fromCents(rows.reduce((sum, row) => sum + toCents(row.dashboardValue), 0)),
      sumOfPerCurrencySums: fromCents(byCurrency.reduce((sum, item) => sum + Math.round(Number(item.exact) * 100), 0)),
      holds: rows.reduce((sum, row) => sum + toCents(row.dashboardValue), 0) === byCurrency.reduce((sum, item) => sum + Math.round(Number(item.exact) * 100), 0),
    },
  };
}

const CANDIDATE_PATTERN = /оплат|платеж|платёж|payment|paid|invoice|счет|счёт|сумма|amount|first|перв|cash|касс|billing|smpro|тариф|tariff|подписк|subscription|contract|договор/i;

/** Fields on the Deal that could carry a payment-like amount, for human review. Titles only. */
export function findAmountFieldCandidates(fields, deals) {
  const entries = Object.entries(fields ?? {});
  return entries.flatMap(([key, field]) => {
    const meta = field && typeof field === "object" ? field : {};
    const title = scalar(meta.formLabel ?? meta.listLabel ?? meta.title ?? meta.EDIT_FORM_LABEL ?? meta.LIST_COLUMN_LABEL);
    if (!CANDIDATE_PATTERN.test(`${key} ${title}`) && key !== "OPPORTUNITY") return [];
    const populated = deals.filter((deal) => {
      const value = deal?.[key];
      return !(value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length) || value === "0" || value === 0 || value === "0.00");
    }).length;
    return [{ key, title: title || key, type: scalar(meta.type ?? meta.USER_TYPE_ID), populatedOnSales: populated, salesChecked: deals.length }];
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function opportunityFacts(deals) {
  const count = (predicate) => deals.filter(predicate).length;
  return {
    dealsChecked: deals.length,
    isManualOpportunity: { yes: count((deal) => scalar(deal.IS_MANUAL_OPPORTUNITY).toUpperCase() === "Y"), no: count((deal) => scalar(deal.IS_MANUAL_OPPORTUNITY).toUpperCase() === "N"), absent: count((deal) => deal.IS_MANUAL_OPPORTUNITY === undefined) },
    opportunityAccountDiffersFromOpportunity: count((deal) => deal.OPPORTUNITY_ACCOUNT !== undefined && Number(deal.OPPORTUNITY_ACCOUNT) !== Number(deal.OPPORTUNITY)),
    accountCurrencyDiffersFromDealCurrency: count((deal) => deal.ACCOUNT_CURRENCY_ID !== undefined && scalar(deal.ACCOUNT_CURRENCY_ID) !== scalar(deal.CURRENCY_ID)),
    taxValueNonZero: count((deal) => Number(deal.TAX_VALUE ?? 0) !== 0),
  };
}

export function decideVerdicts({ period, unresolvedCount, candidates }) {
  const quality = period.dataQuality;
  const blockers = [];
  const caveats = [];
  if (period.currencies.length > 1) blockers.push("MULTIPLE_CURRENCIES: the dashboard adds them into one number and labels it with a single currency");
  if (quality.noCurrency.count) blockers.push("MISSING_CURRENCY_ID: the dashboard shows an empty currency as UZS");
  if (quality.invalidNonNumeric.count) blockers.push("INVALID_OPPORTUNITY: non-numeric amounts are silently read as 0");
  if (quality.negative.count) blockers.push("NEGATIVE_OPPORTUNITY: the dashboard subtracts them");
  if (quality.missing.count) caveats.push("MISSING_OPPORTUNITY: read as 0 and included in average and median");
  if (quality.zero.count) caveats.push("ZERO_OPPORTUNITY: counted as sales with no value");
  if (unresolvedCount) caveats.push("UNRESOLVED_EVIDENCE: the sale population itself is not fully resolved");
  return {
    opportunityBasedSalesValue: {
      label: "deal value (OPPORTUNITY) of won Deals — 'Sotuv summasi'; NOT cash received",
      verdict: blockers.length ? "NO-GO as a single total" : caveats.length ? "GO WITH CAVEATS" : "GO",
      blockers,
      caveats,
    },
    firstPaymentOrCashRevenue: {
      verdict: "NO-GO",
      reasons: [
        "OPPORTUNITY is the Deal amount (expected / contract value entered on the card or summed from product rows). Bitrix does not record it as a payment.",
        "The dashboard reads no payment, invoice or billing record; sync selects OPPORTUNITY and CURRENCY_ID only. Stage history rows carry stage and time, no amount.",
        "The Deal has no verified first-payment field in this data source. Candidate fields below are listed for human review only and are not treated as first-payment evidence.",
        "SaaS first-payment revenue needs an external Billing/SMPRO source (payment date and amount). It is not integrated here.",
      ],
      candidateFieldsForReview: candidates,
    },
  };
}

const money = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function extractIboxRevenueEvidence({ call, config, now = () => new Date(), retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS }) {
  const snapshotStartedAt = now().toISOString();
  const collected = await collectIboxLeadSqlRows({ call, config, retryOptions, routingPatterns });
  const sales = summarizeSales({ config, bounds: collected.bounds, collected });
  const dealFields = await callWithTransientRetry(call, "crm.deal.fields", {}, retryOptions);

  const sourceOf = new Map();
  for (const groupItem of [...sales.periodSales.bySource, ...sales.cohortSales.bySource]) {
    for (const id of groupItem.ids) sourceOf.set(id, { sourceId: groupItem.sourceId, sourceLabel: groupItem.sourceLabel });
  }
  const toRow = (dealId) => {
    const lookup = collected.currentDeals.get(dealId);
    if (lookup?.kind !== "FOUND") throw new EvidenceError("SALE_DEAL_NOT_READABLE", `Deal ${dealId} is a counted sale but its current record was not readable`);
    const deal = lookup.deal;
    return { dealId, ...sourceOf.get(dealId), currency: scalar(deal.CURRENCY_ID) || NO_CURRENCY, ...parseOpportunity(deal.OPPORTUNITY), deal };
  };
  const periodRows = sales.periodSales.all.ids.map(toRow);
  const cohortRows = sales.cohortSales.all.ids.map(toRow);
  const period = buildRevenueReference(periodRows);
  const cohort = buildRevenueReference(cohortRows);
  const createdBeforeRows = periodRows.filter((row) => sales.periodSales.createdBeforeRange.ids.includes(row.dealId));
  const createdBefore = { ...buildRevenueReference(createdBeforeRows), ids: createdBeforeRows.map((row) => row.dealId).sort(compareIds) };
  const allSaleDeals = [...new Map([...periodRows, ...cohortRows].map((row) => [row.dealId, row.deal])).values()];
  const candidates = findAmountFieldCandidates(dealFields?.result, allSaleDeals);
  const overlap = periodRows.filter((row) => cohortRows.some((item) => item.dealId === row.dealId)).map((row) => row.dealId).sort(compareIds);
  const snapshotCompletedAt = now().toISOString();

  const report = {
    schemaVersion: 1,
    kind: "ibox-revenue-evidence",
    result: sales.unresolved.count ? "COMPLETE_WITH_UNRESOLVED" : "COMPLETE",
    snapshot: { startedAt: snapshotStartedAt, completedAt: snapshotCompletedAt },
    config: {
      categoryId: String(config.categoryId),
      postSaleCategoryId: String(config.postSaleCategoryId),
      failureReasonField: config.failureReasonField,
      timezone: TIMEZONE,
      fromDateInclusive: collected.bounds.from,
      toDateInclusive: collected.bounds.to,
      formulaAudited: "SUM(OPPORTUNITY) over period Sales (wonAt in range); cohort revenue over cohort Sales (DATE_CREATE in range)",
      semanticsClaim: "OPPORTUNITY is the Deal amount, not payment received. This audit does not treat the sum as cash or first-payment revenue.",
      methods: ["crm.stagehistory.list", "crm.deal.get", "crm.deal.fields", "crm.status.list"],
    },
    reconciliation: {
      ...sales.reconciliation,
      cohortSales: sales.cohortSales.all.count,
      periodSales: sales.periodSales.all.count,
      periodSalesCrmForm: sales.periodSales.crmForm.count,
      periodSalesCreatedBeforeRange: sales.periodSales.createdBeforeRange.ids,
    },
    periodRevenue: { ...period, createdBeforeRange: createdBefore },
    cohortRevenue: cohort,
    periodAndCohortOverlap: { note: "Deals that are both cohort Sales and period Sales. The two revenues are different populations and must not be added.", count: overlap.length, ids: overlap },
    currencyDiagnostics: {
      period: { currencies: period.currencies, byCurrency: period.byCurrency.map(({ currency, count, exact }) => ({ currency, count, exact })), mixed: period.currencies.length > 1 },
      cohort: { currencies: cohort.currencies, byCurrency: cohort.byCurrency.map(({ currency, count, exact }) => ({ currency, count, exact })), mixed: cohort.currencies.length > 1 },
    },
    opportunitySemantics: { facts: opportunityFacts(allSaleDeals), amountFieldCandidates: candidates },
    verdicts: decideVerdicts({ period, unresolvedCount: sales.unresolved.count, candidates }),
    unresolved: sales.unresolved,
  };
  // Raw deal payloads stay out of the report; only amounts, states and IDs remain.
  return report;
}

export function renderRevenueSummary(report) {
  const period = report.periodRevenue;
  const cohort = report.cohortRevenue;
  const q = period.dataQuality;
  const line = (label, group) => `${label}: ${group.count}${group.count ? ` [${group.ids.join(", ")}]` : ""}`;
  return [
    "IBOX Revenue / Sotuv summasi evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Range: ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `Formula audited: ${report.config.formulaAudited}`,
    `NOTE: ${report.config.semanticsClaim}`,
    "",
    `Reconciliation: Leads ${report.reconciliation.leads}, SQL ${report.reconciliation.sql}, Not Relevant ${report.reconciliation.notRelevant}, cohort Sales ${report.reconciliation.cohortSales}, period Sales ${report.reconciliation.periodSales} (CRM-форма ${report.reconciliation.periodSalesCrmForm})`,
    "",
    `PERIOD REVENUE = SUM(OPPORTUNITY), all sources: ${money(period.total.exact)} over ${period.total.count} Deals (dashboard float ${period.total.dashboardFormulaFloat}, float − exact ${period.total.floatMinusExact})`,
    `PERIOD REVENUE, CRM-форма: ${money(period.crmForm.exact)} over ${period.crmForm.count} Deals`,
    `COHORT REVENUE, all sources: ${money(cohort.total.exact)} over ${cohort.total.count} Deals; CRM-форма: ${money(cohort.crmForm.exact)} over ${cohort.crmForm.count}`,
    "",
    "CHECK",
    `- period average ${period.stats.dashboardFormula.average}, median ${period.stats.dashboardFormula.median} (dashboard basis, zeros included)`,
    `- period average ${period.stats.positiveOnly.average}, median ${period.stats.positiveOnly.median} over ${period.stats.positiveOnly.count} positive amounts`,
    "",
    "CREATED BEFORE RANGE, paid in period",
    ...(period.createdBeforeRange.dealValues.length
      ? period.createdBeforeRange.dealValues.map((row) => `- ${row.dealId}: ${row.opportunity ?? "(no amount)"} ${row.currency} [${row.state}]`)
      : ["- none"]),
    `- contribution: ${money(period.createdBeforeRange.total.exact)}`,
    "",
    "BY SOURCE (period)",
    ...period.bySource.map((item) => `- ${item.sourceId || "(none)"} — ${item.sourceLabel}: ${item.count} Deals, ${money(item.exact)}`),
    "",
    "CURRENCY (period)",
    ...period.byCurrency.map((item) => `- ${item.currency}: ${item.count} Deals, ${money(item.exact)}`),
    `- mixed currencies: ${report.currencyDiagnostics.period.mixed ? "YES — a single total is not meaningful" : "no"}`,
    "",
    "DATA QUALITY (period)",
    line("- missing OPPORTUNITY", q.missing),
    line("- zero OPPORTUNITY", q.zero),
    `- negative OPPORTUNITY: ${q.negative.count}${q.negative.count ? ` [${q.negative.ids.join(", ")}] value ${q.negative.value}` : ""}`,
    line("- invalid / non-numeric OPPORTUNITY", q.invalidNonNumeric),
    line("- no CURRENCY_ID", q.noCurrency),
    `- reconciliation of listed values: ${period.reconciliation.sumOfListedDealValues} = per-currency sums ${period.reconciliation.sumOfPerCurrencySums} (${period.reconciliation.holds ? "HOLDS" : "VIOLATED"})`,
    "",
    "AMOUNT-LIKE DEAL FIELDS (for human review; not first-payment evidence)",
    ...report.opportunitySemantics.amountFieldCandidates.map((item) => `- ${item.key} — ${item.title}: populated on ${item.populatedOnSales}/${item.salesChecked} sales`),
    "",
    `VERDICT (a) OPPORTUNITY-based sales value: ${report.verdicts.opportunityBasedSalesValue.verdict}`,
    ...report.verdicts.opportunityBasedSalesValue.blockers.map((item) => `  BLOCKER ${item}`),
    ...report.verdicts.opportunityBasedSalesValue.caveats.map((item) => `  CAVEAT ${item}`),
    `VERDICT (b) true first-payment / cash revenue: ${report.verdicts.firstPaymentOrCashRevenue.verdict}`,
    ...report.verdicts.firstPaymentOrCashRevenue.reasons.map((item) => `  - ${item}`),
    "",
    `UNRESOLVED evidence: ${report.unresolved.count}`,
    "",
    "PERIOD DEAL VALUES (Deal ID, OPPORTUNITY, currency, source)",
    ...period.dealValues.map((row) => `${row.dealId}\t${row.opportunity ?? ""}\t${row.currency}\t${row.sourceLabel}\t${row.state}`),
    "",
  ].join("\n");
}

export async function writeRevenueAuditOutput(report, auditDir = DEFAULT_REVENUE_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderRevenueSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write("Read-only IBOX Revenue / Sotuv summasi evidence audit\n\nUsage:\n  npm run audit:ibox-revenue -- --category-id <IBOX_CATEGORY_ID> --post-sale-category-id <POST_SALE_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD\n");
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxRevenueEvidence({ call, config });
  const files = await writeRevenueAuditOutput(report);
  process.stdout.write(renderRevenueSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX Revenue evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
