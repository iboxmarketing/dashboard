#!/usr/bin/env node
/**
 * As-of outcome reconstruction — "what did this cohort look like on <instant>,
 * and what has changed since?"
 *
 * A frozen KPI reference is a statement about evidence at a moment, not a
 * permanent fact: a Deal certified as SQL on 19 September can be marked Not
 * Relevant on 21 September, and both readings are correct for their date. This
 * tool rebuilds every Deal twice with the SAME analytics builder the sync uses:
 *
 *   as-of    stage history truncated at the instant, and the Deal's stage,
 *            category and MOVED_TIME taken from the last history row at or
 *            before it;
 *   current  the stored evidence as it is now.
 *
 * Every difference is therefore reported with the stage-history row that caused
 * it and its timestamp. Fields Bitrix does not version — the failure reason,
 * the amount — keep their current value; they are diagnostic, never the
 * classification (docs/BUSINESS_RULES.md §3).
 *
 * Read-only: D1 is queried through `wrangler d1 execute`, nothing is written,
 * and Bitrix is never called.
 *
 *   npm run audit:outcome-drift -- --database ibox-dashboard-production \
 *     --from 2026-09-01 --to 2026-09-19 --as-of 2026-09-19T19:42:31.378Z \
 *     [--ids <file.json>] [--out <file.json>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildAnalyticsRecords, type RawDeal, type RawStageHistory } from "../lib/analytics";
import { buildFieldOptionMap, buildStatusMaps, buildUserMap } from "../lib/analytics-dictionaries";
import { defaultSettings } from "../lib/business-time";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import { boundsFromKeys } from "../lib/period";
import { isEligibleCohortDeal, isSalesLost } from "../lib/sales-logic";
import { projectScopedRecords } from "../lib/sales-sections";
import { normalizeSettings } from "../lib/settings-safety";
import { stageIdList } from "../lib/stage-config";
import { resolveDashboardMetricIds } from "../lib/dashboard-metrics";
import { normalizeSafeStableSellerField } from "../lib/stable-seller-field";
import type { AnalyticsRecord, CrmFieldOption, DashboardSettings } from "../lib/types";

const args = process.argv.slice(2);
const arg = (name: string, fallback = "") => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const database = arg("database");
const from = arg("from");
const to = arg("to");
const asOf = arg("as-of");
const idsFile = arg("ids");
const out = arg("out");
if (!database || !from || !to || !asOf) throw new Error("--database, --from, --to and --as-of are required");

function query<T>(sql: string): T[] {
  const raw = execFileSync("npx", ["--no-install", "wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql], {
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" },
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf("["))) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

const parse = <T,>(rows: { payload: string }[]) => rows.flatMap((row) => { try { return [JSON.parse(row.payload) as T]; } catch { return []; } });
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/* ------------------------------------------------------------------ inputs */

const settingsRow = query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'dashboard'")[0];
const stored = settingsRow ? JSON.parse(settingsRow.value) as Partial<DashboardSettings> : {};
const settings = normalizeSettings({
  ...defaultSettings, ...stored,
  salesManagerField: normalizeSafeStableSellerField(stored.salesManagerField),
  schedule: { ...defaultSettings.schedule, ...(stored.schedule ?? {}) },
  holidays: Array.isArray(stored.holidays) ? stored.holidays : [],
  selectedPipelineIds: (stored.selectedPipelineIds ?? []).map(String),
  postSalePipelineIds: (stored.postSalePipelineIds ?? []).map(String),
  stageLimits: stored.stageLimits ?? {},
  qualifiedStageIds: stageIdList(stored.qualifiedStageIds), lowQualityStageIds: stageIdList(stored.lowQualityStageIds),
  paymentStageIds: stageIdList(stored.paymentStageIds), closedLostStageIds: stageIdList(stored.closedLostStageIds),
  dashboardMetricIds: resolveDashboardMetricIds(stored.dashboardMetricIds),
} as DashboardSettings);

const dictionary = <T,>(key: string, fallback: T): T => {
  const row = query<{ payload: string }>(`SELECT payload FROM crm_dictionaries WHERE key = '${key}'`)[0];
  try { return row ? JSON.parse(row.payload) as T : fallback; } catch { return fallback; }
};
const users = buildUserMap(dictionary<Record<string, unknown>[]>("users", []));
const { stages, sources, stageMeta } = buildStatusMaps(dictionary<Record<string, unknown>[]>("statuses", []));
const fieldOptions = buildFieldOptionMap(dictionary<CrmFieldOption[]>("crmFields", []));
const pipelines = new Map(dictionary<{ id: string; name: string }[]>("pipelines", []).map((row) => [String(row.id), String(row.name)]));

const bounds = boundsFromKeys({ from, to });
const fromIso = new Date(bounds.from).toISOString();
const toIso = new Date(bounds.to).toISOString();
const cohortIds = new Set(
  idsFile
    ? (JSON.parse(readFileSync(idsFile, "utf8")) as { includedIds?: (string | number)[] }).includedIds?.map(String) ?? []
    : query<{ deal_id: string }>(
      `SELECT deal_id FROM analytics_records WHERE json_valid(payload) AND json_extract(payload,'$.createdAt') >= '${fromIso}' AND json_extract(payload,'$.createdAt') <= '${toIso}'`,
    ).map((row) => String(row.deal_id)),
);
if (!cohortIds.size) throw new Error("no Deals in the requested cohort");

// Period Sales is dated by `wonAt`, so a Deal created before the range can
// belong to it (Deal 40099 is the canonical example). Those Deals are loaded
// too, and counted only in the Period population.
const periodIds = new Set(query<{ deal_id: string }>(
  `SELECT deal_id FROM analytics_records WHERE json_valid(payload) AND json_extract(payload,'$.salesStatus') = 'WON' AND json_extract(payload,'$.wonAt') >= '${fromIso}' AND json_extract(payload,'$.wonAt') <= '${toIso}'`,
).map((row) => String(row.deal_id)));

const loadIds = [...new Set([...cohortIds, ...periodIds])];
const idList = loadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
const deals = parse<RawDeal>(query<{ payload: string }>(`SELECT payload FROM raw_deals WHERE deal_id IN (${idList})`));
const histories = parse<RawStageHistory>(query<{ payload: string }>(`SELECT payload FROM raw_stage_history WHERE deal_id IN (${idList})`));

/* ------------------------------------------------------------- as-of build */

const historyByDeal = new Map<string, RawStageHistory[]>();
for (const history of histories) {
  const id = text(history.OWNER_ID);
  if (!id) continue;
  const rows = historyByDeal.get(id);
  if (rows) rows.push(history); else historyByDeal.set(id, [history]);
}
for (const rows of historyByDeal.values()) rows.sort((a, b) => text(a.CREATED_TIME).localeCompare(text(b.CREATED_TIME)));

const instant = new Date(asOf).getTime();
const before = (history: RawStageHistory) => new Date(text(history.CREATED_TIME)).getTime() <= instant;

/** The Deal as the CRM held it at the instant: last stage entered at or before it. */
function asOfDeal(deal: RawDeal) {
  const rows = (historyByDeal.get(text(deal.ID)) ?? []).filter(before);
  const last = rows[rows.length - 1];
  return last
    ? { ...deal, CATEGORY_ID: text(last.CATEGORY_ID), STAGE_ID: text(last.STAGE_ID), MOVED_TIME: text(last.CREATED_TIME), CLOSED: "N" }
    : deal;
}

const build = (rows: RawDeal[], stageHistories: RawStageHistory[]) => buildAnalyticsRecords({
  deals: rows, stageHistories, settings, users, pipelines, stages, sources, stageMeta, fieldOptions,
  domain: null, stageHistoryAvailable: true,
});

// The canonical read path: the project's own records, each with a decided
// membership — exactly what a Sales section computes from (lib/sales-sections.ts).
const scoped = (records: AnalyticsRecord[]) => projectScopedRecords(records, settings);
const currentRecords = scoped(build(deals, histories));
const asOfRecords = scoped(build(deals.map(asOfDeal), histories.filter(before)));

/* ------------------------------------------------------------ classification */

type Quality = "SQL" | "NOT_RELEVANT" | "UNCLASSIFIED";
type Outcome = "SALE" | "SALES_LOST" | "NOT_RELEVANT" | "ROUTED" | "OPEN";
const quality = (row: AnalyticsRecord): Quality => (row.qualified ? "SQL" : row.lossReasonGroup === "MARKETING" ? "NOT_RELEVANT" : "UNCLASSIFIED");
const outcome = (row: AnalyticsRecord): Outcome =>
  row.salesStatus === "WON" ? "SALE"
    : row.lossReasonGroup === "MARKETING" ? "NOT_RELEVANT"
      : isSalesLost(row) ? "SALES_LOST"
        : row.lossReasonGroup === "ROUTING" ? "ROUTED" : "OPEN";

function summarize(records: AnalyticsRecord[], label: string) {
  const cohort = records.filter((row) => {
    const created = new Date(row.createdAt).getTime();
    return created >= bounds.from && created <= bounds.to;
  });
  const won = records.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= bounds.from && new Date(row.wonAt).getTime() <= bounds.to);
  const metrics = buildDashboardMetrics(cohort, won);
  return {
    label,
    lead: metrics.counts.leads, sql: metrics.counts.sql, notRelevant: metrics.counts.not_relevant,
    saralangan: metrics.counts.classified_leads, saralanmagan: metrics.counts.unclassified_leads,
    salesLost: metrics.counts.sales_lost, preSqlClosed: metrics.counts.pre_sql_closed,
    cohortSales: metrics.counts.cohort_sales, periodSales: metrics.counts.period_sales,
    cohortRevenue: metrics.money.cohort_revenue, periodRevenue: metrics.money.revenue, currency: metrics.money.currency,
    eligible: cohort.filter(isEligibleCohortDeal).length,
  };
}

const asOfById = new Map(asOfRecords.map((row) => [row.dealId, row]));
const changes = currentRecords.filter((row) => cohortIds.has(row.dealId)).flatMap((current) => {
  const past = asOfById.get(current.dealId);
  if (!past) return [];
  const sameQuality = quality(past) === quality(current);
  const sameOutcome = outcome(past) === outcome(current);
  const sameMembership = (past.projectLeadMembership ?? "") === (current.projectLeadMembership ?? "");
  if (sameQuality && sameOutcome && sameMembership) return [];
  const moves = (historyByDeal.get(current.dealId) ?? []).filter((history) => !before(history));
  return [{
    dealId: current.dealId,
    was: { quality: quality(past), outcome: outcome(past), membership: past.projectLeadMembership ?? null, stage: past.stage, stageId: past.stageId },
    now: { quality: quality(current), outcome: outcome(current), membership: current.projectLeadMembership ?? null, stage: current.stage, stageId: current.stageId },
    transitions: moves.map((history) => ({ at: text(history.CREATED_TIME), categoryId: text(history.CATEGORY_ID), stageId: text(history.STAGE_ID), stage: stages.get(text(history.STAGE_ID)) ?? text(history.STAGE_ID) })),
    lossReason: current.lossReason,
  }];
});

const report = {
  database, range: { from, to }, asOf, generatedAt: new Date().toISOString(),
  cohortIds: cohortIds.size, periodIds: periodIds.size, rawDeals: deals.length,
  missingRawDeals: loadIds.filter((id) => !deals.some((deal) => text(deal.ID) === id)),
  asOfSummary: summarize(asOfRecords, `as-of ${asOf}`),
  currentSummary: summarize(currentRecords, "current"),
  changedCount: changes.length,
  changes: changes.sort((a, b) => a.dealId.localeCompare(b.dealId)),
};
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, changes: report.changes.slice(0, 40) }, null, 1));
