import { calculateBusinessMinutes, getSlaStart, isInsideWorkingTime } from "./business-time";
import { classifyLossReasonGroup, classifySalesStatus, fieldDisplayValue, isPaymentStage, isQualificationStage } from "./sales-logic";
import type { SalesSnapshot } from "./storage";
import type { AnalyticsRecord, CallOutcome, DashboardSettings, ProviderDiagnostic, SalesManagerAttribution } from "./types";

export type RawDeal = Record<string, unknown>;
export type RawActivity = Record<string, unknown>;
export type RawCallStat = Record<string, unknown>;
export type RawStageHistory = Record<string, unknown>;

function string(value: unknown) { return value === null || value === undefined ? "" : String(value); }
function timestamp(value: unknown) { const date = new Date(string(value)); return Number.isFinite(date.getTime()) ? date : null; }
function managerName(id: string, users: Map<string, string>) { return users.get(id) ?? (id ? `Menejer #${id}` : "Aniqlanmagan"); }
function employeeId(raw: unknown) { const value = Array.isArray(raw) ? raw[0] : raw; return string(value).match(/(?:user_)?(\d+)/i)?.[1] ?? ""; }

export function activityProviderKey(activity: RawActivity) {
  return [activity.PROVIDER_ID, activity.PROVIDER_TYPE_ID, activity.TYPE_ID, activity.DIRECTION].map(string).join("|");
}

export function isOutgoingCall(activity: RawActivity, providerRules: Record<string, string> = {}) {
  const rule = providerRules[activityProviderKey(activity)];
  if (rule === "IGNORE") return false;
  if (rule === "USE") return true;
  const provider = `${string(activity.PROVIDER_ID)} ${string(activity.PROVIDER_TYPE_ID)}`.toUpperCase();
  return string(activity.DIRECTION) === "2" && (string(activity.TYPE_ID) === "2" || /CALL|VOXIMPLANT|TELEPHON/.test(provider));
}

export function discoverProviders(activities: RawActivity[]): ProviderDiagnostic[] {
  const map = new Map<string, ProviderDiagnostic>();
  for (const activity of activities) {
    const direction = string(activity.DIRECTION); const typeId = string(activity.TYPE_ID);
    const providerId = string(activity.PROVIDER_ID); const providerTypeId = string(activity.PROVIDER_TYPE_ID);
    if (!direction && !providerId && typeId !== "2") continue;
    const key = activityProviderKey(activity); const current = map.get(key);
    if (current) current.count += 1;
    else map.set(key, { key, providerId: providerId || "—", providerTypeId: providerTypeId || "—", typeId: typeId || "—", direction: direction || "—", count: 1, sampleSubject: string(activity.SUBJECT).slice(0, 100) || "—", mode: "AUTO" });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function activityDealIds(activity: RawActivity) {
  const ids = new Set<string>(); const bindings = Array.isArray(activity.BINDINGS) ? activity.BINDINGS : [];
  for (const raw of bindings) {
    const binding = raw as Record<string, unknown>; const type = string(binding.OWNER_TYPE_ID ?? binding.ENTITY_TYPE_ID); const id = string(binding.OWNER_ID ?? binding.ENTITY_ID);
    if (type === "2" && id) ids.add(id);
  }
  if (string(activity.OWNER_TYPE_ID) === "2" && activity.OWNER_ID) ids.add(string(activity.OWNER_ID));
  return [...ids];
}

export function normalizeCallOutcome(codeValue: unknown): CallOutcome {
  const code = string(codeValue).toUpperCase();
  if (code === "200") return "Ko‘tardi"; if (code === "304") return "Ko‘tarmadi"; if (code === "486") return "Band";
  if (code === "603") return "Rad etdi"; if (code === "603-S") return "Bekor qilindi"; if (code === "404") return "Noto‘g‘ri raqam";
  if (["480", "484", "503", "403", "402"].includes(code)) return "Ulanmadi"; if (code === "423") return "Bloklangan";
  return "Noma’lum";
}

function callOutcome(activity: RawActivity, stat?: RawCallStat) {
  let outcome = normalizeCallOutcome(stat?.CALL_FAILED_CODE ?? activity.RESULT_STATUS ?? activity.RESULT_VALUE); let inferred = false;
  const duration = Number(stat?.CALL_DURATION ?? 0);
  if (outcome === "Noma’lum" && duration > 0) { outcome = "Ko‘tardi"; inferred = true; }
  return { outcome, inferred, duration: Number.isFinite(duration) ? duration : 0 };
}

function orderedHistory(histories: RawStageHistory[]) {
  return histories.filter((row) => timestamp(row.CREATED_TIME)).sort((a, b) => timestamp(a.CREATED_TIME)!.getTime() - timestamp(b.CREATED_TIME)!.getTime());
}

function firstStageChange(deal: RawDeal, histories: RawStageHistory[]) {
  const createdAt = timestamp(deal.DATE_CREATE); if (!createdAt) return null;
  const unique: RawStageHistory[] = [];
  for (const row of orderedHistory(histories)) if (!unique.length || string(unique.at(-1)?.STAGE_ID) !== string(row.STAGE_ID)) unique.push(row);
  if (!unique.length) return null;
  const firstAt = timestamp(unique[0].CREATED_TIME)!; const candidate = Math.abs(firstAt.getTime() - createdAt.getTime()) <= 120_000 ? unique[1] : unique[0];
  const at = candidate ? timestamp(candidate.CREATED_TIME) : null;
  return at && at > createdAt ? { at, stageId: string(candidate?.STAGE_ID) } : null;
}

function stageName(id: string, stages: Map<string, string>) { return stages.get(id) ?? (id || "Aniqlanmagan"); }

function buildStageTimeline(input: {
  histories: RawStageHistory[];
  currentCategoryId: string;
  currentStageId: string;
  currentStageEnteredAt: Date;
  createdAt: Date;
  terminalAt: Date | null;
  pipelines: Map<string, string>;
  stages: Map<string, string>;
}) {
  const events: { categoryId: string; stageId: string; enteredAt: Date }[] = [];
  for (const row of input.histories) {
    const enteredAt = timestamp(row.CREATED_TIME); const stageId = string(row.STAGE_ID);
    if (!enteredAt || !stageId) continue;
    const categoryId = string(row.CATEGORY_ID || input.currentCategoryId);
    const previous = events.at(-1);
    if (previous?.stageId === stageId && previous.categoryId === categoryId) continue;
    events.push({ categoryId, stageId, enteredAt });
  }
  if (!events.length) events.push({ categoryId: input.currentCategoryId, stageId: input.currentStageId, enteredAt: input.currentStageEnteredAt ?? input.createdAt });
  else if (events.at(-1)?.stageId !== input.currentStageId || events.at(-1)?.categoryId !== input.currentCategoryId) {
    events.push({ categoryId: input.currentCategoryId, stageId: input.currentStageId, enteredAt: input.currentStageEnteredAt });
  }
  const finalAt = input.terminalAt && input.terminalAt > events.at(-1)!.enteredAt ? input.terminalAt : new Date();
  return events.map((event, index) => {
    const next = events[index + 1]; const exitedAt = next?.enteredAt ?? (input.terminalAt ? finalAt : null);
    const durationEnd = exitedAt ?? new Date();
    return {
      categoryId: event.categoryId,
      pipeline: input.pipelines.get(event.categoryId) ?? `Pipeline #${event.categoryId}`,
      stageId: event.stageId,
      stage: stageName(event.stageId, input.stages),
      enteredAt: event.enteredAt.toISOString(),
      exitedAt: exitedAt?.toISOString() ?? null,
      durationHours: Math.max(0, (durationEnd.getTime() - event.enteredAt.getTime()) / 3_600_000),
    };
  });
}

export function buildAnalyticsRecords(input: {
  deals: RawDeal[]; activities: RawActivity[]; stageHistories: RawStageHistory[]; callStats: RawCallStat[];
  settings: DashboardSettings; providerRules: Record<string, string>; users: Map<string, string>;
  pipelines: Map<string, string>; stages: Map<string, string>; sources: Map<string, string>; fieldOptions?: Map<string, Map<string, string>>;
  snapshots?: Map<string, SalesSnapshot>; domain: string | null; activitiesAvailable: boolean; stageHistoryAvailable: boolean;
}) {
  const activitiesByDeal = new Map<string, RawActivity[]>();
  for (const activity of input.activities) for (const dealId of activityDealIds(activity)) activitiesByDeal.set(dealId, [...(activitiesByDeal.get(dealId) ?? []), activity]);
  const historiesByDeal = new Map<string, RawStageHistory[]>();
  for (const history of input.stageHistories) { const id = string(history.OWNER_ID); if (id) historiesByDeal.set(id, [...(historiesByDeal.get(id) ?? []), history]); }
  const statsByActivity = new Map<string, RawCallStat>();
  for (const stat of input.callStats) { const id = string(stat.CRM_ACTIVITY_ID); if (id) statsByActivity.set(id, stat); }
  const mainIds = new Set(input.settings.selectedPipelineIds); const postSaleIds = new Set(input.settings.postSalePipelineIds);
  const fieldOptions = input.fieldOptions ?? new Map<string, Map<string, string>>(); const snapshots = input.snapshots ?? new Map<string, SalesSnapshot>();

  return input.deals.flatMap((deal): AnalyticsRecord[] => {
    const dealId = string(deal.ID); const created = timestamp(deal.DATE_CREATE); if (!dealId || !created) return [];
    const histories = orderedHistory(historiesByDeal.get(dealId) ?? []); const currentCategoryId = string(deal.CATEGORY_ID || "0"); const currentStageId = string(deal.STAGE_ID);
    const currentStage = stageName(currentStageId, input.stages);
    const firstMainHistory = histories.find((row) => mainIds.has(string(row.CATEGORY_ID)));
    const originCategoryId = string(firstMainHistory?.CATEGORY_ID) || (mainIds.has(currentCategoryId) ? currentCategoryId : string(histories.find((row) => !postSaleIds.has(string(row.CATEGORY_ID)))?.CATEGORY_ID)) || currentCategoryId;
    const paymentHistory = histories.find((row) => isPaymentStage(stageName(string(row.STAGE_ID), input.stages)));
    const postSaleHistory = histories.find((row) => postSaleIds.has(string(row.CATEGORY_ID)));
    // Sitting in the payment stage is itself proof of a sale. Deriving this from
    // stage history alone let a missing/denied history permission silently
    // demote a paid deal back to ACTIVE and under-count Sales.
    const currentStageIsPayment = isPaymentStage(currentStage);
    // MOVED_TIME is Bitrix's "moved to current stage" timestamp (its partner
    // field is MOVED_BY_ID), already trusted as current-stage entry by
    // stageEntered below and by buildCurrentStageRecords. While the current
    // stage IS the payment stage it is therefore real payment-entry evidence.
    // Nothing else is substituted: DATE_MODIFY is any edit and would fabricate
    // a revenue date, so a missing MOVED_TIME leaves wonAt null on purpose.
    const currentPaymentAt = currentStageIsPayment ? timestamp(deal.MOVED_TIME) : null;
    const wonEvent = paymentHistory ?? postSaleHistory;
    const wonAt = (wonEvent ? timestamp(wonEvent.CREATED_TIME) : null)?.toISOString() ?? currentPaymentAt?.toISOString() ?? null;
    const currentHistory = [...histories].reverse().find((row) => string(row.STAGE_ID) === currentStageId && (!row.CATEGORY_ID || string(row.CATEGORY_ID) === currentCategoryId));
    const baseSalesStatus = classifySalesStatus({ stage: currentStage, semantic: string(currentHistory?.STAGE_SEMANTIC_ID), paymentReached: Boolean(paymentHistory) || currentStageIsPayment, inPostSalePipeline: postSaleIds.has(currentCategoryId) || Boolean(postSaleHistory) });
    const stageEntered = timestamp(currentHistory?.CREATED_TIME ?? deal.MOVED_TIME ?? deal.DATE_MODIFY) ?? created;
    const stageAgeHours = Math.max(0, (Date.now() - stageEntered.getTime()) / 3_600_000);
    const stageLimitHours = Number(input.settings.stageLimits[currentStageId] ?? input.settings.defaultStageLimitHours);
    const terminalAt = baseSalesStatus === "ACTIVE" ? null : timestamp(deal.CLOSEDATE ?? deal.DATE_MODIFY) ?? (wonAt ? new Date(wonAt) : null);
    const stageTimeline = buildStageTimeline({ histories, currentCategoryId, currentStageId, currentStageEnteredAt: stageEntered, createdAt: created, terminalAt, pipelines: input.pipelines, stages: input.stages });
    const qualifiedIds = new Set(input.settings.qualifiedStageIds);
    const qualifiedEvent = stageTimeline.find((entry) => mainIds.has(entry.categoryId) && (qualifiedIds.has(entry.stageId) || isQualificationStage(entry.stage)));
    const salesStatus = baseSalesStatus;
    // Not Relevant is always a marketing-quality rejection. A previous SQL-stage visit must
    // not silently reclassify it as a salesperson loss. Won and genuine closed-loss deals
    // are quality accepted even if incomplete history prevented us from seeing Обработка.
    const qualified = salesStatus === "LOW_QUALITY"
      ? false
      : Boolean(qualifiedEvent || salesStatus === "LOST" || salesStatus === "WON");
    const qualifiedFallback = qualified ? stageTimeline.filter((entry) => mainIds.has(entry.categoryId))[1] ?? stageTimeline.find((entry) => mainIds.has(entry.categoryId)) : null;
    const effectiveQualifiedEvent = qualified ? (qualifiedEvent ?? qualifiedFallback) : null;
    const qualifiedAt = effectiveQualifiedEvent?.enteredAt ?? null;

    const assignedManagerId = string(deal.ASSIGNED_BY_ID);
    const calls = (activitiesByDeal.get(dealId) ?? []).filter((row) => isOutgoingCall(row, input.providerRules)).filter((row) => { const at = timestamp(row.START_TIME ?? row.CREATED); return at && at >= created; }).sort((a, b) => timestamp(a.START_TIME ?? a.CREATED)!.getTime() - timestamp(b.START_TIME ?? b.CREATED)!.getTime());
    const firstCall = calls[0] ?? null; const firstCallAt = firstCall ? timestamp(firstCall.START_TIME ?? firstCall.CREATED) : null;
    const firstCallStat = firstCall ? statsByActivity.get(string(firstCall.ID)) : undefined;
    const firstOutcome = firstCall ? callOutcome(firstCall, firstCallStat) : { outcome: "Noma’lum" as CallOutcome, inferred: false, duration: 0 };
    const latestCall = calls.at(-1); const latestOutcome = latestCall ? callOutcome(latestCall, statsByActivity.get(string(latestCall.ID))).outcome : "Noma’lum";
    const successes = calls.flatMap((activity) => { const at = timestamp(activity.START_TIME ?? activity.CREATED); return at && callOutcome(activity, statsByActivity.get(string(activity.ID))).outcome === "Ko‘tardi" ? [{ at }] : []; });
    const stageChange = firstStageChange(deal, histories); const slaStart = getSlaStart(created, input.settings);
    const firstCallMinutes = firstCallAt ? calculateBusinessMinutes(slaStart, firstCallAt, input.settings) : null;
    const stageMinutes = stageChange ? calculateBusinessMinutes(slaStart, stageChange.at, input.settings) : null;
    const processingAt = firstCallAt ?? stageChange?.at ?? null; const processingMinutes = processingAt ? calculateBusinessMinutes(slaStart, processingAt, input.settings) : null;
    const processingSource = firstCallAt ? "OUTGOING_CALL" : stageChange ? "STAGE_CHANGE" : "NO_PROCESSING";
    const stageChangedBeforeCall = Boolean(stageChange && firstCallAt && stageChange.at < firstCallAt);

    const snapshot = snapshots.get(dealId); const customManagerId = input.settings.salesManagerField ? employeeId(deal[input.settings.salesManagerField]) : "";
    const firstCallManagerId = firstCall ? string(firstCall.RESPONSIBLE_ID) : ""; const moverId = string(deal.MOVED_BY_ID);
    let salesManagerId = snapshot?.managerId ?? ""; let salesManager = snapshot?.managerName ?? ""; let salesManagerAttribution = (snapshot?.attributionSource as SalesManagerAttribution | undefined) ?? "UNKNOWN";
    if (!snapshot && customManagerId) { salesManagerId = customManagerId; salesManagerAttribution = "CUSTOM_FIELD"; }
    else if (!snapshot && firstCallManagerId) { salesManagerId = firstCallManagerId; salesManagerAttribution = "FIRST_CALL"; }
    else if (!snapshot && moverId) { salesManagerId = moverId; salesManagerAttribution = "STAGE_MOVER"; }
    else if (!snapshot && assignedManagerId) { salesManagerId = assignedManagerId; salesManagerAttribution = "CURRENT_RESPONSIBLE"; }
    if (!salesManager && salesManagerId) salesManager = managerName(salesManagerId, input.users);

    const reasonField = input.settings.failureReasonField; const sourceField = input.settings.marketingChannelField;
    const lossReason = reasonField ? fieldDisplayValue(deal[reasonField], fieldOptions.get(reasonField)) : "";
    const customSource = sourceField ? fieldDisplayValue(deal[sourceField], fieldOptions.get(sourceField)) : "";
    const sourceId = customSource || string(deal.SOURCE_ID); const source = customSource || input.sources.get(sourceId) || sourceId || "Ko‘rsatilmagan";
    const opportunity = Number(deal.OPPORTUNITY ?? 0);
    const effectiveWonAt = snapshot?.wonAt ?? wonAt;
    const salesCycleHours = effectiveWonAt ? Math.max(0, (new Date(effectiveWonAt).getTime() - created.getTime()) / 3_600_000) : null;
    const contactId = string(deal.CONTACT_ID) || (Array.isArray(deal.CONTACT_IDS) ? string(deal.CONTACT_IDS[0]) : "");
    const companyId = string(deal.COMPANY_ID);
    const effectiveLossReason = lossReason || ((salesStatus === "LOST" || salesStatus === "LOW_QUALITY") ? "Sabab ko‘rsatilmagan" : "");
    const lossReasonGroup = classifyLossReasonGroup({ status: salesStatus, reason: effectiveLossReason, routingPatterns: input.settings.routingReasonPatterns });

    return [{
      analyticsVersion: 3, dealId, title: string(deal.TITLE) || `Deal #${dealId}`, createdAt: created.toISOString(), creationPeriod: isInsideWorkingTime(created, input.settings) ? "WORK_HOURS" : "AFTER_HOURS", slaStart: slaStart.toISOString(),
      assignedManagerId, assignedManager: managerName(assignedManagerId, input.users), categoryId: currentCategoryId, pipeline: input.pipelines.get(currentCategoryId) ?? `Pipeline #${currentCategoryId}`,
      originCategoryId, originPipeline: input.pipelines.get(originCategoryId) ?? `Pipeline #${originCategoryId}`, operationalPipeline: mainIds.has(currentCategoryId),
      stageId: currentStageId, stage: currentStage, stageEnteredAt: stageEntered.toISOString(), stageAgeHours, stageLimitHours, stageOverdue: salesStatus === "ACTIVE" && stageAgeHours > stageLimitHours,
      sourceId, source, salesStatus, qualified, qualifiedAt, qualifiedStageId: effectiveQualifiedEvent?.stageId ?? null, qualifiedStage: effectiveQualifiedEvent?.stage ?? null,
      wonAt: effectiveWonAt, salesCycleHours, opportunity: Number.isFinite(opportunity) ? opportunity : 0, currencyId: string(deal.CURRENCY_ID), lossReason: effectiveLossReason, lossReasonGroup,
      contactId: contactId || null, companyId: companyId || null, customerKey: contactId ? `contact:${contactId}` : companyId ? `company:${companyId}` : null, duplicateOfDealId: null, stageTimeline,
      salesManagerId: salesManagerId || null, salesManager: salesManager || null, salesManagerAttribution,
      firstCallAt: firstCallAt?.toISOString() ?? null, firstCallActivityId: firstCall ? string(firstCall.ID) : null, firstCallManagerId: firstCallManagerId || null, firstCallManager: firstCallManagerId ? managerName(firstCallManagerId, input.users) : null,
      firstCallBusinessMinutes: firstCallMinutes, firstCallOutcome: firstOutcome.outcome, firstCallDuration: firstCall ? firstOutcome.duration : null, outcomeInferred: firstOutcome.inferred,
      firstSuccessfulCallAt: successes[0]?.at.toISOString() ?? null, firstSuccessfulCallBusinessMinutes: successes[0] ? calculateBusinessMinutes(slaStart, successes[0].at, input.settings) : null,
      firstStageChangeAt: stageChange?.at.toISOString() ?? null, firstStageChangeTo: stageChange ? stageName(stageChange.stageId, input.stages) : null, firstStageChangeBusinessMinutes: stageMinutes,
      stageChangedBeforeCall, stageAttributionInferred: Boolean(stageChange), processingSource, processingAt: processingAt?.toISOString() ?? null, processingBusinessMinutes: processingMinutes,
      slaStatus: processingMinutes === null ? "NO_PROCESSING" : processingMinutes <= input.settings.slaMinutes ? "ON_TIME" : "LATE",
      outgoingCallCount: calls.length, answeredCallCount: calls.filter((row) => callOutcome(row, statsByActivity.get(string(row.ID))).outcome === "Ko‘tardi").length,
      unansweredCallCount: calls.filter((row) => !["Ko‘tardi", "Noma’lum"].includes(callOutcome(row, statsByActivity.get(string(row.ID))).outcome)).length, latestCallOutcome: latestOutcome,
      dataUnavailable: (!input.activitiesAvailable || !input.stageHistoryAvailable) && !processingAt,
      bitrixUrl: input.domain ? `https://${input.domain}/crm/deal/details/${encodeURIComponent(dealId)}/` : null,
    }];
  });
}
