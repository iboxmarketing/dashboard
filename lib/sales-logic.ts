import { normalizePipelineName } from "./pipelines";
import type { SalesStatus } from "./types";

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
