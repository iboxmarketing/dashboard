import { authorizePermission } from "@/lib/auth/http";
import { funnelOwnerKey } from "@/lib/funnel-owner";
import { marketingResponse } from "@/lib/marketing/http";
import { countIcp } from "@/lib/marketing/icp";
import { icpByKey } from "@/lib/marketing/metrics";
import type { DashboardRecord } from "@/lib/dashboard-record";

/**
 * ICP for the cohort — totals, by acquisition channel and by funnel owner — so
 * the existing Overview and Managers pages can show ICP later without new logic.
 * UNSET is reported, never in the fit-rate denominator.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context) => ({
    icp: countIcp(context.cohort.map((record) => context.attribution.get(record.dealId)?.icpClass ?? "UNSET")),
    byChannel: icpByKey(context.cohort, context.attribution, (record) => context.attribution.get(record.dealId)?.channel ?? "NOT_YET_ATTRIBUTED"),
    byManager: icpByKey(context.cohort, context.attribution, (record) => funnelOwnerKey(record as unknown as DashboardRecord)),
  }));
}
