import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { roleOf } from "../scripts/seller-repair-manifest.mjs";
import {
  DISPOSITION, EVIDENCE_SOURCE, OBSERVER_STATE,
  buildFinalManifest, classifyObservers, observerDataPresent, parseObservers, resolveSellerEvidence, summarizeRecovery,
} from "../scripts/observer-seller-recovery.mjs";

/**
 * Observer seller-recovery audit.
 *
 * Owner-confirmed handoff: in category 13 ASSIGNED_BY_ID is the operator and the
 * Sales Manager is an Observer. Seller candidates are the valid observers minus
 * the assignee. Evidence priority is trustworthy snapshot, then payment-stage
 * mover, then a category-13 observer, then Unknown. Nothing is ever guessed.
 */

const SALES = "3";
const POST_SALE = "13";
const SD_POST_SALE = "17";
const PAY = ["C3:WON", "C5:WON"];
const OPERATOR = "88";
const SELLER = "7";
const SELLER2 = "17";
const KNOWN = new Set([SELLER, SELLER2, OPERATOR, "99"]);
const USERS = new Map([
  [SELLER, { ID: SELLER, WORK_POSITION: "Sales Manager", UF_DEPARTMENT: [195] }],
  [SELLER2, { ID: SELLER2, WORK_POSITION: "Sales Manager", UF_DEPARTMENT: [195] }],
  [OPERATOR, { ID: OPERATOR, WORK_POSITION: "Customer Care Specialist", UF_DEPARTMENT: [43] }],
  ["99", { ID: "99", WORK_POSITION: "", UF_DEPARTMENT: [1] }],
]);

const snap = (over = {}) => ({ dealId: "1", managerId: OPERATOR, managerName: "Operator", attributionSource: "CUSTOM_FIELD", frozenAt: "2026-09-16T05:00:00Z", ...over });
const rec = (over = {}) => ({ categoryId: POST_SALE, stageId: "C13:NEW", assignedId: OPERATOR, movedBy: OPERATOR, ...over });
const observers = (list, assignedById = OPERATOR) => classifyObservers({ deal: { observers: list }, assignedById, knownUserIds: KNOWN });
const resolve = (over = {}) => resolveSellerEvidence({
  snapshot: snap(over.snapshot), record: over.record === undefined ? rec() : over.record,
  observerVerdict: over.observerVerdict, paymentStageIds: PAY, postSaleCategoryId: POST_SALE,
  priorTrustworthy: over.priorTrustworthy ?? false, users: USERS, roleOf,
});

// --------------------------------------------------------- observer states ---

test("an absent observer key is OBSERVER_NOT_CACHED, and an explicit [] is NO_OBSERVER", () => {
  const noKey = { ID: "1", CATEGORY_ID: POST_SALE, ASSIGNED_BY_ID: OPERATOR };
  assert.equal(parseObservers(noKey).present, false);
  assert.equal(classifyObservers({ deal: noKey, assignedById: OPERATOR }).state, OBSERVER_STATE.NOT_CACHED);
  assert.equal(observerDataPresent([noKey, { ID: "2" }]), false);

  assert.equal(observers([]).state, OBSERVER_STATE.NO_OBSERVER ?? OBSERVER_STATE.NONE);
  assert.equal(observers([]).state, "NO_OBSERVER");
  assert.equal(observerDataPresent([{ observers: [] }]), true, "an empty list is real evidence");
});

test("[seller, operator] with the operator assigned resolves to exactly one seller candidate", () => {
  const v = observers([SELLER, OPERATOR]);
  assert.equal(v.state, OBSERVER_STATE.EXACT_ONE);
  assert.equal(v.state, "EXACT_ONE_SELLER_CANDIDATE");
  assert.deepEqual(v.candidates, [SELLER], "the assignee is subtracted, leaving the seller");
  assert.deepEqual(v.observerIds, [SELLER, OPERATOR]);
});

test("[seller1, seller2, operator] is MULTIPLE_SELLER_CANDIDATES and never guesses", () => {
  const v = observers([SELLER, SELLER2, OPERATOR]);
  assert.equal(v.state, "MULTIPLE_SELLER_CANDIDATES");
  assert.deepEqual(v.candidates, [SELLER, SELLER2]);

  const r = resolve({ observerVerdict: v });
  assert.equal(r.source, EVIDENCE_SOURCE.AMBIGUOUS);
  assert.equal(r.sellerId, null, "no seller is picked, not even the first id");
  assert.equal(r.disposition, DISPOSITION.REVIEW);
  // A job-title hint helps the reviewer but must not resolve the ambiguity.
  assert.ok(r.flags.some((f) => f.startsWith("HINT_CANDIDATES_WITH_SELLER_JOB_TITLE")));
});

test("[operator] only is OBSERVER_EQUALS_ASSIGNEE_ONLY and yields no seller", () => {
  const v = observers([OPERATOR]);
  assert.equal(v.state, "OBSERVER_EQUALS_ASSIGNEE_ONLY");
  assert.deepEqual(v.candidates, []);
  const r = resolve({ observerVerdict: v });
  assert.equal(r.source, EVIDENCE_SOURCE.NONE);
  assert.equal(r.sellerId, null);
  assert.equal(r.disposition, DISPOSITION.TO_UNKNOWN);
});

test("an unparseable or unknown observer id is INVALID_OBSERVER_ID and goes to review", () => {
  assert.equal(observers(["Ali"]).state, "INVALID_OBSERVER_ID");
  assert.equal(observers([424242]).state, "INVALID_OBSERVER_ID", "not a real user");
  assert.deepEqual(parseObservers({ observers: [0, "0"] }).ids, [], "user 0 is not a person");
  const r = resolve({ observerVerdict: observers(["Ali"]) });
  assert.equal(r.disposition, DISPOSITION.REVIEW);
  assert.equal(r.sellerId, null);
});

test("observer ids parse from every shape the capture might produce", () => {
  assert.deepEqual(parseObservers({ observers: [7, 17] }).ids, ["7", "17"]);
  assert.deepEqual(parseObservers({ OBSERVER_IDS: ["user_7"] }).ids, ["7"]);
  assert.deepEqual(parseObservers({ observerIds: "7,17" }).ids, ["7", "17"]);
  assert.deepEqual(parseObservers({ observers: [{ ID: "7" }] }).ids, ["7"]);
  assert.deepEqual(parseObservers({ observers: [7, 7] }).ids, ["7"], "de-duplicated");
});

// ------------------------------------------------------- evidence priority ---

test("a trustworthy snapshot wins over observer evidence, and disagreement is flagged", () => {
  const r = resolve({
    snapshot: snap({ managerId: SELLER2, attributionSource: "STAGE_MOVER" }),
    priorTrustworthy: true, observerVerdict: observers([SELLER, OPERATOR]),
  });
  assert.equal(r.source, EVIDENCE_SOURCE.TRUSTWORTHY_SNAPSHOT);
  assert.equal(r.sellerId, SELLER2);
  assert.equal(r.disposition, DISPOSITION.KEEP);
  assert.ok(r.flags.some((f) => f.startsWith("OBSERVER_DISAGREES_WITH_TRUSTED_SNAPSHOT")));
});

test("payment-stage mover wins BEFORE observer evidence", () => {
  const r = resolve({
    record: rec({ categoryId: SALES, stageId: "C3:WON", assignedId: SELLER2, movedBy: SELLER2 }),
    // Observers name SELLER; the contemporaneous mover is SELLER2.
    observerVerdict: observers([SELLER, SELLER2], SELLER2),
  });
  assert.equal(r.source, EVIDENCE_SOURCE.PAYMENT_MOVER);
  assert.equal(r.sellerId, SELLER2, "the contemporaneous mover is preferred over current observers");
  assert.equal(r.disposition, DISPOSITION.RECOVER_MOVER);
  assert.ok(r.flags.some((f) => f.startsWith("OBSERVER_DISAGREES_WITH_PAYMENT_MOVER")));
});

test("in post-sale the mover is the operator, so observer evidence is used instead", () => {
  const r = resolve({ observerVerdict: observers([SELLER, OPERATOR]) });
  assert.equal(r.source, EVIDENCE_SOURCE.OBSERVER);
  assert.equal(r.sellerId, SELLER);
  assert.equal(r.disposition, DISPOSITION.RECOVER_OBSERVER);
});

test("a category-17 observer is ignored: the handoff rule is confirmed for 13 only", () => {
  const r = resolve({
    record: rec({ categoryId: SD_POST_SALE, stageId: "C17:NEW" }),
    observerVerdict: observers([SELLER, OPERATOR]),
  });
  assert.equal(r.source, EVIDENCE_SOURCE.NONE);
  assert.equal(r.sellerId, null, "no seller is recovered outside category 13");
  assert.equal(r.disposition, DISPOSITION.TO_UNKNOWN);
  assert.ok(r.flags.some((f) => f.startsWith("OBSERVER_IGNORED_OUTSIDE_CATEGORY_13")));

  // Same for any other funnel, and for a Deal still sitting in Sales.
  for (const category of ["31", SALES, ""]) {
    const other = resolve({ record: rec({ categoryId: category, stageId: "X" }), observerVerdict: observers([SELLER, OPERATOR]) });
    assert.equal(other.sellerId, null, `category ${category || "(unknown)"}`);
  }
});

test("no seller is ever guessed when evidence is absent", () => {
  for (const verdict of [
    { state: OBSERVER_STATE.NOT_CACHED, candidates: [], observerIds: [], invalid: [] },
    observers([]),
    observers([OPERATOR]),
  ]) {
    const r = resolve({ observerVerdict: verdict });
    assert.equal(r.sellerId, null);
    assert.equal(r.source, EVIDENCE_SOURCE.NONE);
  }
  // An uncached Deal record cannot produce a seller either.
  assert.equal(resolve({ record: null, observerVerdict: observers([SELLER, OPERATOR]) }).sellerId, null);
});

// ------------------------------------------------- rollup and manifest shape ---

test("the September rollup counts each evidence class and credits evidence only", () => {
  const rows = [
    { dealId: "1", source: EVIDENCE_SOURCE.TRUSTWORTHY_SNAPSHOT, sellerId: SELLER, sellerName: "Seller A", observerState: OBSERVER_STATE.EXACT_ONE, disposition: DISPOSITION.KEEP },
    { dealId: "2", source: EVIDENCE_SOURCE.PAYMENT_MOVER, sellerId: SELLER, sellerName: "Seller A", observerState: OBSERVER_STATE.NONE, disposition: DISPOSITION.RECOVER_MOVER },
    { dealId: "3", source: EVIDENCE_SOURCE.OBSERVER, sellerId: SELLER2, sellerName: "Seller B", observerState: OBSERVER_STATE.EXACT_ONE, disposition: DISPOSITION.RECOVER_OBSERVER },
    { dealId: "4", source: EVIDENCE_SOURCE.AMBIGUOUS, sellerId: null, observerState: OBSERVER_STATE.MULTIPLE, disposition: DISPOSITION.REVIEW },
    { dealId: "5", source: EVIDENCE_SOURCE.NONE, sellerId: null, observerState: OBSERVER_STATE.ASSIGNEE_ONLY, disposition: DISPOSITION.TO_UNKNOWN },
    { dealId: "6", source: EVIDENCE_SOURCE.NONE, sellerId: null, observerState: OBSERVER_STATE.NOT_CACHED, disposition: DISPOSITION.TO_UNKNOWN },
  ];
  const s = summarizeRecovery(rows);
  assert.equal(s.deals, 6);
  assert.equal(s.trustworthy, 1);
  assert.equal(s.paymentMover, 1);
  assert.equal(s.observerRecovered, 1);
  assert.equal(s.ambiguous, 1);
  assert.equal(s.unknown, 2);
  assert.equal(s.trustworthy + s.paymentMover + s.observerRecovered + s.ambiguous + s.unknown, s.deals,
    "the five report classes partition the population exactly once");
  // Observer absence is a diagnostic that deliberately overlaps those classes:
  // the payment-mover row (2) and the assignee-only row (5) both lack observers.
  assert.equal(s.noObserverEvidenceDiagnostic, 2);
  assert.deepEqual(s.sellerBreakdownFromEvidenceOnly, { [`${SELLER} Seller A`]: 2, [`${SELLER2} Seller B`]: 1 });
  assert.equal(Object.keys(s.sellerBreakdownFromEvidenceOnly).length, 2, "rows with no evidence credit nobody");
});

test("the final manifest stays unreviewed and empty while observers are uncached", () => {
  const rows = [
    { dealId: "1", disposition: DISPOSITION.KEEP },
    { dealId: "2", disposition: DISPOSITION.RECOVER_MOVER },
    { dealId: "3", disposition: DISPOSITION.RECOVER_OBSERVER },
    { dealId: "4", disposition: DISPOSITION.TO_UNKNOWN },
    { dealId: "5", disposition: DISPOSITION.REVIEW },
  ];
  const pending = buildFinalManifest({ rows, observerDataAvailable: false });
  assert.equal(pending.reviewedInvalidate.reviewed, false);
  assert.deepEqual(pending.reviewedInvalidate.dealIds, [], "never populated from missing observer data");
  assert.equal(pending.reviewedInvalidate.pendingEvidence, OBSERVER_STATE.NOT_CACHED);
  assert.deepEqual(pending.keepTrustworthy.map((r) => r.dealId), ["1"]);
  assert.deepEqual(pending.humanReview.map((r) => r.dealId), ["5"]);

  const ready = buildFinalManifest({ rows, observerDataAvailable: true });
  assert.equal(ready.reviewed ?? ready.reviewedInvalidate.reviewed, true);
  assert.deepEqual(ready.reviewedInvalidate.dealIds, ["2", "3", "4"], "all three invalidate paths, never KEEP or REVIEW");
  assert.equal("pendingEvidence" in ready.reviewedInvalidate, false);
});

test("the recovery module touches no database, API or secret", async () => {
  const source = await readFile(new URL("../scripts/observer-seller-recovery.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:getD1|D1Database|fetch|wrangler)\s*\(/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|SET)\b/i);
  assert.doesNotMatch(source, /crm\.[a-z.]+\.(?:add|update|delete)\b/);
  assert.doesNotMatch(source, /webhook|token|secret/i);
});
