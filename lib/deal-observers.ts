/**
 * Bitrix universal CRM field for Deal observers.
 *
 * `crm.item.fields` (entityTypeId 2) declares this exact camelCase key as a
 * `user[]`. The legacy `crm.deal.*` API does not provide a comparably reliable
 * selectable field, so sync enriches only the post-sale Deals that need this
 * evidence through `crm.item.list`.
 */
export const DEAL_OBSERVERS_FIELD = "observers";

function positiveIntegerId(raw: unknown) {
  const shown = raw === null || raw === undefined ? "" : String(raw).trim();
  return /^[1-9]\d*$/.test(shown) ? shown : "";
}

export function buildDealObserverRead(dealIds: readonly string[]) {
  const ids = [...new Set(dealIds.map(positiveIntegerId).filter(Boolean))];
  if (!ids.length) throw new Error("At least one valid Deal ID is required for observer enrichment");
  return {
    method: "crm.item.list" as const,
    params: {
      entityTypeId: 2,
      select: ["id", DEAL_OBSERVERS_FIELD],
      filter: { "@id": ids },
    },
    dealIds: ids,
  };
}

/** Adds only the documented universal field; all legacy Deal fields survive. */
export function attachDealObservers(
  deals: readonly Record<string, unknown>[],
  items: readonly Record<string, unknown>[],
) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = positiveIntegerId(item.id);
    if (id) byId.set(id, item);
  }
  return deals.map((deal) => {
    const item = byId.get(positiveIntegerId(deal.ID));
    if (!item) return deal;
    return {
      ...deal,
      [DEAL_OBSERVERS_FIELD]: Array.isArray(item[DEAL_OBSERVERS_FIELD])
        ? item[DEAL_OBSERVERS_FIELD]
        : [],
    };
  });
}

export function observerItemIds(items: readonly Record<string, unknown>[]) {
  return new Set(items.map((item) => positiveIntegerId(item.id)).filter(Boolean));
}

/**
 * A post-sale observer is commercial handoff evidence only when Bitrix exposes
 * one unique, non-zero observer and that person is not the operational owner.
 * Multiple observers remain ambiguous; the current assignee is never removed
 * from the list to manufacture a single candidate.
 */
export function singlePostSaleObserverId(raw: unknown, assignedManagerId: unknown) {
  if (!Array.isArray(raw)) return "";
  const observers = [...new Set(raw.map(positiveIntegerId).filter(Boolean))];
  if (observers.length !== 1) return "";
  const assigned = positiveIntegerId(assignedManagerId);
  return observers[0] === assigned ? "" : observers[0];
}
