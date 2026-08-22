import { bitrixCall, getBitrixDomain, getWebhookUrl, safeBitrixMessage } from "@/lib/bitrix";
import { saveSyncState } from "@/lib/storage";

type Check = "ok" | "warning" | "error";

async function test(method: string, params: Record<string, unknown>, optional = false): Promise<Check> {
  try {
    await bitrixCall(method, params);
    return "ok";
  } catch {
    return optional ? "warning" : "error";
  }
}

export async function POST() {
  if (!getWebhookUrl()) {
    return Response.json({ configured: false, error: "Bitrix24 webhook ulanmagan" }, { status: 400 });
  }
  try {
    await bitrixCall("profile", {});
    const [deals, stageHistory, managers] = await Promise.all([
      test("crm.deal.list", { select: ["ID"], start: 0 }),
      test("crm.stagehistory.list", { entityTypeId: 2, filter: { OWNER_ID: 0 }, select: ["ID"], start: 0 }),
      test("user.get", { FILTER: { ACTIVE: true }, start: 0 }),
    ]);
    const permissions = { deals, stageHistory, managers };
    await saveSyncState({ status: "connected", permissions, safeError: null });
    return Response.json({
      configured: true,
      domain: getBitrixDomain(),
      bitrix: "ok",
      ...permissions,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ configured: true, bitrix: "error", error: safeBitrixMessage(error) }, { status: 400 });
  }
}

