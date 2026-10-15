import { authError, requirePermission } from "@/lib/auth/http";
import { kpiDetailResponse } from "@/lib/kpi-detail-http";

/** One page of a KPI's Deals — the metric's population, a segment of it, or one breakdown row. Guarded by `dashboard`, like the Dashboard card it details. */
export async function GET(request: Request) {
  let user;
  try {
    ({ user } = await requirePermission(request, "dashboard"));
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return kpiDetailResponse(request, user, "deals");
}
