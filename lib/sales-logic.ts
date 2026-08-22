import { normalizePipelineName } from "./pipelines";
import type { LossReasonGroup, SalesStatus } from "./types";

function normalized(value: unknown) {
  return normalizePipelineName(String(value ?? ""));
}

export function isLowQualityStage(stage: string) {
  const value = normalized(stage);
  return value.includes("not relevant") || value.includes("не релевант") || value.includes("sifatsiz");
}

export function isPaymentStage(stage: string) {
  const value = normalized(stage);
  return (value.includes("oplata") && (value.includes("poluch") || value.includes("olindi"))) || value.includes("оплата получена");
}

export function isQualificationStage(stage: string) {
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

export function isClosedLostStage(stage: string, semantic = "") {
  if (isLowQualityStage(stage)) return false;
  const value = normalized(stage);
  return semantic.toUpperCase() === "F" || (value.includes("закрыт") && value.includes("не реализ")) || value.includes("yopildi sotilmadi");
}

export function classifySalesStatus(input: { stage: string; semantic?: string; paymentReached: boolean; inPostSalePipeline: boolean }): SalesStatus {
  if (input.paymentReached || input.inPostSalePipeline) return "WON";
  if (isLowQualityStage(input.stage)) return "LOW_QUALITY";
  if (isClosedLostStage(input.stage, input.semantic)) return "LOST";
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
