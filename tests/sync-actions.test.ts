import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SYNC_ACTIONS, isSyncAction, startsSync } from "../lib/sync-actions";

/**
 * Sprint 23 — /api/sync previously treated every unrecognised action, and a
 * missing one, as "start". An empty POST body was therefore enough to launch a
 * sync against production; that was observed live before this fix.
 */

test("only an explicit start may launch a sync", () => {
  assert.equal(startsSync("start"), true);
  for (const action of ["step", "pause", "resume"]) {
    assert.equal(isSyncAction(action), true, action);
    assert.equal(startsSync(action), false, `${action} must not start a sync`);
  }
});

test("unknown, missing and malformed actions are rejected outright", () => {
  const rejected = [
    "noop", "unknown", "START", "Start", " start", "start ", "full",
    "", null, undefined, 0, 1, true, false, {}, [], { action: "start" },
  ];
  for (const value of rejected) {
    assert.equal(isSyncAction(value), false, `must reject: ${JSON.stringify(value)}`);
    assert.equal(startsSync(value), false, `must not start: ${JSON.stringify(value)}`);
  }
});

test("the action list is closed", () => {
  assert.deepEqual([...SYNC_ACTIONS], ["start", "step", "pause", "resume"]);
});

test("the route rejects before reaching startSync", () => {
  const route = readFileSync(new URL("../app/api/sync/route.ts", import.meta.url), "utf8");
  // The guard must run before any handler call…
  const guardAt = route.indexOf("isSyncAction");
  const startAt = route.indexOf("startSync(");
  assert.ok(guardAt > -1, "route validates the action");
  assert.ok(guardAt < startAt, "validation precedes startSync");
  assert.match(route, /status:\s*400/, "unknown action returns 400");
  // …and startSync must be reachable only through an explicit "start".
  assert.match(route, /action === "start"\s*\n?\s*\?\s*await startSync/, "startSync is gated on action === start");
  assert.doesNotMatch(route, /:\s*await startSync\(/, "no fall-through branch reaches startSync");
});
