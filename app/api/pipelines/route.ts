import { safeBitrixMessage } from "@/lib/bitrix";
import { getSettings } from "@/lib/storage";
import { getDictionary } from "@/lib/storage";
import { listCrmFields, listPipelines, resolvePipelineSelection } from "@/lib/sync";
import { resolvePostSalePipelines } from "@/lib/pipelines";
import type { CrmFieldOption } from "@/lib/types";

export async function GET() {
  try {
    const [settings, pipelines, statuses] = await Promise.all([getSettings(), listPipelines(), getDictionary<Record<string, unknown>[]>("statuses", [])]);
    let selected = [] as typeof pipelines;
    try { selected = resolvePipelineSelection(pipelines, settings.selectedPipelineIds, settings.selectedPipelineNames); } catch { /* The UI lets the user correct names. */ }
    const fields = await listCrmFields(selected.map((item) => item.id)).catch(() => getDictionary<CrmFieldOption[]>("crmFields", []));
    const reporting = resolvePostSalePipelines(pipelines, settings.postSalePipelineIds, settings.postSalePipelineNames);
    const stages = statuses.flatMap((row) => {
      const entity = String(row.ENTITY_ID ?? ""); const id = String(row.STATUS_ID ?? "");
      return entity.startsWith("DEAL_STAGE") && id ? [{ id, name: String(row.NAME ?? id) }] : [];
    });
    return Response.json({ pipelines, fields, customFieldCount: fields.filter((field) => field.key.startsWith("UF_")).length, stages, selectedIds: selected.map((item) => item.id), reportingIds: reporting.map((item) => item.id) });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
