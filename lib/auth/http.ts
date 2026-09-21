import { hasPermission, type PermissionKey } from "./permissions";
import { assertSafeMutation, cookieValue } from "./security";
import { resolveSession } from "./storage";
import type { AuthContext } from "./types";
import { assertContextPermission, AuthHttpError, authorizationErrorResponse } from "./authorization";

export { AuthHttpError } from "./authorization";
export async function requireSession(request: Request): Promise<AuthContext> {
  const token = cookieValue(request);
  const context = token ? await resolveSession(token) : null;
  if (!context) throw new AuthHttpError(401, "UNAUTHENTICATED", "Kirish talab qilinadi");
  return context;
}
export async function requirePermission(request: Request, permission: PermissionKey) {
  assertSafeMutation(request);
  const context = await requireSession(request);
  return assertContextPermission(context, permission);
}
export async function requireAnyPermission(request: Request, permissions: PermissionKey[]) {
  assertSafeMutation(request);
  const context = await requireSession(request);
  if (context.user.mustChangePassword) throw new AuthHttpError(403, "PASSWORD_CHANGE_REQUIRED", "Avval vaqtinchalik parolni almashtiring");
  if (!permissions.some((permission) => hasPermission(context.user.role, context.user.permissions, permission))) throw new AuthHttpError(403, "FORBIDDEN", "Bu ma’lumot uchun ruxsat yo‘q");
  return context;
}
export async function requireAdmin(request: Request) {
  assertSafeMutation(request);
  const context = await requireSession(request);
  if (context.user.mustChangePassword) throw new AuthHttpError(403, "PASSWORD_CHANGE_REQUIRED", "Avval vaqtinchalik parolni almashtiring");
  if (context.user.role !== "ADMIN") throw new AuthHttpError(403, "FORBIDDEN", "Administrator ruxsati talab qilinadi");
  return context;
}
export function authError(error: unknown) {
  const authorization = authorizationErrorResponse(error);
  if (authorization) return authorization;
  if (error instanceof Error && ["CROSS_SITE_REQUEST", "INVALID_REQUEST_ORIGIN"].includes(error.message)) return Response.json({ error: "So‘rov manbasi rad etildi", code: "CSRF_REJECTED" }, { status: 403 });
  return null;
}
export async function authorizePermission(request: Request, permission: PermissionKey) {
  try { await requirePermission(request, permission); return null; } catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
}
export async function authorizeAnyPermission(request: Request, permissions: PermissionKey[]) {
  try { await requireAnyPermission(request, permissions); return null; } catch (error) { return authError(error) ?? Response.json({ error: "Kirishni tekshirib bo‘lmadi" }, { status: 500 }); }
}
