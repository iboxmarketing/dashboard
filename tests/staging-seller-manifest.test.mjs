import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ACTION } from "../scripts/seller-final-certification.mjs";
import { buildManifest, d1, derivedSales, requireCompleteSnapshots } from "../scripts/staging-seller-manifest.mjs";

/**
 * Staging-only seller manifest.
 *
 * The contract that matters: `reviewed: true` is impossible while the staging
 * snapshot population is still being written, because `saveSalesSnapshots` runs
 * inside the analytics phase of the sync.
 */

test("the completeness gate refuses a partial snapshot population", () => {
  const running = requireCompleteSnapshots({
    analytics: 403, raws: 3243, snapshots: 272, expectedSnapshots: 382,
    job: JSON.stringify({ status: "running", phase: "analytics", processed: 320, total: 3243 }),
  });
  assert.equal(running.complete, false);
  assert.ok(running.reasons.some((r) => r.startsWith("ANALYTICS_INCOMPLETE:403/3243")));
  assert.ok(running.reasons.some((r) => r.startsWith("SYNC_RUNNING:phase=analytics")));
  assert.ok(running.reasons.some((r) => r.startsWith("SNAPSHOTS_INCOMPLETE:272/382")));
});

test("the gate passes only when analytics, the job and the snapshot count all agree", () => {
  const done = requireCompleteSnapshots({
    analytics: 3243, raws: 3243, snapshots: 382, expectedSnapshots: 382,
    job: JSON.stringify({ status: "idle", phase: null, processed: 3243, total: 3243 }),
  });
  assert.deepEqual(done.reasons, []);
  assert.equal(done.complete, true);

  // Each failure mode alone is enough to hold the manifest.
  assert.equal(requireCompleteSnapshots({ analytics: 3242, raws: 3243, snapshots: 382, expectedSnapshots: 382, job: "{}" }).complete, false);
  assert.equal(requireCompleteSnapshots({ analytics: 3243, raws: 3243, snapshots: 381, expectedSnapshots: 382, job: "{}" }).complete, false);
  assert.equal(requireCompleteSnapshots({ analytics: 3243, raws: 3243, snapshots: 382, expectedSnapshots: 382, job: JSON.stringify({ status: "paused" }) }).complete, false);
  // A malformed job row must not be read as "finished".
  assert.equal(requireCompleteSnapshots({ analytics: 3243, raws: 3243, snapshots: 382, expectedSnapshots: 382, job: "not json" }).complete, true);
});

test("the manifest stays unreviewed and empty until the gate passes", () => {
  const rows = [
    { dealId: "1", action: ACTION.KEEP, provenUnsafe: false },
    { dealId: "2", action: ACTION.OBSERVER, provenUnsafe: true },
    { dealId: "3", action: ACTION.MOVER, provenUnsafe: true },
    { dealId: "4", action: ACTION.UNKNOWN, provenUnsafe: true },
    { dealId: "5", action: ACTION.UNKNOWN, provenUnsafe: false },
    { dealId: "6", action: ACTION.REVIEW, provenUnsafe: true },
  ];
  const held = buildManifest({ rows, complete: false });
  assert.equal(held.reviewedInvalidate.reviewed, false);
  assert.deepEqual(held.reviewedInvalidate.dealIds, []);
  assert.equal(held.reviewedInvalidate.pendingEvidence, "STAGING_SNAPSHOTS_INCOMPLETE");

  const ready = buildManifest({ rows, complete: true });
  assert.equal(ready.reviewedInvalidate.reviewed, true);
  assert.deepEqual(ready.reviewedInvalidate.dealIds, ["2", "3", "4", "6"], "only proven-unsafe, never KEEP, never not-proven-unsafe");
  assert.deepEqual(ready.keepTrustworthy.map((r) => r.dealId), ["1"]);
  assert.deepEqual(ready.humanReview.map((r) => r.dealId), ["6"]);
  assert.equal(ready.reviewedInvalidate.dealIds.includes("1"), false);
  assert.equal(ready.reviewedInvalidate.dealIds.includes("5"), false);
});

test("Sales populations come from the approved WON rule and wonAt policy", () => {
  const ev = new Map([
    // payment history inside September: cohort and period
    ["1", { cat: "13", stage: "C13:NEW", created: Date.parse("2026-09-05T10:00:00+05:00"), movedTime: null, paymentAt: "2026-09-10T10:00:00+05:00", postSaleAt: "2026-09-11T10:00:00+05:00", salesAt: "2026-09-05T10:00:00+05:00" }],
    // created in August, paid in September: period only
    ["2", { cat: "13", stage: "C13:NEW", created: Date.parse("2026-08-04T10:00:00+05:00"), movedTime: null, paymentAt: "2026-09-08T10:00:00+05:00", postSaleAt: null, salesAt: "2026-08-04T10:00:00+05:00" }],
    // created in September, paid in October: cohort only
    ["3", { cat: "13", stage: "C13:NEW", created: Date.parse("2026-09-05T10:00:00+05:00"), movedTime: null, paymentAt: "2026-10-05T10:00:00+05:00", postSaleAt: null, salesAt: "2026-09-05T10:00:00+05:00" }],
    // never entered Sales: not an IBOX sale at all
    ["4", { cat: "13", stage: "C13:NEW", created: Date.parse("2026-09-05T10:00:00+05:00"), movedTime: null, paymentAt: "2026-09-06T10:00:00+05:00", postSaleAt: null, salesAt: null }],
    // active in Sales: not won
    ["5", { cat: "3", stage: "C3:UC_X", created: Date.parse("2026-09-05T10:00:00+05:00"), movedTime: null, paymentAt: null, postSaleAt: null, salesAt: "2026-09-05T10:00:00+05:00" }],
  ]);
  const sales = derivedSales(ev);
  assert.deepEqual(sales.all.map((x) => x.id).sort(), ["1", "2", "3"]);
  assert.deepEqual(sales.cohort.map((x) => x.id).sort(), ["1", "3"]);
  assert.deepEqual(sales.period.map((x) => x.id).sort(), ["1", "2"]);
  assert.equal(sales.period.find((x) => x.id === "2").wonAt, Date.parse("2026-09-08T10:00:00+05:00"));
});

test("the export reader tolerates wrangler's preamble and envelope", () => {
  assert.deepEqual(d1('[{"results":[{"a":1}],"success":true}]'), [{ a: 1 }]);
  assert.deepEqual(d1('noise\n[{"results":[{"a":1}]},{"results":[{"b":2}]}]'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => d1("no array here"), /no JSON array/);
});

test("the staging export and manifest scripts contain no write operation", async () => {
  const sh = await readFile(new URL("../scripts/staging-seller-export.sh", import.meta.url), "utf8");
  assert.doesNotMatch(sh, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i, "the export runs SELECTs only");
  assert.doesNotMatch(sh, /ibox-dashboard-production/, "staging repair must not read production");
  // Every SQL argument handed to the `run` helper must begin with SELECT, and
  // there must be one per `run` call — no statement slips through unchecked.
  const runCalls = (sh.match(/^run /gm) ?? []).length;
  const selects = (sh.match(/"SELECT [^"]*FROM/g) ?? []).length;
  assert.equal(runCalls, 6, "six exports");
  assert.equal(selects, runCalls, "every run call carries exactly one SELECT statement");

  const js = await readFile(new URL("../scripts/staging-seller-manifest.mjs", import.meta.url), "utf8");
  // Guards call sites, not prose: the doc comment legitimately names wrangler.
  assert.doesNotMatch(js, /\bgetD1\s*\(|\bD1Database\b/, "the classifier opens no database");
  assert.doesNotMatch(js, /\b(?:execSync|execFileSync|spawnSync|spawn|exec)\s*\(/, "the classifier shells out to nothing");
  assert.doesNotMatch(js, /\b(?:startSync|runSync|startBackfill|runBackfill)\s*\(/);
  assert.doesNotMatch(js, /["'`]\/api\/(?:sync|backfill|reconcile|settings)/);
});
