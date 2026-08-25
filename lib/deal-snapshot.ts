
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

/**
 * Outcome of a by-id lookup.
 *
 * The distinction is safety-critical now that reconciliation *writes*: an
 * earlier version turned every thrown error into NOT_FOUND, which would have
 * marked a live deal permanently unavailable the first time Bitrix timed out.
 *
 *   NOT_FOUND     Bitrix answered, definitively: the deal is gone or unreadable.
 *   LOOKUP_ERROR  We could not get an answer. Change nothing; retry later.
 */
export type DealLookup =
  | { found: true; deal: DealSnapshot }
  | { found: false; reason: "NOT_FOUND"; code: string }
  | { found: false; reason: "LOOKUP_ERROR"; code: string };

/**
 * Bitrix error codes that definitively mean "this deal is not retrievable".
 *
 * Verified against the six production deals that vanished. Anything not on
 * this list — a network failure, a malformed body, an HTTP 5xx, a rate limit,
 * an unrecognised code — is treated as transient and must never cause a write.
 */
export const DEFINITIVE_MISSING_CODES = new Set([
  "NOT_FOUND",
  "EMPTY_RESULT",
  "ERROR_NOT_FOUND",
  "ERROR_CORE",
  "ACCESS_DENIED",
  "INVALID_ARG_VALUE",
  // Verified on the portal: crm.deal.get for a deal that no longer exists
  // answers HTTP 400 with an empty error code. An id that never existed
  // (99999999) produces the identical signature, which is what makes it
  // definitive rather than incidental.
  "HTTP_400",
]);

/** Transient by construction: never write a scope decision from these. */
export const TRANSIENT_CODES = new Set([
  "NETWORK_ERROR", "INVALID_RESPONSE", "NOT_CONFIGURED", "QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT",
]);

export function classifyLookupFailure(code: string): DealLookup {
  const normalized = String(code || "UNKNOWN").toUpperCase();
  if (TRANSIENT_CODES.has(normalized) || normalized.startsWith("HTTP_5")) {
    return { found: false, reason: "LOOKUP_ERROR", code: normalized };
  }
  if (DEFINITIVE_MISSING_CODES.has(normalized)) {
    return { found: false, reason: "NOT_FOUND", code: normalized };
  }
  // Unknown codes are ambiguous, so they are transient by default: a wrong
  // "retry later" costs one sync cycle, a wrong "gone forever" corrupts a record.
  return { found: false, reason: "LOOKUP_ERROR", code: normalized };
}

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
