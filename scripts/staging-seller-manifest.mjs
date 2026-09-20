#!/usr/bin/env node

// Staging-only seller repair manifest + post-repair certification report.
//
// Reads ONLY the staging exports in .audit/staging-in (see
// scripts/staging-seller-export.sh). Production snapshots are never consulted:
// staging has its own snapshot population and must be repaired on its own
// evidence.
//
//   node scripts/staging-seller-manifest.mjs manifest   # TASK B
//   node scripts/staging-seller-manifest.mjs certify    # TASK A
//
// It opens no database, starts no sync/backfill/repair and writes only .audit
// report files. `reviewed: true` is emitted only when the staging snapshot
// population is complete — see requireCompleteSnapshots below.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ACTION, certify, isSalesStaffByFootprint } from "./seller-final-certification.mjs";
import { classifyObservers, OBSERVER_STATE } from "./observer-seller-recovery.mjs";
import { roleOf } from "./seller-repair-manifest.mjs";
import { applyOwnerOverride, loadOwnerOverrides, overrideManifest } from "./owner-seller-overrides.mjs";

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const ms = (v) => { const p = Date.parse(s(v)); return Number.isFinite(p) ? p : null; };
const cmp = (a, b) => a.length - b.length || a.localeCompare(b);
export const PAYMENT_STAGES = Object.freeze(["C3:WON", "C5:WON"]);
export const SEPTEMBER = Object.freeze({ from: "2026-09-01", to: "2026-09-19", timezone: "Asia/Tashkent" });
const FROM = Date.parse("2026-09-01T00:00:00+05:00");
const TO = Date.parse("2026-09-19T00:00:00+05:00") + 86_400_000;

/** Reads one `wrangler d1 execute --json` document, ignoring any preamble. */
export function d1(text) {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("no JSON array in export");
  const parsed = JSON.parse(text.slice(start, text.lastIndexOf("]") + 1));
  return parsed.flatMap((set) => (Array.isArray(set?.results) ? set.results : []));
}

/**
 * `saveSalesSnapshots` runs inside the analytics phase (lib/sync.ts), page by
 * page, so a sync that has not finished analytics has not finished writing
 * snapshots. Emitting `reviewed: true` against a partial population would hand
 * on a manifest that silently omits a third of the rows.
 */
export function requireCompleteSnapshots({ analytics, raws, snapshots, expectedSnapshots, job }) {
  const parsedJob = (() => { try { return typeof job === "string" ? JSON.parse(job) : job; } catch { return null; } })();
  const phase = s(parsedJob?.phase);
  const status = s(parsedJob?.status);
  const reasons = [];
  if (analytics < raws) reasons.push(`ANALYTICS_INCOMPLETE:${analytics}/${raws}`);
  if (status === "running" || status === "paused") reasons.push(`SYNC_${status.toUpperCase()}:phase=${phase} ${s(parsedJob?.processed)}/${s(parsedJob?.total)}`);
  if (snapshots < expectedSnapshots) reasons.push(`SNAPSHOTS_INCOMPLETE:${snapshots}/${expectedSnapshots}`);
  return { complete: reasons.length === 0, reasons };
}

export async function loadStaging(inDir) {
  const read = async (name) => d1(await readFile(new URL(name, inDir), "utf8"));
  const [snaps, deals, history, footRows, usersRows, progressRows] = await Promise.all([
    read("snapshots.json"), read("deals.json"), read("history.json"),
    read("footprint.json"), read("users.json"), read("progress.json"),
  ]);
  const users = new Map(JSON.parse(usersRows[0].payload).map((u) => [String(u.ID), u]));
  const hist = new Map(history.map((r) => [s(r.deal_id), r]));
  const evidence = new Map(deals.map((r) => {
    const h = hist.get(s(r.deal_id)) ?? {};
    return [s(r.deal_id), {
      cat: s(r.cat), stage: s(r.stage), created: ms(r.created), movedTime: ms(r.moved_time),
      movedBy: s(r.moved_by), assigned: s(r.assigned), source: s(r.source),
      opportunity: Number(r.opportunity ?? 0) || 0, currency: s(r.currency), observers: r.observers,
      paymentAt: s(h.payment_at) || null, postSaleAt: s(h.post_sale_at) || null, salesAt: s(h.sales_at) || null,
    }];
  }));
  const footprint = new Map();
  for (const r of footRows) {
    const m = s(r.mid); const f = footprint.get(m) ?? {};
    f[s(r.cat)] = (f[s(r.cat)] ?? 0) + r.n; footprint.set(m, f);
  }
  const snapshots = snaps.map((r) => ({
    dealId: s(r.deal_id), wonAt: s(r.won_at) || null, managerId: s(r.manager_id) || null,
    managerName: s(r.manager_name) || null, attributionSource: s(r.attribution_source), frozenAt: s(r.created_at) || null,
  }));
  return { snapshots, evidence, footprint, users, progress: progressRows[0] ?? {} };
}

export function normalizeObservers(raw) {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Approved WON rule + wonAt policy, from raw evidence only. */
export function derivedSales(evidence) {
  const sales = [];
  for (const [id, ev] of evidence) {
    const paymentAt = ms(ev.paymentAt); const postSaleAt = ms(ev.postSaleAt);
    const currentPayment = PAYMENT_STAGES.includes(ev.stage);
    const won = paymentAt !== null || currentPayment || ev.cat === "13" || postSaleAt !== null;
    const everSales = ev.salesAt !== null || ev.cat === "3";
    if (!won || !everSales) continue;
    const wonAt = paymentAt ?? postSaleAt ?? (currentPayment ? ev.movedTime : null);
    sales.push({ id, ev, wonAt, created: ev.created });
  }
  const inRange = (t) => t !== null && t >= FROM && t < TO;
  return {
    all: sales,
    cohort: sales.filter((x) => inRange(x.created)),
    period: sales.filter((x) => inRange(x.wonAt)),
  };
}

export function classifyAll({ snapshots, evidence, footprint, users, overrides = loadOwnerOverrides() }) {
  const known = new Set(users.keys());
  const footOf = (id) => footprint.get(s(id)) ?? {};
  return snapshots.map((snapshot) => {
    const ev = evidence.get(snapshot.dealId) ?? null;
    const observerVerdict = ev && ev.observers !== undefined && ev.observers !== null
      ? classifyObservers({ deal: { observers: normalizeObservers(ev.observers) }, assignedById: ev.assigned, knownUserIds: known })
      : { state: OBSERVER_STATE.NOT_CACHED, candidates: [], observerIds: [], invalid: [] };
    // Owner confirmation outranks CRM evidence — it is the only evidence for a
    // Deal no rule can resolve. Disagreements are flagged, never hidden.
    const verdict = applyOwnerOverride({
      dealId: snapshot.dealId,
      verdict: certify({ snapshot, evidence: ev, observerVerdict, footprintOf: footOf, users }),
      overrides, snapshotManagerId: snapshot.managerId, observerCandidates: observerVerdict.candidates,
    });
    const name = (id) => { const u = users.get(s(id)); return u ? `${u.NAME ?? ""} ${u.LAST_NAME ?? ""}`.trim() : null; };
    return {
      dealId: snapshot.dealId, managerId: snapshot.managerId, managerName: snapshot.managerName,
      attributionSource: snapshot.attributionSource, wonAt: snapshot.wonAt, snapshotCreatedAt: snapshot.frozenAt,
      currentCategoryId: ev?.cat ?? null, currentStageId: ev?.stage ?? null, currentAssignedManagerId: ev?.assigned ?? null,
      observerState: observerVerdict.state, observerCandidates: observerVerdict.candidates,
      action: verdict.action, basis: verdict.basis, newSellerId: verdict.sellerId, ownerConfirmed: Boolean(verdict.ownerConfirmed),
      newSellerName: verdict.sellerId ? name(verdict.sellerId) : null,
      provenUnsafe: verdict.provenUnsafe, flags: verdict.flags,
      opportunity: ev?.opportunity ?? null, currency: ev?.currency ?? null, created: ev?.created ?? null,
    };
  });
}

const tally = (rows, key) => {
  const counts = new Map();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
};
const uzs = (rows) => (rows.filter((r) => (r.currency ?? "UZS") === "UZS").reduce((sum, r) => sum + Math.round((r.opportunity ?? 0) * 100), 0) / 100).toFixed(2);

export function buildManifest({ rows, complete }) {
  const include = rows.filter((r) => r.action !== ACTION.KEEP && r.provenUnsafe);
  const ownerConfirmed = rows.filter((r) => r.ownerConfirmed);
  return {
    reviewedInvalidate: complete
      ? { reviewed: true, dealIds: include.map((r) => r.dealId).sort(cmp) }
      : { reviewed: false, dealIds: [], pendingEvidence: "STAGING_SNAPSHOTS_INCOMPLETE" },
    keepTrustworthy: rows.filter((r) => r.action === ACTION.KEEP),
    humanReview: rows.filter((r) => r.action === ACTION.REVIEW),
    include, ownerConfirmed,
  };
}

/** The ten-section post-repair report. Returns the text plus a pass/fail verdict. */
export function certificationReport({ rows, sales, manifest, progress, complete, gate, users = new Map(), footprint = new Map(), overrides = new Map() }) {
  const L = []; const fail = [];
  const byAction = tally(rows, (r) => r.action);
  const septemberCoverage = (population) => {
    const resolved = population.filter((x) => {
      const row = rows.find((r) => r.dealId === x.id);
      if (!row) return overrides.has(x.id);
      return [ACTION.KEEP, ACTION.MOVER, ACTION.OBSERVER].includes(row.action) || row.action === "OWNER_CONFIRMED_SELLER";
    });
    const unresolved = population.filter((x) => !resolved.some((r) => r.id === x.id));
    return { resolved: resolved.length, total: population.length, unresolvedIds: unresolved.map((x) => x.id).sort(cmp) };
  };
  const cohort = septemberCoverage(sales.cohort);
  const period = septemberCoverage(sales.period);

  L.push("STAGING SELLER CERTIFICATION", "=".repeat(72));
  L.push(`generated ${new Date().toISOString()} | READ-ONLY | no sync, backfill, repair or deploy`);
  L.push(`snapshot population complete: ${complete ? "YES" : `NO — ${gate.reasons.join("; ")}`}`);

  L.push("", "1. CORE KPI RECONCILIATION (from raw evidence)");
  L.push(`   raw Deals ${progress.raws} | stage-history Deals ${progress.history_deals} | observers ${progress.observers} | analytics ${progress.analytics}`);
  L.push(`   WON (approved rule): ${sales.all.length}`);
  L.push(`   Cohort Sales: ${sales.cohort.length} (expected 41)${sales.cohort.length === 41 ? " OK" : " MISMATCH"}`);
  L.push(`   Period Sales: ${sales.period.length} (expected 42)${sales.period.length === 42 ? " OK" : " MISMATCH"}`);
  if (sales.cohort.length !== 41) fail.push(`COHORT_SALES_${sales.cohort.length}_EXPECTED_41`);
  if (sales.period.length !== 42) fail.push(`PERIOD_SALES_${sales.period.length}_EXPECTED_42`);

  L.push("", "2. EXACT COHORT / PERIOD SALE IDS");
  L.push(`   cohort: ${sales.cohort.map((x) => x.id).sort(cmp).join(", ")}`);
  L.push(`   period: ${sales.period.map((x) => x.id).sort(cmp).join(", ")}`);

  L.push("", "3. DEAL 40099 (period sale created before the range)");
  const d40099 = sales.period.find((x) => x.id === "40099");
  L.push(`   present in period Sales: ${d40099 ? "YES" : "NO"}${d40099 ? ` | created ${new Date(d40099.created).toISOString()} | wonAt ${new Date(d40099.wonAt).toISOString()}` : ""}`);
  if (!d40099) fail.push("DEAL_40099_MISSING_FROM_PERIOD_SALES");

  L.push("", "4. SELLER SNAPSHOT POPULATION");
  L.push(`   staging snapshots: ${rows.length} | with raw evidence: ${rows.filter((r) => r.currentCategoryId !== null).length}`);

  L.push("", "5. ATTRIBUTION-SOURCE BREAKDOWN (current, before repair)");
  for (const [k, v] of Object.entries(tally(rows, (r) => r.attributionSource || "(empty)"))) L.push(`   ${k}: ${v}`);

  L.push("", "6. OBSERVER RECOVERY");
  L.push(`   observer states: ${JSON.stringify(tally(rows, (r) => r.observerState))}`);
  L.push(`   INVALIDATE_THEN_RECOVER_OBSERVER: ${byAction[ACTION.OBSERVER] ?? 0}`);
  L.push(`   INVALIDATE_THEN_RECOVER_PAYMENT_MOVER: ${byAction[ACTION.MOVER] ?? 0}`);

  L.push("", "7. UNKNOWN");
  L.push(`   INVALIDATE_TO_UNKNOWN: ${byAction[ACTION.UNKNOWN] ?? 0} | HUMAN_REVIEW_REQUIRED: ${byAction[ACTION.REVIEW] ?? 0}`);

  L.push("", "8. SEPTEMBER MANAGER COVERAGE");
  L.push(`   Cohort:  ${cohort.resolved} / ${cohort.total}${cohort.unresolvedIds.length ? `  unresolved: ${cohort.unresolvedIds.join(", ")}` : ""}`);
  L.push(`   Period:  ${period.resolved} / ${period.total}${period.unresolvedIds.length ? `  unresolved: ${period.unresolvedIds.join(", ")}` : ""}`);

  L.push("", "9. ONBOARDING / OPERATOR CONTAMINATION CHECK");
  const credited = rows.filter((r) => [ACTION.KEEP, ACTION.MOVER, ACTION.OBSERVER].includes(r.action) || r.ownerConfirmed);
  const contaminated = credited.filter((r) => {
    const id = r.action === ACTION.KEEP ? r.managerId : r.newSellerId;
    if (!id) return false;
    // A credited seller is contaminated only when BOTH signals say non-Sales:
    // the job title and the deal footprint. A stale title alone is not enough.
    const role = roleOf(users.get(s(id)));
    return role.role === "NON_SELLER" && role.proven && !isSalesStaffByFootprint(footprint.get(s(id)) ?? {}).ok;
  });
  const contaminatedDetail = contaminated.map((r) => `${r.dealId}:${r.action === ACTION.KEEP ? r.managerId : r.newSellerId}`);
  L.push(`   evidence-backed sellers: ${credited.length}`);
  L.push(`   credited to a non-Sales person with no Sales footprint: ${contaminated.length}`);
  if (contaminated.length) { L.push(`   contaminated rows: ${contaminatedDetail.join(", ")}`); fail.push(`OPERATOR_CONTAMINATION_${contaminated.length}`); }

  L.push("", "9b. OWNER-CONFIRMED SELLER OVERRIDES (manual, not a rule)");
  const ownerRows = rows.filter((r) => r.ownerConfirmed);
  L.push(`   registry entries: ${overrides.size} | matched to a staging snapshot: ${ownerRows.length}`);
  for (const [dealId, o] of overrides) {
    const row = rows.find((r) => r.dealId === dealId);
    L.push(`   ${dealId} -> seller ${o.sellerId} ${o.sellerName ?? ""} (confirmedBy ${o.confirmedBy} ${o.confirmedAt})${row ? `; frozen was ${row.managerId ?? "none"}` : "; no staging snapshot"}`);
  }

  L.push("", "10. REVIEWED MANIFEST RECONCILIATION");
  L.push(`   reviewed: ${manifest.reviewedInvalidate.reviewed} | dealIds: ${manifest.reviewedInvalidate.dealIds.length}`);
  L.push(`   requested ${manifest.reviewedInvalidate.dealIds.length} | expected matched ${manifest.reviewedInvalidate.dealIds.length} | expected wouldChange ${manifest.reviewedInvalidate.dealIds.length}`);
  L.push(`   recover via payment mover: ${manifest.include.filter((r) => r.action === ACTION.MOVER).length}`);
  L.push(`   recover via POST_SALE_OBSERVER: ${manifest.include.filter((r) => r.action === ACTION.OBSERVER).length}`);
  L.push(`   become UNKNOWN: ${manifest.include.filter((r) => [ACTION.UNKNOWN, ACTION.REVIEW].includes(r.action)).length}`);
  L.push(`   human review remaining: ${byAction[ACTION.REVIEW] ?? 0}`);
  L.push(`   excluded KEEP_TRUSTWORTHY: ${byAction[ACTION.KEEP] ?? 0} | excluded not-proven-unsafe: ${rows.filter((r) => r.action !== ACTION.KEEP && !r.provenUnsafe).length}`);
  L.push(`   UZS at risk in the manifest: ${uzs(manifest.include)}`);
  if (manifest.reviewedInvalidate.dealIds.some((id) => rows.find((r) => r.dealId === id)?.action === ACTION.KEEP)) fail.push("MANIFEST_CONTAINS_KEEP_ROW");

  if (!complete) fail.push("STAGING_SNAPSHOTS_INCOMPLETE");
  L.push("", "=".repeat(72));
  L.push(fail.length ? `STAGING_CERTIFICATION_FAILED — ${fail.join("; ")}` : "STAGING_CERTIFIED");
  return { text: L.join("\n") + "\n", passed: fail.length === 0, failures: fail, cohort, period };
}

async function main() {
  const mode = process.argv[2] === "certify" ? "certify" : "manifest";
  const inDir = new URL("../.audit/staging-in/", import.meta.url);
  const outDir = new URL("../.audit/seller-repair-staging/", import.meta.url);
  const overrides = loadOwnerOverrides();
  const { snapshots, evidence, footprint, users, progress } = await loadStaging(inDir);
  const sales = derivedSales(evidence);
  const expectedSnapshots = sales.all.filter((x) => x.wonAt !== null).length;
  const gate = requireCompleteSnapshots({
    analytics: Number(progress.analytics ?? 0), raws: Number(progress.raws ?? 0),
    snapshots: snapshots.length, expectedSnapshots, job: progress.job,
  });
  const rows = classifyAll({ snapshots, evidence, footprint, users, overrides });
  const manifest = buildManifest({ rows, complete: gate.complete });
  const report = certificationReport({ rows, sales, manifest, progress, complete: gate.complete, gate, users, footprint, overrides });

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const write = (name, payload) => writeFile(new URL(name, outDir), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await write("reviewed-invalidate.json", manifest.reviewedInvalidate);
  await write("keep-trustworthy.json", manifest.keepTrustworthy);
  await write("human-review.json", manifest.humanReview);
  await write("owner-confirmed-overrides.json", overrideManifest(overrides));
  await writeFile(new URL("summary.txt", outDir), report.text, { mode: 0o600 });
  process.stdout.write(report.text);
  process.stdout.write(`\nmanifest path: ${new URL("reviewed-invalidate.json", outDir).pathname}\nmode: ${mode}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
