import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERRIDE_SCOPE, OWNER_CONFIRMED_SELLERS,
  applyOwnerOverride, assertSellerOnlyScope, loadOwnerOverrides, overrideManifest,
} from "../scripts/owner-seller-overrides.mjs";

/**
 * Owner-confirmed seller overrides.
 *
 * One attested fact per Deal, not a rule. The tests pin down that it cannot
 * reach beyond seller attribution, and that it never turns into "pick the
 * candidate with the Sales job title" for anyone else.
 */

const entry = (over = {}) => ({
  dealId: "43407", sellerId: "7893", sellerName: "Jamoliddin Kamarov",
  confirmedBy: "business owner", confirmedAt: "2026-09-20", evidence: "owner said so",
  scope: OVERRIDE_SCOPE, ...over,
});

test("the shipped registry holds exactly the owner-confirmed Deal 43407", () => {
  const overrides = loadOwnerOverrides();
  assert.equal(overrides.size, 1);
  const o = overrides.get("43407");
  assert.equal(o.sellerId, "7893");
  assert.equal(o.sellerName, "Jamoliddin Kamarov");
  assert.equal(o.confirmedBy, "business owner");
  assert.equal(o.scope, OVERRIDE_SCOPE);
  assert.match(o.evidence, /Owner confirmation/);
  assert.equal(OWNER_CONFIRMED_SELLERS.length, 1);
});

test("an override may never reach beyond seller attribution", () => {
  for (const field of ["wonAt", "opportunity", "revenue", "salesStatus", "qualified", "source", "stageTimeline"]) {
    assert.throws(() => assertSellerOnlyScope(entry({ [field]: "x" })), /out-of-scope fields/, field);
  }
  assert.throws(() => assertSellerOnlyScope(entry({ scope: "EVERYTHING" })), /must declare scope/);
  assert.equal(assertSellerOnlyScope(entry()), true);
});

test("a malformed or duplicated override is refused rather than silently ignored", () => {
  assert.throws(() => loadOwnerOverrides([entry({ dealId: "not-a-deal" })]), /invalid dealId/);
  assert.throws(() => loadOwnerOverrides([entry({ dealId: "9", sellerId: "0" })]), /invalid sellerId/);
  assert.throws(() => loadOwnerOverrides([entry({ dealId: "9", sellerId: "Ali" })]), /invalid sellerId/);
  assert.throws(() => loadOwnerOverrides([entry({ dealId: "9", confirmedBy: "" })]), /confirmedBy and confirmedAt/);
  assert.throws(() => loadOwnerOverrides([entry()]), /declared twice/, "43407 is already in the registry");
  assert.equal(loadOwnerOverrides([entry({ dealId: "99" })]).size, 2, "a new Deal is accepted");
});

test("the override replaces the seller, marks the frozen value unsafe and records provenance", () => {
  const overrides = loadOwnerOverrides();
  const verdict = applyOwnerOverride({
    dealId: "43407", overrides, snapshotManagerId: "12961", observerCandidates: ["7893", "13053"],
    verdict: { action: "HUMAN_REVIEW_REQUIRED", basis: "AMBIGUOUS_2_OBSERVER_CANDIDATES", sellerId: null, provenUnsafe: true, flags: [] },
  });
  assert.equal(verdict.action, "OWNER_CONFIRMED_SELLER");
  assert.equal(verdict.basis, "OWNER_CONFIRMATION");
  assert.equal(verdict.sellerId, "7893");
  assert.equal(verdict.ownerConfirmed, true);
  assert.equal(verdict.provenUnsafe, true, "the frozen 12961 differs, so it must be invalidated");
  assert.ok(verdict.flags.some((f) => f.startsWith("OWNER_CONFIRMED_SELLER:7893")));
  assert.ok(verdict.flags.some((f) => f.startsWith("OWNER_SELLER_REPLACES_FROZEN:12961")));
});

test("the frozen seller is left alone when it already matches the confirmation", () => {
  const verdict = applyOwnerOverride({
    dealId: "43407", overrides: loadOwnerOverrides(), snapshotManagerId: "7893", observerCandidates: ["7893"],
    verdict: { action: "KEEP_TRUSTWORTHY", basis: "x", sellerId: "7893", provenUnsafe: false, flags: [] },
  });
  assert.equal(verdict.sellerId, "7893");
  assert.equal(verdict.provenUnsafe, false, "nothing to invalidate");
  assert.equal(verdict.flags.some((f) => f.startsWith("OWNER_SELLER_REPLACES_FROZEN")), false);
});

test("a confirmation that contradicts the CRM evidence is flagged, not hidden", () => {
  const verdict = applyOwnerOverride({
    dealId: "43407", overrides: loadOwnerOverrides(), snapshotManagerId: "12961", observerCandidates: ["555", "666"],
    verdict: { action: "HUMAN_REVIEW_REQUIRED", basis: "x", sellerId: null, provenUnsafe: true, flags: [] },
  });
  assert.ok(verdict.flags.some((f) => f.startsWith("OWNER_SELLER_NOT_AMONG_OBSERVER_CANDIDATES")));
});

test("Deals without a confirmation are untouched — this is not a job-title rule", () => {
  const original = { action: "HUMAN_REVIEW_REQUIRED", basis: "AMBIGUOUS_2_OBSERVER_CANDIDATES", sellerId: null, provenUnsafe: true, flags: [] };
  const verdict = applyOwnerOverride({
    // A different Deal with the very same observer shape stays ambiguous.
    dealId: "99999", overrides: loadOwnerOverrides(), snapshotManagerId: "12961", observerCandidates: ["7893", "13053"], verdict: original,
  });
  assert.deepEqual(verdict, original, "returned unchanged, by identity of content");
  assert.equal(verdict.sellerId, null);
  assert.equal(verdict.action, "HUMAN_REVIEW_REQUIRED");
});

test("the repair payload carries seller provenance and no KPI field", () => {
  const payload = overrideManifest(loadOwnerOverrides());
  assert.equal(payload.scope, OVERRIDE_SCOPE);
  assert.deepEqual(Object.keys(payload.overrides[0]).sort(), [
    "attributionSource", "confirmedAt", "confirmedBy", "dealId", "evidence", "sellerId", "sellerName",
  ]);
  assert.equal(payload.overrides[0].attributionSource, "OWNER_CONFIRMED");
  // Scoped to the entries: the payload's `note` legitimately names the fields it
  // promises not to touch, so checking the whole document would test the prose.
  const entries = JSON.stringify(payload.overrides);
  for (const forbidden of ["wonAt", "opportunity", "revenue", "salesStatus", "qualified", "stageTimeline", "currency"]) {
    assert.doesNotMatch(entries, new RegExp(`"${forbidden}"`, "i"), `${forbidden} must not be an override field`);
  }
  assert.match(payload.note, /wonAt, OPPORTUNITY, Revenue/, "the payload states its own limits");
});
