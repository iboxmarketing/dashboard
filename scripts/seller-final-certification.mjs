#!/usr/bin/env node

// Final seller certification from COMPLETE RAW evidence (read-only).
//
// Deliberately does not read `analytics_records`: the observer-aware Full Sync
// hit the D1 daily write quota at 320/3,243 analytics rows, so that table is
// partial. Raw Deals, stage history and observer capture are complete, so the
// certification is derived from those instead.
//
// Evidence priority:
//   1. truly trustworthy frozen seller
//   2. payment-stage mover
//   3. category-13 post-sale observer (candidates = observers MINUS assignee)
//   4. Unknown
//
// Category 17 and every other funnel stay out of observer scope. Nothing is
// written to D1 or Bitrix and no repair is performed.

import { readFile } from "node:fs/promises";
import { roleOf, resolveRoleConflict, d1Rows } from "./seller-repair-manifest.mjs";
import { OBSERVER_STATE } from "./observer-seller-recovery.mjs";

/**
 * Is this person commercial Sales staff, judged by deal footprint?
 *
 * Used for an OBSERVER candidate, where the Deal sitting in post-sale is exactly
 * what the workflow predicts and therefore says nothing about the candidate. The
 * post-sale-contamination test that guards the KEEP path would wrongly reject
 * every observer candidate, so the question here is only about the person:
 * do they hold Sales cards and no post-sale cards?
 *
 * This is what lets a stale title through — "Customer Care Team Lead" with 335
 * category-3 cards and none in post-sale is a seller.
 */
export function isSalesStaffByFootprint(footprint = {}, { salesCategoryId = "3", postSaleCategoryId = "13", minFootprint = 10, salesShareThreshold = 0.9 } = {}) {
  const total = Object.values(footprint).reduce((sum, n) => sum + n, 0);
  if (total < minFootprint) return { ok: false, basis: `FOOTPRINT_TOO_SMALL(${total})` };
  const sales = footprint[String(salesCategoryId)] ?? 0;
  const postSale = footprint[String(postSaleCategoryId)] ?? 0;
  if (postSale > 0) return { ok: false, basis: `HAS_POST_SALE_FOOTPRINT(${postSale})` };
  if (sales / total < salesShareThreshold) return { ok: false, basis: `SALES_SHARE_${Math.round((sales / total) * 100)}PCT` };
  return { ok: true, basis: `FOOTPRINT_${Math.round((sales / total) * 100)}PCT_SALES_OF_${total}` };
}

export const ACTION = Object.freeze({
  KEEP: "KEEP_TRUSTWORTHY",
  MOVER: "INVALIDATE_THEN_RECOVER_PAYMENT_MOVER",
  OBSERVER: "INVALIDATE_THEN_RECOVER_OBSERVER",
  UNKNOWN: "INVALIDATE_TO_UNKNOWN",
  REVIEW: "HUMAN_REVIEW_REQUIRED",
});

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const ms = (v) => { const p = Date.parse(s(v)); return Number.isFinite(p) ? p : null; };
export const PAYMENT_STAGES = Object.freeze(["C3:WON", "C5:WON"]);
const SALES_CATS = new Set(["3", "5"]);

/**
 * One snapshot, judged against complete raw evidence.
 *
 * `CUSTOM_FIELD` is never trustworthy: the configured field was ASSIGNED_BY_ID,
 * so the frozen value is the operational owner. A `STAGE_MOVER` row is
 * trustworthy only with positive sale-time proof — the card still sits at the
 * payment stage, or the snapshot was frozen before the card ever reached
 * post-sale. A job-title contradiction is settled by the person's deal
 * footprint, never by the title alone.
 */
export function certify({ snapshot, evidence, observerVerdict, footprintOf, users }) {
  const flags = [];
  if (!evidence) {
    return { action: ACTION.UNKNOWN, basis: "NO_RAW_EVIDENCE_FOR_THIS_DEAL", sellerId: null, flags, provenUnsafe: false };
  }
  const cat = s(evidence.cat);
  const atPayment = PAYMENT_STAGES.includes(s(evidence.stage)) && SALES_CATS.has(cat);
  const inPostSale = cat === "13";
  const movedBy = s(evidence.movedBy);
  const frozen = ms(snapshot.frozenAt);
  const postSaleAt = ms(evidence.postSaleAt);
  const src = snapshot.attributionSource;

  // Settles a proven-non-seller job title against the person's real footprint.
  const guard = (personId, dealStillInSales) => {
    const role = roleOf(users.get(s(personId)));
    if (!(role.role === "NON_SELLER" && role.proven)) return { ok: true };
    const verdict = resolveRoleConflict({
      footprint: footprintOf(personId), dealCurrentCategoryId: cat,
      dealEverInPostSale: postSaleAt !== null || inPostSale,
    });
    if (verdict.resolution === "KEEP" && dealStillInSales) { flags.push(`ROLE_CONFLICT_RESOLVED:${verdict.basis}`); return { ok: true }; }
    flags.push(`ROLE_CONFLICT_UNRESOLVED:${verdict.basis}`);
    return { ok: false };
  };

  // 1. Truly trustworthy frozen seller.
  let trustworthy = null;
  if (src === "STAGE_MOVER") {
    if (atPayment) trustworthy = "MOVER_AT_PAYMENT_STAGE";
    else if (frozen !== null && postSaleAt !== null && frozen < postSaleAt) trustworthy = "FROZEN_BEFORE_POST_SALE_ENTRY";
  } else if (src === "FIRST_CALL" && atPayment && movedBy && movedBy === snapshot.managerId) {
    trustworthy = "FIRST_CALL_CORROBORATED_BY_PAYMENT_STAGE_MOVER";
  }
  if (trustworthy) {
    if (observerVerdict?.state === OBSERVER_STATE.EXACT_ONE && observerVerdict.candidates[0] !== snapshot.managerId) {
      flags.push(`OBSERVER_NAMES_ANOTHER_SELLER:${observerVerdict.candidates[0]}`);
    }
    if (guard(snapshot.managerId, atPayment).ok) {
      return { action: ACTION.KEEP, basis: trustworthy, sellerId: snapshot.managerId, flags, provenUnsafe: false };
    }
    return { action: ACTION.REVIEW, basis: `CONTRADICTED_${trustworthy}`, sellerId: null, flags, provenUnsafe: false };
  }

  // Is the FROZEN seller proven unsafe? Lack of proof that it is right is not
  // the same as proof that it is wrong, and clearing a plausible seller would
  // destroy good attribution.
  //
  //  - FIRST_CALL: unsafe by approved policy — a call is not seller evidence.
  //  - CUSTOM_FIELD / unproven STAGE_MOVER: the frozen value is ASSIGNED_BY_ID or
  //    an unproven mover, which the post-sale handoff corrupts. That mechanism
  //    needs the handoff, so a Deal that never left Sales and names real Sales
  //    staff is NOT proven unsafe; it is merely unproven, and stays untouched.
  const leftSales = inPostSale || postSaleAt !== null || !SALES_CATS.has(cat);
  const frozenRole = roleOf(users.get(s(snapshot.managerId)));
  const frozenIsSalesStaff = frozenRole.role === "SELLER" || isSalesStaffByFootprint(footprintOf(snapshot.managerId)).ok;
  const provenUnsafe = src === "FIRST_CALL"
    ? true
    : (src === "CUSTOM_FIELD" || src === "STAGE_MOVER") && (leftSales || !frozenIsSalesStaff);
  if (!provenUnsafe && (src === "CUSTOM_FIELD" || src === "STAGE_MOVER")) {
    flags.push("FROZEN_SELLER_UNPROVEN_BUT_NOT_PROVEN_UNSAFE:deal never left Sales and names Sales staff");
  }

  // 2. Payment-stage mover.
  if (atPayment && movedBy) {
    if (guard(movedBy, true).ok) {
      return { action: ACTION.MOVER, basis: "MOVER_WHILE_CURRENT_STAGE_IS_PAYMENT", sellerId: movedBy, flags, provenUnsafe };
    }
    return { action: ACTION.REVIEW, basis: "PAYMENT_MOVER_ROLE_CONTRADICTED", sellerId: null, flags, provenUnsafe };
  }

  // 3. Category-13 observer.
  if (inPostSale) {
    if (observerVerdict?.state === OBSERVER_STATE.EXACT_ONE) {
      const sellerId = observerVerdict.candidates[0];
      const role = roleOf(users.get(s(sellerId)));
      if (role.role === "SELLER") {
        return { action: ACTION.OBSERVER, basis: "SINGLE_CATEGORY_13_OBSERVER_CANDIDATE", sellerId, flags, provenUnsafe };
      }
      // A non-seller title is overridden by a clean Sales footprint; the Deal
      // being in post-sale is expected here and proves nothing about the person.
      const byFootprint = isSalesStaffByFootprint(footprintOf(sellerId));
      if (byFootprint.ok) {
        flags.push(`OBSERVER_TITLE_OVERRIDDEN_BY_FOOTPRINT:${byFootprint.basis}`);
        return { action: ACTION.OBSERVER, basis: "SINGLE_CATEGORY_13_OBSERVER_CANDIDATE", sellerId, flags, provenUnsafe };
      }
      flags.push(`OBSERVER_CANDIDATE_NOT_SALES_STAFF:${byFootprint.basis}`);
      return { action: ACTION.REVIEW, basis: "OBSERVER_CANDIDATE_ROLE_CONTRADICTED", sellerId: null, flags, provenUnsafe };
    }
    if (observerVerdict?.state === OBSERVER_STATE.MULTIPLE) {
      return { action: ACTION.REVIEW, basis: `AMBIGUOUS_${observerVerdict.candidates.length}_OBSERVER_CANDIDATES`, sellerId: null, flags, provenUnsafe };
    }
    return { action: ACTION.UNKNOWN, basis: `POST_SALE_${observerVerdict?.state ?? OBSERVER_STATE.NOT_CACHED}`, sellerId: null, flags, provenUnsafe };
  }

  if (observerVerdict?.candidates?.length) flags.push(`OBSERVER_IGNORED_OUTSIDE_CATEGORY_13:category=${cat || "unknown"}`);
  return { action: ACTION.UNKNOWN, basis: "NO_SALE_TIME_EVIDENCE", sellerId: null, flags, provenUnsafe };
}

/** Loads every input this certification needs. Read-only, from .audit exports. */
export async function loadEvidence(inDir) {
  const read = async (name) => d1Rows(await readFile(new URL(name, inDir), "utf8"));
  const [snapRows, stgDeals, stgHist, prodDeals, prodHist, foot] = await Promise.all([
    read("snapshots.json"), read("f-deals.json"), read("f-hist.json"),
    read("p-deals.json"), read("p-hist.json"), read("stg-foot.json"),
  ]);
  const usersText = await readFile(new URL("stg-users.json", inDir), "utf8");
  const usersArr = JSON.parse(JSON.parse(usersText.slice(usersText.indexOf("["), usersText.lastIndexOf("]") + 1))[0].results[0].payload);
  const users = new Map(usersArr.map((u) => [String(u.ID), u]));

  const histOf = (rows) => new Map(rows.map((r) => [s(r.deal_id), r]));
  const stagingHist = histOf(stgHist);
  const productionHist = histOf(prodHist);
  const build = (rows, hist, withObservers) => new Map(rows.map((r) => {
    const h = hist.get(s(r.deal_id)) ?? {};
    return [s(r.deal_id), {
      cat: s(r.cat), stage: s(r.stage), created: ms(r.created), movedTime: ms(r.moved_time),
      movedBy: s(r.moved_by), assigned: s(r.assigned), opportunity: Number(r.opportunity ?? 0) || 0,
      currency: s(r.currency), paymentAt: s(h.payment_at) || null, postSaleAt: s(h.post_sale_at) || null,
      salesAt: s(h.sales_at) || null, observers: withObservers ? r.observers : undefined, source: withObservers ? "staging" : "production",
    }];
  }));
  const staging = build(stgDeals, stagingHist, true);
  const production = build(prodDeals, productionHist, false);
  const footprint = new Map();
  for (const r of foot) {
    const m = s(r.mid); const f = footprint.get(m) ?? {};
    f[s(r.cat)] = (f[s(r.cat)] ?? 0) + r.n; footprint.set(m, f);
  }
  return { snapRows, staging, production, users, footprint };
}

export function normalizeObservers(raw) {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
