import { calculateBusinessMinutes, getSlaStart, isInsideWorkingTime } from "./business-time";
import { resolveSlaState } from "./sla";
import { canInferQualificationFromOutcome, classifyLossReasonGroup, MISSING_LOSS_REASON, classifySalesStatus, fieldDisplayValue, isLowQualityStage, isPaymentStage, isSqlOrDownstreamStage } from "./sales-logic";
import { sqlThresholdsByCategory, type StageMeta, type StageSemantics } from "./stage-config";
import { canonicalDealFieldKey } from "./crm-fields";
import type { SalesSnapshot } from "./storage";
import type { AnalyticsRecord, DashboardSettings, ProcessingSource, SalesManagerAttribution } from "./types";

/**
 * Bumped whenever persisted AnalyticsRecord semantics change, so the stale-data
 * banner can tell a rebuilt record from one written by older logic.
 *
 * 5 — Sprint 15/16: SOURCE_ID-based source, per-funnel failure reason,
 *     downstream-stage qualification, qualification-based first processing and
 *     the removal of call-derived seller attribution.
 * 6 — Sprint 28.1: `qualified` is evidence-based, so a terminal LOST outcome no
 *     longer implies acceptance unless the history could not be observed;
 *     `qualifiedAt`/`qualifiedStage` come only from real qualification
 *     evidence; canonical Sales Lost is a strict subset of SQL and deals closed
 *     before SQL are a separate pre-SQL population. A version 5 record was
 *     written under the old rule and reports different SQL and Sotilmadi
 *     numbers until it is rebuilt.
 */
export const ANALYTICS_VERSION = 6;

export type RawDeal = Record<string, unknown>;
export type RawActivity = Record<string, unknown>;
export type RawCallStat = Record<string, unknown>;
export type RawStageHistory = Record<string, unknown>;

function string(value: unknown) { return value === null || value === undefined ? "" : String(value); }
function timestamp(value: unknown) { const date = new Date(string(value)); return Number.isFinite(date.getTime()) ? date : null; }
function managerName(id: string, users: Map<string, string>) { return users.get(id) ?? (id ? `Menejer #${id}` : "Aniqlanmagan"); }
function employeeId(raw: unknown) { const value = Array.isArray(raw) ? raw[0] : raw; return string(value).match(/(?:user_)?(\d+)/i)?.[1] ?? ""; }

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
  deals: RawDeal[]; stageHistories: RawStageHistory[];
  // Calls are no longer a dashboard data source. These stay optional so existing
  // callers keep compiling; nothing reads them.
  activities?: RawActivity[]; callStats?: RawCallStat[]; providerRules?: Record<string, string>;
  settings: DashboardSettings; users: Map<string, string>;
  pipelines: Map<string, string>; stages: Map<string, string>; sources: Map<string, string>; fieldOptions?: Map<string, Map<string, string>>;
  stageMeta?: Map<string, StageMeta>;
  snapshots?: Map<string, SalesSnapshot>; domain: string | null; activitiesAvailable?: boolean; stageHistoryAvailable: boolean;
}) {
  const historiesByDeal = new Map<string, RawStageHistory[]>();
  for (const history of input.stageHistories) { const id = string(history.OWNER_ID); if (id) historiesByDeal.set(id, [...(historiesByDeal.get(id) ?? []), history]); }
  const mainIds = new Set(input.settings.selectedPipelineIds); const postSaleIds = new Set(input.settings.postSalePipelineIds);
  const stageThresholds = sqlThresholdsByCategory(input.settings.qualifiedStageIds, input.stageMeta);
  const stageSemantics: StageSemantics = {
    lowQualityStageIds: input.settings.lowQualityStageIds, paymentStageIds: input.settings.paymentStageIds,
    closedLostStageIds: input.settings.closedLostStageIds, qualifiedStageIds: input.settings.qualifiedStageIds,
  };
  const fieldOptions = input.fieldOptions ?? new Map<string, Map<string, string>>(); const snapshots = input.snapshots ?? new Map<string, SalesSnapshot>();

  return input.deals.flatMap((deal): AnalyticsRecord[] => {
    const dealId = string(deal.ID); const created = timestamp(deal.DATE_CREATE); if (!dealId || !created) return [];
    const histories = orderedHistory(historiesByDeal.get(dealId) ?? []); const currentCategoryId = string(deal.CATEGORY_ID || "0"); const currentStageId = string(deal.STAGE_ID);
    const currentStage = stageName(currentStageId, input.stages);
    const firstMainHistory = histories.find((row) => mainIds.has(string(row.CATEGORY_ID)));
    const originCategoryId = string(firstMainHistory?.CATEGORY_ID) || (mainIds.has(currentCategoryId) ? currentCategoryId : string(histories.find((row) => !postSaleIds.has(string(row.CATEGORY_ID)))?.CATEGORY_ID)) || currentCategoryId;
    const paymentHistory = histories.find((row) => isPaymentStage(stageName(string(row.STAGE_ID), input.stages), string(row.STAGE_ID), stageSemantics));
    const postSaleHistory = histories.find((row) => postSaleIds.has(string(row.CATEGORY_ID)));
    // Sitting in the payment stage is itself proof of a sale. Deriving this from
    // stage history alone let a missing/denied history permission silently
    // demote a paid deal back to ACTIVE and under-count Sales.
    const currentStageIsPayment = isPaymentStage(currentStage, currentStageId, stageSemantics);
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
    const baseSalesStatus = classifySalesStatus({
      stage: currentStage, stageId: currentStageId, semantic: string(currentHistory?.STAGE_SEMANTIC_ID),
      paymentReached: Boolean(paymentHistory), currentStagePayment: currentStageIsPayment,
      inPostSalePipeline: postSaleIds.has(currentCategoryId) || Boolean(postSaleHistory), config: stageSemantics,
    });
    const stageEntered = timestamp(currentHistory?.CREATED_TIME ?? deal.MOVED_TIME ?? deal.DATE_MODIFY) ?? created;
    const stageAgeHours = Math.max(0, (Date.now() - stageEntered.getTime()) / 3_600_000);
    const stageLimitHours = Number(input.settings.stageLimits[currentStageId] ?? input.settings.defaultStageLimitHours);
    const terminalAt = baseSalesStatus === "ACTIVE" ? null : timestamp(deal.CLOSEDATE ?? deal.DATE_MODIFY) ?? (wonAt ? new Date(wonAt) : null);
    const stageTimeline = buildStageTimeline({ histories, currentCategoryId, currentStageId, currentStageEnteredAt: stageEntered, createdAt: created, terminalAt, pipelines: input.pipelines, stages: input.stages });
    const acceptsAsQualified = (stageId: string, name: string, categoryId: string, semantic = "") =>
      isSqlOrDownstreamStage({ stageId, stage: name, categoryId, semantic, thresholds: stageThresholds, stageMeta: input.stageMeta, config: stageSemantics });
    const qualifiedEvent = stageTimeline.find((entry) => mainIds.has(entry.categoryId) && acceptsAsQualified(entry.stageId, entry.stage, entry.categoryId));
    const salesStatus = baseSalesStatus;
    // Quality acceptance is evidence-based. Not Relevant is always a marketing
    // rejection, so a previous SQL visit must not reclassify it as a salesperson
    // loss. A sale proves acceptance on its own. A terminal LOST outcome does
    // NOT: it may only stand in for evidence when the qualification history
    // could not be observed at all. Read history showing the deal never reached
    // SQL is positive evidence against qualification, and upgrading it was
    // counting never-worked leads as SQL.
    const outcomeMayImplyQualification = canInferQualificationFromOutcome({
      stageHistoryAvailable: input.stageHistoryAvailable,
      historyRowCount: histories.length,
    });
    const qualified = salesStatus === "LOW_QUALITY"
      ? false
      : Boolean(qualifiedEvent)
        || salesStatus === "WON"
        || (salesStatus === "LOST" && outcomeMayImplyQualification);
    // Timing comes only from real qualification evidence. The old positional
    // fallback picked whatever stage happened to sit second in the timeline,
    // which dated qualification to Нет ответа or Сделка провалена.
    const effectiveQualifiedEvent = qualified ? qualifiedEvent ?? null : null;
    const qualifiedAt = effectiveQualifiedEvent?.enteredAt ?? null;

    const assignedManagerId = string(deal.ASSIGNED_BY_ID);
    const stageChange = firstStageChange(deal, histories); const slaStart = getSlaStart(created, input.settings);
    const stageMinutes = stageChange ? calculateBusinessMinutes(slaStart, stageChange.at, input.settings) : null;
    // First processing is the CRM-recorded result of the first real qualification
    // conversation: the deal entering SQL/Обработка or Not Relevant. Calls are
    // deliberately excluded — not every seller has a Bitrix-connected phone, so
    // call coverage is uneven and would bias manager and SLA comparisons.
    // Intermediate operational stages (No Answer, First Attempt, …) do not stop
    // the timer: only the two configured qualification outcomes do.
    // Quality acceptance can be proven by any downstream sales progression, so a
    // deal that skipped Обработка is processed at the moment it entered Встреча,
    // Согласие or Оплата. No Обработка event is fabricated.
    const isProcessingStage = (stageId: string, name: string, categoryId: string) =>
      acceptsAsQualified(stageId, name, categoryId) || isLowQualityStage(name, stageId, stageSemantics);
    const processingHistory = histories.find((row) => {
      const at = timestamp(row.CREATED_TIME); const stageId = string(row.STAGE_ID);
      const categoryId = string(row.CATEGORY_ID || currentCategoryId);
      return Boolean(at) && isProcessingStage(stageId, stageName(stageId, input.stages), categoryId);
    });
    // Without history we only trust MOVED_TIME, and only while the CURRENT stage
    // is itself a qualification outcome — then it is the exact entry time. For a
    // later stage the deal was clearly processed, but its first qualification
    // cannot be dated, so nothing is fabricated from DATE_MODIFY or creation.
    const currentStageIsProcessing = isProcessingStage(currentStageId, currentStage, currentCategoryId);
    const processingAt = (processingHistory ? timestamp(processingHistory.CREATED_TIME) : null)
      ?? (currentStageIsProcessing ? timestamp(deal.MOVED_TIME) : null);
    const processingMinutes = processingAt ? calculateBusinessMinutes(slaStart, processingAt, input.settings) : null;
    const processingSource: ProcessingSource = processingAt
      ? "QUALIFICATION_STAGE"
      : histories.length ? "NO_PROCESSING" : "NO_PROCESSING_EVIDENCE";

    const snapshot = snapshots.get(dealId); const customManagerId = input.settings.salesManagerField ? employeeId(deal[input.settings.salesManagerField]) : "";
    const moverId = string(deal.MOVED_BY_ID);
    // Two different immutability rules. The sale date is frozen as soon as a
    // snapshot exists, but seller attribution is frozen only once a real seller
    // was actually resolved: a snapshot holding an UNKNOWN seller must not block
    // the fallback chain forever, otherwise the deal can never be attributed.
    const snapshotManagerId = snapshot?.managerId ?? "";
    let salesManagerId = snapshotManagerId;
    let salesManager = snapshotManagerId ? snapshot?.managerName ?? "" : "";
    let salesManagerAttribution: SalesManagerAttribution = snapshotManagerId ? (snapshot?.attributionSource as SalesManagerAttribution) : "UNKNOWN";
    if (!snapshotManagerId && customManagerId) { salesManagerId = customManagerId; salesManagerAttribution = "CUSTOM_FIELD"; }
    else if (!snapshotManagerId && moverId) { salesManagerId = moverId; salesManagerAttribution = "STAGE_MOVER"; }
    else if (!snapshotManagerId && assignedManagerId) { salesManagerId = assignedManagerId; salesManagerAttribution = "CURRENT_RESPONSIBLE"; }
    if (!salesManager && salesManagerId) salesManager = managerName(salesManagerId, input.users);

    // Each Sales funnel carries its own Причина провала field; fall back to the
    // single configured field for installs that have not mapped per pipeline.
    const reasonField = input.settings.failureReasonFieldByPipeline?.[originCategoryId]
      ?? input.settings.failureReasonFieldByPipeline?.[currentCategoryId]
      ?? input.settings.failureReasonField;
    // Legacy settings may hold the camelCase spelling; deals only ever carry UF_CRM_*.
    const reasonKey = reasonField ? canonicalDealFieldKey(reasonField) : "";
    const lossReason = reasonKey ? fieldDisplayValue(deal[reasonKey] ?? deal[reasonField as string], fieldOptions.get(reasonKey) ?? fieldOptions.get(reasonField as string)) : "";
    // Source is the standard Bitrix SOURCE_ID resolved through the live SOURCE
    // dictionary. Custom "how did you hear" fields and UTM are separate
    // dimensions and must not stand in for it.
    const sourceId = string(deal.SOURCE_ID);
    const source = input.sources.get(sourceId) || sourceId || "Aniqlanmagan";
    const opportunity = Number(deal.OPPORTUNITY ?? 0);
    const effectiveWonAt = snapshot?.wonAt ?? wonAt;
    const salesCycleHours = effectiveWonAt ? Math.max(0, (new Date(effectiveWonAt).getTime() - created.getTime()) / 3_600_000) : null;
    const contactId = string(deal.CONTACT_ID) || (Array.isArray(deal.CONTACT_IDS) ? string(deal.CONTACT_IDS[0]) : "");
    const companyId = string(deal.COMPANY_ID);
    const effectiveLossReason = lossReason || ((salesStatus === "LOST" || salesStatus === "LOW_QUALITY") ? MISSING_LOSS_REASON : "");
    const lossReasonGroup = classifyLossReasonGroup({ status: salesStatus, reason: effectiveLossReason, routingPatterns: input.settings.routingReasonPatterns });

    return [{
      analyticsVersion: ANALYTICS_VERSION, dealId, title: string(deal.TITLE) || `Deal #${dealId}`, createdAt: created.toISOString(), creationPeriod: isInsideWorkingTime(created, input.settings) ? "WORK_HOURS" : "AFTER_HOURS", slaStart: slaStart.toISOString(),
      assignedManagerId, assignedManager: managerName(assignedManagerId, input.users), categoryId: currentCategoryId, pipeline: input.pipelines.get(currentCategoryId) ?? `Pipeline #${currentCategoryId}`,
      originCategoryId, originPipeline: input.pipelines.get(originCategoryId) ?? `Pipeline #${originCategoryId}`, operationalPipeline: mainIds.has(currentCategoryId),
      stageId: currentStageId, stage: currentStage, stageEnteredAt: stageEntered.toISOString(), stageAgeHours, stageLimitHours, stageOverdue: salesStatus === "ACTIVE" && stageAgeHours > stageLimitHours,
      sourceId, source, salesStatus, qualified, qualifiedAt, qualifiedStageId: effectiveQualifiedEvent?.stageId ?? null, qualifiedStage: effectiveQualifiedEvent?.stage ?? null,
      wonAt: effectiveWonAt, salesCycleHours, opportunity: Number.isFinite(opportunity) ? opportunity : 0, currencyId: string(deal.CURRENCY_ID), lossReason: effectiveLossReason, lossReasonGroup,
      contactId: contactId || null, companyId: companyId || null, customerKey: contactId ? `contact:${contactId}` : companyId ? `company:${companyId}` : null, duplicateOfDealId: null, stageTimeline,
      salesManagerId: salesManagerId || null, salesManager: salesManager || null, salesManagerAttribution,
      // Retained as inert columns so no destructive migration is needed.
      firstCallAt: null, firstCallActivityId: null, firstCallManagerId: null, firstCallManager: null,
      firstCallBusinessMinutes: null, firstCallOutcome: "Noma’lum", firstCallDuration: null, outcomeInferred: false,
      firstSuccessfulCallAt: null, firstSuccessfulCallBusinessMinutes: null,
      firstStageChangeAt: stageChange?.at.toISOString() ?? null, firstStageChangeTo: stageChange ? stageName(stageChange.stageId, input.stages) : null, firstStageChangeBusinessMinutes: stageMinutes,
      stageChangedBeforeCall: false, stageAttributionInferred: Boolean(stageChange), processingSource, processingAt: processingAt?.toISOString() ?? null, processingBusinessMinutes: processingMinutes,
      // Point-in-time snapshot; the dashboard re-resolves it live so a lead can
      // cross its deadline without needing another sync.
      slaStatus: resolveSlaState({ processingBusinessMinutes: processingMinutes, processingSource, slaStart: slaStart.toISOString() }, input.settings),
      outgoingCallCount: 0, answeredCallCount: 0, unansweredCallCount: 0, latestCallOutcome: "Noma’lum",
      dataUnavailable: !input.stageHistoryAvailable && !processingAt,
      bitrixUrl: input.domain ? `https://${input.domain}/crm/deal/details/${encodeURIComponent(dealId)}/` : null,
    }];
  });
}
