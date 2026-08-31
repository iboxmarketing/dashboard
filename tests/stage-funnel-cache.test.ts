import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { initialStageFunnelState, stageFunnelNeedsRetry, stageFunnelNext, type StageFunnelAction, type StageFunnelStatus } from "../lib/stage-funnel-cache";

/**
 * A behavioural harness: it drives the same machine the component drives and
 * counts the requests that would actually be issued. Sprint 29B shipped a
 * lifecycle bug that every static check passed, so these assert observable
 * request behaviour rather than source text.
 */
function harness(initial: StageFunnelStatus = "idle") {
  let state = { ...initialStageFunnelState, status: initial };
  let requests = 0;
  let view: "dashboard" | "stages" = "dashboard";
  const dispatch = (action: StageFunnelAction) => {
    const next = stageFunnelNext(state, action);
    state = { status: next.status, dirty: next.dirty };
    if (next.fetch) requests += 1;
    return next;
  };
  return {
    get status() { return state.status; },
    get dirty() { return state.dirty; },
    get requests() { return requests; },
    goTo(next: "dashboard" | "stages") { view = next; if (next === "stages") dispatch({ type: "OPEN" }); },
    /** Mirrors load(): the analytics dataset was replaced. */
    analyticsRefreshed() { dispatch({ type: "INVALIDATE", visible: view === "stages" }); },
    succeed() { dispatch({ type: "SUCCESS" }); },
    fail() { dispatch({ type: "FAILURE" }); },
    retry() { dispatch({ type: "RETRY" }); },
  };
}

test("A: the initial dashboard load issues no stage-funnel request", () => {
  const h = harness();
  assert.equal(h.requests, 0);
  // Bootstrap calls load(), which invalidates while the dashboard is visible.
  h.analyticsRefreshed();
  assert.equal(h.requests, 0, "history must not be fetched before Stage Control is opened");
  assert.equal(h.status, "idle");
});

test("B: the first navigation to Stage Control fetches once", () => {
  const h = harness();
  h.goTo("stages");
  assert.equal(h.requests, 1);
  assert.equal(h.status, "loading");
  h.succeed();
  assert.equal(h.status, "loaded");
});

test("C: leaving and returning without a refresh reuses the cache", () => {
  const h = harness();
  h.goTo("stages"); h.succeed();
  h.goTo("dashboard");
  h.goTo("stages");
  h.goTo("dashboard");
  h.goTo("stages");
  assert.equal(h.requests, 1, "no refetch while the dataset is unchanged");
  assert.equal(h.status, "loaded");
});

test("D: a failed fetch retries on the next visit instead of latching", () => {
  const h = harness();
  h.goTo("stages");
  h.fail();
  assert.equal(h.status, "error", "failure must not be recorded as loaded");
  assert.equal(stageFunnelNeedsRetry(h.status), true);
  h.goTo("dashboard");
  h.goTo("stages");
  assert.equal(h.requests, 2, "reopening retries");
  h.succeed();
  assert.equal(h.status, "loaded");
  // And the explicit retry button works without leaving the view.
  const e = harness(); e.goTo("stages"); e.fail(); e.retry();
  assert.equal(e.requests, 2);
  assert.equal(e.status, "loading");
});

test("E: a successful analytics refresh invalidates the cached history", () => {
  const h = harness();
  h.goTo("stages"); h.succeed();
  h.goTo("dashboard");
  h.analyticsRefreshed();               // sync completed -> load() -> new records
  assert.equal(h.status, "idle", "the cache is no longer trusted");
  assert.equal(h.requests, 1, "not fetched while Stage Control is closed");
  h.goTo("stages");
  assert.equal(h.requests, 2, "the next visit loads fresh history");
});

test("F: a refresh while Stage Control is open refetches immediately", () => {
  const h = harness();
  h.goTo("stages"); h.succeed();
  assert.equal(h.requests, 1);
  h.analyticsRefreshed();               // still on the stages view
  assert.equal(h.requests, 2, "the visible funnel must not stay stale");
  assert.equal(h.status, "loading");
  h.succeed();
  assert.equal(h.status, "loaded");
});

test("G: concurrent triggers never issue a duplicate request", () => {
  const h = harness();
  h.goTo("stages");
  assert.equal(h.status, "loading");
  h.goTo("stages"); h.goTo("stages");   // rapid re-navigation while in flight
  h.retry();                            // and an impatient retry click
  h.analyticsRefreshed();               // and a sync landing mid-flight
  assert.equal(h.requests, 1, "exactly one request while loading");
  assert.equal(h.dirty, true, "the in-flight result is known to be superseded");
  // The superseded result does not become the funnel: one fresh request goes
  // out when it settles, still never two at once.
  h.succeed();
  assert.equal(h.requests, 2);
  assert.equal(h.status, "loading");
  h.succeed();
  assert.equal(h.status, "loaded");
});

test("the machine is total: every action from every status is defined", () => {
  const statuses: StageFunnelStatus[] = ["idle", "loading", "loaded", "error"];
  const actions: StageFunnelAction[] = [
    { type: "OPEN" }, { type: "RETRY" }, { type: "SUCCESS" }, { type: "FAILURE" },
    { type: "INVALIDATE", visible: true }, { type: "INVALIDATE", visible: false },
  ];
  for (const status of statuses) for (const dirty of [false, true]) for (const action of actions) {
    const next = stageFunnelNext({ status, dirty }, action);
    assert.ok(statuses.includes(next.status), `${status}/${dirty} + ${action.type}`);
    // A request is only ever issued together with entering `loading`, which is
    // what makes duplicate concurrent fetches structurally impossible.
    if (next.fetch) assert.equal(next.status, "loading", `${status}/${dirty} + ${action.type} fetched without loading`);
  }
});

test("invalidation is wired to the analytics reload and nothing else", () => {
  const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  assert.equal((client.match(/invalidateStageFunnel\(\);/g) ?? []).length, 1, "exactly one invalidation site");
  const around = client.slice(client.indexOf("invalidateStageFunnel();") - 700, client.indexOf("invalidateStageFunnel();"));
  assert.match(around, /setRecords\(markDuplicates/, "invalidated where the analytics dataset is replaced");
  // Unrelated reloads must not invalidate the funnel.
  for (const unrelated of ["loadProjects", "loadPages", "loadShares", "loadCurrentStages"]) {
    const body = client.slice(client.indexOf(`const ${unrelated} = useCallback`), client.indexOf(`const ${unrelated} = useCallback`) + 700);
    assert.doesNotMatch(body, /invalidateStageFunnel/, `${unrelated} must not invalidate the funnel`);
  }
});
