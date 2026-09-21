import { bitrixList, getBitrixDomain, safeBitrixMessage } from "@/lib/bitrix";
import { buildCurrentStageRecords, reconcileCurrentStages, type RawCurrentStageDeal } from "@/lib/current-stages";
import { getDictionary, getSettings, listAnalyticsRecords } from "@/lib/storage";
import { listPipelineStages } from "@/lib/sync";
import { authorizePermission } from "@/lib/auth/http";
import type { DashboardSettings } from "@/lib/types";

/**
 * The slice of settings Stage Control renders with: funnel names and stage
 * semantics. A Stages-only member gets this instead of the full CRM settings,
 * which `/api/bootstrap` now releases only to `settings`.
 */
function stageSettings(settings: DashboardSettings) {
  return {
    selectedPipelineIds: settings.selectedPipelineIds, selectedPipelineNames: settings.selectedPipelineNames,
    qualifiedStageIds: settings.qualifiedStageIds, lowQualityStageIds: settings.lowQualityStageIds,
    paymentStageIds: settings.paymentStageIds, closedLostStageIds: settings.closedLostStageIds,
  };
}

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "stages");
  if (denied) return denied;
  let truncated = false;
  try {
    const settings = await getSettings();
    const categoryIds = [...new Set(settings.selectedPipelineIds.map(String).filter(Boolean))];
    if (!categoryIds.length) return Response.json({ records: [], reconciliation: null, stageCatalog: [], truncated: false, stageSettings: stageSettings(settings) });

    const [deals, stageOptions, userRows, cachedRecords] = await Promise.all([
      bitrixList<RawCurrentStageDeal>("crm.deal.list", {
        order: { ID: "ASC" },
        filter: {
          ...(categoryIds.length === 1 ? { CATEGORY_ID: categoryIds[0] } : { "@CATEGORY_ID": categoryIds }),
          CLOSED: "N",
        },
        select: ["ID", "TITLE", "DATE_CREATE", "DATE_MODIFY", "MOVED_TIME", "ASSIGNED_BY_ID", "CATEGORY_ID", "STAGE_ID", "CLOSED"],
      }, {
        maxPages: 100,
        onTruncated: (info) => {
          truncated = true;
          console.warn(`current-stages: ${info.method} ${info.maxPages} sahifada uzildi; faqat ${info.loaded} ta ochiq deal yuklandi.`);
        },
      }),
      listPipelineStages(categoryIds),
      getDictionary<Record<string, unknown>[]>("users", []),
      listAnalyticsRecords(),
    ]);

    const pipelines = new Map(categoryIds.map((id, index) => [id, settings.selectedPipelineNames[index] ?? `Sales funnel #${id}`]));
    const stages = new Map<string, string>();
    for (const stage of stageOptions) {
      stages.set(`${stage.categoryId}:${stage.id}`, stage.name);
      if (!stages.has(stage.id)) stages.set(stage.id, stage.name);
    }
    const users = new Map(userRows.map((row) => [value(row, "ID"), [value(row, "NAME"), value(row, "LAST_NAME")].filter(Boolean).join(" ") || `Menejer #${value(row, "ID")}`]));
    const records = buildCurrentStageRecords({ deals, settings, pipelines, stages, users, domain: getBitrixDomain() });
    // The full cache is handed over scoped by funnel only. Sales status must not
    // gate membership, otherwise an open deal that reached payment (cached as
    // WON, still CLOSED=N in Bitrix) is falsely reported as missing.
    const reconciliation = reconcileCurrentStages(records, cachedRecords, new Date().toISOString(), {
      operationalCategoryIds: categoryIds,
      historyDays: settings.historyDays,
    });
    // The stage catalog travels beside the records so the client never has to
    // re-derive Bitrix funnel order: SORT lives here, not in React.
    const stageCatalog = stageOptions.map((stage) => ({
      id: stage.id, name: stage.name, categoryId: stage.categoryId, sort: stage.sort, semantics: stage.semantics,
    }));
    return Response.json({ records, reconciliation, stageCatalog, truncated, stageSettings: stageSettings(settings) });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
