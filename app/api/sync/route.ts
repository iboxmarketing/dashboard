import { safeBitrixMessage } from "@/lib/bitrix";
import { pauseSync, resumeSync, runSyncStep, startSync } from "@/lib/sync";

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as { action?: "start" | "step" | "pause" | "resume"; days?: number; full?: boolean };
    const result = payload.action === "step"
      ? await runSyncStep()
      : payload.action === "pause"
        ? await pauseSync()
        : payload.action === "resume"
          ? await resumeSync()
          : await startSync(payload);
    return Response.json(result);
  } catch (error) {
    const safe = safeBitrixMessage(error);
    return Response.json({ error: safe === "Kutilmagan xavfsiz server xatosi" && error instanceof Error ? error.message.slice(0, 240) : safe }, { status: 500 });
  }
}
