import { SYNC_FAILED_MESSAGE, safeOperationMessage } from "@/lib/safe-errors";
import { pauseSync, resumeSync, runSyncSteps, startSync } from "@/lib/sync";
import { isSyncAction, type SyncAction } from "@/lib/sync-actions";
import { authorizePermission } from "@/lib/auth/http";
import { parseProjectKey } from "@/lib/sales-projects";

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
      action?: unknown; days?: number; full?: boolean; steps?: number; pipelineId?: string; project?: unknown;
    };
    if (!isSyncAction(payload.action)) {
      return Response.json({ error: "Noma’lum amal" }, { status: 400 });
    }
    const action: SyncAction = payload.action;
    // A start names its project (body or `?project=`); step, pause and resume act
    // on the running job, which already carries its own.
    const project = parseProjectKey(payload.project ?? new URL(request.url).searchParams.get("project"));
    if (action === "start" && !project) return Response.json({ error: "Loyiha noto‘g‘ri" }, { status: 400 });
    const result = action === "start"
      ? await startSync({ days: payload.days, full: payload.full, pipelineId: payload.pipelineId, project: project ?? undefined })
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
