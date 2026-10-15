import { authorizePermission } from "@/lib/auth/http";
import { FUNNEL_OWNER_LABELS, funnelOwnerKey } from "@/lib/funnel-owner";
import { resolveManagerName } from "@/lib/manager-identity";
import { marketingResponse } from "@/lib/marketing/http";
import { countIcp } from "@/lib/marketing/icp";
import { icpByKey } from "@/lib/marketing/metrics";
import type { DashboardRecord } from "@/lib/dashboard-record";

/**
 * ICP for the cohort — totals, by acquisition channel and by funnel owner — so
 * the existing Overview and Managers pages can show ICP later without new logic.
 * UNSET is reported, never in the fit-rate denominator. A workspace without an
 * ICP definition answers icpStatus NOT_APPLICABLE and nothing else.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context) => {
    // A workspace without ICP answers NOT_APPLICABLE (the envelope's icpStatus), with no counts at all.
    if (!context.icp.enabled) return {};
    const icp = context.icp;
    return {
      icp: countIcp(context.cohort.map((record) => context.attribution.get(record.dealId)?.icpClass ?? "UNSET"), icp),
      byChannel: icpByKey(context.cohort, context.attribution, (record) => context.attribution.get(record.dealId)?.channel ?? "NOT_YET_ATTRIBUTED", icp),
      // The same owner key and display name as the Managers page.
      byManager: (icpByKey(context.cohort, context.attribution, (record) => funnelOwnerKey(record as unknown as DashboardRecord), icp) ?? [])
        .map((row) => ({ ...row, name: resolveManagerName(row.key, context.cohort as unknown as DashboardRecord[], FUNNEL_OWNER_LABELS) })),
    };
  });
}
