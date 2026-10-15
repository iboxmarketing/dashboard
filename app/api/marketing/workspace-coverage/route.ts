import { authorizePermission } from "@/lib/auth/http";
import { workspaceCoverage } from "@/lib/marketing/coverage";
import { parseMarketingQuery } from "@/lib/marketing/http";
import { workspaceCoverageEvidence } from "@/lib/marketing/store";

/** Attribution coverage for IBOX_UZ, SD_UZ, IBOX_KZ, SD_KZ (KZ measured on tracking-delivered Deals until activated). */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  const parsed = parseMarketingQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    const rows = await workspaceCoverageEvidence(parsed.query.startDate, parsed.query.endDate);
    return Response.json({ range: { startDate: parsed.query.startDate, endDate: parsed.query.endDate }, workspaces: workspaceCoverage(rows) },
      { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Coverage yuklanmadi" }, { status: 500 });
  }
}
