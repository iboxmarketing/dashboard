import { safeBitrixMessage } from "@/lib/bitrix";
import { addD1WriteAuditToResponse, withD1WriteAudit, withD1WriteAuditPhase } from "@/lib/d1-write-audit";
import { pauseSync, resumeSync, runSyncSteps, startSync } from "@/lib/sync";
import { isSyncAction, type SyncAction } from "@/lib/sync-actions";
import { env } from "cloudflare:workers";

function auditJson<T extends object>(value: T, init?: ResponseInit) {
  return Response.json(addD1WriteAuditToResponse(value), init);
}

/**
 * Sync control endpoint.
 *
 * `start` must be asked for by name. This route previously treated every
 * unrecognised action — including a missing one — as "start", so an empty body
 * was enough to launch a sync against production.
 */
export async function POST(request: Request) {
  const auditFlag = (env as unknown as { D1_WRITE_AUDIT?: string }).D1_WRITE_AUDIT;
  return await withD1WriteAudit(auditFlag, async () => {
    try {
      const payload = (await request.json().catch(() => ({}))) as {
        action?: unknown; days?: number; full?: boolean; steps?: number; pipelineId?: string;
      };
      if (!isSyncAction(payload.action)) {
        return auditJson({ error: "Noma’lum amal" }, { status: 400 });
      }
      const action: SyncAction = payload.action;
      const phase = action === "start" ? "sync.start"
        : action === "step" ? "sync.step"
          : action === "pause" ? "sync.pause"
            : "sync.resume";
      const result = await withD1WriteAuditPhase(phase, async () => action === "start"
        ? await startSync(payload)
        : action === "step"
          ? await runSyncSteps(payload.steps)
          : action === "pause"
            ? await pauseSync()
            : await resumeSync());
      return auditJson(result);
    } catch (error) {
      const safe = safeBitrixMessage(error);
      return auditJson({ error: safe === "Kutilmagan xavfsiz server xatosi" && error instanceof Error ? error.message.slice(0, 240) : safe }, { status: 500 });
    }
  });
}
