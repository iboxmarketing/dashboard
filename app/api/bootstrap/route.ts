import { getBitrixDomain, getWebhookUrl } from "@/lib/bitrix";
import { getSettings, getSyncState, listProviderDiagnostics } from "@/lib/storage";

export async function GET() {
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

