import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BUCKETS, classify, compareIds, d1Rows, manifestRow, quantify } from "../scripts/seller-repair-manifest.mjs";

/**
 * Seller-snapshot repair manifest.
 *
 * Three buckets: clear the seller, never touch it, or send it to a human. The
 * rules are deliberately asymmetric — a proven-invalid source is enough to clear
 * a row, but only positive sale-time evidence marks one trustworthy, and a
 * STAGE_MOVER row is never invalidated just because the Deal is now post-sale.
 */

const PAY = ["C3:WON", "C5:WON"];
const base = { paymentStageIds: PAY, postSaleCategoryId: "13", configuredFieldWasAssignedBy: true, acceptFirstCall: false };
const snap = (over = {}) => ({ dealId: "1", managerId: "7", managerName: "Ali", attributionSource: "STAGE_MOVER", wonAt: "2026-09-10T05:00:00Z", frozenAt: "2026-09-11T05:00:00Z", ...over });
const rec = (over = {}) => ({ categoryId: "3", stageId: "C3:WON", assignedId: "7", opportunity: 1000, currency: "UZS", ...over });
const run = (over = {}) => classify({ ...base, snapshot: snap(over.snapshot), record: over.record === undefined ? rec() : over.record, raw: over.raw ?? null, postSaleEnteredAt: over.postSaleEnteredAt ?? null, ...over.opts });

test("a CUSTOM_FIELD row is invalid because the configured field was ASSIGNED_BY_ID", () => {
  const r = run({ snapshot: { attributionSource: "CUSTOM_FIELD" } });
  assert.equal(r.bucket, BUCKETS.INVALID);
  assert.equal(r.reason, "CUSTOM_FIELD_WAS_ASSIGNED_BY_ID_NOT_A_SELLER_FIELD");
  // Invalid on the source alone: even a Deal sitting at the payment stage with a
  // real Sales person named is still ASSIGNED_BY_ID-derived, never seller proof.
  assert.equal(run({ snapshot: { attributionSource: "CUSTOM_FIELD" }, record: rec({ categoryId: "13", stageId: "C13:NEW" }) }).bucket, BUCKETS.INVALID);
});

test("a CUSTOM_FIELD row goes to review if the configured source was NOT proven to be ASSIGNED_BY_ID", () => {
  const r = classify({ ...base, configuredFieldWasAssignedBy: false, snapshot: snap({ attributionSource: "CUSTOM_FIELD" }), record: rec(), raw: null, postSaleEnteredAt: null });
  assert.equal(r.bucket, BUCKETS.UNKNOWN);
  assert.equal(r.reason, "CUSTOM_FIELD_SOURCE_UNVERIFIED");
});

test("a STAGE_MOVER row at the payment stage is trustworthy and must not be touched", () => {
  assert.equal(run().bucket, BUCKETS.TRUSTWORTHY);
  assert.equal(run().reason, "MOVER_AT_PAYMENT_STAGE");
  assert.equal(run({ record: rec({ categoryId: "5", stageId: "C5:WON" }) }).bucket, BUCKETS.TRUSTWORTHY, "the other pipeline's payment stage counts too");
});

test("a STAGE_MOVER row frozen before the Deal reached post-sale is trustworthy on timing evidence", () => {
  const r = run({ record: rec({ categoryId: "13", stageId: "C13:NEW" }), postSaleEnteredAt: "2026-09-14T05:00:00Z" });
  assert.equal(r.bucket, BUCKETS.TRUSTWORTHY);
  assert.equal(r.reason, "FROZEN_BEFORE_POST_SALE_ENTRY");
});

test("a STAGE_MOVER row is NEVER invalidated merely because the Deal is now post-sale", () => {
  // Frozen after the post-sale move is suspicious, but it goes to a human — not
  // to the automatic clear list.
  const after = run({ snapshot: { frozenAt: "2026-09-16T05:00:00Z" }, record: rec({ categoryId: "13", stageId: "C13:NEW" }), postSaleEnteredAt: "2026-09-14T05:00:00Z" });
  assert.equal(after.bucket, BUCKETS.UNKNOWN);
  assert.equal(after.reason, "FROZEN_AFTER_POST_SALE_ENTRY_NEEDS_HUMAN_EVIDENCE");
  // No timing at all is also review, never invalid.
  const noTiming = run({ record: rec({ categoryId: "13", stageId: "C13:NEW" }) });
  assert.equal(noTiming.bucket, BUCKETS.UNKNOWN);
  assert.equal(noTiming.reason, "STAGE_MOVER_NO_TIMING_EVIDENCE");
  assert.equal(run({ record: null }).bucket, BUCKETS.UNKNOWN, "an unreadable/uncached Deal is review, not invalid");
  for (const b of [after.bucket, noTiming.bucket]) assert.notEqual(b, BUCKETS.INVALID);
});

test("a legacy FIRST_CALL row is invalid unless payment-stage mover evidence names the same person", () => {
  const plain = run({ snapshot: { attributionSource: "FIRST_CALL" } });
  assert.equal(plain.bucket, BUCKETS.INVALID);
  assert.equal(plain.reason, "FIRST_CALL_LEGACY_SOURCE_NO_STRONGER_EVIDENCE");

  const corroborated = run({ snapshot: { attributionSource: "FIRST_CALL" }, raw: { movedBy: "7" } });
  assert.equal(corroborated.bucket, BUCKETS.TRUSTWORTHY);
  assert.equal(corroborated.reason, "FIRST_CALL_CORROBORATED_BY_PAYMENT_STAGE_MOVER");

  // A different mover, or a Deal away from the payment stage, corroborates nothing.
  assert.equal(run({ snapshot: { attributionSource: "FIRST_CALL" }, raw: { movedBy: "88" } }).bucket, BUCKETS.INVALID);
  assert.equal(run({ snapshot: { attributionSource: "FIRST_CALL" }, raw: { movedBy: "7" }, record: rec({ stageId: "C3:UC_X" }) }).bucket, BUCKETS.INVALID);

  // If the business re-accepts call attribution, these stop being auto-clearable.
  const accepted = classify({ ...base, acceptFirstCall: true, snapshot: snap({ attributionSource: "FIRST_CALL" }), record: rec(), raw: null, postSaleEnteredAt: null });
  assert.equal(accepted.bucket, BUCKETS.UNKNOWN);
});

test("an unrecognised attribution source is sent to review, never cleared automatically", () => {
  const r = run({ snapshot: { attributionSource: "MAGIC" } });
  assert.equal(r.bucket, BUCKETS.UNKNOWN);
  assert.equal(r.reason, "UNRECOGNISED_ATTRIBUTION_SOURCE_MAGIC");
});

test("a manifest row carries only the agreed non-secret fields — no raw payload", () => {
  const row = manifestRow({ snapshot: snap(), record: rec(), bucket: BUCKETS.TRUSTWORTHY, reason: "MOVER_AT_PAYMENT_STAGE" });
  assert.deepEqual(Object.keys(row).sort(), [
    "attributionSource", "bucket", "currency", "currentAssignedManagerId", "currentCategoryId",
    "dealId", "managerId", "managerName", "opportunity", "reason", "snapshotCreatedAt", "wonAt",
  ]);
  // The repair touches seller attribution only: nothing else is even expressible.
  for (const forbidden of ["stageHistory", "salesStatus", "qualified", "source", "newWonAt", "newOpportunity"]) {
    assert.equal(forbidden in row, false, `${forbidden} must not appear in a seller manifest`);
  }
  const uncached = manifestRow({ snapshot: snap(), record: null, bucket: BUCKETS.UNKNOWN, reason: "x" });
  assert.equal(uncached.currentCategoryId, null);
  assert.equal(uncached.opportunity, null, "an uncached Deal reports no amount rather than 0");
});

test("quantification sums UZS only and breaks down by source, manager and reason", () => {
  const rows = [
    manifestRow({ snapshot: snap({ dealId: "1" }), record: rec({ opportunity: 1000 }), bucket: BUCKETS.INVALID, reason: "A" }),
    manifestRow({ snapshot: snap({ dealId: "2", managerId: "88", managerName: "Onboarding", attributionSource: "CUSTOM_FIELD" }), record: rec({ opportunity: 2500.5 }), bucket: BUCKETS.INVALID, reason: "B" }),
    manifestRow({ snapshot: snap({ dealId: "3" }), record: rec({ opportunity: 99, currency: "USD" }), bucket: BUCKETS.INVALID, reason: "A" }),
  ];
  const q = quantify(rows);
  assert.equal(q.deals, 3);
  assert.equal(q.uzsOpportunity, "3500.50", "the USD row is not blended into the UZS total");
  assert.deepEqual(q.byAttributionSource, { STAGE_MOVER: 2, CUSTOM_FIELD: 1 });
  assert.deepEqual(q.byReason, { A: 2, B: 1 });
  assert.deepEqual(q.byManager, { "7 Ali": 2, "88 Onboarding": 1 });
});

test("export parsing and Deal-ID ordering are numeric-aware", () => {
  assert.deepEqual(d1Rows('[{"results":[{"deal_id":"1"}],"success":true}]'), [{ deal_id: "1" }]);
  assert.deepEqual(d1Rows('noise before [{"results":[{"a":1}]}]'), [{ a: 1 }]);
  assert.deepEqual(["100", "9", "42"].sort(compareIds), ["9", "42", "100"]);
});

test("the manifest builder never writes to a database or calls an API", async () => {
  const source = await readFile(new URL("../scripts/seller-repair-manifest.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|wrangler|fetch)\s*\(/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|UPSERT)\s+(?:INTO|FROM|SET|OR)\b/i);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith(".")), [],
    "no local imports: the manifest is derived purely from the exports it is given");
});
