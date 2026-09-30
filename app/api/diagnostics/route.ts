import { authError, requirePermission } from "@/lib/auth/http";
import { loadSalesRecords, requestProject, salesServerTiming } from "@/lib/sales-http";
import { diagnosticsPayload } from "@/lib/sales-sections";

/**
 * Diagnostics as a finished view model: sync health, data-quality counts,
 * classification diagnostics and stage-configuration readiness. Aggregates
 * only — the record population never leaves the Worker.
 */
export async function GET(request: Request) {
  try { await requirePermission(request, "diagnostics"); }
  catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  try {
    const { records, settings, sync, projectSync, timing } = await loadSalesRecords(new Date(), scoped.project);
    return Response.json({ ...diagnosticsPayload(records, settings, sync), project: scoped.project, projectSync },
      { headers: { "cache-control": "no-store", "server-timing": salesServerTiming(timing) } });
  } catch {
    return Response.json({ error: "Diagnostika ma’lumotlarini yuklab bo‘lmadi" }, { status: 500 });
  }
}
