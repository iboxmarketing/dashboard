import { canonicalDealFieldKey } from "../crm-fields";
import type { CrmFieldOption } from "../types";

/**
 * The Bitrix Deal fields marketing attribution reads.
 *
 * No numeric UF_CRM id is guessed here. Every role is resolved against the live
 * Bitrix field metadata (`crmFields`, refreshed by each Full Sync):
 *
 *  - `keys`   exact field codes with external evidence: the standard Deal UTM
 *             fields; the named `UF_CRM_META_*` fields the Meta lead-tracking
 *             Worker writes (its write audit lists exactly these codes); the ICP
 *             field the owner named.
 *  - `titles` a title pattern for a field the metadata names but no other
 *             system pins, e.g. "Marketing: Landing".
 *
 * A role resolves only when its field EXISTS in the metadata, and a title pattern
 * resolves only when exactly one field matches — two candidates are a question
 * for a human, not a pick. Unresolved roles are simply absent from the Deal read.
 */
export type MarketingFieldRole =
  | "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm" | "utmId"
  | "metaLeadId" | "metaPageId" | "metaFormId" | "metaCampaignId" | "metaAdsetId" | "metaAdId"
  | "adAccountId" | "campaignName" | "adsetName" | "adName"
  | "placement" | "landingPath" | "formName" | "locale"
  | "icp";

type FieldSpec = { role: MarketingFieldRole; keys?: string[]; titles?: RegExp[] };

/** Owner-named ICP field (2026-10-14): "ICP ga moslik". */
export const ICP_FIELD = "UF_CRM_1787725980192";

export const MARKETING_FIELD_SPECS: readonly FieldSpec[] = [
  { role: "utmSource", keys: ["UTM_SOURCE"] },
  { role: "utmMedium", keys: ["UTM_MEDIUM"] },
  { role: "utmCampaign", keys: ["UTM_CAMPAIGN"] },
  { role: "utmContent", keys: ["UTM_CONTENT"] },
  { role: "utmTerm", keys: ["UTM_TERM"] },
  // The tracking Worker's Instant Form route maps `campaignId` to this field;
  // Bitrix titles it "utm_id". Meta fills utm_id with the campaign id.
  { role: "utmId", titles: [/^\s*utm[_ ]?id\s*$/i] },
  { role: "metaLeadId", keys: ["UF_CRM_META_LEAD_ID"], titles: [/meta\s*lead\s*id/i] },
  { role: "metaPageId", keys: ["UF_CRM_META_PAGE_ID"], titles: [/meta\s*page\s*id/i] },
  { role: "metaFormId", keys: ["UF_CRM_META_FORM_ID"], titles: [/meta\s*form\s*id/i] },
  { role: "metaCampaignId", keys: ["UF_CRM_META_CAMPAIGN_ID"], titles: [/meta\s*campaign\s*id/i] },
  { role: "metaAdsetId", keys: ["UF_CRM_META_ADSET_ID"], titles: [/meta\s*ad\s*set\s*id|meta\s*adset\s*id/i] },
  { role: "metaAdId", keys: ["UF_CRM_META_AD_ID"], titles: [/^\s*meta\s*ad\s*id\s*$/i] },
  { role: "adAccountId", keys: ["UF_CRM_META_AD_ACCOUNT_ID"], titles: [/ad\s*account\s*id/i] },
  { role: "campaignName", keys: ["UF_CRM_META_CAMPAIGN_NAME"], titles: [/meta\s*campaign\s*name/i] },
  { role: "adsetName", keys: ["UF_CRM_META_ADSET_NAME"], titles: [/meta\s*ad\s*set\s*name|meta\s*adset\s*name/i] },
  { role: "adName", keys: ["UF_CRM_META_AD_NAME"], titles: [/^\s*meta\s*ad\s*name\s*$/i] },
  { role: "placement", keys: ["UF_CRM_META_PLACEMENT"], titles: [/placement/i] },
  { role: "landingPath", titles: [/marketing:\s*landing/i, /landing\s*(path|page|url)/i] },
  { role: "formName", keys: ["UF_CRM_META_FORM_NAME"], titles: [/meta\s*form\s*name/i] },
  { role: "locale", keys: ["UF_CRM_META_LOCALE"], titles: [/^\s*(lead\s*)?locale\s*$/i] },
  { role: "icp", keys: [ICP_FIELD] },
];

export type MarketingFieldMap = Partial<Record<MarketingFieldRole, string>>;

export type MarketingFieldResolution = {
  fields: MarketingFieldMap;
  /** Roles whose title pattern matched more than one field: never guessed. */
  ambiguous: { role: MarketingFieldRole; candidates: string[] }[];
};

export function resolveMarketingFields(crmFields: readonly CrmFieldOption[]): MarketingFieldResolution {
  const byKey = new Map(crmFields.map((field) => [canonicalDealFieldKey(field.key), field]));
  const fields: MarketingFieldMap = {};
  const ambiguous: MarketingFieldResolution["ambiguous"] = [];
  const taken = new Set<string>();
  for (const spec of MARKETING_FIELD_SPECS) {
    const exact = (spec.keys ?? []).map(canonicalDealFieldKey).find((key) => byKey.has(key));
    if (exact) { fields[spec.role] = exact; taken.add(exact); continue; }
    const matches = [...new Set(crmFields
      .filter((field) => (spec.titles ?? []).some((pattern) => pattern.test(String(field.title ?? ""))))
      .map((field) => canonicalDealFieldKey(field.key))
      .filter((key) => /^(UF_CRM_|UTM_)/.test(key) && !taken.has(key)))];
    if (matches.length === 1) { fields[spec.role] = matches[0]; taken.add(matches[0]); }
    else if (matches.length > 1) ambiguous.push({ role: spec.role, candidates: matches });
  }
  return { fields, ambiguous };
}

/** Every resolved field code, for the Deal read. */
export function marketingSelect(map: MarketingFieldMap): string[] {
  return [...new Set(Object.values(map).filter((key): key is string => Boolean(key)))];
}
