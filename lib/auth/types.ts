export const AUTH_ROLES = ["ADMIN", "MEMBER"] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: AuthRole;
  passwordHash: string;
  mustChangePassword: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type PublicAuthUser = Omit<AuthUser, "passwordHash"> & { permissions: string[] };
export type AuthSession = {
  id: string; tokenHash: string; userId: string; createdAt: string;
  expiresAt: string; lastSeenAt: string; revokedAt: string | null;
};
export type AuthContext = { user: PublicAuthUser; session: Omit<AuthSession, "tokenHash"> };

export function normalizeEmail(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
export function isAuthRole(value: unknown): value is AuthRole { return AUTH_ROLES.includes(value as AuthRole); }
