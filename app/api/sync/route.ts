import { safeBitrixMessage } from "@/lib/bitrix";
import { pauseSync, resumeSync, runSyncSteps, startSync } from "@/lib/sync";
import { isSyncAction, type SyncAction } from "@/lib/sync-actions";

/**
 * Sync control endpoint.
 *
 * `start` must be asked for by name. This route previously treated every
 * unrecognised action — including a missing one — as "start", so an empty body
 * was enough to launch a sync against production.
 */
export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as {
      action?: unknown; days?: number; full?: boolean; steps?: number; pipelineId?: string;
    };
    if (!isSyncAction(payload.action)) {
      return Response.json({ error: "Noma’lum amal" }, { status: 400 });
    }
    const action: SyncAction = payload.action;
    const result = action === "start"
      ? await startSync(payload)
      : action === "step"
        ? await runSyncSteps(payload.steps)
        : action === "pause"
          ? await pauseSync()
          : await resumeSync();
    return Response.json(result);
  } catch (error) {
    const safe = safeBitrixMessage(error);
    return Response.json({ error: safe === "Kutilmagan xavfsiz server xatosi" && error instanceof Error ? error.message.slice(0, 240) : safe }, { status: 500 });
  }
}
