#!/usr/bin/env node
/**
 * Fresh seller-snapshot classifier for a live database.
 *
 * Replaces the environment-specific staging repair manifests: it re-derives a
 * verdict for every stored sale snapshot from the evidence that database holds
 * right now, and writes nothing.
 *
 *   KEEP_CERTIFIED             the attribution is proven — an owner
 *                              confirmation, the approved post-sale observer
 *                              handoff, or a configured seller field that still
 *                              corroborates the frozen value.
 *   OWNER_CONFIRMED            in the reviewed owner registry.
 *   REPAIR_TO_CERTIFIED_SELLER a configured seller field deterministically names
 *                              somebody else. Deterministic, so repairable.
 *   SET_UNKNOWN                the frozen seller cannot be told apart from the
 *                              Deal's current owner and nothing corroborates it,
 *                              so it names an operator as often as a seller.
 *   HUMAN_REVIEW               named on evidence that proves nothing (the card
 *                              mover, a legacy call value), or the Deal is gone.
 *
 * Only REPAIR_TO_CERTIFIED_SELLER is ever a mutation candidate, and this script
 * does not mutate: every repair needs an explicit reviewed manifest, a D1 restore
 * point and the existing invalidation workflow (docs/OPERATIONS.md). The read
 * side already protects employees — anything not certified is excluded from
 * scorecards by lib/seller-evidence.ts, with the seller still visible.
 *
 *   npm run audit:seller-classifier -- --database ibox-dashboard-production \
 *     [--out report.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { OWNER_OVERRIDES } from "../lib/seller-overrides";
import { canonicalDealFieldKey } from "../lib/crm-fields";
import { normalizeSafeStableSellerField } from "../lib/stable-seller-field";
import type { DashboardSettings } from "../lib/types";

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
const stored = settingsRow ? JSON.parse(settingsRow.value) as Partial<DashboardSettings> : {};
const sellerField = normalizeSafeStableSellerField(stored.salesManagerField);
const fieldKey = sellerField ? canonicalDealFieldKey(sellerField) : "";

type Row = {
  deal_id: string; manager_id: string | null; manager_name: string | null; attribution_source: string; won_at: string;
  assigned: string | null; field_seller: string | null; scope: string | null; membership: string | null; known_user: number;
};

const rows = query<Row>(`SELECT s.deal_id, s.manager_id, s.manager_name, s.attribution_source, s.won_at,
    json_extract(r.payload,'$.ASSIGNED_BY_ID') AS assigned,
    ${fieldKey ? `json_extract(r.payload,'$.${fieldKey}')` : "NULL"} AS field_seller,
    json_extract(a.payload,'$.currentScope') AS scope,
    json_extract(a.payload,'$.projectLeadMembership') AS membership,
    (SELECT count(*) FROM crm_dictionaries d, json_each(d.payload) j
      WHERE d.key='users' AND json_extract(j.value,'$.ID') = s.manager_id) AS known_user
  FROM deal_sales_snapshots s
  LEFT JOIN raw_deals r ON r.deal_id = s.deal_id
  LEFT JOIN analytics_records a ON a.deal_id = s.deal_id`);

type Verdict = "KEEP_CERTIFIED" | "OWNER_CONFIRMED" | "REPAIR_TO_CERTIFIED_SELLER" | "SET_UNKNOWN" | "HUMAN_REVIEW";
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function classify(row: Row): { verdict: Verdict; reason: string; proposedSellerId?: string } {
  const sellerId = text(row.manager_id);
  if (OWNER_OVERRIDES.has(row.deal_id)) return { verdict: "OWNER_CONFIRMED", reason: "REVIEWED_OWNER_REGISTRY" };
  if (row.scope === "DELETED" || row.scope === "UNAVAILABLE") return { verdict: "HUMAN_REVIEW", reason: `DEAL_${row.scope}` };
  if (!sellerId || !/^[1-9]\d*$/u.test(sellerId)) return { verdict: "SET_UNKNOWN", reason: "NO_VALID_SELLER_ID" };
  if (!row.known_user) return { verdict: "SET_UNKNOWN", reason: "SELLER_NOT_A_KNOWN_USER" };
  if (row.attribution_source === "OWNER_CONFIRMED") return { verdict: "OWNER_CONFIRMED", reason: "STORED_OWNER_CONFIRMED" };
  if (row.attribution_source === "POST_SALE_OBSERVER") return { verdict: "KEEP_CERTIFIED", reason: "OBSERVER_HANDOFF" };

  const fieldSeller = text(row.field_seller);
  if (fieldKey && fieldSeller) {
    if (fieldSeller === sellerId) return { verdict: "KEEP_CERTIFIED", reason: "CORROBORATED_BY_SELLER_FIELD" };
    return { verdict: "REPAIR_TO_CERTIFIED_SELLER", reason: "SELLER_FIELD_NAMES_SOMEBODY_ELSE", proposedSellerId: fieldSeller };
  }

  // Nothing corroborates the frozen value. When it is exactly the Deal's current
  // owner it cannot be told apart from the operator/onboarding person who holds
  // the card now — the misattribution this sprint exists to stop.
  if (sellerId === text(row.assigned)) return { verdict: "SET_UNKNOWN", reason: "EQUALS_CURRENT_ASSIGNEE_NO_CORROBORATION" };
  if (row.attribution_source === "CUSTOM_FIELD") return { verdict: "HUMAN_REVIEW", reason: "LEGACY_FIELD_NO_CONFIGURED_FIELD" };
  if (row.attribution_source === "STAGE_MOVER") return { verdict: "HUMAN_REVIEW", reason: "MOVER_IS_NOT_SELLER" };
  if (row.attribution_source === "FIRST_CALL") return { verdict: "HUMAN_REVIEW", reason: "LEGACY_CALL_EVIDENCE" };
  return { verdict: "HUMAN_REVIEW", reason: `UNRECOGNISED_SOURCE_${row.attribution_source}` };
}

const classified = rows.map((row) => ({
  dealId: row.deal_id, sellerId: row.manager_id, sellerName: row.manager_name, source: row.attribution_source,
  wonAt: row.won_at, currentAssignee: row.assigned, membership: row.membership, scope: row.scope,
  ...classify(row),
}));

const byVerdict = (verdict: Verdict) => classified.filter((row) => row.verdict === verdict);
const report = {
  database, generatedAt: new Date().toISOString(),
  configuredSellerField: sellerField ?? null,
  snapshots: classified.length,
  counts: Object.fromEntries((["KEEP_CERTIFIED", "OWNER_CONFIRMED", "REPAIR_TO_CERTIFIED_SELLER", "SET_UNKNOWN", "HUMAN_REVIEW"] as Verdict[])
    .map((verdict) => [verdict, byVerdict(verdict).length])),
  reasons: Object.entries(classified.reduce<Record<string, number>>((acc, row) => { acc[row.reason] = (acc[row.reason] ?? 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1]),
  repairCandidates: byVerdict("REPAIR_TO_CERTIFIED_SELLER"),
  mutated: false,
  note: "Read-only. A repair requires a reviewed manifest, a D1 restore point and the documented invalidation workflow.",
  rows: classified,
};
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, rows: undefined, repairCandidates: report.repairCandidates.slice(0, 20) }, null, 1));
