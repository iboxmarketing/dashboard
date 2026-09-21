import { getSettings, listAnalyticsRecords } from "@/lib/storage";
import { bitrixList, safeBitrixMessage as _safe } from "@/lib/bitrix";
import type { RawCurrentStageDeal } from "@/lib/current-stages";
import { getDealsByIds, LOOKUP_BATCH_LIMIT } from "@/lib/deal-lookup";
import { currentScopeFor, resolveStaleDeal } from "@/lib/stale-resolution";
import { authorizePermission } from "@/lib/auth/http";


/**
 * Internal reconciliation diagnostics.
 *
 * Read-only by design: it classifies cached project Deals missing from the
 * current membership snapshot via a direct by-ID lookup and reports what it
 * found. It writes nothing — applying a resolution is a separate step.
 *
 * Not public. In production the whole Worker except /share/* sits behind
 * Cloudflare Access, which is what keeps this authenticated.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "diagnostics");
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const requested = (url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);

    const [settings, records] = await Promise.all([getSettings(), listAnalyticsRecords()]);
    const salesCategoryIds = [...new Set((settings.selectedPipelineIds ?? []).map(String).filter(Boolean))];
    const projectCategoryIds = [...new Set([...salesCategoryIds, ...(settings.postSalePipelineIds ?? []).map(String)].filter(Boolean))];
    // Membership snapshot: all statuses in Sales + matching post-sale. This is
    // intentionally broader than the open-Sales current-stage inventory.
    const live = await bitrixList<RawCurrentStageDeal>("crm.deal.list", {
      order: { ID: "ASC" },
      filter: {
        ...(projectCategoryIds.length === 1 ? { CATEGORY_ID: projectCategoryIds[0] } : { "@CATEGORY_ID": projectCategoryIds }),
      },
      select: ["ID"],
    }, { maxPages: 100 });
    const liveIds = new Set(live.map((row) => String((row as Record<string, unknown>).ID ?? "")));

    // Either the explicitly requested ids, or every cached project Deal the
    // current membership snapshot no longer lists.
    const staleIds = requested.length
      ? requested
      : records
        .filter((row) => projectCategoryIds.includes(String(row.categoryId)))
        .filter((row) => !liveIds.has(row.dealId))
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
          // The Bitrix error *code* only — never the description, which can
          // echo request context.
          lookupCode: lookup.found ? null : lookup.code,
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
