import { authorizePermission } from "@/lib/auth/http";
import { marketingResponse } from "@/lib/marketing/http";
import { buildSummary } from "@/lib/marketing/metrics";

/** Project summary over the lead-date cohort: outcomes, ICP, Meta spend, CMC, ROAS, ID coverage. */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context) => ({
    summary: buildSummary({ cohort: context.cohort, attribution: context.attribution, spend: context.spend, fx: context.fx, spendApplies: context.spendApplies }),
  }));
}
