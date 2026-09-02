/**
 * Browser → `/api/sync` transport resilience.
 *
 * Nothing here knows what a sync step *means*: it only decides how much work to
 * ask for per request, how to read a response that may not be JSON at all, and
 * when a failure is worth retrying. Sync semantics stay in `lib/sync.ts`.
 *
 * The problem this solves: a manual sync in production reached the analytics
 * phase and then flapped 200 / 503 / 200 / 503. Two separate faults combined —
 *
 *  1. the client asked for 4 steps per POST, so one Worker invocation could
 *     process 4 x 80 = 320 analytics deals and intermittently exceed limits;
 *  2. `postSync` called `response.json()` unconditionally, so Cloudflare's HTML
 *     503 page surfaced to the user as `Unexpected token '<'`.
 */

/**
 * Steps per `/api/sync` POST.
 *
 * One. The server clamps `steps` into 1..6 and runs them in a single Worker
 * invocation, so this value is a direct multiplier on the work — and therefore
 * the CPU and subrequest budget — of one request. Batch sizes are deliberately
 * left alone (analytics 80, stage history 25): shrinking the invocation is the
 * cheaper lever and it keeps every server-side batch boundary unchanged.
 */
export const SYNC_STEPS_PER_REQUEST = 1;

/**
 * Pause between successful steps. Enough to stop the loop hammering the Worker,
 * D1 and Bitrix back-to-back, small enough that a sync of a few hundred steps
 * still finishes in a comparable time to before.
 */
export const SYNC_STEP_DELAY_MS = 200;

/**
 * Gateway/edge failures.
 *
 * These may occur BEFORE, DURING or AFTER the Worker ran: a 503 is produced at
 * the edge and says nothing about whether application code executed or what it
 * wrote. Only idempotent/resumable actions are therefore safe to replay
 * automatically — see `RETRYABLE_ACTIONS`.
 */
export const TRANSIENT_STATUSES = [502, 503, 504] as const;

/** Backoff before retry 1, 2 and 3. Three attempts, then give up. */
export const SYNC_RETRY_DELAYS_MS = [750, 1500, 3000] as const;

export const SYNC_MAX_RETRIES = SYNC_RETRY_DELAYS_MS.length;

export const SYNC_BUSY_MESSAGE = "Server vaqtincha band. Sinxronizatsiya qayta urinadi.";

export const SYNC_EXHAUSTED_MESSAGE =
  "Server vaqtincha band. Sync saqlandi — “Davom ettirish” orqali davom ettiring.";

export function isTransientStatus(status: number) {
  return (TRANSIENT_STATUSES as readonly number[]).includes(status);
}

export function retryDelayMs(attempt: number) {
  return SYNC_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), SYNC_RETRY_DELAYS_MS.length - 1)];
}

function looksJson(contentType: string | null | undefined) {
  return /\bjson\b/i.test(contentType ?? "");
}

export type SyncResponseOutcome<T> =
  /** A JSON body the caller can use. */
  | { kind: "ok"; payload: T }
  /** JSON, but the route reported a real application failure. Do not retry. */
  | { kind: "error"; message: string; status: number }
  /** Gateway failure or unreadable body from one. Retry the SAME action. */
  | { kind: "transient"; message: string; status: number }
  /** Non-JSON from a non-gateway status — a bug or a proxy. Do not retry. */
  | { kind: "invalid"; message: string; status: number };

/**
 * Classifies one `/api/sync` response without ever parsing blindly.
 *
 * Cloudflare returns `text/html` for 502/503/504, so `response.json()` throws a
 * SyntaxError whose message (`Unexpected token '<'`) is meaningless to an
 * operator and leaks nothing useful. The raw body is never surfaced: an HTML
 * error page is Cloudflare's, not ours, and putting it in the UI would be both
 * confusing and a small information leak.
 */
export function classifySyncResponse<T>(input: {
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
}): SyncResponseOutcome<T> {
  if (isTransientStatus(input.status)) {
    return { kind: "transient", message: SYNC_BUSY_MESSAGE, status: input.status };
  }
  if (!looksJson(input.contentType)) {
    return { kind: "invalid", message: `Serverdan noto‘g‘ri javob olindi (HTTP ${input.status}).`, status: input.status };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    // Declared JSON but is not — treat like any other malformed response.
    return { kind: "invalid", message: `Serverdan noto‘g‘ri javob olindi (HTTP ${input.status}).`, status: input.status };
  }
  if (!input.ok) {
    const message = (parsed as { error?: unknown } | null)?.error;
    return {
      kind: "error",
      message: typeof message === "string" && message ? message : "Sinxronizatsiya bajarilmadi",
      status: input.status,
    };
  }
  return { kind: "ok", payload: parsed as T };
}

/**
 * A network-level failure (`fetch` rejected) is indistinguishable from a
 * gateway drop from the browser's side, so it retries on the same terms.
 */
export function transientFromNetworkError(): SyncResponseOutcome<never> {
  return { kind: "transient", message: SYNC_BUSY_MESSAGE, status: 0 };
}

/**
 * Whether another attempt is allowed.
 *
 * Both conditions must hold: the failure is gateway-class, AND the action is
 * one that can be safely replayed. A transient failure on `start` returns
 * false here, so exactly one start POST is ever sent.
 */
export function shouldRetry(outcome: SyncResponseOutcome<unknown>, attempt: number, action: unknown) {
  return outcome.kind === "transient" && isRetryableAction(action) && attempt < SYNC_MAX_RETRIES;
}

/**
 * Which sync actions may be replayed automatically after a transient failure.
 *
 * Decided by the request's `action`, never by HTTP method — every sync call is
 * a POST. Verified against lib/sync.ts:
 *
 *  - `step`   runSyncSteps advances from the stored cursor; replaying a step
 *             that already ran simply advances from wherever the job now is.
 *  - `resume` flips a stored job back to running. It creates no run and resets
 *             no cursor; on an already-successful job it returns state as-is.
 *  - `pause`  running -> paused, otherwise a no-op.
 *
 * `start` is excluded because startSync is NOT idempotent: it mints a new
 * runId, rewrites settings and the crmFields dictionary, replaces the stored
 * job with `cursor: 0`, and for a full sync calls clearPipelineScope(). A
 * replay after the Worker had already run it can create a second run, reset an
 * in-flight cursor, or clear the pipeline scope a second time.
 */
export const RETRYABLE_ACTIONS = ["step", "resume", "pause"] as const;

export function isRetryableAction(action: unknown): boolean {
  return typeof action === "string" && (RETRYABLE_ACTIONS as readonly string[]).includes(action);
}

export const SYNC_START_UNCONFIRMED_MESSAGE =
  "Sync boshlanganini tasdiqlab bo‘lmadi. Qayta boshlashdan oldin holatni tekshiring.";

/**
 * Did a `start` whose response was lost actually take effect?
 *
 * Read-only recovery: the caller performs ONE GET of existing sync state and
 * hands the result here. A running job for the requested pipeline means the
 * start succeeded and the loop may continue stepping. Anything else — no
 * state, a different pipeline, a non-running status — is unconfirmed, and the
 * only safe move is to stop and let a human look.
 */
export type StartRecovery = { kind: "recovered" } | { kind: "unconfirmed" };

export function classifyStartRecovery(input: {
  state: { status?: unknown; scopePipelineId?: unknown } | null | undefined;
  requestedPipelineId?: string | null;
}): StartRecovery {
  const state = input.state;
  if (!state || state.status !== "running") return { kind: "unconfirmed" };
  const requested = input.requestedPipelineId ? String(input.requestedPipelineId) : "";
  if (!requested) return { kind: "recovered" };
  const scope = state.scopePipelineId === null || state.scopePipelineId === undefined ? "" : String(state.scopePipelineId);
  return scope === requested ? { kind: "recovered" } : { kind: "unconfirmed" };
}
