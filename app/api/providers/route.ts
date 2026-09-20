import { saveProviderRule } from "@/lib/storage";
import { authorizePermission } from "@/lib/auth/http";

export async function POST(request: Request) {
  const denied = await authorizePermission(request, "diagnostics");
  if (denied) return denied;
  try {
    const payload = (await request.json()) as { key?: string; mode?: string };
    if (!payload.key || !["AUTO", "USE", "IGNORE"].includes(payload.mode ?? "")) {
      return Response.json({ error: "Provider sozlamasi noto‘g‘ri" }, { status: 400 });
    }
    await saveProviderRule(payload.key, payload.mode as "AUTO" | "USE" | "IGNORE");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Provider sozlamasini saqlab bo‘lmadi" }, { status: 500 });
  }
}
