#!/usr/bin/env node

// Read-only IBOX SQL evidence audit.
//
// Base population: the canonical IBOX Lead cohort from ibox-lead-evidence.mjs
// (entered IBOX Sales by stage history, currently in IBOX Sales or IBOX
// post-sale, DATE_CREATE in Asia/Tashkent). On top of it this script applies the
// repo's SQL semantics (lib/analytics.ts, lib/sales-logic.ts) from live Bitrix
// evidence only. It never calls a mutating Bitrix method and never touches D1
// or the dashboard's data-refresh jobs.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceError,
  TIMEZONE,
  TRANSFER_OUT_REASONS,
  classifyDealEvidence,
  createBitrixClient,
  discoverIboxDealIds,
  exhaustiveList,
  fetchCurrentDeals,
  loadFailureReasonOptions,
  loadSourceCatalog,
  parseCliArgs,
  resolveFailureReasons,
  tashkentDateBounds,
  countUnresolvedByCode,
} from "./ibox-lead-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SQL_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-sql-evidence");

/**
 * Mirrors `defaultSettings.routingReasonPatterns` in lib/business-time.ts. A
 * test asserts the two stay identical, so a change in the dashboard default
 * shows up here as a failing test instead of a silent drift.
 */
export const DASHBOARD_ROUTING_PATTERNS = Object.freeze(["idoko", "sd", "передан", "перевод", "routing", "yo'naltir", "yo‘naltir", "o'tkaz", "o‘tkaz"]);

export const SQL_BASIS = Object.freeze({
  STAGE_EVIDENCE: "SQL_STAGE_EVIDENCE",
  WON_INFERRED: "WON_INFERRED_SQL",
  PRE_SQL_CLOSED: "PRE_SQL_CLOSED_DIRECT_SALES_LOSS",
});

function scalar(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Same normalisation as `normalizePipelineName` in lib/pipelines.ts. */
export function normalizeName(value) {
  return scalar(value).normalize("NFKD").trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

// --- stage predicates: name-based mirrors of lib/sales-logic.ts -------------------
// The repo also accepts configured stage IDs from D1 settings. Those are not
// readable from here, so the live audit relies on the same name fallbacks the
// dashboard uses when nothing is configured, plus Bitrix's own failure semantics.

export function isNotRelevantName(name) {
  const value = normalizeName(name);
  return value.includes("not relevant") || value.includes("не релевант") || value.includes("sifatsiz");
}

export function isPaymentName(name) {
  if (isNotRelevantName(name)) return false;
  const value = normalizeName(name);
  return (value.includes("oplata") && (value.includes("poluch") || value.includes("olindi"))) || value.includes("оплата получена");
}

export function isQualificationName(name) {
  const value = normalizeName(name);
  return value.includes("обработ") || value.includes("processing") || value.includes("qabul qil") || value.includes("sql");
}

export function isClosedLostName(name, failureSemantic = false) {
  if (isNotRelevantName(name)) return false;
  const value = normalizeName(name);
  return failureSemantic
    || (value.includes("закрыт") && value.includes("не реализ"))
    || value.includes("yopildi sotilmadi")
    || value.includes("сделка провалена");
}

export function buildStageRules(catalogRows) {
  const stages = new Map();
  for (const row of catalogRows) {
    const id = scalar(row.STATUS_ID || row.ID);
    if (!id) continue;
    const semantics = scalar(row.EXTRA?.SEMANTICS ?? row.SEMANTICS).toLowerCase();
    stages.set(id, {
      id,
      name: scalar(row.NAME) || id,
      sort: Number(row.SORT),
      failureSemantic: semantics === "failure" || semantics === "f",
    });
  }
  const sqlStages = [...stages.values()].filter((stage) => Number.isFinite(stage.sort) && !isNotRelevantName(stage.name) && isQualificationName(stage.name));
  if (!sqlStages.length) throw new EvidenceError("SQL_STAGE_NOT_FOUND", "No SQL/Обработка stage found in the IBOX Sales stage dictionary");
  const threshold = Math.min(...sqlStages.map((stage) => stage.sort));

  const known = (stageId) => stages.has(scalar(stageId));
  const stage = (stageId) => stages.get(scalar(stageId));
  const isNotRelevant = (stageId) => Boolean(stage(stageId)) && isNotRelevantName(stage(stageId).name);
  const isPayment = (stageId) => Boolean(stage(stageId)) && isPaymentName(stage(stageId).name);
  const isClosedLost = (stageId, dealSemantic = "") => {
    const found = stage(stageId);
    return Boolean(found) && isClosedLostName(found.name, found.failureSemantic || scalar(dealSemantic).toUpperCase() === "F");
  };
  // Same precedence as isSqlOrDownstreamStage: Not Relevant and closed-lost are
  // terminal outcomes, never progression; then the SQL stage or anything at or
  // beyond its SORT in the same pipeline.
  const isSqlOrDownstream = (stageId) => {
    const found = stage(stageId);
    if (!found || isNotRelevant(stageId) || isClosedLost(stageId)) return false;
    if (isQualificationName(found.name)) return true;
    return Number.isFinite(found.sort) && found.sort >= threshold;
  };
  return {
    known, stage, isNotRelevant, isPayment, isClosedLost, isSqlOrDownstream,
    sqlStageIds: sqlStages.map((item) => item.id),
    thresholdSort: threshold,
  };
}

export function isRoutingReason(reasonText, patterns = DASHBOARD_ROUTING_PATTERNS) {
  const reason = normalizeName(reasonText);
  return patterns.some((pattern) => {
    const value = normalizeName(pattern);
    if (!value) return false;
    if (value === "sd") return /(^|[^a-zа-я0-9])sd([^a-zа-я0-9]|$)/i.test(reason);
    return reason.includes(value);
  });
}

function lossReasonText(deal, failureReasonField, failureReasonOptions) {
  if (!failureReasonOptions.fieldFound) return "";
  const actualKey = Object.keys(deal).find((key) => key.toUpperCase() === failureReasonField.toUpperCase());
  if (!actualKey) return "";
  // Labels for known enum IDs and free text; an orphan enum ID has no label and
  // never matches a routing pattern, exactly like fieldDisplayValue's raw fallback.
  return resolveFailureReasons(deal[actualKey], failureReasonOptions).labels.join(", ");
}

/**
 * SQL classification of ONE canonical IBOX Lead. Mirrors buildAnalyticsRecords:
 *   status: WON (payment anywhere in history / post-sale) > Not Relevant (current
 *           stage) > LOST (closed-lost stage) > ACTIVE
 *   qualified = status !== NOT_RELEVANT && (real SQL/downstream evidence || WON
 *               || ordinary Sales LOST)
 * No qualifiedAt is fabricated for a WON/direct-close deal without evidence.
 */
export function classifySqlEvidence({
  dealId, deal, history, hasPostSaleHistory = false, categoryId, postSaleCategoryId,
  rules, failureReasonField, failureReasonOptions, routingPatterns = DASHBOARD_ROUTING_PATTERNS,
}) {
  const currentCategoryId = scalar(deal.CATEGORY_ID);
  const currentStageId = scalar(deal.STAGE_ID);
  const inMain = currentCategoryId === String(categoryId);
  const inPostSale = currentCategoryId === String(postSaleCategoryId);
  const semantic = scalar(deal.STAGE_SEMANTIC_ID);

  // The Deal's IBOX stage trail: every recorded IBOX row plus the current stage
  // while the Deal still sits in IBOX Sales (the dashboard timeline does too).
  const historyRows = history.map((row) => ({ stageId: scalar(row.STAGE_ID), at: scalar(row.CREATED_TIME) }));
  const trail = inMain && currentStageId && !historyRows.some((row) => row.stageId === currentStageId)
    ? [...historyRows, { stageId: currentStageId, at: "" }]
    : historyRows;

  const evidenceRow = trail.find((row) => rules.isSqlOrDownstream(row.stageId)) ?? null;
  const unknownStageIds = [...new Set(trail.map((row) => row.stageId).filter((id) => id && !rules.known(id)))];
  const paymentEver = trail.some((row) => rules.isPayment(row.stageId));
  const won = paymentEver || inPostSale || hasPostSaleHistory;
  const currentNotRelevant = inMain && rules.isNotRelevant(currentStageId);
  const currentClosedLost = inMain && rules.isClosedLost(currentStageId, semantic);

  const status = won ? "WON" : currentNotRelevant ? "NOT_RELEVANT" : currentClosedLost ? "LOST" : "ACTIVE";
  const reasonText = status === "LOST" ? lossReasonText(deal, failureReasonField, failureReasonOptions) : "";
  const lossGroup = status === "LOST" ? (isRoutingReason(reasonText, routingPatterns) ? "ROUTING" : "SALES") : null;

  const base = {
    dealId: String(dealId),
    currentCategoryId,
    currentStageId,
    salesStatus: status,
    lossReasonGroup: lossGroup,
    hasSqlEvidence: Boolean(evidenceRow),
    evidenceStageId: evidenceRow?.stageId ?? null,
    // Only a real recorded stage-entry time; never invented for inferred SQL.
    qualifiedAt: evidenceRow?.at ? new Date(evidenceRow.at).toISOString() : null,
  };

  if (status !== "NOT_RELEVANT" && !evidenceRow && unknownStageIds.length) {
    return { ...base, classification: "UNRESOLVED", reason: "UNKNOWN_STAGE_ID_IN_TRAIL", unknownStageIds };
  }

  const directSalesLoss = status === "LOST" && lossGroup === "SALES";
  const qualified = status !== "NOT_RELEVANT" && (Boolean(evidenceRow) || won || directSalesLoss);
  if (!qualified) {
    return {
      ...base,
      classification: status === "NOT_RELEVANT" ? "NOT_RELEVANT" : "NOT_SQL",
      reason: status === "NOT_RELEVANT" ? "NOT_RELEVANT_NEVER_SQL" : "NO_SQL_EVIDENCE",
      ...(status === "LOST" ? { routingReasonLostWithoutEvidence: true } : {}),
    };
  }

  const basis = evidenceRow ? SQL_BASIS.STAGE_EVIDENCE : won ? SQL_BASIS.WON_INFERRED : SQL_BASIS.PRE_SQL_CLOSED;
  return {
    ...base,
    classification: "SQL",
    basis,
    // Visible diagnostic; never subtracted from SQL (lib/sales-logic.ts isPreSqlClosed).
    preSqlClosed: directSalesLoss && !evidenceRow,
    // The dashboard removes every ROUTING deal from its eligible cohort, but a
    // Deal that is still in IBOX Sales is a canonical Lead (failure reason does
    // not decide Lead membership). Kept visible so the two can be reconciled.
    ...(lossGroup === "ROUTING" ? { routingReasonInIbox: true } : {}),
    ...(status === "WON" && rules.isNotRelevant(currentStageId) && inMain ? { notRelevantButWon: true } : {}),
  };
}

function idsOf(rows) {
  return rows.map((row) => row.dealId).sort(compareIds);
}

function group(rows) {
  const ids = idsOf(rows);
  return { count: ids.length, ids };
}

function isCrmForm(row) {
  return normalizeName(row.sourceLabel) === normalizeName("CRM-форма");
}

function sourceBreakdown(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.sourceId}\u0000${row.sourceLabel}`;
    const item = groups.get(key) ?? { sourceId: row.sourceId, sourceLabel: row.sourceLabel, rows: [] };
    item.rows.push(row);
    groups.set(key, item);
  }
  return [...groups.values()]
    .map((item) => ({ sourceId: item.sourceId, sourceLabel: item.sourceLabel, ...group(item.rows) }))
    .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel) || left.sourceId.localeCompare(right.sourceId));
}

export function summarizeSql(sqlRows) {
  const sql = sqlRows.filter((row) => row.classification === "SQL");
  const notRelevant = sqlRows.filter((row) => row.classification === "NOT_RELEVANT");
  const routingInIbox = sql.filter((row) => row.routingReasonInIbox);
  const notRelevantWon = sql.filter((row) => row.notRelevantButWon);
  return {
    all: group(sql),
    crmForm: group(sql.filter(isCrmForm)),
    bySource: sourceBreakdown(sql),
    breakdown: {
      realSqlOrDownstreamEvidence: group(sql.filter((row) => row.basis === SQL_BASIS.STAGE_EVIDENCE)),
      wonOrPostSaleInferred: group(sql.filter((row) => row.basis === SQL_BASIS.WON_INFERRED)),
      preSqlClosedDirectSalesLoss: group(sql.filter((row) => row.basis === SQL_BASIS.PRE_SQL_CLOSED)),
    },
    notRelevantExcluded: {
      ...group(notRelevant),
      crmForm: group(notRelevant.filter(isCrmForm)),
      withPriorSqlEvidence: group(notRelevant.filter((row) => row.hasSqlEvidence)),
    },
    // Reference vs dashboard, computed here so a mismatch is a number, not a guess.
    dashboardComparison: {
      routingReasonLostInIbox: {
        note: "Lead by category, but the dashboard drops every ROUTING-reason LOST Deal from its eligible cohort, so it cannot count them as SQL.",
        ...group(routingInIbox),
        crmForm: group(routingInIbox.filter(isCrmForm)),
        sqlAllWithoutThem: sql.length - routingInIbox.length,
        sqlCrmFormWithoutThem: sql.filter(isCrmForm).length - routingInIbox.filter(isCrmForm).length,
      },
      notRelevantCurrentStageButWon: {
        note: "The dashboard gives payment/post-sale evidence precedence over a Not Relevant current stage (analytics.ts classifySalesStatus), which conflicts with 'Not Relevant is never SQL' read literally.",
        ...group(notRelevantWon),
      },
    },
  };
}

/**
 * Shared live collection for the SQL and Not Relevant audits: the canonical Lead
 * cohort plus one SQL-semantics classification per included Lead. Read-only.
 */
export async function collectIboxLeadSqlRows({ call, config, retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS }) {
  const bounds = tashkentDateBounds(config.from, config.to);
  if (!/^\d+$/.test(String(config.postSaleCategoryId ?? "")) || String(config.postSaleCategoryId) === String(config.categoryId)) {
    throw new EvidenceError("INVALID_POST_SALE_CATEGORY", "postSaleCategoryId is required, numeric and different from categoryId");
  }
  const discovery = await discoverIboxDealIds(call, config.categoryId, retryOptions);
  const stageEntity = String(config.categoryId) === "0" ? "DEAL_STAGE" : `DEAL_STAGE_${config.categoryId}`;
  const [postSaleDiscovery, sourceCatalog, failureReasonOptions, stageRows, currentDeals] = await Promise.all([
    discoverIboxDealIds(call, config.postSaleCategoryId, retryOptions),
    loadSourceCatalog(call),
    loadFailureReasonOptions(call, config.failureReasonField),
    exhaustiveList(call, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: stageEntity } }, { retryTransient: true, retryOptions }),
    fetchCurrentDeals(call, discovery.dealIds, retryOptions),
  ]);
  const rules = buildStageRules(stageRows);
  const postSaleHistoryIds = new Set(postSaleDiscovery.dealIds);

  const leads = discovery.dealIds.map((dealId) => classifyDealEvidence({
    dealId,
    lookup: currentDeals.get(dealId),
    history: discovery.histories.get(dealId) ?? [],
    categoryId: config.categoryId,
    postSaleCategoryId: config.postSaleCategoryId,
    failureReasonField: config.failureReasonField,
    failureReasonOptions,
    sourceLabels: sourceCatalog.byId,
    bounds,
  }));
  const includedLeads = leads.filter((row) => row.classification === "INCLUDED");
  const sqlRows = includedLeads.map((lead) => ({
    ...classifySqlEvidence({
      dealId: lead.dealId,
      deal: currentDeals.get(lead.dealId).deal,
      history: discovery.histories.get(lead.dealId) ?? [],
      hasPostSaleHistory: postSaleHistoryIds.has(lead.dealId),
      categoryId: config.categoryId,
      postSaleCategoryId: config.postSaleCategoryId,
      rules,
      failureReasonField: config.failureReasonField,
      failureReasonOptions,
      routingPatterns,
    }),
    sourceId: lead.sourceId,
    sourceLabel: lead.sourceLabel,
  }));
  return { bounds, discovery, postSaleDiscovery, leads, includedLeads, sqlRows, currentDeals, rules, failureReasonOptions, sourceCatalog };
}

export async function extractIboxSqlEvidence({ call, config, now = () => new Date(), retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS }) {
  const snapshotStartedAt = now().toISOString();
  const { bounds, discovery, leads, includedLeads, sqlRows, rules } = await collectIboxLeadSqlRows({ call, config, retryOptions, routingPatterns });
  const leadUnresolved = leads.filter((row) => row.classification === "UNRESOLVED");
  const sqlUnresolved = sqlRows.filter((row) => row.classification === "UNRESOLVED");
  const unresolved = [
    ...leadUnresolved.map((row) => ({ dealId: row.dealId, stage: "LEAD_COHORT", reason: row.reason, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })),
    ...sqlUnresolved.map((row) => ({ dealId: row.dealId, stage: "SQL_EVIDENCE", reason: row.reason, unknownStageIds: row.unknownStageIds })),
  ];
  const summary = summarizeSql(sqlRows);
  const snapshotCompletedAt = now().toISOString();

  return {
    schemaVersion: 1,
    kind: "ibox-sql-evidence",
    result: unresolved.length ? "COMPLETE_WITH_UNRESOLVED" : "COMPLETE",
    snapshot: { startedAt: snapshotStartedAt, completedAt: snapshotCompletedAt },
    config: {
      categoryId: String(config.categoryId),
      postSaleCategoryId: String(config.postSaleCategoryId),
      failureReasonField: config.failureReasonField,
      dateBasis: "DATE_CREATE",
      timezone: TIMEZONE,
      fromDateInclusive: bounds.from,
      toDateInclusive: bounds.to,
      baseCohort: "canonical IBOX Lead (ibox-lead-evidence.mjs): entered category by stage history, currently in category or post-sale category",
      sqlStageIds: rules.sqlStageIds,
      sqlThresholdSort: rules.thresholdSort,
      routingPatterns: [...routingPatterns],
      transferReasonLabels: [...TRANSFER_OUT_REASONS],
      methods: ["crm.stagehistory.list", "crm.deal.get", "crm.deal.fields", "crm.status.list"],
    },
    lead: {
      discovered: discovery.dealIds.length,
      included: includedLeads.length,
      includedCrmForm: includedLeads.filter(isCrmForm).length,
      excluded: leads.filter((row) => row.classification === "EXCLUDED").length,
      unresolved: leadUnresolved.length,
    },
    sql: summary,
    unresolved: { count: unresolved.length, byReason: countUnresolvedByCode(unresolved), rows: unresolved },
    sqlRows: sqlRows.map((row) => ({
      dealId: row.dealId, classification: row.classification, reason: row.reason ?? null, basis: row.basis ?? null,
      salesStatus: row.salesStatus, lossReasonGroup: row.lossReasonGroup, sourceLabel: row.sourceLabel,
      currentCategoryId: row.currentCategoryId, evidenceStageId: row.evidenceStageId, qualifiedAt: row.qualifiedAt,
      ...(row.preSqlClosed ? { preSqlClosed: true } : {}),
      ...(row.routingReasonInIbox ? { routingReasonInIbox: true } : {}),
      ...(row.notRelevantButWon ? { notRelevantButWon: true } : {}),
    })),
  };
}

function idLine(label, value) {
  return `${label}: ${value.count}${value.count ? ` [${value.ids.join(", ")}]` : ""}`;
}

export function renderSqlSummary(report) {
  const { sql } = report;
  const cmp = sql.dashboardComparison;
  return [
    "IBOX SQL evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Date filter: DATE_CREATE ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `IBOX category ${report.config.categoryId}, post-sale category ${report.config.postSaleCategoryId}`,
    `SQL stage IDs: ${report.config.sqlStageIds.join(", ")} (threshold SORT ${report.config.sqlThresholdSort})`,
    "",
    `Canonical Leads: ${report.lead.included} (CRM-форма ${report.lead.includedCrmForm}); excluded ${report.lead.excluded}; unresolved ${report.lead.unresolved}`,
    "",
    `SQL, all sources: ${sql.all.count}`,
    `SQL, CRM-форма: ${sql.crmForm.count}`,
    "",
    "SQL BREAKDOWN",
    idLine("- real SQL/Обработка or downstream evidence", sql.breakdown.realSqlOrDownstreamEvidence),
    idLine("- WON/post-sale inferred SQL", sql.breakdown.wonOrPostSaleInferred),
    idLine("- direct Sales Lost, no SQL evidence (preSqlClosed)", sql.breakdown.preSqlClosedDirectSalesLoss),
    "",
    "SQL BY SOURCE",
    ...sql.bySource.map((item) => `- ${item.sourceId || "(none)"} — ${item.sourceLabel}: ${item.count}`),
    "",
    idLine("NOT RELEVANT excluded from SQL", sql.notRelevantExcluded),
    `- of which CRM-форма: ${sql.notRelevantExcluded.crmForm.count}; with prior SQL/downstream evidence: ${sql.notRelevantExcluded.withPriorSqlEvidence.count}`,
    "",
    `UNRESOLVED evidence: ${report.unresolved.count}`,
    ...report.unresolved.rows.map((row) => `- ${row.dealId}: ${row.stage} ${row.reason}`),
    "",
    "DASHBOARD COMPARISON",
    idLine("- routing-reason LOST still in IBOX (reference counts, dashboard cannot)", cmp.routingReasonLostInIbox),
    `  SQL without them: all ${cmp.routingReasonLostInIbox.sqlAllWithoutThem}, CRM-форма ${cmp.routingReasonLostInIbox.sqlCrmFormWithoutThem}`,
    idLine("- Not Relevant current stage but WON/post-sale evidence (counted SQL, as the dashboard does)", cmp.notRelevantCurrentStageButWon),
    "",
    "SQL DEAL IDS (all sources)",
    sql.all.ids.join(", ") || "none",
    "",
  ].join("\n");
}

export async function writeSqlAuditOutput(report, auditDir = DEFAULT_SQL_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderSqlSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write("Read-only IBOX SQL evidence audit\n\nUsage:\n  npm run audit:ibox-sql -- --category-id <IBOX_CATEGORY_ID> --post-sale-category-id <POST_SALE_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD\n");
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxSqlEvidence({ call, config });
  const files = await writeSqlAuditOutput(report);
  process.stdout.write(renderSqlSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX SQL evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
