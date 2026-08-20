import { calculateBusinessMinutes, getSlaStart, isInsideWorkingTime } from "./business-time";
import type {
  AnalyticsRecord,
  CallOutcome,
  DashboardSettings,
  ProviderDiagnostic,
} from "./types";

export type RawDeal = Record<string, unknown>;
export type RawActivity = Record<string, unknown>;
export type RawCallStat = Record<string, unknown>;
export type RawStageHistory = Record<string, unknown>;

function string(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function timestamp(value: unknown) {
  const date = new Date(string(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function activityProviderKey(activity: RawActivity) {
  return [activity.PROVIDER_ID, activity.PROVIDER_TYPE_ID, activity.TYPE_ID, activity.DIRECTION]
    .map(string)
    .join("|");
}

export function isOutgoingCall(
  activity: RawActivity,
  providerRules: Record<string, string> = {},
) {
  const key = activityProviderKey(activity);
  const rule = providerRules[key];
  if (rule === "IGNORE") return false;
  if (rule === "USE") return true;
  const direction = string(activity.DIRECTION);
  const typeId = string(activity.TYPE_ID);
  const provider = `${string(activity.PROVIDER_ID)} ${string(activity.PROVIDER_TYPE_ID)}`.toUpperCase();
  return direction === "2" && (typeId === "2" || /CALL|VOXIMPLANT|TELEPHON/.test(provider));
}

export function discoverProviders(activities: RawActivity[]): ProviderDiagnostic[] {
  const map = new Map<string, ProviderDiagnostic>();
  for (const activity of activities) {
    const direction = string(activity.DIRECTION);
    const typeId = string(activity.TYPE_ID);
    const providerId = string(activity.PROVIDER_ID);
    const providerTypeId = string(activity.PROVIDER_TYPE_ID);
    if (!direction && !providerId && typeId !== "2") continue;
    const key = activityProviderKey(activity);
    const current = map.get(key);
    if (current) current.count += 1;
    else {
      map.set(key, {
        key,
        providerId: providerId || "—",
        providerTypeId: providerTypeId || "—",
        typeId: typeId || "—",
        direction: direction || "—",
        count: 1,
        sampleSubject: string(activity.SUBJECT).slice(0, 100) || "—",
        mode: "AUTO",
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function activityDealIds(activity: RawActivity) {
  const ids = new Set<string>();
  const bindings = Array.isArray(activity.BINDINGS) ? activity.BINDINGS : [];
  for (const rawBinding of bindings) {
    const binding = rawBinding as Record<string, unknown>;
    const type = string(binding.OWNER_TYPE_ID ?? binding.ENTITY_TYPE_ID);
    const id = string(binding.OWNER_ID ?? binding.ENTITY_ID);
    if (type === "2" && id) ids.add(id);
  }
  if (string(activity.OWNER_TYPE_ID) === "2" && activity.OWNER_ID) ids.add(string(activity.OWNER_ID));
  return [...ids];
}

export function normalizeCallOutcome(codeValue: unknown): CallOutcome {
  const code = string(codeValue).toUpperCase();
  if (code === "200") return "Ko‘tardi";
  if (code === "304") return "Ko‘tarmadi";
  if (code === "486") return "Band";
  if (code === "603") return "Rad etdi";
  if (code === "603-S") return "Bekor qilindi";
  if (code === "404") return "Noto‘g‘ri raqam";
  if (["480", "484", "503", "403", "402"].includes(code)) return "Ulanmadi";
  if (code === "423") return "Bloklangan";
  return "Noma’lum";
}

function callOutcome(activity: RawActivity, stat?: RawCallStat) {
  const code = stat?.CALL_FAILED_CODE ?? activity.RESULT_STATUS ?? activity.RESULT_VALUE;
  let outcome = normalizeCallOutcome(code);
  let inferred = false;
  const duration = Number(stat?.CALL_DURATION ?? 0);
  if (outcome === "Noma’lum" && duration > 0) {
    outcome = "Ko‘tardi";
    inferred = true;
  }
  return { outcome, inferred, duration: Number.isFinite(duration) ? duration : 0 };
}

function managerName(id: string, users: Map<string, string>) {
  return users.get(id) ?? (id ? `Menejer #${id}` : "Aniqlanmagan");
}

function firstStageChange(
  deal: RawDeal,
  histories: RawStageHistory[],
) {
  const createdAt = timestamp(deal.DATE_CREATE);
  if (!createdAt) return null;
  const ordered = histories
    .filter((row) => timestamp(row.CREATED_TIME))
    .sort((a, b) => timestamp(a.CREATED_TIME)!.getTime() - timestamp(b.CREATED_TIME)!.getTime());
  const unique: RawStageHistory[] = [];
  for (const row of ordered) {
    if (!unique.length || string(unique.at(-1)?.STAGE_ID) !== string(row.STAGE_ID)) unique.push(row);
  }
  if (!unique.length) return null;
  const firstAt = timestamp(unique[0].CREATED_TIME)!;
  const initialLooksLikeCreation = Math.abs(firstAt.getTime() - createdAt.getTime()) <= 120_000;
  const candidate = initialLooksLikeCreation ? unique[1] : unique[0];
  if (!candidate) return null;
  const at = timestamp(candidate.CREATED_TIME);
  return at && at > createdAt ? { at, stageId: string(candidate.STAGE_ID) } : null;
}

export function buildAnalyticsRecords(input: {
  deals: RawDeal[];
  activities: RawActivity[];
  stageHistories: RawStageHistory[];
  callStats: RawCallStat[];
  settings: DashboardSettings;
  providerRules: Record<string, string>;
  users: Map<string, string>;
  pipelines: Map<string, string>;
  stages: Map<string, string>;
  sources: Map<string, string>;
  domain: string | null;
  activitiesAvailable: boolean;
  stageHistoryAvailable: boolean;
}) {
  const activitiesByDeal = new Map<string, RawActivity[]>();
  for (const activity of input.activities) {
    for (const dealId of activityDealIds(activity)) {
      const rows = activitiesByDeal.get(dealId) ?? [];
      rows.push(activity);
      activitiesByDeal.set(dealId, rows);
    }
  }

  const historiesByDeal = new Map<string, RawStageHistory[]>();
  for (const history of input.stageHistories) {
    const dealId = string(history.OWNER_ID);
    if (!dealId) continue;
    const rows = historiesByDeal.get(dealId) ?? [];
    rows.push(history);
    historiesByDeal.set(dealId, rows);
  }

  const statsByActivity = new Map<string, RawCallStat>();
  for (const stat of input.callStats) {
    const activityId = string(stat.CRM_ACTIVITY_ID);
    if (activityId) statsByActivity.set(activityId, stat);
  }

  return input.deals.flatMap((deal): AnalyticsRecord[] => {
    const dealId = string(deal.ID);
    const created = timestamp(deal.DATE_CREATE);
    if (!dealId || !created) return [];
    const assignedManagerId = string(deal.ASSIGNED_BY_ID);
    const calls = (activitiesByDeal.get(dealId) ?? [])
      .filter((activity) => isOutgoingCall(activity, input.providerRules))
      .filter((activity) => {
        const at = timestamp(activity.START_TIME ?? activity.CREATED);
        return at && at >= created;
      })
      .sort((a, b) => timestamp(a.START_TIME ?? a.CREATED)!.getTime() - timestamp(b.START_TIME ?? b.CREATED)!.getTime());

    const firstCall = calls[0] ?? null;
    const firstCallAt = firstCall ? timestamp(firstCall.START_TIME ?? firstCall.CREATED) : null;
    const firstCallStat = firstCall ? statsByActivity.get(string(firstCall.ID)) : undefined;
    const firstOutcome = firstCall ? callOutcome(firstCall, firstCallStat) : { outcome: "Noma’lum" as CallOutcome, inferred: false, duration: 0 };
    const latestCall = calls.at(-1);
    const latestOutcome = latestCall
      ? callOutcome(latestCall, statsByActivity.get(string(latestCall.ID))).outcome
      : "Noma’lum";

    const successfulCalls = calls.flatMap((activity) => {
      const at = timestamp(activity.START_TIME ?? activity.CREATED);
      const outcome = callOutcome(activity, statsByActivity.get(string(activity.ID))).outcome;
      return at && outcome === "Ko‘tardi" ? [{ at, activity }] : [];
    });
    const firstSuccess = successfulCalls[0] ?? null;
    const outcomes = calls.map((activity) => callOutcome(activity, statsByActivity.get(string(activity.ID))).outcome);
    const stageChange = firstStageChange(deal, historiesByDeal.get(dealId) ?? []);
    const slaStart = getSlaStart(created, input.settings);
    const firstCallMinutes = firstCallAt
      ? calculateBusinessMinutes(slaStart, firstCallAt, input.settings)
      : null;
    const stageMinutes = stageChange
      ? calculateBusinessMinutes(slaStart, stageChange.at, input.settings)
      : null;
    const processingAt = firstCallAt ?? stageChange?.at ?? null;
    const processingMinutes = processingAt
      ? calculateBusinessMinutes(slaStart, processingAt, input.settings)
      : null;
    const processingSource = firstCallAt
      ? "OUTGOING_CALL"
      : stageChange
        ? "STAGE_CHANGE"
        : "NO_PROCESSING";
    const stageChangedBeforeCall = Boolean(stageChange && firstCallAt && stageChange.at < firstCallAt);
    const categoryId = string(deal.CATEGORY_ID || "0");
    const stageId = string(deal.STAGE_ID);
    const sourceId = string(deal.SOURCE_ID);

    return [{
      dealId,
      title: string(deal.TITLE) || `Deal #${dealId}`,
      createdAt: created.toISOString(),
      creationPeriod: isInsideWorkingTime(created, input.settings) ? "WORK_HOURS" : "AFTER_HOURS",
      slaStart: slaStart.toISOString(),
      assignedManagerId,
      assignedManager: managerName(assignedManagerId, input.users),
      categoryId,
      pipeline: input.pipelines.get(categoryId) ?? `Pipeline #${categoryId}`,
      stageId,
      stage: input.stages.get(stageId) ?? (stageId || "Aniqlanmagan"),
      sourceId,
      source: input.sources.get(sourceId) ?? (sourceId || "Ko‘rsatilmagan"),
      firstCallAt: firstCallAt?.toISOString() ?? null,
      firstCallActivityId: firstCall ? string(firstCall.ID) : null,
      firstCallManagerId: firstCall ? string(firstCall.RESPONSIBLE_ID) : null,
      firstCallManager: firstCall ? managerName(string(firstCall.RESPONSIBLE_ID), input.users) : null,
      firstCallBusinessMinutes: firstCallMinutes,
      firstCallOutcome: firstOutcome.outcome,
      firstCallDuration: firstCall ? firstOutcome.duration : null,
      outcomeInferred: firstOutcome.inferred,
      firstSuccessfulCallAt: firstSuccess?.at.toISOString() ?? null,
      firstSuccessfulCallBusinessMinutes: firstSuccess
        ? calculateBusinessMinutes(slaStart, firstSuccess.at, input.settings)
        : null,
      firstStageChangeAt: stageChange?.at.toISOString() ?? null,
      firstStageChangeTo: stageChange ? input.stages.get(stageChange.stageId) ?? stageChange.stageId : null,
      firstStageChangeBusinessMinutes: stageMinutes,
      stageChangedBeforeCall,
      stageAttributionInferred: Boolean(stageChange),
      processingSource,
      processingAt: processingAt?.toISOString() ?? null,
      processingBusinessMinutes: processingMinutes,
      slaStatus: processingMinutes === null
        ? "NO_PROCESSING"
        : processingMinutes <= input.settings.slaMinutes
          ? "ON_TIME"
          : "LATE",
      outgoingCallCount: calls.length,
      answeredCallCount: outcomes.filter((value) => value === "Ko‘tardi").length,
      unansweredCallCount: outcomes.filter((value) => value !== "Ko‘tardi" && value !== "Noma’lum").length,
      latestCallOutcome: latestOutcome,
      dataUnavailable: (!input.activitiesAvailable || !input.stageHistoryAvailable) && !processingAt,
      bitrixUrl: input.domain ? `https://${input.domain}/crm/deal/details/${encodeURIComponent(dealId)}/` : null,
    }];
  });
}
