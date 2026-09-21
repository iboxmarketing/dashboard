import assert from "node:assert/strict";
import test from "node:test";
import { ACTION, certify } from "../scripts/seller-final-certification.mjs";
import { OBSERVER_STATE } from "../scripts/observer-seller-recovery.mjs";
import { OWNER, deployedBackfill, expectedDryRun, finalAction } from "../scripts/staging-final-manifest.mjs";

const seller = { ID: "10", NAME: "S", LAST_NAME: "S", WORK_POSITION: "Sales Manager", UF_DEPARTMENT: [197] };
const users = new Map([["10", seller], ["11", { ...seller, ID: "11" }], ["89", { ID: "89", WORK_POSITION: "Marketing", UF_DEPARTMENT: [1] }]]);
const footprintOf = (id) => (id === "10" || id === "11" ? { 3: 200 } : {});
const exact = (id) => ({ state: OBSERVER_STATE.EXACT_ONE, candidates: [id], observerIds: [id], invalid: [] });
const post = { cat: "13", stage: "C13:NEW", movedBy: "5", assigned: "12961", postSaleAt: "2026-09-02T00:00:00Z" };
const run = (snapshot, evidence, observerVerdict) => certify({ snapshot: { frozenAt: null, ...snapshot }, evidence, observerVerdict, footprintOf, users });

test("an existing POST_SALE_OBSERVER snapshot is kept only when raw observers re-derive the same Sales seller", () => {
  assert.equal(run({ managerId: "10", attributionSource: "POST_SALE_OBSERVER" }, post, exact("10")).action, ACTION.KEEP);
  const other = run({ managerId: "10", attributionSource: "POST_SALE_OBSERVER" }, post, exact("11"));
  assert.equal(other.action, ACTION.OBSERVER); assert.equal(other.provenUnsafe, true); assert.equal(other.sellerId, "11");
  const ambiguous = run({ managerId: "10", attributionSource: "POST_SALE_OBSERVER" }, post, { state: OBSERVER_STATE.MULTIPLE, candidates: ["10", "11"] });
  assert.equal(ambiguous.action, ACTION.REVIEW); assert.equal(ambiguous.provenUnsafe, false);
});

test("an UNKNOWN snapshot has nothing to invalidate", () => {
  const none = run({ managerId: null, attributionSource: "UNKNOWN" }, { cat: "31", stage: "C31:X" }, null);
  assert.equal(none.action, ACTION.UNKNOWN); assert.equal(none.provenUnsafe, false);
  const multi = run({ managerId: null, attributionSource: "UNKNOWN" }, post, { state: OBSERVER_STATE.MULTIPLE, candidates: ["10", "11"] });
  assert.equal(multi.action, ACTION.REVIEW); assert.equal(multi.provenUnsafe, false);
});

test("evidence naming the same person as the frozen seller corroborates it", () => {
  const atPayment = { cat: "3", stage: "C3:WON", movedBy: "10", assigned: "10" };
  const kept = run({ managerId: "10", attributionSource: "CUSTOM_FIELD" }, atPayment, null);
  assert.equal(kept.action, ACTION.KEEP); assert.equal(kept.basis, "CUSTOM_FIELD_CORROBORATED_BY_PAYMENT_STAGE_MOVER");
  const firstCall = run({ managerId: "10", attributionSource: "FIRST_CALL" }, post, exact("10"));
  assert.equal(firstCall.action, ACTION.KEEP); assert.equal(firstCall.provenUnsafe, false);
});

test("the owner override maps to exactly one of the six actions", () => {
  assert.equal(finalAction({ action: "OWNER_CONFIRMED_SELLER", provenUnsafe: true }), OWNER);
  assert.equal(finalAction({ action: "OWNER_CONFIRMED_SELLER", provenUnsafe: false }), ACTION.KEEP);
});

test("the deployed Backfill chain is mover-at-payment, then single observer, never a role check", () => {
  assert.deepEqual(deployedBackfill({ cat: "3", stage: "C3:WON", movedBy: "89" }).sellerId, "89", "credits Marketing — why such rows are excluded");
  assert.equal(deployedBackfill({ cat: "13", observers: "[\"10\",\"12961\"]", assigned: "12961" }).sellerId, "10");
  assert.equal(deployedBackfill({ cat: "13", observers: ["7893", "13053"], assigned: "12961" }).source, "UNKNOWN", "43407 stays UNKNOWN");
  assert.equal(deployedBackfill({ cat: "31", stage: "C31:X", movedBy: "5" }).source, "UNKNOWN");
  assert.equal(deployedBackfill(null).source, "UNKNOWN");
});

test("dry-run counts follow the repair CLI exactly", () => {
  const snaps = new Map([
    ["1", { managerId: "10", managerName: "S", attributionSource: "CUSTOM_FIELD" }],
    ["2", { managerId: null, managerName: null, attributionSource: "UNKNOWN" }],
  ]);
  assert.deepEqual(expectedDryRun(["1", "2", "3", "1"], snaps), { requested: 3, matched: 2, missing: 1, wouldChange: 1 });
});
