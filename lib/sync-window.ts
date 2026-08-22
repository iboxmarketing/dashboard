/**
 * Sync window resolution.
 *
 * Kept free of Cloudflare/D1 imports so the calculation stays directly
 * testable; `lib/sync.ts` owns the surrounding state machine.
 *
 * The incremental checkpoint is written in exactly one place — the analytics
 * phase, once it has drained (`lib/sync.ts`, analyticsStep). A paused, stale,
 * failed or otherwise incomplete run never advances it, so an incremental
 * window always resumes from the last *successfully completed* sync.
 */

/** Deliberate re-read overlap protecting against clock skew and in-flight writes. */
export const SYNC_OVERLAP_MINUTES = 10;

export type SyncWindowReason =
  | "FULL_REQUESTED"
  | "NO_CHECKPOINT"
  | "INVALID_CHECKPOINT"
  | "CHECKPOINT";

export type SyncWindow = {
  mode: "full" | "incremental";
  from: Date;
  reason: SyncWindowReason;
};

export function clampBootstrapDays(days: unknown) {
  return Math.min(365, Math.max(1, Number(days)));
}

/**
 * Reads a stored checkpoint. Returns null when it is absent or unparseable so
 * the caller can bootstrap instead of guessing a window. A checkpoint later
 * than `now` (clock skew or a bad write) is clamped to `now`, because a window
 * starting in the future would silently match no deals at all.
 */
export function parseCheckpoint(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(Math.min(milliseconds, now.getTime()));
}

/**
 * Resolves the `DATE_CREATE` (full) or `DATE_MODIFY` (incremental) lower bound
 * for the next run.
 *
 * An incremental window is anchored ONLY to the last successful sync minus the
 * overlap. It is intentionally not truncated to a rolling 24h: a dashboard that
 * has been closed for days must still catch up on everything modified since its
 * last completed run.
 */
export function resolveSyncWindow(input: {
  lastSuccessfulSyncAt: string | null | undefined;
  now: Date;
  bootstrapDays: number;
  full?: boolean;
}): SyncWindow {
  const bootstrapFrom = new Date(input.now.getTime() - clampBootstrapDays(input.bootstrapDays) * 86_400_000);
  if (input.full) return { mode: "full", from: bootstrapFrom, reason: "FULL_REQUESTED" };

  const checkpoint = parseCheckpoint(input.lastSuccessfulSyncAt, input.now);
  if (!checkpoint) {
    return {
      mode: "full",
      from: bootstrapFrom,
      reason: input.lastSuccessfulSyncAt ? "INVALID_CHECKPOINT" : "NO_CHECKPOINT",
    };
  }

  return {
    mode: "incremental",
    from: new Date(checkpoint.getTime() - SYNC_OVERLAP_MINUTES * 60_000),
    reason: "CHECKPOINT",
  };
}
