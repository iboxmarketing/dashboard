import { cloneAuthFixtures } from "./auth-fixtures";
import { normalizePermissions } from "./auth-permissions";
import { isAuthRole } from "./auth/types";
import type {
  AuthErrorKind, AuthUser, ChangePasswordRequest, LoginRequest, NewUser, Role, UserPatch,
} from "./auth-types";

/**
 * The only place auth and admin talk to the network.
 *
 * Components call the adapter, never `fetch`. There is deliberately no automatic
 * fixture fallback: an auth failure must surface as an error, because signing
 * someone in against sample users would be a security incident, not a
 * convenience.
 */

export const AUTH_ENDPOINTS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/auth/me",
  changePassword: "/api/auth/change-password",
  users: "/api/admin/users",
} as const;

export class AuthError extends Error {
  readonly kind: AuthErrorKind;
  readonly status: number;
  constructor(kind: AuthErrorKind, message: string, status = 0) {
    super(message); this.name = "AuthError"; this.kind = kind; this.status = status;
  }
}

/**
 * Login failures are deliberately indistinguishable.
 *
 * A wrong password, an unknown email and a deactivated account all produce the
 * same sentence, so the form cannot be used to discover which emails exist or
 * which staff have left.
 */
export const GENERIC_LOGIN_ERROR = "Email yoki parol noto‘g‘ri, yoki hisob faol emas.";
export const FORBIDDEN_MESSAGE = "Bu bo‘limga kirish huquqingiz yo‘q.";

function errorKind(status: number): AuthErrorKind {
  if (status === 401) return "INVALID_CREDENTIALS";
  if (status === 400) return "VALIDATION";
  if (status === 403) return "FORBIDDEN";
  if (status === 0) return "NETWORK";
  return "SERVER";
}

/** Normalises whatever the backend returns into the UI's `AuthUser`. */
export function readUser(raw: unknown): AuthUser {
  const value = (raw ?? {}) as Record<string, unknown>;
  // An unrecognised role degrades to MEMBER, the least privileged: a server that
  // starts sending a new role must not accidentally widen access here.
  const role: Role = isAuthRole(value.role) ? value.role : "MEMBER";
  return {
    id: String(value.id ?? ""),
    email: String(value.email ?? ""),
    name: String(value.name ?? "").trim() || String(value.email ?? ""),
    role,
    mustChangePassword: value.mustChangePassword === true,
    active: value.active !== false,
    permissions: normalizePermissions(value.permissions),
    lastLoginAt: typeof value.lastLoginAt === "string" ? value.lastLoginAt : null,
  };
}

export type AuthAdapter = {
  readonly source: "api" | "fixtures";
  me(): Promise<AuthUser | null>;
  login(body: LoginRequest): Promise<AuthUser>;
  logout(): Promise<void>;
  /**
   * Resolves once the server has accepted the new password. `loginRequired`
   * means the server revoked every session, including this one.
   */
  changePassword(body: ChangePasswordRequest): Promise<{ loginRequired: boolean }>;
  listUsers(): Promise<AuthUser[]>;
  createUser(body: NewUser): Promise<{ id: string }>;
  updateUser(body: UserPatch): Promise<void>;
};

export function createHttpAuthAdapter(fetchImpl: typeof fetch = fetch): AuthAdapter {
  /**
   * `genericOn401` is set only for login. Everywhere else a 401 or a 400 carries
   * the server's own message — "Joriy parol noto‘g‘ri", "Parol kamida 12 ta
   * belgidan iborat bo‘lishi kerak" — and replacing those with the login
   * sentence would tell a user changing their password that their email is wrong.
   */
  const call = async (path: string, init?: RequestInit, genericOn401 = false) => {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        credentials: "same-origin",
      });
    } catch { throw new AuthError("NETWORK", "Serverga ulanmadi. Internetni tekshirib qayta urinib ko‘ring."); }
    if (response.status === 204) return null;
    const isJson = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
    const payload = isJson ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
    if (!response.ok) {
      const kind = errorKind(response.status);
      const serverMessage = typeof payload?.error === "string" && payload.error ? payload.error : null;
      const message = kind === "INVALID_CREDENTIALS" && genericOn401
        ? GENERIC_LOGIN_ERROR
        : kind === "FORBIDDEN"
          ? serverMessage ?? FORBIDDEN_MESSAGE
          : serverMessage ?? "Server xatosi. Keyinroq urinib ko‘ring.";
      throw new AuthError(kind, message, response.status);
    }
    return payload;
  };

  const userFrom = (payload: Record<string, unknown> | null) => {
    const raw = payload && "user" in payload ? payload.user : payload;
    if (!raw || typeof raw !== "object") throw new AuthError("SERVER", "Server foydalanuvchini qaytarmadi.");
    return readUser(raw);
  };

  return {
    source: "api",
    me: async () => {
      try { return userFrom(await call(AUTH_ENDPOINTS.me)); }
      catch (error) {
        // 401 at startup simply means "not signed in", not a failure to report.
        if (error instanceof AuthError && (error.status === 401 || error.status === 403)) return null;
        throw error;
      }
    },
    // Every login failure — wrong password, unknown email, deactivated account,
    // throttled — is collapsed into one sentence by `genericOn401`, so the form
    // cannot be used to discover which emails exist or who has left.
    login: async (body) => userFrom(await call(AUTH_ENDPOINTS.login, { method: "POST", body: JSON.stringify(body) }, true)),
    logout: async () => { await call(AUTH_ENDPOINTS.logout, { method: "POST" }); },
    changePassword: async (body) => {
      const payload = await call(AUTH_ENDPOINTS.changePassword, { method: "POST", body: JSON.stringify(body) });
      // The server revokes every session on a password change, so a success here
      // means the current cookie is already dead and the user must sign in again.
      return { loginRequired: payload?.loginRequired !== false };
    },
    listUsers: async () => {
      const payload = await call(AUTH_ENDPOINTS.users);
      const rows = payload && Array.isArray(payload.users) ? payload.users : Array.isArray(payload) ? payload : null;
      if (!rows) throw new AuthError("SERVER", "Server foydalanuvchilar ro‘yxatini qaytarmadi.");
      return rows.map(readUser);
    },
    createUser: async (body) => {
      const payload = await call(AUTH_ENDPOINTS.users, { method: "POST", body: JSON.stringify(body) });
      const id = payload && typeof payload.id === "string" ? payload.id : null;
      if (!id) throw new AuthError("SERVER", "Server yangi foydalanuvchi id qaytarmadi.");
      return { id };
    },
    updateUser: async (body) => { await call(AUTH_ENDPOINTS.users, { method: "PATCH", body: JSON.stringify(body) }); },
  };
}

/** Explicit test/development stand-in. Production never reaches this. */
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

export function createAuthAdapter({ mode = "api", fetchImpl, fixture }: {
  mode?: "api" | "fixtures";
  fetchImpl?: typeof fetch;
  fixture?: Parameters<typeof createFixtureAuthAdapter>[0];
} = {}): AuthAdapter {
  return mode === "fixtures" ? createFixtureAuthAdapter(fixture) : createHttpAuthAdapter(fetchImpl);
}
