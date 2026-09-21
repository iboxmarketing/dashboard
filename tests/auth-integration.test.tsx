import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { ROUTE_PERMISSIONS, createTestServer, type SeedUser } from "./auth-integration-server";
import { AuthError, createHttpAuthAdapter } from "../lib/auth-adapter";
import {
  ASSIGNABLE_PERMISSIONS, NAV_ENTRIES, allowedNavEntries, canAccess, canAccessView, firstAllowedView, hasAnySection,
} from "../lib/auth-permissions";
import { PERMISSIONS } from "../lib/auth-types";
import { SALES_SECTION_PERMISSION, type SalesSection } from "../lib/sales-sections";
import { PERMISSION_KEYS, hasPermission, normalizeMemberPermissions, permissionForView, type PermissionKey } from "../lib/auth/permissions";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const routeSource = (path: string) => read(`app/api/${path}/route.ts`);
const client = read("app/dashboard-client.tsx");

const ADMIN_PASSWORD = "AdminPassword1";
const MEMBER_PASSWORD = "MemberPassword1";

const SEED: SeedUser[] = [
  { id: "u-admin", email: "admin@ibox.uz", name: "Admin Person", role: "ADMIN", password: ADMIN_PASSWORD, permissions: [] },
  { id: "u-fin", email: "fin@ibox.uz", name: "Finance Person", role: "MEMBER", password: MEMBER_PASSWORD, permissions: ["finance"] },
  { id: "u-sales", email: "sales@ibox.uz", name: "Sales Person", role: "MEMBER", password: MEMBER_PASSWORD, permissions: ["dashboard", "managers", "deals"] },
  { id: "u-none", email: "none@ibox.uz", name: "Waiting Person", role: "MEMBER", password: MEMBER_PASSWORD, permissions: [] },
  { id: "u-temp", email: "temp@ibox.uz", name: "New Person", role: "MEMBER", password: MEMBER_PASSWORD, permissions: ["dashboard"], mustChangePassword: true },
  { id: "u-off", email: "off@ibox.uz", name: "Gone Person", role: "MEMBER", password: MEMBER_PASSWORD, permissions: ["dashboard"], active: false },
];

/** One server per suite: the real PBKDF2 at 600k iterations is not cheap. */
let server: Awaited<ReturnType<typeof createTestServer>>;
const boot = (async () => { server = await createTestServer(SEED); })();
const session = async () => { await boot; return createHttpAuthAdapter(server.client()); };
const signedIn = async (email: string, password = MEMBER_PASSWORD) => {
  const adapter = await session();
  await adapter.login({ email, password });
  return adapter;
};
/** Calls a protected route directly, the way a curl or a devtools fetch would. */
const callApi = async (fetchImpl: typeof fetch, path: string, init?: RequestInit) =>
  (fetchImpl as unknown as (input: string, init?: RequestInit) => Promise<Response>)(path, init);

/* ================= 1. login lands on an allowed view ================= */

test("1. a successful login resolves to the user's first allowed view", async () => {
  const adapter = await signedIn("fin@ibox.uz");
  const user = await adapter.me();
  assert.ok(user);
  assert.equal(user.email, "fin@ibox.uz");
  assert.equal(user.role, "MEMBER");
  assert.deepEqual(user.permissions, ["finance"]);
  // The landing view is derived, never assumed to be "dashboard".
  assert.equal(firstAllowedView(user), "finance");
  assert.equal(canAccessView(user, "dashboard"), false);
  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  assert.equal(firstAllowedView(await admin.me()), "dashboard");
});

/* ============ 2. a finance-only MEMBER: nav, and both API sides ============ */

test("2. a finance-only MEMBER sees Finance, no Sales, and the APIs agree", async () => {
  const adapter = await signedIn("fin@ibox.uz");
  const user = await adapter.me();
  assert.ok(user);

  // Navigation
  assert.deepEqual(allowedNavEntries(user).map((entry) => entry.view), ["finance"]);
  assert.equal(canAccess(user, "finance"), true);
  for (const hidden of ["dashboard", "managers", "leadFlow", "quality", "stages", "deals", "settings", "users"] as const) {
    assert.equal(canAccess(user, hidden), false, `${hidden} must be hidden`);
  }

  // The API, called directly rather than through the UI
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "fin@ibox.uz", password: MEMBER_PASSWORD }) });
  for (const allowed of ["/api/finance/summary", "/api/finance/transactions", "/api/finance/accounts", "/api/bootstrap"]) {
    assert.equal((await callApi(fetchImpl, allowed)).status, 200, `${allowed} must be allowed`);
  }
  for (const denied of ["/api/sales/dashboard", "/api/sales/managers", "/api/sales/deals", "/api/diagnostics", "/api/current-stages", "/api/stage-funnel", "/api/settings", "/api/sync", "/api/projects", "/api/pages", "/api/admin/users"]) {
    const response = await callApi(fetchImpl, denied, denied === "/api/settings" || denied === "/api/sync" ? { method: "POST", body: "{}" } : undefined);
    assert.equal(response.status, 403, `${denied} must be forbidden`);
  }
});

/* ============ 3. a MEMBER without finance is refused by the API ============ */

test("3. a MEMBER without finance gets 403 from the Finance API directly", async () => {
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "sales@ibox.uz", password: MEMBER_PASSWORD }) });
  for (const path of ["/api/finance/summary", "/api/finance/accounts", "/api/finance/transactions", "/api/finance/categories", "/api/finance/projects", "/api/finance/subscriptions", "/api/finance/currencies"]) {
    const response = await callApi(fetchImpl, path);
    assert.equal(response.status, 403, `${path} must be forbidden`);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "FORBIDDEN");
  }
  // Hiding the nav item is not what does this; the API refuses on its own.
  assert.equal((await callApi(fetchImpl, "/api/sales/dashboard")).status, 200);
});

/* ================= 4. ADMIN reaches everything ================= */

test("4. ADMIN sees every section and every protected API accepts them", async () => {
  const adapter = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  const user = await adapter.me();
  assert.ok(user);
  assert.equal(allowedNavEntries(user).length, PERMISSIONS.length);
  for (const permission of PERMISSIONS) assert.equal(canAccess(user, permission), true);

  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@ibox.uz", password: ADMIN_PASSWORD }) });
  for (const path of Object.keys(ROUTE_PERMISSIONS)) {
    const response = await callApi(fetchImpl, path, ["/api/settings", "/api/sync", "/api/providers", "/api/test-connection"].includes(path) ? { method: "POST", body: "{}" } : undefined);
    assert.equal(response.status, 200, `${path} must accept an ADMIN`);
  }
});

/* ================= 5. an empty permission list ================= */

test("5. a MEMBER with no permissions gets the no-section state, not an empty shell", async () => {
  const adapter = await signedIn("none@ibox.uz");
  const user = await adapter.me();
  assert.ok(user);
  assert.equal(hasAnySection(user), false);
  assert.equal(firstAllowedView(user), null);
  assert.match(read("app/auth/auth-primitives.tsx"), /Sizga hali bo‘lim biriktirilmagan/);
  assert.match(read("app/auth/auth-shell.tsx"), /if \(!hasAnySection\(state\.user\)\)/);
  // Even /api/bootstrap, the least privileged route, refuses them.
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "none@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal((await callApi(fetchImpl, "/api/bootstrap")).status, 403);
});

/* ================= 6. must-change-password blocks everything ================= */

test("6. a temporary password blocks the dashboard until it is changed", async () => {
  const fetchImpl = server.client();
  const login = await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "temp@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal(login.status, 200);
  const { user } = await login.json() as { user: { mustChangePassword: boolean } };
  assert.equal(user.mustChangePassword, true);

  // Server side: every permissioned route refuses, with its own code.
  for (const path of ["/api/bootstrap", "/api/sales/dashboard"]) {
    const response = await callApi(fetchImpl, path);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code?: string }).code, "PASSWORD_CHANGE_REQUIRED");
  }
  // Client side: the gate returns the screen before it ever reaches `children`.
  const shell = read("app/auth/auth-shell.tsx");
  assert.ok(shell.indexOf('state.status === "mustChangePassword"') < shell.indexOf("children({"));

  // A change that meets the policy unblocks the account.
  const changed = await callApi(fetchImpl, "/api/auth/change-password", {
    method: "POST", body: JSON.stringify({ currentPassword: MEMBER_PASSWORD, newPassword: "BrandNewPass1" }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json() as { loginRequired?: boolean }).loginRequired, true);

  const after = await signedIn("temp@ibox.uz", "BrandNewPass1");
  const user2 = await after.me();
  assert.equal(user2?.mustChangePassword, false);
  assert.equal((await callApi(server.client(), "/api/auth/me")).status, 401);
});

test("6b. the server, not the form, enforces the current password and the policy", async () => {
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "sales@ibox.uz", password: MEMBER_PASSWORD }) });
  const reject = async (body: Record<string, string>) => {
    const response = await callApi(fetchImpl, "/api/auth/change-password", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    return (await response.json() as { error: string }).error;
  };
  assert.match(await reject({ currentPassword: "WrongPassword1", newPassword: "BrandNewPass1" }), /Joriy parol noto‘g‘ri/);
  assert.match(await reject({ currentPassword: MEMBER_PASSWORD, newPassword: "Short1a" }), /12 ta belgi/);
  assert.match(await reject({ currentPassword: MEMBER_PASSWORD, newPassword: "nouppercaseordigit" }), /katta harf/);
  assert.match(await reject({ currentPassword: MEMBER_PASSWORD, newPassword: MEMBER_PASSWORD }), /farq qilishi kerak/);
  // The UI does not overwrite these with the login sentence.
  const adapter = createHttpAuthAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.changePassword({ currentPassword: "WrongPassword1", newPassword: "BrandNewPass1" }),
    (error: unknown) => error instanceof AuthError && /Joriy parol/.test(error.message),
  );
});

/* ================= 7. logout ================= */

test("7. logout makes the session unusable straight away", async () => {
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "sales@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal((await callApi(fetchImpl, "/api/auth/me")).status, 200);
  assert.equal((await callApi(fetchImpl, "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await callApi(fetchImpl, "/api/auth/me")).status, 401);
  assert.equal((await callApi(fetchImpl, "/api/sales/dashboard")).status, 401);
  // The adapter reads that 401 as "signed out", not as an error to display.
  assert.equal(await createHttpAuthAdapter(fetchImpl).me(), null);
});

/* ================= 8. an admin password reset revokes sessions ================= */

test("8. resetting a password revokes the target's open sessions", async () => {
  const victim = server.client();
  await callApi(victim, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "sales@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal((await callApi(victim, "/api/auth/me")).status, 200);

  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  await admin.updateUser({ id: "u-sales", temporaryPassword: "ResetPassword1" });

  assert.equal((await callApi(victim, "/api/auth/me")).status, 401, "the old session must be dead");
  // And the reset puts them back on the temporary-password gate.
  const back = await signedIn("sales@ibox.uz", "ResetPassword1");
  assert.equal((await back.me())?.mustChangePassword, true);
});

/* ================= 9. deactivation ================= */

test("9. deactivating a user kills their session and their next login", async () => {
  const victim = server.client();
  await callApi(victim, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "fin@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal((await callApi(victim, "/api/finance/summary")).status, 200);

  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  await admin.updateUser({ id: "u-fin", active: false });

  assert.equal((await callApi(victim, "/api/finance/summary")).status, 401);
  assert.equal((await callApi(victim, "/api/auth/me")).status, 401);
  // A deactivated account cannot log back in, and the refusal is the generic one.
  const login = await callApi(server.client(), "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "fin@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal(login.status, 401);
  assert.match((await login.json() as { error: string }).error, /Email yoki parol noto‘g‘ri/);
  // Deactivation also removes every section client-side, whatever is stored.
  assert.equal(canAccess({ role: "MEMBER", permissions: ["finance"], active: false }, "finance"), false);
  assert.equal(canAccess({ role: "ADMIN", permissions: [], active: false }, "finance"), false);

  await admin.updateUser({ id: "u-fin", active: true });
  assert.equal((await (await signedIn("fin@ibox.uz")).me())?.active, true);
});

/* ================= 10. promotion ================= */

test("10. promoting to ADMIN grants access through the role, not a stored list", async () => {
  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  await admin.updateUser({ id: "u-fin", role: "ADMIN" });

  const promoted = await signedIn("fin@ibox.uz");
  const user = await promoted.me();
  assert.ok(user);
  assert.equal(user.role, "ADMIN");
  assert.equal(allowedNavEntries(user).length, PERMISSIONS.length);
  // The row's own permission list is empty; the role is what grants access.
  assert.deepEqual(server.users.get("u-fin")?.permissions, []);
  assert.equal(hasPermission("ADMIN", [], "users"), true);

  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "fin@ibox.uz", password: MEMBER_PASSWORD }) });
  assert.equal((await callApi(fetchImpl, "/api/admin/users")).status, 200);

  await admin.updateUser({ id: "u-fin", role: "MEMBER", permissions: ["finance"] });
  assert.equal((await callApi(server.client(), "/api/admin/users")).status, 401);
});

test("10b. a MEMBER cannot reach the admin API even with `users` in the payload", async () => {
  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  // The escalation attempt: grant a MEMBER the one administrative key.
  await admin.updateUser({ id: "u-sales", permissions: ["dashboard", "users"] as PermissionKey[] });
  assert.deepEqual(server.users.get("u-sales")?.permissions, ["dashboard"], "storage strips `users` from a MEMBER");

  // Even if a row somehow held it, the rule refuses it outright.
  assert.equal(hasPermission("MEMBER", ["users"], "users"), false);
  assert.equal(canAccess({ role: "MEMBER", permissions: ["users"], active: true }, "users"), false);
  assert.deepEqual(normalizeMemberPermissions(["dashboard", "users"]), ["dashboard"]);
  // And the key is never offered in the editor.
  assert.equal(ASSIGNABLE_PERMISSIONS.includes("users"), false);

  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "sales@ibox.uz", password: "ResetPassword1" }) });
  // (that account is on a temporary password after test 8, so it is refused twice over)
  const response = await callApi(fetchImpl, "/api/admin/users");
  assert.equal(response.status, 403);
});

test("10c. an admin cannot remove the last active administrator, or demote themselves", async () => {
  const admin = await signedIn("admin@ibox.uz", ADMIN_PASSWORD);
  await assert.rejects(() => admin.updateUser({ id: "u-admin", role: "MEMBER" }),
    (error: unknown) => error instanceof AuthError && /o‘z rolini olib tashlay/.test(error.message));
  await assert.rejects(() => admin.updateUser({ id: "u-admin", active: false }),
    (error: unknown) => error instanceof AuthError && /o‘z rolini olib tashlay|o‘zini o‘chira/.test(error.message));
  assert.equal(server.users.get("u-admin")?.active, true);
  assert.equal(server.users.get("u-admin")?.role, "ADMIN");
  // The drawer refuses the same two before they are ever sent.
  const drawer = read("app/auth/user-drawer.tsx");
  assert.match(drawer, /if \(isSelf && !active\) return setError/);
  assert.match(drawer, /if \(isSelf && role !== "ADMIN" && user!\.role === "ADMIN"\) return setError/);
  // The last-admin rule is a database invariant, not a JS count-then-update:
  // the route only maps the trigger's refusal (proven against real SQLite in
  // tests/auth-hardening.test.ts).
  assert.match(routeSource("admin/users"), /LAST_ACTIVE_ADMIN/);
  assert.doesNotMatch(routeSource("admin/users"), /countActiveAdmins/);
  assert.doesNotMatch(read("lib/auth/storage.ts"), /countActiveAdmins/);
  assert.match(read("drizzle/0009_auth_admin_invariant.sql"), /RAISE\(ABORT, 'LAST_ACTIVE_ADMIN'\)/);
});

/* ================= 11. secrets never leave the server ================= */

test("11. no password hash, session token or token hash ever reaches a payload", async () => {
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@ibox.uz", password: ADMIN_PASSWORD }) });
  const bodies = await Promise.all(["/api/auth/me", "/api/admin/users"].map(async (path) => (await callApi(fetchImpl, path)).text()));
  for (const body of bodies) {
    for (const secret of ["passwordHash", "password_hash", "tokenHash", "token_hash", "pbkdf2-sha256", ADMIN_PASSWORD, MEMBER_PASSWORD]) {
      assert.equal(body.includes(secret), false, `${secret} leaked into a payload`);
    }
  }
  // The shape the server actually builds omits it by construction.
  const storage = read("lib/auth/storage.ts");
  assert.match(storage, /function publicUser/);
  assert.doesNotMatch(storage.slice(storage.indexOf("function publicUser"), storage.indexOf("function sessionFromRow")), /passwordHash/);
  assert.match(read("lib/auth/types.ts"), /Omit<AuthUser, "passwordHash">/);
  // `AuthContext.session` is the session minus its token hash.
  assert.match(read("lib/auth/types.ts"), /session: Omit<AuthSession, "tokenHash">/);
  // The raw token exists only in the cookie, and the cookie is HttpOnly.
  assert.match(read("lib/auth/security.ts"), /HttpOnly; Secure; SameSite=Lax/);
  for (const source of ["lib/auth-adapter.ts", "app/auth/auth-shell.tsx", "app/auth/users-screen.tsx", "app/dashboard-client.tsx"]) {
    assert.doesNotMatch(read(source), /document\.cookie/, `${source} must not read the session cookie`);
  }
});

/* ============ 12. the business formulas are untouched ============ */

test("12. the auth integration changes no analytics, seller or finance calculation", () => {
  // Committed and uncommitted changes since the Finance base, so this guard
  // holds before a commit as well as after it.
  const changed = [...new Set([
    ...execFileSync("git", ["diff", "--name-only", "cd1d418"], { cwd: root, encoding: "utf8" }).split("\n"),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n"),
  ].filter(Boolean))];
  assert.ok(changed.length > 0, "the branch must actually contain the auth work");

  // Every module that decides a Lead, an SQL, a Not Relevant, a Sales Lost, a
  // Sale, Revenue, seller attribution or a Finance total.
  const protectedModules = [
    "lib/analytics.ts", "lib/sales-logic.ts", "lib/dashboard-metrics.ts", "lib/dashboard-cards.ts",
    "lib/lead-flow-analytics.ts", "lib/quality-analytics.ts", "lib/manager-profile.ts",
    "lib/stage-control-analytics.ts", "lib/trend-series.ts", "lib/period.ts", "lib/record-filters.ts",
    "lib/sales-snapshots.ts", "lib/stable-seller-field.ts", "lib/dashboard-record.ts", "lib/sla.ts", "lib/duplicates.ts",
    "lib/finance-metrics.ts", "lib/finance-money.ts", "lib/finance-core.ts", "lib/finance/summary.ts", "lib/finance/money.ts",
  ];
  const touched = protectedModules.filter((module) => changed.includes(module));
  assert.deepEqual(touched, [], `auth must not touch calculation modules: ${touched.join(", ")}`);

  // Outside lib/auth*, lib/ changes are limited to: the server-side Sales
  // sections (which call the protected modules above, moved verbatim from the
  // client), the one authenticated fetch path, and Finance's transport default.
  const libChanges = changed.filter((path) => path.startsWith("lib/") && !/^lib\/auth[/-]/.test(path));
  assert.deepEqual(libChanges.sort(), ["lib/auth-fetch.ts", "lib/finance-adapter.ts", "lib/sales-http.ts", "lib/sales-sections.ts"].filter((path) => !/^lib\/auth[/-]/.test(path)).sort());
  // Finance's change is transport only: every changed line is about the fetch path.
  const financeDiff = execFileSync("git", ["diff", "-U0", "cd1d418", "--", "lib/finance-adapter.ts"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((line) => /^[+-](?![+-])/.test(line) && line.slice(1).trim());
  for (const line of financeDiff) {
    assert.match(line, /authFetch|SessionLostError|createHttpTransport\(fetchImpl: typeof fetch = fetch\)|catch \(error\)|throw error|FinanceError\("Finance API bilan aloqa|^[+-]\s*(\/\/|\}|\} catch)/, `unexpected Finance change: ${line}`);
  }
  // Migrations: only the two auth ones, both additive.
  assert.deepEqual(changed.filter((path) => path.startsWith("drizzle/") && path.endsWith(".sql")).sort(), ["drizzle/0008_auth_core.sql", "drizzle/0009_auth_admin_invariant.sql"]);
  // Triggers only: no statement that drops, alters or rewrites data.
  assert.doesNotMatch(read("drizzle/0009_auth_admin_invariant.sql"), /^\s*(DROP|ALTER|DELETE|UPDATE|INSERT)\b/im);
});


/* ============ the one contract: frontend mapping == backend guards ============ */

test("the frontend permission mapping and the backend route guards are the same mapping", () => {
  // One list, imported by both sides — not two lists kept in step by hand.
  assert.deepEqual([...PERMISSIONS], [...PERMISSION_KEYS]);
  assert.deepEqual(NAV_ENTRIES.map((entry) => entry.permission), [...PERMISSION_KEYS]);
  assert.match(read("lib/auth-types.ts"), /import \{ PERMISSION_KEYS[\s\S]*from "\.\/auth\/permissions"/);
  assert.match(read("lib/auth-permissions.ts"), /return hasPermission\(user\.role, user\.permissions, permission\);/);

  // Every nav view resolves to the same key on both sides.
  for (const entry of NAV_ENTRIES) assert.equal(permissionForView(entry.view), entry.permission, `${entry.view} disagrees`);

  // Every route this suite exercises is guarded in the real source with the
  // same rule the test server applies.
  const guardOf: Record<string, RegExp> = {
    "/api/bootstrap": /requireAnyPermission\(request, PERMISSION_KEYS\)/,
    "/api/admin/users": /requireAdmin\(request\)/,
    "/api/diagnostics": /requirePermission\(request, "diagnostics"\)/,
    "/api/pages": /requirePermission\(request, "pages"\)/,
  };
  const sectionOf: Record<string, SalesSection> = {
    "/api/sales/dashboard": "dashboard", "/api/sales/managers": "managers", "/api/sales/manager": "manager",
    "/api/sales/lead-flow": "leadFlow", "/api/sales/quality": "quality", "/api/sales/deals": "deals",
  };
  for (const [path, rule] of Object.entries(ROUTE_PERMISSIONS)) {
    const source = routeSource(path.replace("/api/", ""));
    const section = sectionOf[path];
    if (section) {
      // A Sales route names its section; the section names exactly one permission.
      assert.match(source, new RegExp(`salesSectionResponse\\(request, "${section}"\\)`), `${path} does not name its section`);
      assert.equal(SALES_SECTION_PERMISSION[section], rule, `${path} is not guarded by ${String(rule)}`);
      continue;
    }
    const expected = guardOf[path] ?? new RegExp(`authorizePermission\\(request, "${rule as string}"\\)`);
    assert.match(source, expected, `${path} is not guarded as the mapping says`);
  }
  // The shared Sales handler checks that permission before reading anything.
  const handler = read("lib/sales-http.ts");
  assert.ok(handler.indexOf("requirePermission(request, SALES_SECTION_PERMISSION[section])") < handler.indexOf("loadSalesRecords()"));
});

test("every application route is guarded; only login, logout and the share link are open", () => {
  // Walks the filesystem rather than git, so a new, uncommitted route is seen.
  const routes = (readdirSync(`${root}/app`, { recursive: true }) as string[])
    .filter((path) => path.endsWith("route.ts")).map((path) => `app/${path}`);
  const open = routes.filter((path) => !/require(Admin|Session|AnyPermission|Permission)|authorize(Any)?Permission|salesSectionResponse\(request/.test(read(path)));
  assert.deepEqual(open.sort(), [
    // Both are entry points that establish or destroy a session, and both still
    // call assertSafeMutation.
    "app/api/auth/login/route.ts",
    "app/api/auth/logout/route.ts",
    // Independently protected by a bearer token, by existing design.
    "app/share/[token]/route.ts",
  ]);
  // Both delegate to handlers that reject cross-site writes first.
  assert.match(read("app/api/auth/login/route.ts"), /handleLogin\(request,/);
  assert.match(read("app/api/auth/logout/route.ts"), /handleLogout\(request,/);
  for (const path of ["lib/auth/login.ts", "lib/auth/logout.ts"]) {
    assert.match(read(path), /assertSafeMutation\(request\)/, `${path} must still reject cross-site writes`);
  }
  assert.match(read("app/share/[token]/route.ts"), /The token is a bearer credential/);
});

test("state-changing calls are same-origin and survive the Origin and Sec-Fetch-Site checks", async () => {
  assert.match(read("lib/auth-adapter.ts"), /credentials: "same-origin"/);
  const fetchImpl = server.client();
  await callApi(fetchImpl, "/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@ibox.uz", password: ADMIN_PASSWORD }) });
  // Same-origin write: accepted.
  assert.equal((await callApi(fetchImpl, "/api/settings", { method: "POST", body: "{}" })).status, 200);
  // A cross-site write is refused before anything is read.
  const crossSite = await callApi(fetchImpl, "/api/settings", {
    method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json() as { code?: string }).code, "CSRF_REJECTED");
  // A GET is never blocked by the check, so reads keep working.
  assert.equal((await callApi(fetchImpl, "/api/bootstrap", { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
});

test("the dashboard never fetches a section the user cannot open", () => {
  // Hiding a nav item would still leave its fetch firing on load; these guards
  // are what stop a MEMBER's browser asking for data the API would refuse.
  assert.match(client, /if \(!accessRef\.current\.canStages\) return;/);
  assert.match(client, /if \(!accessRef\.current\.canProjects\) return;/);
  assert.match(client, /if \(!accessRef\.current\.canPages\) return;/);
  // Operational config is fetched only by Settings; each Sales section only
  // while its own view is open.
  assert.match(client, /if \(accessRef\.current\.canSettings\) \{\n\s+const bootstrapResponse = await authFetch\("\/api\/bootstrap"/);
  assert.match(client, /useSalesSection<DashboardSection>\(view === "dashboard" \? "dashboard" : null/);
  assert.match(client, /useSalesSection<DealsSection>\(view === "deals" \? "deals" : null/);
  assert.doesNotMatch(client, /\/api\/dashboard"/);
  // Sync is an administrative action, so its controls and its timers are gated.
  assert.match(client, /if \(!canSettings \|\| !configured/);
  assert.match(client, /\{!isManagementView\(view\) && canSettings &&/);
});

test("a forbidden view cannot be rendered, even if the view state names it", () => {
  assert.match(client, /const view: View = canAccessView\(authUser, requestedView\) \? requestedView : defaultView;/);
  const member = { role: "MEMBER" as const, permissions: ["finance" as PermissionKey], active: true };
  assert.equal(canAccessView(member, "settings"), false);
  assert.equal(canAccessView(member, "users"), false);
  assert.equal(canAccessView(member, "managerDetail"), false);
  assert.equal(canAccessView({ ...member, permissions: ["managers"] }, "managerDetail"), true);
  assert.equal(canAccessView(member, "somethingInvented"), false);
});
