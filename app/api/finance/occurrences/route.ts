import { financeApiError, financeId, financePayload } from "@/lib/finance/api";
import {
  confirmSubscriptionOccurrence, keepOccurrencePending, listSubscriptionOccurrences,
  retrySubscriptionOccurrence, skipSubscriptionOccurrence, sweepDueSubscriptions,
} from "@/lib/finance/occurrence-storage";
import { authorizePermission } from "@/lib/auth/http";

/** Asia/Tashkent decides what "today" means, as everywhere else in Finance. */
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
});

export async function GET(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try { return Response.json({ occurrences: await listSubscriptionOccurrences() }); }
  catch (error) { return financeApiError(error); }
}

/**
 * Every occurrence action, and the manual sweep.
 *
 * `sweep` creates the missing occurrence for each due subscription and checks its
 * balance once — the same call the daily cron makes, exposed so the owner can ask
 * "check now" without waiting for it. It never rechecks an existing occurrence.
 */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "finance");
  if (denied) return denied;
  try {
    const payload = await financePayload(request);
    const action = String(payload.action ?? "");
    if (action === "sweep") {
      return Response.json({ sweep: await sweepDueSubscriptions(dayFormatter.format(new Date())) });
    }
    const id = financeId(payload);
    if (!id) return Response.json({ error: "Occurrence id is required" }, { status: 400 });
    switch (action) {
      case "retry": return Response.json(await retrySubscriptionOccurrence(id));
      case "confirm": return Response.json(await confirmSubscriptionOccurrence(id));
      case "pending": return Response.json(await keepOccurrencePending(id));
      case "skip": return Response.json(await skipSubscriptionOccurrence(id));
      default: return Response.json({ error: "Unknown occurrence action" }, { status: 400 });
    }
  } catch (error) { return financeApiError(error); }
}
