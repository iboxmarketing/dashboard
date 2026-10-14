-- Marketing data engine: normalized Deal attribution and Meta Ads daily insights.
--
-- Additive only: two new tables and their indexes. No existing table is touched,
-- so every Sales, Finance and Auth query is unaffected. Generated from
-- lib/marketing/schema.ts (a test keeps the two identical). Apply once per
-- database before deploying the build that reads it.
CREATE TABLE IF NOT EXISTS marketing_deal_attribution (
  deal_id TEXT PRIMARY KEY NOT NULL,
  project_key TEXT NOT NULL,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  campaign_id TEXT, campaign_name TEXT,
  adset_id TEXT, adset_name TEXT,
  ad_id TEXT, ad_name TEXT,
  meta_lead_id TEXT, form_id TEXT, page_id TEXT, ad_account_id TEXT,
  placement TEXT, landing_path TEXT, form_name TEXT, locale TEXT,
  channel TEXT NOT NULL,
  attribution_source TEXT NOT NULL,
  attribution_conflict TEXT,
  icp_raw TEXT, icp_label TEXT, icp_class TEXT NOT NULL,
  lead_created_at TEXT NOT NULL,
  bitrix_evidence_json TEXT NOT NULL,
  tracking_evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mda_project_created ON marketing_deal_attribution(project_key, lead_created_at);
CREATE INDEX IF NOT EXISTS idx_mda_campaign ON marketing_deal_attribution(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mda_adset ON marketing_deal_attribution(adset_id);
CREATE INDEX IF NOT EXISTS idx_mda_ad ON marketing_deal_attribution(ad_id);
CREATE INDEX IF NOT EXISTS idx_mda_meta_lead ON marketing_deal_attribution(meta_lead_id);
CREATE TABLE IF NOT EXISTS marketing_meta_daily (
  date TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  project_key TEXT,
  campaign_id TEXT, campaign_name TEXT,
  adset_id TEXT, adset_name TEXT,
  ad_name TEXT,
  creative_id TEXT, video_id TEXT, image_hash TEXT,
  spend_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  reach INTEGER,
  account_timezone TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, ad_id)
);
CREATE INDEX IF NOT EXISTS idx_mmd_date ON marketing_meta_daily(date);
CREATE INDEX IF NOT EXISTS idx_mmd_campaign ON marketing_meta_daily(campaign_id, date);
CREATE INDEX IF NOT EXISTS idx_mmd_adset ON marketing_meta_daily(adset_id, date);
CREATE INDEX IF NOT EXISTS idx_mmd_ad ON marketing_meta_daily(ad_id, date);
CREATE INDEX IF NOT EXISTS idx_mmd_project ON marketing_meta_daily(project_key, date);
