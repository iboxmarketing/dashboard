/**
 * The closed set of sync control actions.
 *
 * Kept separate from the route so the guard is testable without a Cloudflare
 * binding: nothing outside this list may reach `startSync`, and a missing or
 * unknown action is rejected rather than defaulted.
 */
export const SYNC_ACTIONS = ["start", "step", "pause", "resume"] as const;

export type SyncAction = (typeof SYNC_ACTIONS)[number];

export function isSyncAction(value: unknown): value is SyncAction {
  return typeof value === "string" && (SYNC_ACTIONS as readonly string[]).includes(value);
}

/** Only an explicit "start" may launch a sync job. */
export function startsSync(value: unknown): boolean {
  return isSyncAction(value) && value === "start";
}
