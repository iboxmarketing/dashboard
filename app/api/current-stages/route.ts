import { bitrixList, getBitrixDomain, safeBitrixMessage } from "@/lib/bitrix";
import { buildCurrentStageRecords, reconcileCurrentStages, type RawCurrentStageDeal } from "@/lib/current-stages";
import { getDictionary, getSettings, listAnalyticsRecords } from "@/lib/storage";
import { listPipelineStages } from "@/lib/sync";

function value(row: Record<string, unknown>, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined ? "" : String(raw);
}

export async function GET() {
  let truncated = false;
  try {
    const settings = await getSettings();
    const categoryIds = [...new Set(settings.selectedPipelineIds.map(String).filter(Boolean))];
    if (!categoryIds.length) return Response.json({ records: [], reconciliation: null });

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
    const reconciliation = reconcileCurrentStages(records, cachedRecords, new Date().toISOString(), { operationalCategoryIds: categoryIds });
    return Response.json({ records, reconciliation, truncated });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
