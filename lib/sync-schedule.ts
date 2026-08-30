/**
 * Scheduling policy for the background sync.
 *
 * Pure by design: kept free of Cloudflare and D1 imports so every branch —
 * disabled, overlapping, abandoned, failed, paused — is testable directly.
 * The runner that performs the sync lives in `scheduled-sync.ts`.
 */
/** A running job whose heartbeat is older than this is treated as abandoned. */
export const ABANDONED_JOB_MINUTES = 10;

/** Cloudflare fires a cron up to about a minute late; do not skip for that. */
export const CRON_JITTER_MINUTES = 2;

/** Each invocation drives at most this many step batches. */
export const MAX_STEP_BATCHES = 40;
const STEPS_PER_BATCH = 6;

export type ScheduledSkipReason = "DISABLED" | "JOB_RUNNING" | "PREVIOUS_ERROR" | "PAUSED" | "NOT_CONFIGURED" | "TOO_SOON";
export type ScheduledAction = "START" | "RESUME";

export type ScheduledDecision =
  | { run: false; reason: ScheduledSkipReason }
  | { run: true; action: ScheduledAction };

export type SchedulerInput = {
  autoSyncMinutes: number;
  selectedPipelineIds: string[];
  job: { status: string; heartbeatAt?: string | null; updatedAt?: string | null } | null;
  /** Last successful sync, used to honour the configured interval. */
  lastSyncAt?: string | null;
  now: Date;
};

/**
 * Whether this tick should sync, kept pure so every branch is testable.
 *
 * `autoSyncMinutes = 0` means the owner has disabled background refresh. The
 * Cloudflare trigger cadence is static, so the setting — not the cron entry —
 * is the on/off switch.
 */
export function scheduledDecision(input: SchedulerInput): ScheduledDecision {
  const interval = Number(input.autoSyncMinutes);
  if (!interval) return { run: false, reason: "DISABLED" };
  if (!input.selectedPipelineIds.length) return { run: false, reason: "NOT_CONFIGURED" };

  // The Cloudflare cron cadence is fixed at 15 minutes, so the setting has to
  // gate the run itself. Previously any non-zero value merely meant "enabled",
  // and 60 synced four times an hour instead of once.
  const last = Date.parse(input.lastSyncAt ?? "");
  if (Number.isFinite(last)) {
    const elapsed = (input.now.getTime() - last) / 60_000;
    // A small tolerance: cron fires with up to ~1 minute of jitter, so a run due
    // "at 60 minutes" must not be skipped for arriving at 59m 50s.
    if (elapsed < interval - CRON_JITTER_MINUTES) return { run: false, reason: "TOO_SOON" };
  }

  const job = input.job;
  if (!job) return { run: true, action: "START" };

  // A deliberate pause and a recorded failure both want a human, not a retry
  // that would overwrite the evidence.
  if (job.status === "paused") return { run: false, reason: "PAUSED" };
  if (job.status === "error") return { run: false, reason: "PREVIOUS_ERROR" };

  if (job.status === "running") {
    const beat = Date.parse(job.heartbeatAt ?? job.updatedAt ?? "");
    const ageMinutes = Number.isFinite(beat) ? (input.now.getTime() - beat) / 60_000 : Infinity;
    // Fresh heartbeat means another invocation is mid-flight: never overlap.
    if (ageMinutes < ABANDONED_JOB_MINUTES) return { run: false, reason: "JOB_RUNNING" };
    // Otherwise the previous run died (a closed tab, an evicted isolate);
    // resume it rather than starting over and losing its cursor.
    return { run: true, action: "RESUME" };
  }

  return { run: true, action: "START" };
}

