import { authError, requirePermission } from "@/lib/auth/http";
import { kpiDetailResponse } from "@/lib/kpi-detail-http";

/** One KPI's detail: definition, hero, summary, breakdowns and one page of its exact Deals. Guarded by `dashboard`, like the Dashboard card it details. */
export async function GET(request: Request) {
  let user;
  try {
    ({ user } = await requirePermission(request, "dashboard"));
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return kpiDetailResponse(request, user, "detail");
}
