import { financeApiError, financeId, financePayload, includeArchived } from "@/lib/finance/api";
import { createFinanceProject, getFinanceProject, listFinanceProjects, updateFinanceProject } from "@/lib/finance/storage";
import { validateFinanceProjectInput } from "@/lib/finance/validation";
import { authorizePermission } from "@/lib/auth/http";

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try { return Response.json({ projects: await listFinanceProjects(includeArchived(request)) }); }
  catch (error) { return financeApiError(error); }
}

export async function POST(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const parsed = validateFinanceProjectInput(await financePayload(request));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ id: await createFinanceProject(parsed.value) }, { status: 201 });
  } catch (error) { return financeApiError(error); }
}

export async function PATCH(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const payload = await financePayload(request);
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Finance project id is required" }, { status: 400 });
    const existing = await getFinanceProject(id);
    if (!existing) return Response.json({ error: "Finance project was not found" }, { status: 404 });
    const parsed = validateFinanceProjectInput({ ...existing, ...payload });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    await updateFinanceProject(id, parsed.value);
    return Response.json({ ok: true });
  } catch (error) { return financeApiError(error); }
}
