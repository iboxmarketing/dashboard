import { safeBitrixMessage } from "@/lib/bitrix";
import { getSettings } from "@/lib/storage";
import { getDictionary } from "@/lib/storage";
import { detectFailureReasonField, listCrmFields, listPipelines, listPipelineStages, resolvePipelineSelection } from "@/lib/sync";
import { pairPostSalePipeline, resolvePostSalePipelines } from "@/lib/pipelines";
import type { CrmFieldOption } from "@/lib/types";

export async function GET() {
  try {
    const [settings, pipelines] = await Promise.all([getSettings(), listPipelines()]);
    let selected = [] as typeof pipelines;
    try { selected = resolvePipelineSelection(pipelines, settings.selectedPipelineIds, settings.selectedPipelineNames); } catch { /* The UI lets the user correct names. */ }
    const fields = await listCrmFields(selected.map((item) => item.id)).catch(() => getDictionary<CrmFieldOption[]>("crmFields", []));
    const configuredReporting = resolvePostSalePipelines(pipelines, settings.postSalePipelineIds, settings.postSalePipelineNames);
    const automaticReporting = resolvePostSalePipelines(pipelines, [], selected.map((item) => item.name));
    const reporting = selected.flatMap((main) => {
      const paired = pairPostSalePipeline(main, configuredReporting) ?? pairPostSalePipeline(main, automaticReporting);
      return paired ? [paired] : [];
    });
    const stages = await listPipelineStages(selected.map((item) => item.id)).catch(() => []);
    const detectedFailureReasonField = detectFailureReasonField(fields);
    return Response.json({
      pipelines,
      fields,
      customFieldCount: fields.filter((field) => field.key.startsWith("UF_")).length,
      detectedFailureReasonField,
      stages,
      selectedIds: selected.map((item) => item.id),
      reportingIds: [...new Set(reporting.map((item) => item.id))],
    });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
