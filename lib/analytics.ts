import { businessSlaMinutes, calculateBusinessMinutes, elapsedCalendarMinutes, getSlaStart, isInsideWorkingTime } from "./business-time";
import { OWNER_OVERRIDES, type OwnerSellerOverride } from "./seller-overrides";
import { resolveSlaState } from "./sla";
import { classifyLossReasonGroup, MISSING_LOSS_REASON, classifySalesStatus, fieldDisplayValue, isLowQualityStage, isPaymentStage, isSqlOrDownstreamStage } from "./sales-logic";
import { distributionStageId, sqlThresholdsByCategory, type StageMeta, type StageSemantics } from "./stage-config";
import { canonicalDealFieldKey } from "./crm-fields";
import { resolveDealSource } from "./source-authority";
import { certifySeller } from "./seller-evidence";
import { decideCanonicalLeadMembership } from "./canonical-lead-membership.js";
import { normalizeSafeStableSellerField, normalizeSalesOwnerAtWonField } from "./stable-seller-field";
import { DEAL_OBSERVERS_FIELD, observerIdList, singlePostSaleObserverId } from "./deal-observers";
import type { SalesSnapshot } from "./storage";
import type { AnalyticsRecord, DashboardSettings, ProcessingSource, SalesManagerAttribution, SellerConfirmationEvidence } from "./types";

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
 * 7 — Direct-close correction: an ordinary canonical Sales LOST closure is
 *     always qualified now, regardless of stage-history evidence — a Deal
 *     moved straight to "Закрыто и нереализовано" without ever visiting
 *     SQL/Обработка is a seller process error, not proof the lead was never
 *     worked, so it counts as SQL + Sales Lost. LOW_QUALITY still forces
 *     qualified=false (Not Relevant stays authoritative) and ROUTING stays
 *     outside the eligible cohort entirely, untouched by this rule.
 *     `pre_sql_closed` (isPreSqlClosed) is diagnostic only from here on — it
 *     flags a missing SQL-stage evidence trail but is never subtracted from
 *     SQL, Sales Lost or Saralangan. A version 6 record was written under the
 *     old exclusion and reports different SQL and Sotilmadi numbers, and a
 *     different Saralangan, until it is rebuilt.
 * 8 — Canonical project Lead membership is persisted independently from source
 *     and failure reason. Entry into selected Sales plus the current project
 *     category decides the population; ambiguous history remains unresolved.
 * 9 — Won-deal seller attribution no longer guesses from a post-sale/current
 *     owner. A won Deal may use MOVED_BY_ID only while its current stage is the
 *     payment stage; otherwise it needs a stable custom field or an already
 *     frozen snapshot and remains Unknown when neither exists.
 * 10 — Stable seller configuration is custom-field-only. Generic operational
 *      owners such as ASSIGNED_BY_ID can no longer be read and mislabeled as
 *      CUSTOM_FIELD seller evidence. Existing unsafe snapshots are repaired
 *      only through the explicit reviewed-ID invalidation workflow.
 * 11 — A won Deal currently in its paired post-sale category may recover the
 *      commercial seller from the universal Bitrix `observers` user[] field,
 *      but only when it contains exactly one valid user distinct from the
 *      current operational assignee. Observer evidence is explicit and never
 *      masquerades as a custom field.
 * 12 — Source authority: `source` is the configured Marketing channel field's
 *      label when the Deal carries a valid value, else the SOURCE_ID label;
 *      `rawSource` always keeps the SOURCE_ID label and `sourceAuthority`
 *      says which one decided. Lead, SQL, Sales and seller rules are
 *      unchanged; only the Source dimension differs from version 11.
 * 13 — Employee-evaluation accuracy. `source` is SOURCE_ID only again (owner
 *      decision); the Marketing channel stays on the record as its own
 *      dimension, never as Source. Every attribution now carries
 *      `sellerCertification` (OWNER_CONFIRMED / CERTIFIED / REVIEW_REQUIRED /
 *      UNKNOWN) with the reason that produced it, so only proven sales reach an
 *      employee scorecard; an ordinary Sales loss carries `lostOwner*` under
 *      the same rules; and the actors behind each decision (MOVED_BY_ID,
 *      observers, current assignee) are persisted for the audit trail. Lead,
 *      SQL, Not Relevant, Sales and Revenue membership are unchanged.
 * 14 — Sales Owner at Won becomes the canonical seller source (owner decision).
 *      A Bitrix robot writes the Responsible person into
 *      `UF_CRM_1790230512` when a Deal reaches `Оплата получена` and the field
 *      is still empty, i.e. before the operator handoff, so the value is the
 *      seller at the moment of sale. Priority is now: an attested per-Deal fact
 *      (reviewed owner registry, then an admin confirmation written back to that
 *      same field), the field itself, then the already-approved deterministic
 *      legacy evidence, then review/unknown. The field also supersedes a frozen
 *      legacy snapshot, and `UF_CRM_1740741551` ("Первый sales") is rejected
 *      everywhere. Lead, SQL, Not Relevant, Sales, Revenue and membership rules
 *      are unchanged.
 * 15 — Product-fit outcome. A Deal closed in a configured product-fit stage
 *      (`productFitStageIds`, owner decision: `C3:UC_FKITQ2` "Klient lekin
 *      programma nepodxodit") carries `lossReasonGroup = "PRODUCT_FIT"`: it is a
 *      Lead, it is NOT SQL, NOT Not Relevant and NOT Sales Lost, it sits inside
 *      Saralanmagan, and it is reported on its own line. Blames neither Marketing
 *      nor Sales. Independently, Bitrix `SEMANTICS = F` now travels on stage
 *      metadata, so a failure stage can never become "downstream of SQL"
 *      qualification evidence merely because its SORT sits after Обработка — the
 *      defect that made one such Deal count as SQL + Sotilmadi. A version 14
 *      record reports the old classification for those Deals until rebuilt.
 */
export const ANALYTICS_VERSION = 16;

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
  /** Admin confirmations from the review queue, written back to Bitrix (lib/storage.ts). */
  confirmations?: Map<string, SellerConfirmationEvidence>;
  /** Reviewed per-Deal seller decisions. Default to the version-controlled registry, so every caller — Sync and Backfill — applies them. */
  ownerOverrides?: Map<string, OwnerSellerOverride>;
}) {
  const ownerOverrides = input.ownerOverrides ?? OWNER_OVERRIDES;
  const historiesByDeal = new Map<string, RawStageHistory[]>();
  for (const history of input.stageHistories) { const id = string(history.OWNER_ID); if (id) historiesByDeal.set(id, [...(historiesByDeal.get(id) ?? []), history]); }
  const mainIds = new Set(input.settings.selectedPipelineIds); const postSaleIds = new Set(input.settings.postSalePipelineIds);
  // Validation only: the roster can flag an attribution for review, never decide it.
  const salesRoster = new Set((input.settings.salesStaffIds ?? []).map(String).filter(Boolean));
  const stageThresholds = sqlThresholdsByCategory(input.settings.qualifiedStageIds, input.stageMeta);
  const stageSemantics: StageSemantics = {
    lowQualityStageIds: input.settings.lowQualityStageIds, paymentStageIds: input.settings.paymentStageIds,
    closedLostStageIds: input.settings.closedLostStageIds, qualifiedStageIds: input.settings.qualifiedStageIds,
    productFitStageIds: input.settings.productFitStageIds,
  };
  const fieldOptions = input.fieldOptions ?? new Map<string, Map<string, string>>(); const snapshots = input.snapshots ?? new Map<string, SalesSnapshot>();

  return input.deals.flatMap((deal): AnalyticsRecord[] => {
    const dealId = string(deal.ID); const created = timestamp(deal.DATE_CREATE); if (!dealId || !created) return [];
    const histories = orderedHistory(historiesByDeal.get(dealId) ?? []); const currentCategoryId = string(deal.CATEGORY_ID || "0"); const currentStageId = string(deal.STAGE_ID);
    const currentStage = stageName(currentStageId, input.stages);
    const firstMainHistory = histories.find((row) => mainIds.has(string(row.CATEGORY_ID)));
    const projectLeadMembership = decideCanonicalLeadMembership({
      enteredSalesCategory: mainIds.has(currentCategoryId) || firstMainHistory
        ? true
        : input.stageHistoryAvailable
          ? false
          : undefined,
      currentCategoryId,
      salesCategoryIds: mainIds,
      postSaleCategoryIds: postSaleIds,
    });
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
    // lossReasonGroup must be known before `qualified` below, because ordinary
    // Sales closures and routed/transferred ones are treated differently.
    // Neither this block nor lossReasonGroup depends on qualified, so hoisting
    // it here (its position in the returned record is unchanged) is safe.
    const reasonField = input.settings.failureReasonFieldByPipeline?.[originCategoryId]
      ?? input.settings.failureReasonFieldByPipeline?.[currentCategoryId]
      ?? input.settings.failureReasonField;
    // Legacy settings may hold the camelCase spelling; deals only ever carry UF_CRM_*.
    const reasonKey = reasonField ? canonicalDealFieldKey(reasonField) : "";
    const lossReason = reasonKey ? fieldDisplayValue(deal[reasonKey] ?? deal[reasonField as string], fieldOptions.get(reasonKey) ?? fieldOptions.get(reasonField as string)) : "";
    const effectiveLossReason = lossReason || ((salesStatus === "LOST" || salesStatus === "LOW_QUALITY") ? MISSING_LOSS_REASON : "");
    const lossReasonGroup = classifyLossReasonGroup({
      status: salesStatus, reason: effectiveLossReason, routingPatterns: input.settings.routingReasonPatterns,
      // A configured product-fit stage decides the group from the stage the Deal
      // actually closed in, never from the failure reason text.
      stageId: currentStageId, config: stageSemantics,
    });
    // Quality acceptance. Not Relevant is always a marketing rejection, so a
    // previous SQL visit must not reclassify it as a salesperson loss. A sale
    // proves acceptance on its own. An ORDINARY Sales-funnel closure
    // (lossReasonGroup === "SALES", i.e. not Not Relevant and not routed/
    // transferred to another project) is also always treated as qualified,
    // even with no SQL/Обработка stage evidence: a seller who closes a Deal
    // directly as "Закрыто и нереализовано" without moving it through SQL
    // first is a process violation, not proof the lead was never worked, and
    // it must still count as a seller-qualified lost lead. Routed/transferred
    // closures are excluded from this rule — they never had a chance to
    // convert here at all, so they are neither SQL nor Sales Lost.
    const qualified = salesStatus === "LOW_QUALITY"
      ? false
      : Boolean(qualifiedEvent)
        || salesStatus === "WON"
        || (salesStatus === "LOST" && lossReasonGroup === "SALES");
    // Timing comes only from real qualification evidence. The old positional
    // fallback picked whatever stage happened to sit second in the timeline,
    // which dated qualification to Нет ответа or Сделка провалена. A direct
    // close carries no such evidence, so qualifiedAt/qualifiedStage stay null
    // for it even though `qualified` is true — see isPreSqlClosed below for
    // the diagnostic that reads exactly this gap.
    const effectiveQualifiedEvent = qualified ? qualifiedEvent ?? null : null;
    const qualifiedAt = effectiveQualifiedEvent?.enteredAt ?? null;

    // ---- Employee SLA evidence: distribution -> first move out of it ----------
    // The clock starts when the Deal enters the distributed stage and stops on the
    // FIRST transition to any other stage — Нет ответа and Первое касание stop it
    // exactly as Обработка does. Calls are not evidence: not every seller has a
    // Bitrix-connected phone (owner rule, 2026-09-26).
    const distributionStage = distributionStageId(originCategoryId, input.stageMeta, stageSemantics);
    const distributionEntry = distributionStage
      ? histories.find((row) => string(row.STAGE_ID) === distributionStage && Boolean(timestamp(row.CREATED_TIME)))
      : undefined;
    const slaStartAt = distributionEntry ? timestamp(distributionEntry.CREATED_TIME) : null;
    const slaStopEntry = slaStartAt
      ? histories.find((row) => {
        const at = timestamp(row.CREATED_TIME);
        return Boolean(at) && (at as Date) > slaStartAt && string(row.STAGE_ID) !== distributionStage;
      })
      : undefined;
    const slaStopAt = slaStopEntry ? timestamp(slaStopEntry.CREATED_TIME) : null;
    const slaStopStageId = slaStopEntry ? string(slaStopEntry.STAGE_ID) : null;
    const slaBusinessMinutes = businessSlaMinutes(slaStartAt, slaStopAt, input.settings);
    const slaElapsedMinutes = elapsedCalendarMinutes(slaStartAt, slaStopAt);

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

    const snapshot = snapshots.get(dealId);
    // The canonical seller field: a Bitrix robot writes the Responsible person
    // into it when the Deal reaches payment and the field is still empty, so the
    // value predates the operator/onboarding handoff. Stored separately from
    // ASSIGNED_BY_ID, MOVED_BY_ID, the observer list and FIRST_CALL, and never
    // confused with the legacy stable seller field.
    const ownerAtWonField = normalizeSalesOwnerAtWonField(input.settings.salesOwnerAtWonField);
    const ownerAtWonKey = ownerAtWonField ? canonicalDealFieldKey(ownerAtWonField) : "";
    const salesOwnerAtWonId = ownerAtWonKey
      ? employeeId(deal[ownerAtWonKey] ?? deal[ownerAtWonField as string])
      : "";
    // A value that names no known Bitrix user proves nothing, so it is recorded
    // for audit but does not silence the legacy evidence chain.
    const usableOwnerAtWonId = salesOwnerAtWonId && input.users.has(salesOwnerAtWonId) ? salesOwnerAtWonId : "";
    // Settings written before field canonicalization may still contain Bitrix's
    // camelCase spelling. Deal SELECT payloads use UF_CRM_*; read the canonical
    // key first while retaining the raw-key fallback for controlled fixtures and
    // any legacy payload that happened to use the stored spelling.
    const safeSellerField = normalizeSafeStableSellerField(input.settings.salesManagerField);
    const salesManagerField = safeSellerField ? canonicalDealFieldKey(safeSellerField) : "";
    const customManagerId = salesManagerField
      ? employeeId(deal[salesManagerField] ?? deal[safeSellerField as string])
      : "";
    const moverId = string(deal.MOVED_BY_ID);
    const postSaleObserverId = salesStatus === "WON" && postSaleIds.has(currentCategoryId)
      ? singlePostSaleObserverId(deal[DEAL_OBSERVERS_FIELD], assignedManagerId)
      : "";
    // Two different immutability rules. The sale date is frozen as soon as a
    // snapshot exists, but seller attribution is frozen only once a real seller
    // was actually resolved: a snapshot holding an UNKNOWN seller must not block
    // the fallback chain forever, otherwise the deal can never be attributed.
    // Legacy snapshots written from CURRENT_RESPONSIBLE never proved a seller:
    // that value may already have been the post-sale owner. Keep their wonAt,
    // but let trustworthy evidence repair their manager. CUSTOM_FIELD and
    // STAGE_MOVER snapshots stay immutable because they may have been captured
    // at the actual payment transition and no later field is stronger. A known
    // bad legacy CUSTOM_FIELD/FIRST_CALL snapshot is not weakened globally:
    // the reviewed-ID repair first clears only its seller fields to UNKNOWN,
    // after which this normal unresolved-snapshot fallback chain applies.
    // Newly resolved POST_SALE_OBSERVER snapshots join CUSTOM_FIELD and
    // STAGE_MOVER as immutable trustworthy evidence.
    //
    // Priority: 1 OWNER_CONFIRMED  2 trustworthy frozen snapshot  3 safe UF_CRM_*
    // field  4 current payment-stage mover  5 category-13 observer  6 Unknown.
    // An owner confirmation is an explicit per-Deal fact and outranks every
    // CRM signal, including a frozen snapshot. Environment-specific repair
    // manifests are deliberately not runtime attribution rules: a row omitted
    // from an invalidation manifest keeps its frozen snapshot normally.
    const ownerOverride = ownerOverrides.get(dealId);
    const confirmation = input.confirmations?.get(dealId);
    // One attested per-Deal fact, from the reviewed registry in git or from an
    // admin confirmation that was written back to Bitrix. The registry is
    // reviewable in version control, so it wins if both exist.
    const attested: { sellerId: string; sellerName: string; attribution: SalesManagerAttribution } | null = ownerOverride
      ? { sellerId: ownerOverride.sellerId, sellerName: ownerOverride.sellerName, attribution: "OWNER_CONFIRMED" }
      : confirmation && /^[1-9]\d*$/.test(String(confirmation.sellerId ?? ""))
        ? { sellerId: String(confirmation.sellerId), sellerName: confirmation.sellerName ?? "", attribution: "MANUAL_CONFIRMATION" }
        : null;
    // A populated canonical field also supersedes a frozen legacy snapshot: the
    // snapshot froze an inference, the field recorded the seller at sale time.
    const snapshotManagerId = attested || usableOwnerAtWonId
      ? ""
      : snapshot?.attributionSource === "CURRENT_RESPONSIBLE" ? "" : snapshot?.managerId ?? "";
    let salesManagerId = snapshotManagerId;
    let salesManager = snapshotManagerId ? snapshot?.managerName ?? "" : "";
    let salesManagerAttribution: SalesManagerAttribution = snapshotManagerId ? (snapshot?.attributionSource as SalesManagerAttribution) : "UNKNOWN";
    const mayRecover = !attested && !usableOwnerAtWonId && !snapshotManagerId;
    if (attested) { salesManagerId = attested.sellerId; salesManager = attested.sellerName; salesManagerAttribution = attested.attribution; }
    // Nothing below may override the canonical field: not the current assignee,
    // not the stage mover, not an observer, not a legacy CUSTOM_FIELD value.
    else if (usableOwnerAtWonId) { salesManagerId = usableOwnerAtWonId; salesManagerAttribution = "SALES_OWNER_AT_WON"; }
    else if (mayRecover && customManagerId) { salesManagerId = customManagerId; salesManagerAttribution = "CUSTOM_FIELD"; }
    // Bitrix stage history has stage/category/time but no historical actor.
    // MOVED_BY_ID is only the actor who moved the Deal into its CURRENT stage,
    // so it is sale-time evidence only while that current stage is payment.
    // Once a won Deal has moved to post-sale, both MOVED_BY_ID and
    // ASSIGNED_BY_ID can belong to onboarding/support and must never be frozen
    // as the seller. A single distinct observer is the owner's confirmed CRM
    // handoff evidence; an empty/ambiguous observer list remains Unknown.
    else if (mayRecover && moverId && (salesStatus !== "WON" || currentStageIsPayment) && mainIds.has(currentCategoryId)) {
      salesManagerId = moverId; salesManagerAttribution = "STAGE_MOVER";
    }
    else if (mayRecover && postSaleObserverId) {
      salesManagerId = postSaleObserverId; salesManagerAttribution = "POST_SALE_OBSERVER";
    }
    // Current responsibility remains useful for not-yet-won Sales-funnel work
    // (including ordinary Sales Lost), but is operational evidence, never a
    // fallback for a completed sale.
    else if (mayRecover && salesStatus !== "WON" && assignedManagerId && mainIds.has(currentCategoryId)) {
      salesManagerId = assignedManagerId; salesManagerAttribution = "CURRENT_RESPONSIBLE";
    }
    if (!salesManager && salesManagerId) salesManager = managerName(salesManagerId, input.users);

    // Can this attribution be shown on an employee's scorecard? Decided here,
    // where the evidence that produced it is still in hand (lib/seller-evidence.ts).
    const sellerEvidence = certifySeller({
      attribution: salesManagerAttribution,
      sellerId: salesManagerId,
      fromSnapshot: Boolean(snapshotManagerId) && salesManagerId === snapshotManagerId && !attested,
      hasConfiguredSellerField: Boolean(salesManagerField),
      fieldSellerId: customManagerId,
      knownUser: Boolean(salesManagerId) && input.users.has(salesManagerId),
      salesRoster: salesRoster,
    });

    // Who owns an ordinary Sales loss. The same evidence problem applies: the
    // current owner and the mover are not proof of who was responsible when the
    // Deal was closed, so without a configured seller field or an owner
    // confirmation this stays UNKNOWN rather than blaming whoever is on the card
    // now. MOVED_BY_ID is recorded as audit evidence only.
    const lostOwnerId = lossReasonGroup === "SALES" && salesStatus === "LOST"
      ? attested ? attested.sellerId : customManagerId || ""
      : "";
    const lostOwnerEvidence = lossReasonGroup === "SALES" && salesStatus === "LOST"
      ? certifySeller({
        attribution: attested ? attested.attribution : lostOwnerId ? "CUSTOM_FIELD" : "UNKNOWN",
        sellerId: lostOwnerId,
        fromSnapshot: false,
        hasConfiguredSellerField: Boolean(salesManagerField),
        fieldSellerId: customManagerId,
        knownUser: Boolean(lostOwnerId) && input.users.has(lostOwnerId),
        salesRoster: salesRoster,
      })
      : null;

    // Source is the standard Bitrix SOURCE_ID, resolved through the live SOURCE
    // dictionary, and nothing else (owner decision, docs/BUSINESS_RULES.md §9).
    // The configured Marketing channel is still read, but as its own marketing
    // dimension — it never stands in for Source, and neither do UTM fields.
    const sourceId = string(deal.SOURCE_ID);
    const { source, marketingChannel, rawSource } = resolveDealSource({
      deal, marketingChannelField: input.settings.marketingChannelField, fieldOptions, sources: input.sources,
    });
    const opportunity = Number(deal.OPPORTUNITY ?? 0);
    const effectiveWonAt = snapshot?.wonAt ?? wonAt;
    const salesCycleHours = effectiveWonAt ? Math.max(0, (new Date(effectiveWonAt).getTime() - created.getTime()) / 3_600_000) : null;
    const contactId = string(deal.CONTACT_ID) || (Array.isArray(deal.CONTACT_IDS) ? string(deal.CONTACT_IDS[0]) : "");
    const companyId = string(deal.COMPANY_ID);

    return [{
      analyticsVersion: ANALYTICS_VERSION, dealId, title: string(deal.TITLE) || `Deal #${dealId}`, createdAt: created.toISOString(), creationPeriod: isInsideWorkingTime(created, input.settings) ? "WORK_HOURS" : "AFTER_HOURS", slaStart: slaStart.toISOString(),
      assignedManagerId, assignedManager: managerName(assignedManagerId, input.users), categoryId: currentCategoryId, pipeline: input.pipelines.get(currentCategoryId) ?? `Pipeline #${currentCategoryId}`,
      originCategoryId, originPipeline: input.pipelines.get(originCategoryId) ?? `Pipeline #${originCategoryId}`, operationalPipeline: mainIds.has(currentCategoryId), projectLeadMembership,
      stageId: currentStageId, stage: currentStage, stageEnteredAt: stageEntered.toISOString(), stageAgeHours, stageLimitHours, stageOverdue: salesStatus === "ACTIVE" && stageAgeHours > stageLimitHours,
      sourceId, source, rawSource, marketingChannel, salesStatus, qualified, qualifiedAt, qualifiedStageId: effectiveQualifiedEvent?.stageId ?? null, qualifiedStage: effectiveQualifiedEvent?.stage ?? null,
      wonAt: effectiveWonAt, salesCycleHours, opportunity: Number.isFinite(opportunity) ? opportunity : 0, currencyId: string(deal.CURRENCY_ID), lossReason: effectiveLossReason, lossReasonGroup,
      contactId: contactId || null, companyId: companyId || null, customerKey: contactId ? `contact:${contactId}` : companyId ? `company:${companyId}` : null, duplicateOfDealId: null, stageTimeline,
      salesManagerId: salesManagerId || null, salesManager: salesManager || null, salesManagerAttribution,
      salesOwnerAtWonId: salesOwnerAtWonId || null,
      salesOwnerAtWonName: salesOwnerAtWonId ? managerName(salesOwnerAtWonId, input.users) : null,
      sellerCertification: sellerEvidence.status, sellerEvidenceReason: sellerEvidence.reason, sellerOutsideRoster: sellerEvidence.outsideRoster,
      lostOwnerId: lostOwnerId || null,
      lostOwnerName: lostOwnerId ? managerName(lostOwnerId, input.users) : null,
      lostOwnerCertification: lostOwnerEvidence?.status ?? null,
      lostOwnerEvidenceReason: lostOwnerEvidence?.reason ?? null,
      // Audit trail: the raw actors behind every attribution decision.
      movedById: moverId || null,
      observerIds: observerIdList(deal[DEAL_OBSERVERS_FIELD]),
      postSaleObserverId: postSaleObserverId || null,
      // Retained as inert columns so no destructive migration is needed.
      firstCallAt: null, firstCallActivityId: null, firstCallManagerId: null, firstCallManager: null,
      firstCallBusinessMinutes: null, firstCallOutcome: "Noma’lum", firstCallDuration: null, outcomeInferred: false,
      firstSuccessfulCallAt: null, firstSuccessfulCallBusinessMinutes: null,
      firstStageChangeAt: stageChange?.at.toISOString() ?? null, firstStageChangeTo: stageChange ? stageName(stageChange.stageId, input.stages) : null, firstStageChangeBusinessMinutes: stageMinutes,
      stageChangedBeforeCall: false, stageAttributionInferred: Boolean(stageChange), processingSource, processingAt: processingAt?.toISOString() ?? null, processingBusinessMinutes: processingMinutes,
      // Point-in-time snapshot; the dashboard re-resolves it live so a lead can
      // cross its deadline without needing another sync.
      slaStartAt: slaStartAt?.toISOString() ?? null,
      slaStopAt: slaStopAt?.toISOString() ?? null,
      slaStopStageId, slaStopStage: slaStopStageId ? stageName(slaStopStageId, input.stages) : null,
      slaBusinessMinutes, slaElapsedMinutes,
      slaStatus: resolveSlaState({
        slaStartAt: slaStartAt?.toISOString() ?? null, slaBusinessMinutes,
        processingBusinessMinutes: processingMinutes, processingSource, slaStart: slaStart.toISOString(),
      }, input.settings),
      outgoingCallCount: 0, answeredCallCount: 0, unansweredCallCount: 0, latestCallOutcome: "Noma’lum",
      dataUnavailable: !input.stageHistoryAvailable && !processingAt,
      bitrixUrl: input.domain ? `https://${input.domain}/crm/deal/details/${encodeURIComponent(dealId)}/` : null,
    }];
  });
}
