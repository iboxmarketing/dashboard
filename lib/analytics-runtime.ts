import type { AnalyticsRuntimeDiagnostics } from "./types";

export const ANALYTICS_BATCH_SIZES = [80, 40, 20, 10, 5, 1] as const;
export const ANALYTICS_HISTORY_ROW_BUDGET = 300;
export const ANALYTICS_INPUT_BYTE_BUDGET = 80_000;

type PayloadRow = { deal_id: string; payload: string };

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function candidates(available: number) {
  const capped = Math.min(ANALYTICS_BATCH_SIZES[0], Math.max(0, Math.floor(available)));
  if (!capped) return [];
  return [...new Set([capped, ...ANALYTICS_BATCH_SIZES.filter((size) => size < capped)])];
}

function profile(rawDeals: PayloadRow[], stageHistories: PayloadRow[], batchSize: number) {
  const selected = rawDeals.slice(0, batchSize);
  const ids = new Set(selected.map((row) => row.deal_id));
  const selectedHistory = stageHistories.filter((row) => ids.has(row.deal_id));
  return {
    batchSize: selected.length,
    rawBytes: selected.reduce((total, row) => total + bytes(row.payload), 0),
    historyRows: selectedHistory.length,
    historyBytes: selectedHistory.reduce((total, row) => total + bytes(row.payload), 0),
    firstDealId: selected[0]?.deal_id ?? "",
    lastDealId: selected.at(-1)?.deal_id ?? "",
  };
}

export class AnalyticsSingleDealRuntimeError extends Error {
  readonly safeErrorClass = "ANALYTICS_SINGLE_DEAL_RUNTIME";
  readonly dealId: string;

  constructor(dealId: string) {
    super(`ANALYTICS_SINGLE_DEAL_RUNTIME: Deal ${dealId || "UNKNOWN"} minimum analytics batchida Worker limitidan oshdi`);
    this.name = "AnalyticsSingleDealRuntimeError";
    this.dealId = dealId || "UNKNOWN";
  }
}

/**
 * Chooses a deterministic prefix of the stable analytics page.
 *
 * A Worker 1102 terminates the invocation before application code can catch
 * it. `analyticsStep` therefore persists an `attempting` plan before the
 * expensive calculation. Seeing that same marker at the same cursor on the
 * next request proves the prior attempt did not commit its cursor and halves
 * the batch without relying on the failed request to run a catch handler.
 */
export function planAnalyticsBatch(input: {
  cursor: number;
  rawDeals: PayloadRow[];
  stageHistories: PayloadRow[];
  previous?: AnalyticsRuntimeDiagnostics;
}): AnalyticsRuntimeDiagnostics {
  const sizes = candidates(input.rawDeals.length);
  if (!sizes.length) throw new AnalyticsSingleDealRuntimeError("UNKNOWN");

  const previousAttempt = input.previous?.state === "attempting" && input.previous.cursor === input.cursor
    ? input.previous
    : null;

  if (previousAttempt) {
    const nextSize = sizes.find((size) => size < previousAttempt.batchSize);
    if (!nextSize) throw new AnalyticsSingleDealRuntimeError(input.rawDeals[0]?.deal_id ?? "UNKNOWN");
    const next = profile(input.rawDeals, input.stageHistories, nextSize);
    return {
      cursor: input.cursor,
      attemptedBatchSize: previousAttempt.batchSize,
      ...next,
      splitLevel: previousAttempt.splitLevel + 1,
      retryCount: previousAttempt.retryCount + 1,
      safeErrorClass: "ANALYTICS_RUNTIME_SPLIT",
      state: "attempting",
    };
  }

  const attemptedBatchSize = sizes[0];
  for (let index = 0; index < sizes.length; index += 1) {
    const next = profile(input.rawDeals, input.stageHistories, sizes[index]);
    const withinBudget = next.historyRows <= ANALYTICS_HISTORY_ROW_BUDGET
      && next.rawBytes + next.historyBytes <= ANALYTICS_INPUT_BYTE_BUDGET;
    if (withinBudget) return {
      cursor: input.cursor,
      attemptedBatchSize,
      ...next,
      splitLevel: index,
      retryCount: 0,
      safeErrorClass: index === 0 ? "NONE" : "ANALYTICS_COST_SPLIT",
      state: "attempting",
    };
  }

  throw new AnalyticsSingleDealRuntimeError(input.rawDeals[0]?.deal_id ?? "UNKNOWN");
}
