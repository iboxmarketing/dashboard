import { financeApiError, financeId, financePayload } from "@/lib/finance/api";
import { createFinanceTransaction, getFinanceTransaction, listFinanceTransactions, updateFinanceTransaction } from "@/lib/finance/storage";
import { normalizeFinanceDate, validateTransactionInput } from "@/lib/finance/validation";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const rawFrom = params.get("from");
    const rawTo = params.get("to");
    const from = rawFrom ? normalizeFinanceDate(rawFrom) ?? undefined : undefined;
    const to = rawTo ? normalizeFinanceDate(rawTo) ?? undefined : undefined;
    if ((rawFrom && !from) || (rawTo && !to) || (from && to && from > to)) {
      return Response.json({ error: "Transaction date range is invalid" }, { status: 400 });
    }
    const projectParam = params.get("projectId");
    const projectId = projectParam === "none" ? null : projectParam ?? undefined;
    return Response.json({ transactions: await listFinanceTransactions({ from, to, projectId }) });
  } catch (error) { return financeApiError(error); }
}

export async function POST(request: Request) {
  try {
    const parsed = validateTransactionInput(await financePayload(request));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ id: await createFinanceTransaction(parsed.value) }, { status: 201 });
  } catch (error) { return financeApiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const payload = await financePayload(request);
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Transaction id is required" }, { status: 400 });
    const existing = await getFinanceTransaction(id);
    if (!existing) return Response.json({ error: "Transaction was not found" }, { status: 404 });
    const parsed = validateTransactionInput({ ...existing, ...payload });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    await updateFinanceTransaction(id, parsed.value);
    return Response.json({ ok: true });
  } catch (error) { return financeApiError(error); }
}
