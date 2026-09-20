import { hasPermission, type PermissionKey } from "./permissions";
import type { AuthContext } from "./types";

export class AuthHttpError extends Error {
  constructor(public status: 401 | 403, public code: string, message: string) { super(message); }
}

export function assertContextPermission(context: AuthContext, permission: PermissionKey) {
  if (context.user.mustChangePassword) throw new AuthHttpError(403, "PASSWORD_CHANGE_REQUIRED", "Avval vaqtinchalik parolni almashtiring");
  if (!hasPermission(context.user.role, context.user.permissions, permission)) throw new AuthHttpError(403, "FORBIDDEN", "Bu bo‘lim uchun ruxsat yo‘q");
  return context;
}

export function authorizationErrorResponse(error: unknown) {
  if (error instanceof AuthHttpError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return null;
}
