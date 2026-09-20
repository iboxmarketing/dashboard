import { financeApiError, financeId, financePayload, includeArchived } from "@/lib/finance/api";
import { createFinanceAccount, getFinanceAccount, listFinanceAccounts, updateFinanceAccount } from "@/lib/finance/storage";
import { validateAccountInput } from "@/lib/finance/validation";

export async function GET(request: Request) {
  try { return Response.json({ accounts: await listFinanceAccounts(includeArchived(request)) }); }
  catch (error) { return financeApiError(error); }
}

export async function POST(request: Request) {
  try {
    const parsed = validateAccountInput(await financePayload(request));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ id: await createFinanceAccount(parsed.value) }, { status: 201 });
  } catch (error) { return financeApiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const payload = await financePayload(request);
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Account id is required" }, { status: 400 });
    const existing = await getFinanceAccount(id);
    if (!existing) return Response.json({ error: "Account was not found" }, { status: 404 });
    const parsed = validateAccountInput({ ...existing, ...payload });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    await updateFinanceAccount(id, parsed.value);
    return Response.json({ ok: true });
  } catch (error) { return financeApiError(error); }
}
