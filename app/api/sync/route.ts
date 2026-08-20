import { safeBitrixMessage } from "@/lib/bitrix";
import { runSync } from "@/lib/sync";

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as { days?: number; full?: boolean };
    const result = await runSync(payload);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: safeBitrixMessage(error) }, { status: 500 });
  }
}

