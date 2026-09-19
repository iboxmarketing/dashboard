#!/usr/bin/env node

// Read-only IBOX Sales Lost / Sotilmadi live reference.
//
// Reuses the canonical Lead + SQL collection pass from ibox-sql-evidence.mjs.
// Sales Lost is therefore selected only from canonical IBOX Leads and cannot
// invent a second Lead, SQL, Not Relevant, routing, date, or deduplication rule.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceError,
  TIMEZONE,
  countUnresolvedByCode,
  createBitrixClient,
  parseCliArgs,
} from "./ibox-lead-evidence.mjs";
import {
  DASHBOARD_ROUTING_PATTERNS,
  SQL_BASIS,
  collectIboxLeadSqlRows,
  normalizeName,
} from "./ibox-sql-evidence.mjs";
import { failureReasonDiagnostic } from "./ibox-not-relevant-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SALES_LOST_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-sales-lost-evidence");

export const VERIFIED_INPUT_REFERENCE = Object.freeze({
  categoryId: "3",
  postSaleCategoryId: "13",
  from: "2026-09-01",
  to: "2026-09-19",
  leadAll: 470,
  leadCrmForm: 448,
  leadUnresolved: 0,
  sqlAll: 209,
  sqlCrmForm: 187,
  realSqlOrDownstreamEvidence: 163,
  preSqlClosed: 46,
  sqlUnresolved: 0,
});

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

function group(rows) {
  const ids = rows.map((row) => String(row.dealId)).sort(compareIds);
  return { count: ids.length, ids };
}

const isCrmForm = (row) => normalizeName(row.sourceLabel) === normalizeName("CRM-форма");

function groupedRows(rows, keyOf, metadataOf = () => ({})) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const item = groups.get(key) ?? { key, rows: [], ...metadataOf(row) };
    item.rows.push(row);
    groups.set(key, item);
  }
  return [...groups.values()]
    .map(({ rows: grouped, ...item }) => ({ ...item, ...group(grouped) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function sourceBreakdown(rows) {
  return groupedRows(
    rows,
    (row) => `${row.sourceId}\u0000${row.sourceLabel}`,
    (row) => ({ sourceId: row.sourceId, sourceLabel: row.sourceLabel }),
  ).map((item) => ({
    sourceId: item.sourceId,
    sourceLabel: item.sourceLabel,
    count: item.count,
    ids: item.ids,
  }))
    .sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel) || left.sourceId.localeCompare(right.sourceId));
}

function failureReasonBucket(item) {
  const labels = item.diagnostic.labels ?? [];
  const orphanIds = item.diagnostic.orphanIds ?? [];
  if (labels.length && orphanIds.length) return `${labels.join(", ")} + orphan enum ${orphanIds.join(", ")}`;
  if (labels.length) return labels.join(", ");
  if (orphanIds.length) return `Orphan enum ${orphanIds.join(", ")}`;
  if (item.diagnostic.state === "FIELD_NOT_IN_DICTIONARY") return "Failure-reason field not in dictionary";
  return "Missing / unselected";
}

function idDifference(left, right) {
  const rightIds = new Set(right.map((row) => row.dealId));
  return group(left.filter((row) => !rightIds.has(row.dealId)));
}

function verifiedInputComparison({ config, includedLeads, sqlRows, leadUnresolved, sqlUnresolved }) {
  const reference = VERIFIED_INPUT_REFERENCE;
  const applicable = String(config.categoryId) === reference.categoryId
    && String(config.postSaleCategoryId) === reference.postSaleCategoryId
    && config.from === reference.from
    && config.to === reference.to;
  if (!applicable) return { applicable: false, reference };

  const sql = sqlRows.filter((row) => row.classification === "SQL");
  const actual = {
    leadAll: includedLeads.length,
    leadCrmForm: includedLeads.filter(isCrmForm).length,
    leadUnresolved: leadUnresolved.length,
    sqlAll: sql.length,
    sqlCrmForm: sql.filter(isCrmForm).length,
    realSqlOrDownstreamEvidence: sql.filter((row) => row.basis === SQL_BASIS.STAGE_EVIDENCE).length,
    preSqlClosed: sql.filter((row) => row.preSqlClosed).length,
    sqlUnresolved: sqlUnresolved.length,
  };
  const checks = Object.fromEntries(Object.keys(actual).map((key) => [key, {
    expected: reference[key], actual: actual[key], matches: actual[key] === reference[key],
  }]));
  return { applicable: true, reference, actual, checks, allMatch: Object.values(checks).every((item) => item.matches) };
}

export function summarizeSalesLost({
  config, includedLeads, sqlRows, currentDeals, failureReasonOptions,
  leadUnresolved, routingPatterns = DASHBOARD_ROUTING_PATTERNS,
}) {
  const sql = sqlRows.filter((row) => row.classification === "SQL");
  const notRelevant = sqlRows.filter((row) => row.classification === "NOT_RELEVANT");
  const sqlUnresolved = sqlRows.filter((row) => row.classification === "UNRESOLVED");
  const salesLost = sql.filter((row) => row.salesStatus === "LOST" && row.lossReasonGroup === "SALES");
  const realEvidence = salesLost.filter((row) => row.hasSqlEvidence);
  const preSqlClosed = salesLost.filter((row) => row.preSqlClosed);

  const diagnostics = salesLost.map((row) => ({
    ...row,
    diagnostic: failureReasonDiagnostic(
      currentDeals.get(row.dealId).deal,
      config.failureReasonField,
      failureReasonOptions,
    ),
  }));
  const missingOrUnselected = diagnostics.filter((row) => ["NOT_SELECTED", "FIELD_ABSENT_ON_DEAL"].includes(row.diagnostic.state));
  const orphanRows = diagnostics.filter((row) => row.diagnostic.orphanIds?.length);
  const stateCounts = new Map();
  for (const row of diagnostics) stateCounts.set(row.diagnostic.state, (stateCounts.get(row.diagnostic.state) ?? 0) + 1);

  const unresolved = [
    ...leadUnresolved.map((row) => ({ dealId: row.dealId, stage: "LEAD_COHORT", reason: row.reason, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })),
    ...sqlUnresolved.map((row) => ({ dealId: row.dealId, stage: "SQL_EVIDENCE", reason: row.reason, unknownStageIds: row.unknownStageIds })),
    ...(!failureReasonOptions.fieldFound
      ? sqlRows.filter((row) => row.salesStatus === "LOST").map((row) => ({
        dealId: row.dealId, stage: "SALES_LOST_REASON", reason: "FAILURE_REASON_FIELD_NOT_IN_DICTIONARY",
      }))
      : []),
  ];

  const leadIds = new Set(includedLeads.map((row) => row.dealId));
  const sqlIds = new Set(sql.map((row) => row.dealId));
  const notRelevantIds = new Set(notRelevant.map((row) => row.dealId));
  const salesLostIds = salesLost.map((row) => row.dealId);
  const preSqlClosedIds = preSqlClosed.map((row) => row.dealId);

  // Current dashboard formula on the already-canonical rows. This is an exact
  // formula comparison, while the separate note records the known population
  // mismatch in this branch: dashboard eligibility is still reason-based.
  const dashboardFormulaRows = sqlRows.filter((row) => (
    row.classification === "SQL"
    && row.salesStatus === "LOST"
    && row.lossReasonGroup === "SALES"
  ));
  const onlyInReference = idDifference(salesLost, dashboardFormulaRows);
  const onlyInDashboardFormula = idDifference(dashboardFormulaRows, salesLost);

  return {
    salesLost: {
      all: group(salesLost),
      crmForm: group(salesLost.filter(isCrmForm)),
      bySource: sourceBreakdown(salesLost),
      breakdown: {
        realSqlOrDownstreamEvidence: group(realEvidence),
        preSqlClosedDirectSalesLoss: group(preSqlClosed),
      },
    },
    failureReasons: {
      breakdown: groupedRows(diagnostics, failureReasonBucket).map(({ key, ...item }) => ({ reason: key, ...item })),
      missingOrUnselected: group(missingOrUnselected),
      byDiagnosticState: Object.fromEntries([...stateCounts].sort(([left], [right]) => left.localeCompare(right))),
      orphanDeals: orphanRows.map((row) => ({
        dealId: row.dealId,
        orphanFailureReasonIds: row.diagnostic.orphanIds,
        resolvedLabels: row.diagnostic.labels ?? [],
      })),
      routingPatterns: [...routingPatterns],
    },
    invariants: {
      salesLostSubsetOfSql: { holds: salesLostIds.every((id) => sqlIds.has(id)) },
      salesLostIntersectNotRelevant: {
        ...group(salesLost.filter((row) => notRelevantIds.has(row.dealId))),
        holds: salesLostIds.every((id) => !notRelevantIds.has(id)),
      },
      salesLostSubsetOfCanonicalLeads: { holds: salesLostIds.every((id) => leadIds.has(id)) },
      preSqlClosedSubsetOfSalesLost: { holds: preSqlClosedIds.every((id) => salesLostIds.includes(id)) },
      oneDealIdOnce: {
        holds: new Set(salesLostIds).size === salesLostIds.length
          && new Set(sqlRows.map((row) => row.dealId)).size === sqlRows.length
          && new Set(includedLeads.map((row) => row.dealId)).size === includedLeads.length,
      },
      breakdownExhaustive: {
        holds: realEvidence.length + preSqlClosed.length === salesLost.length,
        total: salesLost.length,
        realEvidence: realEvidence.length,
        preSqlClosed: preSqlClosed.length,
      },
    },
    dashboardComparison: {
      formulaOnCanonicalRows: {
        reference: group(salesLost),
        dashboardModeled: group(dashboardFormulaRows),
        onlyInReference,
        onlyInDashboard: onlyInDashboardFormula,
        matches: onlyInReference.count === 0 && onlyInDashboardFormula.count === 0,
        note: "Dashboard isSalesLost formula matches: SALES + qualified; direct ordinary closures are qualified and remain preSqlClosed diagnostics.",
      },
      basePopulation: {
        matches: false,
        note: "Current branch dashboard eligibility is lossReasonGroup !== ROUTING, not canonical current IBOX Sales/post-sale membership. It can retain an ordinary Sales Lost Deal that has moved to another project; the live audit excludes it before this calculation. Quantification requires the live audit/dashboard data.",
      },
    },
    unresolved: { count: unresolved.length, byReason: countUnresolvedByCode(unresolved), rows: unresolved },
  };
}

export async function extractIboxSalesLostEvidence({
  call, config, now = () => new Date(), retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS,
}) {
  const snapshotStartedAt = now().toISOString();
  const collected = await collectIboxLeadSqlRows({ call, config, retryOptions, routingPatterns });
  const leadUnresolved = collected.leads.filter((row) => row.classification === "UNRESOLVED");
  const summary = summarizeSalesLost({ ...collected, config, leadUnresolved, routingPatterns });
  const sqlUnresolved = collected.sqlRows.filter((row) => row.classification === "UNRESOLVED");
  const inputReference = verifiedInputComparison({ ...collected, config, leadUnresolved, sqlUnresolved });
  const snapshotCompletedAt = now().toISOString();

  return {
    schemaVersion: 1,
    kind: "ibox-sales-lost-evidence",
    result: summary.unresolved.count ? "COMPLETE_WITH_UNRESOLVED" : "COMPLETE",
    snapshot: { startedAt: snapshotStartedAt, completedAt: snapshotCompletedAt },
    config: {
      categoryId: String(config.categoryId),
      postSaleCategoryId: String(config.postSaleCategoryId),
      failureReasonField: config.failureReasonField,
      dateBasis: "DATE_CREATE",
      timezone: TIMEZONE,
      fromDateInclusive: collected.bounds.from,
      toDateInclusive: collected.bounds.to,
      baseCohort: "canonical IBOX Lead from collectIboxLeadSqlRows",
      salesLostRule: "canonical Lead + ordinary IBOX LOST + SALES reason group; direct close is SQL and preSqlClosed",
      methods: ["crm.stagehistory.list", "crm.deal.get", "crm.deal.fields", "crm.status.list"],
    },
    lead: {
      discovered: collected.discovery.dealIds.length,
      included: collected.includedLeads.length,
      includedCrmForm: collected.includedLeads.filter(isCrmForm).length,
      excluded: collected.leads.filter((row) => row.classification === "EXCLUDED").length,
      unresolved: leadUnresolved.length,
    },
    sqlReference: {
      all: collected.sqlRows.filter((row) => row.classification === "SQL").length,
      crmForm: collected.sqlRows.filter((row) => row.classification === "SQL" && isCrmForm(row)).length,
      unresolved: sqlUnresolved.length,
    },
    verifiedInputReference: inputReference,
    ...summary,
  };
}

function idLine(label, value) {
  return `${label}: ${value.count}${value.count ? ` [${value.ids.join(", ")}]` : ""}`;
}

export function renderSalesLostSummary(report) {
  const lost = report.salesLost;
  const inv = report.invariants;
  const cmp = report.dashboardComparison;
  const baseline = report.verifiedInputReference;
  return [
    "IBOX Sales Lost / Sotilmadi evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Date filter: DATE_CREATE ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `IBOX category ${report.config.categoryId}, post-sale category ${report.config.postSaleCategoryId}`,
    "",
    `Canonical Leads: ${report.lead.included} (CRM-форма ${report.lead.includedCrmForm}); excluded ${report.lead.excluded}; unresolved ${report.lead.unresolved}`,
    `SQL reference: all ${report.sqlReference.all}, CRM-форма ${report.sqlReference.crmForm}; unresolved ${report.sqlReference.unresolved}`,
    ...(baseline.applicable ? [`Verified input reference: ${baseline.allMatch ? "MATCH" : "MISMATCH"}`] : ["Verified input reference: not applicable to this date/category selection"]),
    "",
    `Sales Lost, all sources: ${lost.all.count}`,
    `Sales Lost, CRM-форма: ${lost.crmForm.count}`,
    "",
    idLine("- real SQL/downstream evidence then Sales Lost", lost.breakdown.realSqlOrDownstreamEvidence),
    idLine("- direct Sales Lost without recorded SQL evidence (preSqlClosed)", lost.breakdown.preSqlClosedDirectSalesLoss),
    "",
    "SALES LOST BY SOURCE",
    ...lost.bySource.map((item) => `- ${item.sourceId || "(none)"} — ${item.sourceLabel}: ${item.count}`),
    "",
    "FAILURE REASONS",
    ...report.failureReasons.breakdown.map((item) => `- ${item.reason}: ${item.count}`),
    idLine("Missing / unselected failure reason", report.failureReasons.missingOrUnselected),
    ...report.failureReasons.orphanDeals.map((item) => `- orphan ${item.dealId}: ${item.orphanFailureReasonIds.join(", ")}`),
    "",
    "INVARIANTS",
    `- Sales Lost ⊆ SQL: ${inv.salesLostSubsetOfSql.holds ? "HOLDS" : "VIOLATED"}`,
    `- Sales Lost ∩ Not Relevant = empty: ${inv.salesLostIntersectNotRelevant.holds ? "HOLDS" : `VIOLATED [${inv.salesLostIntersectNotRelevant.ids.join(", ")}]`}`,
    `- Sales Lost ⊆ canonical Leads: ${inv.salesLostSubsetOfCanonicalLeads.holds ? "HOLDS" : "VIOLATED"}`,
    `- preSqlClosed ⊆ Sales Lost: ${inv.preSqlClosedSubsetOfSalesLost.holds ? "HOLDS" : "VIOLATED"}`,
    `- one Deal ID once: ${inv.oneDealIdOnce.holds ? "HOLDS" : "VIOLATED"}`,
    `- breakdown exhaustive: ${inv.breakdownExhaustive.holds ? "HOLDS" : "VIOLATED"}`,
    "",
    `UNRESOLVED evidence: ${report.unresolved.count}`,
    ...report.unresolved.rows.map((row) => `- ${row.dealId}: ${row.stage} ${row.reason}`),
    "",
    "DASHBOARD COMPARISON",
    `- Sales Lost formula on canonical rows: ${cmp.formulaOnCanonicalRows.matches ? "MATCH" : "MISMATCH"}`,
    `- Base population: ${cmp.basePopulation.matches ? "MATCH" : "MISMATCH"}`,
    `  ${cmp.basePopulation.note}`,
    "",
    "SALES LOST DEAL IDS (all sources)",
    lost.all.ids.join(", ") || "none",
    "",
  ].join("\n");
}

export async function writeSalesLostAuditOutput(report, auditDir = DEFAULT_SALES_LOST_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderSalesLostSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write("Read-only IBOX Sales Lost evidence audit\n\nUsage:\n  npm run audit:ibox-sales-lost -- --category-id <IBOX_CATEGORY_ID> --post-sale-category-id <POST_SALE_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD\n");
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxSalesLostEvidence({ call, config });
  const files = await writeSalesLostAuditOutput(report);
  process.stdout.write(renderSalesLostSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX Sales Lost evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
