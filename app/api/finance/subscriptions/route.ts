import { financeApiError, financeId, financePayload, includeArchived } from "@/lib/finance/api";
import { createFinanceSubscription, getFinanceSubscription, listFinanceSubscriptions, updateFinanceSubscription } from "@/lib/finance/storage";
import { validateSubscriptionInput } from "@/lib/finance/validation";
import { authorizePermission } from "@/lib/auth/http";

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try { return Response.json({ subscriptions: await listFinanceSubscriptions(includeArchived(request)) }); }
  catch (error) { return financeApiError(error); }
}

export async function POST(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const parsed = validateSubscriptionInput(await financePayload(request));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ id: await createFinanceSubscription(parsed.value) }, { status: 201 });
  } catch (error) { return financeApiError(error); }
}

export async function PATCH(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const payload = await financePayload(request);
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Subscription id is required" }, { status: 400 });
    const existing = await getFinanceSubscription(id);
    if (!existing) return Response.json({ error: "Subscription was not found" }, { status: 404 });
    const parsed = validateSubscriptionInput({ ...existing, ...payload });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    await updateFinanceSubscription(id, parsed.value);
    return Response.json({ ok: true });
  } catch (error) { return financeApiError(error); }
}
