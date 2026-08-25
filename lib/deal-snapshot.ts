
/**
 * Direct by-id deal lookup.
 *
 * The live reconciliation query is `CATEGORY_ID = <selected sales>` and
 * `CLOSED = N`, so a deal that has been closed, moved out of the funnel, or
 * deleted all look identical from it: simply absent. That ambiguity is why six
 * production deals could not be classified. `crm.deal.get` answers it.
 *
 * Server-side only. The webhook stays in `bitrixCall`, and nothing here is
 * reachable without going through an authenticated route.
 */

export type DealSnapshot = {
  id: string;
  title: string;
  categoryId: string;
  stageId: string;
  closed: boolean;
  closeDate: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  movedAt: string | null;
  assignedById: string | null;
  opportunity: number;
  currencyId: string | null;
};

/** Absent from Bitrix — deleted, or no longer readable by this webhook. */
export type DealLookup =
  | { found: true; deal: DealSnapshot }
  | { found: false; reason: "NOT_FOUND" };

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));

export function toDealSnapshot(raw: Record<string, unknown>): DealSnapshot {
  return {
    id: str(raw.ID),
    title: str(raw.TITLE),
    categoryId: str(raw.CATEGORY_ID),
    stageId: str(raw.STAGE_ID),
    // Bitrix returns "Y"/"N"; anything else is treated as open.
    closed: str(raw.CLOSED).toUpperCase() === "Y",
    closeDate: str(raw.CLOSEDATE) || null,
    createdAt: str(raw.DATE_CREATE) || null,
    modifiedAt: str(raw.DATE_MODIFY) || null,
    movedAt: str(raw.MOVED_TIME) || null,
    assignedById: str(raw.ASSIGNED_BY_ID) || null,
    opportunity: Number(raw.OPPORTUNITY ?? 0) || 0,
    currencyId: str(raw.CURRENCY_ID) || null,
  };
}

/**
 * @param dealIds bounded batch; Bitrix rejects oversized batch payloads, and an
 *   unbounded reconciliation sweep would be a way to hammer the REST limit.
 */
/**
 * @param dealIds bounded batch; Bitrix rejects oversized batch payloads, and an
 *   unbounded reconciliation sweep would be a way to hammer the REST limit.
 */
export const LOOKUP_BATCH_LIMIT = 25;
