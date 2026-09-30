/**
 * Which project's rules interpret each raw Deal.
 *
 * Shared by the sync's analytics step and the analytics backfill, so a record is
 * built the same way whichever path rebuilds it. Pure: no database, no Bitrix.
 */
import { dealProjectFamily, projectForCategory, type ProjectKey } from "./sales-projects";

type RawDealLike = { ID?: unknown; CATEGORY_ID?: unknown };
type RawHistoryLike = { OWNER_ID?: unknown; CATEGORY_ID?: unknown };

/**
 * Deals grouped by the project that must interpret them, each group with its own
 * stage history.
 *
 * The Deal's current family decides; a Deal outside both families goes with the
 * family its history shows it came from; a Deal with neither goes to `fallback`
 * (the running job's project), where the builder marks it `projectKey: null` —
 * it then belongs to no population rather than to a guessed one.
 */
export function groupDealsByProject<D extends RawDealLike, H extends RawHistoryLike>(
  deals: readonly D[], histories: readonly H[], fallback: ProjectKey,
): Map<ProjectKey, { deals: D[]; histories: H[] }> {
  const historyByDeal = new Map<string, H[]>();
  for (const row of histories) {
    const id = String(row.OWNER_ID ?? "");
    historyByDeal.set(id, [...(historyByDeal.get(id) ?? []), row]);
  }
  const groups = new Map<ProjectKey, { deals: D[]; histories: H[] }>();
  for (const deal of deals) {
    const id = String(deal.ID ?? "");
    const own = historyByDeal.get(id) ?? [];
    const cameFrom = own.find((row) => projectForCategory(row.CATEGORY_ID));
    const project = dealProjectFamily(deal.CATEGORY_ID, cameFrom?.CATEGORY_ID) ?? fallback;
    const group = groups.get(project) ?? { deals: [], histories: [] };
    group.deals.push(deal);
    group.histories.push(...own);
    groups.set(project, group);
  }
  return groups;
}
