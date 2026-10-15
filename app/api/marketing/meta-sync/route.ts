import { authorizePermission } from "@/lib/auth/http";
import { marketingAdminResponse } from "@/lib/marketing/http";
import { extendMetaSync, resumeMetaSync, startMetaSync, stepMetaSync } from "@/lib/marketing/jobs";

/** Meta Ads Insights: {action:"start", days?} (resumes a run in progress), {action:"step"} until success, {action:"resume"} after a pause. */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
  return marketingAdminResponse(request, async (payload) => {
    if (payload.action === "start") return startMetaSync(Number(payload.days ?? 365), fetch, payload.restart === true, { from: payload.from, to: payload.to });
    if (payload.action === "resume") return resumeMetaSync();
    if (payload.action === "extend") return extendMetaSync(payload.from);
    return stepMetaSync();
  });
}
