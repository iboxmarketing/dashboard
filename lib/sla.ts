import { businessMinutesExceed, calculateBusinessMinutes } from "./business-time";
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
  /**
   * The canonical employee SLA: scheduled working minutes from distribution to the
   * seller's first move out of that stage. `null` while the Deal has not been
   * moved, which is a pending SLA rather than a completed one.
   */
  slaBusinessMinutes?: number | null;
  /** When the Deal was distributed — the origin a pending SLA is measured from. */
  slaStartAt?: string | null;
  processingBusinessMinutes: number | null;
  processingSource: ProcessingSource;
  slaStart?: string | null;
  createdAt?: string | null;
};

/** Business-time elapsed since the SLA clock started, for an unprocessed lead. */
export function elapsedSlaMinutes(row: SlaInput, settings: DashboardSettings, now: Date = new Date()) {
  // Distribution is the SLA origin, so a pending Deal's elapsed time is measured
  // from exactly where a completed one would be. Records written before the SLA
  // evidence existed fall back to their stored slaStart/createdAt.
  const start = row.slaStartAt ?? row.slaStart ?? row.createdAt;
  if (!start) return 0;
  return calculateBusinessMinutes(start, now, settings);
}

export function resolveSlaState(row: SlaInput, settings: DashboardSettings, now: Date = new Date()): SlaStatus {
  // The Deal was moved out of distribution: the SLA is settled, on working time.
  if (row.slaBusinessMinutes !== null && row.slaBusinessMinutes !== undefined) {
    return row.slaBusinessMinutes <= settings.slaMinutes ? "ON_TIME" : "LATE";
  }
  // A record written before the SLA evidence existed still answers with what it
  // has, so a legacy row is not reported as missing evidence until it is rebuilt.
  if (row.slaStartAt === undefined && row.processingBusinessMinutes !== null) {
    return row.processingBusinessMinutes <= settings.slaMinutes ? "ON_TIME" : "LATE";
  }
  // Distribution evidence itself is missing: there is no SLA start to measure
  // from. The Deal's qualification speed is NOT substituted here — blending two
  // different measures into one rate is exactly the defect this SLA replaced — so
  // the Deal is reported as unmeasurable and stays out of the denominator.
  if (row.slaStartAt === null) return "UNKNOWN_EVIDENCE";
  // History is missing and the deal already sits past qualification: it was
  // very likely processed, we simply cannot date it. Never a seller failure.
  if (row.processingSource === "NO_PROCESSING_EVIDENCE") return "UNKNOWN_EVIDENCE";
  return elapsedSlaExceeds(row, settings, now) ? "OVERDUE_UNPROCESSED" : "PENDING";
}

/**
 * `elapsedSlaMinutes(row, settings, now) > settings.slaMinutes`, answered
 * without walking every day since a months-old lead arrived: the walk stops
 * as soon as the limit is passed.
 */
function elapsedSlaExceeds(row: SlaInput, settings: DashboardSettings, now: Date) {
  const start = row.slaStartAt ?? row.slaStart ?? row.createdAt;
  if (!start) return 0 > settings.slaMinutes;
  return businessMinutesExceed(start, now, settings, settings.slaMinutes);
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
