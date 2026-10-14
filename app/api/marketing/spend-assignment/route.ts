import { authorizePermission } from "@/lib/auth/http";
import { summarizeAssignment } from "@/lib/marketing/assignment";
import { parseMarketingQuery } from "@/lib/marketing/http";
import { minorToUzs } from "@/lib/marketing/money";
import { getMarketingSettings, marketingFx, spendAssignmentReport } from "@/lib/marketing/store";

/**
 * Where every ad-day of Meta spend in the range went: assigned to IBOX, to Sales
 * Doctor, to non-dashboard funnels, MIXED, or UNASSIGNED (no Deal yet). Spans all
 * projects, so it needs the settings permission.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  const parsed = parseMarketingQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    const fx = marketingFx(await getMarketingSettings());
    const { rows, assignment } = await spendAssignmentReport(parsed.query.startDate, parsed.query.endDate);
    const buckets = summarizeAssignment(rows, assignment, (minor, currency) => minorToUzs(minor, currency, fx));
    const unresolved = [...assignment].filter(([, bucket]) => bucket === "MIXED" || bucket === "UNASSIGNED").map(([adId, bucket]) => ({ adId, bucket }));
    return Response.json({
      range: { startDate: parsed.query.startDate, endDate: parsed.query.endDate }, fx: { usdToUzs: fx.usdToUzs },
      granularity: "AD_DAY", buckets, unresolvedAds: unresolved.slice(0, 500),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Spend taqsimotini yuklab bo‘lmadi" }, { status: 500 });
  }
}
