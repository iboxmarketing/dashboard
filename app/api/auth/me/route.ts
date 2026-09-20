import { authError, requireSession } from "@/lib/auth/http";

export async function GET(request: Request) {
  try {
    const context = await requireSession(request);
    return Response.json({ user: context.user, session: context.session }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Sessiyani tekshirib bo‘lmadi" }, { status: 500 });
  }
}
