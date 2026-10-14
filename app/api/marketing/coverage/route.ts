import { authorizePermission } from "@/lib/auth/http";
import { getD1 } from "@/db";
import { marketingResponse } from "@/lib/marketing/http";
import { buildCoverage } from "@/lib/marketing/metrics";

/** How much of the cohort carries stable Meta IDs, by path, plus conflicts. */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "dashboard");
  if (denied) return denied;
  let unassigned: { currency: string; spend_minor: number; rows: number }[] = [];
  const response = await marketingResponse(request, (context) => ({ coverage: buildCoverage(context.cohort, context.attribution) }));
  if (response.status !== 200) return response;
  // Spend whose ad account / campaign is not yet tied to a project is shown, never silently dropped.
  try {
    const url = new URL(request.url);
    const result = await getD1().prepare(`SELECT currency, sum(spend_minor) AS spend_minor, count(*) AS rows FROM marketing_meta_daily
      WHERE project_key IS NULL AND date >= ? AND date <= ? GROUP BY currency`)
      .bind(url.searchParams.get("startDate") ?? "0000-00-00", url.searchParams.get("endDate") ?? "9999-12-31").all<{ currency: string; spend_minor: number; rows: number }>();
    unassigned = result.results ?? [];
  } catch { unassigned = []; }
  const body = await response.json() as Record<string, unknown>;
  return Response.json({ ...body, unassignedSpend: unassigned }, { headers: { "cache-control": "no-store" } });
}
