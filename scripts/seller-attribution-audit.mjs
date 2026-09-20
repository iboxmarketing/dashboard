#!/usr/bin/env node

// Read-only seller-attribution audit.
//
// Answers one question: do the frozen rows in `deal_sales_snapshots` name the
// commercial seller, or an onboarding/support employee who only touched the card
// after it moved to IBOX Обучение/Сопровождение?
//
// It never opens D1. The operator exports the two tables with a read-only SELECT
// (see docs/OPERATIONS.md) and passes the JSON in; Bitrix is read through the
// same allowlisted read methods as the other audits. Nothing is written back,
// no sync or backfill is started, and no secret is printed.
//
// Approved seller priority, which is what "verified" is measured against:
//   1. trustworthy existing snapshot
//   2. configured stable Sales Manager custom field
//   3. MOVED_BY_ID only while the CURRENT stage is the payment stage
//   4. Unknown
// Post-sale MOVED_BY_ID / ASSIGNED_BY_ID are never seller evidence.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvidenceError,
  TIMEZONE,
  callWithTransientRetry,
  createBitrixClient,
  discoverIboxDealIds,
  fetchCurrentDeals,
  tashkentDateBounds,
} from "./ibox-lead-evidence.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AUDIT_DIR = path.resolve(scriptDir, "../.audit/seller-attribution");

export const CLASSIFICATIONS = Object.freeze({
  VERIFIED: "VERIFIED_SELLER",
  REPAIRABLE: "REPAIRABLE_FROM_CUSTOM_FIELD",
  SUSPICIOUS: "SUSPICIOUS_NO_PROOF",
  UNKNOWN: "UNKNOWN_INSUFFICIENT_EVIDENCE",
});

/** Attribution sources the current code can write. Anything else is legacy. */
export const KNOWN_ATTRIBUTION_SOURCES = Object.freeze(["CUSTOM_FIELD", "STAGE_MOVER", "CURRENT_RESPONSIBLE", "UNKNOWN"]);

const NO_CURRENCY = "(no CURRENCY_ID)";

function scalar(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length || a.localeCompare(b);
  return a.localeCompare(b);
}

function msOrNull(value) {
  const text = scalar(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Same employee parse as `employeeId` in lib/analytics.ts: arrays and `user_123`. */
export function employeeIdFrom(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return scalar(value).match(/(?:user_)?(\d+)/i)?.[1] ?? "";
}

/** Same canonical spelling as `canonicalDealFieldKey` in lib/crm-fields.ts. */
export function canonicalFieldKey(key) {
  const match = /^uf_?crm_?(.+)$/i.exec(scalar(key));
  return match ? `UF_CRM_${match[1]}` : scalar(key);
}

/**
 * Flattens whatever `wrangler d1 execute --json` produced: a list of result
 * sets, a `{result:[...]}` envelope, or a bare array of rows.
 */
export function parseD1Rows(payload) {
  const unwrapped = payload && typeof payload === "object" && !Array.isArray(payload) && "result" in payload ? payload.result : payload;
  const sets = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
  return sets.flatMap((set) => {
    if (Array.isArray(set)) return set;
    if (set && typeof set === "object" && Array.isArray(set.results)) return set.results;
    if (set && typeof set === "object") return [set];
    return [];
  }).filter((row) => row && typeof row === "object");
}

export function readSnapshotRows(payload) {
  const rows = parseD1Rows(payload).filter((row) => "deal_id" in row || "dealId" in row);
  return rows.map((row) => ({
    dealId: scalar(row.deal_id ?? row.dealId),
    wonAt: scalar(row.won_at ?? row.wonAt) || null,
    managerId: scalar(row.manager_id ?? row.managerId) || null,
    managerName: scalar(row.manager_name ?? row.managerName) || null,
    attributionSource: scalar(row.attribution_source ?? row.attributionSource) || "",
    frozenAt: scalar(row.created_at ?? row.createdAt) || null,
  })).filter((row) => row.dealId);
}

/**
 * Pulls the settings this audit needs out of an `app_settings` export. The
 * dashboard stores one JSON blob per key, so the value is parsed, not columns.
 */
export function readSettings(payload) {
  const rows = parseD1Rows(payload);
  let settings = {};
  for (const row of rows) {
    const value = row.value ?? row.settings ?? null;
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = { ...settings, ...parsed };
    } catch { /* a non-JSON settings row is not this audit's concern */ }
  }
  const list = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  return {
    salesManagerField: scalar(settings.salesManagerField) || null,
    paymentStageIds: list(settings.paymentStageIds),
    selectedPipelineIds: list(settings.selectedPipelineIds),
    postSalePipelineIds: list(settings.postSalePipelineIds),
  };
}

/**
 * TASK A: is the configured field usable at all?
 *
 * `lib/analytics.ts` reads `deal[settings.salesManagerField]` verbatim, while
 * the deal `select` list is built through `canonicalDealFieldKey`. A stored
 * camelCase spelling therefore resolves to `undefined` on every deal and the
 * CUSTOM_FIELD step silently never fires — the same failure that once left
 * 0 of 1,549 deals with a failure reason (see lib/crm-fields.ts).
 */
export function inspectSalesManagerField({ configuredKey, dealFields, deals }) {
  if (!configuredKey) {
    return { configured: false, usable: false, findings: ["NOT_CONFIGURED: no salesManagerField is set, so the stable-field step can never fire and nothing is automatically repairable"] };
  }
  const canonical = canonicalFieldKey(configuredKey);
  const fields = dealFields && typeof dealFields === "object" ? dealFields : {};
  const actualKey = Object.keys(fields).find((key) => key.toUpperCase() === canonical.toUpperCase());
  const meta = actualKey ? fields[actualKey] : null;
  const findings = [];
  if (!actualKey) findings.push(`FIELD_NOT_IN_BITRIX: crm.deal.fields has no ${canonical}`);
  if (canonical !== configuredKey) {
    findings.push(`NON_CANONICAL_SPELLING: settings hold "${configuredKey}" but deal payloads carry "${canonical}". lib/analytics.ts reads the stored spelling verbatim, so the CUSTOM_FIELD step cannot fire until the setting is re-saved from the field list.`);
  }
  const readAs = (deal) => employeeIdFrom(deal[Object.keys(deal).find((key) => key.toUpperCase() === canonical.toUpperCase()) ?? canonical]);
  const populated = deals.filter((deal) => readAs(deal)).length;
  const asStoredKey = deals.filter((deal) => employeeIdFrom(deal[configuredKey])).length;
  if (populated && !asStoredKey && canonical !== configuredKey) {
    findings.push(`SILENTLY_UNREAD: ${populated} of ${deals.length} audited deals carry a value under ${canonical}, but 0 are readable under the stored spelling.`);
  }
  const type = scalar(meta?.type ?? meta?.USER_TYPE_ID ?? meta?.userTypeId);
  return {
    configured: true,
    configuredKey,
    canonicalKey: canonical,
    existsInBitrix: Boolean(actualKey),
    label: scalar(meta?.formLabel ?? meta?.title ?? meta?.listLabel ?? meta?.EDIT_FORM_LABEL) || null,
    type: type || null,
    isEmployeeType: /employee|user/i.test(type),
    populatedOnAuditedDeals: populated,
    auditedDeals: deals.length,
    populationRate: deals.length ? Math.round((populated / deals.length) * 100) : 0,
    usable: Boolean(actualKey) && canonical === configuredKey,
    findings,
  };
}

/**
 * Classifies ONE snapshot against the approved priority.
 *
 * A STAGE_MOVER row is deliberately not assumed wrong: it is verified when the
 * mover is provably sale-time evidence — the card still sits in the payment
 * stage, or the snapshot was frozen before the card ever reached post-sale.
 */
export function classifySnapshot({
  snapshot, lookup, postSaleEnteredAt = null,
  categoryId, postSaleCategoryId, paymentStageIds = [], isPaymentStageName = () => false,
  salesManagerFieldKey = null, fieldUsable = true,
}) {
  const flags = [];
  const base = { dealId: snapshot.dealId, attributionSource: snapshot.attributionSource || "(empty)", snapshotManagerId: snapshot.managerId, snapshotManagerName: snapshot.managerName, wonAt: snapshot.wonAt, frozenAt: snapshot.frozenAt };
  const out = (classification, reason, extra = {}) => ({ ...base, classification, reason, flags, ...extra });

  if (!lookup || lookup.kind !== "FOUND") {
    const code = lookup?.code ?? "MISSING";
    return out(CLASSIFICATIONS.UNKNOWN, `LOOKUP_${code}`, { note: "current Deal state unreadable, so the frozen seller cannot be checked either way" });
  }
  const deal = lookup.deal;
  const currentCategoryId = scalar(deal.CATEGORY_ID);
  const currentStageId = scalar(deal.STAGE_ID);
  const assignedById = employeeIdFrom(deal.ASSIGNED_BY_ID);
  const movedById = employeeIdFrom(deal.MOVED_BY_ID);
  const inSalesNow = currentCategoryId === String(categoryId);
  const isPostSaleNow = currentCategoryId === String(postSaleCategoryId);
  const currentStageIsPayment = paymentStageIds.length
    ? paymentStageIds.includes(currentStageId)
    : isPaymentStageName(currentStageId);
  const fieldKey = salesManagerFieldKey ? canonicalFieldKey(salesManagerFieldKey) : null;
  const actualKey = fieldKey ? Object.keys(deal).find((key) => key.toUpperCase() === fieldKey.toUpperCase()) : undefined;
  const stableSellerId = actualKey ? employeeIdFrom(deal[actualKey]) : "";
  const observed = {
    currentCategoryId, currentStageId, assignedById: assignedById || null, movedById: movedById || null,
    stableSellerId: stableSellerId || null, isPostSaleNow, currentStageIsPayment,
    postSaleEnteredAt, opportunity: Number(deal.OPPORTUNITY ?? 0) || 0, currency: scalar(deal.CURRENCY_ID) || NO_CURRENCY,
    createdAt: scalar(deal.DATE_CREATE) || null,
  };
  const result = (classification, reason, extra = {}) => out(classification, reason, { observed, ...extra });

  if (isPostSaleNow && snapshot.managerId && snapshot.managerId === assignedById) flags.push("SELLER_EQUALS_POST_SALE_ASSIGNEE");
  if (isPostSaleNow && snapshot.managerId && snapshot.managerId === movedById) flags.push("SELLER_EQUALS_POST_SALE_MOVER");
  if (!KNOWN_ATTRIBUTION_SOURCES.includes(snapshot.attributionSource)) flags.push(`LEGACY_ATTRIBUTION_SOURCE:${snapshot.attributionSource || "(empty)"}`);

  // Nothing was ever attributed: honest Unknown, not a wrong seller.
  if (!snapshot.managerId || snapshot.attributionSource === "UNKNOWN") {
    return result(CLASSIFICATIONS.UNKNOWN, "NO_SELLER_FROZEN");
  }

  // Priority 2 evidence, when it is actually readable, settles it either way.
  if (stableSellerId && fieldUsable) {
    if (stableSellerId === snapshot.managerId) return result(CLASSIFICATIONS.VERIFIED, "STABLE_FIELD_CONFIRMS_SNAPSHOT");
    return result(CLASSIFICATIONS.REPAIRABLE, "STABLE_FIELD_NAMES_ANOTHER_SELLER", { repairToManagerId: stableSellerId });
  }
  if (stableSellerId && !fieldUsable) {
    // The value exists but the running code cannot read it (see TASK A).
    flags.push("STABLE_FIELD_PRESENT_BUT_UNREADABLE_BY_CURRENT_CODE");
  }

  if (!KNOWN_ATTRIBUTION_SOURCES.includes(snapshot.attributionSource)) {
    return result(CLASSIFICATIONS.UNKNOWN, "UNRECOGNISED_ATTRIBUTION_SOURCE");
  }

  if (snapshot.attributionSource === "CUSTOM_FIELD") {
    // Frozen from the stable field at sync time; priority 1 outranks a field
    // that has since been cleared.
    if (!stableSellerId) flags.push("STABLE_FIELD_NOW_EMPTY");
    return result(CLASSIFICATIONS.VERIFIED, "FROZEN_FROM_STABLE_FIELD");
  }

  if (snapshot.attributionSource === "STAGE_MOVER") {
    if (inSalesNow && currentStageIsPayment) return result(CLASSIFICATIONS.VERIFIED, "MOVER_AT_PAYMENT_STAGE");
    const frozenMs = msOrNull(snapshot.frozenAt);
    const postSaleMs = msOrNull(postSaleEnteredAt);
    if (frozenMs === null) return result(CLASSIFICATIONS.UNKNOWN, "NO_FREEZE_TIME_TO_COMPARE");
    if (postSaleMs !== null) {
      return frozenMs < postSaleMs
        ? result(CLASSIFICATIONS.VERIFIED, "FROZEN_WHILE_STILL_IN_SALES")
        : result(CLASSIFICATIONS.SUSPICIOUS, "FROZEN_AFTER_POST_SALE_ENTRY");
    }
    if (inSalesNow) return result(CLASSIFICATIONS.SUSPICIOUS, "MOVER_NOT_AT_PAYMENT_STAGE");
    return result(CLASSIFICATIONS.SUSPICIOUS, "MOVED_OUT_OF_PROJECT_NO_PAYMENT_PROOF");
  }

  // CURRENT_RESPONSIBLE never proved a seller; it may always have been the
  // post-sale owner.
  return result(CLASSIFICATIONS.SUSPICIOUS, "CURRENT_RESPONSIBLE_NEVER_PROVEN");
}

function group(rows) {
  const ids = rows.map((row) => row.dealId).sort(compareIds);
  return { count: ids.length, ids };
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function moneyByCurrency(rows) {
  const cents = new Map();
  // A Deal whose current state was unreadable has no amount to report; counting
  // it as 0 would invent a currency bucket that does not exist.
  for (const row of rows.filter((item) => item.observed)) {
    const currency = row.observed?.currency ?? NO_CURRENCY;
    cents.set(currency, (cents.get(currency) ?? 0) + Math.round((row.observed?.opportunity ?? 0) * 100));
  }
  return Object.fromEntries([...cents].sort(([left], [right]) => left.localeCompare(right)).map(([currency, total]) => [currency, (total / 100).toFixed(2)]));
}

function sellerBreakdown(rows, sellerOf) {
  const byId = new Map();
  for (const row of rows) {
    const id = sellerOf(row);
    if (!id) continue;
    const item = byId.get(id) ?? { managerId: id, managerName: row.snapshotManagerName || null, deals: [] };
    if (!item.managerName && row.snapshotManagerName) item.managerName = row.snapshotManagerName;
    item.deals.push(row.dealId);
    byId.set(id, item);
  }
  return [...byId.values()]
    .map((item) => ({ ...item, count: item.deals.length, deals: item.deals.sort(compareIds) }))
    .sort((left, right) => right.count - left.count || compareIds(left.managerId, right.managerId));
}

export function summarizeAttribution({ rows, fieldReport, cohortBounds = null, expectedCohortSales = null, userNames = new Map() }) {
  const by = (classification) => rows.filter((row) => row.classification === classification);
  const verified = by(CLASSIFICATIONS.VERIFIED);
  const repairable = by(CLASSIFICATIONS.REPAIRABLE);
  const suspicious = by(CLASSIFICATIONS.SUSPICIOUS);
  const unknown = by(CLASSIFICATIONS.UNKNOWN);
  const notVerified = [...repairable, ...suspicious, ...unknown];
  const name = (id) => userNames.get(String(id)) ?? null;

  const inCohort = (row) => {
    if (!cohortBounds) return false;
    const created = msOrNull(row.observed?.createdAt);
    return created !== null && created >= cohortBounds.fromMs && created < cohortBounds.toExclusiveMs;
  };
  const cohortRows = cohortBounds ? rows.filter(inCohort) : [];

  // Would a repair move Sales between managers? Compare who is credited now
  // with who would be credited after the automatic repairs only.
  const currentCredit = countBy(rows.filter((row) => row.snapshotManagerId), (row) => row.snapshotManagerId);
  const repairedCredit = countBy(
    rows.filter((row) => row.snapshotManagerId || row.repairToManagerId),
    (row) => row.repairToManagerId ?? row.snapshotManagerId,
  );
  const movedManagers = [...new Set([...Object.keys(currentCredit), ...Object.keys(repairedCredit)])]
    .map((id) => ({ managerId: id, managerName: name(id), now: currentCredit[id] ?? 0, afterRepair: repairedCredit[id] ?? 0 }))
    .filter((item) => item.now !== item.afterRepair)
    .sort((left, right) => Math.abs(right.afterRepair - right.now) - Math.abs(left.afterRepair - left.now));

  return {
    totals: {
      snapshots: rows.length,
      confidentlyCorrect: verified.length,
      repairableAutomatically: repairable.length,
      suspiciousNotAutomaticallyRepairable: suspicious.length,
      unknown: unknown.length,
      atRiskOfWrongSeller: repairable.length + suspicious.length,
    },
    byClassification: countBy(rows, (row) => row.classification),
    byAttributionSource: countBy(rows, (row) => row.attributionSource),
    byClassificationAndSource: Object.fromEntries(
      Object.keys(countBy(rows, (row) => row.attributionSource)).map((source) => [
        source, countBy(rows.filter((row) => row.attributionSource === source), (row) => row.classification),
      ]),
    ),
    byReason: countBy(rows, (row) => row.reason),
    flags: countBy(rows.flatMap((row) => row.flags.map((flag) => ({ flag }))), (row) => row.flag),
    suspiciousPopulations: {
      currentResponsibleSnapshots: group(rows.filter((row) => row.attributionSource === "CURRENT_RESPONSIBLE")),
      stageMoverNowPostSale: group(rows.filter((row) => row.attributionSource === "STAGE_MOVER" && row.observed?.isPostSaleNow)),
      snapshotDiffersFromStableField: group(repairable),
      sellerEqualsPostSaleAssignee: group(rows.filter((row) => row.flags.includes("SELLER_EQUALS_POST_SALE_ASSIGNEE"))),
    },
    affectedSellers: {
      note: "Sellers currently credited by a snapshot that is not verified — they may be holding someone else's Sales, or vice versa.",
      credited: sellerBreakdown(notVerified, (row) => row.snapshotManagerId).map((item) => ({ ...item, managerName: item.managerName ?? name(item.managerId) })),
      wouldGainFromRepair: sellerBreakdown(repairable, (row) => row.repairToManagerId).map((item) => ({ ...item, managerName: name(item.managerId) })),
    },
    revenueAtRisk: {
      note: "OPPORTUNITY of Deals whose frozen seller is not verified. Deal value, not cash received; currencies are never added together.",
      notVerifiedByCurrency: moneyByCurrency(notVerified),
      repairableByCurrency: moneyByCurrency(repairable),
      suspiciousByCurrency: moneyByCurrency(suspicious),
    },
    managerTableImpact: {
      note: "How many Sales rows each manager gains or loses if ONLY the automatic repairs are applied. A non-empty list means the manager conversion tables are materially affected.",
      materiallyAffected: movedManagers.length > 0,
      managers: movedManagers,
    },
    cohort: cohortBounds ? {
      range: { from: cohortBounds.from, to: cohortBounds.to, timezone: TIMEZONE, basis: "DATE_CREATE" },
      snapshotsInCohort: cohortRows.length,
      expectedCohortSales: expectedCohortSales,
      salesWithNoSnapshotAtAll: expectedCohortSales === null ? null : Math.max(0, expectedCohortSales - cohortRows.length),
      byClassification: countBy(cohortRows, (row) => row.classification),
      verified: group(cohortRows.filter((row) => row.classification === CLASSIFICATIONS.VERIFIED)),
      repairable: group(cohortRows.filter((row) => row.classification === CLASSIFICATIONS.REPAIRABLE)),
      suspicious: group(cohortRows.filter((row) => row.classification === CLASSIFICATIONS.SUSPICIOUS)),
      unknown: group(cohortRows.filter((row) => row.classification === CLASSIFICATIONS.UNKNOWN)),
      sellerBreakdownVerifiedAndRepairable: sellerBreakdown(
        cohortRows.filter((row) => [CLASSIFICATIONS.VERIFIED, CLASSIFICATIONS.REPAIRABLE].includes(row.classification)),
        (row) => row.repairToManagerId ?? row.snapshotManagerId,
      ).map((item) => ({ ...item, managerName: item.managerName ?? name(item.managerId) })),
    } : null,
    repairRecommendation: buildRepairRecommendation({ fieldReport, verified, repairable, suspicious, unknown }),
  };
}

/** TASK D, derived from what the evidence actually supports. */
export function buildRepairRecommendation({ fieldReport, repairable, suspicious, unknown }) {
  const steps = [];
  const blocked = [];
  if (fieldReport.configured && !fieldReport.usable) {
    steps.push("FIRST, fix the configuration, not the data: the stable Sales Manager field is unusable as stored (see configuration.findings). Re-save it from the Settings field list so the CUSTOM_FIELD step can fire. Repairing snapshots before this would re-freeze the same guesses.");
  }
  if (!fieldReport.configured) {
    blocked.push("No salesManagerField is configured, so there is no automatic repair source. Configure and populate it on won Deals, or accept Unknown for the suspicious rows.");
  }
  if (repairable.length) {
    steps.push(`ANALYTICS BACKFILL is sufficient for the ${repairable.length} REPAIRABLE_FROM_CUSTOM_FIELD row(s): the shipped upsert already replaces a CURRENT_RESPONSIBLE seller with CUSTOM_FIELD/STAGE_MOVER evidence, so a rebuild corrects them without touching Bitrix.`);
  }
  if (suspicious.length) {
    steps.push(`TARGETED SNAPSHOT CORRECTION is the only thing that can fix the ${suspicious.length} SUSPICIOUS_NO_PROOF row(s), and only after a human names the seller: no field in Bitrix proves who sold them. A backfill cannot repair a STAGE_MOVER row, because the upsert guard treats it as trustworthy.`);
  }
  if (unknown.length) {
    steps.push(`${unknown.length} row(s) are UNKNOWN_INSUFFICIENT_EVIDENCE — report them as Unknown rather than attributing them to anyone.`);
  }
  steps.push("A FULL SYNC is NOT required and is the riskier option: it re-reads Bitrix but cannot invent historical actors, and stage history carries no per-move actor, so it would not recover a single lost seller.");
  return { orderedSteps: steps, blockers: blocked, mutatesNothingInThisAudit: true };
}

export function parseArgs(argv) {
  const values = {};
  const flags = ["--snapshots", "--settings", "--sales-manager-field", "--category-id", "--post-sale-category-id", "--from", "--to", "--expected-cohort-sales", "--out-dir"];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!flags.includes(token)) throw new EvidenceError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new EvidenceError("INVALID_ARGUMENT", `${token} requires a value`);
    values[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!values.snapshots) throw new EvidenceError("MISSING_SNAPSHOTS", "--snapshots <file.json> is required (read-only D1 export)");
  if (!/^\d+$/.test(values.categoryId ?? "")) throw new EvidenceError("INVALID_CATEGORY", "--category-id is required and must be numeric");
  if (!/^\d+$/.test(values.postSaleCategoryId ?? "") || values.postSaleCategoryId === values.categoryId) {
    throw new EvidenceError("INVALID_POST_SALE_CATEGORY", "--post-sale-category-id is required, numeric and different from --category-id");
  }
  if ((values.from && !values.to) || (values.to && !values.from)) throw new EvidenceError("INVALID_DATE_RANGE", "--from and --to must be given together");
  if (values.expectedCohortSales !== undefined && !/^\d+$/.test(values.expectedCohortSales)) {
    throw new EvidenceError("INVALID_EXPECTED_COHORT", "--expected-cohort-sales must be a whole number");
  }
  return {
    help: false,
    snapshots: values.snapshots,
    settings: values.settings ?? null,
    salesManagerField: values.salesManagerField ?? null,
    categoryId: values.categoryId,
    postSaleCategoryId: values.postSaleCategoryId,
    from: values.from ?? null,
    to: values.to ?? null,
    expectedCohortSales: values.expectedCohortSales === undefined ? null : Number(values.expectedCohortSales),
    outDir: values.outDir ?? null,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new EvidenceError("INVALID_INPUT_FILE", `${file} is not readable JSON${error instanceof SyntaxError ? " (syntax error)" : ""}`);
  }
}

export async function runAudit({ call, config, snapshots, settings, now = () => new Date(), retryOptions = {} }) {
  const startedAt = now().toISOString();
  const fieldKey = config.salesManagerField ?? settings.salesManagerField;
  const cohortBounds = config.from && config.to ? tashkentDateBounds(config.from, config.to) : null;

  const dealIds = [...new Set(snapshots.map((row) => row.dealId))];
  const [dealFieldsResponse, postSaleHistory, currentDeals, stageRows] = await Promise.all([
    callWithTransientRetry(call, "crm.deal.fields", {}, retryOptions),
    discoverIboxDealIds(call, config.postSaleCategoryId, retryOptions),
    fetchCurrentDeals(call, dealIds, retryOptions),
    callWithTransientRetry(call, "crm.status.list", { order: { SORT: "ASC" }, filter: { ENTITY_ID: `DEAL_STAGE_${config.categoryId}` } }, retryOptions),
  ]);

  const stageNames = new Map((Array.isArray(stageRows?.result) ? stageRows.result : stageRows?.result?.items ?? [])
    .map((row) => [scalar(row.STATUS_ID || row.ID), scalar(row.NAME)]));
  const isPaymentStageName = (stageId) => {
    const name = (stageNames.get(stageId) ?? "").toLocaleLowerCase();
    return name.includes("оплата получена") || (name.includes("oplata") && (name.includes("poluch") || name.includes("olindi")));
  };
  const postSaleEntry = new Map();
  for (const [dealId, rows] of postSaleHistory.histories) {
    const first = rows.map((row) => scalar(row.CREATED_TIME)).filter(Boolean).sort()[0];
    if (first) postSaleEntry.set(dealId, first);
  }
  const foundDeals = dealIds.map((id) => currentDeals.get(id)).filter((lookup) => lookup?.kind === "FOUND").map((lookup) => lookup.deal);
  const fieldReport = inspectSalesManagerField({ configuredKey: fieldKey, dealFields: dealFieldsResponse?.result, deals: foundDeals });

  const rows = snapshots.map((snapshot) => classifySnapshot({
    snapshot,
    lookup: currentDeals.get(snapshot.dealId),
    postSaleEnteredAt: postSaleEntry.get(snapshot.dealId) ?? null,
    categoryId: config.categoryId,
    postSaleCategoryId: config.postSaleCategoryId,
    paymentStageIds: settings.paymentStageIds,
    isPaymentStageName,
    salesManagerFieldKey: fieldKey,
    fieldUsable: fieldReport.usable,
  }));

  // Names come from the snapshot rows themselves (`manager_name`), so the audit
  // needs no extra Bitrix call and stays inside the four read methods.
  const userNames = new Map(snapshots.filter((row) => row.managerId && row.managerName).map((row) => [String(row.managerId), row.managerName]));
  const summary = summarizeAttribution({ rows, fieldReport, cohortBounds, expectedCohortSales: config.expectedCohortSales, userNames });
  const completedAt = now().toISOString();

  return {
    schemaVersion: 1,
    kind: "seller-attribution-audit",
    result: summary.totals.unknown ? "COMPLETE_WITH_UNKNOWN" : "COMPLETE",
    snapshot: { startedAt, completedAt },
    config: {
      categoryId: String(config.categoryId),
      postSaleCategoryId: String(config.postSaleCategoryId),
      salesManagerFieldFromSettings: settings.salesManagerField,
      salesManagerFieldUsed: fieldKey ?? null,
      paymentStageIdsConfigured: settings.paymentStageIds,
      paymentStageDetection: settings.paymentStageIds.length ? "configured stage IDs" : "stage-name fallback",
      timezone: TIMEZONE,
      approvedPriority: ["trustworthy snapshot", "stable Sales Manager field", "MOVED_BY_ID only while the current stage is the payment stage", "Unknown"],
      readOnly: "no D1 access, no Bitrix writes, no sync or backfill; snapshots come from an operator-supplied read-only export",
      methods: ["crm.deal.fields", "crm.deal.get", "crm.stagehistory.list", "crm.status.list"],
    },
    configuration: fieldReport,
    ...summary,
    snapshotRows: rows.map(({ observed, ...row }) => ({
      ...row,
      currentCategoryId: observed?.currentCategoryId ?? null,
      currentStageId: observed?.currentStageId ?? null,
      currentStageName: observed ? stageNames.get(observed.currentStageId) ?? null : null,
      currentAssignedById: observed?.assignedById ?? null,
      currentMovedById: observed?.movedById ?? null,
      stableFieldSellerId: observed?.stableSellerId ?? null,
      postSaleEnteredAt: observed?.postSaleEnteredAt ?? null,
      isPostSaleNow: observed?.isPostSaleNow ?? null,
    })),
  };
}

const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : "—");

export function renderSummary(report) {
  const t = report.totals;
  const config = report.configuration;
  const cohort = report.cohort;
  const lines = [
    "Seller attribution audit (read-only)",
    "",
    `Result: ${report.result}`,
    `Snapshot: ${report.snapshot.startedAt} — ${report.snapshot.completedAt}`,
    `IBOX Sales category ${report.config.categoryId}, post-sale category ${report.config.postSaleCategoryId}`,
    `Payment-stage detection: ${report.config.paymentStageDetection}`,
    "",
    "TASK A — CONFIGURED SALES MANAGER FIELD",
    config.configured
      ? `- configured: ${config.configuredKey} (canonical ${config.canonicalKey}); exists in Bitrix: ${config.existsInBitrix ? "yes" : "NO"}`
      : "- configured: NO",
    config.configured ? `- label: ${config.label ?? "(none)"}; type: ${config.type ?? "(unknown)"}${config.isEmployeeType ? " (employee/user)" : ""}` : "",
    config.configured ? `- populated on ${config.populatedOnAuditedDeals}/${config.auditedDeals} audited won Deals (${config.populationRate}%)` : "",
    config.configured ? `- usable by the running code: ${config.usable ? "yes" : "NO"}` : "",
    ...config.findings.map((finding) => `  ! ${finding}`),
    "",
    "TASK B — SNAPSHOTS BY ATTRIBUTION SOURCE",
    ...Object.entries(report.byAttributionSource).map(([source, count]) => `- ${source}: ${count}`),
    "",
    "CLASSIFICATION",
    ...Object.entries(report.byClassification).map(([name, count]) => `- ${name}: ${count} (${pct(count, t.snapshots)})`),
    "",
    "BY SOURCE AND CLASSIFICATION",
    ...Object.entries(report.byClassificationAndSource).map(([source, counts]) => `- ${source}: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ")}`),
    "",
    "REASONS",
    ...Object.entries(report.byReason).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "SUSPICIOUS POPULATIONS",
    `- CURRENT_RESPONSIBLE snapshots: ${report.suspiciousPopulations.currentResponsibleSnapshots.count}`,
    `- STAGE_MOVER snapshots now in post-sale: ${report.suspiciousPopulations.stageMoverNowPostSale.count}`,
    `- snapshot seller differs from the stable field: ${report.suspiciousPopulations.snapshotDiffersFromStableField.count}`,
    `- frozen seller equals the current post-sale assignee: ${report.suspiciousPopulations.sellerEqualsPostSaleAssignee.count}${report.suspiciousPopulations.sellerEqualsPostSaleAssignee.count ? ` [${report.suspiciousPopulations.sellerEqualsPostSaleAssignee.ids.join(", ")}]` : ""}`,
    "",
    "TASK C — BUSINESS IMPACT",
    `- total sales snapshots: ${t.snapshots}`,
    `- confidently correct: ${t.confidentlyCorrect} (${pct(t.confidentlyCorrect, t.snapshots)})`,
    `- repairable automatically: ${t.repairableAutomatically}`,
    `- suspicious, not automatically repairable: ${t.suspiciousNotAutomaticallyRepairable}`,
    `- unknown: ${t.unknown}`,
    `- Sales/Revenue rows that could be attributed to the wrong person: ${t.atRiskOfWrongSeller}`,
    `- manager conversion tables materially affected: ${report.managerTableImpact.materiallyAffected ? "YES" : "no"}`,
    ...report.managerTableImpact.managers.map((item) => `  - ${item.managerId} ${item.managerName ?? ""}: ${item.now} now → ${item.afterRepair} after automatic repair`),
    "",
    "AFFECTED SELLERS (credited by a snapshot that is not verified)",
    ...(report.affectedSellers.credited.length
      ? report.affectedSellers.credited.map((item) => `- ${item.managerId} ${item.managerName ?? "(name unknown)"}: ${item.count} deal(s) [${item.deals.join(", ")}]`)
      : ["- none"]),
    "",
    "REVENUE AT RISK (deal value, not cash)",
    ...Object.entries(report.revenueAtRisk.notVerifiedByCurrency).map(([currency, value]) => `- ${currency}: ${value}`),
  ];
  if (cohort) {
    lines.push(
      "",
      `COHORT ${cohort.range.from} — ${cohort.range.to} (${cohort.range.basis}, ${cohort.range.timezone})`,
      `- snapshots in cohort: ${cohort.snapshotsInCohort}${cohort.expectedCohortSales === null ? "" : ` of ${cohort.expectedCohortSales} expected cohort Sales`}`,
      ...(cohort.salesWithNoSnapshotAtAll === null ? [] : [`- cohort Sales with no frozen seller at all: ${cohort.salesWithNoSnapshotAtAll}`]),
      `- verified: ${cohort.verified.count}; repairable: ${cohort.repairable.count}; suspicious: ${cohort.suspicious.count}; unknown: ${cohort.unknown.count}`,
      "- seller breakdown (VERIFIED + REPAIRABLE evidence only):",
      ...(cohort.sellerBreakdownVerifiedAndRepairable.length
        ? cohort.sellerBreakdownVerifiedAndRepairable.map((item) => `  - ${item.managerId} ${item.managerName ?? "(name unknown)"}: ${item.count}`)
        : ["  - none"]),
    );
  }
  lines.push(
    "",
    "TASK D — SAFE REPAIR",
    ...report.repairRecommendation.orderedSteps.map((step, index) => `${index + 1}. ${step}`),
    ...report.repairRecommendation.blockers.map((item) => `!  ${item}`),
    "",
    "Nothing was mutated by this audit.",
    "",
  );
  return lines.filter((line) => line !== "").concat("").join("\n");
}

export async function writeAuditOutput(report, auditDir = DEFAULT_AUDIT_DIR) {
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const stamp = report.snapshot.completedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(auditDir, `${stamp}_seller-attribution.json`);
  const summaryPath = path.join(auditDir, `${stamp}_seller-attribution.txt`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(summaryPath, renderSummary(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, summaryPath };
}

export function usage() {
  return [
    "Read-only seller attribution audit",
    "",
    "Export the two tables first, with read-only SELECTs (no writes):",
    '  npx wrangler d1 execute DB --remote --config wrangler.generated.jsonc --json \\',
    '    --command "SELECT deal_id, won_at, manager_id, manager_name, attribution_source, created_at FROM deal_sales_snapshots" \\',
    "    > .audit/in/snapshots.json",
    '  npx wrangler d1 execute DB --remote --config wrangler.generated.jsonc --json \\',
    '    --command "SELECT key, value FROM app_settings WHERE key = \'dashboard\'" \\',
    "    > .audit/in/settings.json",
    "",
    "Then, with BITRIX24_WEBHOOK_URL already in the environment:",
    "  npm run audit:seller-attribution -- \\",
    "    --snapshots .audit/in/snapshots.json --settings .audit/in/settings.json \\",
    "    --category-id 3 --post-sale-category-id 13 \\",
    "    --from 2026-09-01 --to 2026-09-19 --expected-cohort-sales 41",
    "",
    `Output: ${path.relative(path.resolve(scriptDir, ".."), DEFAULT_AUDIT_DIR)}/ (git-ignored)`,
  ].join("\n");
}

export async function runCli(argv, environment = process.env) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const snapshots = readSnapshotRows(await readJson(config.snapshots));
  if (!snapshots.length) throw new EvidenceError("NO_SNAPSHOTS", "the snapshots export contained no deal_sales_snapshots rows");
  const settings = config.settings ? readSettings(await readJson(config.settings)) : { salesManagerField: null, paymentStageIds: [], selectedPipelineIds: [], postSalePipelineIds: [] };
  const call = createBitrixClient(environment.BITRIX24_WEBHOOK_URL);
  const report = await runAudit({ call, config, snapshots, settings });
  const files = await writeAuditOutput(report, config.outDir ?? DEFAULT_AUDIT_DIR);
  process.stdout.write(renderSummary(report));
  process.stdout.write(`JSON: ${files.jsonPath}\nSummary: ${files.summaryPath}\n`);
  return report;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof EvidenceError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`Seller attribution audit failed (${code}).\n`);
    process.exitCode = 1;
  });
}
