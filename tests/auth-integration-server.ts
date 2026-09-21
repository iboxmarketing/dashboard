import { authenticateCredentials } from "../lib/auth/authenticate";
import { hashPassword, validatePassword, verifyPassword } from "../lib/auth/password";
import { PERMISSION_KEYS, hasPermission, normalizeMemberPermissions, type PermissionKey } from "../lib/auth/permissions";
import { assertSafeMutation, clearSessionCookie, cookieValue, hashOpaqueToken, createSessionToken, sessionIsUsable } from "../lib/auth/security";
import { handleLogin } from "../lib/auth/login";
import { handleLogout } from "../lib/auth/logout";
import type { ThrottleRow, ThrottleStore } from "../lib/auth/throttle";
import type { DashboardRecord } from "../lib/dashboard-record";
import { bootstrapPayload, buildSalesSection, filterPermissionError, parseSalesQuery, type SalesSection } from "../lib/sales-sections";
import type { DashboardSettings } from "../lib/types";
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
  "/api/sales/dashboard": "dashboard",
  "/api/sales/managers": "managers",
  "/api/sales/manager": "managers",
  "/api/sales/lead-flow": "leadFlow",
  "/api/sales/quality": "quality",
  "/api/sales/deals": "deals",
  "/api/diagnostics": "diagnostics",
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

/** In-memory ThrottleStore with the same bounded-key semantics as D1. */
export function memoryThrottleStore() {
  const rows = new Map<string, ThrottleRow>();
  const store: ThrottleStore = {
    get: async (key) => rows.get(key) ?? null,
    put: async (key, row) => { rows.set(key, { ...row }); },
    delete: async (key) => { rows.delete(key); },
    sweep: async (before, now, limit) => {
      let removed = 0;
      for (const [key, row] of rows) {
        if (removed >= limit) break;
        if (row.updatedAt < before && (!row.blockedUntil || row.blockedUntil < now)) { rows.delete(key); removed += 1; }
      }
    },
  };
  return { store, rows };
}

export type SalesFixture = { records: DashboardRecord[]; settings: DashboardSettings };

const SALES_PATHS: Record<string, SalesSection> = {
  "/api/sales/dashboard": "dashboard", "/api/sales/managers": "managers", "/api/sales/manager": "manager",
  "/api/sales/lead-flow": "leadFlow", "/api/sales/quality": "quality", "/api/sales/deals": "deals",
};

export async function createTestServer(seed: SeedUser[], sales?: SalesFixture) {
  const users = new Map<string, Row>();
  const sessions = new Map<string, Session>();
  const { store: throttle, rows: throttleRows } = memoryThrottleStore();
  const authenticateCalls = { count: 0 };
  const failRevocation = { on: false };
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
      // The real handler, including the bounded throttle, over in-memory rows.
      return handleLogin(request, {
        throttle,
        findUserByEmail: async (email) => {
          const row = [...users.values()].find((candidate) => candidate.email === normalizeEmail(email));
          return row ? { ...row, createdAt: "", updatedAt: "" } : null;
        },
        authenticate: async (user, password) => {
          authenticateCalls.count += 1;
          return authenticateCredentials(user, password);
        },
        createSession: async (userId) => {
          const token = createSessionToken();
          const tokenHash = await hashOpaqueToken(token);
          sessions.set(tokenHash, { tokenHash, userId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null });
          return { token };
        },
        completeLogin: async (userId) => { const row = users.get(userId); if (row) row.lastLoginAt = new Date().toISOString(); },
        resolveSession: async (token) => {
          const session = sessions.get(await hashOpaqueToken(token));
          const row = session ? users.get(session.userId) : null;
          if (!session || !row) return null;
          return { user: publicUser(row), session: { id: "s", userId: row.id, createdAt: "", expiresAt: session.expiresAt, lastSeenAt: "", revokedAt: null } };
        },
      });
    }

    if (path === "/api/auth/me") {
      const context = await resolve(request);
      if (!context) return json({ error: "Kirish talab qilinadi" }, { status: 401 });
      return json({ user: publicUser(context.row) });
    }

    if (path === "/api/auth/logout") {
      return handleLogout(request, async (token) => {
        if (failRevocation.on) throw new Error("D1_ERROR: write failed");
        const session = sessions.get(await hashOpaqueToken(token));
        if (session) session.revokedAt ??= new Date().toISOString();
      });
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
    const can = (key: PermissionKey) => hasPermission(context.row.role, context.row.permissions, key);

    // The real section builders and filter rules, over fixture records — the
    // same steps lib/sales-http.ts takes after its D1 read.
    const section = SALES_PATHS[path];
    if (section && sales) {
      const parsed = parseSalesQuery(new URL(request.url).searchParams);
      if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
      const refused = filterPermissionError(parsed.query, can);
      if (refused) return json({ error: refused, code: "FILTER_FORBIDDEN" }, { status: 403 });
      return json(buildSalesSection(section, sales.records, parsed.query, { can, settings: sales.settings, dataAsOf: "2026-09-20T00:00:00.000Z" }));
    }
    if (path === "/api/bootstrap" && sales) {
      return json(bootstrapPayload(can("settings"), () => ({
        configured: true, domain: "ibox.bitrix24.test", settings: sales.settings,
        sync: { status: "success", lastSyncAt: "2026-09-20T00:00:00.000Z" }, providers: [{ key: "p" }], records: sales.records,
      })));
    }
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

  return { client, users, sessions, publicUser, throttleRows, authenticateCalls, failRevocation };
}
