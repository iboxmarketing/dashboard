import { safeBitrixMessage } from "@/lib/bitrix";
import { getDictionary } from "@/lib/storage";
import { detectFailureReasonField, listCrmFields, listPipelines, listPipelineStages } from "@/lib/sync";
import { requestProject } from "@/lib/sales-http";
import { SALES_PROJECTS, projectCategoryIds } from "@/lib/sales-projects";
import type { CrmFieldOption } from "@/lib/types";
import { authorizePermission } from "@/lib/auth/http";

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  try {
    // This project's two funnels and ONLY their stages: the Settings pickers of a
    // Sales Doctor workspace can never offer an IBOX category-3 stage, or the reverse.
    const registry = SALES_PROJECTS[scoped.project];
    const pipelines = await listPipelines();
    const selected = pipelines.filter((item) => item.id === registry.salesCategoryId);
    const reporting = pipelines.filter((item) => item.id === registry.postSaleCategoryId);
    const categoryIds = projectCategoryIds(scoped.project);
    const fields = await listCrmFields(categoryIds).catch(() => getDictionary<CrmFieldOption[]>("crmFields", []));
    const stages = await listPipelineStages(categoryIds).catch(() => []);
    const detectedFailureReasonField = detectFailureReasonField(fields);
    return Response.json({
      project: scoped.project,
      pipelines: [...selected, ...reporting],
      fields,
      customFieldCount: fields.filter((field) => field.key.startsWith("UF_")).length,
      detectedFailureReasonField,
      stages,
      selectedIds: selected.map((item) => item.id),
      reportingIds: reporting.map((item) => item.id),
    });
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}
