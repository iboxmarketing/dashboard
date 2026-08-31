import { getSettings, getSyncJob, getSyncState } from "./storage";
import { resumeSync, runSyncSteps, startSync } from "./sync";
import { scheduledDecision, MAX_STEP_BATCHES, type ScheduledAction, type ScheduledSkipReason } from "./sync-schedule";

/**
 * Server-side scheduled incremental sync.
 *
 * The dashboard's auto-refresh has always been a `setInterval` inside the page,
 * so it only ran while someone had an authenticated tab open. One unattended
 * night left the cache 14 hours stale, under-reporting Sotilmadi by 16 deals
 * and revenue by 3.8M until a manual sync corrected it.
 *
 * This drives the *same* state machine the UI drives — `startSync` then
 * `runSyncSteps` — rather than a second implementation, so checkpoint overlap,
 * pagination and classification stay identical. It can never request a full
 * sync.
 */
const STEPS_PER_BATCH = 6;

export type ScheduledOutcome =
  | { ran: false; reason: ScheduledSkipReason }
  | { ran: true; action: ScheduledAction; status: string; batches: number; safeError: string | null };

/**
 * One scheduled tick. Never throws: a cron handler that rejects gives no better
 * outcome than one that records a safe status, and Bitrix messages are already
 * sanitised by `safeBitrixMessage` before they reach `safeError`.
 */
export async function runScheduledSync(now: Date = new Date()): Promise<ScheduledOutcome> {
  const [settings, job, priorState] = await Promise.all([getSettings(), getSyncJob(), getSyncState()]);
  const decision = scheduledDecision({
    autoSyncMinutes: settings.autoSyncMinutes,
    selectedPipelineIds: settings.selectedPipelineIds ?? [],
    job,
    lastSyncAt: priorState.lastSyncAt,
    now,
  });
  if (!decision.run) return { ran: false, reason: decision.reason };

  // `full` is never passed: a scheduled tick may only ever run incrementally.
  if (decision.action === "START") {
    await startSync({ pipelineId: settings.selectedPipelineIds[0] });
  } else {
    await resumeSync();
  }

  let state = await runSyncSteps(STEPS_PER_BATCH);
  let batches = 1;
  while (state.status === "running" && batches < MAX_STEP_BATCHES) {
    state = await runSyncSteps(STEPS_PER_BATCH);
    batches += 1;
  }
  // Still running means we ran out of budget, not that anything failed; the
  // next tick sees a stale heartbeat and resumes from the same cursor.
  const final = await getSyncState();
  return { ran: true, action: decision.action, status: final.status, batches, safeError: final.safeError ?? null };
}
