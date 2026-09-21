import { SYNC_FAILED_MESSAGE, safeOperationMessage } from "@/lib/safe-errors";
import { pauseSync, resumeSync, runSyncSteps, startSync } from "@/lib/sync";
import { isSyncAction, type SyncAction } from "@/lib/sync-actions";
import { authorizePermission } from "@/lib/auth/http";

/**
 * Sync control endpoint.
 *
 * `start` must be asked for by name. This route previously treated every
 * unrecognised action — including a missing one — as "start", so an empty body
 * was enough to launch a sync against production.
 */
export async function POST(request: Request) {
  const denied = await authorizePermission(request, "settings");
  if (denied) return denied;
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
    // Fixed, pre-written text only — never a raw Error.message.
    return Response.json({ error: safeOperationMessage(error, SYNC_FAILED_MESSAGE) }, { status: 500 });
  }
}
