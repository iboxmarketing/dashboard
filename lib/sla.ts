import { calculateBusinessMinutes } from "./business-time";
import type { DashboardSettings, ProcessingSource, SlaStatus } from "./types";

/**
 * SLA state resolution and aggregation.
 *
 * The KPI answers one question: of the leads whose processing deadline is
 * already resolved, what share were processed on time? A lead still inside its
 * deadline (PENDING) and a lead whose first-processing timestamp cannot be
 * reconstructed (UNKNOWN_EVIDENCE) are both excluded, so an unprocessed lead can
 * no longer hide outside the denominator forever and missing history is never
 * silently charged to a seller.
 *
 * Kept free of React and Cloudflare imports so every consumer — the record
 * builder and each dashboard view — shares one definition.
 */

export type SlaInput = {
  processingBusinessMinutes: number | null;
  processingSource: ProcessingSource;
  slaStart?: string | null;
  createdAt?: string | null;
};

/** Business-time elapsed since the SLA clock started, for an unprocessed lead. */
export function elapsedSlaMinutes(row: SlaInput, settings: DashboardSettings, now: Date = new Date()) {
  // slaStart already rolls an after-hours lead forward to the next working
  // period, and processingBusinessMinutes is measured from it, so pending and
  // overdue must use the same origin to stay comparable.
  const start = row.slaStart ?? row.createdAt;
  if (!start) return 0;
  return calculateBusinessMinutes(start, now, settings);
}

export function resolveSlaState(row: SlaInput, settings: DashboardSettings, now: Date = new Date()): SlaStatus {
  if (row.processingBusinessMinutes !== null) {
    return row.processingBusinessMinutes <= settings.slaMinutes ? "ON_TIME" : "LATE";
  }
  // History is missing and the deal already sits past qualification: it was
  // very likely processed, we simply cannot date it. Never a seller failure.
  if (row.processingSource === "NO_PROCESSING_EVIDENCE") return "UNKNOWN_EVIDENCE";
  return elapsedSlaMinutes(row, settings, now) > settings.slaMinutes ? "OVERDUE_UNPROCESSED" : "PENDING";
}

export type SlaSummary = {
  onTime: number; late: number; overdue: number; pending: number; unknown: number;
  denominator: number; rate: number;
};

/** Canonical aggregation: ON_TIME / (ON_TIME + LATE + OVERDUE_UNPROCESSED). */
export function summarizeSla(rows: { slaStatus: SlaStatus }[]): SlaSummary {
  const count = (state: SlaStatus) => rows.filter((row) => row.slaStatus === state).length;
  const onTime = count("ON_TIME"); const late = count("LATE"); const overdue = count("OVERDUE_UNPROCESSED");
  const denominator = onTime + late + overdue;
  return {
    onTime, late, overdue, pending: count("PENDING"), unknown: count("UNKNOWN_EVIDENCE"),
    denominator, rate: denominator ? Math.round((onTime / denominator) * 100) : 0,
  };
}

export const SLA_LABELS: Record<SlaStatus, string> = {
  ON_TIME: "SLA ichida",
  LATE: "Kech ishlov berilgan",
  OVERDUE_UNPROCESSED: "Ishlov muddati o‘tgan",
  PENDING: "SLA muddati ichida",
  UNKNOWN_EVIDENCE: "Ishlov vaqti noma’lum",
};

export const SLA_TONES: Record<SlaStatus, string> = {
  ON_TIME: "success", LATE: "warning", OVERDUE_UNPROCESSED: "danger",
  PENDING: "neutral", UNKNOWN_EVIDENCE: "neutral",
};
