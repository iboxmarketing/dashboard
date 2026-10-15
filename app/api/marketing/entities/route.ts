import { authorizePermission } from "@/lib/auth/http";
import { marketingResponse } from "@/lib/marketing/http";
import { buildEntities, ENTITY_LEVELS, type EntityLevel } from "@/lib/marketing/metrics";

/** Campaign / ad set / ad / creative / placement / landing rows. Stable IDs and names apart. */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  return marketingResponse(request, (context, params) => {
    const level = (params.get("level") ?? "campaign") as EntityLevel;
    if (!ENTITY_LEVELS.includes(level)) return Response.json({ error: "level noto‘g‘ri" }, { status: 400, headers: { "cache-control": "no-store" } });
    return { level, rows: buildEntities({ level, cohort: context.cohort, attribution: context.attribution, spend: context.spend, fx: context.fx, spendApplies: context.spendApplies, icp: context.icp }) };
  });
}
