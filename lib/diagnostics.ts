import { countDuplicates } from "./duplicates";
import { STAGE_SEMANTIC_GROUPS, stageIdList, type StageSemantics } from "./stage-config";
import type { AnalyticsRecord } from "./types";

/**
 * Data-quality and configuration-readiness diagnostics.
 *
 * These are measurements only. No helper here changes a record or feeds a
 * funnel metric: a deal counted as uncertain keeps its salesStatus, its cohort
 * membership and its manager attribution exactly as classified.
 */

/**
 * Sold, but with no trustworthy sale date. Sprint 3 deliberately allows this:
 * the sale is real (the current stage proves payment) while MOVED_TIME was
 * missing, so no revenue date could be derived without inventing one.
 * Counts in Cohort Sales; invisible to every wonAt-keyed period metric.
 */
export function isWonWithoutSaleDate(row: Pick<AnalyticsRecord, "salesStatus" | "wonAt">) {
  return row.salesStatus === "WON" && !row.wonAt;
}

/**
 * Seller recorded as Bitrix user id "0". Truthy as a string, so the attribution
 * chain currently treats it as resolved and it also blocks snapshot repair.
 * Surfaced for evidence only — the semantics are not approved for change.
 */
export function hasManagerIdZero(row: Pick<AnalyticsRecord, "salesManagerId">) {
  return row.salesManagerId === "0";
}

/** No seller at all — distinct from the resolved-but-suspicious "0" above. */
export function isMissingSalesManager(row: Pick<AnalyticsRecord, "salesManagerId">) {
  return !row.salesManagerId;
}

export function summarizeDataQuality(records: AnalyticsRecord[]) {
  const count = (predicate: (row: AnalyticsRecord) => boolean) => records.filter(predicate).length;
  return {
    wonWithoutSaleDate: count(isWonWithoutSaleDate),
    managerIdZero: count(hasManagerIdZero),
    missingSalesManager: count(isMissingSalesManager),
    unknownProcessingTime: count((row) => row.processingSource === "NO_PROCESSING_EVIDENCE"),
    missingStageHistory: count((row) => !row.stageTimeline.length),
    missingFailureReason: count((row) => ["LOW_QUALITY", "LOST"].includes(row.salesStatus) && row.lossReason === "Sabab ko‘rsatilmagan"),
    currentResponsibleFallback: count((row) => row.salesManagerAttribution === "CURRENT_RESPONSIBLE"),
    duplicateLeads: countDuplicates(records),
    dataUnavailable: count((row) => row.dataUnavailable),
  };
}

/**
 * How much of the Sprint 9 stage-ID hardening is actually configured.
 *
 * An empty group is NOT a data error — stage-name matching remains a valid
 * fallback — so this is readiness, not failure.
 */
export function stageConfigReadiness(config: StageSemantics) {
  const missing = STAGE_SEMANTIC_GROUPS.filter((group) => !stageIdList(config[group.key]).length);
  return {
    total: STAGE_SEMANTIC_GROUPS.length,
    configured: STAGE_SEMANTIC_GROUPS.length - missing.length,
    missing: missing.map((group) => group.label),
    complete: missing.length === 0,
  };
}
