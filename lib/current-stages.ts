import { countsAsOperational } from "./stale-resolution";
import type { AnalyticsRecord, CurrentStageRecord, DashboardSettings, StageReconciliation } from "./types";

export type RawCurrentStageDeal = Record<string, unknown>;

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

export function buildCurrentStageRecords(input: {
  deals: RawCurrentStageDeal[];
  settings: DashboardSettings;
  pipelines: Map<string, string>;
  stages: Map<string, string>;
  users: Map<string, string>;
  domain: string | null;
  now?: Date;
}): CurrentStageRecord[] {
  const now = input.now ?? new Date();
  return input.deals.flatMap((deal) => {
    const dealId = shown(deal.ID); const categoryId = shown(deal.CATEGORY_ID || "0"); const stageId = shown(deal.STAGE_ID);
    if (!dealId || !stageId) return [];
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
      stage: input.stages.get(`${categoryId}:${stageId}`) ?? input.stages.get(stageId) ?? stageId,
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
  options: { operationalCategoryIds?: string[] } = {},
): StageReconciliation {
  const operationalIds = new Set((options.operationalCategoryIds ?? []).map(String).filter(Boolean));
  const scoped = operationalIds.size ? cached.filter((row) => operationalIds.has(String(row.categoryId))) : cached;
  const liveById = new Map(live.map((row) => [row.dealId, row]));
  const cachedById = new Map(scoped.map((row) => [row.dealId, row]));
  const missingDealIds = [...liveById.keys()].filter((id) => !cachedById.has(id));
  const staleDealIds = scoped.filter((row) => cachedIsOpen(row) && !liveById.has(row.dealId)).map((row) => row.dealId);
  const stageMismatchCount = [...liveById].filter(([id, row]) => cachedById.has(id) && cachedById.get(id)?.stageId !== row.stageId).length;
  return {
    liveCount: live.length,
    cachedCount: scoped.length,
    missingCount: missingDealIds.length,
    staleCount: staleDealIds.length,
    stageMismatchCount,
    missingDealIds: missingDealIds.slice(0, 200),
    staleDealIds: staleDealIds.slice(0, 200),
    fetchedAt,
  };
}
