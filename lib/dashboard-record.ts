import type { AnalyticsRecord } from "./types";

/**
 * The shape `/api/dashboard` actually returns.
 *
 * It is deliberately NOT an `AnalyticsRecord`. The stored record keeps all 66
 * fields — nothing is deleted from D1 — but the dashboard response omits the
 * ones no consumer reads, and replaces the largest field with a count.
 *
 * The omissions are listed here rather than inlined in a query so the storage
 * layer, the client type and the regression tests all read from one source.
 */

/**
 * Written by `buildAnalyticsRecords` and read by nobody.
 *
 * Verified field by field across dashboard-client, dashboard-metrics,
 * sales-logic, sla, duplicates, diagnostics, custom-pages, share-render,
 * projects and the test suite. Two of them — `sourceId` and
 * `stageChangedBeforeCall` — are still read by `upsertAnalyticsRecords` when it
 * writes the indexed columns, so they stay in the stored payload; they are
 * simply never needed in the response.
 */
export const DASHBOARD_OMITTED_FIELDS = [
  "firstStageChangeAt", "firstStageChangeTo", "firstStageChangeBusinessMinutes",
  "firstCallAt", "firstCallActivityId", "firstCallManagerId", "firstCallManager",
  "firstCallBusinessMinutes", "firstCallDuration", "firstCallOutcome",
  "firstSuccessfulCallAt", "firstSuccessfulCallBusinessMinutes", "latestCallOutcome",
  "outgoingCallCount", "answeredCallCount", "unansweredCallCount",
  "outcomeInferred", "stageAttributionInferred", "stageChangedBeforeCall", "sourceId",
] as const;

/**
 * `stageTimeline` is 30% of the response and has exactly two consumers: the
 * Stage Control historical funnel, which now fetches it on demand, and the
 * `missingStageHistory` diagnostic, which only ever read its length.
 */
export const DASHBOARD_TIMELINE_FIELD = "stageTimeline" as const;
export const STAGE_HISTORY_COUNT_FIELD = "stageHistoryCount" as const;

export type DashboardRecord =
  Omit<AnalyticsRecord, (typeof DASHBOARD_OMITTED_FIELDS)[number] | "stageTimeline">
  & { stageHistoryCount: number };

/** Minimal row the Stage Control funnel needs: its own filters plus the timeline. */
export type StageFunnelRecord = Pick<AnalyticsRecord,
  "dealId" | "title" | "assignedManagerId" | "salesManagerId" | "originPipeline" | "originCategoryId"
  | "salesStatus" | "qualified" | "lossReasonGroup" | "stageTimeline">;

/**
 * `qualified` and `lossReasonGroup` are carried so the historical outcome
 * summary can reuse the canonical predicates (isSalesLost / isPreSqlClosed)
 * instead of classifying by stage or reason text. Two scalars per row: the
 * endpoint stays lazy and the payload stays a projection, not a full record.
 */
export const STAGE_FUNNEL_FIELDS = [
  "dealId", "title", "assignedManagerId", "salesManagerId",
  "originPipeline", "originCategoryId", "salesStatus", "qualified", "lossReasonGroup", "stageTimeline",
] as const;

/** SQLite JSON path list for the fields the dashboard response drops. */
export function dashboardRemovedPaths() {
  return [...DASHBOARD_OMITTED_FIELDS, DASHBOARD_TIMELINE_FIELD].map((field) => `$.${field}`);
}

/**
 * What the shared metric/diagnostic helpers actually read.
 *
 * Both shapes satisfy it: a stored `AnalyticsRecord` (which still carries
 * `stageTimeline` and the omitted fields) and a `DashboardRecord` (which
 * carries `stageHistoryCount` instead). Keeping the two history fields optional
 * here is what lets one implementation of every metric serve both callers, so
 * no metric is ever re-derived for the compact shape.
 */
export type MetricRecord =
  Omit<AnalyticsRecord, (typeof DASHBOARD_OMITTED_FIELDS)[number] | "stageTimeline">
  & { stageHistoryCount?: number; stageTimeline?: AnalyticsRecord["stageTimeline"] };
