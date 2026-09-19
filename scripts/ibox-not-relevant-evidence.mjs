#!/usr/bin/env node

// Read-only IBOX Not Relevant live reference.
//
// Reuses the canonical IBOX Lead cohort and the SQL semantics from
// ibox-sql-evidence.mjs so SQL and Not Relevant are computed from ONE pass over
// the same evidence and cannot drift apart. Not Relevant is stage-authoritative
// (Marketing low quality): the failure reason is reported as a diagnostic and is
// never used to classify. Read-only Bitrix methods only; no D1, no data-refresh
// jobs, no webhook in output.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceError,
  TIMEZONE,
  countUnresolvedByCode,
  createBitrixClient,
  parseCliArgs,
  resolveFailureReasons,
} from "./ibox-lead-evidence.mjs";
import {
  DASHBOARD_ROUTING_PATTERNS,
  collectIboxLeadSqlRows,
  isRoutingReason,
  normalizeName,
} from "./ibox-sql-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_NOT_RELEVANT_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-not-relevant-evidence");

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

function group(rows) {
  const ids = rows.map((row) => row.dealId).sort(compareIds);
  return { count: ids.length, ids };
}

const isCrmForm = (row) => normalizeName(row.sourceLabel) === normalizeName("CRM-форма");

function bySource(rows) {
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

/**
 * Diagnostic ONLY. Says what the failure-reason field holds; never feeds a
 * classification (Not Relevant is decided by the IBOX stage/outcome).
 */
export function failureReasonDiagnostic(deal, failureReasonField, options) {
  if (!options.fieldFound) return { state: "FIELD_NOT_IN_DICTIONARY" };
  const key = Object.keys(deal).find((candidate) => candidate.toUpperCase() === failureReasonField.toUpperCase());
  if (!key) return { state: "FIELD_ABSENT_ON_DEAL" };
  const resolved = resolveFailureReasons(deal[key], options);
  if (resolved.orphanIds.length && !options.byId.size) return { state: "DICTIONARY_EMPTY", orphanIds: resolved.orphanIds };
  if (!resolved.labels.length && !resolved.orphanIds.length) return { state: "NOT_SELECTED" };
  if (!resolved.labels.length) return { state: "ORPHAN_ENUM_ID", orphanIds: resolved.orphanIds };
  if (resolved.orphanIds.length) return { state: "RESOLVED_WITH_ORPHAN", labels: resolved.labels, orphanIds: resolved.orphanIds };
  return { state: "RESOLVED", labels: resolved.labels };
}

export function summarizeNotRelevant({ config, includedLeads, sqlRows, currentDeals, rules, failureReasonOptions, leadUnresolved, routingPatterns }) {
  const notRelevantRows = sqlRows.filter((row) => row.classification === "NOT_RELEVANT");
  const sqlRowsOnly = sqlRows.filter((row) => row.classification === "SQL");
  const sqlUnresolved = sqlRows.filter((row) => row.classification === "UNRESOLVED");
  const notSql = sqlRows.filter((row) => row.classification === "NOT_SQL");

  // A Lead still in IBOX Sales whose current stage the dictionary does not know
  // could be a Not Relevant stage; it is reported, not guessed, and its SQL
  // verdict is left exactly as the SQL audit computed it.
  const unknownCurrentStage = sqlRows.filter((row) => (
    row.classification !== "UNRESOLVED"
    && row.currentCategoryId === String(config.categoryId)
    && !rules.known(row.currentStageId)
  ));
  const unresolved = [
    ...leadUnresolved.map((row) => ({ dealId: row.dealId, stage: "LEAD_COHORT", reason: row.reason, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })),
    ...sqlUnresolved.map((row) => ({ dealId: row.dealId, stage: "SQL_EVIDENCE", reason: row.reason })),
    ...unknownCurrentStage.map((row) => ({ dealId: row.dealId, stage: "NOT_RELEVANT_CURRENT_STAGE", reason: "CURRENT_STAGE_NOT_IN_DICTIONARY" })),
  ];

  const diagnostics = notRelevantRows.map((row) => ({
    dealId: row.dealId,
    sourceLabel: row.sourceLabel,
    ...failureReasonDiagnostic(currentDeals.get(row.dealId).deal, config.failureReasonField, failureReasonOptions),
  }));
  const stateCounts = new Map();
  for (const item of diagnostics) stateCounts.set(item.state, (stateCounts.get(item.state) ?? 0) + 1);
  const routingStyle = diagnostics.filter((item) => item.labels?.some((label) => isRoutingReason(label, routingPatterns)));

  const sqlIds = new Set(sqlRowsOnly.map((row) => row.dealId));
  const nrIds = notRelevantRows.map((row) => row.dealId);
  const leadIds = new Set(includedLeads.map((row) => row.dealId));
  const intersection = nrIds.filter((id) => sqlIds.has(id)).sort(compareIds);
  const partitionSum = sqlRowsOnly.length + notRelevantRows.length + notSql.length + sqlUnresolved.length;

  return {
    notRelevant: {
      all: group(notRelevantRows),
      crmForm: group(notRelevantRows.filter(isCrmForm)),
      bySource: bySource(notRelevantRows),
      withPriorSqlDownstreamHistory: group(notRelevantRows.filter((row) => row.hasSqlEvidence)),
      withoutPriorSqlDownstreamHistory: group(notRelevantRows.filter((row) => !row.hasSqlEvidence)),
      crmFormWithPriorSqlDownstreamHistory: group(notRelevantRows.filter((row) => isCrmForm(row) && row.hasSqlEvidence)),
      crmFormWithoutPriorSqlDownstreamHistory: group(notRelevantRows.filter((row) => isCrmForm(row) && !row.hasSqlEvidence)),
    },
    sqlReference: { all: sqlRowsOnly.length, crmForm: sqlRowsOnly.filter(isCrmForm).length },
    failureReasonDiagnostics: {
      note: "Diagnostics only. The failure reason never classifies a Deal; the IBOX stage/outcome does.",
      byState: Object.fromEntries([...stateCounts].sort(([left], [right]) => left.localeCompare(right))),
      orphanDeals: diagnostics.filter((item) => item.orphanIds?.length).map((item) => ({ dealId: item.dealId, orphanFailureReasonIds: item.orphanIds })),
      routingStyleReasonStillNotRelevant: group(routingStyle),
    },
    invariants: {
      sqlIntersectNotRelevant: { count: intersection.length, ids: intersection, holds: intersection.length === 0 },
      notRelevantSubsetOfCanonicalLeads: { holds: nrIds.every((id) => leadIds.has(id)) },
      everyDealIdOnce: {
        holds: new Set(nrIds).size === nrIds.length
          && new Set(sqlRows.map((row) => row.dealId)).size === sqlRows.length
          && new Set(includedLeads.map((row) => row.dealId)).size === includedLeads.length,
      },
      leadPartition: {
        leads: includedLeads.length,
        sql: sqlRowsOnly.length,
        notRelevant: notRelevantRows.length,
        neitherSqlNorNotRelevant: notSql.length,
        sqlEvidenceUnresolved: sqlUnresolved.length,
        holds: partitionSum === includedLeads.length,
      },
    },
    dashboardComparison: {
      notRelevantCurrentStageButWon: {
        note: "Current stage is Not Relevant but payment/post-sale evidence exists. The dashboard (and the SQL audit) resolve these to WON, so they are SQL, not Not Relevant. Read literally, 'a Deal that currently resolves to Not Relevant is Not Relevant' would move them; that is a decision, not applied here.",
        ...group(sqlRowsOnly.filter((row) => row.notRelevantButWon)),
      },
    },
    unresolved: { count: unresolved.length, byReason: countUnresolvedByCode(unresolved), rows: unresolved },
    notRelevantRows: notRelevantRows.map((row) => ({
      dealId: row.dealId, sourceId: row.sourceId, sourceLabel: row.sourceLabel, currentStageId: row.currentStageId,
      hasPriorSqlDownstreamHistory: row.hasSqlEvidence, priorEvidenceStageId: row.evidenceStageId,
    })),
  };
}

export async function extractIboxNotRelevantEvidence({ call, config, now = () => new Date(), retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS }) {
  const snapshotStartedAt = now().toISOString();
  const collected = await collectIboxLeadSqlRows({ call, config, retryOptions, routingPatterns });
  const leadUnresolved = collected.leads.filter((row) => row.classification === "UNRESOLVED");
  const summary = summarizeNotRelevant({ ...collected, config, leadUnresolved, routingPatterns });
  const snapshotCompletedAt = now().toISOString();
  return {
    schemaVersion: 1,
    kind: "ibox-not-relevant-evidence",
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
      baseCohort: "canonical IBOX Lead (ibox-lead-evidence.mjs)",
      notRelevantRule: "current IBOX Sales stage is Not Relevant and no payment/post-sale evidence; stage-authoritative, failure reason ignored",
      methods: ["crm.stagehistory.list", "crm.deal.get", "crm.deal.fields", "crm.status.list"],
    },
    lead: {
      discovered: collected.discovery.dealIds.length,
      included: collected.includedLeads.length,
      includedCrmForm: collected.includedLeads.filter(isCrmForm).length,
      excluded: collected.leads.filter((row) => row.classification === "EXCLUDED").length,
      unresolved: leadUnresolved.length,
    },
    ...summary,
  };
}

function idLine(label, value) {
  return `${label}: ${value.count}${value.count ? ` [${value.ids.join(", ")}]` : ""}`;
}

export function renderNotRelevantSummary(report) {
  const nr = report.notRelevant;
  const inv = report.invariants;
  const diag = report.failureReasonDiagnostics;
  return [
    "IBOX Not Relevant evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Date filter: DATE_CREATE ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `IBOX category ${report.config.categoryId}, post-sale category ${report.config.postSaleCategoryId}`,
    "",
    `Canonical Leads: ${report.lead.included} (CRM-форма ${report.lead.includedCrmForm}); excluded ${report.lead.excluded}; unresolved ${report.lead.unresolved}`,
    `SQL reference: all ${report.sqlReference.all}, CRM-форма ${report.sqlReference.crmForm}`,
    "",
    `Not Relevant, all sources: ${nr.all.count}`,
    `Not Relevant, CRM-форма: ${nr.crmForm.count}`,
    "",
    idLine("- with prior SQL/downstream history", nr.withPriorSqlDownstreamHistory),
    idLine("- without prior SQL/downstream history", nr.withoutPriorSqlDownstreamHistory),
    `- CRM-форма: with prior ${nr.crmFormWithPriorSqlDownstreamHistory.count}, without prior ${nr.crmFormWithoutPriorSqlDownstreamHistory.count}`,
    "",
    "NOT RELEVANT BY SOURCE",
    ...nr.bySource.map((item) => `- ${item.sourceId || "(none)"} — ${item.sourceLabel}: ${item.count}`),
    "",
    "FAILURE-REASON DIAGNOSTICS (never used to classify)",
    ...Object.entries(diag.byState).map(([state, count]) => `- ${state}: ${count}`),
    ...diag.orphanDeals.map((item) => `- orphan ${item.dealId}: ${item.orphanFailureReasonIds.join(", ")}`),
    "",
    "INVARIANTS",
    `- SQL ∩ Not Relevant = empty: ${inv.sqlIntersectNotRelevant.holds ? "HOLDS" : `VIOLATED [${inv.sqlIntersectNotRelevant.ids.join(", ")}]`}`,
    `- Not Relevant ⊆ canonical Leads: ${inv.notRelevantSubsetOfCanonicalLeads.holds ? "HOLDS" : "VIOLATED"}`,
    `- one Deal ID once: ${inv.everyDealIdOnce.holds ? "HOLDS" : "VIOLATED"}`,
    `- Leads = SQL + Not Relevant + neither + unresolved: ${inv.leadPartition.leads} = ${inv.leadPartition.sql} + ${inv.leadPartition.notRelevant} + ${inv.leadPartition.neitherSqlNorNotRelevant} + ${inv.leadPartition.sqlEvidenceUnresolved} (${inv.leadPartition.holds ? "HOLDS" : "VIOLATED"})`,
    "",
    `UNRESOLVED evidence: ${report.unresolved.count}`,
    ...report.unresolved.rows.map((row) => `- ${row.dealId}: ${row.stage} ${row.reason}`),
    "",
    "DASHBOARD COMPARISON",
    idLine("- Not Relevant current stage but WON/post-sale (SQL in dashboard and SQL audit)", report.dashboardComparison.notRelevantCurrentStageButWon),
    "",
    "NOT RELEVANT DEAL IDS (all sources)",
    nr.all.ids.join(", ") || "none",
    "",
  ].join("\n");
}

export async function writeNotRelevantAuditOutput(report, auditDir = DEFAULT_NOT_RELEVANT_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderNotRelevantSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write("Read-only IBOX Not Relevant evidence audit\n\nUsage:\n  npm run audit:ibox-not-relevant -- --category-id <IBOX_CATEGORY_ID> --post-sale-category-id <POST_SALE_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD\n");
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxNotRelevantEvidence({ call, config });
  const files = await writeNotRelevantAuditOutput(report);
  process.stdout.write(renderNotRelevantSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX Not Relevant evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
