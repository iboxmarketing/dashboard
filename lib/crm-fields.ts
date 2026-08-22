import type { CrmFieldOption } from "./types";

/**
 * Bitrix exposes the same Deal custom field under two spellings:
 * `crm.item.fields` returns `ufCrm_1748329407554` while `crm.deal.list` only
 * accepts `UF_CRM_1748329407554`. Selecting the camelCase spelling makes the
 * field silently absent from every deal payload — Sprint 17 found 0 of 1,549
 * deals carrying a reason because of exactly that.
 *
 * `UF_CRM_*` is therefore the canonical representation everywhere: settings,
 * the deal `select` list and analytics reads.
 */
export function canonicalDealFieldKey(key: string) {
  const match = /^uf_?crm_?(.+)$/i.exec(key.trim());
  return match ? `UF_CRM_${match[1]}` : key.trim();
}

export function isCustomDealField(key: string) {
  return /^uf_?crm_?/i.test(key.trim());
}

/**
 * Collapses spelling variants into one option per real field, keeping the
 * richest metadata (a title that is not the raw key, and any enum options) so
 * the Settings selector shows each field exactly once.
 */
export function canonicalizeFieldOptions(fields: CrmFieldOption[]): CrmFieldOption[] {
  const merged = new Map<string, CrmFieldOption>();
  for (const field of fields) {
    const key = canonicalDealFieldKey(field.key);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...field, key });
      continue;
    }
    const betterTitle = previous.title && previous.title !== previous.key && !/^Custom field /.test(previous.title)
      ? previous.title
      : field.title;
    merged.set(key, {
      ...previous,
      key,
      title: betterTitle || field.title || key,
      type: previous.type && previous.type !== "unknown" && previous.type !== "string" ? previous.type : field.type,
      options: previous.options.length ? previous.options : field.options,
      sampleValue: previous.sampleValue || field.sampleValue,
    });
  }
  return [...merged.values()];
}
