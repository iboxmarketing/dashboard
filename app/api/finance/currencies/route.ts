import { financeApiError } from "@/lib/finance/api";
import { listFinanceCurrencies } from "@/lib/finance/storage";
import { authorizePermission } from "@/lib/auth/http";

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try { return Response.json({ currencies: await listFinanceCurrencies() }); }
  catch (error) { return financeApiError(error); }
}
