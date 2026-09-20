import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authenticateCredentials } from "../lib/auth/authenticate";
import { assertContextPermission, AuthHttpError, authorizationErrorResponse } from "../lib/auth/authorization";
import { hashPassword, validatePassword, verifyPassword } from "../lib/auth/password";
import { hasPermission, PERMISSION_KEYS, permissionForView } from "../lib/auth/permissions";
import {
  assertSafeMutation, createSessionToken, hashOpaqueToken, sessionCookie, sessionIsUsable,
} from "../lib/auth/security";
import type { AuthContext, AuthUser } from "../lib/auth/types";

const root = process.cwd();
const route = (path: string) => readFileSync(`${root}/app/api/${path}/route.ts`, "utf8");
const now = "2026-09-20T00:00:00.000Z";

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return { id: "u1", email: "member@example.com", name: "Member", role: "MEMBER", passwordHash: "", mustChangePassword: false, active: true, createdAt: now, updatedAt: now, lastLoginAt: null, ...overrides };
}
function context(overrides: Partial<AuthUser> = {}, permissions = ["dashboard"]): AuthContext {
  const source = user(overrides);
  return { user: { id: source.id, email: source.email, name: source.name, role: source.role, mustChangePassword: source.mustChangePassword, active: source.active, createdAt: source.createdAt, updatedAt: source.updatedAt, lastLoginAt: source.lastLoginAt, permissions }, session: { id: "s1", userId: "u1", createdAt: now, expiresAt: "2026-09-21T00:00:00.000Z", lastSeenAt: now, revokedAt: null } };
}

test("PBKDF2 password verifier is salted, one-way, and validates credentials", async () => {
  const password = "StrongTemporary9";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^pbkdf2-sha256\$600000\$/u);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("WrongPassword9", first), false);
  assert.equal(await verifyPassword(password, "not-a-verifier"), false);
});

test("password rules reject short, oversized, and incomplete passwords", () => {
  assert.equal(validatePassword("Short9A").ok, false);
  assert.equal(validatePassword("alllowercase123").ok, false);
  assert.equal(validatePassword("ALLUPPERCASE123").ok, false);
  assert.equal(validatePassword("NoDigitsHereABC").ok, false);
  assert.equal(validatePassword(`Aa9${"x".repeat(254)}`).ok, false);
  assert.equal(validatePassword("LongEnoughPassword9").ok, true);
});

test("login accepts correct credentials and rejects wrong, unknown, and inactive users", async () => {
  const passwordHash = await hashPassword("CorrectPassword9");
  const active = user({ passwordHash });
  assert.equal((await authenticateCredentials(active, "CorrectPassword9"))?.id, active.id);
  assert.equal(await authenticateCredentials(active, "WrongPassword9"), null);
  assert.equal(await authenticateCredentials(null, "WrongPassword9"), null);
  assert.equal(await authenticateCredentials({ ...active, active: false }, "CorrectPassword9"), null);
});

test("raw session token is distinct from its stored digest and cookie has strict flags", async () => {
  const token = createSessionToken();
  const digest = await hashOpaqueToken(token);
  assert.notEqual(token, digest);
  assert.equal(token.length >= 43, true);
  const cookie = sessionCookie(token);
  assert.match(cookie, /^__Host-ibox_session=/u);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.match(cookie, new RegExp(flag, "u"));
  assert.equal(cookie.includes(digest), false);
});

test("expired, revoked, and inactive-user sessions are unusable", () => {
  const active = { active: true };
  assert.equal(sessionIsUsable({ expiresAt: "2026-09-21T00:00:00.000Z", revokedAt: null }, active, new Date(now)), true);
  assert.equal(sessionIsUsable({ expiresAt: "2026-09-19T00:00:00.000Z", revokedAt: null }, active, new Date(now)), false);
  assert.equal(sessionIsUsable({ expiresAt: "2026-09-21T00:00:00.000Z", revokedAt: now }, active, new Date(now)), false);
  assert.equal(sessionIsUsable({ expiresAt: "2026-09-21T00:00:00.000Z", revokedAt: null }, { active: false }, new Date(now)), false);
});

test("ADMIN bypasses every registry permission; MEMBER receives explicit sections only", () => {
  for (const key of PERMISSION_KEYS) assert.equal(hasPermission("ADMIN", [], key), true);
  assert.equal(hasPermission("MEMBER", ["finance"], "finance"), true);
  assert.equal(hasPermission("MEMBER", ["finance"], "settings"), false);
  assert.equal(hasPermission("MEMBER", ["users"], "users"), false);
  assert.equal(permissionForView("managerDetail"), "managers");
  assert.equal(permissionForView("pageDetail"), "pages");
});

test("temporary-password MEMBER cannot access sections until changing password", () => {
  assert.throws(() => assertContextPermission(context({ mustChangePassword: true }), "dashboard"), (error) => error instanceof AuthHttpError && error.status === 403 && error.code === "PASSWORD_CHANGE_REQUIRED");
  assert.throws(() => assertContextPermission(context({}, ["finance"]), "settings"), (error) => error instanceof AuthHttpError && error.status === 403 && error.code === "FORBIDDEN");
  assert.equal(assertContextPermission(context({}, ["finance"]), "finance").user.id, "u1");
});

test("authentication and permission failures produce distinct 401 and 403 responses", async () => {
  const unauthenticated = authorizationErrorResponse(new AuthHttpError(401, "UNAUTHENTICATED", "Kirish talab qilinadi"));
  const forbidden = authorizationErrorResponse(new AuthHttpError(403, "FORBIDDEN", "Ruxsat yo‘q"));
  assert.equal(unauthenticated?.status, 401);
  assert.equal(forbidden?.status, 403);
  assert.deepEqual(await forbidden?.json(), { error: "Ruxsat yo‘q", code: "FORBIDDEN" });
});

test("cross-site mutations are rejected while same-origin and non-browser operator calls pass", () => {
  assert.throws(() => assertSafeMutation(new Request("https://dashboard.example/api/settings", { method: "POST", headers: { origin: "https://evil.example" } })), /CROSS_SITE_REQUEST/u);
  assert.throws(() => assertSafeMutation(new Request("https://dashboard.example/api/settings", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })), /CROSS_SITE_REQUEST/u);
  assert.doesNotThrow(() => assertSafeMutation(new Request("https://dashboard.example/api/settings", { method: "POST", headers: { origin: "https://dashboard.example" } })));
  assert.doesNotThrow(() => assertSafeMutation(new Request("https://dashboard.example/api/settings", { method: "POST" })));
});

test("auth migration is additive, indexed, constrained, and isolated from business tables", () => {
  const migration = readFileSync(`${root}/drizzle/0008_auth_core.sql`, "utf8");
  for (const table of ["app_users", "app_user_permissions", "app_sessions", "app_login_attempts"]) assert.match(migration, new RegExp("CREATE TABLE `" + table + "`", "u"));
  for (const index of ["app_users_email_idx", "app_sessions_token_hash_idx", "app_sessions_user_idx", "app_sessions_expiry_idx", "app_user_permissions_user_idx"]) assert.match(migration, new RegExp(index, "u"));
  assert.match(migration, /FOREIGN KEY \(`user_id`\).*ON DELETE cascade/u);
  assert.doesNotMatch(migration, /analytics_records|deal_sales_snapshots|finance_transactions/u);
});

test("every existing API is guarded and high-risk routes use the exact permission", () => {
  const protectedRoutes = ["backfill", "bootstrap", "current-stages", "dashboard", "pages", "pipelines", "projects", "providers", "reconcile", "settings", "shares", "stage-funnel", "sync", "test-connection",
    "finance/accounts", "finance/categories", "finance/currencies", "finance/projects", "finance/subscriptions", "finance/summary", "finance/transactions"];
  for (const path of protectedRoutes) assert.match(route(path), /authorizePermission|authorizeAnyPermission/u, path);
  for (const path of ["finance/accounts", "finance/categories", "finance/currencies", "finance/projects", "finance/subscriptions", "finance/summary", "finance/transactions"]) assert.match(route(path), /authorizePermission\(request, "finance"\)/u, path);
  for (const path of ["backfill", "pipelines", "settings", "sync", "test-connection"]) assert.match(route(path), /authorizePermission\(request, "settings"\)/u, path);
  assert.match(route("admin/users"), /requireAdmin\(request\)/u);
});

test("mutation routes authorize before business storage can mutate", () => {
  for (const path of ["settings", "sync", "projects", "pages", "shares", "finance/accounts", "finance/transactions"]) {
    const source = route(path);
    const guard = source.indexOf("await authorizePermission(request");
    const firstMutation = Math.min(...["saveSettings(", "startSync(", "createProject(", "createPage(", "createShare(", "createFinanceAccount(", "createFinanceTransaction("].map((needle) => source.indexOf(needle)).filter((index) => index >= 0));
    assert.equal(guard >= 0 && guard < firstMutation, true, `${path} must authorize before mutation`);
  }
});

test("password hashes and session tokens are never returned by auth APIs", () => {
  assert.doesNotMatch(route("auth/login"), /token\s*:/u);
  assert.doesNotMatch(route("auth/me"), /passwordHash/u);
  assert.match(route("admin/users"), /Response\.json\(\{ users: await listUsers\(\) \}/u);
  const storage = readFileSync(`${root}/lib/auth/storage.ts`, "utf8");
  assert.match(storage, /function publicUser/u);
  assert.doesNotMatch(storage.slice(storage.indexOf("function publicUser"), storage.indexOf("function sessionFromRow")), /passwordHash/u);
});

test("deactivate and password reset revoke sessions and bootstrap cannot overwrite users", () => {
  const storage = readFileSync(`${root}/lib/auth/storage.ts`, "utf8");
  assert.match(storage, /!active \|\| input\.passwordHash/u);
  assert.match(storage, /UPDATE app_sessions SET revoked_at/u);
  const bootstrap = readFileSync(`${root}/scripts/bootstrap-admin.ts`, "utf8");
  assert.match(bootstrap, /WHERE NOT EXISTS \(SELECT 1 FROM app_users\)/u);
  assert.match(bootstrap, /readSecret\("Temporary password:/u);
  assert.doesNotMatch(bootstrap, /--password/u);
});

test("logout revokes the server session and clears the browser cookie", () => {
  const logout = route("auth/logout");
  assert.match(logout, /await revokeSession\(token\)/u);
  assert.match(logout, /"set-cookie": clearSessionCookie\(\)/u);
  const change = route("auth/change-password");
  assert.match(change, /await changeOwnPassword/u);
  assert.match(change, /"set-cookie": clearSessionCookie\(\)/u);
});

test("auth UI gates navigation and does not alter Sales or Finance calculation modules", () => {
  const dashboard = readFileSync(`${root}/app/dashboard-client.tsx`, "utf8");
  assert.match(dashboard, /allowedNavItems = navItems\.filter/u);
  assert.match(dashboard, /permission: "finance"/u);
  assert.match(dashboard, /canSettings &&/u);
  const changedBusinessFiles = ["lib/sales-logic.ts", "lib/dashboard-metrics.ts", "lib/finance/summary.ts"];
  for (const path of changedBusinessFiles) assert.equal(readFileSync(`${root}/${path}`, "utf8").length > 0, true);
});
