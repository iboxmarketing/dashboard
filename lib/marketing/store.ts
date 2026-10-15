import { env } from "cloudflare:workers";

import { getD1 } from "@/db";
import { canonicalDealFieldKey } from "../crm-fields";
import { buildFieldOptionMap } from "../analytics-dictionaries";
import { recordProject, type ProjectKey } from "../sales-projects";
import type { AnalyticsRecord, CrmFieldOption } from "../types";
import { getDictionary } from "../storage";
import { buildDealAttribution, type MarketingDealAttribution, type TrackingEvidence } from "./attribution";
import type { MarketingFieldMap, MarketingFieldResolution } from "./fields";
import type { IcpClass } from "./icp";
import type { MetaDailyRow } from "./meta-insights";
import type { AttributionView, SpendRow } from "./metrics";
import { DEFAULT_MARKETING_USD_TO_UZS, type MarketingFx } from "./money";
import { assignAds, collectAdEvidence } from "./assignment";
import { MARKETING_SCHEMA_STATEMENTS } from "./schema";
import { MARKETING_WORKSPACES, workspaceForProject } from "./workspaces";
import { trackingCoverageRow, type CoverageEvidence } from "./coverage";
import { ATTRIBUTION_UPSERT, DAILY_UPSERT, attributionBindings, dailyBindings } from "./sql";

/**
 * Marketing persistence. Dashboard D1 for its own two tables; the Meta
 * lead-tracking D1 (binding TRACKING_DB) strictly READ-ONLY — every statement
 * against it below is a SELECT, and none of its tables is ever written.
 */
type D1 = ReturnType<typeof getD1>;
const ensured = new WeakSet<object>();

export async function ensureMarketingSchema(db: D1 = getD1()) {
  if (ensured.has(db)) return;
  await db.batch(MARKETING_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  ensured.add(db);
}

/** The tracking D1, when this Worker is bound to it. Absent → tracking fallback is skipped. */
export function getTrackingD1(): D1 | null {
  return (env as unknown as { TRACKING_DB?: D1 }).TRACKING_DB ?? null;
}

/* ---------------------------------------------------------------- settings */

export type MarketingSettings = {
  /** Owner decision 2026-10-14: a reporting rate, not Finance FX. */
  usdToUzs: number;
  /**
   * Meta ad accounts to ingest. Deliberately NOT tied to a project: an account
   * feeds several funnels, so spend is assigned per ad (lib/marketing/assignment.ts).
   */
  adAccounts: { id: string }[];
};

const MARKETING_SETTINGS_KEY = "marketing";

export async function getMarketingSettings(db: D1 = getD1()): Promise<MarketingSettings> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(MARKETING_SETTINGS_KEY).first<{ value: string }>();
  let parsed: Partial<MarketingSettings> = {};
  try { parsed = row?.value ? JSON.parse(row.value) as Partial<MarketingSettings> : {}; } catch { parsed = {}; }
  const rate = Number(parsed.usdToUzs);
  return {
    usdToUzs: Number.isSafeInteger(rate) && rate > 0 ? rate : DEFAULT_MARKETING_USD_TO_UZS,
    adAccounts: Array.isArray(parsed.adAccounts)
      ? parsed.adAccounts.filter((item) => /^\d{5,25}$/.test(String(item?.id ?? ""))).map((item) => ({ id: String(item.id) }))
      : [],
  };
}

export async function saveMarketingSettings(settings: MarketingSettings, db: D1 = getD1()) {
  await db.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(MARKETING_SETTINGS_KEY, JSON.stringify(settings), new Date().toISOString()).run();
}

export function marketingFx(settings: MarketingSettings): MarketingFx { return { usdToUzs: settings.usdToUzs }; }

/* ------------------------------------------------------------- attribution */

export async function upsertAttributions(rows: readonly MarketingDealAttribution[], db: D1 = getD1()) {
  if (!rows.length) return;
  await ensureMarketingSchema(db);
  const now = new Date().toISOString();
  for (let index = 0; index < rows.length; index += 40) {
    await db.batch(rows.slice(index, index + 40).map((row) => db.prepare(ATTRIBUTION_UPSERT).bind(...attributionBindings(row, now))));
  }
}

type AttributionDbRow = {
  deal_id: string; campaign_id: string | null; campaign_name: string | null; adset_id: string | null; adset_name: string | null;
  ad_id: string | null; ad_name: string | null; placement: string | null; landing_path: string | null;
  channel: string; attribution_source: string; attribution_conflict: string | null; icp_class: string;
};

/** Attribution of one project's Deals created in [fromIso, toIso], keyed by Deal. */
export async function listAttributionViews(project: string, fromIso: string, toIso: string, db: D1 = getD1()) {
  await ensureMarketingSchema(db);
  const result = await db.prepare(`SELECT deal_id, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, placement, landing_path,
      channel, attribution_source, attribution_conflict, icp_class
    FROM marketing_deal_attribution WHERE project_key = ? AND lead_created_at >= ? AND lead_created_at <= ?`)
    .bind(project, fromIso, toIso).all<AttributionDbRow>();
  return new Map((result.results ?? []).map((row) => [row.deal_id, toView(row)]));
}

export function toView(row: AttributionDbRow): AttributionView {
  return {
    dealId: row.deal_id, campaignId: row.campaign_id, campaignName: row.campaign_name, adsetId: row.adset_id, adsetName: row.adset_name,
    adId: row.ad_id, adName: row.ad_name, placement: row.placement, landingPath: row.landing_path,
    channel: row.channel, attributionSource: row.attribution_source, conflict: Boolean(row.attribution_conflict),
    icpClass: (row.icp_class || "UNSET") as IcpClass,
  };
}

/* ---------------------------------------------------------- tracking (RO) */

type MetaLeadRow = NonNullable<TrackingEvidence["metaLead"]> & { deal_id: string };
type WebsiteRow = { deal_id: string; submission_id: string; form_name: string | null; locale: string | null; attribution_json: string };

/**
 * Tracking evidence for exactly these Deals: the Instant Form lead delivered as
 * the Deal (bitrix_delivery.deal_id → meta_leads, or meta_leads' own entity id),
 * and the website submission whose Deal it is. SELECT only.
 */
export async function lookupTracking(dealIds: readonly string[], tracking: D1 | null = getTrackingD1()) {
  const out = new Map<string, TrackingEvidence>();
  if (!tracking || !dealIds.length) return out;
  for (let index = 0; index < dealIds.length; index += 80) {
    const ids = dealIds.slice(index, index + 80);
    const marks = ids.map(() => "?").join(",");
    const leadSelect = `m.lead_id, m.page_id, m.form_id, m.form_name, m.ad_account_id, m.campaign_id, m.campaign_name,
      m.adset_id, m.adset_name, m.ad_id, m.ad_name, m.platform, m.utm_source, m.utm_medium, m.utm_campaign, m.utm_content, m.utm_term`;
    const [delivered, direct, website] = await tracking.batch([
      tracking.prepare(`SELECT d.deal_id AS deal_id, ${leadSelect} FROM bitrix_delivery d JOIN meta_leads m ON m.lead_id = d.lead_id WHERE d.deal_id IN (${marks})`).bind(...ids),
      tracking.prepare(`SELECT m.bitrix_entity_id AS deal_id, ${leadSelect} FROM meta_leads m WHERE m.bitrix_entity_type = 'deal' AND m.bitrix_entity_id IN (${marks})`).bind(...ids),
      tracking.prepare(`SELECT deal_id, submission_id, form_name, locale, attribution_json FROM website_leads WHERE deal_id IN (${marks})`).bind(...ids),
    ]);
    for (const row of [...((delivered.results ?? []) as MetaLeadRow[]), ...((direct.results ?? []) as MetaLeadRow[])]) {
      const dealId = String(row.deal_id);
      if (!out.get(dealId)?.metaLead) out.set(dealId, { ...(out.get(dealId) ?? {}), metaLead: { ...row } });
    }
    for (const row of (website.results ?? []) as WebsiteRow[]) {
      let attribution: Record<string, unknown> = {};
      try { attribution = JSON.parse(row.attribution_json) as Record<string, unknown>; } catch { attribution = {}; }
      const dealId = String(row.deal_id);
      if (out.get(dealId)?.website) continue;
      out.set(dealId, {
        ...(out.get(dealId) ?? {}),
        website: {
          submission_id: row.submission_id, form_name: row.form_name, locale: row.locale,
          first_touch: (attribution.first_touch ?? null) as never, last_paid_touch: (attribution.last_paid_touch ?? null) as never,
          current_session: (attribution.current_session ?? null) as never,
          landing_path: typeof attribution.landing_path === "string" ? attribution.landing_path : null,
        },
      });
    }
  }
  return out;
}

/* ---------------------------------------------- materialize from records */

/**
 * Attribution for a batch of freshly built analytics records, from their raw
 * Deals. Used by Full/incremental Sync (every analytics batch) and the backfill,
 * so future Deals never need a manual marketing backfill. A record with no
 * project (a legacy record awaiting its project's rebuild) is skipped.
 */
export async function materializeAttribution(
  rawDeals: readonly Record<string, unknown>[], records: readonly AnalyticsRecord[],
  context?: { resolution?: MarketingFieldResolution; crmFields?: CrmFieldOption[]; tracking?: D1 | null; db?: D1 },
) {
  const resolution = context?.resolution ?? await getDictionary<MarketingFieldResolution>("marketingFields", { fields: {}, ambiguous: [] });
  const crmFields = context?.crmFields ?? await getDictionary<CrmFieldOption[]>("crmFields", []);
  const fields: MarketingFieldMap = resolution.fields ?? {};
  const icpOptions = fields.icp ? buildFieldOptionMap(crmFields).get(canonicalDealFieldKey(fields.icp)) : undefined;
  const byId = new Map(rawDeals.map((deal) => [String(deal.ID ?? ""), deal]));
  const projected = records
    .map((record) => ({ record, project: recordProject(record), deal: byId.get(record.dealId) }))
    .filter((item): item is { record: AnalyticsRecord; project: NonNullable<ReturnType<typeof recordProject>>; deal: Record<string, unknown> } => Boolean(item.project && item.deal));
  const tracking = await lookupTracking(projected.map((item) => item.record.dealId), context?.tracking === undefined ? getTrackingD1() : context.tracking);
  const rows = projected.map(({ record, project, deal }) => buildDealAttribution({
    deal, workspaceKey: workspaceForProject(project), projectKey: project, leadCreatedAt: record.createdAt, fields, icpOptions, tracking: tracking.get(record.dealId) ?? null,
  }));
  await upsertAttributions(rows, context?.db);
  return rows;
}

/* ------------------------------------------------------------- meta daily */

/** Same (date, ad) replaces that day's numbers: a re-fetch never adds spend. */
export async function upsertMetaDaily(rows: readonly MetaDailyRow[], db: D1 = getD1()) {
  if (!rows.length) return;
  await ensureMarketingSchema(db);
  const now = new Date().toISOString();
  for (let index = 0; index < rows.length; index += 40) {
    await db.batch(rows.slice(index, index + 40).map((row) => db.prepare(DAILY_UPSERT).bind(...dailyBindings(row, now))));
  }
}

export type SpendFilter = { campaignId?: string | null; adsetId?: string | null; adId?: string | null };

type DailyDbRow = { date: string; ad_id: string; ad_account_id: string; campaign_id: string | null; campaign_name: string | null; adset_id: string | null;
  adset_name: string | null; ad_name: string | null; creative_id: string | null; spend_minor: number; currency: string; impressions: number; clicks: number };

/** Every account's ad-day spend in [fromDate, toDate], before project assignment. */
export async function listSpendRows(fromDate: string, toDate: string, filter: SpendFilter = {}, db: D1 = getD1()): Promise<SpendRow[]> {
  await ensureMarketingSchema(db);
  const clauses = ["date >= ?", "date <= ?"];
  const binds: unknown[] = [fromDate, toDate];
  if (filter.campaignId) { clauses.push("campaign_id = ?"); binds.push(filter.campaignId); }
  if (filter.adsetId) { clauses.push("adset_id = ?"); binds.push(filter.adsetId); }
  if (filter.adId) { clauses.push("ad_id = ?"); binds.push(filter.adId); }
  const result = await db.prepare(`SELECT date, ad_id, ad_account_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, creative_id,
      spend_minor, currency, impressions, clicks FROM marketing_meta_daily WHERE ${clauses.join(" AND ")}`).bind(...binds).all<DailyDbRow>();
  return (result.results ?? []).map((row) => ({
    date: row.date, adId: row.ad_id, adAccountId: row.ad_account_id, campaignId: row.campaign_id, campaignName: row.campaign_name,
    adsetId: row.adset_id, adsetName: row.adset_name, adName: row.ad_name, creativeId: row.creative_id,
    spendMinor: Number(row.spend_minor), currency: row.currency, impressions: Number(row.impressions), clicks: Number(row.clicks),
  }));
}

/**
 * Per-ad destination evidence: the dashboard's attribution (Deal → project) and,
 * when bound, the tracking D1's lead → Deal → current Bitrix category — which
 * also sees Deals in funnels the dashboard never syncs (41, 33, 1). SELECT only.
 */
export async function loadAdEvidence(adIds: readonly string[], db: D1 = getD1(), tracking: D1 | null = getTrackingD1()) {
  await ensureMarketingSchema(db);
  const attribution: { adId: string | null; workspaceKey: string | null }[] = [];
  const categories: { adId: string | null; categoryId: string | null }[] = [];
  for (let index = 0; index < adIds.length; index += 80) {
    const ids = adIds.slice(index, index + 80);
    const marks = ids.map(() => "?").join(",");
    const own = await db.prepare(`SELECT DISTINCT ad_id, workspace_key FROM marketing_deal_attribution WHERE ad_id IN (${marks})`).bind(...ids)
      .all<{ ad_id: string; workspace_key: string }>();
    attribution.push(...(own.results ?? []).map((row) => ({ adId: row.ad_id, workspaceKey: row.workspace_key })));
    if (!tracking) continue;
    const [leads, site] = await tracking.batch([
      tracking.prepare(`SELECT DISTINCT m.ad_id AS ad_id, h.category_id AS category_id FROM meta_leads m
        JOIN bitrix_delivery d ON d.lead_id = m.lead_id JOIN deal_health h ON h.deal_id = d.deal_id
        WHERE m.ad_id IN (${marks}) AND h.category_id IS NOT NULL`).bind(...ids),
      tracking.prepare(`SELECT DISTINCT COALESCE(json_extract(w.attribution_json, '$.last_paid_touch.ad_id'), json_extract(w.attribution_json, '$.first_touch.ad_id')) AS ad_id,
        h.category_id AS category_id FROM website_leads w JOIN deal_health h ON h.deal_id = w.deal_id
        WHERE COALESCE(json_extract(w.attribution_json, '$.last_paid_touch.ad_id'), json_extract(w.attribution_json, '$.first_touch.ad_id')) IN (${marks})
          AND h.category_id IS NOT NULL`).bind(...ids),
    ]);
    for (const row of [...((leads.results ?? []) as { ad_id: string; category_id: string }[]), ...((site.results ?? []) as { ad_id: string; category_id: string }[])]) {
      categories.push({ adId: String(row.ad_id), categoryId: String(row.category_id) });
    }
  }
  return collectAdEvidence(attribution, categories);
}

/** One project's spend: only the ads assigned to its workspace (Campaign/Ad set totals roll these up). */
export async function listSpend(project: ProjectKey, fromDate: string, toDate: string, filter: SpendFilter = {}, db: D1 = getD1()): Promise<SpendRow[]> {
  const rows = await listSpendRows(fromDate, toDate, filter, db);
  const assignment = assignAds(await loadAdEvidence([...new Set(rows.map((row) => row.adId))], db), rows.map((row) => row.adId));
  const workspace = workspaceForProject(project);
  return rows.filter((row) => assignment.get(row.adId) === workspace);
}

/** Every ad-day in the range, bucketed by workspace, NON_DASHBOARD, MIXED or UNASSIGNED. */
export async function spendAssignmentReport(fromDate: string, toDate: string, db: D1 = getD1()) {
  const rows = await listSpendRows(fromDate, toDate, {}, db);
  const adIds = [...new Set(rows.map((row) => row.adId))];
  const assignment = assignAds(await loadAdEvidence(adIds, db), adIds);
  return { rows, assignment };
}

/** Coverage evidence for every workspace in [fromDate, toDate] (YYYY-MM-DD): dashboard rows, plus tracking for reserved ones. SELECT only. */
export async function workspaceCoverageEvidence(fromDate: string, toDate: string, db: D1 = getD1(), tracking: D1 | null = getTrackingD1()) {
  await ensureMarketingSchema(db);
  const own = await db.prepare(`SELECT deal_id, workspace_key, campaign_id, adset_id, ad_id, channel, attribution_conflict FROM marketing_deal_attribution
    WHERE substr(lead_created_at, 1, 10) >= ? AND substr(lead_created_at, 1, 10) <= ?`).bind(fromDate, toDate)
    .all<{ deal_id: string; workspace_key: string; campaign_id: string | null; adset_id: string | null; ad_id: string | null; channel: string; attribution_conflict: string | null }>();
  const rows: CoverageEvidence[] = (own.results ?? []).map((row) => ({
    dealId: row.deal_id, workspaceKey: row.workspace_key, campaignId: row.campaign_id, adsetId: row.adset_id, adId: row.ad_id,
    channel: row.channel, conflict: Boolean(row.attribution_conflict),
  }));
  const reserved = MARKETING_WORKSPACES.filter((workspace) => !workspace.activated);
  if (tracking && reserved.length) {
    const cases = reserved.map((workspace) => `WHEN h.category_id IN (${workspace.categoryIds.map((id) => `'${id}'`).join(",")}) THEN '${workspace.key}'`).join(" ");
    const categories = reserved.flatMap((workspace) => workspace.categoryIds as readonly string[]);
    const result = await tracking.prepare(`SELECT h.deal_id AS deal_id, CASE ${cases} END AS workspace_key,
        m.lead_id AS lead_id, m.campaign_id AS mc, m.adset_id AS ma, m.ad_id AS mad, w.submission_id AS submission_id,
        COALESCE(json_extract(w.attribution_json, '$.last_paid_touch.campaign_id'), json_extract(w.attribution_json, '$.first_touch.campaign_id')) AS wc,
        COALESCE(json_extract(w.attribution_json, '$.last_paid_touch.adset_id'), json_extract(w.attribution_json, '$.first_touch.adset_id')) AS wa,
        COALESCE(json_extract(w.attribution_json, '$.last_paid_touch.ad_id'), json_extract(w.attribution_json, '$.first_touch.ad_id')) AS wad
      FROM deal_health h
      LEFT JOIN bitrix_delivery d ON d.deal_id = h.deal_id LEFT JOIN meta_leads m ON m.lead_id = d.lead_id
      LEFT JOIN website_leads w ON w.deal_id = h.deal_id
      WHERE h.category_id IN (${categories.map(() => "?").join(",")}) AND substr(h.date_create, 1, 10) >= ? AND substr(h.date_create, 1, 10) <= ?`)
      .bind(...categories, fromDate, toDate).all<Parameters<typeof trackingCoverageRow>[0]>();
    const known = new Set(rows.map((row) => row.dealId));
    for (const row of result.results ?? []) if (!known.has(String(row.deal_id))) rows.push(trackingCoverageRow(row));
  }
  return rows;
}
