import { authorizePermission } from "@/lib/auth/http";
import { marketingAdminResponse } from "@/lib/marketing/http";
import { startMetaSync, stepMetaSync } from "@/lib/marketing/jobs";

/** Meta Ads Insights ingestion: {action:"start", days?} once, then {action:"step"} until success. */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  return marketingAdminResponse(request, async (payload) => {
    if (payload.action === "start") return startMetaSync(Number(payload.days ?? 365));
    return stepMetaSync();
  });
}
