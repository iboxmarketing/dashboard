import { bitrixCall } from "./bitrix";
import { toDealSnapshot, LOOKUP_BATCH_LIMIT, type DealLookup } from "./deal-snapshot";

export { LOOKUP_BATCH_LIMIT };
export type { DealLookup, DealSnapshot } from "./deal-snapshot";

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/** Direct by-id lookup. Server-side only; the webhook never leaves `bitrixCall`. */
export async function getDealsByIds(dealIds: string[]): Promise<Map<string, DealLookup>> {
  const results = new Map<string, DealLookup>();
  const ids = [...new Set(dealIds.map(String).filter(Boolean))].slice(0, LOOKUP_BATCH_LIMIT);
  for (const id of ids) {
    try {
      const response = await bitrixCall<Record<string, unknown>>("crm.deal.get", { id });
      const raw = (response as { result?: Record<string, unknown> }).result;
      results.set(id, raw && str(raw.ID) ? { found: true, deal: toDealSnapshot(raw) } : { found: false, reason: "NOT_FOUND" });
    } catch {
      // A deleted deal answers with an error rather than an empty result; both
      // mean the same thing here, and the message is not surfaced because it
      // can echo request context.
      results.set(id, { found: false, reason: "NOT_FOUND" });
    }
  }
  return results;
}
