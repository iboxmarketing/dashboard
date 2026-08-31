/**
 * Backfill progress shape and arithmetic, kept free of D1 so the paging rules
 * are directly testable.
 */
export type BackfillState = {
  status: "running" | "success" | "error";
  cursor: number;
  total: number;
  rebuilt: number;
  progress: number;
  message: string;
  version: number;
  lastError: string | null;
};

/** Clamped so a dataset that grows mid-run cannot report above 100. */
export function backfillProgress(cursor: number, total: number) {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((cursor / total) * 100)));
}

/** Batches needed for a dataset — used by callers to bound a single request. */
export function backfillBatchCount(total: number, batchSize: number) {
  if (total <= 0 || batchSize <= 0) return 0;
  return Math.ceil(total / batchSize);
}
