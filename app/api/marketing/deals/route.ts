import { authorizePermission } from "@/lib/auth/http";
import { marketingResponse } from "@/lib/marketing/http";
import { DEAL_METRICS, dealsForMetric, type DealMetric } from "@/lib/marketing/metrics";

/** The Deals behind one number: ?metric=lead|icp_fit|icp_other|icp_unset|sql|pipeline|sale plus entity filters. */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context, params) => {
    const metric = (params.get("metric") ?? "lead") as DealMetric;
    if (!DEAL_METRICS.includes(metric)) return Response.json({ error: "metric noto‘g‘ri" }, { status: 400, headers: { "cache-control": "no-store" } });
    const deals = dealsForMetric(metric, context.cohort, context.attribution, context.icp);
    // ICP is not a dimension of this workspace: say so, never answer with an empty list.
    if (!deals) return Response.json({ error: "ICP bu loyiha uchun qo‘llanilmaydi", code: "ICP_NOT_APPLICABLE" }, { status: 400, headers: { "cache-control": "no-store" } });
    return { metric, count: deals.length, deals: deals.slice(0, 2000), truncated: deals.length > 2000 };
  });
}
