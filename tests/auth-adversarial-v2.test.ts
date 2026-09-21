import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleLogin } from "../lib/auth/login";
import { clientAddress } from "../lib/auth/security";
import {
  IP_BLOCK_MS, IP_LIMIT, USER_BLOCK_MS, USER_LIMIT, clientNetwork, ipBucketKey,
  recordFailure, type ThrottleRow, type ThrottleStore,
} from "../lib/auth/throttle";
import type { AuthUser } from "../lib/auth/types";
import type { PermissionKey } from "../lib/auth/permissions";
import type { WidgetType } from "../lib/custom-pages";

/**
 * Auth Security Adversarial Pack v2.
 *
 * This suite is intentionally committed on the audited vulnerable commit. Its
 * expectations describe the security boundary, not the current implementation:
 * it must fail on 2237f80 and pass unchanged on the hardened descendant.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

type PublicUser = {
  id: string;
  role: "ADMIN" | "MEMBER";
  active: boolean;
  permissions: PermissionKey[];
};

type ShareAccessModule = {
  canAccessWidgetSources(user: PublicUser, widgetTypes: readonly WidgetType[]): boolean;
};

/**
 * The hardened code owns this pure policy. Routes and public-share resolution
 * must call the same helper so UI checks cannot drift from bearer-link checks.
 */
async function loadShareAccess(): Promise<ShareAccessModule> {
  const modulePath = "../lib/auth/share-access.ts";
  try {
    const loaded = await import(modulePath) as Partial<ShareAccessModule>;
    assert.equal(typeof loaded.canAccessWidgetSources, "function",
      "lib/auth/share-access.ts must export canAccessWidgetSources");
    return loaded as ShareAccessModule;
  } catch (error) {
    assert.fail(`central share-source authorization is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const member = (permissions: PermissionKey[]): PublicUser => ({
  id: "member-1", role: "MEMBER", active: true, permissions,
});

/* ================= A. public-share permission laundering ================ */

test("A1: pages-only MEMBER cannot add or update a widget into SALES_KPI", async () => {
  const policy = await loadShareAccess();
  const pagesOnly = member(["pages"]);
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["SALES_KPI"]), false);

  const source = read("app/api/pages/route.ts");
  const add = source.slice(source.indexOf('if (action === "addWidget")'), source.indexOf('if (action === "updateWidget")'));
  const update = source.slice(source.indexOf('if (action === "updateWidget")'), source.indexOf('if (action === "deleteWidget")'));
  assert.match(add, /canAccessWidgetSources/u, "addWidget must enforce source permission server-side");
  const updateCall = update.match(/await updateWidget\([\s\S]*?\);/u)?.[0] ?? "";
  assert.ok(!/widgetType/u.test(updateCall) || /canAccessWidgetSources/u.test(update),
    "updateWidget must keep type immutable or authorize the proposed new source server-side");
});

test("A2: pages-only MEMBER cannot add any Projects-backed widget", async () => {
  const policy = await loadShareAccess();
  const pagesOnly = member(["pages"]);
  for (const type of ["PROJECT_SUMMARY", "PROJECT_STATUS_BREAKDOWN", "PROJECTS_LIST", "LATEST_UPDATES"] as WidgetType[]) {
    assert.equal(policy.canAccessWidgetSources(pagesOnly, [type]), false, type);
  }
  assert.equal(policy.canAccessWidgetSources(member(["pages", "projects"]), ["PROJECTS_LIST"]), true);
});

test("A3: restricted widgets cannot be published with pages permission alone", async () => {
  const policy = await loadShareAccess();
  const pagesOnly = member(["pages"]);
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["TEXT_NOTE"]), true, "safe page content remains shareable");
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["TEXT_NOTE", "SALES_KPI"]), false);
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["PROJECT_SUMMARY"]), false);

  const source = read("app/api/shares/route.ts");
  const create = source.slice(source.indexOf('if (action === "createShare")'), source.indexOf('if (action === "updateShare")'));
  const update = source.slice(source.indexOf('if (action === "updateShare")'), source.indexOf('if (action === "revokeShare")'));
  assert.match(create, /canAccessWidgetSources/u, "createShare must check every selected widget source");
  assert.match(update, /canAccessWidgetSources/u, "updateShare must check every selected widget source");
  assert.match(create, /canAccessWidgetSources\(\s*(?:context\.)?user/u,
    "share creation must authorize the authenticated grantor, not a synthetic role");
  assert.match(update, /canAccessWidgetSources\(\s*(?:context\.)?user/u,
    "share updates must authorize the authenticated grantor, not a synthetic role");
});

test("A4: revoking dashboard disables an existing Sales bearer share", async () => {
  const policy = await loadShareAccess();
  const before = member(["pages", "dashboard"]);
  const after = member(["pages"]);
  assert.equal(policy.canAccessWidgetSources(before, ["SALES_KPI"]), true);
  assert.equal(policy.canAccessWidgetSources(after, ["SALES_KPI"]), false,
    "public resolution must use the grantor's current permissions");

  const route = read("app/share/[token]/route.ts");
  const authorization = route.indexOf("canAccessWidgetSources");
  const analyticsRead = route.indexOf("listAnalyticsRecords()");
  assert.ok(authorization >= 0 && authorization < analyticsRead,
    "public bearer authorization must fail closed before analytics are loaded");
  assert.match(route, /canAccessWidgetSources\(\s*resolved\.(?:grantor|creator|owner)/u,
    "public resolution must authorize the persisted grantor's current role and permissions");
  const sharePersistence = `${read("lib/share-store.ts")}\n${read("lib/share-storage.ts")}\n${read("drizzle/0005_page_shares.sql")}`;
  assert.match(sharePersistence, /(?:grantor|creator|owner|created_by)(?:_user)?_id/iu,
    "a share must persist the grantor identity needed for permission revocation");
});

test("A5: changing a shared TEXT widget into SALES_KPI fails closed, while text-only remains accessible", async () => {
  const policy = await loadShareAccess();
  const pagesOnly = member(["pages"]);
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["TEXT_NOTE"]), true,
    "existing text-only public shares remain available");
  assert.equal(policy.canAccessWidgetSources(pagesOnly, ["SALES_KPI"]), false,
    "authorization follows the current widget type, not its type when the share was created");
});

test("A6: createFromTemplate cannot introduce restricted widgets without their source permissions", async () => {
  const source = read("app/api/pages/route.ts");
  const template = source.slice(source.indexOf('if (action === "createFromTemplate")'), source.indexOf('return Response.json({ error: "Noma'));
  assert.match(template, /canAccessWidgetSources/u,
    "template creation must authorize the complete template before creating its page or widgets");
  assert.ok(template.indexOf("canAccessWidgetSources") < template.indexOf("createPage("),
    "template authorization must happen before the first write");
});

/* ================= B/C. atomic, shape-neutral login throttle ============ */

type Reservation = { allowed: boolean; row: ThrottleRow };
type AtomicThrottleStore = ThrottleStore & {
  reserve(key: string, limit: number, blockMs: number, now: Date): Promise<Reservation>;
};

/**
 * An atomic in-memory implementation of the storage capability expected by the
 * hardened handler. The state transition happens synchronously before the
 * promise resolves, matching one D1 INSERT..ON CONFLICT..RETURNING statement.
 */
function atomicThrottleStore() {
  const rows = new Map<string, ThrottleRow>();
  const operations: string[] = [];
  const category = (key: string) => key.split(":", 1)[0];
  const store: AtomicThrottleStore = {
    async get(key) { operations.push(`get:${category(key)}`); return rows.get(key) ?? null; },
    async put(key, row) { operations.push(`put:${category(key)}`); rows.set(key, { ...row }); },
    async delete(key) { operations.push(`delete:${category(key)}`); rows.delete(key); },
    async sweep() { operations.push("sweep"); },
    async reserve(key, limit, blockMs, now) {
      operations.push(`reserve:${category(key)}`);
      const existing = rows.get(key);
      if (existing?.blockedUntil && existing.blockedUntil > now.toISOString()) return { allowed: false, row: existing };
      const reset = !existing || now.getTime() - new Date(existing.windowStartedAt).getTime() > 15 * 60_000;
      const failureCount = reset ? 1 : existing.failureCount + 1;
      const row: ThrottleRow = {
        failureCount,
        windowStartedAt: reset ? now.toISOString() : existing.windowStartedAt,
        blockedUntil: failureCount >= limit ? new Date(now.getTime() + blockMs).toISOString() : null,
        updatedAt: now.toISOString(),
      };
      rows.set(key, row);
      return { allowed: failureCount <= limit, row };
    },
  };
  return { store, rows, operations };
}

function collidingCounterStore(concurrency: number) {
  const base = atomicThrottleStore();
  const originalGet = base.store.get.bind(base.store);
  let waiting = 0;
  let release!: () => void;
  const allReadsStarted = new Promise<void>((resolve) => { release = resolve; });
  base.store.get = async (key) => {
    waiting += 1;
    if (waiting === concurrency) release();
    await allReadsStarted;
    return originalGet(key);
  };
  return base;
}

const knownUser: AuthUser = {
  id: "known-1", email: "known@ibox.test", name: "Known", role: "MEMBER",
  passwordHash: "unused", mustChangePassword: false, active: true,
  createdAt: "", updatedAt: "", lastLoginAt: null,
};

const loginRequest = (email: string, ipv6 = "2001:db8:1:2::99") => new Request("https://dashboard.test/api/auth/login", {
  method: "POST",
  headers: {
    origin: "https://dashboard.test",
    "cf-connecting-ip": ipv6,
    "content-type": "application/json",
  },
  body: JSON.stringify({ email, password: "WrongPassword1" }),
});

function loginDependencies(store: AtomicThrottleStore, known = true, authenticationGate?: Promise<void>) {
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
  const attempts = 100;
  const key = "identity:7";
  const { store, rows } = collidingCounterStore(attempts);
  const now = new Date("2026-09-21T10:00:00.000Z");
  await Promise.all(Array.from({ length: attempts }, () =>
    recordFailure(store, key, USER_LIMIT, USER_BLOCK_MS, now)));
  const finalCount = rows.get(key)?.failureCount ?? 0;
  assert.ok(finalCount >= USER_LIMIT,
    `100 overlapping failures collapsed to ${finalCount}; threshold ${USER_LIMIT} is bypassable`);
});

test("B1: 100 genuinely overlapping failures cannot lose the counter or bypass the identity threshold", async () => {
  const { store, rows } = atomicThrottleStore();
  let release!: () => void;
  const authenticationGate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, work } = loginDependencies(store, true, authenticationGate);
  const pending = Promise.all(Array.from({ length: 100 }, () =>
    handleLogin(loginRequest(knownUser.email), deps)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release();
  const responses = await pending;
  const statuses = responses.map((response) => response.status);

  assert.ok([...rows.values()].some((row) => row.failureCount >= USER_LIMIT),
    "the atomic identity counter must reach its threshold; a final count of 1 is a lost update");
  assert.ok(work.count <= Math.min(IP_LIMIT, USER_LIMIT), `password work was ${work.count}, expected <= ${USER_LIMIT}`);
  assert.ok(statuses.includes(429), "parallel attempts must transition to 429");
  assert.ok(statuses.filter((status) => status === 429).length >= 100 - USER_LIMIT);
  assert.ok(rows.size <= 2, "one network and one bounded identity bucket only");
});

test("B2: many unique emails remain bounded and cannot multiply password work on one network", async () => {
  const { store, rows } = atomicThrottleStore();
  let release!: () => void;
  const authenticationGate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, work } = loginDependencies(store, false, authenticationGate);
  const pending = Promise.all(Array.from({ length: 100 }, (_, index) =>
    handleLogin(loginRequest(`unknown-${index}@invalid.test`), deps)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release();
  const responses = await pending;
  assert.ok(work.count <= IP_LIMIT, `password work was ${work.count}, expected <= ${IP_LIMIT}`);
  assert.ok(responses.filter((response) => response.status === 429).length >= 100 - IP_LIMIT);
  assert.ok(rows.size <= 1 + 100, "row count is bounded by fixed network/identity bucket spaces, never raw email cardinality");
});

test("B3: production D1 throttle uses one atomic reservation statement, not get-then-put", () => {
  const storage = read("lib/auth/storage.ts");
  const throttle = read("lib/auth/throttle.ts");
  assert.match(storage, /reserve\s*\(/u, "D1 throttle store must expose an atomic reservation operation");
  assert.match(storage, /ON CONFLICT[\s\S]*RETURNING/iu,
    "reservation must be one D1 upsert/returning statement");
  assert.doesNotMatch(throttle, /const existing = await store\.get\(key\)[\s\S]*await store\.put\(key/u,
    "security counters must not be a read-then-write transition");
  assert.match(throttle, /IDENTITY_BUCKETS\s*=\s*\d+/u,
    "identity storage must use a fixed bucket space rather than raw-email cardinality");
  assert.match(throttle, /identityBucketKey/u, "identity keys must be mapped into that fixed bucket space");
});

test("C: known and unknown failures have identical persistent throttle operation shape", async () => {
  async function shape(known: boolean) {
    const { store, operations } = atomicThrottleStore();
    const { deps } = loginDependencies(store, known);
    await handleLogin(loginRequest(known ? knownUser.email : "missing@ibox.test"), deps);
    return operations;
  }
  const known = await shape(true);
  const unknown = await shape(false);
  assert.deepEqual(known, unknown,
    `account existence changed persistent throttle operations:\nknown=${known.join(",")}\nunknown=${unknown.join(",")}`);
  assert.deepEqual([...new Set(known.filter((op) => op.includes(":")).map((op) => op.split(":")[1]))].sort(),
    ["identity", "ip"], "both paths use the same bounded network and identity bucket categories");
  assert.equal(known.some((op) => op.includes("user")), false, "no existing-account-only bucket path");
});

/* ================= D. canonical client networks ========================== */

test("D1: equivalent IPv6 spellings produce exactly one address and /64 bucket", async () => {
  const equivalent = [
    "2001:db8:0:0:0:0:0:1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:db8::1",
    "2001:DB8:0000:0000::1",
  ];
  assert.equal(new Set(equivalent.map(clientNetwork)).size, 1, "same IPv6 /64 must canonicalize identically");
  assert.equal(new Set(await Promise.all(equivalent.map(ipBucketKey))).size, 1, "same IPv6 /64 must use one bucket");
});

test("D2: addresses within one /64 match, while the selected different /64 does not", async () => {
  assert.equal(clientNetwork("2001:db8:1:2::1"), clientNetwork("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(clientNetwork("2001:db8:1:2::1"), clientNetwork("2001:db8:1:3::1"));
  assert.notEqual(await ipBucketKey("2001:db8:1:2::1"), await ipBucketKey("2001:db8:1:3::1"));
});

test("D3: X-Forwarded-For cannot override the trusted Cloudflare address", () => {
  const request = new Request("https://dashboard.test/api/auth/login", {
    headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.77, 192.0.2.1" },
  });
  assert.equal(clientAddress(request), "203.0.113.10");
});

/* ================= E. safe operational error output ====================== */

type SafeErrorModule = { safeInternalErrorMessage(error: unknown): string };

async function loadSafeError(): Promise<SafeErrorModule> {
  const modulePath = "../lib/safe-error.ts";
  try {
    const loaded = await import(modulePath) as Partial<SafeErrorModule>;
    assert.equal(typeof loaded.safeInternalErrorMessage, "function",
      "lib/safe-error.ts must export safeInternalErrorMessage");
    return loaded as SafeErrorModule;
  } catch (error) {
    assert.fail(`shared safe-error mapper is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test("E: forced Sync and Backfill errors never echo internal SQL or webhook-shaped strings", async () => {
  const sqlLeak = "SQLITE_ERROR SELECT password_hash FROM app_users";
  const webhookLeak = `secret webhook https://example/${"rest/123/token"}`;
  const safeErrors = await loadSafeError();

  for (const leak of [sqlLeak, webhookLeak]) {
    const output = safeErrors.safeInternalErrorMessage(new Error(leak));
    assert.equal(typeof output, "string");
    assert.ok(output.length > 0, "safe error response remains actionable");
    assert.equal(output.includes(leak), false, "raw exception must not reach the client");
    assert.doesNotMatch(output, /password_hash|SQLITE_ERROR|rest\/123\/token/iu);
  }

  for (const path of ["app/api/sync/route.ts", "app/api/backfill/route.ts"]) {
    const source = read(path);
    assert.doesNotMatch(source, /error\.message(?:\.slice)?/u, `${path} returns raw Error.message`);
    assert.match(source, /safeInternalErrorMessage/u,
      `${path} must map arbitrary failures to a fixed safe diagnostic`);
  }
});

/* ================= F. previous pack remains mandatory ==================== */

test("F: every previous high-finding regression suite remains enabled", () => {
  const packageJson = read("package.json");
  for (const suite of [
    "tests/auth-core.test.ts",
    "tests/auth-ui.test.tsx",
    "tests/auth-integration.test.tsx",
    "tests/auth-hardening.test.ts",
    "tests/production-bundle.test.mjs",
  ]) assert.ok(packageJson.includes(suite), suite);

  const oldPack = read("tests/auth-hardening.test.ts");
  for (const expectation of [
    "each Sales section is its own permission",
    "every logout path clears the cookie",
    "1000 unique fake emails from one IP",
    "Finance-only, Projects-only and Sales members get no operational configuration",
    "two concurrent demotions cannot leave zero active admins",
    "the target must match one binding exactly",
    "401 signs out once",
  ]) assert.ok(oldPack.includes(expectation), `missing previous expectation: ${expectation}`);
});

// Keep constants referenced in this pack tied to the production throttle.
assert.ok(IP_BLOCK_MS > 0 && USER_BLOCK_MS > 0);
