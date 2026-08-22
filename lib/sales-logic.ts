import { normalizePipelineName } from "./pipelines";
import { hasConfiguredStage, type StageSemantics } from "./stage-config";
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
 * Canonical Sales Lost population: a quality-accepted lead that Sales did not
 * close. Routing/transfer outcomes carry their own group and are deliberately
 * excluded, so this is narrower than `salesStatus === "LOST"`.
 *
 * Every metric labelled "Sotilmadi" / "Sales loss" must go through here.
 * `SalesStatus.LOST` stays useful as the broader terminal state (quality
 * acceptance, drop-off, missing-reason diagnostics) but must never power a
 * Sales Lost KPI on its own.
 */
export function isSalesLost(row: { lossReasonGroup?: LossReasonGroup | null }) {
  return row.lossReasonGroup === "SALES";
}

export function countSalesLost(rows: { lossReasonGroup?: LossReasonGroup | null }[]) {
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
 * card no longer reads "Sotilmadi" while every Sotilmadi count excludes it.
 * Presentation only: no new SalesStatus value and no stored field.
 */
export function dealOutcomeLabel(row: { salesStatus?: SalesStatus; lossReasonGroup?: LossReasonGroup | null }): DealOutcomePresentation {
  if (row.salesStatus === "WON") return { label: "Sotilgan", tone: "success" };
  if (row.salesStatus === "LOW_QUALITY") return { label: "Sifatsiz", tone: "warning" };
  if (row.salesStatus === "LOST") {
    return row.lossReasonGroup === "ROUTING"
      ? { label: "Yo‘naltirildi", tone: "neutral" }
      : { label: "Sotilmadi", tone: "danger" };
  }
  return { label: "Aktiv", tone: "neutral" };
}
