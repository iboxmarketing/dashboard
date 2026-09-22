import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authFetch, onSessionLost, resetSessionLost, SessionLostError } from "../lib/auth-fetch";
import { handleLogin } from "../lib/auth/login";
import { handleLogout } from "../lib/auth/logout";
import {
  ACCOUNT_BLOCK_MS,
  ACCOUNT_BUCKETS,
  ACCOUNT_LIMIT,
  IP_BLOCK_MS,
  IP_BUCKETS,
  IP_LIMIT,
  RESERVE_SQL,
  accountBucketKey,
  clientNetwork,
  ipBucketKey,
  reserveAttempt,
  throttleAddress,
  type ThrottleStore,
} from "../lib/auth/throttle";
import type { AuthUser } from "../lib/auth/types";
import type { PageWidget, WidgetType } from "../lib/custom-pages";
import { BACKFILL_FAILED_MESSAGE, SYNC_FAILED_MESSAGE, safeOperationMessage } from "../lib/safe-errors";
import { shareDataNeeds } from "../lib/share-model";
import { allowedWidgets, canUseWidget, publicShareWidgetIds } from "../lib/widget-permissions";
import { assertTargetEnvironment, resolveD1Target } from "../scripts/bootstrap-admin-lib";
import { createTestServer, sqliteThrottle, type SeedUser } from "./auth-integration-server";

/**
 * Auth Security Adversarial Pack v3.
 *
 * This is a semantic port of every top-level V2 scenario to the release
 * candidate's current interfaces. Security expectations are unchanged.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const pagesOnly = { role: "MEMBER" as const, permissions: ["pages"], active: true };
const member = (permissions: string[], active = true) => ({ role: "MEMBER" as const, permissions, active });

function widget(id: string, widgetType: WidgetType): Pick<PageWidget, "id" | "widgetType"> {
  return { id, widgetType };
}

/* ================= A. public-share permission laundering ================ */

test("A1: pages-only MEMBER cannot add or update a widget into SALES_KPI", () => {
  assert.equal(canUseWidget(pagesOnly, "SALES_KPI"), false);

  const source = read("app/api/pages/route.ts");
  const add = source.slice(source.indexOf('if (action === "addWidget")'), source.indexOf('if (action === "updateWidget")'));
  const update = source.slice(source.indexOf('if (action === "updateWidget")'), source.indexOf('if (action === "deleteWidget")'));
  assert.ok(add.indexOf("canUseWidget(access, parsed.value.widgetType)") < add.indexOf("addWidget(parsed.value)"),
    "addWidget must authorize the source before writing");
  assert.match(update, /canUseWidget\(access, stored\.widgetType\)/u,
    "updateWidget must authorize the stored source");
  assert.match(update, /validateWidgetConfig\(stored\.widgetType, payload\.config\)/u,
    "the client cannot relabel a widget during update");
});

test("A2: pages-only MEMBER cannot add any Projects-backed widget", () => {
  for (const type of ["PROJECT_SUMMARY", "PROJECT_STATUS_BREAKDOWN", "PROJECTS_LIST", "LATEST_UPDATES"] as WidgetType[]) {
    assert.equal(canUseWidget(pagesOnly, type), false, type);
  }
  assert.equal(canUseWidget(member(["pages", "projects"]), "PROJECTS_LIST"), true);
});

test("A3: restricted widgets cannot be published with pages permission alone", () => {
  const widgets = [widget("note", "TEXT_NOTE"), widget("sales", "SALES_KPI"), widget("projects", "PROJECT_SUMMARY")];
  assert.deepEqual(allowedWidgets(pagesOnly, widgets).map((row) => row.id), ["note"]);

  const source = read("app/api/shares/route.ts");
  const create = source.slice(source.indexOf('if (action === "createShare")'), source.indexOf('if (action === "updateShare")'));
  const update = source.slice(source.indexOf('if (action === "updateShare")'), source.indexOf('if (action === "revokeShare")'));
  for (const block of [create, update]) {
    assert.match(block, /allowedWidgets\(access, available\)/u);
    assert.match(block, /status:\s*403/u, "a forbidden share selection remains HTTP 403");
  }
  assert.match(create, /ownerUserId:\s*caller\.user\.id/u,
    "share creation must persist the authenticated grantor");
  assert.match(update, /ownerUserId:\s*caller\.user\.id/u,
    "share update must persist the authenticated grantor");
});

test("A4: revoking dashboard disables an existing Sales bearer share", () => {
  const widgets = [widget("sales", "SALES_KPI"), widget("note", "TEXT_NOTE")];
  const selected = widgets.map((row) => row.id);
  const before = publicShareWidgetIds(selected, widgets, member(["pages", "dashboard"]));
  const after = publicShareWidgetIds(selected, widgets, member(["pages"]));
  assert.deepEqual(before, ["sales", "note"]);
  assert.deepEqual(after, ["note"]);
  assert.deepEqual(shareDataNeeds(widgets as PageWidget[], after), { analytics: false, projects: false },
    "revocation must prevent the analytics dataset from loading");

  const route = read("app/share/[token]/route.ts");
  const ownerRead = route.indexOf("loadUserAccess(resolved.share.ownerUserId)");
  const sourceCheck = route.indexOf("publicShareWidgetIds(");
  const needsCheck = route.indexOf("shareDataNeeds(");
  const analyticsRead = route.indexOf("listAnalyticsRecords()");
  assert.ok(ownerRead >= 0 && ownerRead < sourceCheck && sourceCheck < needsCheck && needsCheck < analyticsRead,
    "public reads must re-check current access before loading restricted data");
  assert.match(`${read("lib/share-store.ts")}\n${read("drizzle/0010_share_owner.sql")}`, /owner_user_id/iu,
    "the grantor identity must remain persisted");
});

test("A5: changing a shared TEXT widget into SALES_KPI fails closed, while text-only remains accessible", () => {
  const owner = member(["pages"]);
  assert.deepEqual(publicShareWidgetIds(["same"], [widget("same", "TEXT_NOTE")], owner), ["same"]);
  assert.deepEqual(publicShareWidgetIds(["same"], [widget("same", "SALES_KPI")], owner), [],
    "authorization follows the widget's current type");
  assert.deepEqual(shareDataNeeds([widget("same", "SALES_KPI")] as PageWidget[], []), { analytics: false, projects: false });
});

test("A6: createFromTemplate cannot introduce restricted widgets without their source permissions", () => {
  const source = read("app/api/pages/route.ts");
  const template = source.slice(source.indexOf('if (action === "createFromTemplate")'));
  const authorization = template.indexOf("canUseWidget(access, widget.widgetType)");
  const firstWrite = template.indexOf("createPage(");
  assert.ok(authorization >= 0 && authorization < firstWrite,
    "the complete template must be authorized before the first write");
  assert.equal(canUseWidget(pagesOnly, "SALES_KPI"), false);
  assert.equal(canUseWidget(pagesOnly, "PROJECT_SUMMARY"), false);
});

/* ================= B/C. atomic, shape-neutral login throttle ============ */

const knownUser: AuthUser = {
  id: "known-1", email: "known@ibox.test", name: "Known", role: "MEMBER",
  passwordHash: "unused", mustChangePassword: false, active: true,
  createdAt: "", updatedAt: "", lastLoginAt: null,
};

const loginRequest = (email: string, address = "2001:db8:1:2::99") => new Request("https://dashboard.test/api/auth/login", {
  method: "POST",
  headers: { origin: "https://dashboard.test", "cf-connecting-ip": address, "content-type": "application/json" },
  body: JSON.stringify({ email, password: "WrongPassword1" }),
});

function loginDependencies(store: ThrottleStore, known = true, authenticationGate?: Promise<void>) {
  const work = { count: 0 };
  return {
    work,
    deps: {
      throttle: store,
      findUserByEmail: async (email: string) => known && email === knownUser.email ? knownUser : null,
      authenticate: async () => {
        work.count += 1;
        if (authenticationGate) await authenticationGate;
        return null;
      },
      createSession: async () => ({ token: "unused" }),
      completeLogin: async () => {},
      resolveSession: async () => null,
    },
  };
}

test("B0: 100 colliding counter transitions cannot collapse to a final count of 1", async () => {
  const throttle = sqliteThrottle();
  const now = new Date("2026-09-21T10:00:00.000Z");
  await Promise.all(Array.from({ length: 100 }, () =>
    reserveAttempt(throttle.store, "acct:7", ACCOUNT_LIMIT, ACCOUNT_BLOCK_MS, now)));
  const row = throttle.rows().find((candidate) => candidate.key_hash === "acct:7");
  assert.equal(row?.failure_count, 100, "all colliding transitions must be preserved up to the configured cap");
  assert.ok(row?.blocked_until, "the threshold must produce a block");
});

test("B1: 100 genuinely overlapping failures cannot lose the counter or bypass the identity threshold", async () => {
  const throttle = sqliteThrottle();
  let release!: () => void;
  const authenticationGate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, work } = loginDependencies(throttle.store, true, authenticationGate);
  const pending = Promise.all(Array.from({ length: 100 }, () => handleLogin(loginRequest(knownUser.email), deps)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release();
  const responses = await pending;
  const statuses = responses.map((response) => response.status);
  const rows = throttle.rows();

  assert.ok(rows.some((row) => row.key_hash.startsWith("acct:") && row.failure_count >= ACCOUNT_LIMIT));
  assert.ok(work.count <= Math.min(IP_LIMIT, ACCOUNT_LIMIT),
    `PBKDF2 work was ${work.count}, expected <= ${Math.min(IP_LIMIT, ACCOUNT_LIMIT)}`);
  assert.ok(statuses.includes(429));
  assert.ok(statuses.filter((status) => status === 429).length >= 100 - ACCOUNT_LIMIT);
  assert.ok(rows.length <= 2, "one network and one bounded account bucket only");
});

test("B2: many unique emails remain bounded and cannot multiply password work on one network", async () => {
  const throttle = sqliteThrottle();
  let release!: () => void;
  const authenticationGate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, work } = loginDependencies(throttle.store, false, authenticationGate);
  const pending = Promise.all(Array.from({ length: 100 }, (_, index) =>
    handleLogin(loginRequest(`unknown-${index}@invalid.test`), deps)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release();
  const responses = await pending;
  const rows = throttle.rows();

  assert.ok(work.count <= IP_LIMIT, `PBKDF2 work was ${work.count}, expected <= ${IP_LIMIT}`);
  assert.ok(responses.filter((response) => response.status === 429).length >= 100 - IP_LIMIT);
  assert.ok(rows.length <= 1 + IP_LIMIT,
    "refused network reservations must not create attacker-selected account rows");
  assert.ok(rows.every((row) => /^(?:ip|acct):\d+$/u.test(row.key_hash)), "only fixed-space bucket keys may persist");
});

test("B3: production D1 throttle uses one atomic reservation statement, not get-then-put", async () => {
  assert.match(RESERVE_SQL, /INSERT INTO app_login_attempts[\s\S]*ON CONFLICT\(key_hash\) DO UPDATE SET[\s\S]*RETURNING failure_count, blocked_until/iu);
  const throttle = read("lib/auth/throttle.ts");
  const storage = read("lib/auth/storage.ts");
  assert.doesNotMatch(throttle, /const existing = await store\.get\(key\)[\s\S]*store\.put\(key/u);
  assert.match(throttle, /export const IP_BUCKETS\s*=\s*\d+/u);
  assert.match(throttle, /export const ACCOUNT_BUCKETS\s*=\s*\d+/u);
  assert.ok(IP_BUCKETS > 0 && ACCOUNT_BUCKETS > 0);
  assert.match(storage, /sqlThrottleStore\(getD1\(\)\)/u, "production storage must use the atomic SQL adapter");
  assert.match(await accountBucketKey("one@example.test"), /^acct:\d+$/u);
});

test("C: known and unknown failures have identical persistent throttle operation shape", async () => {
  async function shape(known: boolean) {
    const sqlite = sqliteThrottle();
    const operations: string[] = [];
    const category = (key: string) => key.split(":", 1)[0];
    const store: ThrottleStore = {
      reserve: (key, input) => { operations.push(`reserve:${category(key)}`); return sqlite.store.reserve(key, input); },
      refund: (key) => { operations.push(`refund:${category(key)}`); return sqlite.store.refund(key); },
      clear: (key) => { operations.push(`clear:${category(key)}`); return sqlite.store.clear(key); },
      sweep: (before, now, limit) => { operations.push("sweep"); return sqlite.store.sweep(before, now, limit); },
    };
    const { deps } = loginDependencies(store, known);
    const response = await handleLogin(loginRequest(known ? knownUser.email : "missing@ibox.test"), deps);
    assert.equal(response.status, 401);
    return operations;
  }

  const known = await shape(true);
  const unknown = await shape(false);
  assert.deepEqual(known, unknown,
    `account existence changed persistent operations: known=${known.join(",")} unknown=${unknown.join(",")}`);
  assert.deepEqual([...new Set(known.filter((op) => op.includes(":")).map((op) => op.split(":")[1]))].sort(), ["acct", "ip"]);
  assert.equal(known.some((op) => op.includes("user")), false, "no account-existence-only persistent path");
});

/* ================= D. canonical client networks ========================== */

test("D1: equivalent IPv6 spellings produce exactly one address and /64 bucket", async () => {
  const equivalent = [
    "2001:db8:0:0:0:0:0:1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:db8::1",
    "2001:DB8:0000:0000::1",
  ];
  assert.equal(new Set(equivalent.map(clientNetwork)).size, 1);
  assert.equal(new Set(await Promise.all(equivalent.map(ipBucketKey))).size, 1);
});

test("D2: addresses within one /64 match, while the selected different /64 does not", async () => {
  assert.equal(clientNetwork("2001:db8:1:2::1"), clientNetwork("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(clientNetwork("2001:db8:1:2::1"), clientNetwork("2001:db8:1:3::1"));
  assert.notEqual(await ipBucketKey("2001:db8:1:2::1"), await ipBucketKey("2001:db8:1:3::1"));
});

test("D3: X-Forwarded-For cannot override the trusted Cloudflare address", () => {
  const withCloudflare = new Request("https://dashboard.test/api/auth/login", {
    headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.77, 192.0.2.1" },
  });
  const withoutCloudflare = new Request("https://dashboard.test/api/auth/login", {
    headers: { "x-forwarded-for": "198.51.100.77, 192.0.2.1" },
  });
  assert.equal(throttleAddress(withCloudflare), "203.0.113.10");
  assert.equal(throttleAddress(withoutCloudflare), "unknown",
    "login throttling must not trust a client-controlled forwarding header");
  assert.match(read("lib/auth/login.ts"), /ipBucketKey\(throttleAddress\(request\)\)/u);
});

/* ================= E. safe operational error output ====================== */

test("E: forced Sync and Backfill errors never echo internal SQL, password_hash, or webhook-shaped strings", async () => {
  const leaks = [
    "SQLITE_ERROR SELECT password_hash FROM app_users",
    `secret webhook https://tenant.invalid/${"rest/123/fake-token"}`,
  ];
  const cases = [
    { path: "app/api/sync/route.ts", fallback: SYNC_FAILED_MESSAGE },
    { path: "app/api/backfill/route.ts", fallback: BACKFILL_FAILED_MESSAGE },
  ];

  for (const { path, fallback } of cases) {
    for (const leak of leaks) {
      // Harness adapter for the route's catch block: production's exact mapper,
      // fallback, response shape and status, with the internal operation forced.
      const response = Response.json({ error: safeOperationMessage(new Error(leak), fallback) }, { status: 500 });
      const body = await response.clone().text();
      assert.equal(response.status, 500);
      assert.equal(body.includes(leak), false);
      assert.doesNotMatch(body, /password_hash|SQLITE_ERROR|rest\/123\/fake-token/iu);
    }
    const source = read(path);
    assert.match(source, /safeOperationMessage\(error, /u);
    assert.doesNotMatch(source, /error\.message|String\(error\)|\.message\.slice/u,
      `${path} must not return arbitrary exception text`);
  }
});

/* ================= F. previous pack remains mandatory ==================== */

test("F: previous findings remain enforced semantically", async () => {
  // Logout: a D1 failure is an error, but every path clears the browser cookie.
  const logout = await handleLogout(new Request("https://dashboard.test/api/auth/logout", {
    method: "POST", headers: { origin: "https://dashboard.test", cookie: "__Host-ibox_session=token" },
  }), async () => { throw new Error("D1_ERROR password_hash"); });
  assert.equal(logout.status, 500);
  assert.match(logout.headers.get("set-cookie") ?? "", /__Host-ibox_session=;[^\n]*Max-Age=0/u);
  assert.doesNotMatch(await logout.text(), /D1_ERROR|password_hash/u);

  // The global client path signs out once for 401; 403 remains a permission answer.
  const originalFetch = globalThis.fetch;
  let lost = 0;
  const stop = onSessionLost(() => { lost += 1; });
  try {
    resetSessionLost();
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    assert.equal((await authFetch("/api/projects")).status, 403);
    assert.equal(lost, 0);
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await assert.rejects(() => authFetch("/api/projects"), SessionLostError);
    await assert.rejects(() => authFetch("/api/pages"), SessionLostError);
    assert.equal(lost, 1);
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    resetSessionLost();
  }

  // Database invariant: the final active admin cannot be demoted or deleted.
  const db = new DatabaseSync(":memory:");
  for (const file of ["drizzle/0008_auth_core.sql", "drizzle/0009_auth_admin_invariant.sql"]) {
    for (const statement of read(file).split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
  }
  db.prepare("INSERT INTO app_users (id,email,name,role,password_hash,must_change_password,active,created_at,updated_at) VALUES (?,?,?,?,?,0,1,?,?)")
    .run("admin", "admin@example.test", "Admin", "ADMIN", "hash", "now", "now");
  assert.throws(() => db.prepare("UPDATE app_users SET role='MEMBER' WHERE id='admin'").run(), /LAST_ACTIVE_ADMIN/u);
  assert.throws(() => db.prepare("DELETE FROM app_users WHERE id='admin'").run(), /LAST_ACTIVE_ADMIN/u);
  db.close();

  // Bootstrap refuses ambiguous/mismatched targets and production without confirmation.
  const config = JSON.stringify({
    name: "dashboard-staging",
    d1_databases: [{ binding: "DB", database_name: "dashboard-staging", database_id: "staging-id" }],
  });
  const target = { binding: "DB", databaseName: "dashboard-staging", databaseId: "staging-id" };
  assert.equal(resolveD1Target(config, target).databaseId, "staging-id");
  assert.throws(() => resolveD1Target(config, { ...target, databaseId: "production-id" }), /database-id does not match/u);
  assert.throws(() => assertTargetEnvironment("production", "dashboard", "dashboard", false), /confirm-production/u);
  const bootstrapSource = `${read("scripts/bootstrap-admin.ts")}\n${read("scripts/bootstrap-admin-lib.ts")}`;
  assert.doesNotMatch(bootstrapSource, /--password/u);
  assert.match(bootstrapSource, /mode:\s*0o600/u);

  // Direct MEMBER API requests remain server-enforced, independent of UI state.
  const seed: SeedUser[] = [{
    id: "member-pages", email: "member-pages@ibox.test", name: "Pages Member", role: "MEMBER",
    password: "MemberPassword1", permissions: ["pages"],
  }];
  const server = await createTestServer(seed);
  const call = server.client();
  const signedIn = await call("/api/auth/login", {
    method: "POST", body: JSON.stringify({ email: "member-pages@ibox.test", password: "MemberPassword1" }),
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await call("/api/pages")).status, 200);
  assert.equal((await call("/api/projects")).status, 403);
  assert.equal((await call("/api/sales/dashboard")).status, 403);
  assert.equal((await call("/api/admin/users")).status, 403);

  // Fixtures stay test-only, and full verify executes the post-build bundle scan.
  const imports = (source: string) => source.match(/(?:import|export)[\s\S]*?from\s+["'][^"']+["']/gu)?.join("\n") ?? "";
  for (const path of ["lib/auth-adapter.ts", "app/auth/auth-shell.tsx", "app/page.tsx"]) {
    assert.doesNotMatch(imports(read(path)), /auth-fixture|tests\//u, `${path} must not import test fixtures`);
  }
  assert.ok(read("tests/auth-ui.test.tsx").includes("fixtures are never a fallback"),
    "source-level fixture boundary remains enabled");
  const packageJson = read("package.json");
  assert.ok(packageJson.includes("tests/production-bundle.test.mjs"), "post-build fixture scan remains in full verify");
});

assert.ok(IP_BLOCK_MS > 0 && ACCOUNT_BLOCK_MS > 0);
