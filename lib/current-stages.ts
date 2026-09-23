import { countsAsOperational } from "./stale-resolution";
import { isClosedLostStage, isLowQualityStage, isPaymentStage } from "./sales-logic";
import { resolveSyncWindow } from "./sync-window";
import type { AnalyticsRecord, CurrentStageRecord, DashboardSettings, StageReconciliation } from "./types";

export type RawCurrentStageDeal = Record<string, unknown>;

/** Why a live Deal is not part of the workload. Reported, never hidden. */
export type CurrentStageExclusion = "OTHER_CATEGORY" | "NOT_RELEVANT" | "SALES_LOST" | "WON" | "DUPLICATE";

export const CURRENT_STAGE_EXCLUSION_LABELS: Record<CurrentStageExclusion, string> = {
  OTHER_CATEGORY: "Boshqa funnel",
  NOT_RELEVANT: "Not Relevant",
  SALES_LOST: "Sotilmadi",
  WON: "Sotilgan / to‘lov",
  DUPLICATE: "Takroriy ID",
};

function shown(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function validDate(...values: unknown[]) {
  for (const value of values) {
    const date = new Date(shown(value));
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date(0);
}

/**
 * The canonical live workload population.
 *
 * `CLOSED = N` is not enough: Bitrix keeps a Not Relevant or a closed-lost card
 * non-closed in some configurations, and a paid card can sit in the payment
 * stage before it moves on. A Deal belongs to the live workload only while it is
 * in a selected Sales funnel AND its current stage is still work — not Not
 * Relevant, not closed-lost, not payment. Everything excluded is counted and
 * reported rather than silently dropped, and each Deal ID appears once.
 */
export function buildCurrentStageRecords(input: {
  deals: RawCurrentStageDeal[];
  settings: DashboardSettings;
  pipelines: Map<string, string>;
  stages: Map<string, string>;
  users: Map<string, string>;
  sources?: Map<string, string>;
  domain: string | null;
  now?: Date;
  /** Receives why each Deal was left out, for the Stage Control reconciliation. */
  onExcluded?: (reason: CurrentStageExclusion, dealId: string) => void;
}): CurrentStageRecord[] {
  const now = input.now ?? new Date();
  const semantics = {
    lowQualityStageIds: input.settings.lowQualityStageIds, paymentStageIds: input.settings.paymentStageIds,
    closedLostStageIds: input.settings.closedLostStageIds, qualifiedStageIds: input.settings.qualifiedStageIds,
  };
  const salesCategories = new Set(input.settings.selectedPipelineIds.map(String));
  const seen = new Set<string>();
  return input.deals.flatMap((deal) => {
    const dealId = shown(deal.ID); const categoryId = shown(deal.CATEGORY_ID || "0"); const stageId = shown(deal.STAGE_ID);
    if (!dealId || !stageId) return [];
    if (seen.has(dealId)) { input.onExcluded?.("DUPLICATE", dealId); return []; }
    seen.add(dealId);
    if (salesCategories.size && !salesCategories.has(categoryId)) { input.onExcluded?.("OTHER_CATEGORY", dealId); return []; }
    const stageName = input.stages.get(`${categoryId}:${stageId}`) ?? input.stages.get(stageId) ?? stageId;
    if (isLowQualityStage(stageName, stageId, semantics)) { input.onExcluded?.("NOT_RELEVANT", dealId); return []; }
    if (isClosedLostStage(stageName, shown(deal.STAGE_SEMANTIC_ID), stageId, semantics)) { input.onExcluded?.("SALES_LOST", dealId); return []; }
    if (isPaymentStage(stageName, stageId, semantics)) { input.onExcluded?.("WON", dealId); return []; }
    const createdAt = validDate(deal.DATE_CREATE, deal.DATE_MODIFY);
    const stageEnteredAt = validDate(deal.MOVED_TIME, deal.DATE_MODIFY, deal.DATE_CREATE);
    const assignedManagerId = shown(deal.ASSIGNED_BY_ID);
    const stageLimitHours = Number(input.settings.stageLimits[stageId] ?? input.settings.defaultStageLimitHours);
    const stageAgeHours = Math.max(0, (now.getTime() - stageEnteredAt.getTime()) / 3_600_000);
    return [{
      dealId,
      title: shown(deal.TITLE) || `Deal #${dealId}`,
      createdAt: createdAt.toISOString(),
      assignedManagerId,
      assignedManager: input.users.get(assignedManagerId) ?? (assignedManagerId ? `Menejer #${assignedManagerId}` : "Aniqlanmagan"),
      categoryId,
      pipeline: input.pipelines.get(categoryId) ?? `Pipeline #${categoryId}`,
      stageId,
      stage: stageName,
      // Canonical Source: SOURCE_ID through the live SOURCE dictionary, the same
      // value every other Sales view groups by, so the Source filter really
      // filters this list instead of quietly applying somewhere else.
      sourceId: shown(deal.SOURCE_ID),
      source: input.sources?.get(shown(deal.SOURCE_ID)) || shown(deal.SOURCE_ID) || "Aniqlanmagan",
      stageEnteredAt: stageEnteredAt.toISOString(),
      stageAgeHours,
      stageLimitHours,
      stageOverdue: stageAgeHours > stageLimitHours,
      bitrixUrl: input.domain ? `https://${input.domain}/crm/deal/details/${encodeURIComponent(dealId)}/` : null,
    }];
  }).sort((a, b) => a.stage.localeCompare(b.stage) || a.assignedManager.localeCompare(b.assignedManager) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Whether the cache still believes this deal is operationally open.
 * Mirrors the client's `hydrateRecord` default so records written before
 * `salesStatus` existed are treated as open rather than silently dropped.
 */
/**
 * Open *and still somewhere the sync can see*.
 *
 * A deal that moved to a category outside the selected sales and paired
 * post-sale funnels can never be returned by the incremental query again, so
 * reporting it as "stale" every run is noise, not a finding — it is a resolved
 * fact recorded on the record itself.
 */
function cachedIsOpen(row: AnalyticsRecord) {
  return (row.salesStatus ?? "ACTIVE") === "ACTIVE" && countsAsOperational(row.currentScope);
}

/**
 * Reconciles the live Bitrix open-deal snapshot against the analytics cache.
 *
 * It answers one question only: does the cache contain this currently open
 * Bitrix deal id, and does its cached stage still match? Sales classification
 * must never decide cache membership — a deal that reached payment but is
 * still `CLOSED=N` is legitimately live AND legitimately cached as WON.
 *
 * Two deliberately different populations are used:
 *  - membership (missing / stage mismatch): every cached record whose *current*
 *    category is one of the selected Sales funnels, whatever its sales status;
 *  - staleness: only the subset the cache still considers open, because "stale"
 *    means the cache thinks a deal is open while Bitrix no longer does.
 *
 * `operationalCategoryIds` scopes the cache to the selected Sales funnels, which
 * also keeps post-sale/support and unrelated funnels out of both populations.
 * Passing none leaves an already-scoped cache untouched.
 */
export function reconcileCurrentStages(
  live: CurrentStageRecord[],
  cached: AnalyticsRecord[],
  fetchedAt = new Date().toISOString(),
  options: { operationalCategoryIds?: string[]; historyDays?: number; now?: Date } = {},
): StageReconciliation {
  const operationalIds = new Set((options.operationalCategoryIds ?? []).map(String).filter(Boolean));
  const scoped = operationalIds.size ? cached.filter((row) => operationalIds.has(String(row.categoryId))) : cached;
  const liveById = new Map(live.map((row) => [row.dealId, row]));
  const cachedById = new Map(scoped.map((row) => [row.dealId, row]));
  const missingDealIds = [...liveById.keys()].filter((id) => !cachedById.has(id));
  const staleDealIds = scoped.filter((row) => cachedIsOpen(row) && !liveById.has(row.dealId)).map((row) => row.dealId);
  const stageMismatchDealIds = [...liveById]
    .filter(([id, row]) => cachedById.has(id) && cachedById.get(id)?.stageId !== row.stageId)
    .map(([id]) => id);

  // Split the missing ids by the sync's own bootstrap window rather than a
  // second date interpretation. A deal created before it was never a candidate
  // for import, so its absence is expected rather than a cache failure.
  const historyFrom = options.historyDays === undefined
    ? null
    : resolveSyncWindow({
      lastSuccessfulSyncAt: null,
      now: options.now ?? new Date(fetchedAt),
      bootstrapDays: options.historyDays,
      full: true,
    }).from;
  const olderThanHistory: string[] = [];
  const withinHistory: string[] = [];
  for (const id of missingDealIds) {
    if (!historyFrom) { withinHistory.push(id); continue; }
    const created = Date.parse(liveById.get(id)?.createdAt ?? "");
    (Number.isFinite(created) && created < historyFrom.getTime() ? olderThanHistory : withinHistory).push(id);
  }

  return {
    liveCount: live.length,
    cachedCount: scoped.length,
    matchedCount: live.length - missingDealIds.length,
    missingCount: missingDealIds.length,
    missingOlderThanHistoryCount: olderThanHistory.length,
    missingWithinHistoryCount: withinHistory.length,
    missingOlderThanHistoryDealIds: olderThanHistory.slice(0, 200),
    missingWithinHistoryDealIds: withinHistory.slice(0, 200),
    historyFrom: historyFrom ? historyFrom.toISOString() : null,
    historyDays: options.historyDays ?? null,
    staleCount: staleDealIds.length,
    stageMismatchCount: stageMismatchDealIds.length,
    missingDealIds: missingDealIds.slice(0, 200),
    staleDealIds: staleDealIds.slice(0, 200),
    stageMismatchDealIds: stageMismatchDealIds.slice(0, 200),
    fetchedAt,
  };
}
