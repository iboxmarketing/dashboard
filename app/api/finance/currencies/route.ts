import { financeApiError } from "@/lib/finance/api";
import { listFinanceCurrencies } from "@/lib/finance/storage";

export async function GET() {
  try { return Response.json({ currencies: await listFinanceCurrencies() }); }
  catch (error) { return financeApiError(error); }
}
