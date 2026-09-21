#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CERTIFICATION_TIMEZONE = "Asia/Tashkent";
export const ANALYTICS_EXPORT_QUERY = "SELECT deal_id, payload, json_valid(payload) AS payload_valid FROM analytics_records ORDER BY deal_id";

export const CERTIFIED_REFERENCE = Object.freeze({
  from: "2026-09-01",
  to: "2026-09-19",
  timezone: CERTIFICATION_TIMEZONE,
  metrics: Object.freeze({
    lead: 470,
    sql: 209,
    notRelevant: 230,
    saralangan: 439,
    saralanmagan: 31,
    salesLost: 80,
    cohortSales: 41,
    periodSales: 42,
    periodRevenue: 18_862_500,
    cohortRevenue: 18_303_500,
    currency: "UZS",
  }),
  deal: Object.freeze({ dealId: "40099", periodSale: true, opportunity: 559_000, currency: "UZS" }),
});

export const REQUESTED_ATTRIBUTION_SOURCES = Object.freeze([
  "OWNER_CONFIRMED",
  "POST_SALE_OBSERVER",
  "STAGE_MOVER",
  "FIRST_CALL",
  "CUSTOM_FIELD",
  "UNKNOWN",
]);

const CERTIFIED_ATTRIBUTION_SOURCES = new Set([
  "OWNER_CONFIRMED",
  "POST_SALE_OBSERVER",
  "STAGE_MOVER",
  "CUSTOM_FIELD",
]);
const KNOWN_UNCERTIFIED_ATTRIBUTION_SOURCES = new Set(["FIRST_CALL", "UNKNOWN", "CURRENT_RESPONSIBLE"]);
const REVIEW_VALUES = new Set(["HUMAN_REVIEW", "HUMAN_REVIEW_REQUIRED"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TASHKENT_OFFSET = "+05:00";

function string(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function finiteMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function boundsFromTashkentKeys(from, to) {
  if (!DATE_KEY.test(from) || !DATE_KEY.test(to) || from > to) {
    throw new Error("Date range must be ordered YYYY-MM-DD keys");
  }
  return {
    from: new Date(`${from}T00:00:00${TASHKENT_OFFSET}`).getTime(),
    to: new Date(`${to}T23:59:59.999${TASHKENT_OFFSET}`).getTime(),
  };
}

function inBounds(value, bounds) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= bounds.from && time <= bounds.to;
}

/**
 * Mirrors the post-release canonical Lead predicate while retaining the legacy
 * fallback needed to audit pre-membership analytics rows.
 */
export function isCertificationLead(record) {
  if (record.currentScope === "OUT_OF_SCOPE" || record.currentScope === "UNAVAILABLE") return false;
  if (record.projectLeadMembership) return record.projectLeadMembership !== "EXCLUDED";
  return record.lossReasonGroup !== "ROUTING";
}

function uniqueIds(records) {
  return new Set(records.map((record) => string(record.dealId))).size === records.length;
}

function duplicateIds(records) {
  const seen = new Set();
  const duplicates = new Set();
  for (const record of records) {
    const id = string(record.dealId);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function deduplicateRecords(records) {
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const id = string(record.dealId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push({ ...record, dealId: id });
  }
  return unique;
}

function moneySummary(records) {
  const invalidOpportunityDealIds = [];
  const byCurrency = {};
  let total = 0;
  for (const record of records) {
    const amount = finiteMoney(record.opportunity);
    if (amount === null) {
      invalidOpportunityDealIds.push(string(record.dealId));
      continue;
    }
    const currency = string(record.currencyId) || "MISSING";
    byCurrency[currency] = (byCurrency[currency] ?? 0) + amount;
    total += amount;
  }
  const currencies = Object.keys(byCurrency).sort();
  return {
    total: invalidOpportunityDealIds.length || currencies.length > 1 || currencies.includes("MISSING") ? null : total,
    independentlySummedOpportunity: total,
    currency: currencies.length === 1 && currencies[0] !== "MISSING" ? currencies[0] : null,
    byCurrency,
    currencies,
    invalidOpportunityDealIds,
  };
}

function metricPopulation(name, records) {
  return { name, count: records.length, dealIds: records.map((row) => string(row.dealId)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
}

export function calculateCertificationMetrics(records, range) {
  const bounds = boundsFromTashkentKeys(range.from, range.to);
  const cohort = records.filter((record) => inBounds(record.createdAt, bounds));
  const eligible = cohort.filter(isCertificationLead);
  const sql = eligible.filter((record) => record.qualified === true);
  const notRelevant = eligible.filter((record) => record.lossReasonGroup === "MARKETING");
  const classified = eligible.filter((record) => record.qualified === true || record.lossReasonGroup === "MARKETING");
  const unclassified = eligible.filter((record) => record.qualified !== true && record.lossReasonGroup !== "MARKETING");
  const salesLost = eligible.filter((record) => record.qualified === true && record.lossReasonGroup === "SALES");
  const cohortSales = eligible.filter((record) => record.salesStatus === "WON");
  const periodSales = records.filter((record) => record.salesStatus === "WON" && inBounds(record.wonAt, bounds));
  const periodMoney = moneySummary(periodSales);
  const cohortMoney = moneySummary(cohortSales);
  const percent = (part, whole) => whole ? Math.round((part / whole) * 100) : 0;

  return {
    range: { ...range, timezone: CERTIFICATION_TIMEZONE },
    populations: {
      cohort: metricPopulation("Created cohort before eligibility", cohort),
      lead: metricPopulation("Lead", eligible),
      sql: metricPopulation("SQL", sql),
      notRelevant: metricPopulation("Not Relevant", notRelevant),
      saralangan: metricPopulation("Saralangan", classified),
      saralanmagan: metricPopulation("Saralanmagan", unclassified),
      salesLost: metricPopulation("Sales Lost", salesLost),
      cohortSales: metricPopulation("Cohort Sales", cohortSales),
      periodSales: metricPopulation("Period Sales", periodSales),
    },
    values: {
      lead: eligible.length,
      sql: sql.length,
      notRelevant: notRelevant.length,
      saralangan: classified.length,
      saralanmagan: unclassified.length,
      salesLost: salesLost.length,
      cohortSales: cohortSales.length,
      periodSales: periodSales.length,
      periodRevenue: periodMoney.total,
      cohortRevenue: cohortMoney.total,
      periodCurrency: periodMoney.currency,
      cohortCurrency: cohortMoney.currency,
      leadToSql: percent(sql.length, eligible.length),
      sqlToSale: percent(cohortSales.length, sql.length),
      leadToSale: percent(cohortSales.length, eligible.length),
    },
    money: { period: periodMoney, cohort: cohortMoney },
  };
}

function invariant(id, pass, detail, dealIds = []) {
  return { id, status: pass ? "PASS" : "FAIL", detail, dealIds };
}

function metricFingerprint(record) {
  return JSON.stringify({
    dealId: string(record.dealId),
    createdAt: record.createdAt ?? null,
    currentScope: record.currentScope ?? null,
    projectLeadMembership: record.projectLeadMembership ?? null,
    lossReasonGroup: record.lossReasonGroup ?? null,
    qualified: record.qualified ?? null,
    salesStatus: record.salesStatus ?? null,
    wonAt: record.wonAt ?? null,
    opportunity: finiteMoney(record.opportunity),
    currencyId: string(record.currencyId),
  });
}

export function compareSellerMutationIsolation(beforeRecords, afterRecords) {
  const before = new Map(beforeRecords.map((row) => [string(row.dealId), metricFingerprint(row)]));
  const after = new Map(afterRecords.map((row) => [string(row.dealId), metricFingerprint(row)]));
  const changedDealIds = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) if (before.get(id) !== after.get(id)) changedDealIds.push(id);
  return invariant(
    "seller_changes_preserve_non_seller_metrics",
    changedDealIds.length === 0,
    changedDealIds.length ? "Seller comparison changed a metric-bearing field" : "Only seller fields changed between inputs",
    changedDealIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  );
}

export function buildInvariants(rawRecords, uniqueRecords, metrics, inputIssues = [], comparisonRecords = null) {
  const populations = Object.values(metrics.populations);
  const sqlIds = new Set(metrics.populations.sql.dealIds);
  const nrIds = new Set(metrics.populations.notRelevant.dealIds);
  const overlap = [...sqlIds].filter((id) => nrIds.has(id));
  const lostOutsideSql = metrics.populations.salesLost.dealIds.filter((id) => !sqlIds.has(id));
  const wonNotQualified = [...metrics.populations.cohortSales.dealIds, ...metrics.populations.periodSales.dealIds]
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => uniqueRecords.find((row) => string(row.dealId) === id)?.qualified !== true);
  const periodIds = new Set(metrics.populations.periodSales.dealIds);
  const populationOverlap = metrics.populations.cohortSales.dealIds.filter((id) => periodIds.has(id));
  const sellerMutatedMetrics = calculateCertificationMetrics(uniqueRecords.map((record) => ({
    ...record,
    salesManagerId: "CERTIFICATION_MUTATION",
    salesManager: "CERTIFICATION_MUTATION",
    salesManagerAttribution: "UNKNOWN",
  })), { from: metrics.range.from, to: metrics.range.to });
  const sellerFieldsAreIsolated = JSON.stringify(sellerMutatedMetrics.values) === JSON.stringify(metrics.values)
    && JSON.stringify(sellerMutatedMetrics.populations) === JSON.stringify(metrics.populations);
  const invariants = [
    invariant("input_payloads_valid", inputIssues.length === 0, inputIssues.length ? "Input contains invalid or missing payload rows" : "Every exported payload parsed", inputIssues.map((issue) => issue.dealId).filter(Boolean)),
    invariant("one_input_row_per_deal", duplicateIds(rawRecords).length === 0, "Analytics input must contain one row per Bitrix Deal ID", duplicateIds(rawRecords)),
    invariant("lead_equals_sql_plus_nr_plus_saralanmagan", metrics.values.lead === metrics.values.sql + metrics.values.notRelevant + metrics.values.saralanmagan, `${metrics.values.lead} = ${metrics.values.sql} + ${metrics.values.notRelevant} + ${metrics.values.saralanmagan}`),
    invariant("not_relevant_not_sql", overlap.length === 0, "Final quality classification cannot contain the same Deal in SQL and Not Relevant", overlap),
    invariant("sales_lost_subset_of_sql", lostOutsideSql.length === 0, "Every Sales Lost Deal must be SQL", lostOutsideSql),
    invariant("won_is_qualified", wonNotQualified.length === 0, "Every won Deal must be quality accepted", wonNotQualified),
    invariant("no_deal_duplicated_inside_metric", populations.every((population) => uniqueIds(population.dealIds.map((dealId) => ({ dealId })))), "Every metric population contains unique Deal IDs"),
    invariant("cohort_and_period_sales_are_separate_selectors", true, `Cohort Sales uses createdAt; Period Sales uses wonAt; overlap=${populationOverlap.length}`, populationOverlap),
    invariant("period_revenue_equals_sum_opportunity", metrics.money.period.invalidOpportunityDealIds.length === 0 && metrics.values.periodRevenue === metrics.money.period.independentlySummedOpportunity, "Period Revenue is the sum of Period Sales OPPORTUNITY", metrics.money.period.invalidOpportunityDealIds),
    invariant("cohort_revenue_equals_sum_opportunity", metrics.money.cohort.invalidOpportunityDealIds.length === 0 && metrics.values.cohortRevenue === metrics.money.cohort.independentlySummedOpportunity, "Cohort Revenue is the sum of Cohort Sales OPPORTUNITY", metrics.money.cohort.invalidOpportunityDealIds),
    invariant("no_mixed_period_currency", metrics.money.period.currencies.length <= 1 && !metrics.money.period.currencies.includes("MISSING"), `Period currencies: ${metrics.money.period.currencies.join(", ") || "none"}`),
    invariant("no_mixed_cohort_currency", metrics.money.cohort.currencies.length <= 1 && !metrics.money.cohort.currencies.includes("MISSING"), `Cohort currencies: ${metrics.money.cohort.currencies.join(", ") || "none"}`),
    invariant("seller_fields_are_metric_isolated", sellerFieldsAreIsolated, "Changing only seller fields cannot change Lead, SQL, NR, Sales, Revenue, populations, or wonAt"),
  ];
  invariants.push(comparisonRecords
    ? compareSellerMutationIsolation(uniqueRecords, comparisonRecords)
    : { id: "seller_changes_preserve_non_seller_metrics", status: "NOT_RUN", detail: "Optional cross-export check: pass --compare-input to compare pre/post seller datasets", dealIds: [] });
  return invariants;
}

function reviewValue(record) {
  return string(record.sellerReviewStatus || record.reviewStatus || record.sellerCertificationStatus).toUpperCase();
}

function sellerStructuralReview(record, source) {
  const sellerId = string(record.salesManagerId);
  const sellerName = string(record.salesManager);
  if (REVIEW_VALUES.has(reviewValue(record))) return true;
  if (!CERTIFIED_ATTRIBUTION_SOURCES.has(source) && !KNOWN_UNCERTIFIED_ATTRIBUTION_SOURCES.has(source)) return true;
  if (CERTIFIED_ATTRIBUTION_SOURCES.has(source) && (!sellerId || sellerId === "0" || !sellerName)) return true;
  if (source === "UNKNOWN" && sellerId) return true;
  return false;
}

export function buildManagerCertification(periodSales) {
  const groups = new Map();
  for (const record of periodSales) {
    const source = string(record.salesManagerAttribution).toUpperCase() || "UNKNOWN";
    const sellerId = string(record.salesManagerId);
    const seller = string(record.salesManager) || "UNKNOWN";
    const key = `${sellerId || "unknown"}\u0000${seller}\u0000${source}`;
    const group = groups.get(key) ?? {
      sellerId: sellerId || null,
      seller,
      attributionSource: source,
      salesCount: 0,
      revenueByCurrency: {},
      unknownCount: 0,
      humanReviewCount: 0,
      invalidOpportunityCount: 0,
      certification: "CERTIFIED",
      dealIds: [],
    };
    group.salesCount += 1;
    group.dealIds.push(string(record.dealId));
    const amount = finiteMoney(record.opportunity);
    const currency = string(record.currencyId) || "MISSING";
    if (amount !== null) group.revenueByCurrency[currency] = (group.revenueByCurrency[currency] ?? 0) + amount;
    else group.invalidOpportunityCount += 1;
    const unknown = source === "UNKNOWN" || !sellerId || sellerId === "0";
    const humanReview = sellerStructuralReview(record, source);
    if (unknown) group.unknownCount += 1;
    if (humanReview) group.humanReviewCount += 1;
    if (!CERTIFIED_ATTRIBUTION_SOURCES.has(source) || unknown || humanReview) group.certification = "UNCERTIFIED";
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((row) => {
    const currencies = Object.keys(row.revenueByCurrency);
    return {
      ...row,
      revenue: row.invalidOpportunityCount === 0 && currencies.length === 1 && currencies[0] !== "MISSING" ? row.revenueByCurrency[currencies[0]] : null,
      currency: row.invalidOpportunityCount === 0 && currencies.length === 1 && currencies[0] !== "MISSING" ? currencies[0] : null,
      dealIds: row.dealIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
  }).sort((a, b) => a.seller.localeCompare(b.seller) || a.attributionSource.localeCompare(b.attributionSource));
  const sourceCoverage = [...new Set([...REQUESTED_ATTRIBUTION_SOURCES, ...rows.map((row) => row.attributionSource)])]
    .map((source) => ({ source, salesCount: rows.filter((row) => row.attributionSource === source).reduce((sum, row) => sum + row.salesCount, 0) }));
  return { population: "Period Sales", rows, sourceCoverage };
}

export function sourceComparisonKey(value) {
  return string(value).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}_]+/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeSourceForAudit(record) {
  const sourceId = string(record.sourceId);
  const raw = string(record.source);
  const key = sourceComparisonKey(raw);
  if (!sourceId) return { normalizedSource: "MISSING", classification: "MISSING_SOURCE", needsReview: true };
  if ((sourceId && raw === sourceId) || ["unknown", "aniqlanmagan", "неизвестно", "не указано"].includes(key)) {
    return { normalizedSource: "UNKNOWN", classification: "UNKNOWN_SOURCE", needsReview: true };
  }
  if (["crm forma", "crm форма"].includes(key)) return { normalizedSource: "CRM-forma", classification: "CRM_FORMA", needsReview: false };
  if (key === "meta") return { normalizedSource: "Meta", classification: "META", needsReview: false };
  if (key === "google") return { normalizedSource: "Google", classification: "GOOGLE", needsReview: false };
  if (["organic", "other", "organic other"].includes(key)) return { normalizedSource: "organic/other", classification: "ORGANIC_OTHER", needsReview: false };
  return { normalizedSource: raw || sourceId, classification: "UNMAPPED", needsReview: true };
}

export function buildSourceCertification(cohort) {
  const eligible = cohort.filter(isCertificationLead);
  const groups = new Map();
  for (const record of eligible) {
    const rawSourceId = string(record.sourceId);
    const rawSource = string(record.source) || "Aniqlanmagan";
    const audit = normalizeSourceForAudit(record);
    const key = `${rawSourceId}\u0000${rawSource}`;
    const row = groups.get(key) ?? {
      rawSourceId,
      rawSource,
      normalizedSource: audit.normalizedSource,
      classification: audit.classification,
      needsReview: audit.needsReview,
      comparisonKey: sourceComparisonKey(rawSource),
      dealCount: 0,
      sqlCount: 0,
      salesCount: 0,
      revenueByCurrency: {},
      invalidOpportunityCount: 0,
    };
    row.dealCount += 1;
    if (record.qualified === true) row.sqlCount += 1;
    if (record.salesStatus === "WON") {
      row.salesCount += 1;
      const amount = finiteMoney(record.opportunity);
      const currency = string(record.currencyId) || "MISSING";
      if (amount !== null) row.revenueByCurrency[currency] = (row.revenueByCurrency[currency] ?? 0) + amount;
      else row.invalidOpportunityCount += 1;
    }
    groups.set(key, row);
  }
  const rows = [...groups.values()].map((row) => {
    const currencies = Object.keys(row.revenueByCurrency);
    return {
      ...row,
      revenue: row.invalidOpportunityCount === 0 && currencies.length === 1 && currencies[0] !== "MISSING" ? row.revenueByCurrency[currencies[0]] : null,
      currency: row.invalidOpportunityCount === 0 && currencies.length === 1 && currencies[0] !== "MISSING" ? currencies[0] : null,
    };
  }).sort((a, b) => b.dealCount - a.dealCount || a.rawSource.localeCompare(b.rawSource));
  const spellings = new Map();
  for (const row of rows) {
    if (!row.comparisonKey) continue;
    const names = spellings.get(row.comparisonKey) ?? new Set();
    names.add(row.rawSource);
    spellings.set(row.comparisonKey, names);
  }
  const duplicateSpellings = [...spellings.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([comparisonKey, names]) => ({ comparisonKey, rawSources: [...names].sort() }));
  return { population: "Eligible created cohort", rows, duplicateSpellings };
}

export function validateCertifiedReference(metrics, records) {
  const checks = [];
  for (const [metric, expected] of Object.entries(CERTIFIED_REFERENCE.metrics)) {
    const actual = metric === "currency" ? metrics.values.periodCurrency : metrics.values[metric];
    checks.push({ id: `reference_${metric}`, expected, actual, status: actual === expected ? "PASS" : "FAIL" });
  }
  const deal = records.find((record) => string(record.dealId) === CERTIFIED_REFERENCE.deal.dealId);
  const periodIds = new Set(metrics.populations.periodSales.dealIds);
  const dealChecks = [
    { id: "reference_deal_40099_present", expected: true, actual: Boolean(deal) },
    { id: "reference_deal_40099_period_sale", expected: true, actual: periodIds.has("40099") },
    { id: "reference_deal_40099_opportunity", expected: 559_000, actual: deal ? finiteMoney(deal.opportunity) : null },
    { id: "reference_deal_40099_currency", expected: "UZS", actual: deal ? string(deal.currencyId) : null },
  ].map((check) => ({ ...check, status: check.actual === check.expected ? "PASS" : "FAIL" }));
  return { range: CERTIFIED_REFERENCE, checks: [...checks, ...dealChecks] };
}

export function buildCertificationReport(rawRecords, options = {}) {
  const range = options.range ?? { from: CERTIFIED_REFERENCE.from, to: CERTIFIED_REFERENCE.to };
  const uniqueRecords = deduplicateRecords(rawRecords);
  const metrics = calculateCertificationMetrics(uniqueRecords, range);
  const referenceEnabled = options.reference !== false && range.from === CERTIFIED_REFERENCE.from && range.to === CERTIFIED_REFERENCE.to;
  const reference = referenceEnabled ? validateCertifiedReference(metrics, uniqueRecords) : null;
  const cohortRows = uniqueRecords.filter((record) => inBounds(record.createdAt, boundsFromTashkentKeys(range.from, range.to)));
  const managers = buildManagerCertification(uniqueRecords.filter((record) => metrics.populations.periodSales.dealIds.includes(string(record.dealId))));
  const sources = buildSourceCertification(cohortRows);
  const invariants = buildInvariants(rawRecords, uniqueRecords, metrics, options.inputIssues ?? [], options.comparisonRecords ?? null);
  invariants.push(
    invariant("manager_sales_reconcile_to_period_sales", managers.rows.reduce((sum, row) => sum + row.salesCount, 0) === metrics.values.periodSales, "Manager sales rows must sum to Period Sales"),
    invariant("source_deals_reconcile_to_lead", sources.rows.reduce((sum, row) => sum + row.dealCount, 0) === metrics.values.lead, "Exact raw-source rows must sum to Lead"),
    invariant("source_sql_reconcile_to_sql", sources.rows.reduce((sum, row) => sum + row.sqlCount, 0) === metrics.values.sql, "Exact raw-source SQL rows must sum to SQL"),
    invariant("source_sales_reconcile_to_cohort_sales", sources.rows.reduce((sum, row) => sum + row.salesCount, 0) === metrics.values.cohortSales, "Exact raw-source sales rows must sum to Cohort Sales"),
  );
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    analyticsQuery: ANALYTICS_EXPORT_QUERY,
    input: { rawRows: rawRecords.length, uniqueDeals: uniqueRecords.length, duplicateDealIds: duplicateIds(rawRecords), issues: options.inputIssues ?? [] },
    metrics,
    invariants,
    reference,
    managers,
    sources,
  };
  const failed = invariants.some((check) => check.status === "FAIL") || Boolean(reference?.checks.some((check) => check.status === "FAIL"));
  return { ...report, certificationStatus: failed ? "FAIL" : "PASS" };
}

function unwrapD1Rows(value) {
  if (Array.isArray(value)) {
    if (value.every((entry) => entry && typeof entry === "object" && Array.isArray(entry.results))) return value.flatMap((entry) => entry.results);
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value.records)) return value.records;
  if (value && typeof value === "object" && Array.isArray(value.results)) return value.results;
  throw new Error("Input must be an analytics record array, dashboard {records}, or Wrangler D1 JSON result");
}

export function parseCertificationInput(value) {
  const rows = unwrapD1Rows(value);
  const records = [];
  const issues = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      issues.push({ index, dealId: null, error: "ROW_NOT_OBJECT" });
      continue;
    }
    if (Object.hasOwn(row, "payload")) {
      const dealId = string(row.deal_id ?? row.dealId);
      if (Number(row.payload_valid) === 0) {
        issues.push({ index, dealId, error: "INVALID_JSON_PAYLOAD" });
        continue;
      }
      try {
        const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        if (!parsed || typeof parsed !== "object") throw new Error("payload is not an object");
        records.push({ ...parsed, dealId: string(parsed.dealId) || dealId });
      } catch {
        issues.push({ index, dealId, error: "INVALID_JSON_PAYLOAD" });
      }
      continue;
    }
    records.push(row);
  }
  for (const [index, record] of records.entries()) {
    if (!string(record.dealId)) issues.push({ index, dealId: null, error: "MISSING_DEAL_ID" });
  }
  return { records, issues };
}

export async function readCertificationInput(path) {
  const text = path === "-" ? await new Promise((resolveInput, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolveInput(value));
    process.stdin.on("error", reject);
  }) : await readFile(path, "utf8");
  return parseCertificationInput(JSON.parse(text));
}

function formatMoney(value, currency) {
  return value === null ? "BLOCKED (mixed/missing currency or invalid OPPORTUNITY)" : `${value.toLocaleString("en-US")} ${currency ?? ""}`.trim();
}

export function renderCertificationText(report) {
  const value = report.metrics.values;
  const lines = [
    `DATA CERTIFICATION: ${report.certificationStatus}`,
    `Range: ${report.metrics.range.from}..${report.metrics.range.to} (${CERTIFICATION_TIMEZONE})`,
    `Input: ${report.input.rawRows} rows / ${report.input.uniqueDeals} unique Deals`,
    "",
    "KPI",
    `Lead ${value.lead}`,
    `SQL ${value.sql}`,
    `Not Relevant ${value.notRelevant}`,
    `Saralangan ${value.saralangan}`,
    `Saralanmagan ${value.saralanmagan}`,
    `Sales Lost ${value.salesLost}`,
    `Cohort Sales ${value.cohortSales}`,
    `Period Sales ${value.periodSales}`,
    `Period Revenue ${formatMoney(value.periodRevenue, value.periodCurrency)}`,
    `Cohort Revenue ${formatMoney(value.cohortRevenue, value.cohortCurrency)}`,
    `Lead -> SQL ${value.leadToSql}% | SQL -> Sale ${value.sqlToSale}% | Lead -> Sale ${value.leadToSale}%`,
    "",
    "INVARIANTS",
    ...report.invariants.map((check) => `${check.status.padEnd(7)} ${check.id}: ${check.detail}`),
  ];
  if (report.reference) {
    lines.push("", "CERTIFIED REFERENCE", ...report.reference.checks.map((check) => `${check.status.padEnd(4)} ${check.id}: expected=${check.expected} actual=${check.actual}`));
  }
  lines.push("", "MANAGER CERTIFICATION (Period Sales)");
  if (!report.managers.rows.length) lines.push("No Period Sales rows");
  for (const row of report.managers.rows) {
    lines.push(`${row.certification.padEnd(11)} ${row.seller} | ${row.attributionSource} | sales=${row.salesCount} | revenue=${formatMoney(row.revenue, row.currency)} | UNKNOWN=${row.unknownCount} | HUMAN_REVIEW=${row.humanReviewCount}`);
  }
  lines.push("", "SOURCE CERTIFICATION (created cohort)");
  if (!report.sources.rows.length) lines.push("No eligible cohort rows");
  for (const row of report.sources.rows) {
    lines.push(`${row.rawSourceId || "(missing id)"} | ${row.rawSource} -> ${row.normalizedSource} | deals=${row.dealCount} | SQL=${row.sqlCount} | sales=${row.salesCount} | revenue=${formatMoney(row.revenue, row.currency)} | ${row.classification}${row.needsReview ? " REVIEW" : ""}`);
  }
  if (report.sources.duplicateSpellings.length) {
    lines.push("", "DUPLICATE SPELLINGS", ...report.sources.duplicateSpellings.map((row) => `${row.comparisonKey}: ${row.rawSources.join(" | ")}`));
  }
  return `${lines.join("\n")}\n`;
}

async function writeAggregateReport(outputDir, report, textReport) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(resolve(outputDir, "data-certification.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(resolve(outputDir, "data-certification.txt"), textReport, { mode: 0o600 }),
  ]);
}

function usage() {
  return `Usage: node scripts/validate-data-certification.mjs --input <file|-> [options]\n\nOptions:\n  --from YYYY-MM-DD       Inclusive Tashkent date (default 2026-09-01)\n  --to YYYY-MM-DD         Inclusive Tashkent date (default 2026-09-19)\n  --compare-input <file>  Pre/post seller comparison dataset\n  --no-reference          Do not check the fixed certified reference\n  --format text|json      Stdout format (default text)\n  --output-dir <dir>      Write aggregate JSON and text reports\n  --print-query           Print the fixed read-only D1 query and exit\n`;
}

export function parseArgs(argv) {
  const options = { from: CERTIFIED_REFERENCE.from, to: CERTIFIED_REFERENCE.to, format: "text", reference: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--compare-input") options.compareInput = argv[++index];
    else if (arg === "--from") options.from = argv[++index];
    else if (arg === "--to") options.to = argv[++index];
    else if (arg === "--format") options.format = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--no-reference") options.reference = false;
    else if (arg === "--print-query") options.printQuery = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.printQuery && !options.input) throw new Error("--input is required");
  if (!["text", "json"].includes(options.format)) throw new Error("--format must be text or json");
  boundsFromTashkentKeys(options.from, options.to);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (options.printQuery) {
    process.stdout.write(`${ANALYTICS_EXPORT_QUERY}\n`);
    return 0;
  }
  const input = await readCertificationInput(options.input);
  const comparison = options.compareInput ? await readCertificationInput(options.compareInput) : null;
  const report = buildCertificationReport(input.records, {
    range: { from: options.from, to: options.to },
    inputIssues: input.issues,
    comparisonRecords: comparison?.records ?? null,
    reference: options.reference,
  });
  const textReport = renderCertificationText(report);
  if (options.outputDir) await writeAggregateReport(options.outputDir, report, textReport);
  process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : textReport);
  return report.certificationStatus === "PASS" ? 0 : 1;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`Data certification failed: ${String(error?.message ?? error).replace(/\s+/g, " ")}\n`);
    process.exitCode = 2;
  });
}
