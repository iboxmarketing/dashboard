#!/usr/bin/env node

// Read-only IBOX Sotuv / WON live reference.
//
// Same canonical IBOX Lead cohort and stage rules as the SQL and Not Relevant
// audits (one shared collection pass). A Deal is WON when it reached the IBOX
// payment stage OR moved into the IBOX post-sale category; both signals count it
// once. Reports the cohort Sales (DATE_CREATE) and, separately, period Sales by a
// trustworthy wonAt. Read-only Bitrix methods only; no D1, no data-refresh jobs,
// no webhook in output.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceError,
  TIMEZONE,
  classifyDealEvidence,
  countUnresolvedByCode,
  createBitrixClient,
  parseCliArgs,
} from "./ibox-lead-evidence.mjs";
import {
  DASHBOARD_ROUTING_PATTERNS,
  collectIboxLeadSqlRows,
  normalizeName,
} from "./ibox-sql-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SALES_AUDIT_DIR = path.resolve(scriptDir, "../.audit/ibox-sales-evidence");

export const WON_AT_SOURCE = Object.freeze({
  PAYMENT_HISTORY: "PAYMENT_STAGE_HISTORY",
  POST_SALE_HISTORY: "POST_SALE_HISTORY",
  CURRENT_PAYMENT_MOVED_TIME: "CURRENT_PAYMENT_STAGE_MOVED_TIME",
});

function scalar(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

/** A real timestamp or null. Never falls back to DATE_MODIFY or any other field. */
function isoOrNull(value) {
  const text = scalar(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
 * WON evidence for ONE Deal, mirroring buildAnalyticsRecords:
 *   won  = payment-stage entry (history or current stage) OR post-sale (currently
 *          in the post-sale category, or any post-sale history row)
 *   wonAt priority = payment history > post-sale transition > MOVED_TIME while the
 *          current stage is the payment stage > null (never DATE_MODIFY)
 * `history` are the Deal's IBOX rows, `postSaleHistory` its post-sale rows, both
 * ordered by time.
 */
export function classifyWonEvidence({ deal, history, postSaleHistory, categoryId, postSaleCategoryId, rules }) {
  const postSaleRows = postSaleHistory ?? [];
  const currentCategoryId = scalar(deal.CATEGORY_ID);
  const currentStageId = scalar(deal.STAGE_ID);
  const inMain = currentCategoryId === String(categoryId);
  const inPostSale = currentCategoryId === String(postSaleCategoryId);

  const paymentRow = history.find((row) => rules.isPayment(scalar(row.STAGE_ID))) ?? null;
  const currentStagePayment = inMain && rules.isPayment(currentStageId);
  const paymentEvidence = Boolean(paymentRow) || currentStagePayment;
  const postSaleRow = postSaleRows[0] ?? null;
  const postSaleEvidence = inPostSale || postSaleRows.length > 0;
  const won = paymentEvidence || postSaleEvidence;

  const paymentAt = paymentRow ? isoOrNull(paymentRow.CREATED_TIME) : currentStagePayment ? isoOrNull(deal.MOVED_TIME) : null;
  const postSaleAt = postSaleRow ? isoOrNull(postSaleRow.CREATED_TIME) : null;

  let wonAt = null;
  let wonAtSource = null;
  if (paymentRow && isoOrNull(paymentRow.CREATED_TIME)) { wonAt = isoOrNull(paymentRow.CREATED_TIME); wonAtSource = WON_AT_SOURCE.PAYMENT_HISTORY; }
  else if (!paymentRow && postSaleRow && isoOrNull(postSaleRow.CREATED_TIME)) { wonAt = isoOrNull(postSaleRow.CREATED_TIME); wonAtSource = WON_AT_SOURCE.POST_SALE_HISTORY; }
  else if (!paymentRow && !postSaleRow && currentStagePayment && isoOrNull(deal.MOVED_TIME)) { wonAt = isoOrNull(deal.MOVED_TIME); wonAtSource = WON_AT_SOURCE.CURRENT_PAYMENT_MOVED_TIME; }

  const trail = [...history.map((row) => scalar(row.STAGE_ID)), ...(inMain && currentStageId ? [currentStageId] : [])];
  const unknownStageIds = [...new Set(trail.filter((id) => id && !rules.known(id)))];

  const currentNotRelevant = inMain && rules.isNotRelevant(currentStageId);
  const nrRow = [...history].reverse().find((row) => rules.isNotRelevant(scalar(row.STAGE_ID))) ?? null;
  const nrEnteredAt = nrRow ? isoOrNull(nrRow.CREATED_TIME) : null;
  const evidenceTimes = [paymentAt, postSaleAt].filter(Boolean).map((value) => Date.parse(value));
  const earliestEvidenceMs = evidenceTimes.length ? Math.min(...evidenceTimes) : null;
  const evidenceEarlierThanNotRelevant = Boolean(currentNotRelevant && earliestEvidenceMs !== null && nrEnteredAt && earliestEvidenceMs < Date.parse(nrEnteredAt));

  return {
    won,
    paymentEvidence,
    postSaleEvidence,
    bothEvidence: paymentEvidence && postSaleEvidence,
    currentCategoryId,
    currentStageId,
    paymentAt,
    postSaleAt,
    wonAt,
    wonAtSource,
    unknownStageIds,
    currentNotRelevant,
    nrEnteredAt,
    evidenceEarlierThanNotRelevant,
    // Payment recorded after the post-sale move: the dashboard still dates the
    // sale by the payment row, so the two timestamps are worth seeing.
    paymentAfterPostSale: Boolean(paymentAt && postSaleAt && Date.parse(paymentAt) > Date.parse(postSaleAt)),
    // Not Relevant is never a sale unless earlier definitive payment/post-sale
    // evidence exists; the dashboard counts every WON regardless.
    counted: won && (!currentNotRelevant || evidenceEarlierThanNotRelevant),
  };
}

const UNBOUNDED = Object.freeze({ fromMs: Number.NEGATIVE_INFINITY, toExclusiveMs: Number.POSITIVE_INFINITY });

export function summarizeSales({ config, bounds, collected }) {
  const { discovery, postSaleDiscovery, currentDeals, rules, failureReasonOptions, sourceCatalog, includedLeads, sqlRows, leads } = collected;
  const leadUnresolved = leads.filter((row) => row.classification === "UNRESOLVED");
  const cohortIds = new Set(includedLeads.map((row) => row.dealId));

  // Project membership WITHOUT the DATE_CREATE window: entered IBOX Sales and
  // currently in IBOX Sales or post-sale. Period sales are keyed on wonAt, so the
  // creation date must not limit them.
  const members = [];
  const memberUnresolved = [];
  const outsideProject = [];
  for (const dealId of discovery.dealIds) {
    const member = classifyDealEvidence({
      dealId,
      lookup: currentDeals.get(dealId),
      history: discovery.histories.get(dealId) ?? [],
      categoryId: config.categoryId,
      postSaleCategoryId: config.postSaleCategoryId,
      failureReasonField: config.failureReasonField,
      failureReasonOptions,
      sourceLabels: sourceCatalog.byId,
      bounds: UNBOUNDED,
    });
    const lookup = currentDeals.get(dealId);
    if (member.classification === "UNRESOLVED") { memberUnresolved.push(member); continue; }
    const evidence = lookup?.kind === "FOUND"
      ? classifyWonEvidence({
        deal: lookup.deal,
        history: discovery.histories.get(dealId) ?? [],
        postSaleHistory: postSaleDiscovery.histories.get(dealId) ?? [],
        categoryId: config.categoryId,
        postSaleCategoryId: config.postSaleCategoryId,
        rules,
      })
      : null;
    if (member.classification === "EXCLUDED") {
      if (member.reason === "MOVED_TO_OTHER_FUNNEL_NO_RETURN" && evidence?.paymentAt) outsideProject.push({ dealId, currentCategoryId: member.currentCategoryId, paymentAt: evidence.paymentAt });
      continue;
    }
    members.push({ dealId, sourceId: member.sourceId, sourceLabel: member.sourceLabel, createdAt: member.createdAt, ...evidence });
  }

  const cohort = members.filter((row) => cohortIds.has(row.dealId));
  const cohortWon = cohort.filter((row) => row.won);
  const cohortSales = cohortWon.filter((row) => row.counted);
  const conflicts = members.filter((row) => row.won && row.currentNotRelevant);
  const cohortConflicts = conflicts.filter((row) => cohortIds.has(row.dealId));

  const wonAtTrusted = cohortSales.filter((row) => row.wonAt);
  const wonAtMissing = cohortSales.filter((row) => !row.wonAt);

  const fromMs = bounds.fromMs;
  const toExclusiveMs = bounds.toExclusiveMs;
  const inPeriod = (row) => row.wonAt && Date.parse(row.wonAt) >= fromMs && Date.parse(row.wonAt) < toExclusiveMs;
  const periodSales = members.filter((row) => row.counted && inPeriod(row));
  const createdMs = (row) => Date.parse(row.createdAt);
  const periodOutsideProject = outsideProject.filter((row) => Date.parse(row.paymentAt) >= fromMs && Date.parse(row.paymentAt) < toExclusiveMs);
  const periodUnresolved = memberUnresolved.filter((row) => !cohortIds.has(row.dealId));

  // A Deal with an unknown stage ID and no won evidence could still be a sale.
  const unknownStage = cohort.filter((row) => !row.won && row.unknownStageIds.length);
  const unresolved = [
    ...leadUnresolved.map((row) => ({ dealId: row.dealId, stage: "LEAD_COHORT", reason: row.reason, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })),
    ...unknownStage.map((row) => ({ dealId: row.dealId, stage: "SALES_EVIDENCE", reason: "UNKNOWN_STAGE_ID_IN_TRAIL" })),
  ];

  const sqlIds = new Set(sqlRows.filter((row) => row.classification === "SQL").map((row) => row.dealId));
  const notRelevantIds = new Set(sqlRows.filter((row) => row.classification === "NOT_RELEVANT").map((row) => row.dealId));
  const salesIds = cohortSales.map((row) => row.dealId);
  const notInSql = salesIds.filter((id) => !sqlIds.has(id)).sort(compareIds);
  const notInLeads = salesIds.filter((id) => !cohortIds.has(id)).sort(compareIds);
  const listedConflictIds = new Set(cohortConflicts.map((row) => row.dealId));
  const currentNrSales = cohortSales.filter((row) => row.currentNotRelevant && !listedConflictIds.has(row.dealId)).map((row) => row.dealId);
  const inNotRelevantAudit = salesIds.filter((id) => notRelevantIds.has(id)).sort(compareIds);
  const wonByDeal = new Map(cohort.map((row) => [row.dealId, Boolean(row.won)]));
  const salesStatusDisagreements = sqlRows
    .filter((row) => row.classification !== "UNRESOLVED" && (row.salesStatus === "WON") !== wonByDeal.get(row.dealId))
    .map((row) => row.dealId).sort(compareIds);

  const sql = sqlIds.size;
  const notRelevant = notRelevantIds.size;
  const saralangan = sql + notRelevant;

  return {
    reconciliation: {
      leads: includedLeads.length,
      sql,
      notRelevant,
      saralangan,
      saralanmagan: includedLeads.length - saralangan,
      note: "Leads, SQL and Not Relevant come from the same pass as the SQL and Not Relevant audits; compare with the verified 470 / 209 / 230 / 439 / 31.",
    },
    cohortSales: {
      all: group(cohortSales),
      crmForm: group(cohortSales.filter(isCrmForm)),
      bySource: bySource(cohortSales),
      evidence: {
        paymentStage: group(cohortSales.filter((row) => row.paymentEvidence)),
        postSale: group(cohortSales.filter((row) => row.postSaleEvidence)),
        both: group(cohortSales.filter((row) => row.bothEvidence)),
        paymentOnly: group(cohortSales.filter((row) => row.paymentEvidence && !row.postSaleEvidence)),
        postSaleOnly: group(cohortSales.filter((row) => row.postSaleEvidence && !row.paymentEvidence)),
      },
      wonAt: {
        trustworthy: group(wonAtTrusted),
        missing: group(wonAtMissing),
        bySource: Object.fromEntries(Object.values(WON_AT_SOURCE).map((source) => [source, wonAtTrusted.filter((row) => row.wonAtSource === source).length])),
        paymentRecordedAfterPostSale: group(cohortSales.filter((row) => row.paymentAfterPostSale)),
      },
    },
    periodSales: {
      note: "Keyed on wonAt inside the selected range, regardless of DATE_CREATE. Includes Deals that entered IBOX Sales and are currently in IBOX Sales or post-sale. Different population from cohort Sales.",
      all: group(periodSales),
      crmForm: group(periodSales.filter(isCrmForm)),
      bySource: bySource(periodSales),
      createdInRange: group(periodSales.filter((row) => cohortIds.has(row.dealId))),
      createdBeforeRange: group(periodSales.filter((row) => createdMs(row) < fromMs)),
      createdAfterRange: group(periodSales.filter((row) => createdMs(row) >= toExclusiveMs)),
      unresolvedCandidates: { count: periodUnresolved.length, ids: periodUnresolved.map((row) => row.dealId).sort(compareIds) },
    },
    conflicts: {
      note: "Current stage is Not Relevant but payment/post-sale evidence exists. Counted as a sale only when that evidence is provably earlier than the Not Relevant entry; otherwise listed and not counted.",
      notRelevantWithWonEvidence: cohortConflicts.map((row) => ({
        dealId: row.dealId, sourceLabel: row.sourceLabel, paymentAt: row.paymentAt, postSaleAt: row.postSaleAt, notRelevantEnteredAt: row.nrEnteredAt,
        evidenceEarlierThanNotRelevant: row.evidenceEarlierThanNotRelevant, countedAsSale: row.counted,
      })).sort((left, right) => compareIds(left.dealId, right.dealId)),
      countedAsSale: group(cohortConflicts.filter((row) => row.counted)),
      notCounted: group(cohortConflicts.filter((row) => !row.counted)),
    },
    invariants: {
      cohortSalesSubsetOfSql: { holds: notInSql.length === 0, violations: notInSql },
      cohortSalesSubsetOfCanonicalLeads: { holds: notInLeads.length === 0, violations: notInLeads },
      cohortSalesIntersectNotRelevant: {
        holds: currentNrSales.length === 0 && inNotRelevantAudit.length === 0,
        unlistedViolations: [...new Set([...currentNrSales, ...inNotRelevantAudit])].sort(compareIds),
        listedConflicts: cohortConflicts.filter((row) => row.counted).map((row) => row.dealId).sort(compareIds),
      },
      everyDealIdOnce: { holds: new Set(salesIds).size === salesIds.length && new Set(members.map((row) => row.dealId)).size === members.length },
      salesStatusAgreesWithSqlAudit: { holds: salesStatusDisagreements.length === 0, disagreements: salesStatusDisagreements },
    },
    dashboardComparison: {
      dashboardCohortSales: {
        note: "The dashboard counts every salesStatus === WON, so a Not Relevant current stage with payment/post-sale evidence is a sale there even when the evidence is not provably earlier.",
        ...group(cohortWon),
        differenceFromReference: cohortWon.length - cohortSales.length,
      },
      outsideProjectButPaidInPeriod: {
        note: "Entered IBOX, now in another project's funnel (not canonical Leads), with an IBOX payment-stage entry inside the period. A stored dashboard record for such a Deal could still count it as a sale; the canonical reference does not.",
        count: periodOutsideProject.length,
        ids: periodOutsideProject.map((row) => row.dealId).sort(compareIds),
      },
      wonAtSnapshot: "The dashboard freezes wonAt in a D1 snapshot at first sync (snapshot wonAt wins over live history). The live reference reads current history, so a later history correction moves it but not the snapshot. D1 is not read here.",
      periodScope: `Dashboard period sales come from stored records; the live reference is not limited to a sync window. ${periodSales.filter((row) => createdMs(row) < fromMs).length} period sale(s) were created before the range start and are absent from any dashboard import that only covers the range.`,
    },
    unresolved: { count: unresolved.length, byReason: countUnresolvedByCode(unresolved), rows: unresolved },
    salesRows: cohortWon.map((row) => ({
      dealId: row.dealId, counted: row.counted, sourceId: row.sourceId, sourceLabel: row.sourceLabel, currentCategoryId: row.currentCategoryId,
      paymentEvidence: row.paymentEvidence, postSaleEvidence: row.postSaleEvidence, wonAt: row.wonAt, wonAtSource: row.wonAtSource,
      ...(row.currentNotRelevant ? { currentNotRelevant: true, evidenceEarlierThanNotRelevant: row.evidenceEarlierThanNotRelevant } : {}),
    })),
  };
}

export async function extractIboxSalesEvidence({ call, config, now = () => new Date(), retryOptions = {}, routingPatterns = DASHBOARD_ROUTING_PATTERNS }) {
  const snapshotStartedAt = now().toISOString();
  const collected = await collectIboxLeadSqlRows({ call, config, retryOptions, routingPatterns });
  const summary = summarizeSales({ config, bounds: collected.bounds, collected });
  const snapshotCompletedAt = now().toISOString();
  const leadUnresolved = collected.leads.filter((row) => row.classification === "UNRESOLVED");
  return {
    schemaVersion: 1,
    kind: "ibox-sales-evidence",
    result: summary.unresolved.count ? "COMPLETE_WITH_UNRESOLVED" : "COMPLETE",
    snapshot: { startedAt: snapshotStartedAt, completedAt: snapshotCompletedAt },
    config: {
      categoryId: String(config.categoryId),
      postSaleCategoryId: String(config.postSaleCategoryId),
      failureReasonField: config.failureReasonField,
      dateBasis: "DATE_CREATE (cohort Sales); wonAt (period Sales)",
      timezone: TIMEZONE,
      fromDateInclusive: collected.bounds.from,
      toDateInclusive: collected.bounds.to,
      baseCohort: "canonical IBOX Lead (ibox-lead-evidence.mjs)",
      wonRule: "payment-stage entry OR post-sale category; a Deal counts once",
      wonAtPolicy: "payment-stage history > post-sale history > MOVED_TIME only while the current stage is the payment stage > missing; DATE_MODIFY is never used",
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

const holds = (item) => (item.holds ? "HOLDS" : "VIOLATED");

export function renderSalesSummary(report) {
  const cohort = report.cohortSales;
  const period = report.periodSales;
  const inv = report.invariants;
  const rec = report.reconciliation;
  return [
    "IBOX Sotuv / WON evidence summary",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `Date filter: DATE_CREATE ${report.config.fromDateInclusive} — ${report.config.toDateInclusive} inclusive (${report.config.timezone})`,
    `IBOX category ${report.config.categoryId}, post-sale category ${report.config.postSaleCategoryId}`,
    "",
    `Reconciliation: Leads ${rec.leads}, SQL ${rec.sql}, Not Relevant ${rec.notRelevant}, Saralangan ${rec.saralangan}, Saralanmagan ${rec.saralanmagan}`,
    "",
    `Cohort Sales (Kelgan leadlardan sotuv), all sources: ${cohort.all.count}`,
    `Cohort Sales, CRM-форма: ${cohort.crmForm.count}`,
    "",
    "EVIDENCE",
    `- payment-stage evidence: ${cohort.evidence.paymentStage.count}`,
    `- post-sale evidence: ${cohort.evidence.postSale.count}`,
    `- both: ${cohort.evidence.both.count} (payment only ${cohort.evidence.paymentOnly.count}, post-sale only ${cohort.evidence.postSaleOnly.count})`,
    "",
    "wonAt",
    `- trustworthy: ${cohort.wonAt.trustworthy.count}; missing: ${cohort.wonAt.missing.count}${cohort.wonAt.missing.count ? ` [${cohort.wonAt.missing.ids.join(", ")}]` : ""}`,
    ...Object.entries(cohort.wonAt.bySource).map(([source, count]) => `  - ${source}: ${count}`),
    "",
    `Period Sales by wonAt (Shu davrdagi sotuvlar), all sources: ${period.all.count}; CRM-форма: ${period.crmForm.count}`,
    `- created in range ${period.createdInRange.count}, before range ${period.createdBeforeRange.count}, after range ${period.createdAfterRange.count}`,
    "",
    "COHORT SALES BY SOURCE",
    ...cohort.bySource.map((item) => `- ${item.sourceId || "(none)"} — ${item.sourceLabel}: ${item.count}`),
    "",
    "NOT RELEVANT / WON CONFLICTS",
    ...(report.conflicts.notRelevantWithWonEvidence.length
      ? report.conflicts.notRelevantWithWonEvidence.map((row) => `- ${row.dealId}: payment ${row.paymentAt ?? "-"}, post-sale ${row.postSaleAt ?? "-"}, Not Relevant ${row.notRelevantEnteredAt ?? "-"}, earlier evidence ${row.evidenceEarlierThanNotRelevant ? "yes" : "no"} → ${row.countedAsSale ? "counted" : "not counted"}`)
      : ["- none"]),
    "",
    "INVARIANTS",
    `- cohort Sales ⊆ SQL: ${holds(inv.cohortSalesSubsetOfSql)}`,
    `- cohort Sales ⊆ canonical Leads: ${holds(inv.cohortSalesSubsetOfCanonicalLeads)}`,
    `- cohort Sales ∩ Not Relevant = empty (listed conflicts aside): ${holds(inv.cohortSalesIntersectNotRelevant)}`,
    `- one Deal ID once: ${holds(inv.everyDealIdOnce)}`,
    `- WON status agrees with the SQL audit: ${holds(inv.salesStatusAgreesWithSqlAudit)}`,
    "",
    `UNRESOLVED evidence: ${report.unresolved.count}`,
    ...report.unresolved.rows.map((row) => `- ${row.dealId}: ${row.stage} ${row.reason}`),
    "",
    "DASHBOARD COMPARISON",
    `- dashboard cohort Sales (every WON): ${report.dashboardComparison.dashboardCohortSales.count} (difference from reference ${report.dashboardComparison.dashboardCohortSales.differenceFromReference})`,
    idLine("- outside IBOX now but paid in period (not canonical)", report.dashboardComparison.outsideProjectButPaidInPeriod),
    `- ${report.dashboardComparison.periodScope}`,
    `- ${report.dashboardComparison.wonAtSnapshot}`,
    "",
    "COHORT SALES DEAL IDS (all sources)",
    cohort.all.ids.join(", ") || "none",
    "",
    "PERIOD SALES DEAL IDS (all sources)",
    period.all.ids.join(", ") || "none",
    "",
  ].join("\n");
}

export async function writeSalesAuditOutput(report, auditDir = DEFAULT_SALES_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const basename = `${stamp}_category-${report.config.categoryId}_${report.config.fromDateInclusive}_${report.config.toDateInclusive}`;
  const jsonPath = path.join(auditDir, `${basename}.json`);
  const summaryPath = path.join(auditDir, `${basename}.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderSalesSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export async function runCli(argv, environment = process.env) {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write("Read-only IBOX Sotuv / WON evidence audit\n\nUsage:\n  npm run audit:ibox-sales -- --category-id <IBOX_CATEGORY_ID> --post-sale-category-id <POST_SALE_CATEGORY_ID> --failure-reason-field <UF_CRM_FIELD> --from YYYY-MM-DD --to YYYY-MM-DD\n");
    return null;
  }
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await extractIboxSalesEvidence({ call, config });
  const files = await writeSalesAuditOutput(report);
  process.stdout.write(renderSalesSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`IBOX Sotuv evidence extraction failed (${code}).\n`);
    process.exitCode = 1;
  });
}
