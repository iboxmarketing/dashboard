import { AuthError, GENERIC_LOGIN_ERROR, type AuthAdapter } from "../lib/auth-adapter";
import { normalizePermissions } from "../lib/auth-permissions";
import type { AuthUser } from "../lib/auth-types";

/**
 * TEST-ONLY auth identities and an in-memory adapter over them.
 *
 * This file lives under tests/ and nothing under app/ or lib/ imports it, so
 * the production bundle contains neither these names and emails nor an adapter
 * that could sign anyone in against them. A test asserts both.
 */
export const AUTH_FIXTURE_USERS: AuthUser[] = [
  { id: "u-admin", email: "admin@ibox.uz", name: "Diyorbek Sultonov", role: "ADMIN", mustChangePassword: false, active: true, permissions: [], lastLoginAt: "2026-09-20T08:10:00.000Z" },
  { id: "u-sales", email: "sanjar@ibox.uz", name: "Sanjar Juraev", role: "MEMBER", mustChangePassword: false, active: true, permissions: ["dashboard", "managers", "leadFlow", "deals"], lastLoginAt: "2026-09-19T14:02:00.000Z" },
  { id: "u-fin", email: "mamura@ibox.uz", name: "Mamura Sobirova", role: "MEMBER", mustChangePassword: false, active: true, permissions: ["finance", "projects"], lastLoginAt: null },
  { id: "u-new", email: "yangi@ibox.uz", name: "Yangi Xodim", role: "MEMBER", mustChangePassword: true, active: true, permissions: ["dashboard"], lastLoginAt: null },
  { id: "u-none", email: "kutish@ibox.uz", name: "Kutilayotgan Xodim", role: "MEMBER", mustChangePassword: false, active: true, permissions: [], lastLoginAt: null },
  { id: "u-off", email: "ketgan@ibox.uz", name: "Ketgan Xodim", role: "MEMBER", mustChangePassword: false, active: false, permissions: ["dashboard"], lastLoginAt: "2026-06-01T09:00:00.000Z" },
];

export const cloneAuthFixtures = (): AuthUser[] => structuredClone(AUTH_FIXTURE_USERS);

/** In-memory adapter mirroring the API contract, for tests only. */
export function createFixtureAuthAdapter({ signedInAs = null, users = cloneAuthFixtures() }: {
  signedInAs?: string | null;
  users?: AuthUser[];
} = {}): AuthAdapter {
  let current = users.find((user) => user.id === signedInAs) ?? null;
  let counter = 0;
  return {
    source: "fixtures",
    me: async () => (current ? structuredClone(current) : null),
    login: async ({ email }) => {
      const found = users.find((user) => user.email.toLowerCase() === email.trim().toLowerCase());
      if (!found || !found.active) throw new AuthError("INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR, 401);
      current = found;
      return structuredClone(found);
    },
    logout: async () => { current = null; },
    changePassword: async () => {
      if (!current) throw new AuthError("INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR, 401);
      const index = users.findIndex((user) => user.id === current!.id);
      if (index >= 0) users[index] = { ...users[index], mustChangePassword: false };
      // Mirrors the API: the password change revokes the session.
      current = null;
      return { loginRequired: true };
    },
    listUsers: async () => structuredClone(users),
    createUser: async (body) => {
      const id = `u-local-${++counter}`;
      users.push({
        id, email: body.email, name: body.name, role: body.role,
        mustChangePassword: body.mustChangePassword, active: true,
        permissions: normalizePermissions(body.permissions), lastLoginAt: null,
      });
      return { id };
    },
    updateUser: async (patch) => {
      const index = users.findIndex((user) => user.id === patch.id);
      if (index < 0) throw new AuthError("SERVER", "Foydalanuvchi topilmadi", 404);
      // `temporaryPassword` is write-only: accepted and stored nowhere, exactly
      // as the API behaves, so no later read can echo it back.
      const { id, ...rest } = patch;
      delete rest.temporaryPassword;
      users[index] = { ...users[index], ...rest, permissions: rest.permissions ? normalizePermissions(rest.permissions) : users[index].permissions };
      if (current?.id === id) current = users[index];
    },
  };
}

