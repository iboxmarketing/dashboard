import { canonicalDealFieldKey } from "./crm-fields";

/**
 * Marketing source (docs/BUSINESS_RULES.md §9).
 *
 * Source is the standard Bitrix `SOURCE_ID`, resolved through the live SOURCE
 * dictionary, and nothing else. Owner decision: a custom Marketing channel
 * field, a Meta/Google Ads value, UTM source/medium/campaign — none of them is
 * Source. They belong to a separate marketing-attribution dimension, which is
 * why the configured channel is still read and kept on the record as
 * `marketingChannel`, never substituted for `source`.
 *
 * A Deal with no `SOURCE_ID` is unknown, not invented: the SOURCE dictionary's
 * own label is used when there is one, else the raw id, else "Aniqlanmagan".
 */

export type ResolvedSource = {
  /** The effective Source every Sales view groups and filters by: SOURCE_ID's label. */
  source: string;
  /** Same value, named for the places that compare Source against its raw origin. */
  rawSource: string;
  /** The configured Marketing channel's label, as a separate dimension. Null when empty or unconfigured. */
  marketingChannel: string | null;
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

function channelLabel(raw: unknown, options: Map<string, string> | undefined) {
  const values = (Array.isArray(raw) ? raw : [raw]).map(text).filter(Boolean);
  if (!values.length) return "";
  // A field with an option list only accepts its own options; an option Bitrix
  // no longer lists is not a label anyone chose.
  if (options && options.size) {
    const labels = values.map((value) => options.get(value) ?? "");
    return labels.every(Boolean) ? labels.join(", ") : "";
  }
  return values.join(", ");
}

export function resolveDealSource(input: {
  deal: Record<string, unknown>;
  marketingChannelField: string | null | undefined;
  fieldOptions: Map<string, Map<string, string>>;
  sources: Map<string, string>;
}): ResolvedSource {
  const sourceId = text(input.deal.SOURCE_ID);
  const source = input.sources.get(sourceId) || sourceId || "Aniqlanmagan";
  const field = text(input.marketingChannelField);
  const key = field ? canonicalDealFieldKey(field) : "";
  const channel = key
    ? channelLabel(input.deal[key] ?? input.deal[field], input.fieldOptions.get(key) ?? input.fieldOptions.get(field))
    : "";
  return { source, rawSource: source, marketingChannel: channel || null };
}

/**
 * The configured Marketing channel field if Bitrix currently lists it, else
 * null. When the field list could not be read at all, the configured value is
 * kept rather than dropped on a transient failure. Nothing is ever detected by
 * name: a field is used only because it was configured.
 */
export function validMarketingChannelField(configured: string | null | undefined, knownFieldKeys: ReadonlySet<string>) {
  const field = text(configured);
  if (!field) return null;
  if (!knownFieldKeys.size) return field;
  return knownFieldKeys.has(field) || knownFieldKeys.has(canonicalDealFieldKey(field)) ? field : null;
}
