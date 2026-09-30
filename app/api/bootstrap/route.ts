import { getBitrixDomain } from "@/lib/bitrix";
import { authError, requireAnyPermission } from "@/lib/auth/http";
import { PERMISSION_KEYS, hasPermission } from "@/lib/auth/permissions";
import { loadSalesRecords, requestProject } from "@/lib/sales-http";
import { bootstrapPayload } from "@/lib/sales-sections";
import { listProviderDiagnostics } from "@/lib/storage";

/**
 * Operational configuration, released section by section.
 *
 * Any signed-in user with at least one section may call this, but each block
 * is included only for the permission that owns it. A Finance-only or
 * Projects-only member receives `{}`: no CRM settings, no sync state, no
 * provider diagnostics, no CRM domain. The Sales sections carry their own
 * data freshness, and Diagnostics has its own endpoint.
 */
export async function GET(request: Request) {
  let can: (permission: (typeof PERMISSION_KEYS)[number]) => boolean;
  try {
    const context = await requireAnyPermission(request, PERMISSION_KEYS);
    can = (permission) => hasPermission(context.user.role, context.user.permissions, permission);
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 });
  }
  const headers = { "cache-control": "no-store" };
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  // Nothing is read for a caller without `settings`.
  if (!can("settings")) return Response.json(bootstrapPayload(false, () => { throw new Error("unreachable"); }), { headers });
  try {
    const [{ records, settings, sync, projectSync, configured }, providers] = await Promise.all([
      loadSalesRecords(new Date(), scoped.project), listProviderDiagnostics(),
    ]);
    // The workspace's own last Full Sync and version travel with it, and the
    // payload names its project so the client can refuse a mismatched answer.
    return Response.json({
      ...bootstrapPayload(true, () => ({ configured, domain: getBitrixDomain(), settings, sync, providers, records })),
      project: scoped.project, projectSync,
    }, { headers });
  } catch {
    return Response.json({ error: "Dashboard bazasi tayyorlanmadi" }, { status: 500 });
  }
}
