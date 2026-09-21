#!/usr/bin/env node

// FINAL staging seller repair manifest (read-only).
//
// Inputs: the staging-only exports in .audit/staging-in (scripts/staging-seller-export.sh),
// taken after run cad62108-933e-429c-8b3c-ad31564c6c33 completed. Production is never read.
//
// Outputs (.audit/seller-repair-staging/, 0600):
//   reviewed-invalidate.json   { reviewed: true, dealIds } — Codex's repair CLI input
//   keep-trustworthy.json      rows kept, with basis
//   human-review.json          rows no rule may decide
//   owner-confirmed-overrides.json
//   classification.json        all snapshots, one final action each
//   backfill-prediction.json   per manifest row: what the DEPLOYED Backfill chain will write
//   summary.txt
//
// Nothing here opens a database, starts a sync/backfill/repair, or deploys.

import { mkdir, writeFile } from "node:fs/promises";
import { ACTION, isSalesStaffByFootprint } from "./seller-final-certification.mjs";
import { roleOf } from "./seller-repair-manifest.mjs";
import { loadOwnerOverrides, overrideManifest } from "./owner-seller-overrides.mjs";
import { classifyAll, derivedSales, loadStaging, normalizeObservers, requireCompleteSnapshots } from "./staging-seller-manifest.mjs";

export const OWNER = "INVALIDATE_THEN_OWNER_OVERRIDE";
export const FINAL_ACTIONS = Object.freeze([ACTION.KEEP, ACTION.MOVER, ACTION.OBSERVER, OWNER, ACTION.UNKNOWN, ACTION.REVIEW]);
const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const cmp = (a, b) => a.length - b.length || a.localeCompare(b);

/** Staging settings read on 2026-09-21 (read-only SELECT on app_settings). */
export const STAGING_SETTINGS = Object.freeze({ mainIds: ["3"], postSaleIds: ["13"], paymentStageIds: ["C3:WON"], salesManagerField: null });

/** Maps the owner-override verdict onto the six final actions. */
export function finalAction(row) {
  if (row.action !== "OWNER_CONFIRMED_SELLER") return row.action;
  return row.provenUnsafe ? OWNER : ACTION.KEEP;
}

/**
 * What lib/analytics.ts on origin/feat/analytics-integration (46945eb) writes for a WON
 * Deal whose snapshot seller was cleared to UNKNOWN — its exact fallback order:
 *   CUSTOM_FIELD (only with a safe UF_CRM_* field; staging has none)
 *   → STAGE_MOVER  (MOVED_BY_ID while the current stage is payment, main funnel)
 *   → POST_SALE_OBSERVER (post-sale funnel, observers minus assignee, exactly one)
 *   → UNKNOWN (CURRENT_RESPONSIBLE is never used for a WON Deal)
 * The deployed chain has NO role/footprint guard and NO owner-confirmed source.
 */
export function deployedBackfill(evidence, settings = STAGING_SETTINGS) {
  if (!evidence) return { source: "UNKNOWN", sellerId: null, basis: "NO_RAW_DEAL" };
  if (settings.salesManagerField) return { source: "CUSTOM_FIELD", sellerId: null, basis: "CONFIGURED_FIELD" };
  const cat = s(evidence.cat);
  if (s(evidence.movedBy) && settings.mainIds.includes(cat) && settings.paymentStageIds.includes(s(evidence.stage))) {
    return { source: "STAGE_MOVER", sellerId: s(evidence.movedBy), basis: "MOVER_AT_PAYMENT" };
  }
  if (settings.postSaleIds.includes(cat)) {
    const raw = normalizeObservers(evidence.observers);
    const assigned = s(evidence.assigned);
    const candidates = Array.isArray(raw) ? [...new Set(raw.map(s).filter((id) => /^[1-9]\d*$/.test(id)))].filter((id) => id !== assigned) : [];
    if (candidates.length === 1) return { source: "POST_SALE_OBSERVER", sellerId: candidates[0], basis: "SINGLE_OBSERVER" };
    return { source: "UNKNOWN", sellerId: null, basis: `OBSERVER_CANDIDATES_${candidates.length}` };
  }
  return { source: "UNKNOWN", sellerId: null, basis: `NO_RULE_FOR_CATEGORY_${cat || "NONE"}` };
}

/** Dry-run counts exactly as scripts/invalidate-seller-snapshots.ts computes them. */
export function expectedDryRun(dealIds, snapshotsById) {
  const unique = [...new Set(dealIds)];
  const matched = unique.filter((id) => snapshotsById.has(id));
  const wouldChange = matched.filter((id) => {
    const r = snapshotsById.get(id);
    return r.managerId !== null || r.managerName !== null || r.attributionSource !== "UNKNOWN";
  });
  return { requested: unique.length, matched: matched.length, missing: unique.length - matched.length, wouldChange: wouldChange.length };
}

function name(users, id) { const u = users.get(s(id)); return u ? `${u.NAME ?? ""} ${u.LAST_NAME ?? ""}`.trim() : null; }
const tally = (items, key) => { const m = new Map(); for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1); return Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))); };

async function main() {
  const inDir = new URL("../.audit/staging-in/", import.meta.url);
  const outDir = new URL("../.audit/seller-repair-staging/", import.meta.url);
  const overrides = loadOwnerOverrides();
  const staging = await loadStaging(inDir);
  const { snapshots, evidence, footprint, users, progress } = staging;
  const sales = derivedSales(evidence);
  const gate = requireCompleteSnapshots({
    analytics: Number(progress.analytics ?? 0), raws: Number(progress.raws ?? 0),
    snapshots: snapshots.length, expectedSnapshots: sales.all.length, job: progress.job,
  });
  const job = (() => { try { return JSON.parse(progress.job); } catch { return {}; } })();
  const snapshotsById = new Map(snapshots.map((r) => [r.dealId, r]));
  const salesStaff = (id) => Boolean(id) && (roleOf(users.get(s(id))).role === "SELLER" || isSalesStaffByFootprint(footprint.get(s(id)) ?? {}).ok);

  const rows = classifyAll({ snapshots, evidence, footprint, users, overrides }).map((r) => {
    let action = finalAction(r);
    // The frozen seller is independently unsafe when the person is not Sales
    // staff by BOTH title and footprint — whatever the Deal evidence says, and
    // even when the Deal has no raw evidence at all.
    const frozenNonSales = Boolean(r.managerId) && !salesStaff(r.managerId);
    const provenUnsafe = r.provenUnsafe === true || (action !== ACTION.KEEP && frozenNonSales);
    const candidate = action !== ACTION.KEEP && provenUnsafe;
    const predicted = candidate ? deployedBackfill(evidence.get(r.dealId)) : null;
    const creditsNonSales = predicted?.sellerId ? !salesStaff(predicted.sellerId) : false;
    // A repair must not manufacture a new wrong credit. When the deployed
    // Backfill (which has no role guard) would hand the Deal to a non-Sales
    // person, the row stays out of the manifest and goes to a human, frozen
    // seller untouched — even though that frozen value is itself unproven.
    const flags = [...r.flags];
    if (frozenNonSales) flags.push(`FROZEN_SELLER_NOT_SALES_STAFF:${r.managerId}`);
    if (creditsNonSales) { action = ACTION.REVIEW; flags.push(`EXCLUDED_BACKFILL_WOULD_CREDIT_NON_SALES:${predicted.sellerId}`); }
    const inManifest = candidate && !creditsNonSales;
    const auditSeller = action === ACTION.KEEP ? r.managerId : [ACTION.MOVER, ACTION.OBSERVER, OWNER].includes(action) ? r.newSellerId : null;
    return {
      ...r, provenUnsafe, frozenNonSales, action, flags, inManifest, auditSeller, auditSellerName: auditSeller ? (name(users, auditSeller) ?? r.managerName) : null,
      deployedBackfill: predicted,
      backfillAgreesWithAudit: predicted ? s(predicted.sellerId) === s(auditSeller) : null,
      backfillCreditsNonSales: inManifest && creditsNonSales,
      excludedNonSalesCredit: creditsNonSales,
    };
  });
  for (const r of rows) if (!FINAL_ACTIONS.includes(r.action)) throw new Error(`unmapped action ${r.action} on ${r.dealId}`);

  const manifestRows = rows.filter((r) => r.inManifest);
  const manifestIds = manifestRows.map((r) => r.dealId).sort(cmp);
  const dryRun = expectedDryRun(manifestIds, snapshotsById);

  /* ---- post-repair + Backfill prediction for all snapshots (deployed code) ---- */
  const after = rows.map((r) => {
    if (!r.inManifest) {
      const src = r.attributionSource || "UNKNOWN";
      return { dealId: r.dealId, source: src, sellerId: r.managerId, kept: true };
    }
    return { dealId: r.dealId, source: r.deployedBackfill.source, sellerId: r.deployedBackfill.sellerId, kept: false };
  });
  const afterById = new Map(after.map((a) => [a.dealId, a]));

  /* ---- September certification ---- */
  const reviewIds = new Set(rows.filter((r) => r.action === ACTION.REVIEW).map((r) => r.dealId));
  const septemberRows = (population) => population.map((x) => {
    const r = rows.find((row) => row.dealId === x.id);
    const auditSource = !r ? "UNKNOWN / REVIEW"
      : r.action === OWNER ? "OWNER_CONFIRMED"
        : r.action === ACTION.KEEP ? (r.basis.includes("OBSERVER") || r.attributionSource === "POST_SALE_OBSERVER" ? "TRUSTED_SNAPSHOT(POST_SALE_OBSERVER)" : `TRUSTED_SNAPSHOT(${r.attributionSource})`)
          : r.action === ACTION.MOVER ? "STAGE_MOVER"
            : r.action === ACTION.OBSERVER ? "POST_SALE_OBSERVER" : "UNKNOWN / REVIEW";
    const a = afterById.get(x.id);
    return {
      id: x.id, auditSource, auditSeller: r?.auditSeller ?? null, auditSellerName: r?.auditSellerName ?? null,
      frozen: r ? `${r.attributionSource}:${r.managerId ?? "-"}` : "none",
      afterSource: a?.source ?? "UNKNOWN", afterSeller: a?.sellerId ?? null,
      review: reviewIds.has(x.id),
    };
  });
  const cohort = septemberRows(sales.cohort);
  const period = septemberRows(sales.period);
  const covered = (list, key) => list.filter((x) => x[key]).length;

  /* ---- files ---- */
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const write = (file, payload) => writeFile(new URL(file, outDir), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const complete = gate.complete;
  await write("reviewed-invalidate.json", complete ? { reviewed: true, dealIds: manifestIds } : { reviewed: false, dealIds: [], pendingEvidence: gate.reasons });
  await write("keep-trustworthy.json", rows.filter((r) => r.action === ACTION.KEEP).map((r) => ({ dealId: r.dealId, sellerId: r.managerId, sellerName: r.managerName, attributionSource: r.attributionSource, basis: r.basis, flags: r.flags })));
  await write("human-review.json", rows.filter((r) => r.action === ACTION.REVIEW).map((r) => ({ dealId: r.dealId, frozenSellerId: r.managerId, frozenSellerName: r.managerName, attributionSource: r.attributionSource, frozenProvenUnsafe: r.provenUnsafe, inManifest: r.inManifest, basis: r.basis, observerCandidates: r.observerCandidates, currentCategoryId: r.currentCategoryId, currentStageId: r.currentStageId, deployedBackfill: r.deployedBackfill, flags: r.flags })));
  await write("owner-confirmed-overrides.json", overrideManifest(overrides));
  await write("classification.json", rows.map((r) => ({ dealId: r.dealId, action: r.action, inManifest: r.inManifest, basis: r.basis, frozen: { sellerId: r.managerId, sellerName: r.managerName, source: r.attributionSource }, auditSeller: r.auditSeller, observerState: r.observerState, observerCandidates: r.observerCandidates, deployedBackfill: r.deployedBackfill, flags: r.flags })));
  await write("backfill-prediction.json", manifestRows.map((r) => ({ dealId: r.dealId, action: r.action, auditSeller: r.auditSeller, deployedBackfill: r.deployedBackfill, agrees: r.backfillAgreesWithAudit, creditsNonSales: r.backfillCreditsNonSales })));

  /* ---- summary ---- */
  const L = [];
  const byAction = tally(rows, (r) => r.action);
  const divergent = manifestRows.filter((r) => !r.backfillAgreesWithAudit);
  const contaminating = manifestRows.filter((r) => r.backfillCreditsNonSales);
  const orphans = rows.filter((r) => r.basis === "ORPHAN_SNAPSHOT_NO_RAW_DEAL_IN_STAGING");
  L.push("FINAL STAGING SELLER REPAIR MANIFEST", "=".repeat(78));
  L.push(`generated ${new Date().toISOString()} | READ-ONLY | staging only | no sync/backfill/repair/deploy`);
  L.push(`sync run ${job.runId ?? "?"} status=${job.status ?? "?"} phase=${job.phase ?? "?"} ${job.processed ?? "?"}/${job.total ?? "?"}`);
  L.push(`analytics ${progress.analytics}/${progress.raws} | stage-history Deals ${progress.history_deals} | raw Deals with observers ${progress.observers}`);
  L.push(`population gate: ${complete ? "COMPLETE" : `INCOMPLETE — ${gate.reasons.join("; ")}`}`);

  L.push("", "A. EVIDENCE");
  L.push(`   snapshots ${snapshots.length} | derived WON ${sales.all.length} | Cohort ${sales.cohort.length} | Period ${sales.period.length} | Deal 40099 in period: ${sales.period.some((x) => x.id === "40099") ? "YES" : "NO"}`);
  L.push(`   current snapshot sources: ${JSON.stringify(tally(rows, (r) => r.attributionSource || "(empty)"))}`);
  L.push(`   orphan snapshots (no raw Deal in staging, outside analytics, no KPI effect): ${orphans.length} — ${orphans.map((r) => r.dealId).sort(cmp).join(", ")}`);

  L.push("", "B. CLASSIFICATION OF ALL SNAPSHOTS (exactly one action each)");
  for (const action of FINAL_ACTIONS) L.push(`   ${action.padEnd(40)} ${byAction[action] ?? 0}`);
  L.push(`   total ${rows.length}`);
  L.push("   by current source → action:");
  for (const [k, v] of Object.entries(tally(rows, (r) => `${r.attributionSource} → ${r.action}${r.inManifest ? " [manifest]" : ""}`))) L.push(`     ${k}: ${v}`);

  L.push("", "C. SEPTEMBER CERTIFICATION (audit evidence)");
  for (const [label, list] of [["Cohort", cohort], ["Period", period]]) {
    L.push(`   ${label} ${list.length}: ${JSON.stringify(tally(list, (x) => x.auditSource))}`);
    L.push(`     resolved by evidence: ${covered(list, "auditSeller")} / ${list.length}`);
  }
  L.push("   per sale (id | audit source | seller | frozen now | after repair+Backfill on deployed code):");
  for (const x of period) L.push(`     ${x.id.padEnd(6)} | ${x.auditSource.padEnd(38)} | ${(x.auditSeller ?? "-").padEnd(6)} ${(x.auditSellerName ?? "").padEnd(22)} | ${x.frozen.padEnd(26)} | ${x.afterSource}:${x.afterSeller ?? "-"}${sales.cohort.some((c) => c.id === x.id) ? "" : "  (period only)"}`);
  L.push("   seller breakdown, Period Sales (audit):");
  for (const [k, v] of Object.entries(tally(period, (x) => (x.auditSeller ? `${x.auditSeller} ${x.auditSellerName ?? ""}` : "UNKNOWN")))) L.push(`     ${k}: ${v}`);
  L.push("   seller breakdown, Cohort Sales (audit):");
  for (const [k, v] of Object.entries(tally(cohort, (x) => (x.auditSeller ? `${x.auditSeller} ${x.auditSellerName ?? ""}` : "UNKNOWN")))) L.push(`     ${k}: ${v}`);
  const creditedNonSales = [...cohort, ...period].filter((x) => x.auditSeller && !salesStaff(x.auditSeller));
  L.push(`   September sales credited to a non-Sales person (audit): ${creditedNonSales.length}`);

  L.push("", "D. MANIFEST");
  L.push(`   reviewed-invalidate.json: reviewed=${complete} dealIds=${manifestIds.length}`);
  L.push(`   composition: ${JSON.stringify(tally(manifestRows, (r) => r.action))}`);
  L.push(`   by current source: ${JSON.stringify(tally(manifestRows, (r) => r.attributionSource))}`);
  L.push(`   excluded — KEEP ${byAction[ACTION.KEEP] ?? 0}; not proven unsafe ${rows.filter((r) => r.action !== ACTION.KEEP && !r.provenUnsafe).length}; proven unsafe but Backfill would credit a non-Sales person ${rows.filter((r) => r.excludedNonSalesCredit).length} (${rows.filter((r) => r.excludedNonSalesCredit).map((r) => `${r.dealId}→${r.deployedBackfill.sellerId}`).join(", ")})`);

  L.push("", "E. EXPECTED DRY-RUN (scripts/invalidate-seller-snapshots.ts --dry-run)");
  L.push(`   requested ${dryRun.requested} | matched ${dryRun.matched} | missing ${dryRun.missing} | wouldChange ${dryRun.wouldChange}`);

  L.push("", "F. EXPECTED AFTER repair apply → Analytics Backfill (deployed code 46945eb)");
  L.push(`   snapshot sources after: ${JSON.stringify(tally(after, (a) => a.source))}`);
  L.push(`   kept unchanged: ${after.filter((a) => a.kept).length} | rewritten by Backfill: ${after.filter((a) => !a.kept && a.sellerId).length} | cleared to UNKNOWN: ${after.filter((a) => !a.kept && !a.sellerId).length}`);
  L.push(`   OWNER_CONFIRMED after Backfill: ${after.filter((a) => a.source === "OWNER_CONFIRMED").length} — the deployed code has no OWNER_CONFIRMED source or write path`);
  L.push(`   manifest rows where deployed Backfill disagrees with the audit: ${divergent.length}`);
  for (const r of divergent) L.push(`     ${r.dealId}: audit ${r.action} → ${r.auditSeller ?? "none"} | Backfill ${r.deployedBackfill.source}:${r.deployedBackfill.sellerId ?? "-"} (${r.deployedBackfill.basis})${r.backfillCreditsNonSales ? " NON-SALES" : ""}`);
  L.push(`   manifest rows where Backfill would credit a non-Sales person: ${contaminating.length}${contaminating.length ? ` — ${contaminating.map((r) => `${r.dealId}:${r.deployedBackfill.sellerId}`).join(", ")}` : ""}`);
  L.push("   seller analytics coverage vs snapshot persistence:");
  L.push("     f165432 persists the recovered seller during Backfill, so for every Deal with a snapshot the");
  L.push("     analytics seller equals the persisted snapshot seller; the two coverages are the same number.");
  L.push(`     historical snapshots with a seller after Backfill: ${after.filter((a) => a.sellerId).length} / ${after.length}`);

  L.push("", "G. CERTIFICATION");
  L.push(`   September Cohort manager coverage — audit evidence: ${covered(cohort, "auditSeller")} / ${cohort.length}; deployed code after repair+Backfill: ${covered(cohort, "afterSeller")} / ${cohort.length}`);
  L.push(`   September Period manager coverage — audit evidence: ${covered(period, "auditSeller")} / ${period.length}; deployed code after repair+Backfill: ${covered(period, "afterSeller")} / ${period.length}`);
  L.push(`   Historical staging snapshot coverage — audit evidence: ${rows.filter((r) => r.auditSeller).length} / ${rows.length}; deployed code after repair+Backfill: ${after.filter((a) => a.sellerId).length} / ${after.length}`);
  const remaining = rows.filter((r) => !r.auditSeller).sort((a, b) => cmp(a.dealId, b.dealId)).map((r) => `${r.dealId}(${r.action === ACTION.REVIEW ? "REVIEW" : "UNKNOWN"}:${r.excludedNonSalesCredit ? "BACKFILL_WOULD_CREDIT_NON_SALES" : r.basis}${r.inManifest ? "" : r.managerId ? `; frozen ${r.attributionSource}:${r.managerId} kept` : ""})`);
  L.push(`   remaining without a seller by audit evidence (${remaining.length}):`);
  for (const line of remaining) L.push(`     ${line}`);
  L.push("", "=".repeat(78));
  const text = `${L.join("\n")}\n`;
  await writeFile(new URL("summary.txt", outDir), text, { mode: 0o600 });
  process.stdout.write(text);
  if (!complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
