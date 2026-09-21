/**
 * The client-side view of the auth contract.
 *
 * Every constant here is re-exported from `lib/auth/*`, which the API routes use.
 * There is deliberately no second list: a UI copy of the permission keys or the
 * roles could drift from the server's, and the drift would read as a permission
 * bug long before anyone suspected two sources of truth.
 */

import { AUTH_ROLES, type AuthRole } from "./auth/types";
import { PERMISSION_KEYS, isPermissionKey, type PermissionKey } from "./auth/permissions";

export const ROLES = AUTH_ROLES;
export type Role = AuthRole;
export const ROLE_LABELS: Record<Role, string> = { ADMIN: "Admin", MEMBER: "Member" };

export const PERMISSIONS = PERMISSION_KEYS;
export type Permission = PermissionKey;
export const isPermission = isPermissionKey;

/**
 * What `/api/auth/me` and `/api/admin/users` return. The server sends more
 * (createdAt, updatedAt); the UI reads only what it renders, and `readUser`
 * drops the rest.
 */
export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  active: boolean;
  /** Meaningful for MEMBER. For ADMIN the role decides and this is advisory. */
  permissions: Permission[];
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
  | { status: "unauthenticated"; error: string | null; notice: string | null }
  | { status: "mustChangePassword"; user: AuthUser }
  | { status: "authenticated"; user: AuthUser };

export type AuthErrorKind = "INVALID_CREDENTIALS" | "INACTIVE" | "FORBIDDEN" | "SERVER" | "NETWORK" | "VALIDATION";
