#!/usr/bin/env node

// Builds the seller-snapshot repair manifest from read-only D1 exports.
//
// Splits every `deal_sales_snapshots` row into three buckets:
//   DEFINITELY_INVALID_SELLER_SNAPSHOT  safe to clear the seller on
//   TRUSTWORTHY_SELLER_SNAPSHOT         must not be touched
//   UNKNOWN_REVIEW_REQUIRED             needs a human; never changed automatically
//
// It opens no database and calls no API: it reads the JSON exports produced by
// the read-only SELECTs in docs/OPERATIONS.md. It emits a manifest of Deal IDs
// and nothing else — no webhook, no raw Deal payloads. It performs no repair.
//
// Seller attribution is the ONLY field the downstream repair may touch. wonAt,
// OPPORTUNITY, sales/lead status, source and stage history are out of scope and
// are never emitted as changes here.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = path.resolve(scriptDir, "../.audit/seller-repair");

export const BUCKETS = Object.freeze({
  INVALID: "DEFINITELY_INVALID_SELLER_SNAPSHOT",
  TRUSTWORTHY: "TRUSTWORTHY_SELLER_SNAPSHOT",
  UNKNOWN: "UNKNOWN_REVIEW_REQUIRED",
});

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const ms = (v) => { const p = Date.parse(str(v)); return Number.isFinite(p) ? p : null; };

export function compareIds(a, b) {
  const x = String(a); const y = String(b);
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return x.length - y.length || x.localeCompare(y);
  return x.localeCompare(y);
}

/** Reads one `wrangler d1 execute --json` document, whatever wrapper it used. */
export function d1Rows(text) {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("no JSON array in export");
  const parsed = JSON.parse(text.slice(start, text.lastIndexOf("]") + 1));
  return parsed.flatMap((set) => (Array.isArray(set?.results) ? set.results : []));
}

/**
 * One snapshot's bucket.
 *
 * `configuredFieldWasAssignedBy` is the proven fact that makes a CUSTOM_FIELD
 * row invalid: the "custom field" the sync read was ASSIGNED_BY_ID, the current
 * responsible person, which the approved rule never accepts as seller evidence.
 *
 * STAGE_MOVER is treated conservatively. It is trustworthy when the mover is
 * provably sale-time evidence, and otherwise goes to review — never to the
 * invalid bucket merely because the Deal has since moved to post-sale.
 */
export function classify({ snapshot, record, raw, postSaleEnteredAt, paymentStageIds, postSaleCategoryId, configuredFieldWasAssignedBy, acceptFirstCall }) {
  const source = snapshot.attributionSource;
  const cat = str(record?.categoryId);
  const atPaymentStage = Boolean(record && paymentStageIds.includes(str(record.stageId)));
  const frozen = ms(snapshot.frozenAt);
  const postSale = ms(postSaleEnteredAt);
  const out = (bucket, reason) => ({ bucket, reason });

  if (source === "CUSTOM_FIELD") {
    if (!configuredFieldWasAssignedBy) return out(BUCKETS.UNKNOWN, "CUSTOM_FIELD_SOURCE_UNVERIFIED");
    return out(BUCKETS.INVALID, "CUSTOM_FIELD_WAS_ASSIGNED_BY_ID_NOT_A_SELLER_FIELD");
  }

  if (source === "FIRST_CALL") {
    if (acceptFirstCall) return out(BUCKETS.UNKNOWN, "FIRST_CALL_SEMANTICS_STILL_ACCEPTED");
    // A call-derived seller is no longer accepted evidence, but if the approved
    // priority-3 evidence independently names the same person, keep it.
    const mover = str(raw?.movedBy);
    if (atPaymentStage && mover && mover === snapshot.managerId) {
      return out(BUCKETS.TRUSTWORTHY, "FIRST_CALL_CORROBORATED_BY_PAYMENT_STAGE_MOVER");
    }
    return out(BUCKETS.INVALID, "FIRST_CALL_LEGACY_SOURCE_NO_STRONGER_EVIDENCE");
  }

  if (source === "STAGE_MOVER") {
    if (atPaymentStage && cat && cat !== String(postSaleCategoryId)) {
      return out(BUCKETS.TRUSTWORTHY, "MOVER_AT_PAYMENT_STAGE");
    }
    if (frozen !== null && postSale !== null) {
      return frozen < postSale
        ? out(BUCKETS.TRUSTWORTHY, "FROZEN_BEFORE_POST_SALE_ENTRY")
        : out(BUCKETS.UNKNOWN, "FROZEN_AFTER_POST_SALE_ENTRY_NEEDS_HUMAN_EVIDENCE");
    }
    return out(BUCKETS.UNKNOWN, "STAGE_MOVER_NO_TIMING_EVIDENCE");
  }

  return out(BUCKETS.UNKNOWN, `UNRECOGNISED_ATTRIBUTION_SOURCE_${source || "EMPTY"}`);
}

/** Manifest row: Deal identity, seller identity, and the evidence. Nothing else. */
export function manifestRow({ snapshot, record, bucket, reason }) {
  return {
    dealId: snapshot.dealId,
    managerId: snapshot.managerId || null,
    managerName: snapshot.managerName || null,
    attributionSource: snapshot.attributionSource || null,
    wonAt: snapshot.wonAt || null,
    snapshotCreatedAt: snapshot.frozenAt || null,
    currentCategoryId: record ? str(record.categoryId) || null : null,
    currentAssignedManagerId: record ? str(record.assignedId) || null : null,
    reason,
    opportunity: record ? Number(record.opportunity ?? 0) || 0 : null,
    currency: record ? str(record.currency) || null : null,
    bucket,
  };
}

export function quantify(rows) {
  const uzs = rows.filter((r) => (r.currency ?? "UZS") === "UZS").reduce((sum, r) => sum + Math.round((r.opportunity ?? 0) * 100), 0);
  const tally = (key) => {
    const counts = new Map();
    for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  };
  return {
    deals: rows.length,
    uzsOpportunity: (uzs / 100).toFixed(2),
    byAttributionSource: tally((r) => r.attributionSource ?? "(none)"),
    byManager: tally((r) => `${r.managerId ?? "(none)"} ${r.managerName ?? ""}`.trim()),
    byReason: tally((r) => r.reason),
  };
}

export async function build({ inDir, outDir, cohortFrom, cohortTo, paymentStageIds, postSaleCategoryId, configuredFieldWasAssignedBy = true, acceptFirstCall = false }) {
  const read = async (name) => d1Rows(await readFile(path.join(inDir, name), "utf8"));
  const [snapRows, joinedRows, postSaleRows, rawRows] = await Promise.all([
    read("snapshots.json"), read("joined.json"), read("postsale.json"), read("rawstate.json"),
  ]);

  const snapshots = snapRows.map((r) => ({
    dealId: str(r.deal_id), wonAt: str(r.won_at) || null, managerId: str(r.manager_id) || null,
    managerName: str(r.manager_name) || null, attributionSource: str(r.attribution_source),
    frozenAt: str(r.created_at) || null,
  }));
  const records = new Map(joinedRows.filter((r) => r.category_id !== null).map((r) => [str(r.deal_id), {
    categoryId: r.category_id, stageId: r.stage_id, assignedId: r.assigned_id,
    opportunity: r.opportunity, currency: r.currency,
  }]));
  const postSale = new Map(postSaleRows.map((r) => [str(r.deal_id), str(r.first_post_sale)]));
  const rawState = new Map(rawRows.map((r) => [str(r.deal_id), { movedBy: str(r.moved_by), stage: str(r.stage) }]));

  const rows = snapshots.map((snapshot) => {
    const record = records.get(snapshot.dealId) ?? null;
    const verdict = classify({
      snapshot, record, raw: rawState.get(snapshot.dealId) ?? null,
      postSaleEnteredAt: postSale.get(snapshot.dealId) ?? null,
      paymentStageIds, postSaleCategoryId, configuredFieldWasAssignedBy, acceptFirstCall,
    });
    return manifestRow({ snapshot, record, ...verdict });
  }).sort((a, b) => compareIds(a.dealId, b.dealId));

  const bucketed = {
    [BUCKETS.INVALID]: rows.filter((r) => r.bucket === BUCKETS.INVALID),
    [BUCKETS.TRUSTWORTHY]: rows.filter((r) => r.bucket === BUCKETS.TRUSTWORTHY),
    [BUCKETS.UNKNOWN]: rows.filter((r) => r.bucket === BUCKETS.UNKNOWN),
  };
  // Cohort membership uses the Deal's own creation date from the cached record.
  const created = new Map(joinedRows.map((r) => [str(r.deal_id), ms(r.deal_created)]));
  const fromMs = Date.parse(`${cohortFrom}T00:00:00+05:00`);
  const toMs = Date.parse(`${cohortTo}T00:00:00+05:00`) + 86_400_000;
  const inCohort = (r) => { const c = created.get(r.dealId); return c !== null && c !== undefined && c >= fromMs && c < toMs; };

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const write = async (name, payload) => writeFile(path.join(outDir, name), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await write("definitely-invalid.json", bucketed[BUCKETS.INVALID]);
  await write("trustworthy.json", bucketed[BUCKETS.TRUSTWORTHY]);
  await write("unknown-review.json", bucketed[BUCKETS.UNKNOWN]);

  return {
    totals: Object.fromEntries(Object.entries(bucketed).map(([k, v]) => [k, quantify(v)])),
    cohort: Object.fromEntries(Object.entries(bucketed).map(([k, v]) => {
      const inside = v.filter(inCohort);
      return [k, { deals: inside.length, dealIds: inside.map((r) => r.dealId), uzsOpportunity: quantify(inside).uzsOpportunity }];
    })),
    snapshotsTotal: rows.length,
    outDir,
  };
}
