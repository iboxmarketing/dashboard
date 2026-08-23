import { getSettings, saveSettings } from "@/lib/storage";
import { mergeSettingsPayload } from "@/lib/settings-payload";

/**
 * Settings write endpoint.
 *
 * The merge contract lives in `lib/settings-payload` — absent properties are
 * preserved, `null` clears a nullable field, and a value is validated. An empty
 * body is a no-op; it previously cleared three fields on production.
 */
export async function POST(request: Request) {
  try {
    const current = await getSettings();
    const payload = await request.json().catch(() => ({}));
    const next = mergeSettingsPayload(current, payload);
    await saveSettings(next);
    return Response.json({ settings: next });
  } catch {
    return Response.json({ error: "Sozlamalarni saqlab bo‘lmadi" }, { status: 400 });
  }
}
