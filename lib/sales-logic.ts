import { normalizePipelineName } from "./pipelines";
import { hasConfiguredStage, type StageMeta, type StageSemantics } from "./stage-config";
import type { LossReasonGroup, SalesStatus } from "./types";

function normalized(value: unknown) {
  return normalizePipelineName(String(value ?? ""));
}

// Every predicate is stage-ID first, stage-name second. A configured id is the
// trustworthy signal because Bitrix ids survive renames; the name match stays as
// the backward-compatible fallback, so an empty config behaves exactly as before.
export function isLowQualityStage(stage: string, stageId = "", config: StageSemantics = {}) {
  if (hasConfiguredStage(config.lowQualityStageIds, stageId)) return true;
  const value = normalized(stage);
  return value.includes("not relevant") || value.includes("не релевант") || value.includes("sifatsiz");
}

export function isPaymentStage(stage: string, stageId = "", config: StageSemantics = {}) {
  // Low quality outranks payment for the SAME stage, so a stage id configured
  // into both groups is never read as a sale — including as stage history.
  // Payment proven by a different stage still wins, which is what keeps a
  // paid-then-Not-Relevant deal classified exactly as before.
  if (isLowQualityStage(stage, stageId, config)) return false;
  if (hasConfiguredStage(config.paymentStageIds, stageId)) return true;
  const value = normalized(stage);
  return (value.includes("oplata") && (value.includes("poluch") || value.includes("olindi"))) || value.includes("оплата получена");
}

export function isQualificationStage(stage: string, stageId = "", config: StageSemantics = {}) {
  if (hasConfiguredStage(config.qualifiedStageIds, stageId)) return true;
  const value = normalized(stage);
  return value.includes("обработ") || value.includes("processing") || value.includes("qabul qil") || value.includes("sql");
}

export function classifyLossReasonGroup(input: {
  status: SalesStatus;
  reason: string;
  routingPatterns?: string[];
}): LossReasonGroup {
  if (!input.reason && !["LOW_QUALITY", "LOST"].includes(input.status)) return "NONE";
  // The business rule is stage-authoritative: every Not Relevant card is a
  // marketing-quality rejection, regardless of the selected failure reason.
  if (input.status === "LOW_QUALITY") return "MARKETING";
  const reason = normalized(input.reason);
  const patterns = input.routingPatterns ?? [];
  const isRouting = patterns.some((pattern) => {
    const value = normalized(pattern);
    if (!value) return false;
    if (value === "sd") return /(^|[^a-zа-я0-9])sd([^a-zа-я0-9]|$)/i.test(reason);
    return reason.includes(value);
  });
  if (isRouting) return "ROUTING";
  if (input.status === "LOST") return "SALES";
  return "NONE";
}

export function isClosedLostStage(stage: string, semantic = "", stageId = "", config: StageSemantics = {}) {
  // Not Relevant is never a Sales loss, however Bitrix labels the stage.
  if (isLowQualityStage(stage, stageId, config)) return false;
  if (hasConfiguredStage(config.closedLostStageIds, stageId)) return true;
  const value = normalized(stage);
  return semantic.toUpperCase() === "F" || (value.includes("закрыт") && value.includes("не реализ")) || value.includes("yopildi sotilmadi");
}

/**
 * Precedence: historical/post-sale sale → LOW_QUALITY → current-stage payment
 * → LOST → ACTIVE.
 *
 * Low quality outranks a payment signal read from the CURRENT stage, so a stage
 * id configured into both groups resolves to LOW_QUALITY. It does not outrank
 * payment proven by stage history or a post-sale move: that evidence predates
 * the current stage and kept its existing precedence, which is what keeps an
 * empty configuration behaving exactly as before.
 */
export function classifySalesStatus(input: {
  stage: string;
  stageId?: string;
  semantic?: string;
  paymentReached: boolean;
  currentStagePayment?: boolean;
  inPostSalePipeline: boolean;
  config?: StageSemantics;
}): SalesStatus {
  const stageId = input.stageId ?? "";
  const config = input.config ?? {};
  if (input.paymentReached || input.inPostSalePipeline) return "WON";
  if (isLowQualityStage(input.stage, stageId, config)) return "LOW_QUALITY";
  if (input.currentStagePayment ?? isPaymentStage(input.stage, stageId, config)) return "WON";
  if (isClosedLostStage(input.stage, input.semantic, stageId, config)) return "LOST";
  return "ACTIVE";
}

export function fieldDisplayValue(raw: unknown, options: Map<string, string> = new Map()) {
  const values = Array.isArray(raw) ? raw : [raw];
  const labels = values.map((value) => {
    if (value === null || value === undefined || value === "") return "";
    return options.get(String(value)) ?? String(value);
  }).filter(Boolean);
  return labels.join(", ");
}

/**
 * Historical helper, kept as a tested pure predicate but no longer wired into
 * `qualified` (lib/analytics.ts): an ordinary Sales-group LOST closure is now
 * unconditionally qualified regardless of stage-history evidence — a seller
 * closing "Закрыто и нереализовано" without ever moving the Deal through SQL
 * first is a process violation, not proof the lead was never worked. See
 * `isPreSqlClosed` below for the diagnostic that replaced this gate.
 */
export function canInferQualificationFromOutcome(input: { stageHistoryAvailable: boolean; historyRowCount: number }) {
  return !input.stageHistoryAvailable || input.historyRowCount === 0;
}

/**
 * Canonical Sales Lost population: a **quality-accepted** lead that Sales did
 * not close. Both halves are required — routing/transfer outcomes carry their
 * own group and are never Sales Lost even though they are also terminal. An
 * ordinary Sales-group closure is always qualified (see lib/analytics.ts), so
 * in practice this is now equivalent to `lossReasonGroup === "SALES"`; the
 * `qualified` check is kept so the formula stays correct if that ever changes.
 *
 * Every metric labelled "Sotilmadi" / "Sales loss" must go through here.
 * `SalesStatus.LOST` stays useful as the broader terminal state (drop-off and
 * missing-reason diagnostics) but must never power a Sales Lost KPI on its own.
 */
export function isSalesLost(row: { lossReasonGroup?: LossReasonGroup | null; qualified?: boolean }) {
  return row.lossReasonGroup === "SALES" && Boolean(row.qualified);
}

/**
 * DIAGNOSTIC ONLY — never a KPI population. Every ordinary Sales-group
 * closure is unconditionally SQL and, if lost, Sales Lost (see
 * `lib/analytics.ts`), so this predicate must NEVER be subtracted from SQL,
 * Sales Lost or Saralangan; it exists purely to surface a process-discipline
 * signal for Diagnostics: "closed directly, without ever visiting SQL /
 * Обработка first."
 *
 * Reads `qualifiedStageId` rather than `qualified`: qualified is true
 * unconditionally for this population now, but `qualifiedStageId` is only
 * ever populated from a real stage-history match, so its absence here means
 * no SQL/downstream stage was ever recorded for the Deal. This also covers
 * the case where stage-history evidence was simply unavailable (permission
 * denied or empty) — that reads identically to a genuine skip, which the
 * diagnostic cannot tell apart. That ambiguity is exactly why this stays a
 * soft signal and is never allowed to gate a KPI.
 */
export function isPreSqlClosed(row: { salesStatus?: SalesStatus; lossReasonGroup?: LossReasonGroup | null; qualifiedStageId?: string | null }) {
  return row.salesStatus === "LOST" && row.lossReasonGroup === "SALES" && !row.qualifiedStageId;
}

/**
 * Bitrix leaves the failure reason blank on plenty of closed deals, so the
 * sync stamps this sentinel into `lossReason` at write time (lib/analytics.ts).
 * It is therefore a STORED value, not a display fallback: a reason-discipline
 * check that only tests for an empty string sees zero missing reasons on real
 * data. Every missing-reason count must go through `hasMissingLossReason`.
 */
export const MISSING_LOSS_REASON = "Sabab ko‘rsatilmagan";

export function hasMissingLossReason(row: { lossReason?: string | null }) {
  const reason = (row.lossReason ?? "").trim();
  return !reason || reason === MISSING_LOSS_REASON;
}

export function countPreSqlClosed(rows: { salesStatus?: SalesStatus; lossReasonGroup?: LossReasonGroup | null; qualified?: boolean }[]) {
  return rows.filter(isPreSqlClosed).length;
}

export function countSalesLost(rows: { lossReasonGroup?: LossReasonGroup | null; qualified?: boolean }[]) {
  return rows.filter(isSalesLost).length;
}

/** Seller bucket used by every manager aggregation, including the unknown one. */
export function salesManagerKey(row: { salesManagerId?: string | null }) {
  return row.salesManagerId || "unknown";
}

/**
 * Sales Lost rate. Sales Lost is a post-SQL outcome, so the denominator is the
 * quality-accepted population, never the whole lead cohort: 12 lost out of
 * 60 SQL is 20%, not 12% of 100 leads.
 *
 * Reuses the canonical `qualified` flag produced by buildAnalyticsRecords —
 * there is deliberately no second SQL definition. Zero SQL yields 0.
 */
export function salesLostRate(rows: { lossReasonGroup?: LossReasonGroup | null; qualified?: boolean }[]) {
  const sql = rows.filter((row) => row.qualified).length;
  return sql ? Math.round((countSalesLost(rows) / sql) * 100) : 0;
}

export type DealOutcomePresentation = { label: string; tone: "success" | "danger" | "warning" | "neutral" };

/**
 * Row-level outcome badge. Terminal deals are split by loss group so a routed
 * card reads "Yo‘naltirildi", never "Sotilmadi". Presentation only: no new
 * SalesStatus value and no stored field.
 *
 * A direct close (`isPreSqlClosed`) reads "Sotilmadi" here like any other
 * ordinary Sales-group closure — it IS canonical Sotilmadi for KPI purposes.
 * `isPreSqlClosed` stays a hidden Diagnostics signal and must never surface as
 * a third outcome badge here.
 */
export function dealOutcomeLabel(row: { salesStatus?: SalesStatus; lossReasonGroup?: LossReasonGroup | null; qualified?: boolean }): DealOutcomePresentation {
  if (row.salesStatus === "WON") return { label: "Sotilgan", tone: "success" };
  if (row.salesStatus === "LOW_QUALITY") return { label: "Sifatsiz", tone: "warning" };
  if (row.salesStatus === "LOST") {
    if (row.lossReasonGroup === "ROUTING") return { label: "Yo‘naltirildi", tone: "neutral" };
    return { label: "Sotilmadi", tone: "danger" };
  }
  return { label: "Aktiv", tone: "neutral" };
}

/**
 * Quality acceptance evidence from a stage.
 *
 * True for the configured SQL stage AND for anything downstream of it in the
 * same pipeline — Встреча, Согласие, Оплата all prove the lead was accepted.
 * Ordering comes from the live Bitrix SORT, never from a display name, so a
 * renamed stage keeps working. Not Relevant and closed-lost are excluded: they
 * are terminal outcomes, not progression.
 *
 * With no threshold configured for the pipeline this degrades to the previous
 * name/id match, so an unconfigured install behaves exactly as before.
 */
export function isSqlOrDownstreamStage(input: {
  stageId: string;
  stage: string;
  categoryId: string;
  semantic?: string;
  thresholds?: Map<string, number>;
  stageMeta?: Map<string, StageMeta>;
  config?: StageSemantics;
}) {
  const config = input.config ?? {};
  if (isLowQualityStage(input.stage, input.stageId, config)) return false;
  if (isClosedLostStage(input.stage, input.semantic ?? "", input.stageId, config)) return false;
  if (isQualificationStage(input.stage, input.stageId, config)) return true;
  const threshold = input.thresholds?.get(input.categoryId);
  const sort = input.stageMeta?.get(input.stageId)?.sort;
  if (threshold === undefined || sort === undefined) return false;
  return sort >= threshold;
}

/**
 * Deals routed to another project (Idokon / SD) are stored and diagnosable but
 * leave the IBOX eligible cohort: they never had a chance to convert here, so
 * counting them would depress every IBOX conversion denominator.
 */
export function isEligibleCohortDeal(row: { lossReasonGroup?: LossReasonGroup | null }) {
  return row.lossReasonGroup !== "ROUTING";
}

/**
 * Canonical "has this lead's quality been decided yet?" test.
 *
 * Quality and funnel progression are different questions, so they must not
 * share a denominator. `qualified` answers "was the lead accepted?", and
 * MARKETING answers "was it rejected as low quality?" — either one is a
 * verdict. Everything else (Распределение, Нет ответа, Первое касание and any
 * other pre-SQL stage) is simply undecided, and counting it as low quality
 * would punish a young cohort for not having been worked yet.
 *
 * Deliberately expressed over the canonical `qualified` / `lossReasonGroup`
 * fields rather than display stage names: a renamed or newly added pre-SQL
 * stage stays unclassified without anyone editing a list.
 */
export function isClassifiedLead(row: { qualified?: boolean; lossReasonGroup?: LossReasonGroup | null }) {
  return Boolean(row.qualified) || row.lossReasonGroup === "MARKETING";
}

/** Eligible leads whose quality is not yet decided. Unknown quality, not low quality. */
export function isUnclassifiedLead(row: { qualified?: boolean; lossReasonGroup?: LossReasonGroup | null }) {
  return !isClassifiedLead(row);
}

/**
 * Records that claim both verdicts at once. Canonically impossible — MARKETING
 * is only ever produced from a LOW_QUALITY status, which forces
 * `qualified: false` — so a non-zero count means a stale or hand-edited record,
 * and it is surfaced in Diagnostics rather than silently absorbed by the
 * `Saralangan = Sifatli + Sifatsiz` equation.
 */
export function countClassificationConflicts(rows: { qualified?: boolean; lossReasonGroup?: LossReasonGroup | null }[]) {
  return rows.filter((row) => Boolean(row.qualified) && row.lossReasonGroup === "MARKETING").length;
}
