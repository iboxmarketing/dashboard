import { authenticateCredentials } from "@/lib/auth/authenticate";
import { assertSafeMutation, clientAddress, sessionCookie } from "@/lib/auth/security";
import {
  clearLoginFailures, completeLogin, createSession, findUserByEmail, loginThrottleKey,
  loginThrottleStatus, recordLoginFailure,
  resolveSession,
} from "@/lib/auth/storage";
import { normalizeEmail } from "@/lib/auth/types";

const GENERIC_ERROR = "Email yoki parol noto‘g‘ri";

export async function POST(request: Request) {
  try {
    assertSafeMutation(request);
    const payload = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = normalizeEmail(payload.email);
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!email || password.length > 256) return Response.json({ error: GENERIC_ERROR }, { status: 401 });

    const throttleKey = await loginThrottleKey(email, clientAddress(request));
    const throttle = await loginThrottleStatus(throttleKey);
    if (throttle?.blocked_until && throttle.blocked_until > new Date().toISOString()) {
      return Response.json({ error: "Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring" }, { status: 429, headers: { "retry-after": "600" } });
    }

    const user = await authenticateCredentials(await findUserByEmail(email), password);
    if (!user) {
      await recordLoginFailure(throttleKey);
      return Response.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    await clearLoginFailures(throttleKey);
    const { token } = await createSession(user.id);
    await completeLogin(user.id);
    const context = await resolveSession(token);
    if (!context) throw new Error("Created session could not be resolved");
    return Response.json({ user: context.user }, {
      headers: { "set-cookie": sessionCookie(token), "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && ["CROSS_SITE_REQUEST", "INVALID_REQUEST_ORIGIN"].includes(error.message)) {
      return Response.json({ error: "So‘rov manbasi rad etildi" }, { status: 403 });
    }
    return Response.json({ error: "Kirishni bajarib bo‘lmadi" }, { status: 500 });
  }
}
