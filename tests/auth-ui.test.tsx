import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthCard, AuthErrorState, AuthLoadingScreen, ForbiddenState, NoSectionsState, RoleBadge } from "../app/auth/auth-primitives";
import { ChangePasswordScreen } from "../app/auth/change-password-screen";
import { LoginScreen } from "../app/auth/login-screen";
import { ProfileMenu } from "../app/auth/profile-menu";
import { UserDrawer } from "../app/auth/user-drawer";
import { UsersTable, matchesUserFilters } from "../app/auth/users-screen";
import { isManagementView, isSalesView } from "../app/dashboard-client";
import {
  AUTH_ENDPOINTS, AuthError, FORBIDDEN_MESSAGE, GENERIC_LOGIN_ERROR,
  createAuthAdapter, createHttpAuthAdapter, readUser,
} from "../lib/auth-adapter";
import { createFixtureAuthAdapter } from "./auth-fixture-adapter";
import { AUTH_FIXTURE_USERS, cloneAuthFixtures } from "./auth-fixture-adapter";
import { checkEmail, checkNewPassword, checkTemporaryPassword, normalizeEmailInput, PASSWORD_MIN_LENGTH } from "../lib/auth-password";
import { validatePassword } from "../lib/auth/password";
import { PASSWORD_CHANGED_NOTICE } from "../app/auth/auth-shell";
import {
  ASSIGNABLE_PERMISSIONS, DERIVED_VIEWS, NAV_ENTRIES, accessSummary, allowedNavEntries, canAccess, canAccessView,
  effectivePermissions, firstAllowedView, hasAnySection, normalizePermissions, permissionGroups,
  resolveView, togglePermission,
} from "../lib/auth-permissions";
import { PERMISSIONS, ROLES, type AuthUser } from "../lib/auth-types";

const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const permissionsSource = readFileSync(new URL("../lib/auth-permissions.ts", import.meta.url), "utf8");
const adapterSource = readFileSync(new URL("../lib/auth-adapter.ts", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../app/auth/auth-shell.tsx", import.meta.url), "utf8");
const loginSource = readFileSync(new URL("../app/auth/login-screen.tsx", import.meta.url), "utf8");
const drawerSource = readFileSync(new URL("../app/auth/user-drawer.tsx", import.meta.url), "utf8");
const usersSource = readFileSync(new URL("../app/auth/users-screen.tsx", import.meta.url), "utf8");

const user = (patch: Partial<AuthUser> = {}): AuthUser => ({
  id: "u-1", email: "a@ibox.uz", name: "Test User", role: "MEMBER",
  mustChangePassword: false, active: true, permissions: [], lastLoginAt: null, ...patch,
});
const admin = () => user({ id: "u-admin", role: "ADMIN", name: "Admin Person", email: "admin@ibox.uz" });
const noop = async () => {};

/* ---------- 1. roles and the canonical permission list ---------- */

test("the contract is two roles and twelve permission keys, each with one nav entry", () => {
  assert.deepEqual([...ROLES], ["ADMIN", "MEMBER"]);
  assert.equal(PERMISSIONS.length, 12);
  assert.deepEqual([...PERMISSIONS], [
    "dashboard", "managers", "leadFlow", "quality", "stages", "deals",
    "finance", "projects", "pages", "diagnostics", "settings", "users",
  ]);
  assert.equal(NAV_ENTRIES.length, PERMISSIONS.length);
  assert.deepEqual(NAV_ENTRIES.map((entry) => entry.permission), [...PERMISSIONS]);
  // One key per section, no duplicates and no section without a key.
  assert.equal(new Set(NAV_ENTRIES.map((entry) => entry.view)).size, NAV_ENTRIES.length);
});

/* ---------- 2. ADMIN access comes from the role ---------- */

test("ADMIN reaches every section even with an empty stored permission list", () => {
  const stored = admin();
  assert.deepEqual(stored.permissions, []);
  for (const permission of PERMISSIONS) assert.equal(canAccess(stored, permission), true);
  assert.equal(allowedNavEntries(stored).length, 12);
  assert.deepEqual(effectivePermissions(stored), [...PERMISSIONS]);
});

test("MEMBER reaches only granted sections, and a missing section is absent not disabled", () => {
  const member = user({ permissions: ["dashboard", "deals"] });
  assert.equal(canAccess(member, "dashboard"), true);
  assert.equal(canAccess(member, "finance"), false);
  assert.equal(canAccess(member, "users"), false);
  assert.deepEqual(allowedNavEntries(member).map((entry) => entry.view), ["dashboard", "deals"]);
});

test("a deactivated account has no access at all, whatever its role or list says", () => {
  assert.equal(canAccess(user({ role: "ADMIN", active: false }), "dashboard"), false);
  assert.equal(canAccess(user({ permissions: ["dashboard"], active: false }), "dashboard"), false);
  assert.equal(hasAnySection(user({ role: "ADMIN", active: false })), false);
  assert.equal(canAccess(null, "dashboard"), false);
});

/* ---------- 3. one mapping, no per-user special cases ---------- */

test("permission decisions never branch on an identity", () => {
  for (const [name, source] of [["permissions", permissionsSource], ["shell", shellSource], ["users", usersSource]] as const) {
    assert.doesNotMatch(source, /\.email\s*===/, `${name} decides access by email`);
    assert.doesNotMatch(source, /\.name\s*===\s*["'`]/, `${name} decides access by name`);
  }
  // The dashboard asks the mapping instead of keeping its own allow-list: one
  // `canAccess` derived from the server rule feeds the nav, the landing view,
  // the view guard and every data fetch.
  assert.match(client, /const allowedNavItems = navItems\.filter\(\(item\) => canAccess\(item\.permission\)\);/);
  assert.match(client, /canAccessView\(authUser, requestedView\)/);
  // The client's own access helper is the server's rule, not a second copy.
  assert.match(client, /hasPermission\(authUser\.role, authUser\.permissions, permission\)/);
  assert.match(client, /<nav>\{allowedNavItems\.map/);
});

test("derived views inherit their parent section's permission", () => {
  assert.deepEqual(DERIVED_VIEWS, {
    managerDetail: "managers", projectDetail: "projects", pageDetail: "pages",
    // Seller review rides the ADMIN-only `users` capability: it writes the
    // canonical seller field back to Bitrix (app/api/admin/seller-attribution).
    sellerReview: "users",
  });
  const member = user({ permissions: ["managers"] });
  assert.equal(canAccessView(member, "managerDetail"), true);
  assert.equal(canAccessView(member, "projectDetail"), false);
  // An unknown view is refused rather than allowed by default.
  assert.equal(canAccessView(admin(), "somethingElse"), false);
});

test("every navigable View in the dashboard maps to a permission", () => {
  const union = /type View = ([^;]+);/.exec(client)?.[1] ?? "";
  const views = [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(views.includes("users"), "the users view exists");
  const mapped = new Set([...NAV_ENTRIES.map((entry) => entry.view), ...Object.keys(DERIVED_VIEWS)]);
  assert.deepEqual(views.filter((view) => !mapped.has(view)), []);
});

test("Foydalanuvchilar is an administration section with no sales filters", () => {
  const entry = NAV_ENTRIES.find((candidate) => candidate.permission === "users");
  assert.equal(entry?.group, "administration");
  assert.equal(entry?.label, "Foydalanuvchilar");
  assert.equal(isSalesView("users"), false);
  assert.equal(isManagementView("users"), true);
  assert.match(client, /\{view === "users" && <UsersScreen/);
});

/* ---------- 4. landing view and redirects ---------- */

test("the landing view is the first allowed section, never a hardcoded dashboard", () => {
  assert.equal(firstAllowedView(user({ permissions: ["finance", "projects"] })), "finance");
  assert.equal(firstAllowedView(admin()), "dashboard");
  assert.equal(firstAllowedView(user({ permissions: [] })), null);
  assert.match(client, /const defaultView = allowedNavItems\[0\]\?\.id \?\? "dashboard";/);
  assert.match(client, /useState<View>\(defaultView\)/);
});

test("losing a permission moves the user to an allowed section instead of leaving them on it", () => {
  const member = user({ permissions: ["finance"] });
  assert.deepEqual(resolveView(member, "finance"), { view: "finance", redirected: false });
  assert.deepEqual(resolveView(member, "settings"), { view: "finance", redirected: true });
  // Nothing to redirect to: with no section at all there is no fallback, and the
  // shell shows the empty-access state instead of navigating anywhere.
  assert.deepEqual(resolveView(user({ permissions: [] }), "dashboard"), { view: null, redirected: false });
});

/* ---------- 5. startup gate ---------- */

test("the shell renders loading until /api/auth/me answers, and never guesses signed-out on failure", () => {
  assert.match(shellSource, /if \(state\.status === "loading"\) return <AuthLoadingScreen \/>;/);
  // A server or network fault is a fatal state, not a login form.
  assert.match(shellSource, /setFatal\(/);
  assert.match(shellSource, /if \(fatal\)/);
  // The dashboard mounts only inside the gate, so no section renders first.
  assert.match(client, /<AuthGate>\{\(session\) => <DashboardApp session=\{session\} \/>\}<\/AuthGate>/);
  const html = renderToStaticMarkup(<AuthLoadingScreen />);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Foydalanuvchilar|Dashboard<\/span>/);
});

test("me() treats 401 and 403 as not-signed-in and a 500 as an error", async () => {
  const respond = (status: number) => createHttpAuthAdapter((async () => new Response(
    JSON.stringify({ error: "nope" }), { status, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch);
  assert.equal(await respond(401).me(), null);
  assert.equal(await respond(403).me(), null);
  await assert.rejects(() => respond(500).me(), (error: unknown) => error instanceof AuthError && error.kind === "SERVER");
});

/* ---------- 6. login screen ---------- */

test("login shows one generic failure for wrong password, unknown email and deactivated account", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (path: string) => {
    seen.push(path);
    return new Response(JSON.stringify({ error: "user is deactivated" }), { status: 401, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const adapter = createHttpAuthAdapter(fetchImpl);
  await assert.rejects(
    () => adapter.login({ email: "ketgan@ibox.uz", password: "whatever1" }),
    (error: unknown) => error instanceof AuthError && error.message === GENERIC_LOGIN_ERROR,
  );
  assert.deepEqual(seen, [AUTH_ENDPOINTS.login]);
  // The server said "user is deactivated"; that wording is discarded, so the form
  // cannot be used to tell a wrong password from a disabled account.
  assert.doesNotMatch(GENERIC_LOGIN_ERROR, /deactivated/i);
  assert.equal(GENERIC_LOGIN_ERROR, "Email yoki parol noto‘g‘ri, yoki hisob faol emas.");
  const fixture = createFixtureAuthAdapter({ users: cloneAuthFixtures() });
  await assert.rejects(() => fixture.login({ email: "ketgan@ibox.uz", password: "x" }),
    (error: unknown) => error instanceof AuthError && error.message === GENERIC_LOGIN_ERROR);
  await assert.rejects(() => fixture.login({ email: "nobody@ibox.uz", password: "x" }),
    (error: unknown) => error instanceof AuthError && error.message === GENERIC_LOGIN_ERROR);
});

test("login mentions no hosting account and offers no dead forgot-password link", () => {
  const html = renderToStaticMarkup(<LoginScreen onLogin={noop} />);
  assert.match(html, /Tizimga kirish/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /Cloudflare|Workers|wrangler/i);
  assert.doesNotMatch(html, /Parolni unutdingizmi|forgot/i);
  assert.doesNotMatch(loginSource, /href="/);
  // It tells the user the real recovery path instead.
  assert.match(html, /administrator/i);
});

/* ---------- 7. must-change-password gate ---------- */

test("a temporary password blocks every section until it is replaced", () => {
  assert.match(shellSource, /state\.status === "mustChangePassword"/);
  // The gate returns the screen; `children` is never reached in that state.
  const order = shellSource.indexOf('state.status === "mustChangePassword"');
  assert.ok(order > 0 && order < shellSource.indexOf("children({"));
  const html = renderToStaticMarkup(<ChangePasswordScreen blocking onSubmit={noop} email="yangi@ibox.uz" />);
  assert.equal((html.match(/type="password"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Bekor qilish/);
});

test("the same screen is cancellable when opened voluntarily", () => {
  const html = renderToStaticMarkup(<ChangePasswordScreen blocking={false} onSubmit={noop} onCancel={() => {}} />);
  assert.match(html, /Bekor qilish/);
});

test("the client password check is the server policy, not a looser copy", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  // Every rule below is decided by lib/auth/password.ts, which the API uses too,
  // so the form can never accept a password the server will reject.
  assert.equal(validatePassword("Correct1Horse").ok, true);
  assert.equal(checkNewPassword("OldPassword1", "Correct1Horse", "Correct1Horse").ok, true);
  assert.equal(checkNewPassword("", "Correct1Horse", "Correct1Horse").ok, false);
  assert.equal(checkNewPassword("OldPassword1", "Short1aa", "Short1aa").ok, false);
  assert.equal(checkNewPassword("OldPassword1", "nouppercase1", "nouppercase1").ok, false);
  assert.equal(checkNewPassword("OldPassword1", "NoDigitsHereAtAll", "NoDigitsHereAtAll").ok, false);
  assert.equal(checkNewPassword("Correct1Horse", "Correct1Horse", "Correct1Horse").ok, false);
  assert.match(checkNewPassword("OldPassword1", "Correct1Horse", "Correct1Hors").error ?? "", /mos kelmadi/);
  assert.equal(checkTemporaryPassword("short").ok, false);
  assert.equal(checkTemporaryPassword("Temporary1Pass").ok, true);
  assert.equal(checkEmail("not-an-email").ok, false);
  assert.equal(checkEmail(" a@b.uz ").ok, true);
  assert.equal(normalizeEmailInput("  Sanjar@IBOX.uz "), "sanjar@ibox.uz");
});

test("a password change ends the session, so the UI returns to login rather than pretending", async () => {
  // The API revokes every session and clears the cookie; claiming to stay signed
  // in would leave every later call failing with an unexplainable 401.
  assert.match(shellSource, /if \(result\.loginRequired\)/);
  assert.match(shellSource, /status: "unauthenticated", error: null, notice: PASSWORD_CHANGED_NOTICE/);
  assert.match(PASSWORD_CHANGED_NOTICE, /qaytadan kiring/);
  const fixture = createFixtureAuthAdapter({ signedInAs: "u-new" });
  assert.equal((await fixture.me())?.mustChangePassword, true);
  const result = await fixture.changePassword({ currentPassword: "Temporary1Pass", newPassword: "Correct1Horse" });
  assert.equal(result.loginRequired, true);
  assert.equal(await fixture.me(), null);
  // The flag is cleared on the stored user, so the next login goes straight in.
  const users = await fixture.listUsers();
  assert.equal(users.find((row) => row.id === "u-new")?.mustChangePassword, false);
  // The notice is neutral: it never states whether the account exists.
  const html = renderToStaticMarkup(<LoginScreen onLogin={noop} notice={PASSWORD_CHANGED_NOTICE} />);
  assert.match(html, /auth-notice/);
  assert.match(html, /role="status"/);
});

/* ---------- 8. empty access and forbidden states ---------- */

test("a member with no sections sees an explanation, not an empty dashboard", () => {
  assert.equal(hasAnySection(user({ permissions: [] })), false);
  assert.match(shellSource, /if \(!hasAnySection\(state\.user\)\)/);
  const html = renderToStaticMarkup(<NoSectionsState email="kutish@ibox.uz" />);
  assert.match(html, /bo‘lim biriktirilmagan/i);
  assert.match(html, /kutish@ibox\.uz/);
});

test("a 403 reads as the agreed message and the UI never claims to be the enforcement", () => {
  assert.equal(FORBIDDEN_MESSAGE, "Bu bo‘limga kirish huquqingiz yo‘q.");
  const html = renderToStaticMarkup(<ForbiddenState onBack={() => {}} />);
  assert.match(html, /Bu bo‘limga kirish huquqingiz yo‘q\./);
  assert.match(usersSource, /convenience, not enforcement/);
});

/* ---------- 9. profile menu ---------- */

test("the profile menu shows identity and only the two self-service actions", () => {
  const html = renderToStaticMarkup(<ProfileMenu user={admin()} onChangePassword={() => {}} onLogout={() => {}} />);
  // Collapsed by default; the trigger carries the name and an accessible label.
  assert.match(html, /aria-label="Profil menyusi"/);
  assert.match(html, /Admin Person/);
  assert.match(html, /auth-avatar/);
  // The static "IM" avatar is gone.
  assert.doesNotMatch(client, /className="avatar">IM</);
  assert.match(client, /<ProfileMenu user=\{session\.user\}/);
  const source = readFileSync(new URL("../app/auth/profile-menu.tsx", import.meta.url), "utf8");
  assert.match(source, /Parolni o‘zgartirish/);
  assert.match(source, /Chiqish/);
  // No permission editing anywhere a member can reach.
  assert.doesNotMatch(source, /permissionGroups|togglePermission/);
});

/* ---------- 10. admin users screen ---------- */

test("the users table carries every agreed column and flags the signed-in row", () => {
  const html = renderToStaticMarkup(<UsersTable users={cloneAuthFixtures()} selfId="u-admin" onEdit={() => {}} />);
  for (const header of ["Ism", "Email", "Rol", "Holat", "Ruxsatlar", "Oxirgi kirish"]) assert.match(html, new RegExp(header));
  assert.match(html, /Diyorbek Sultonov/);
  assert.match(html, /users-self/);
  assert.match(html, /Faol emas/);
  assert.match(html, /Hech qachon/);
  assert.match(html, /parol almashtirilmagan/);
  assert.match(html, /Tahrirlash/);
});

test("access is summarised in words, so an account with no sections is visible at a glance", () => {
  assert.equal(accessSummary(admin()), "Barcha bo‘limlar");
  assert.equal(accessSummary(user({ permissions: [] })), "Bo‘lim biriktirilmagan");
  assert.equal(accessSummary(user({ permissions: ["dashboard", "deals"] })), "Dashboard, Deal’lar");
  assert.equal(accessSummary(user({ permissions: ["dashboard", "managers", "deals", "finance"] })), "Dashboard, Menejerlar +2");
  assert.equal(accessSummary(user({ permissions: [...PERMISSIONS] })), "Barcha bo‘limlar");
});

test("search and the role and status filters narrow the list", () => {
  const rows = cloneAuthFixtures();
  const keep = (search: string, role: "all" | "ADMIN" | "MEMBER", active: "all" | "active" | "inactive") =>
    rows.filter((row) => matchesUserFilters(row, search, role, active)).map((row) => row.id);
  assert.deepEqual(keep("", "all", "all"), rows.map((row) => row.id));
  assert.deepEqual(keep("sotuvchi", "all", "all"), ["u-sales"]);
  assert.deepEqual(keep("SULTONOV", "all", "all"), ["u-admin"]);
  assert.deepEqual(keep("", "ADMIN", "all"), ["u-admin"]);
  assert.deepEqual(keep("", "all", "inactive"), ["u-off"]);
  assert.deepEqual(keep("", "MEMBER", "active"), ["u-sales", "u-fin", "u-new", "u-none"]);
  assert.deepEqual(keep("nobody", "all", "all"), []);
});

test("the screen distinguishes loading, an empty list and an API failure", async () => {
  assert.match(usersSource, /users-skeleton/);
  assert.match(usersSource, /Hali foydalanuvchi qo‘shilmagan/);
  assert.match(usersSource, /<AuthErrorState message=\{error\} onRetry=\{reload\} \/>/);
  assert.match(usersSource, /Filtrlarga mos foydalanuvchi topilmadi/);
  const failing = renderToStaticMarkup(<AuthErrorState message="Foydalanuvchilar yuklanmadi." onRetry={() => {}} />);
  assert.match(failing, /Qayta urinish/);
});

/* ---------- 11. create / edit drawers ---------- */

test("creating a user asks for a temporary password the first login must replace", () => {
  const html = renderToStaticMarkup(
    <UserDrawer open user={null} selfId="u-admin" onClose={() => {}} onCreate={async () => {}} onPatch={async () => {}} />,
  );
  assert.match(html, /Yangi foydalanuvchi/);
  assert.match(html, /Vaqtinchalik parol/);
  assert.match(html, /type="password"/);
  assert.match(html, /value="MEMBER"/);
  // The API forces mustChangePassword on every create, so the form states the
  // outcome instead of offering a toggle it cannot honour.
  assert.match(html, /Yangi foydalanuvchi birinchi kirishda parolini albatta almashtiradi/);
  assert.doesNotMatch(html, /Keyingi kirishda parol almashtirilsin/);
  assert.match(drawerSource, /mustChangePassword: true,/);
  assert.match(drawerSource, /checkTemporaryPassword\(temporaryPassword\)/);
  // The policy shown is the server's.
  assert.match(html, /Kamida 12 ta belgi/);
});

test("permissions are grouped checkboxes, never a raw JSON field", () => {
  const groups = permissionGroups();
  assert.deepEqual(groups.map((group) => group.group), ["sales", "finance", "management", "administration"]);
  // Eleven boxes, not twelve: the server refuses `users` to every MEMBER, so
  // offering the box would promise access that cannot exist.
  assert.equal(groups.reduce((total, group) => total + group.entries.length, 0), PERMISSIONS.length - 1);
  assert.deepEqual(groups.flatMap((group) => group.entries).filter((entry) => entry.permission === "users"), []);
  assert.deepEqual(ASSIGNABLE_PERMISSIONS, PERMISSIONS.filter((key) => key !== "users"));
  const html = renderToStaticMarkup(
    <UserDrawer open user={user({ permissions: ["dashboard"] })} selfId="u-admin" onClose={() => {}} onCreate={async () => {}} onPatch={async () => {}} />,
  );
  assert.match(html, /<fieldset class="auth-perm-group"/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length >= PERMISSIONS.length - 1, true);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(drawerSource, /JSON\.parse|JSON\.stringify/);
  assert.match(html, /Belgilanmagan bo‘lim foydalanuvchiga butunlay ko‘rinmaydi/);
});

test("an ADMIN's permission boxes are locked with the agreed explanation", () => {
  const html = renderToStaticMarkup(
    <UserDrawer open user={admin()} selfId="u-other" onClose={() => {}} onCreate={async () => {}} onPatch={async () => {}} />,
  );
  assert.match(html, /Admin barcha bo‘limlarga kiradi/);
  assert.match(html, /<fieldset class="auth-perm-group" disabled=""/);
  // Locked boxes still read as granted, so the access shown matches reality.
  assert.equal((html.match(/checked=""/g) ?? []).length >= PERMISSIONS.length - 1, true);
});

test("a saved password is never displayed again", () => {
  const html = renderToStaticMarkup(
    <UserDrawer open user={AUTH_FIXTURE_USERS[1]} selfId="u-admin" onClose={() => {}} onCreate={async () => {}} onPatch={async () => {}} />,
  );
  assert.match(html, /Vaqtinchalik parol \(ixtiyoriy\)/);
  assert.match(html, /Saqlangan parol hech qachon ko‘rsatilmaydi/);
  // The field opens empty and is only sent when deliberately filled.
  assert.match(html, /type="password"[^>]*value=""/);
  assert.doesNotMatch(html, /type="password"[^>]*value="(?!")/);
  assert.match(drawerSource, /\.\.\.\(temporaryPassword \? \{ temporaryPassword \} : \{\}\)/);
  // No response shape carries a password back.
  assert.doesNotMatch(adapterSource, /password:\s*String\(|value\.password/);
});

test("deactivating, promoting and resetting a password each confirm first", () => {
  assert.match(drawerSource, /role === "ADMIN" && user!\.role !== "ADMIN" && !confirmed\(/);
  assert.match(drawerSource, /!active && user!\.active && !confirmed\(/);
  assert.match(drawerSource, /if \(temporaryPassword\) \{[\s\S]*?!confirmed\(/);
  assert.match(drawerSource, /Eski parol ishlamaydi/);
});

test("an admin cannot lock themselves out from this screen", () => {
  const html = renderToStaticMarkup(
    <UserDrawer open user={admin()} selfId="u-admin" onClose={() => {}} onCreate={async () => {}} onPatch={async () => {}} />,
  );
  assert.match(html, /O‘z hisobingizni faolsizlantira olmaysiz/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/><span>Faol<\/span>/);
  assert.match(drawerSource, /if \(isSelf && !active\) return setError/);
  assert.match(drawerSource, /if \(isSelf && role !== "ADMIN" && user!\.role === "ADMIN"\) return setError/);
  // Editing your own account re-reads `me`, so stale permissions cannot linger.
  assert.match(usersSource, /if \(body\.id === selfId\) onSelfChanged\?\.\(\)/);
});

/* ---------- 12. the single adapter ---------- */

test("exactly the agreed endpoints, same-origin credentials, and no component fetches directly", async () => {
  assert.deepEqual(AUTH_ENDPOINTS, {
    login: "/api/auth/login", logout: "/api/auth/logout", me: "/api/auth/me",
    changePassword: "/api/auth/change-password", users: "/api/admin/users",
  });
  assert.match(adapterSource, /credentials: "same-origin"/);
  for (const [name, source] of [["shell", shellSource], ["users", usersSource], ["drawer", drawerSource], ["login", loginSource]] as const) {
    assert.doesNotMatch(source, /\bfetch\(/, `${name} bypasses the adapter`);
  }
  const calls: { path: string; method: string }[] = [];
  const adapter = createHttpAuthAdapter((async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" });
    const body = path === AUTH_ENDPOINTS.users && (init?.method ?? "GET") === "GET"
      ? { users: [{ id: "u-1", email: "a@ibox.uz", name: "A", role: "MEMBER", permissions: ["dashboard"] }] }
      : path === AUTH_ENDPOINTS.users ? { id: "u-2" } : { user: { id: "u-1", email: "a@ibox.uz", role: "ADMIN" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch);
  await adapter.me();
  await adapter.login({ email: "a@ibox.uz", password: "secret12" });
  await adapter.changePassword({ currentPassword: "secret12", newPassword: "secret34" });
  await adapter.listUsers();
  await adapter.createUser({ name: "B", email: "b@ibox.uz", role: "MEMBER", temporaryPassword: "temp1234", mustChangePassword: true, permissions: ["dashboard"] });
  await adapter.updateUser({ id: "u-1", active: false });
  await adapter.logout();
  assert.deepEqual(calls, [
    { path: "/api/auth/me", method: "GET" },
    { path: "/api/auth/login", method: "POST" },
    { path: "/api/auth/change-password", method: "POST" },
    { path: "/api/admin/users", method: "GET" },
    { path: "/api/admin/users", method: "POST" },
    { path: "/api/admin/users", method: "PATCH" },
    { path: "/api/auth/logout", method: "POST" },
  ]);
});

test("fixtures are never a fallback and cannot be reached from production code", () => {
  assert.equal(createAuthAdapter().source, "api");
  // The fixture adapter and identities live under tests/ only.
  // Checked on import statements and code, not prose: a comment may say where
  // the fixtures live without importing them.
  const imports = (source: string) => source.split("\n").filter((line) => /^\s*import\b|\bfrom\s+["']/.test(line)).join("\n");
  assert.doesNotMatch(adapterSource, /function createFixtureAuthAdapter|AUTH_FIXTURE_USERS|mode: "fixtures"/);
  for (const path of ["../lib/auth-adapter.ts", "../app/auth/auth-shell.tsx", "../app/dashboard-client.tsx", "../app/auth/users-screen.tsx"]) {
    assert.doesNotMatch(imports(readFileSync(new URL(path, import.meta.url), "utf8")), /auth-fixture|finance-fixtures.*auth/, `${path} must not import auth fixtures`);
  }
  assert.throws(() => readFileSync(new URL("../lib/auth-fixtures.ts", import.meta.url), "utf8"), "the lib fixture module is gone");
  // Belt and braces: an injected fixture adapter still throws in production.
  assert.match(shellSource, /adapter\.source === "fixtures" && process\.env\.NODE_ENV === "production"/);
});

test("the adapter normalises unknown permission keys and a missing name out of the payload", () => {
  const parsed = readUser({ id: 7, email: "x@ibox.uz", role: "MEMBER", permissions: ["dashboard", "wat", "finance"], active: undefined });
  assert.equal(parsed.id, "7");
  assert.equal(parsed.name, "x@ibox.uz");
  assert.deepEqual(parsed.permissions, ["dashboard", "finance"]);
  assert.equal(parsed.active, true);
  assert.equal(parsed.mustChangePassword, false);
  assert.equal(readUser({ role: "SUPERUSER" }).role, "MEMBER");
  assert.deepEqual(normalizePermissions("dashboard"), []);
  // Stored order never matters — the canonical order is the contract's.
  assert.deepEqual(togglePermission(["deals"], "dashboard"), ["dashboard", "deals"]);
  assert.deepEqual(togglePermission(["dashboard", "deals"], "deals"), ["dashboard"]);
});

/* ---------- 13. presentation ---------- */

test("the auth and users styles exist so no screen renders unstyled", () => {
  for (const selector of [
    ".auth-screen", ".auth-card", ".auth-badge", ".auth-password", ".auth-inline-state",
    ".auth-profile-menu", ".auth-perm-group", ".users-screen", ".users-table", ".users-skeleton",
  ]) assert.ok(css.includes(selector), `${selector} is missing`);
  const card = renderToStaticMarkup(<AuthCard title="T" subtitle="S">x</AuthCard>);
  // The card no longer nests its own full-height wrapper; the gate owns that.
  assert.doesNotMatch(card, /auth-screen/);
  assert.match(renderToStaticMarkup(<RoleBadge role="ADMIN" />), /auth-badge role-admin/);
});
