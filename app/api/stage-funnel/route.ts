import { getSettings, listStageFunnelJson } from "@/lib/storage";
import { requestProject } from "@/lib/sales-http";
import { authorizePermission } from "@/lib/auth/http";
import { projectScopedRecords } from "@/lib/sales-sections";
import type { StageFunnelRecord } from "@/lib/dashboard-record";

/**
 * Stage history for the Stage Control funnel only, fetched when that view is
 * opened. It carries the timeline plus the minimal fields the historical
 * Manager, Source, Pipeline and search filters read — never the full record,
 * and never on the dashboard's initial load.
 *
 * The rows go through the same project scope and membership rule as every
 * Sales section (`projectScopedRecords`), so an older record from another
 * project cannot reach the funnel through the legacy fallback.
 */
export async function GET(request: Request) {
  const denied = await authorizePermission(request, "stages");
  if (denied) return denied;
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  try {
    const [rows, settings] = await Promise.all([listStageFunnelJson(), getSettings(scoped.project)]);
    const records = projectScopedRecords(rows.map((row) => JSON.parse(row) as StageFunnelRecord), settings, scoped.project);
    return Response.json({ records, project: scoped.project });
  } catch {
    return Response.json({ error: "Stage tarixini yuklab bo‘lmadi" }, { status: 500 });
  }
}
