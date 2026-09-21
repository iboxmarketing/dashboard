import { assertSafeMutation, clearSessionCookie, cookieValue } from "./security";

/**
 * POST /api/auth/logout, with revocation injected so its failure can be tested.
 *
 * Every response — success, a rejected cross-site request, a D1 failure —
 * carries the clearing Set-Cookie, so the browser always forgets the token.
 * Only a completed server-side revocation reports success; a failed one is a
 * 500 with `revoked: false`, never a false "logged out everywhere".
 */
export async function handleLogout(request: Request, revoke: (token: string) => Promise<void>): Promise<Response> {
  const headers = { "set-cookie": clearSessionCookie(), "cache-control": "no-store" };
  try { assertSafeMutation(request); }
  catch { return Response.json({ error: "So‘rov manbasi rad etildi", code: "CSRF_REJECTED", revoked: false }, { status: 403, headers }); }
  const token = cookieValue(request);
  if (!token) return Response.json({ ok: true, revoked: false }, { headers });
  try {
    await revoke(token);
    return Response.json({ ok: true, revoked: true }, { headers });
  } catch {
    return Response.json({ error: "Sessiyani serverda yopib bo‘lmadi. Brauzerdan chiqildi.", code: "REVOCATION_FAILED", revoked: false }, { status: 500, headers });
  }
}
