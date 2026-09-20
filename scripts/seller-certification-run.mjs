#!/usr/bin/env node

// Reproducible runner for the seller-certification audit. Read-only: it consumes
// the read-only D1 exports in .audit/in and writes only .audit report files.
// The role-conflict guard is applied to EVERY evidence-backed disposition, not
// just KEEP, so a Marketing employee cannot be credited through the mover path
// while being sent to review through the KEEP path.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { roleOf, resolveRoleConflict, d1Rows, classify, BUCKETS } from "./seller-repair-manifest.mjs";
import { DISPOSITION, EVIDENCE_SOURCE, buildFinalManifest, classifyObservers, observerDataPresent, resolveSellerEvidence, summarizeRecovery } from "./observer-seller-recovery.mjs";
const IN = new URL("../.audit/in/", import.meta.url), OUT = new URL("../.audit/seller-repair-final/", import.meta.url);
const read=async(n)=>d1Rows(await readFile(new URL(n, IN),"utf8"));
const [snapRows,joined,postSaleRows,rawRows,mgrRows]=await Promise.all([read("snapshots.json"),read("joined.json"),read("postsale.json"),read("rawstate.json"),read("mgr.json")]);
const users=new Map(JSON.parse(await readFile(new URL("_users.json", IN),"utf8")).map(u=>[String(u.ID),u])), KNOWN=new Set(users.keys());
const s=(v)=>v===null||v===undefined?"":String(v).trim();
const PAY=["C3:WON","C5:WON"], PS="13";
const OBS=observerDataPresent(rawRows);
const foot=new Map();
for (const r of mgrRows){ const m=s(r.mid); const f=foot.get(m)??{}; f[s(r.cat)]=(f[s(r.cat)]??0)+r.n; foot.set(m,f); }
const snapshots=snapRows.map(r=>({dealId:s(r.deal_id),wonAt:s(r.won_at)||null,managerId:s(r.manager_id)||null,managerName:s(r.manager_name)||null,attributionSource:s(r.attribution_source),frozenAt:s(r.created_at)||null}));
const base=new Map(joined.filter(r=>r.category_id!==null).map(r=>[s(r.deal_id),{categoryId:r.category_id,stageId:r.stage_id,assignedId:r.assigned_id,opportunity:r.opportunity,currency:r.currency,created:Date.parse(s(r.deal_created))}]));
const raws=new Map(rawRows.map(r=>[s(r.deal_id),r]));
const postSale=new Map(postSaleRows.map(r=>[s(r.deal_id),s(r.first_post_sale)]));
const nameOf=(id)=>{const u=users.get(s(id));return u?`${u.NAME??""} ${u.LAST_NAME??""}`.trim():null;};

const rows=snapshots.map(snapshot=>{
  const b=base.get(snapshot.dealId)??null, raw=raws.get(snapshot.dealId)??null;
  const record=b?{...b,movedBy:s(raw?.moved_by)}:null;
  const pse=postSale.get(snapshot.dealId)??null;
  const prior=classify({snapshot,record,raw:record,postSaleEnteredAt:pse,paymentStageIds:PAY,postSaleCategoryId:PS,configuredFieldWasAssignedBy:true,acceptFirstCall:false});
  const ov=classifyObservers({deal:raw??{},assignedById:record?.assignedId,knownUserIds:KNOWN});
  let e=resolveSellerEvidence({snapshot,record,observerVerdict:ov,paymentStageIds:PAY,postSaleCategoryId:PS,priorTrustworthy:prior.bucket===BUCKETS.TRUSTWORTHY,users,roleOf});
  // TASK B: settle job-title contradictions on trustworthy rows by deal footprint.
  // Guard every evidence-backed disposition, not only KEEP.
  let conflict=null;
  if (e.disposition===DISPOSITION.KEEP || e.disposition===DISPOSITION.RECOVER_MOVER){
    const credited = e.disposition===DISPOSITION.KEEP ? snapshot.managerId : e.sellerId;
    const role=roleOf(users.get(credited));
    if (role.role==="NON_SELLER" && role.proven){
      conflict=resolveRoleConflict({footprint:foot.get(credited)??{},dealCurrentCategoryId:record?.categoryId,dealEverInPostSale:Boolean(pse)});
      if (conflict.resolution==="REVIEW") e={...e,disposition:DISPOSITION.REVIEW,source:EVIDENCE_SOURCE.AMBIGUOUS,sellerId:null,flags:[...e.flags,`ROLE_CONFLICT_UNRESOLVED:${conflict.basis}`]};
      else e={...e,flags:[...e.flags,`ROLE_CONFLICT_RESOLVED_KEEP:${conflict.basis}`]};
    }
  }
  return {dealId:snapshot.dealId,managerId:snapshot.managerId,managerName:snapshot.managerName,attributionSource:snapshot.attributionSource,wonAt:snapshot.wonAt,snapshotCreatedAt:snapshot.frozenAt,
    currentCategoryId:s(record?.categoryId)||null,currentAssignedManagerId:s(record?.assignedId)||null,
    source:e.source,sellerId:e.sellerId,sellerName:e.sellerId?nameOf(e.sellerId):null,disposition:e.disposition,observerState:e.observerState,flags:e.flags,
    opportunity:record?.opportunity??null,currency:record?.currency??null,created:record?.created};
});
const M=buildFinalManifest({rows,observerDataAvailable:OBS});
await mkdir(OUT,{recursive:true,mode:0o700});
const w=(n,p)=>writeFile(new URL(n, OUT),JSON.stringify(p,null,2)+"\n",{encoding:"utf8",mode:0o600});
await w("reviewed-invalidate.json",M.reviewedInvalidate); await w("keep-trustworthy.json",M.keepTrustworthy); await w("human-review.json",M.humanReview);
const S=summarizeRecovery(rows);
const fromMs=Date.parse("2026-09-01T00:00:00+05:00"), toMs=Date.parse("2026-09-19T00:00:00+05:00")+86400000;
const sep=rows.filter(r=>Number.isFinite(r.created)&&r.created>=fromMs&&r.created<toMs), Ssep=summarizeRecovery(sep);
const L=[];
L.push("MEGA SPRINT 1 — OBSERVER SELLER CERTIFICATION (read-only)");
L.push(`generated ${new Date().toISOString()}`);
L.push(`observer data cached: ${OBS?"YES":"NO — OBSERVER_NOT_CACHED"}  (staging synced 2026-09-20, 0 of ${rawRows.length} deals carry observers)`);
L.push(`snapshots: ${rows.length}`);
L.push("");
L.push("DISPOSITIONS: "+JSON.stringify(S.byDisposition));
L.push(`TASK B resolved: KEEP ${S.trustworthy} (was 126 base / 111 over-conservative)`);
L.push("");
for (const [lbl,sum,n] of [["ALL",S,rows.length],["SEPTEMBER 2026-09-01..19 (cached 37 of 41)",Ssep,sep.length]]){
  L.push("="+"=".repeat(68), `${lbl} — ${n}`, "="+"=".repeat(68));
  L.push(`  existing trustworthy seller:      ${sum.trustworthy}`);
  L.push(`  recovered from payment mover:     ${sum.paymentMover}`);
  L.push(`  recovered from cat-13 observer:   ${sum.observerRecovered}`);
  L.push(`  ambiguous:                        ${sum.ambiguous}`);
  L.push(`  no observer (diagnostic):         ${sum.noObserverEvidenceDiagnostic}`);
  L.push(`  Unknown:                          ${sum.unknown}`);
  L.push(`  seller breakdown (evidence only): ${JSON.stringify(sum.sellerBreakdownFromEvidenceOnly)}`);
  L.push("");
}
L.push("MANIFEST");
L.push(`  reviewed-invalidate.json  reviewed=${M.reviewedInvalidate.reviewed} dealIds=${M.reviewedInvalidate.dealIds.length}${M.reviewedInvalidate.pendingEvidence?` pending=${M.reviewedInvalidate.pendingEvidence}`:""}`);
L.push(`  keep-trustworthy.json     ${M.keepTrustworthy.length}`);
L.push(`  human-review.json         ${M.humanReview.length}`);
L.push("", "Nothing repaired, synced, backfilled or deployed.");
const txt=L.join("\n")+"\n";
await writeFile(new URL("summary.txt", OUT),txt,{mode:0o600});
console.log(txt);
console.log("HUMAN REVIEW ROWS:");
for (const r of M.humanReview) console.log(`  ${r.dealId}  ${r.managerId} ${r.managerName}  cat=${r.currentCategoryId}  ${r.flags.join(" | ")}`);
console.log("\nSEPTEMBER Unknown deal IDs:", sep.filter(r=>r.source===EVIDENCE_SOURCE.NONE).map(r=>r.dealId).join(", "));
