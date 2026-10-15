import { authError, requirePermission } from "@/lib/auth/http";
import { kpiDetailResponse } from "@/lib/kpi-detail-http";

/** Display-ready KPI detail contract consumed by HttpKpiDetailAdapter. */
export async function GET(request: Request) {
  let user;
  try {
    ({ user } = await requirePermission(request, "dashboard"));
  } catch (error) {
    return authError(error) ?? Response.json(
      { error: "Kirishni tekshirib bo‘lmadi" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
  return kpiDetailResponse(request, user, "ui");
}
