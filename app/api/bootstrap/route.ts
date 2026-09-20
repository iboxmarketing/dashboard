import { getBitrixDomain, getWebhookUrl } from "@/lib/bitrix";
import { getSettings, getSyncState, listProviderDiagnostics } from "@/lib/storage";
import { authorizeAnyPermission } from "@/lib/auth/http";
import { PERMISSION_KEYS } from "@/lib/auth/permissions";

export async function GET(request: Request) {
  const denied = await authorizeAnyPermission(request, PERMISSION_KEYS);
  if (denied) return denied;
  try {
    const [settings, sync, providers] = await Promise.all([getSettings(), getSyncState(), listProviderDiagnostics()]);
    return Response.json({
      configured: Boolean(getWebhookUrl()),
      domain: getBitrixDomain(),
      settings,
      sync,
      providers,
    });
  } catch {
    return Response.json({ error: "Dashboard bazasi tayyorlanmadi" }, { status: 500 });
  }
}
