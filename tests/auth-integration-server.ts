import { authenticateCredentials } from "../lib/auth/authenticate";
import { hashPassword, validatePassword, verifyPassword } from "../lib/auth/password";
import { PERMISSION_KEYS, hasPermission, normalizeMemberPermissions, type PermissionKey } from "../lib/auth/permissions";
import { assertSafeMutation, clearSessionCookie, cookieValue, hashOpaqueToken, createSessionToken, sessionCookie, sessionIsUsable } from "../lib/auth/security";
import { isAuthRole, normalizeEmail, type AuthRole } from "../lib/auth/types";

/**
 * An in-memory stand-in for the API, used only by the integration tests.
 *
 * Everything that decides anything is the real module: `hasPermission`,
 * `validatePassword`, `verifyPassword`, the session token hashing and
 * `assertSafeMutation` are imported, not reimplemented. Only the D1 rows are
 * held in maps, because `db/index.ts` imports `cloudflare:workers`, which does
 * not resolve outside the Worker runtime.
 *
 * The route guards this server applies are asserted against the real route
 * sources in the test file, so the two cannot drift apart unnoticed.
 */

export type SeedUser = {
  id: string; email: string; name: string; role: AuthRole; password: string;
  permissions: PermissionKey[]; mustChangePassword?: boolean; active?: boolean;
};

type Row = {
  id: string; email: string; name: string; role: AuthRole; passwordHash: string;
  mustChangePassword: boolean; active: boolean; permissions: PermissionKey[]; lastLoginAt: string | null;
};
type Session = { tokenHash: string; userId: string; expiresAt: string; revokedAt: string | null };

/** Route → the permission the real route guards it with. */
export const ROUTE_PERMISSIONS: Record<string, PermissionKey | PermissionKey[] | "ADMIN" | "ANY"> = {
  "/api/bootstrap": "ANY",
  "/api/dashboard": ["dashboard", "managers", "leadFlow", "quality", "deals"],
  "/api/current-stages": "stages",
  "/api/stage-funnel": "stages",
  "/api/finance/summary": "finance",
  "/api/finance/accounts": "finance",
  "/api/finance/categories": "finance",
  "/api/finance/currencies": "finance",
  "/api/finance/projects": "finance",
  "/api/finance/subscriptions": "finance",
  "/api/finance/transactions": "finance",
  "/api/projects": "projects",
  "/api/pages": "pages",
  "/api/shares": "pages",
  "/api/providers": "diagnostics",
  "/api/reconcile": "diagnostics",
  "/api/settings": "settings",
  "/api/pipelines": "settings",
  "/api/sync": "settings",
  "/api/backfill": "settings",
  "/api/test-connection": "settings",
  "/api/admin/users": "ADMIN",
};

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) },
});

export async function createTestServer(seed: SeedUser[]) {
  const users = new Map<string, Row>();
  const sessions = new Map<string, Session>();
  /** Hashing is the real 600k-iteration PBKDF2, so seeds are hashed once. */
  for (const person of seed) {
    users.set(person.id, {
      id: person.id, email: normalizeEmail(person.email), name: person.name, role: person.role,
      passwordHash: await hashPassword(person.password),
      mustChangePassword: person.mustChangePassword === true,
      active: person.active !== false,
      permissions: normalizeMemberPermissions(person.permissions),
      lastLoginAt: null,
    });
  }

  const publicUser = (row: Row) => ({
    id: row.id, email: row.email, name: row.name, role: row.role,
    mustChangePassword: row.mustChangePassword, active: row.active, lastLoginAt: row.lastLoginAt,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    permissions: row.role === "ADMIN" ? [...PERMISSION_KEYS] : row.permissions,
  });

  const revokeAllFor = (userId: string) => {
    const now = new Date().toISOString();
    for (const session of sessions.values()) if (session.userId === userId) session.revokedAt ??= now;
  };

  async function resolve(request: Request) {
    const token = cookieValue(request);
    if (!token) return null;
    const session = sessions.get(await hashOpaqueToken(token));
    if (!session) return null;
    const row = session ? users.get(session.userId) ?? null : null;
    if (!sessionIsUsable(session, row) || !row) return null;
    return { row, session };
  }

  /** Mirrors requireSession → requireAdmin / assertContextPermission. */
  async function guard(request: Request, rule: PermissionKey | PermissionKey[] | "ADMIN" | "ANY") {
    try { assertSafeMutation(request); }
    catch { return json({ error: "So‘rov manbasi rad etildi", code: "CSRF_REJECTED" }, { status: 403 }); }
    const context = await resolve(request);
    if (!context) return json({ error: "Kirish talab qilinadi", code: "UNAUTHENTICATED" }, { status: 401 });
    if (context.row.mustChangePassword) return json({ error: "Avval vaqtinchalik parolni almashtiring", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 });
    const { role, permissions } = context.row;
    const allowed = rule === "ADMIN" ? role === "ADMIN"
      : rule === "ANY" ? PERMISSION_KEYS.some((key) => hasPermission(role, permissions, key))
      : Array.isArray(rule) ? rule.some((key) => hasPermission(role, permissions, key))
      : hasPermission(role, permissions, rule);
    if (!allowed) return json({ error: "Bu bo‘lim uchun ruxsat yo‘q", code: "FORBIDDEN" }, { status: 403 });
    return context;
  }

  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const request = new Request(`https://dashboard.test${input}`, {
      ...init,
      headers: { origin: "https://dashboard.test", ...(init.headers as Record<string, string> ?? {}) },
    });
    const path = new URL(request.url).pathname;

    if (path === "/api/auth/login") {
      try { assertSafeMutation(request); } catch { return json({ error: "So‘rov manbasi rad etildi" }, { status: 403 }); }
      const body = await request.json() as { email?: string; password?: string };
      const email = normalizeEmail(body.email);
      const row = [...users.values()].find((candidate) => candidate.email === email) ?? null;
      const authenticated = await authenticateCredentials(
        row ? { ...row, passwordHash: row.passwordHash, createdAt: "", updatedAt: "" } as never : null,
        body.password ?? "",
      ) as Row | null;
      // One status and one sentence for wrong password, unknown email and
      // deactivated account alike.
      if (!authenticated) return json({ error: "Email yoki parol noto‘g‘ri" }, { status: 401 });
      const token = createSessionToken();
      sessions.set(await hashOpaqueToken(token), {
        tokenHash: await hashOpaqueToken(token), userId: authenticated.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null,
      });
      authenticated.lastLoginAt = new Date().toISOString();
      return json({ user: publicUser(authenticated) }, { headers: { "set-cookie": sessionCookie(token) } });
    }

    if (path === "/api/auth/me") {
      const context = await resolve(request);
      if (!context) return json({ error: "Kirish talab qilinadi" }, { status: 401 });
      return json({ user: publicUser(context.row) });
    }

    if (path === "/api/auth/logout") {
      const token = cookieValue(request);
      if (token) {
        const session = sessions.get(await hashOpaqueToken(token));
        if (session) session.revokedAt ??= new Date().toISOString();
      }
      return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
    }

    if (path === "/api/auth/change-password") {
      try { assertSafeMutation(request); } catch { return json({ error: "So‘rov manbasi rad etildi" }, { status: 403 }); }
      const context = await resolve(request);
      if (!context) return json({ error: "Kirish talab qilinadi" }, { status: 401 });
      const body = await request.json() as { currentPassword?: string; newPassword?: string };
      const checked = validatePassword(body.newPassword);
      if (!checked.ok) return json({ error: checked.error }, { status: 400 });
      if (body.currentPassword === checked.value) return json({ error: "Yangi parol avvalgisidan farq qilishi kerak" }, { status: 400 });
      if (!await verifyPassword(body.currentPassword ?? "", context.row.passwordHash)) return json({ error: "Joriy parol noto‘g‘ri" }, { status: 400 });
      context.row.passwordHash = await hashPassword(checked.value);
      context.row.mustChangePassword = false;
      revokeAllFor(context.row.id);
      return json({ ok: true, loginRequired: true }, { headers: { "set-cookie": clearSessionCookie() } });
    }

    if (path === "/api/admin/users") {
      const context = await guard(request, "ADMIN");
      if (context instanceof Response) return context;
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") return json({ users: [...users.values()].map(publicUser) });
      const body = await request.json() as Record<string, unknown>;
      if (method === "POST") {
        const email = normalizeEmail(body.email);
        const role = body.role;
        if (!isAuthRole(role)) return json({ error: "Rol noto‘g‘ri" }, { status: 400 });
        const checked = validatePassword(body.temporaryPassword);
        if (!checked.ok) return json({ error: checked.error }, { status: 400 });
        if ([...users.values()].some((row) => row.email === email)) return json({ error: "Bu email allaqachon mavjud" }, { status: 409 });
        const id = `u-${users.size + 1}`;
        users.set(id, {
          id, email, name: String(body.name ?? "").trim(), role,
          passwordHash: await hashPassword(checked.value),
          // The API forces this on every create, whatever the payload says.
          mustChangePassword: true, active: true,
          permissions: role === "MEMBER" ? normalizeMemberPermissions(body.permissions) : [],
          lastLoginAt: null,
        });
        return json({ id }, { status: 201 });
      }
      // PATCH
      const target = users.get(String(body.id ?? ""));
      if (!target) return json({ error: "Foydalanuvchi topilmadi" }, { status: 404 });
      const role = body.role === undefined ? target.role : body.role;
      const active = body.active === undefined ? target.active : body.active;
      if (!isAuthRole(role) || typeof active !== "boolean") return json({ error: "Rol yoki holat noto‘g‘ri" }, { status: 400 });
      if (target.id === context.row.id && (!active || role !== "ADMIN")) {
        return json({ error: "Administrator o‘z rolini olib tashlay yoki o‘zini o‘chira olmaydi" }, { status: 400 });
      }
      const otherActiveAdmins = [...users.values()].filter((row) => row.role === "ADMIN" && row.active && row.id !== target.id).length;
      if (target.role === "ADMIN" && target.active && (!active || role !== "ADMIN") && otherActiveAdmins === 0) {
        return json({ error: "Oxirgi faol administratorni o‘chirib bo‘lmaydi" }, { status: 400 });
      }
      if (body.temporaryPassword !== undefined) {
        const checked = validatePassword(body.temporaryPassword);
        if (!checked.ok) return json({ error: checked.error }, { status: 400 });
        target.passwordHash = await hashPassword(checked.value);
        target.mustChangePassword = true;
        revokeAllFor(target.id);
      } else if (body.mustChangePassword !== undefined) {
        target.mustChangePassword = body.mustChangePassword === true;
      }
      if (body.name !== undefined) target.name = String(body.name).trim();
      if (body.email !== undefined) target.email = normalizeEmail(body.email);
      target.role = role;
      if (!active && target.active) revokeAllFor(target.id);
      target.active = active;
      // A MEMBER payload can never smuggle in `users`; storage strips it.
      if (body.permissions !== undefined) target.permissions = role === "MEMBER" ? normalizeMemberPermissions(body.permissions) : [];
      if (role === "ADMIN") target.permissions = [];
      return json({ ok: true });
    }

    const rule = ROUTE_PERMISSIONS[path];
    if (rule === undefined) return json({ error: "Not found" }, { status: 404 });
    const context = await guard(request, rule);
    if (context instanceof Response) return context;
    return json({ ok: true, path });
  }) as unknown as typeof fetch;

  /** A browser-like cookie jar, so sessions behave as they do in the app. */
  function client() {
    let cookie: string | null = null;
    return (async (input: string, init: RequestInit = {}) => {
      const headers = { ...(init.headers as Record<string, string> ?? {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetchImpl(input, { ...init, headers } as RequestInit);
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const [pair] = setCookie.split(";");
        cookie = /Max-Age=0/.test(setCookie) ? null : pair;
      }
      return response;
    }) as unknown as typeof fetch;
  }

  return { client, users, sessions, publicUser };
}
