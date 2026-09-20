import { authError } from "@/lib/auth/http";
import { assertSafeMutation, clearSessionCookie, cookieValue } from "@/lib/auth/security";
import { revokeSession } from "@/lib/auth/storage";

export async function POST(request: Request) {
  try {
    assertSafeMutation(request);
    const token = cookieValue(request);
    if (token) await revokeSession(token);
    return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } });
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Chiqishni bajarib bo‘lmadi" }, { status: 500 });
  }
}
