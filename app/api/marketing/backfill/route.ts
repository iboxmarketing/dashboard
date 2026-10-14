import { authorizePermission } from "@/lib/auth/http";
import { marketingAdminResponse } from "@/lib/marketing/http";
import { resumeAttributionBackfill, startAttributionBackfill, stepAttributionBackfill } from "@/lib/marketing/jobs";

/** Historical attribution backfill: {action:"start"} once, then {action:"step"} until success. Resumable. */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  return marketingAdminResponse(request, async (payload) => {
    if (payload.action === "start") { await startAttributionBackfill(); return stepAttributionBackfill(); }
    if (payload.action === "resume") return resumeAttributionBackfill();
    return stepAttributionBackfill();
  });
}
