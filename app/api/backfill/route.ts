import { BACKFILL_BATCH_SIZE, runAnalyticsBackfillBatch, startAnalyticsBackfill } from "@/lib/analytics-backfill";
import { backfillBatchCount, type BackfillState } from "@/lib/backfill-plan";
import { getDictionary, saveDictionary } from "@/lib/storage";

const STATE_KEY = "analyticsBackfill";
/**
 * Batches per request. Bounded on purpose: the Error 1102 incident was a
 * resource-limit failure, so the rebuild advances in small steps driven by the
 * caller rather than looping until done inside one invocation.
 */
const BATCHES_PER_REQUEST = 4;

export async function GET() {
  const state = await getDictionary<BackfillState | null>(STATE_KEY, null);
  return Response.json({ backfill: state });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as { action?: unknown };
    const action = payload.action === "start" ? "start" : "step";

    let state = action === "start"
      ? await startAnalyticsBackfill()
      : await getDictionary<BackfillState | null>(STATE_KEY, null) ?? await startAnalyticsBackfill();

    for (let batch = 0; batch < BATCHES_PER_REQUEST && state.status === "running"; batch += 1) {
      state = await runAnalyticsBackfillBatch(state);
    }
    await saveDictionary(STATE_KEY, state);
    return Response.json({
      backfill: state,
      batchSize: BACKFILL_BATCH_SIZE,
      remainingBatches: backfillBatchCount(Math.max(0, state.total - state.cursor), BACKFILL_BATCH_SIZE),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Backfill xatolik";
    const state = await getDictionary<BackfillState | null>(STATE_KEY, null);
    if (state) await saveDictionary(STATE_KEY, { ...state, status: "error", lastError: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
