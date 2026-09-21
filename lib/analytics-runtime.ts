import type { AnalyticsRuntimeDiagnostics } from "./types";

export const ANALYTICS_BATCH_SIZES = [80, 40, 20, 10, 5, 1] as const;
export const ANALYTICS_HISTORY_ROW_BUDGET = 300;
export const ANALYTICS_INPUT_BYTE_BUDGET = 80_000;
export const ANALYTICS_MINIMUM_ATTEMPTS = 3;

type PayloadRow = { deal_id: string; payload: string };

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

function candidates(available: number) {
  const capped = Math.min(ANALYTICS_BATCH_SIZES[0], Math.max(0, Math.floor(available)));
  if (!capped) return [];
  return [...new Set([capped, ...ANALYTICS_BATCH_SIZES.filter((size) => size < capped)])];
}

function profiler(rawDeals: PayloadRow[], stageHistories: PayloadRow[]) {
  const historyByDeal = new Map<string, { rows: number; bytes: number }>();
  for (const row of stageHistories) {
    const current = historyByDeal.get(row.deal_id) ?? { rows: 0, bytes: 0 };
    current.rows += 1;
    current.bytes += bytes(row.payload);
    historyByDeal.set(row.deal_id, current);
  }
  const prefixes: { rawBytes: number; historyRows: number; historyBytes: number }[] = [];
  for (const row of rawDeals) {
    const previous = prefixes.at(-1) ?? { rawBytes: 0, historyRows: 0, historyBytes: 0 };
    const history = historyByDeal.get(row.deal_id) ?? { rows: 0, bytes: 0 };
    prefixes.push({
      rawBytes: previous.rawBytes + bytes(row.payload),
      historyRows: previous.historyRows + history.rows,
      historyBytes: previous.historyBytes + history.bytes,
    });
  }
  return (batchSize: number) => {
    const selected = rawDeals.slice(0, batchSize);
    const totals = prefixes[selected.length - 1] ?? { rawBytes: 0, historyRows: 0, historyBytes: 0 };
    return {
      batchSize: selected.length,
      ...totals,
      firstDealId: selected[0]?.deal_id ?? "",
      lastDealId: selected.at(-1)?.deal_id ?? "",
    };
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

export function nextAnalyticsRetryBatchSize(input: {
  cursor: number;
  available: number;
  previous?: AnalyticsRuntimeDiagnostics;
}) {
  const previous = input.previous?.state === "attempting" && input.previous.cursor === input.cursor
    ? input.previous
    : null;
  if (!previous) return null;
  const nextSize = candidates(input.available).find((size) => size < previous.batchSize);
  if (!nextSize && previous.batchSize === 1
    && (previous.minimumAttemptCount || 1) < ANALYTICS_MINIMUM_ATTEMPTS) return 1;
  if (!nextSize) throw new AnalyticsSingleDealRuntimeError(previous.firstDealId);
  return nextSize;
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
  const profile = profiler(input.rawDeals, input.stageHistories);

  const previousAttempt = input.previous?.state === "attempting" && input.previous.cursor === input.cursor
    ? input.previous
    : null;

  if (previousAttempt) {
    const priorMinimumAttempts = previousAttempt.minimumAttemptCount || (previousAttempt.batchSize === 1 ? 1 : 0);
    const smaller = sizes.find((size) => size < previousAttempt.batchSize);
    const retryMinimum = !smaller && previousAttempt.batchSize === 1
      && priorMinimumAttempts < ANALYTICS_MINIMUM_ATTEMPTS;
    const nextSize = smaller ?? (retryMinimum ? 1 : null);
    if (!nextSize) throw new AnalyticsSingleDealRuntimeError(input.rawDeals[0]?.deal_id ?? "UNKNOWN");
    const next = profile(nextSize);
    return {
      cursor: input.cursor,
      attemptedBatchSize: previousAttempt.batchSize,
      ...next,
      splitLevel: previousAttempt.splitLevel + (retryMinimum ? 0 : 1),
      retryCount: previousAttempt.retryCount + 1,
      minimumAttemptCount: nextSize === 1 ? priorMinimumAttempts + 1 : 0,
      safeErrorClass: retryMinimum ? "ANALYTICS_RUNTIME_RETRY" : "ANALYTICS_RUNTIME_SPLIT",
      state: "attempting",
    };
  }

  const attemptedBatchSize = sizes[0];
  for (let index = 0; index < sizes.length; index += 1) {
    const next = profile(sizes[index]);
    const withinBudget = next.historyRows <= ANALYTICS_HISTORY_ROW_BUDGET
      && next.rawBytes + next.historyBytes <= ANALYTICS_INPUT_BYTE_BUDGET;
    if (withinBudget) return {
      cursor: input.cursor,
      attemptedBatchSize,
      ...next,
      splitLevel: index,
      retryCount: 0,
      minimumAttemptCount: next.batchSize === 1 ? 1 : 0,
      safeErrorClass: index === 0 ? "NONE" : "ANALYTICS_COST_SPLIT",
      state: "attempting",
    };
  }

  throw new AnalyticsSingleDealRuntimeError(input.rawDeals[0]?.deal_id ?? "UNKNOWN");
}
