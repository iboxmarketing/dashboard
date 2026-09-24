#!/usr/bin/env node
/**
 * Read-only Sales Owner at Won backfill dry-run against a live D1 database.
 *
 * The same classifier the dashboard uses (`lib/seller-backfill.ts`), run outside
 * the Worker so the migration can be reviewed before anybody presses Apply — and
 * so a production report exists even though the production Worker sits behind
 * Cloudflare Access. It writes nothing: no D1 statement, no Bitrix call.
 *
 *   npm run audit:sales-owner -- --database ibox-dashboard-production \
 *     [--out report.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { classifyBackfill, isWritable, summarizeBackfill } from "../lib/seller-backfill";
import { OWNER_OVERRIDES } from "../lib/seller-overrides";
import { normalizeSalesOwnerAtWonField } from "../lib/stable-seller-field";
import type { AnalyticsRecord, DashboardSettings } from "../lib/types";

const args = process.argv.slice(2);
const arg = (name: string, fallback = "") => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const database = arg("database");
const out = arg("out");
if (!database) throw new Error("--database is required");

function query<T>(sql: string): T[] {
  const raw = execFileSync("npx", ["--no-install", "wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql], {
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" },
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf("["))) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

const settingsRow = query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'dashboard'")[0];
const settings = (settingsRow ? JSON.parse(settingsRow.value) : {}) as Partial<DashboardSettings>;
const field = normalizeSalesOwnerAtWonField(settings.salesOwnerAtWonField);

const records = query<{ payload: string }>("SELECT payload FROM analytics_records")
  .flatMap((row) => { try { return [JSON.parse(row.payload) as AnalyticsRecord]; } catch { return []; } });

// Confirmations already written back to Bitrix rank with the owner registry.
let confirmations: { deal_id: string; seller_id: string; seller_name: string | null; bitrix_write_status: string | null }[] = [];
try {
  confirmations = query("SELECT deal_id, seller_id, seller_name, bitrix_write_status FROM seller_confirmations");
} catch { /* table appears with migration 0011 */ }

const attested = new Map<string, { sellerId: string; sellerName: string | null }>();
for (const [dealId, override] of OWNER_OVERRIDES) attested.set(dealId, { sellerId: override.sellerId, sellerName: override.sellerName });
for (const row of confirmations) {
  if (row.bitrix_write_status === "WRITTEN" || row.bitrix_write_status === "ALREADY_SET") {
    attested.set(String(row.deal_id), { sellerId: String(row.seller_id), sellerName: row.seller_name });
  }
}

const decisions = records.map((record) => classifyBackfill(record as never, {
  attested, configuredSellerField: settings.salesManagerField ?? null,
}));
const summary = summarizeBackfill(decisions);
const sales = records.filter((record) => record.salesStatus === "WON" && record.wonAt);
const report = {
  database, generatedAt: new Date().toISOString(), canonicalField: field,
  analyticsVersions: [...new Set(records.map((record) => record.analyticsVersion))].sort(),
  rows: records.length,
  sales: {
    total: sales.length,
    fieldPopulated: sales.filter((record) => Boolean((record as { salesOwnerAtWonId?: string }).salesOwnerAtWonId)).length,
    certified: sales.filter((record) => record.sellerCertification === "CERTIFIED" || record.sellerCertification === "OWNER_CONFIRMED").length,
    reviewRequired: sales.filter((record) => record.sellerCertification === "REVIEW_REQUIRED").length,
    unknown: sales.filter((record) => !record.sellerCertification || record.sellerCertification === "UNKNOWN").length,
  },
  summary,
  writes: decisions.filter(isWritable).map((decision) => ({
    dealId: decision.dealId, sellerId: decision.sellerId, sellerName: decision.sellerName,
    evidenceType: decision.evidenceType, verdict: decision.verdict, reason: decision.reason,
    priorEvidence: decision.priorEvidence,
  })),
  reviewQueue: decisions.filter((decision) => decision.verdict === "REVIEW_REQUIRED" || decision.verdict === "UNKNOWN").length,
  mutated: false,
  note: "Read-only. Applying the backfill is an explicit admin action in Sotuvchi tasdiqlash.",
};
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, writes: report.writes.slice(0, 25) }, null, 1));
