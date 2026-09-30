import { getSettings, saveSettings } from "@/lib/storage";
import { requestProject } from "@/lib/sales-http";
import { scopeSettingsToProject } from "@/lib/sales-projects";
import { mergeSettingsPayload } from "@/lib/settings-payload";
import { authorizePermission } from "@/lib/auth/http";

/**
 * Settings write endpoint.
 *
 * The merge contract lives in `lib/settings-payload` — absent properties are
 * preserved, `null` clears a nullable field, and a value is validated. An empty
 * body is a no-op; it previously cleared three fields on production.
 */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  const scoped = requestProject(request);
  if (!scoped.ok) return scoped.response;
  try {
    // ONE project's settings. Stage ids from the other project's funnels are
    // dropped on the way in, so a Sales Doctor edit can never land an IBOX stage in
    // Sales Doctor's rules, or the reverse.
    const current = await getSettings(scoped.project);
    const payload = await request.json().catch(() => ({}));
    const next = scopeSettingsToProject(mergeSettingsPayload(current, payload), scoped.project);
    await saveSettings(next, scoped.project);
    return Response.json({ settings: next });
  } catch {
    return Response.json({ error: "Sozlamalarni saqlab bo‘lmadi" }, { status: 400 });
  }
}
