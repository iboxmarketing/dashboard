import { decimalToMinor } from "./money";
import type { SpendRow } from "./metrics";

/**
 * Meta Ads Insights — daily, ad level.
 *
 * One row per (date, ad_id): `level=ad&time_increment=1`. Spend arrives as a
 * decimal string in the ad account's currency and is stored as integer minor
 * units. IDs are the keys; names are labels refreshed on every fetch.
 *
 * The access token is passed in and never logged: every error message is built
 * from Meta's error code/type only, and any URL is stripped of its query.
 */
export const META_GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export const INSIGHT_FIELDS = [
  "date_start", "account_id", "account_currency", "campaign_id", "campaign_name", "adset_id", "adset_name",
  "ad_id", "ad_name", "spend", "impressions", "clicks", "reach",
] as const;

export type MetaAccount = { id: string; currency: string; timezone: string | null; name?: string | null };

export type MetaDailyRow = SpendRow & {
  adsetName: string | null; reach: number | null;
  videoId: string | null; imageHash: string | null; accountTimezone: string | null;
};

export class MetaApiError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) { super(`Meta API ${code} (HTTP ${httpStatus})`); this.name = "MetaApiError"; }
}

type Fetch = typeof fetch;

async function graph<T>(fetchImpl: Fetch, path: string, params: Record<string, string>, token: string): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);
  let response: Response;
  try { response = await fetchImpl(url.toString(), { headers: { accept: "application/json" } }); }
  catch { throw new MetaApiError("NETWORK", 0); }
  const body = await response.json().catch(() => null) as { error?: { code?: number; type?: string; error_subcode?: number } } | null;
  if (!response.ok || body?.error) {
    const error = body?.error;
    throw new MetaApiError(error ? `${error.type ?? "OAuthException"}:${error.code ?? "?"}${error.error_subcode ? `/${error.error_subcode}` : ""}` : "HTTP", response.status);
  }
  return body as T;
}

export function normalizeAccountId(raw: string) {
  const digits = String(raw).replace(/^act_/, "").trim();
  return /^\d{5,25}$/.test(digits) ? digits : null;
}

export async function fetchMetaAccount(fetchImpl: Fetch, accountId: string, token: string): Promise<MetaAccount> {
  const body = await graph<{ id?: string; currency?: string; timezone_name?: string; name?: string }>(
    fetchImpl, `act_${accountId}`, { fields: "currency,timezone_name,name" }, token);
  if (!body.currency) throw new MetaApiError("NO_CURRENCY", 200);
  return { id: accountId, currency: body.currency.toUpperCase(), timezone: body.timezone_name ?? null, name: body.name ?? null };
}

type InsightRow = Partial<Record<typeof INSIGHT_FIELDS[number], string>>;

/** One Insights row → a stored daily row. The account's currency wins over a row's. */
export function parseInsightRow(row: InsightRow, account: MetaAccount): MetaDailyRow | null {
  const adId = String(row.ad_id ?? "").trim();
  const date = String(row.date_start ?? "").trim();
  if (!/^\d{5,25}$/.test(adId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const currency = (row.account_currency || account.currency).toUpperCase();
  const count = (value: unknown) => { const n = Number.parseInt(String(value ?? "0"), 10); return Number.isSafeInteger(n) && n >= 0 ? n : 0; };
  return {
    date, adId, adAccountId: account.id,
    campaignId: /^\d+$/.test(String(row.campaign_id ?? "")) ? String(row.campaign_id) : null,
    campaignName: row.campaign_name?.trim() || null,
    adsetId: /^\d+$/.test(String(row.adset_id ?? "")) ? String(row.adset_id) : null,
    adsetName: row.adset_name?.trim() || null,
    adName: row.ad_name?.trim() || null,
    creativeId: null, videoId: null, imageHash: null,
    spendMinor: decimalToMinor(row.spend ?? "0", currency),
    currency,
    impressions: count(row.impressions), clicks: count(row.clicks),
    reach: row.reach === undefined ? null : count(row.reach),
    accountTimezone: account.timezone,
  };
}

/** Every ad-day in [since, until] for one account, following Meta's paging. */
export async function fetchDailyInsights(fetchImpl: Fetch, account: MetaAccount, since: string, until: string, token: string) {
  const rows: MetaDailyRow[] = [];
  let next: string | null = `act_${account.id}/insights`;
  let params: Record<string, string> = {
    level: "ad", time_increment: "1", limit: "500", fields: INSIGHT_FIELDS.join(","),
    time_range: JSON.stringify({ since, until }), action_attribution_windows: "[]",
  };
  for (let page = 0; next && page < 50; page += 1) {
    const body: { data?: InsightRow[]; paging?: { next?: string } } = await graph(fetchImpl, next, params, token);
    for (const raw of body.data ?? []) { const row = parseInsightRow(raw, account); if (row) rows.push(row); }
    // The `next` URL already carries every parameter (and the token, which graph() re-sets).
    next = body.paging?.next ? body.paging.next.split("?")[0] + "?" + new URL(body.paging.next).searchParams.toString() : null;
    params = {};
  }
  return rows;
}

/** creative/video/image identity per ad, 50 ads per request. Optional: failures leave the ids null. */
export async function fetchCreatives(fetchImpl: Fetch, adIds: readonly string[], token: string) {
  const out = new Map<string, { creativeId: string | null; videoId: string | null; imageHash: string | null }>();
  for (let index = 0; index < adIds.length; index += 50) {
    const ids = adIds.slice(index, index + 50);
    const body = await graph<Record<string, { creative?: { id?: string; video_id?: string; image_hash?: string } }>>(
      fetchImpl, "", { ids: ids.join(","), fields: "creative{id,video_id,image_hash}" }, token);
    for (const id of ids) {
      const creative = body[id]?.creative;
      out.set(id, { creativeId: creative?.id ?? null, videoId: creative?.video_id ?? null, imageHash: creative?.image_hash ?? null });
    }
  }
  return out;
}

/** The newest-first window walk: [max(from, cursor-6), cursor], then before it. */
export function nextWindow(cursorUntil: string, from: string, days = 7): { since: string; until: string; nextCursor: string | null } | null {
  if (cursorUntil < from) return null;
  const until = new Date(`${cursorUntil}T00:00:00Z`);
  const start = new Date(until.getTime() - (days - 1) * 86_400_000);
  const since = start.toISOString().slice(0, 10) < from ? from : start.toISOString().slice(0, 10);
  const before = new Date(new Date(`${since}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  return { since, until: cursorUntil, nextCursor: before < from ? null : before };
}
