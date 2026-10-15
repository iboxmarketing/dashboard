import { authorizePermission } from "@/lib/auth/http";
import { marketingResponse } from "@/lib/marketing/http";
import { buildCoverage } from "@/lib/marketing/metrics";

/**
 * How much of the cohort carries stable Meta IDs, by acquisition path, plus
 * conflicts. Spend that no project owns is in /api/marketing/spend-assignment.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  // Measured on the whole workspace cohort — unattributed Deals are counted here, never in the Meta funnel.
  return marketingResponse(request, (context) => ({ coverage: buildCoverage(context.baseCohort, context.attribution) }));
}
