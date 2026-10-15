import { authorizePermission } from "@/lib/auth/http";
import { marketingResponse } from "@/lib/marketing/http";
import { buildFilterOptions, buildSummary } from "@/lib/marketing/metrics";

/**
 * Project summary over the lead-date cohort: outcomes, ICP, attributed Meta
 * spend, CMC, ROAS, ID coverage — plus the filter catalogue and where the
 * range's spend went (spendAttribution) for the data-quality panel.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context) => ({
    summary: buildSummary({
      cohort: context.cohort, attribution: context.attribution, spend: context.spend, fx: context.fx,
      spendApplies: context.spendApplies, spendStatus: context.spendStatus, icp: context.icp,
    }),
    spendAttribution: context.spendAttribution,
    options: buildFilterOptions({ cohort: context.baseCohort, attribution: context.attribution, spend: context.spend, filters: context.query }),
  }));
}
