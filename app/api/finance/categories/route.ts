import { financeApiError, financeId, financePayload, includeArchived } from "@/lib/finance/api";
import { createFinanceCategory, getFinanceCategory, listFinanceCategories, updateFinanceCategory } from "@/lib/finance/storage";
import { validateCategoryInput } from "@/lib/finance/validation";
import { authorizePermission } from "@/lib/auth/http";

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try { return Response.json({ categories: await listFinanceCategories(includeArchived(request)) }); }
  catch (error) { return financeApiError(error); }
}

export async function POST(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const parsed = validateCategoryInput(await financePayload(request));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ id: await createFinanceCategory(parsed.value) }, { status: 201 });
  } catch (error) { return financeApiError(error); }
}

export async function PATCH(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const payload = await financePayload(request);
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Category id is required" }, { status: 400 });
    const existing = await getFinanceCategory(id);
    if (!existing) return Response.json({ error: "Category was not found" }, { status: 404 });
    const parsed = validateCategoryInput({ ...existing, ...payload });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    await updateFinanceCategory(id, parsed.value);
    return Response.json({ ok: true });
  } catch (error) { return financeApiError(error); }
}
