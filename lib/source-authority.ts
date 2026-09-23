import { canonicalDealFieldKey } from "./crm-fields";

/**
 * Marketing source authority (docs/BUSINESS_RULES.md §9).
 *
 * The configured Marketing channel field decides a Deal's source when the Deal
 * carries a valid value for it; otherwise the standard Bitrix SOURCE_ID does.
 * The SOURCE_ID label is always kept as `rawSource`, so the two can be
 * compared and nothing is lost when the channel is empty.
 *
 * Labels are Bitrix's own, verbatim: the channel's enumeration option text or
 * the SOURCE dictionary name. No mapping between the two vocabularies exists
 * here and none may be invented.
 *
 * A "valid" channel value is a non-empty value that, for an enumeration field,
 * names one of the field's options. An option ID Bitrix no longer lists is not
 * a label anyone chose, so it falls back to SOURCE_ID rather than surfacing a
 * bare number as a source.
 */

export type SourceAuthority = "MARKETING_CHANNEL" | "SOURCE_ID";

export type ResolvedSource = {
  /** The effective source every Sales view groups and filters by. */
  source: string;
  sourceAuthority: SourceAuthority;
  /** The channel label when it decided the source, else null. */
  marketingChannel: string | null;
  /** Standard SOURCE_ID, resolved through the SOURCE dictionary. */
  rawSource: string;
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

function channelLabel(raw: unknown, options: Map<string, string> | undefined) {
  const values = (Array.isArray(raw) ? raw : [raw]).map(text).filter(Boolean);
  if (!values.length) return "";
  // A field with an option list only accepts its own options.
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
  const rawSource = input.sources.get(sourceId) || sourceId || "Aniqlanmagan";
  const field = text(input.marketingChannelField);
  const key = field ? canonicalDealFieldKey(field) : "";
  const channel = key
    ? channelLabel(input.deal[key] ?? input.deal[field], input.fieldOptions.get(key) ?? input.fieldOptions.get(field))
    : "";
  return channel
    ? { source: channel, sourceAuthority: "MARKETING_CHANNEL", marketingChannel: channel, rawSource }
    : { source: rawSource, sourceAuthority: "SOURCE_ID", marketingChannel: null, rawSource };
}

/**
 * The configured field if it is a Deal field Bitrix currently lists, else
 * null. When the field list could not be read at all, the configured value is
 * kept rather than dropped on a transient failure. Nothing is ever detected
 * by name: a field is used only because it was configured.
 */
export function validMarketingChannelField(configured: string | null | undefined, knownFieldKeys: ReadonlySet<string>) {
  const field = text(configured);
  if (!field) return null;
  if (!knownFieldKeys.size) return field;
  return knownFieldKeys.has(field) || knownFieldKeys.has(canonicalDealFieldKey(field)) ? field : null;
}
