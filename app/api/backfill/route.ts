import { BACKFILL_BATCH_SIZE, runAnalyticsBackfillBatch, startAnalyticsBackfill } from "@/lib/analytics-backfill";
import { backfillBatchCount, type BackfillState } from "@/lib/backfill-plan";
import { getDictionary, saveDictionary } from "@/lib/storage";

const STATE_KEY = "analyticsBackfill";
/**
 * Exactly one batch per request — deliberately not a loop.
 *
 * Production returned Error 1102 even at one batch of 25, so the rebuild is now
 * as small as it can usefully be: one HTTP request rebuilds at most
 * BACKFILL_BATCH_SIZE deals and returns. Many cheap requests beat any amount of
 * work batched into a single invocation.
 */

export async function GET() {
  const state = await getDictionary<BackfillState | null>(STATE_KEY, null);
  if (!state) return Response.json({ status: null });
  return Response.json({ status: state.status, cursor: state.cursor, total: state.total, progress: state.progress, lastError: state.lastError });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as { action?: unknown };
    const action = payload.action === "start" ? "start" : "step";

    let state = action === "start"
      ? await startAnalyticsBackfill()
      : await getDictionary<BackfillState | null>(STATE_KEY, null) ?? await startAnalyticsBackfill();

    if (state.status === "running") state = await runAnalyticsBackfillBatch(state);
    await saveDictionary(STATE_KEY, state);
    // Progress metadata only. The rebuilt records are never echoed back: the
    // response is part of the request's memory, and this endpoint exists
    // precisely because that budget was exceeded.
    return Response.json({
      status: state.status,
      cursor: state.cursor,
      total: state.total,
      progress: state.progress,
      batchSize: BACKFILL_BATCH_SIZE,
      remainingRequests: backfillBatchCount(Math.max(0, state.total - state.cursor), BACKFILL_BATCH_SIZE),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Backfill xatolik";
    const state = await getDictionary<BackfillState | null>(STATE_KEY, null);
    if (state) await saveDictionary(STATE_KEY, { ...state, status: "error", lastError: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
