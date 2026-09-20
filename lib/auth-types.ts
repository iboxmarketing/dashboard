/**
 * Auth contract shared with `feat/auth-core`.
 *
 * Two roles only. ADMIN is unconditional full access — never a stored permission
 * list that could drift out of sync with the role. MEMBER carries an explicit
 * list, and anything absent from it is completely unavailable.
 */

export const ROLES = ["ADMIN", "MEMBER"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = { ADMIN: "Admin", MEMBER: "Member" };

/**
 * Canonical permission keys. This list is the contract: a key that is not here
 * does not exist, and every navigable section maps to exactly one key.
 */
export const PERMISSIONS = [
  "dashboard", "managers", "leadFlow", "quality", "stages", "deals",
  "finance", "projects", "pages", "diagnostics", "settings", "users",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const isPermission = (value: unknown): value is Permission => PERMISSIONS.includes(value as Permission);

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  active: boolean;
  /** Meaningful for MEMBER. For ADMIN the role decides and this is advisory. */
  permissions: Permission[];
  /** Only when the backend provides it. */
  lastLoginAt?: string | null;
};

export type LoginRequest = { email: string; password: string };
export type ChangePasswordRequest = { currentPassword: string; newPassword: string };

export type NewUser = {
  name: string;
  email: string;
  role: Role;
  temporaryPassword: string;
  mustChangePassword: boolean;
  permissions: Permission[];
};

/**
 * Admin edit payload. Every field is optional so a PATCH carries only what
 * changed. `temporaryPassword` is write-only — no response ever returns it.
 */
export type UserPatch = {
  id: string;
  name?: string;
  email?: string;
  role?: Role;
  active?: boolean;
  permissions?: Permission[];
  temporaryPassword?: string;
  mustChangePassword?: boolean;
};

/** Startup states. `loading` must render before any navigation is decided. */
export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated"; error: string | null }
  | { status: "mustChangePassword"; user: AuthUser }
  | { status: "authenticated"; user: AuthUser };

export type AuthErrorKind = "INVALID_CREDENTIALS" | "INACTIVE" | "FORBIDDEN" | "SERVER" | "NETWORK" | "VALIDATION";
