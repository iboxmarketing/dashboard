import type { MarketingFieldMap, MarketingFieldRole } from "./fields";
import { readIcp, type IcpClass } from "./icp";

/**
 * One Deal's normalized marketing attribution.
 *
 * Precedence (owner rule, 2026-10-14):
 *   1. the Bitrix Deal's own attribution fields (written by the tracking system),
 *   2. the tracking D1 record for exactly this Deal (Instant Form lead via
 *      bitrix_delivery/meta_leads, or the website submission),
 *   3. unknown.
 * Tracking only fills what Bitrix lacks. Where both carry a stable ID and they
 * differ, Bitrix stays and the row is marked ATTRIBUTION_CONFLICT with both
 * values kept for diagnostics — never silently overwritten.
 *
 * Stable IDs (campaign/adset/ad, lead/form/page) are the attribution keys; names
 * are display labels only. Both acquisition paths — Meta Instant Form and a
 * website lead from a Meta ad — end in the same shape.
 */
export type AttributionChannel = "META_INSTANT_FORM" | "WEBSITE" | "OTHER" | "UNKNOWN";
export type AttributionSource = "BITRIX" | "BITRIX+TRACKING" | "TRACKING_INSTANT_FORM" | "TRACKING_WEBSITE" | "BITRIX_UTM_ONLY" | "UNKNOWN";

export type TrackingTouch = Partial<Record<
  "campaign_id" | "campaign_name" | "adset_id" | "adset_name" | "ad_id" | "ad_name" | "placement" | "landing_path" | "landing_url"
  | "utm_source" | "utm_medium" | "utm_campaign" | "utm_content" | "utm_term" | "utm_id" | "fbclid" | "captured_at" | "site_source_name",
  string | null>>;

export type TrackingEvidence = {
  metaLead?: {
    lead_id: string; page_id?: string | null; form_id?: string | null; form_name?: string | null; ad_account_id?: string | null;
    campaign_id?: string | null; campaign_name?: string | null; adset_id?: string | null; adset_name?: string | null;
    ad_id?: string | null; ad_name?: string | null; platform?: string | null;
    utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null;
  } | null;
  website?: {
    submission_id: string; form_name?: string | null; locale?: string | null;
    first_touch?: TrackingTouch | null; last_paid_touch?: TrackingTouch | null; current_session?: TrackingTouch | null;
    landing_path?: string | null;
  } | null;
};

export type MarketingDealAttribution = {
  dealId: string;
  projectKey: string;
  utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; utmTerm: string | null;
  campaignId: string | null; campaignName: string | null;
  adsetId: string | null; adsetName: string | null;
  adId: string | null; adName: string | null;
  metaLeadId: string | null; formId: string | null; pageId: string | null; adAccountId: string | null;
  placement: string | null; landingPath: string | null; formName: string | null; locale: string | null;
  channel: AttributionChannel;
  attributionSource: AttributionSource;
  /** Null, or the stable-ID keys on which Bitrix and tracking disagree, with both values. */
  attributionConflict: Record<string, { bitrix: string; tracking: string }> | null;
  icpRaw: string | null; icpLabel: string | null; icpClass: IcpClass;
  leadCreatedAt: string;
  bitrixEvidence: Partial<Record<MarketingFieldRole, string>>;
  trackingEvidence: TrackingEvidence | null;
};

const STABLE_KEYS = ["campaignId", "adsetId", "adId", "metaLeadId", "formId", "pageId"] as const;
type StableKey = typeof STABLE_KEYS[number];

/** Meta IDs are long numeric strings; a template placeholder or free text is not an ID. */
export function stableId(raw: unknown): string | null {
  const text = scalar(raw);
  return text && /^\d{5,25}$/.test(text) ? text : null;
}

function scalar(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** Display text: trimmed, unresolved template placeholders dropped. */
function label(raw: unknown): string | null {
  const text = scalar(raw);
  if (!text || /\{\{.*\}\}/.test(text)) return null;
  return text.slice(0, 500);
}

function landingPath(raw: unknown): string | null {
  const text = label(raw);
  if (!text) return null;
  try { return new URL(text, "https://x.invalid").pathname || "/"; } catch { return text; }
}

export function buildDealAttribution(input: {
  deal: Record<string, unknown>;
  projectKey: string;
  leadCreatedAt: string;
  fields: MarketingFieldMap;
  icpOptions?: Map<string, string>;
  tracking?: TrackingEvidence | null;
}): MarketingDealAttribution {
  const { deal, fields } = input;
  const read = (role: MarketingFieldRole) => (fields[role] ? deal[fields[role] as string] : undefined);
  const bitrixEvidence: Partial<Record<MarketingFieldRole, string>> = {};
  for (const role of Object.keys(fields) as MarketingFieldRole[]) {
    const value = scalar(read(role));
    if (value) bitrixEvidence[role] = value.slice(0, 500);
  }

  // Bitrix stable IDs. utm_id carries the campaign id only when it is numeric.
  const bitrix: Record<StableKey, string | null> = {
    campaignId: stableId(read("metaCampaignId")) ?? stableId(read("utmId")),
    adsetId: stableId(read("metaAdsetId")),
    adId: stableId(read("metaAdId")),
    metaLeadId: stableId(read("metaLeadId")),
    formId: stableId(read("metaFormId")),
    pageId: stableId(read("metaPageId")),
  };

  const tracking = input.tracking ?? null;
  const lead = tracking?.metaLead ?? null;
  const site = tracking?.website ?? null;
  // A website lead's paid attribution is its last paid touch, else its first touch.
  const touch = site ? (site.last_paid_touch ?? site.first_touch ?? site.current_session ?? null) : null;
  const tracked: Record<StableKey, string | null> = {
    campaignId: stableId(lead?.campaign_id) ?? stableId(touch?.campaign_id) ?? stableId(touch?.utm_id),
    adsetId: stableId(lead?.adset_id) ?? stableId(touch?.adset_id),
    adId: stableId(lead?.ad_id) ?? stableId(touch?.ad_id),
    metaLeadId: stableId(lead?.lead_id),
    formId: stableId(lead?.form_id),
    pageId: stableId(lead?.page_id),
  };

  const ids = {} as Record<StableKey, string | null>;
  const conflict: Record<string, { bitrix: string; tracking: string }> = {};
  let fromBitrix = 0; let fromTracking = 0;
  for (const key of STABLE_KEYS) {
    const own = bitrix[key]; const other = tracked[key];
    if (own && other && own !== other) conflict[key] = { bitrix: own, tracking: other };
    ids[key] = own ?? other;
    if (own) fromBitrix += 1; else if (other) fromTracking += 1;
  }

  const utm = {
    utmSource: label(read("utmSource")) ?? label(lead?.utm_source) ?? label(touch?.utm_source),
    utmMedium: label(read("utmMedium")) ?? label(lead?.utm_medium) ?? label(touch?.utm_medium),
    utmCampaign: label(read("utmCampaign")) ?? label(lead?.utm_campaign) ?? label(touch?.utm_campaign),
    utmContent: label(read("utmContent")) ?? label(lead?.utm_content) ?? label(touch?.utm_content),
    utmTerm: label(read("utmTerm")) ?? label(lead?.utm_term) ?? label(touch?.utm_term),
  };
  const anyUtm = Object.values(utm).some(Boolean);

  const channel: AttributionChannel = ids.metaLeadId || lead
    ? "META_INSTANT_FORM"
    : site
      ? "WEBSITE"
      : ids.campaignId || ids.adId || anyUtm ? "OTHER" : "UNKNOWN";
  const attributionSource: AttributionSource = fromBitrix && fromTracking
    ? "BITRIX+TRACKING"
    : fromBitrix
      ? "BITRIX"
      : fromTracking
        ? (lead ? "TRACKING_INSTANT_FORM" : "TRACKING_WEBSITE")
        : anyUtm ? "BITRIX_UTM_ONLY" : "UNKNOWN";

  const icp = readIcp(read("icp"), fields.icp ? input.icpOptions : undefined);
  return {
    dealId: String(deal.ID ?? ""),
    projectKey: input.projectKey,
    ...utm,
    campaignId: ids.campaignId,
    campaignName: label(read("campaignName")) ?? label(lead?.campaign_name) ?? label(touch?.campaign_name),
    adsetId: ids.adsetId,
    adsetName: label(read("adsetName")) ?? label(lead?.adset_name) ?? label(touch?.adset_name),
    adId: ids.adId,
    adName: label(read("adName")) ?? label(lead?.ad_name) ?? label(touch?.ad_name),
    metaLeadId: ids.metaLeadId,
    formId: ids.formId,
    pageId: ids.pageId,
    adAccountId: stableId(read("adAccountId")) ?? stableId(lead?.ad_account_id),
    placement: label(read("placement")) ?? label(touch?.placement) ?? label(lead?.platform),
    landingPath: landingPath(read("landingPath")) ?? landingPath(touch?.landing_path ?? site?.landing_path ?? touch?.landing_url),
    formName: label(read("formName")) ?? label(lead?.form_name) ?? label(site?.form_name),
    locale: label(read("locale")) ?? label(site?.locale),
    channel,
    attributionSource,
    attributionConflict: Object.keys(conflict).length ? conflict : null,
    icpRaw: icp.raw, icpLabel: icp.label, icpClass: icp.icpClass,
    leadCreatedAt: input.leadCreatedAt,
    bitrixEvidence,
    trackingEvidence: tracking && (lead || site) ? tracking : null,
  };
}
