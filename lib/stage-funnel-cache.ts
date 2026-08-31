/**
 * Stage Control history cache lifecycle.
 *
 * The historical funnel used to be derived from the dashboard records, so it
 * refreshed whenever they did. Once it moved to its own lazily fetched
 * endpoint it needed an explicit lifecycle, and the first version got two
 * things wrong: a single failed request latched "loaded" forever, and a sync
 * that replaced the analytics dataset left the funnel showing the previous one.
 *
 * Kept as a pure machine — no React, no fetch — so every transition below is
 * directly testable, including the ones a static source check cannot see.
 */

export type StageFunnelStatus = "idle" | "loading" | "loaded" | "error";

export type StageFunnelAction =
  /** The user navigated to Stage Control. */
  | { type: "OPEN" }
  /** The analytics dataset was genuinely refreshed (bootstrap/sync reload). */
  | { type: "INVALIDATE"; visible: boolean }
  | { type: "SUCCESS" }
  | { type: "FAILURE" }
  /** Explicit user retry from the error notice. */
  | { type: "RETRY" };

/**
 * `dirty` records that the dataset changed while a request was already in
 * flight. That request was issued against the previous dataset, so its result
 * cannot be trusted — but firing a second request alongside it would be exactly
 * the duplicate-concurrent-fetch we are avoiding. Instead the flag is carried
 * and the refetch happens when the in-flight one settles.
 */
export type StageFunnelState = { status: StageFunnelStatus; dirty: boolean };

export type StageFunnelDecision = StageFunnelState & { fetch: boolean };

export const initialStageFunnelState: StageFunnelState = { status: "idle", dirty: false };

/**
 * `fetch` is the caller's instruction to issue exactly one request. It is only
 * ever true when the machine simultaneously enters `loading`, which is what
 * makes a duplicate concurrent request impossible: a second OPEN while a
 * request is in flight sees `loading` and is told not to fetch.
 */
export function stageFunnelNext(state: StageFunnelState, action: StageFunnelAction): StageFunnelDecision {
  const { status, dirty } = state;
  switch (action.type) {
    case "OPEN":
      // A failed load must retry when the view is opened again — that is the
      // difference between "we know there is no history" and "we never got it".
      if (status === "idle" || status === "error") return { status: "loading", dirty: false, fetch: true };
      return { status, dirty, fetch: false };
    case "RETRY":
      if (status === "loading") return { status, dirty, fetch: false };
      return { status: "loading", dirty: false, fetch: true };
    case "INVALIDATE":
      // A request is already running against the now-superseded dataset: keep
      // it single-flight and remember to refetch once it settles.
      if (status === "loading") return { status, dirty: true, fetch: false };
      // On screen and idle: it must not sit there stale, so reload now.
      if (action.visible) return { status: "loading", dirty: false, fetch: true };
      // Off screen: drop the cache and let the next visit load it.
      return { status: "idle", dirty: false, fetch: false };
    case "SUCCESS":
      // The data that just arrived predates the refresh, so go straight back
      // out for the current dataset rather than showing the old one.
      if (dirty) return { status: "loading", dirty: false, fetch: true };
      return { status: "loaded", dirty: false, fetch: false };
    case "FAILURE":
      // Deliberately not "loaded": an empty funnel and a failed fetch are
      // different things, and only one of them should stop us trying again.
      return { status: "error", dirty: false, fetch: false };
  }
}

/** True while the funnel has no trustworthy data and is not currently fetching. */
export function stageFunnelNeedsRetry(status: StageFunnelStatus) {
  return status === "error";
}
