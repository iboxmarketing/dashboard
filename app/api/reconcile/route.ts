import { getSettings, listAnalyticsRecords } from "@/lib/storage";
import { bitrixList, safeBitrixMessage as _safe } from "@/lib/bitrix";
import type { RawCurrentStageDeal } from "@/lib/current-stages";
import { getDealsByIds, LOOKUP_BATCH_LIMIT } from "@/lib/deal-lookup";
import { currentScopeFor, resolveStaleDeal } from "@/lib/stale-resolution";


/**
 * Internal reconciliation diagnostics.
 *
 * Read-only by design: it classifies stale cached-ACTIVE deals via a direct
 * by-id lookup and reports what it found. It writes nothing — applying a
 * resolution is a separate, deliberate step.
 *
 * Not public. In production the whole Worker except /share/* sits behind
 * Cloudflare Access, which is what keeps this authenticated.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requested = (url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);

    const [settings, records] = await Promise.all([getSettings(), listAnalyticsRecords()]);
    const categoryIds = [...new Set((settings.selectedPipelineIds ?? []).map(String).filter(Boolean))];
    // Same live query the stage board uses, reduced to ids.
    const live = await bitrixList<RawCurrentStageDeal>("crm.deal.list", {
      order: { ID: "ASC" },
      filter: {
        ...(categoryIds.length === 1 ? { CATEGORY_ID: categoryIds[0] } : { "@CATEGORY_ID": categoryIds }),
        CLOSED: "N",
      },
      select: ["ID"],
    }, { maxPages: 100 });
    const liveIds = new Set(live.map((row) => String((row as Record<string, unknown>).ID ?? "")));

    // Either the explicitly requested ids, or every deal the cache still
    // believes is an open sales deal but the live snapshot no longer lists.
    const staleIds = requested.length
      ? requested
      : records
        .filter((row) => categoryIds.includes(String(row.categoryId)))
        .filter((row) => (row.salesStatus ?? "ACTIVE") === "ACTIVE" && !liveIds.has(row.dealId))
        .filter((row) => (row.currentScope ?? "IN_SCOPE") === "IN_SCOPE")
        .map((row) => row.dealId);

    const batch = staleIds.slice(0, LOOKUP_BATCH_LIMIT);
    const lookups = await getDealsByIds(batch);
    const cached = new Map(records.map((row) => [row.dealId, row]));

    return Response.json({
      checked: batch.length,
      pending: Math.max(0, staleIds.length - batch.length),
      results: batch.map((id) => {
        const lookup = lookups.get(id) ?? { found: false as const, reason: "LOOKUP_ERROR" as const, code: "NO_RESULT" };
        const resolution = resolveStaleDeal(lookup, {
          selectedPipelineIds: settings.selectedPipelineIds ?? [],
          postSalePipelineIds: settings.postSalePipelineIds ?? [],
        });
        const record = cached.get(id);
        return {
          dealId: id,
          resolution,
          currentScope: currentScopeFor(resolution),
          bitrix: lookup.found ? lookup.deal : null,
          cached: record
            ? {
              categoryId: record.categoryId, originCategoryId: record.originCategoryId,
              stageId: record.stageId, salesStatus: record.salesStatus,
              lossReasonGroup: record.lossReasonGroup, createdAt: record.createdAt,
              wonAt: record.wonAt, currentScope: record.currentScope ?? "IN_SCOPE",
            }
            : null,
        };
      }),
    });
  } catch (error) {
    return Response.json({ error: _safe(error) }, { status: 500 });
  }
}
