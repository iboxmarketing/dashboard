import { reportSessionLost } from "./auth-fetch";
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
export const AUTH_TIMEOUT_MESSAGE = "Sessiyani tekshirish juda uzoq davom etdi. Qayta urinib ko‘ring.";
/** The startup session check never waits longer than this: a hung request ends in Retry. */
export const ME_TIMEOUT_MS = 15_000;

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

export function createHttpAuthAdapter(fetchImpl: typeof fetch = fetch, { meTimeoutMs = ME_TIMEOUT_MS }: { meTimeoutMs?: number } = {}): AuthAdapter {
  /**
   * `genericOn401` is set only for login. Everywhere else a 401 or a 400 carries
   * the server's own message — "Joriy parol noto‘g‘ri", "Parol kamida 12 ta
   * belgidan iborat bo‘lishi kerak" — and replacing those with the login
   * sentence would tell a user changing their password that their email is wrong.
   */
  const call = async (path: string, init?: RequestInit, genericOn401 = false, authenticated = true, timeoutMs = 0) => {
    let response: Response;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced as well as aborted: a fetch that ignores the signal still cannot hold
    // the caller past the deadline.
    const deadline = controller
      ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AuthError("TIMEOUT", AUTH_TIMEOUT_MESSAGE)); }, timeoutMs);
      })
      : null;
    try {
      const request = fetchImpl(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        credentials: "same-origin",
        ...(controller ? { signal: controller.signal } : {}),
      });
      response = await (deadline ? Promise.race([request, deadline]) : request);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("NETWORK", "Serverga ulanmadi. Internetni tekshirib qayta urinib ko‘ring.");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.status === 204) return null;
    const isJson = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
    const payload = isJson ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
    if (!response.ok) {
      // A 401 from an endpoint that needs a session means the session is gone;
      // the shell is told once through the shared path. Login and `me` are not
      // authenticated calls — their 401 is an ordinary answer, not a loss.
      if (response.status === 401 && authenticated) reportSessionLost();
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
      try { return userFrom(await call(AUTH_ENDPOINTS.me, undefined, false, false, meTimeoutMs)); }
      catch (error) {
        // 401 at startup simply means "not signed in", not a failure to report.
        // A 403 is not "signed out": the shell shows it as access denied.
        if (error instanceof AuthError && error.status === 401) return null;
        throw error;
      }
    },
    // Every login failure — wrong password, unknown email, deactivated account,
    // throttled — is collapsed into one sentence by `genericOn401`, so the form
    // cannot be used to discover which emails exist or who has left.
    login: async (body) => userFrom(await call(AUTH_ENDPOINTS.login, { method: "POST", body: JSON.stringify(body) }, true, false)),
    logout: async () => { await call(AUTH_ENDPOINTS.logout, { method: "POST" }, false, false); },
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

/**
 * The production adapter. There is no fixture mode here: sample identities are
 * a test concern and live in `tests/auth-fixture-adapter.ts`, so no production
 * bundle can contain them, let alone fall back to them.
 */
export function createAuthAdapter({ fetchImpl }: { fetchImpl?: typeof fetch } = {}): AuthAdapter {
  return createHttpAuthAdapter(fetchImpl);
}
