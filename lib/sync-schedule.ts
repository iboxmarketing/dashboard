/**
 * Scheduling policy for the background sync.
 *
 * Pure by design: kept free of Cloudflare and D1 imports so every branch —
 * disabled, overlapping, abandoned, failed, paused — is testable directly.
 * The runner that performs the sync lives in `scheduled-sync.ts`.
 */
/** A running job whose heartbeat is older than this is treated as abandoned. */
export const ABANDONED_JOB_MINUTES = 10;

/** Each invocation drives at most this many step batches. */
export const MAX_STEP_BATCHES = 40;
const STEPS_PER_BATCH = 6;

export type ScheduledSkipReason = "DISABLED" | "JOB_RUNNING" | "PREVIOUS_ERROR" | "PAUSED" | "NOT_CONFIGURED";
export type ScheduledAction = "START" | "RESUME";

export type ScheduledDecision =
  | { run: false; reason: ScheduledSkipReason }
  | { run: true; action: ScheduledAction };

export type SchedulerInput = {
  autoSyncMinutes: number;
  selectedPipelineIds: string[];
  job: { status: string; heartbeatAt?: string | null; updatedAt?: string | null } | null;
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
  if (!Number(input.autoSyncMinutes)) return { run: false, reason: "DISABLED" };
  if (!input.selectedPipelineIds.length) return { run: false, reason: "NOT_CONFIGURED" };

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

