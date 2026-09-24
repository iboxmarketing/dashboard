import { authError, requireAdmin } from "@/lib/auth/http";
import { bitrixCall, getBitrixDomain, safeBitrixMessage } from "@/lib/bitrix";
import { classifyBackfill, isWritable, summarizeBackfill, type BackfillDecision } from "@/lib/seller-backfill";
import { OWNER_OVERRIDES } from "@/lib/seller-overrides";
import { writeSalesOwnerAtWon } from "@/lib/seller-writeback";
import { normalizeSalesOwnerAtWonField } from "@/lib/stable-seller-field";
import {
  applyBackfilledOwner, applyConfirmedSeller, getDictionary, getSettings, listAnalyticsRecords,
  listSellerAudit, listSellerConfirmations, recordSellerAudit, saveSellerConfirmation,
} from "@/lib/storage";
import type { AnalyticsRecord } from "@/lib/types";

/**
 * Seller attribution administration: the legacy backfill and the manual review
 * queue for the canonical Sales Owner at Won field.
 *
 * ADMIN ONLY, and deliberately the only route in the app that writes to Bitrix.
 * Two invariants hold everywhere below:
 *
 *  - nothing is written to the CRM without an explicit request — a GET only
 *    classifies, and a backfill writes only in `mode: "apply"`;
 *  - a failed CRM write never certifies a seller. The confirmation row keeps the
 *    failure for audit, the analytics record is left untouched, and the Deal
 *    stays in the review queue.
 */

const EMPLOYEE_ID = /^[1-9]\d*$/;
const QUEUE_LIMIT = 500;
/** One backfill request writes at most this many Deals, so a run stays reviewable. */
const APPLY_LIMIT = 200;

function userMap(rows: Record<string, unknown>[]) {
  const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  return new Map(rows.map((row) => [
    text(row.ID),
    [text(row.NAME), text(row.LAST_NAME)].filter(Boolean).join(" ") || `Menejer #${text(row.ID)}`,
  ]));
}

async function loadContext() {
  const [settings, records, confirmations, userRows] = await Promise.all([
    getSettings(), listAnalyticsRecords(), listSellerConfirmations({ includeFailed: true }),
    getDictionary<Record<string, unknown>[]>("users", []),
  ]);
  const users = userMap(userRows);
  // Attested facts: the reviewed registry in git, plus confirmations whose CRM
  // write-back actually succeeded.
  const attested = new Map<string, { sellerId: string; sellerName: string | null }>();
  for (const [dealId, override] of OWNER_OVERRIDES) attested.set(dealId, { sellerId: override.sellerId, sellerName: override.sellerName });
  for (const [dealId, entry] of confirmations) {
    if (entry.bitrixWriteStatus === "WRITTEN" || entry.bitrixWriteStatus === "ALREADY_SET") {
      attested.set(dealId, { sellerId: entry.sellerId, sellerName: entry.sellerName });
    }
  }
  const field = normalizeSalesOwnerAtWonField(settings.salesOwnerAtWonField);
  const decisions = records.map((record) => classifyBackfill(record as never, {
    attested, configuredSellerField: settings.salesManagerField,
  }));
  return { settings, records, confirmations, users, attested, field, decisions };
}

/** The evidence a human needs to name a seller, and nothing beyond it. */
function queueRow(record: AnalyticsRecord, decision: BackfillDecision, users: Map<string, string>, domain: string | null) {
  const name = (id: string | null | undefined) => (id ? users.get(String(id)) ?? `Menejer #${id}` : null);
  return {
    dealId: record.dealId,
    title: record.title,
    wonAt: record.wonAt,
    opportunity: record.opportunity,
    currencyId: record.currencyId,
    bitrixUrl: domain ? `https://${domain}/crm/deal/details/${record.dealId}/` : null,
    assignedManagerId: record.assignedManagerId ?? null,
    assignedManager: name(record.assignedManagerId),
    observerIds: record.observerIds ?? [],
    observers: (record.observerIds ?? []).map((id) => ({ id, name: name(id) })),
    postSaleObserverId: record.postSaleObserverId ?? null,
    postSaleObserver: name(record.postSaleObserverId),
    movedById: record.movedById ?? null,
    movedBy: name(record.movedById),
    snapshotSellerId: record.salesManagerId ?? null,
    snapshotSeller: record.salesManager ?? null,
    snapshotAttribution: record.salesManagerAttribution,
    salesOwnerAtWonId: record.salesOwnerAtWonId ?? null,
    salesOwnerAtWonName: record.salesOwnerAtWonName ?? null,
    certification: record.sellerCertification ?? null,
    certificationReason: record.sellerEvidenceReason ?? null,
    verdict: decision.verdict,
    verdictReason: decision.reason,
  };
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const { settings, records, confirmations, users, field, decisions } = await loadContext();
    const domain = getBitrixDomain();
    const byDeal = new Map(decisions.map((decision) => [decision.dealId, decision]));
    const queue = records
      .filter((record) => {
        const verdict = byDeal.get(record.dealId)?.verdict;
        return verdict === "REVIEW_REQUIRED" || verdict === "UNKNOWN";
      })
      .sort((a, b) => String(b.wonAt ?? "").localeCompare(String(a.wonAt ?? "")))
      .slice(0, QUEUE_LIMIT)
      .map((record) => queueRow(record, byDeal.get(record.dealId) as BackfillDecision, users, domain));
    const sales = records.filter((record) => record.salesStatus === "WON" && record.wonAt);
    return Response.json({
      canonicalField: field,
      configuredSellerField: settings.salesManagerField,
      summary: summarizeBackfill(decisions),
      coverage: {
        sales: sales.length,
        fieldPopulated: sales.filter((record) => Boolean(record.salesOwnerAtWonId)).length,
        certified: sales.filter((record) => record.sellerCertification === "CERTIFIED" || record.sellerCertification === "OWNER_CONFIRMED").length,
        reviewRequired: sales.filter((record) => record.sellerCertification === "REVIEW_REQUIRED").length,
        unknown: sales.filter((record) => !record.sellerCertification || record.sellerCertification === "UNKNOWN").length,
      },
      queue,
      queueTruncated: queue.length >= QUEUE_LIMIT,
      sellers: [...users.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      confirmations: [...confirmations.values()].sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, 100),
      audit: await listSellerAudit(undefined, 50),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Sotuvchi atributsiyasini yuklab bo‘lmadi" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let actor: string;
  try {
    const context = await requireAdmin(request);
    actor = context.user.email;
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 });
  }
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(payload.action ?? "");
  try {
    if (action === "backfill") return await runBackfill(payload, actor);
    if (action === "confirm") return await confirmSeller(payload, actor);
    return Response.json({ error: "Amal noto‘g‘ri" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}

async function runBackfill(payload: Record<string, unknown>, actor: string) {
  const apply = payload.mode === "apply";
  const limit = Math.max(1, Math.min(APPLY_LIMIT, Number(payload.limit ?? APPLY_LIMIT) || APPLY_LIMIT));
  const { settings, decisions, users, field } = await loadContext();
  const writable = decisions.filter(isWritable);
  const summary = summarizeBackfill(decisions);
  const plan = writable.slice(0, limit).map((decision) => ({
    dealId: decision.dealId,
    sellerId: decision.sellerId,
    sellerName: decision.sellerName ?? (decision.sellerId ? users.get(decision.sellerId) ?? null : null),
    evidenceType: decision.evidenceType,
    verdict: decision.verdict,
    reason: decision.reason,
    priorEvidence: decision.priorEvidence,
  }));

  if (!field) {
    return Response.json({
      mode: apply ? "apply" : "dry-run", applied: false, canonicalField: null,
      error: "Sales Owner at Won maydoni sozlanmagan", summary, plan, results: [],
    }, { status: apply ? 400 : 200 });
  }
  if (!apply) {
    return Response.json({
      mode: "dry-run", applied: false, canonicalField: field, summary, plan, results: [],
      pending: Math.max(0, writable.length - plan.length),
    });
  }

  // Sequential on purpose: Bitrix rate-limits, and a per-Deal result log is
  // worth more than throughput on a one-time migration.
  const results: (typeof plan[number] & { status: string; currentValue: string | null; attempts: number; errorCode: string | null })[] = [];
  for (const entry of plan) {
    if (!entry.sellerId) continue;
    const write = await writeSalesOwnerAtWon({ dealId: entry.dealId, sellerId: entry.sellerId, field }, { call: bitrixCall, pauseMs: 250 });
    if (write.status === "WRITTEN" || write.status === "ALREADY_SET") {
      await applyBackfilledOwner({ dealId: entry.dealId, sellerId: entry.sellerId, sellerName: entry.sellerName });
    }
    results.push({ ...entry, status: write.status, currentValue: write.currentValue, attempts: write.attempts, errorCode: write.errorCode ?? null });
  }
  await recordSellerAudit(results.map((result) => ({
    dealId: result.dealId, actor, action: `BACKFILL_${result.status}`,
    payload: {
      sellerId: result.sellerId, sellerName: result.sellerName, evidenceType: result.evidenceType,
      verdict: result.verdict, reason: result.reason, priorEvidence: result.priorEvidence,
      field, status: result.status, errorCode: result.errorCode, configuredSellerField: settings.salesManagerField,
    },
  })));
  const counted = (status: string) => results.filter((result) => result.status === status).length;
  return Response.json({
    mode: "apply", applied: true, canonicalField: field, summary, plan: [], results,
    writes: {
      attempted: results.length, written: counted("WRITTEN"), alreadySet: counted("ALREADY_SET"),
      skippedNotEmpty: counted("SKIPPED_NOT_EMPTY"), failed: counted("FAILED"),
    },
    pending: Math.max(0, writable.length - results.length),
  });
}

async function confirmSeller(payload: Record<string, unknown>, actor: string) {
  const dealId = String(payload.dealId ?? "").trim();
  const sellerId = String(payload.sellerId ?? "").trim();
  if (!EMPLOYEE_ID.test(dealId)) return Response.json({ error: "Deal ID noto‘g‘ri" }, { status: 400 });
  if (!EMPLOYEE_ID.test(sellerId)) return Response.json({ error: "Sotuvchi tanlanmagan" }, { status: 400 });
  const { records, users, field, decisions } = await loadContext();
  if (!field) return Response.json({ error: "Sales Owner at Won maydoni sozlanmagan" }, { status: 400 });
  const record = records.find((entry) => entry.dealId === dealId);
  if (!record) return Response.json({ error: "Deal analytics bazasida topilmadi" }, { status: 404 });
  if (!users.has(sellerId)) return Response.json({ error: "Tanlangan xodim Bitrix’da topilmadi" }, { status: 400 });
  const sellerName = users.get(sellerId) ?? null;
  const decision = decisions.find((entry) => entry.dealId === dealId);

  // Bitrix first: the CRM is the system of record, so the dashboard may only
  // certify a seller the CRM already carries.
  const write = await writeSalesOwnerAtWon({ dealId, sellerId, field }, { call: bitrixCall, pauseMs: 0 });
  const now = new Date().toISOString();
  const priorEvidence = JSON.stringify(decision?.priorEvidence ?? {
    attribution: record.salesManagerAttribution, certification: record.sellerCertification ?? null,
    certificationReason: record.sellerEvidenceReason ?? null, sellerId: record.salesManagerId ?? null,
  });

  if (write.status !== "WRITTEN" && write.status !== "ALREADY_SET") {
    await saveSellerConfirmation({
      dealId, sellerId, sellerName, confirmedBy: actor, confirmedAt: now, priorEvidence,
      bitrixWriteStatus: write.status, bitrixWriteAt: now, bitrixErrorCode: write.errorCode ?? null,
    });
    await recordSellerAudit([{
      dealId, actor, action: `CONFIRM_${write.status}`,
      payload: { sellerId, sellerName, field, errorCode: write.errorCode ?? null, currentValue: write.currentValue, priorEvidence: decision?.priorEvidence ?? null },
    }]);
    const status = write.status === "SKIPPED_NOT_EMPTY" ? 409 : 502;
    return Response.json({
      dealId, status: write.status, certified: false, currentValue: write.currentValue,
      error: write.status === "SKIPPED_NOT_EMPTY"
        ? "Bitrix’da Sales Owner at Won allaqachon boshqa xodimni ko‘rsatadi — avtomatik almashtirilmaydi"
        : "Bitrix yozuvi bajarilmadi, sotuvchi tasdiqlanmadi",
      errorCode: write.errorCode ?? null,
    }, { status });
  }

  const prior = await applyConfirmedSeller({ dealId, sellerId, sellerName });
  await saveSellerConfirmation({
    dealId, sellerId, sellerName, confirmedBy: actor, confirmedAt: now, priorEvidence,
    bitrixWriteStatus: write.status, bitrixWriteAt: now, bitrixErrorCode: null,
  });
  await recordSellerAudit([{
    dealId, actor, action: `CONFIRM_${write.status}`,
    payload: { sellerId, sellerName, field, priorEvidence: prior ?? decision?.priorEvidence ?? null, status: write.status },
  }]);
  return Response.json({
    dealId, status: write.status, certified: true, sellerId, sellerName,
    certification: "OWNER_CONFIRMED", attribution: "MANUAL_CONFIRMATION",
    idempotent: write.status === "ALREADY_SET",
  });
}
