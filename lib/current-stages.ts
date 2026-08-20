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

export function reconcileCurrentStages(live: CurrentStageRecord[], cached: AnalyticsRecord[], fetchedAt = new Date().toISOString()): StageReconciliation {
  const liveById = new Map(live.map((row) => [row.dealId, row]));
  const cachedById = new Map(cached.map((row) => [row.dealId, row]));
  const missingDealIds = [...liveById.keys()].filter((id) => !cachedById.has(id));
  const staleDealIds = [...cachedById.keys()].filter((id) => !liveById.has(id));
  const stageMismatchCount = [...liveById].filter(([id, row]) => cachedById.has(id) && cachedById.get(id)?.stageId !== row.stageId).length;
  return {
    liveCount: live.length,
    cachedCount: cached.length,
    missingCount: missingDealIds.length,
    staleCount: staleDealIds.length,
    stageMismatchCount,
    missingDealIds: missingDealIds.slice(0, 200),
    staleDealIds: staleDealIds.slice(0, 200),
    fetchedAt,
  };
}
