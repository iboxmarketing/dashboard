import { env } from "cloudflare:workers";

import { getD1 } from "@/db";
import { getDictionary, saveDictionary } from "../storage";
import type { AnalyticsRecord } from "../types";
import { fetchCreatives, fetchDailyInsights, fetchMetaAccount, MetaApiError, nextWindow, normalizeAccountId, type MetaDailyRow } from "./meta-insights";
import { attributionBackfillPageSql } from "./sql";
import { getMarketingSettings, getTrackingD1, materializeAttribution, upsertMetaDaily } from "./store";

/* ------------------------------------------------- attribution backfill */

export const ATTRIBUTION_BACKFILL_KEY = "marketingAttributionBackfill";
export const ATTRIBUTION_BATCH = 150;

export type AttributionBackfillState = {
  status: "running" | "success" | "error";
  /** The last deal_id written; the next batch starts strictly after it. */
  cursor: string; processed: number; written: number; total: number;
  startedAt: string; updatedAt: string; lastError?: string | null;
};

/**
 * Resumable, idempotent historical backfill over every stored Deal (the
 * dashboard's own 365-day raw store). Each batch is an upsert keyed by deal_id,
 * so a rerun rewrites the same rows; the cursor is saved after every batch, so an
 * interruption resumes where it stopped instead of restarting from zero. Reads
 * raw_deals/analytics_records only; never writes a CRM or Sales table.
 */
export async function startAttributionBackfill(): Promise<AttributionBackfillState> {
  const total = await getD1().prepare("SELECT count(*) AS n FROM analytics_records").first<{ n: number }>();
  const now = new Date().toISOString();
  const state: AttributionBackfillState = { status: "running", cursor: "", processed: 0, written: 0, total: Number(total?.n ?? 0), startedAt: now, updatedAt: now, lastError: null };
  await saveDictionary(ATTRIBUTION_BACKFILL_KEY, state);
  return state;
}

export async function stepAttributionBackfill(): Promise<AttributionBackfillState> {
  const state = await getDictionary<AttributionBackfillState | null>(ATTRIBUTION_BACKFILL_KEY, null) ?? await startAttributionBackfill();
  if (state.status !== "running") return state;
  try {
    const page = await getD1().prepare(attributionBackfillPageSql(ATTRIBUTION_BATCH)).bind(state.cursor).all<{ deal_id: string; record: string; raw: string }>();
    const rows = page.results ?? [];
    const written = await materializeAttribution(
      rows.map((row) => JSON.parse(row.raw) as Record<string, unknown>),
      rows.map((row) => JSON.parse(row.record) as AnalyticsRecord),
    );
    const next: AttributionBackfillState = {
      ...state,
      cursor: rows.length ? rows[rows.length - 1].deal_id : state.cursor,
      processed: state.processed + rows.length,
      written: state.written + written.length,
      status: rows.length < ATTRIBUTION_BATCH ? "success" : "running",
      updatedAt: new Date().toISOString(),
      lastError: null,
    };
    await saveDictionary(ATTRIBUTION_BACKFILL_KEY, next);
    return next;
  } catch (error) {
    const failed = { ...state, status: "error" as const, updatedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
    await saveDictionary(ATTRIBUTION_BACKFILL_KEY, failed);
    return failed;
  }
}

/** Continue an errored run from its cursor (never from zero). */
export async function resumeAttributionBackfill() {
  const state = await getDictionary<AttributionBackfillState | null>(ATTRIBUTION_BACKFILL_KEY, null);
  if (state?.status === "error") await saveDictionary(ATTRIBUTION_BACKFILL_KEY, { ...state, status: "running", lastError: null });
  return stepAttributionBackfill();
}

/* ---------------------------------------------------- Meta Insights sync */

export const META_SYNC_KEY = "metaInsightsSync";
/** The dashboard Worker's own read-only Ads token (ads_read). Never logged. */
export const META_TOKEN_SECRET = "META_ADS_ACCESS_TOKEN";

export type MetaSyncAccount = {
  id: string; currency: string | null; timezone: string | null;
  /** Next window ends here (YYYY-MM-DD); null when the account is complete. */
  cursor: string | null; error: string | null; rows: number;
};

export type MetaSyncState = {
  status: "running" | "success" | "error" | "blocked";
  reason?: string | null;
  from: string; to: string; accounts: MetaSyncAccount[]; rows: number; startedAt: string; updatedAt: string;
};

function metaToken(): string | null {
  const value = (env as unknown as Record<string, string | undefined>)[META_TOKEN_SECRET];
  return value && value.trim() ? value.trim() : null;
}

function dateKey(date: Date) { return date.toISOString().slice(0, 10); }

/** Ad accounts: the Marketing setting, else every account the tracking D1 has seen a lead from. */
async function adAccounts(): Promise<{ id: string }[]> {
  const settings = await getMarketingSettings();
  if (settings.adAccounts.length) return settings.adAccounts;
  const tracking = getTrackingD1();
  if (!tracking) return [];
  const result = await tracking.prepare("SELECT DISTINCT ad_account_id FROM meta_leads WHERE ad_account_id IS NOT NULL AND ad_account_id <> ''").all<{ ad_account_id: string }>();
  return (result.results ?? []).map((row) => normalizeAccountId(row.ad_account_id)).filter((id): id is string => Boolean(id)).map((id) => ({ id }));
}

export async function startMetaSync(days = 365, fetchImpl: typeof fetch = fetch): Promise<MetaSyncState> {
  const now = new Date();
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  const base = { from: dateKey(new Date(now.getTime() - (safeDays - 1) * 86_400_000)), to: dateKey(now), accounts: [], rows: 0, startedAt: now.toISOString(), updatedAt: now.toISOString() };
  const token = metaToken();
  if (!token) {
    const blocked: MetaSyncState = { ...base, status: "blocked", reason: `${META_TOKEN_SECRET}_MISSING` };
    await saveDictionary(META_SYNC_KEY, blocked);
    return blocked;
  }
  const accounts: MetaSyncAccount[] = [];
  for (const account of await adAccounts()) {
    try {
      const info = await fetchMetaAccount(fetchImpl, account.id, token);
      accounts.push({ id: account.id, currency: info.currency, timezone: info.timezone, cursor: base.to, error: null, rows: 0 });
    } catch (error) {
      accounts.push({ id: account.id, currency: null, timezone: null, cursor: null, error: error instanceof MetaApiError ? error.code : "UNKNOWN", rows: 0 });
    }
  }
  const state: MetaSyncState = { ...base, accounts, status: accounts.some((account) => account.cursor) ? "running" : "error", reason: accounts.length ? null : "NO_AD_ACCOUNTS" };
  await saveDictionary(META_SYNC_KEY, state);
  return state;
}

/** One 7-day window of one account, newest first, then checkpoint. */
export async function stepMetaSync(fetchImpl: typeof fetch = fetch): Promise<MetaSyncState> {
  const state = await getDictionary<MetaSyncState | null>(META_SYNC_KEY, null);
  if (!state || state.status !== "running") return state ?? await startMetaSync(365, fetchImpl);
  const token = metaToken();
  if (!token) {
    const blocked = { ...state, status: "blocked" as const, reason: `${META_TOKEN_SECRET}_MISSING` };
    await saveDictionary(META_SYNC_KEY, blocked);
    return blocked;
  }
  const account = state.accounts.find((item) => item.cursor);
  if (!account) {
    const done = { ...state, status: "success" as const, updatedAt: new Date().toISOString() };
    await saveDictionary(META_SYNC_KEY, done);
    return done;
  }
  const window = nextWindow(account.cursor as string, state.from);
  let added = 0;
  if (window) {
    try {
      const rows: MetaDailyRow[] = await fetchDailyInsights(fetchImpl, { id: account.id, currency: account.currency ?? "USD", timezone: account.timezone }, window.since, window.until, token);
      let creatives = new Map<string, { creativeId: string | null; videoId: string | null; imageHash: string | null }>();
      try { creatives = await fetchCreatives(fetchImpl, [...new Set(rows.map((row) => row.adId))], token); } catch { /* creative identity is optional in V1 */ }
      for (const row of rows) {
        const creative = creatives.get(row.adId);
        if (creative) Object.assign(row, creative);
      }
      await upsertMetaDaily(rows);
      added = rows.length;
      account.cursor = window.nextCursor;
    } catch (error) {
      account.error = error instanceof MetaApiError ? error.code : "UNKNOWN";
      account.cursor = null;
    }
  } else account.cursor = null;
  account.rows += added;
  const next: MetaSyncState = {
    ...state, rows: state.rows + added, updatedAt: new Date().toISOString(),
    status: state.accounts.some((item) => item.cursor) ? "running" : state.accounts.some((item) => item.rows > 0) ? "success" : "error",
  };
  await saveDictionary(META_SYNC_KEY, next);
  return next;
}
