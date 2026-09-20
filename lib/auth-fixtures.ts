import type { AuthUser } from "./auth-types";

/**
 * TEST-ONLY fixtures.
 *
 * Never reachable in production: `createAuthAdapter` defaults to `mode: "api"`
 * and has no failure path that falls back here. Auth data showing sample users
 * would be far worse than an error screen.
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
