/**
 * Marketing tables — additive only (drizzle/0015_marketing_data.sql carries the
 * same statements; a test keeps the two identical).
 *
 * marketing_deal_attribution  one row per Deal, keyed by deal_id: the normalized
 *   attribution plus its raw evidence, with its marketing workspace (IBOX_UZ,
 *   SD_UZ, IBOX_KZ, SD_KZ — lib/marketing/workspaces.ts) and, for an activated
 *   workspace, its dashboard project. An upsert, so re-running a backfill or a
 *   sync never produces a second row for a Deal.
 * marketing_meta_daily        Meta Ads Insights, one row per (date, ad_id): a
 *   re-fetch of the same day replaces that day's numbers and never adds spend.
 *   Money is spend_minor (integer, ISO minor units) + currency. No project is
 *   stored: an ad's project is decided on every read from its Deals
 *   (lib/marketing/assignment.ts), so it follows Deals that arrive later.
 *
 * Neither table is read by any existing Sales, Finance or Auth query.
 */
export const MARKETING_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS marketing_deal_attribution (
  deal_id TEXT PRIMARY KEY NOT NULL,
  workspace_key TEXT NOT NULL,
  project_key TEXT,
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
)`,
  "CREATE INDEX IF NOT EXISTS idx_mda_workspace_created ON marketing_deal_attribution(workspace_key, lead_created_at)",
  "CREATE INDEX IF NOT EXISTS idx_mda_project_created ON marketing_deal_attribution(project_key, lead_created_at)",
  "CREATE INDEX IF NOT EXISTS idx_mda_campaign ON marketing_deal_attribution(campaign_id)",
  "CREATE INDEX IF NOT EXISTS idx_mda_adset ON marketing_deal_attribution(adset_id)",
  "CREATE INDEX IF NOT EXISTS idx_mda_ad ON marketing_deal_attribution(ad_id)",
  "CREATE INDEX IF NOT EXISTS idx_mda_meta_lead ON marketing_deal_attribution(meta_lead_id)",
  `CREATE TABLE IF NOT EXISTS marketing_meta_daily (
  date TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
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
)`,
  "CREATE INDEX IF NOT EXISTS idx_mmd_date ON marketing_meta_daily(date)",
  "CREATE INDEX IF NOT EXISTS idx_mmd_campaign ON marketing_meta_daily(campaign_id, date)",
  "CREATE INDEX IF NOT EXISTS idx_mmd_adset ON marketing_meta_daily(adset_id, date)",
  "CREATE INDEX IF NOT EXISTS idx_mmd_ad ON marketing_meta_daily(ad_id, date)",
];
