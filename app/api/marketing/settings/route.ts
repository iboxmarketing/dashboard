import { authError, requirePermission } from "@/lib/auth/http";
import { marketingAdminResponse } from "@/lib/marketing/http";
import { getMarketingSettings, saveMarketingSettings } from "@/lib/marketing/store";
import { isProjectKey } from "@/lib/sales-projects";

/** The Marketing reporting rate (USD→UZS) and the Meta ad accounts, each optionally tied to a project. */
export async function GET(request: Request) {
  try { await requirePermission(request, "dashboard"); }
  catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
  return Response.json({ settings: await getMarketingSettings() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  try { await requirePermission(request, "settings"); }
  catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
  return marketingAdminResponse(request, async (payload) => {
    const current = await getMarketingSettings();
    const rate = payload.usdToUzs === undefined ? current.usdToUzs : Number(payload.usdToUzs);
    if (!Number.isSafeInteger(rate) || rate <= 0) return { error: "Kurs noto‘g‘ri" };
    const accounts = Array.isArray(payload.adAccounts)
      ? (payload.adAccounts as { id?: unknown; projectKey?: unknown }[])
        .filter((item) => /^\d{5,25}$/.test(String(item?.id ?? "")))
        .map((item) => ({ id: String(item.id), projectKey: isProjectKey(item.projectKey) ? item.projectKey : null }))
      : current.adAccounts;
    const next = { usdToUzs: rate, adAccounts: accounts };
    await saveMarketingSettings(next);
    return { settings: next };
  });
}
