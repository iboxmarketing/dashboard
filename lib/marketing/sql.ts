import type { MarketingDealAttribution } from "./attribution";
import type { MetaDailyRow } from "./meta-insights";

/**
 * The marketing write statements, dependency-free so the exact SQL the Worker
 * runs is also exercised by tests (against SQLite, with the real migration).
 *
 * Both are upserts on the table's natural key — deal_id; (date, ad_id) — so a
 * rerun of a backfill, a sync or an Insights window rewrites rows in place and
 * can never add a second attribution row or a second day of spend.
 */
export const ATTRIBUTION_UPSERT = `INSERT INTO marketing_deal_attribution(
  deal_id, project_key, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
  meta_lead_id, form_id, page_id, ad_account_id, placement, landing_path, form_name, locale,
  channel, attribution_source, attribution_conflict, icp_raw, icp_label, icp_class, lead_created_at,
  bitrix_evidence_json, tracking_evidence_json, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(deal_id) DO UPDATE SET
  project_key = excluded.project_key, utm_source = excluded.utm_source, utm_medium = excluded.utm_medium,
  utm_campaign = excluded.utm_campaign, utm_content = excluded.utm_content, utm_term = excluded.utm_term,
  campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name, adset_id = excluded.adset_id,
  adset_name = excluded.adset_name, ad_id = excluded.ad_id, ad_name = excluded.ad_name,
  meta_lead_id = excluded.meta_lead_id, form_id = excluded.form_id, page_id = excluded.page_id,
  ad_account_id = excluded.ad_account_id, placement = excluded.placement, landing_path = excluded.landing_path,
  form_name = excluded.form_name, locale = excluded.locale, channel = excluded.channel,
  attribution_source = excluded.attribution_source, attribution_conflict = excluded.attribution_conflict,
  icp_raw = excluded.icp_raw, icp_label = excluded.icp_label, icp_class = excluded.icp_class,
  lead_created_at = excluded.lead_created_at, bitrix_evidence_json = excluded.bitrix_evidence_json,
  tracking_evidence_json = excluded.tracking_evidence_json, updated_at = excluded.updated_at`;

export function attributionBindings(row: MarketingDealAttribution, now: string) {
  return [
    row.dealId, row.projectKey, row.utmSource, row.utmMedium, row.utmCampaign, row.utmContent, row.utmTerm,
    row.campaignId, row.campaignName, row.adsetId, row.adsetName, row.adId, row.adName,
    row.metaLeadId, row.formId, row.pageId, row.adAccountId, row.placement, row.landingPath, row.formName, row.locale,
    row.channel, row.attributionSource, row.attributionConflict ? JSON.stringify(row.attributionConflict) : null,
    row.icpRaw, row.icpLabel, row.icpClass, row.leadCreatedAt,
    JSON.stringify(row.bitrixEvidence), row.trackingEvidence ? JSON.stringify(row.trackingEvidence) : null, now, now,
  ];
}


export const DAILY_UPSERT = `INSERT INTO marketing_meta_daily(date, ad_id, ad_account_id, campaign_id, campaign_name,
  adset_id, adset_name, ad_name, creative_id, video_id, image_hash, spend_minor, currency, impressions, clicks, reach, account_timezone, fetched_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(date, ad_id) DO UPDATE SET
  ad_account_id = excluded.ad_account_id,
  campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name, adset_id = excluded.adset_id,
  adset_name = excluded.adset_name, ad_name = excluded.ad_name,
  creative_id = COALESCE(excluded.creative_id, marketing_meta_daily.creative_id),
  video_id = COALESCE(excluded.video_id, marketing_meta_daily.video_id),
  image_hash = COALESCE(excluded.image_hash, marketing_meta_daily.image_hash),
  spend_minor = excluded.spend_minor, currency = excluded.currency, impressions = excluded.impressions,
  clicks = excluded.clicks, reach = excluded.reach, account_timezone = excluded.account_timezone, fetched_at = excluded.fetched_at`;

export function dailyBindings(row: MetaDailyRow, fetchedAt: string) {
  return [row.date, row.adId, row.adAccountId, row.campaignId, row.campaignName, row.adsetId, row.adsetName,
    row.adName, row.creativeId, row.videoId, row.imageHash, row.spendMinor, row.currency, row.impressions, row.clicks,
    row.reach, row.accountTimezone, fetchedAt];
}

/**
 * One backfill page: Deals strictly after the saved cursor, in deal_id order.
 * Resuming re-reads nothing already written and skips nothing not yet written.
 */
export function attributionBackfillPageSql(batch: number) {
  const size = Math.max(1, Math.floor(batch));
  return `SELECT a.deal_id AS deal_id, a.payload AS record, r.payload AS raw
      FROM analytics_records a JOIN raw_deals r ON r.deal_id = a.deal_id
      WHERE a.deal_id > ? ORDER BY a.deal_id LIMIT ${size}`;
}
