import { safeBitrixMessage } from "@/lib/bitrix";
import { getSettings } from "@/lib/storage";
import { listPipelines, resolvePipelineSelection } from "@/lib/sync";

export async function GET() {
  try {
    const [settings, pipelines] = await Promise.all([getSettings(), listPipelines()]);
    let selected = [] as typeof pipelines;
    try { selected = resolvePipelineSelection(pipelines, settings.selectedPipelineIds, settings.selectedPipelineNames); } catch { /* The UI lets the user correct names. */ }
    return Response.json({ pipelines, selectedIds: selected.map((item) => item.id) });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
