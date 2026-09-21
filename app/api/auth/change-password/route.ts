import { authError, requireSession } from "@/lib/auth/http";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/auth/password";
import { assertSafeMutation, clearSessionCookie } from "@/lib/auth/security";
import { changeOwnPassword, findUserById } from "@/lib/auth/storage";

export async function POST(request: Request) {
  try {
    assertSafeMutation(request);
    const context = await requireSession(request);
    const payload = (await request.json().catch(() => ({}))) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
    const checked = validatePassword(payload.newPassword);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    if (currentPassword === checked.value) return Response.json({ error: "Yangi parol avvalgisidan farq qilishi kerak" }, { status: 400 });
    const user = await findUserById(context.user.id);
    if (!user || !await verifyPassword(currentPassword, user.passwordHash)) return Response.json({ error: "Joriy parol noto‘g‘ri" }, { status: 400 });
    await changeOwnPassword(user.id, await hashPassword(checked.value));
    return Response.json({ ok: true, loginRequired: true }, { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } });
  } catch (error) {
    return authError(error) ?? Response.json({ error: "Parolni almashtirib bo‘lmadi" }, { status: 500 });
  }
}
