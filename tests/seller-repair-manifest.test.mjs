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

// ------------------------------- conservative refinement: no config assumption ---

import { EVIDENCE, FINAL_BUCKETS, SALES_DEPARTMENTS, classifyConservative, roleOf } from "../scripts/seller-repair-manifest.mjs";

const user = (over = {}) => ({ ID: "7", WORK_POSITION: "Sales Manager", UF_DEPARTMENT: [195], ...over });
const cons = (over = {}) => classifyConservative({
  snapshot: snap(over.snapshot), record: over.record === undefined ? rec() : over.record,
  raw: over.raw ?? null, postSaleEnteredAt: over.postSaleEnteredAt ?? null,
  user: over.user === undefined ? user() : over.user,
  paymentStageIds: PAY, postSaleCategoryId: "13", priorBucket: over.priorBucket ?? null,
});

test("a job title proves the role, independently of any dashboard configuration", () => {
  assert.deepEqual(roleOf(user({ WORK_POSITION: "Sales Manager" })), { role: "SELLER", basis: "WORK_POSITION=Sales Manager", proven: true });
  assert.equal(roleOf(user({ WORK_POSITION: "Customer Care Specialist", UF_DEPARTMENT: [43] })).role, "NON_SELLER");
  assert.equal(roleOf(user({ WORK_POSITION: "iBox оператор", UF_DEPARTMENT: [27] })).role, "NON_SELLER");
  assert.equal(roleOf(user({ WORK_POSITION: "Customer Retention Manager" })).role, "NON_SELLER");
  assert.equal(roleOf(user({ WORK_POSITION: "Marketing", UF_DEPARTMENT: [1] })).role, "NON_SELLER");
});

test("'Customer Care Team Lead' is customer care, not a sales team lead", () => {
  // Regression: the seller pattern used to match "Team Lead" inside this title
  // and promoted a Customer Care lead to SELLER.
  const r = roleOf(user({ WORK_POSITION: "Customer Care Team Lead", UF_DEPARTMENT: [27] }));
  assert.equal(r.role, "NON_SELLER");
  assert.equal(r.proven, true);
});

test("a bare Teamlead is a seller only inside a sales department", () => {
  assert.equal(roleOf(user({ WORK_POSITION: "Teamlead", UF_DEPARTMENT: [195] })).role, "SELLER");
  assert.equal(roleOf(user({ WORK_POSITION: "Teamlead", UF_DEPARTMENT: [43] })).role, "UNKNOWN", "a lead outside sales proves nothing");
  assert.ok(SALES_DEPARTMENTS.includes(197));
});

test("a blank job title falls back to the department as corroboration, never as proof", () => {
  const care = roleOf(user({ WORK_POSITION: "", UF_DEPARTMENT: [27] }));
  assert.equal(care.role, "NON_SELLER");
  assert.equal(care.proven, false, "department is corroboration only");
  assert.equal(roleOf(user({ WORK_POSITION: null, UF_DEPARTMENT: [1] })).role, "UNKNOWN", "a mixed department signals nothing");
  assert.equal(roleOf(undefined).role, "UNKNOWN");
  assert.equal(roleOf(undefined).basis, "USER_NOT_IN_CACHED_DIRECTORY");
});

test("a CUSTOM_FIELD row is auto-clearable when the frozen person cannot be a seller by job title", () => {
  const r = cons({ snapshot: { attributionSource: "CUSTOM_FIELD" }, user: user({ WORK_POSITION: "Customer Care Specialist", UF_DEPARTMENT: [43] }) });
  assert.equal(r.bucket, FINAL_BUCKETS.AUTO);
  assert.equal(r.evidence, EVIDENCE.PROVEN);
  assert.equal(r.reason, "FROZEN_MANAGER_IS_NOT_A_SELLER_BY_JOB_TITLE");
});

test("a CUSTOM_FIELD row is auto-clearable when timing proves the value is post-sale identity", () => {
  const r = cons({
    snapshot: { attributionSource: "CUSTOM_FIELD", managerId: "88", frozenAt: "2026-09-16T05:00:00Z" },
    record: rec({ categoryId: "13", stageId: "C13:NEW", assignedId: "88" }),
    postSaleEnteredAt: "2026-09-14T05:00:00Z",
    user: user({ WORK_POSITION: "", UF_DEPARTMENT: [1] }),
  });
  assert.equal(r.bucket, FINAL_BUCKETS.AUTO);
  assert.equal(r.reason, "FROZEN_AFTER_POST_SALE_ENTRY_AND_EQUALS_POST_SALE_OWNER");
});

test("a CUSTOM_FIELD row naming a PROVEN SELLER is never auto-cleared — clearing would discard good data", () => {
  const r = cons({ snapshot: { attributionSource: "CUSTOM_FIELD" }, user: user({ WORK_POSITION: "Sales Manager" }) });
  assert.equal(r.bucket, FINAL_BUCKETS.REVIEW);
  assert.equal(r.evidence, EVIDENCE.INSUFFICIENT);
  assert.equal(r.reason, "SOURCE_UNPROVEN_BUT_FROZEN_MANAGER_IS_A_PROVEN_SELLER");
});

test("CUSTOM_FIELD rows that are only suspicious go to the owner, not to auto-clear", () => {
  const dept = cons({ snapshot: { attributionSource: "CUSTOM_FIELD" }, user: user({ WORK_POSITION: "", UF_DEPARTMENT: [27] }) });
  assert.equal(dept.bucket, FINAL_BUCKETS.OWNER);
  assert.equal(dept.evidence, EVIDENCE.STRONG);
  assert.equal(dept.reason, "FROZEN_MANAGER_IN_CUSTOMER_CARE_DEPARTMENT_BUT_NO_JOB_TITLE");

  const unknown = cons({ snapshot: { attributionSource: "CUSTOM_FIELD" }, user: null });
  assert.equal(unknown.bucket, FINAL_BUCKETS.OWNER);
  assert.equal(unknown.reason, "FROZEN_MANAGER_ROLE_UNKNOWN_AND_SOURCE_UNPROVEN");
  // Neither may ever be silently auto-cleared.
  for (const b of [dept.bucket, unknown.bucket]) assert.notEqual(b, FINAL_BUCKETS.AUTO);
});

test("an uncorroborated FIRST_CALL row is cleared by approved policy, whatever the role", () => {
  for (const position of ["Sales Manager", "Customer Care Specialist", ""]) {
    const r = cons({ snapshot: { attributionSource: "FIRST_CALL" }, user: user({ WORK_POSITION: position }) });
    assert.equal(r.bucket, FINAL_BUCKETS.AUTO, position);
    assert.equal(r.reason, "POLICY_FIRST_CALL_NOT_ACCEPTED_AS_SELLER_EVIDENCE");
  }
});

test("payment-stage evidence is kept, unless it contradicts the person's role", () => {
  const kept = cons({ priorBucket: BUCKETS.TRUSTWORTHY, user: user({ WORK_POSITION: "Sales Manager" }) });
  assert.equal(kept.bucket, FINAL_BUCKETS.KEEP);

  const conflict = cons({ priorBucket: BUCKETS.TRUSTWORTHY, user: user({ WORK_POSITION: "Customer Care Team Lead", UF_DEPARTMENT: [27] }) });
  assert.equal(conflict.bucket, FINAL_BUCKETS.REVIEW);
  assert.equal(conflict.reason, "CONFLICT_PAYMENT_EVIDENCE_BUT_NON_SELLER_ROLE");
  assert.notEqual(conflict.bucket, FINAL_BUCKETS.AUTO, "a conflict is never auto-cleared either");
});

test("the conservative classifier never consults the current dashboard configuration", async () => {
  const source = await readFile(new URL("../scripts/seller-repair-manifest.mjs", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export function classifyConservative"));
  assert.doesNotMatch(fn, /salesManagerField|configuredFieldWasAssignedBy/,
    "the conservative path must not depend on the setting, whose history is unknown");
});

// ------------------------- TASK B: job-title vs deal-footprint contradiction ---

import { resolveRoleConflict } from "../scripts/seller-repair-manifest.mjs";

test("a stale job title is overridden by an overwhelming Sales footprint on a Deal that never left Sales", () => {
  // Oybek Shukurillayev: titled "Customer Care Team Lead" but currently holds
  // 101 category-3 cards and none in post-sale.
  const r = resolveRoleConflict({ footprint: { 3: 101 }, dealCurrentCategoryId: "3", dealEverInPostSale: false });
  assert.equal(r.resolution, "KEEP");
  assert.match(r.basis, /FOOTPRINT_100PCT_SALES_OF_101_AND_DEAL_NEVER_LEFT_SALES/);
});

test("no footprint at all cannot settle the contradiction, so it goes to a human", () => {
  // Diyorbek Samadov: titled "Marketing", zero deals anywhere.
  const r = resolveRoleConflict({ footprint: {}, dealCurrentCategoryId: "3", dealEverInPostSale: false });
  assert.equal(r.resolution, "REVIEW");
  assert.equal(r.basis, "NO_DEAL_FOOTPRINT_TO_CORROBORATE_OR_REFUTE_THE_JOB_TITLE");
});

test("the override is refused whenever the handoff could actually have contaminated the row", () => {
  const inPostSale = resolveRoleConflict({ footprint: { 3: 101 }, dealCurrentCategoryId: "13" });
  assert.equal(inPostSale.resolution, "REVIEW", "the Deal is in post-sale, so the contamination applies");
  const wentThrough = resolveRoleConflict({ footprint: { 3: 101 }, dealCurrentCategoryId: "3", dealEverInPostSale: true });
  assert.equal(wentThrough.resolution, "REVIEW", "it entered post-sale at some point");
  const alsoPostSale = resolveRoleConflict({ footprint: { 3: 50, 13: 20 }, dealCurrentCategoryId: "3" });
  assert.equal(alsoPostSale.resolution, "REVIEW", "the person does post-sale work too");
  const tooFew = resolveRoleConflict({ footprint: { 3: 4 }, dealCurrentCategoryId: "3" });
  assert.equal(tooFew.resolution, "REVIEW", "a handful of cards is not a career");
  const mixed = resolveRoleConflict({ footprint: { 3: 60, 17: 40 }, dealCurrentCategoryId: "3" });
  assert.equal(mixed.resolution, "REVIEW", "only 60% Sales");
});

// ------------------ final certification: Sales staff by footprint, proven-unsafe ---

import { ACTION, certify, isSalesStaffByFootprint } from "../scripts/seller-final-certification.mjs";
import { OBSERVER_STATE as OS } from "../scripts/observer-seller-recovery.mjs";

test("Sales staff is judged by footprint, which lets a stale job title through", () => {
  // Oybek Shukurillayev: "Customer Care Team Lead", 335 category-3 cards, none post-sale.
  assert.equal(isSalesStaffByFootprint({ 3: 335 }).ok, true);
  assert.equal(isSalesStaffByFootprint({ 3: 118, 5: 2 }).ok, true);
  assert.equal(isSalesStaffByFootprint({ 3: 5 }).ok, false, "a handful of cards is not a career");
  assert.equal(isSalesStaffByFootprint({ 3: 50, 13: 20 }).ok, false, "any post-sale footprint disqualifies");
  assert.equal(isSalesStaffByFootprint({ 13: 26 }).ok, false);
  assert.equal(isSalesStaffByFootprint({}).ok, false);
});

const U = new Map([
  ["7", { ID: "7", WORK_POSITION: "Sales Manager", UF_DEPARTMENT: [195] }],
  ["88", { ID: "88", WORK_POSITION: "Customer Care Specialist", UF_DEPARTMENT: [43] }],
  ["9903", { ID: "9903", WORK_POSITION: "Customer Care Team Lead", UF_DEPARTMENT: [27] }],
]);
const FP = { 7: { 3: 222 }, 88: { 13: 26 }, 9903: { 3: 335 } };
const cert = (snapshot, evidence, observerVerdict = { state: OS.NOT_CACHED, candidates: [] }) =>
  certify({ snapshot, evidence, observerVerdict, footprintOf: (id) => FP[String(id)] ?? {}, users: U });

test("a CUSTOM_FIELD seller on a Deal that never left Sales is unproven, not proven unsafe", () => {
  // ASSIGNED_BY_ID is corrupted by the post-sale handoff; with no handoff and a
  // real Sales Manager named, clearing it would destroy good attribution.
  const r = cert(
    { dealId: "1", managerId: "7", attributionSource: "CUSTOM_FIELD", frozenAt: null },
    { cat: "3", stage: "C3:UC_OTHER", movedBy: "", postSaleAt: null },
  );
  assert.equal(r.provenUnsafe, false);
  assert.equal(r.action, ACTION.UNKNOWN, "still not certified — but it must stay out of the invalidate list");
  assert.ok(r.flags.some((f) => f.startsWith("FROZEN_SELLER_UNPROVEN_BUT_NOT_PROVEN_UNSAFE")));
});

test("the same seller becomes proven unsafe once the Deal has been through the handoff", () => {
  for (const evidence of [
    { cat: "13", stage: "C13:NEW", movedBy: "88", postSaleAt: "2026-09-14T05:00:00Z" },
    { cat: "3", stage: "C3:UC_OTHER", movedBy: "", postSaleAt: "2026-09-14T05:00:00Z" },
    { cat: "17", stage: "C17:NEW", movedBy: "", postSaleAt: null },
  ]) {
    const r = cert({ dealId: "1", managerId: "7", attributionSource: "CUSTOM_FIELD", frozenAt: null }, evidence);
    assert.equal(r.provenUnsafe, true, JSON.stringify(evidence));
  }
});

test("a CUSTOM_FIELD seller who is not Sales staff is proven unsafe even inside Sales", () => {
  const r = cert(
    { dealId: "1", managerId: "88", attributionSource: "CUSTOM_FIELD", frozenAt: null },
    { cat: "3", stage: "C3:UC_OTHER", movedBy: "", postSaleAt: null },
  );
  assert.equal(r.provenUnsafe, true);
});

test("an uncorroborated FIRST_CALL seller is proven unsafe by approved policy, wherever it sits", () => {
  const r = cert(
    { dealId: "1", managerId: "7", attributionSource: "FIRST_CALL", frozenAt: null },
    { cat: "3", stage: "C3:UC_OTHER", movedBy: "", postSaleAt: null },
  );
  assert.equal(r.provenUnsafe, true);
});

test("a category-13 observer candidate with a stale title is still recovered", () => {
  const r = cert(
    { dealId: "1", managerId: "88", attributionSource: "CUSTOM_FIELD", frozenAt: null },
    { cat: "13", stage: "C13:NEW", movedBy: "88", assigned: "88", postSaleAt: "2026-09-14T05:00:00Z" },
    { state: OS.EXACT_ONE, candidates: ["9903"] },
  );
  assert.equal(r.action, ACTION.OBSERVER);
  assert.equal(r.sellerId, "9903");
  assert.ok(r.flags.some((f) => f.startsWith("OBSERVER_TITLE_OVERRIDDEN_BY_FOOTPRINT")));
});

test("a Deal with no raw evidence is never declared proven unsafe", () => {
  const r = cert({ dealId: "1", managerId: "88", attributionSource: "CUSTOM_FIELD", frozenAt: null }, null);
  assert.equal(r.action, ACTION.UNKNOWN);
  assert.equal(r.provenUnsafe, false);
  assert.equal(r.basis, "NO_RAW_EVIDENCE_FOR_THIS_DEAL");
});
