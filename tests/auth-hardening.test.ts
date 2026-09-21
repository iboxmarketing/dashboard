import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTestServer, sqliteThrottle, type SeedUser } from "./auth-integration-server";
import { handleLogin } from "../lib/auth/login";
import { BACKFILL_FAILED_MESSAGE, SYNC_FAILED_MESSAGE, safeOperationMessage } from "../lib/safe-errors";
import { SafeBitrixError } from "../lib/safe-bitrix-error";
import { SAFE_D1_WRITE_QUOTA_MESSAGE } from "../lib/sync-recovery";
import { handleLogout } from "../lib/auth/logout";
import { ACCOUNT_BUCKETS, ACCOUNT_LIMIT, CLEANUP_BATCH, IP_BUCKETS, IP_LIMIT, RESERVE_SQL, clientNetwork, ipBucketKey, parseIPv6, throttleAddress } from "../lib/auth/throttle";
import type { AuthUser } from "../lib/auth/types";
import { SessionLostError, authFetch, onSessionLost, resetSessionLost } from "../lib/auth-fetch";
import { createHttpAuthAdapter } from "../lib/auth-adapter";
import { createHttpTransport } from "../lib/finance-adapter";
import { buildDashboardMetrics } from "../lib/dashboard-metrics";
import type { DashboardRecord } from "../lib/dashboard-record";
import { filterHistoricalRecords } from "../lib/record-filters";
import { boundsFromKeys } from "../lib/period";
import {
  SALES_SECTION_PERMISSION, bootstrapPayload, buildManagers, buildSalesSection, dashboardSection, parseSalesQuery,
  prepareSalesRecords, salesPopulations, type SalesQuery,
} from "../lib/sales-sections";
import { normalizeSettings } from "../lib/settings-safety";
import {
  assertTargetEnvironment, bootstrapAdmin, resolveD1Target, stripJsonc, withSecretFile, type BootstrapOptions,
} from "../scripts/bootstrap-admin-lib";

const root = process.cwd();
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

/* =================================================================== data */

const SETTINGS = normalizeSettings({ selectedPipelineIds: ["3"], selectedPipelineNames: ["IBOX sales"], dashboardMetricIds: ["leads", "sql", "period_sales"] });

/** Distinctive values, so a leak is findable by plain text search. */
const MANAGERS = [["101", "Zarina Qodirova"], ["102", "Bekzod Tursunov"], ["103", "Laylo Karimova"]] as const;
const REASONS = ["Narx qimmat ekan", "Boshqa filialga yozildi", "Javob bermadi uch marta"];

function deal(index: number): DashboardRecord {
  const [managerId, manager] = MANAGERS[index % MANAGERS.length];
  const day = 1 + (index % 25);
  const hour = 3 + (index % 10);
  const created = `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:17:00.000Z`;
  const kind = index % 5;
  return {
    analyticsVersion: 11, dealId: `90${1000 + index}`, title: `Mijoz Sahifa ${index} — noyob`,
    createdAt: created, creationPeriod: index % 2 ? "WORK_HOURS" : "AFTER_HOURS", slaStart: created,
    assignedManagerId: managerId, assignedManager: manager, categoryId: "3", pipeline: "IBOX sales",
    originCategoryId: "3", originPipeline: "IBOX sales", operationalPipeline: true, projectLeadMembership: "INCLUDED",
    stageId: "C3:NEW", stage: kind === 4 ? "Oplata" : "Распределение", stageEnteredAt: created, stageAgeHours: 2, stageLimitHours: 24, stageOverdue: false,
    source: index % 2 ? "CRM-форма" : "Instagram", salesStatus: kind === 4 ? "WON" : kind === 3 ? "LOST" : kind === 2 ? "LOW_QUALITY" : "ACTIVE",
    qualified: kind !== 2, qualifiedAt: kind !== 2 ? created : null, qualifiedStageId: kind !== 2 ? "C3:UC_SQL" : null, qualifiedStage: null,
    wonAt: kind === 4 ? `2026-08-${String(Math.min(28, day + 2)).padStart(2, "0")}T10:00:00.000Z` : null,
    salesCycleHours: kind === 4 ? 48 : null, opportunity: kind === 4 ? 1_000_000 + index : 0, currencyId: "UZS",
    lossReason: kind === 3 || kind === 2 ? REASONS[index % REASONS.length] : "", lossReasonGroup: kind === 3 ? "SALES" : kind === 2 ? "MARKETING" : "NONE",
    contactId: `c${index}`, companyId: null, customerKey: `c${index}`, duplicateOfDealId: null,
    salesManagerId: managerId, salesManager: manager, salesManagerAttribution: "CUSTOM_FIELD",
    processingSource: "QUALIFICATION_STAGE", processingAt: created, processingBusinessMinutes: 30 + index, slaStatus: "ON_TIME",
    dataUnavailable: false, bitrixUrl: `https://ibox.bitrix24.test/crm/deal/details/90${1000 + index}/`, stageHistoryCount: 2,
  } as DashboardRecord;
}
const RAW = Array.from({ length: 60 }, (_, index) => deal(index));
const RECORDS = prepareSalesRecords(RAW, SETTINGS, new Date("2026-09-01T00:00:00.000Z"));
const QUERY: SalesQuery = { from: "2026-08-01", to: "2026-08-31", managers: [], sources: [] };

const PASSWORD = "MemberPassword1";
const SALES_KEYS = ["dashboard", "managers", "leadFlow", "quality", "deals"] as const;
const SEED: SeedUser[] = [
  { id: "u-admin", email: "admin@ibox.uz", name: "Admin", role: "ADMIN", password: "AdminPassword1", permissions: [] },
  ...SALES_KEYS.map((key) => ({ id: `u-${key}`, email: `${key.toLowerCase()}@ibox.uz`, name: key, role: "MEMBER" as const, password: PASSWORD, permissions: [key] })),
  { id: "u-fin", email: "fin@ibox.uz", name: "Fin", role: "MEMBER", password: PASSWORD, permissions: ["finance"] },
  { id: "u-proj", email: "proj@ibox.uz", name: "Proj", role: "MEMBER", password: PASSWORD, permissions: ["projects"] },
  { id: "u-diag", email: "diag@ibox.uz", name: "Diag", role: "MEMBER", password: PASSWORD, permissions: ["diagnostics"] },
];

let server: Awaited<ReturnType<typeof createTestServer>>;
const boot = (async () => { server = await createTestServer(SEED, { records: RECORDS, settings: SETTINGS }); })();
type Call = (path: string, init?: RequestInit) => Promise<Response>;
async function signIn(email: string, password = PASSWORD): Promise<Call> {
  await boot;
  const fetchImpl = server.client() as unknown as Call;
  const response = await fetchImpl("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200, `login ${email}`);
  return fetchImpl;
}
const SECTION_PATH = { dashboard: "dashboard", managers: "managers", leadFlow: "lead-flow", quality: "quality", deals: "deals" } as const;
const range = "from=2026-08-01&to=2026-08-31";

/* ============================ HIGH 1 — independent Sales permissions ==== */

test("HIGH 1: each Sales section is its own permission, enforced by the API", async () => {
  assert.deepEqual(SALES_SECTION_PERMISSION, {
    dashboard: "dashboard", managers: "managers", manager: "managers", leadFlow: "leadFlow", quality: "quality", deals: "deals",
  });
  for (const own of SALES_KEYS) {
    const call = await signIn(`${own.toLowerCase()}@ibox.uz`);
    for (const other of SALES_KEYS) {
      const response = await call(`/api/sales/${SECTION_PATH[other]}?${range}`);
      assert.equal(response.status, own === other ? 200 : 403, `${own} member → ${other} section`);
    }
    // The manager profile belongs to `managers`.
    assert.equal((await call(`/api/sales/manager?${range}&managerId=101`)).status, own === "managers" ? 200 : 403);
  }
  // `stages` is independent too: a Sales member cannot read Stage Control.
  const dashboardOnly = await signIn("dashboard@ibox.uz");
  assert.equal((await dashboardOnly("/api/current-stages")).status, 403);
  assert.equal((await dashboardOnly("/api/stage-funnel")).status, 403);
});

test("HIGH 1: the dashboard payload cannot be used to rebuild managers, lead flow, quality or deals", async () => {
  const call = await signIn("dashboard@ibox.uz");
  const response = await call(`/api/sales/dashboard?${range}`);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["coverageStart", "dataAsOf", "leadCount", "managers", "metricIds", "metrics", "options", "previousMetrics", "ready", "trend"]);
  assert.equal(body.managers, null, "no manager rows without `managers`");
  assert.deepEqual((body.options as { managers: unknown[] }).managers, [], "no seller list without `managers`");
  for (const record of RECORDS) {
    assert.equal(text.includes(record.dealId), false, "no Deal ID");
    assert.equal(text.includes(record.title), false, "no Deal title");
    assert.equal(text.includes(record.createdAt), false, "no per-Deal timestamp (lead flow needs hours)");
  }
  for (const [, name] of MANAGERS) assert.equal(text.includes(name), false, `no seller name (${name})`);
  for (const reason of REASONS) assert.equal(text.includes(reason), false, "no loss-reason text (quality)");
  assert.equal(text.includes("bitrix24.test/crm/deal"), false, "no Bitrix links");
  // The metric blocks are numbers, not the record arrays buildDashboardMetrics also returns.
  const metrics = body.metrics as Record<string, unknown>;
  assert.deepEqual(Object.keys(metrics).sort(), ["counts", "money", "rates", "sla", "timing"]);
  for (const forbidden of ["eligible", "sql", "periodSales", "cohortSales", "classified"]) assert.equal(forbidden in metrics, false, forbidden);
});

test("HIGH 1: every non-Deal section is minimized, and only `deals` carries Deal rows", () => {
  const can = (key: string) => key === "managers";
  const context = { can: can as never, settings: SETTINGS, dataAsOf: null };
  for (const section of ["managers", "leadFlow", "quality"] as const) {
    const text = JSON.stringify(buildSalesSection(section, RECORDS, QUERY, context));
    for (const record of RECORDS) {
      assert.equal(text.includes(record.dealId), false, `${section}: no Deal ID`);
      assert.equal(text.includes(record.title), false, `${section}: no Deal title`);
      assert.equal(text.includes(record.createdAt), false, `${section}: no per-Deal timestamp`);
    }
  }
  const leadFlow = JSON.stringify(buildSalesSection("leadFlow", RECORDS, QUERY, { ...context, can: (() => false) as never }));
  for (const [, name] of MANAGERS) assert.equal(leadFlow.includes(name), false, "lead flow carries no seller names");
  for (const reason of REASONS) assert.equal(leadFlow.includes(reason), false, "lead flow carries no reasons");
  const managers = JSON.stringify(buildSalesSection("managers", RECORDS, QUERY, context));
  for (const reason of REASONS) assert.equal(managers.includes(reason), false, "the manager table carries no reason text");
  // Deals is the Deal-level section by definition — and still a projection.
  const deals = buildSalesSection("deals", RECORDS, QUERY, context) as { deals: Record<string, unknown>[] };
  assert.ok(deals.deals.length > 0);
  for (const field of ["contactId", "companyId", "customerKey", "stageHistoryCount", "slaStart", "assignedManagerId"]) {
    assert.equal(field in deals.deals[0], false, `${field} is not rendered by the Deal report`);
  }
});

test("HIGH 1: filters that would cross sections are refused, not just hidden", async () => {
  const dashboardOnly = await signIn("dashboard@ibox.uz");
  const perSeller = await dashboardOnly(`/api/sales/dashboard?${range}&manager=101`);
  assert.equal(perSeller.status, 403, "per-seller KPIs need `managers`");
  assert.equal((await perSeller.json() as { code: string }).code, "FILTER_FORBIDDEN", "told apart from a lost permission");
  const otherSection = await dashboardOnly(`/api/sales/deals?${range}`);
  assert.equal((await otherSection.json() as { code: string }).code, "FORBIDDEN");
  assert.equal((await dashboardOnly(`/api/sales/dashboard?${range}&search=9010`)).status, 403, "Deal probing needs `deals`");
  assert.equal((await dashboardOnly(`/api/sales/dashboard?${range}&source=Instagram`)).status, 200, "an ordinary dashboard filter still works");
  const admin = await signIn("admin@ibox.uz", "AdminPassword1");
  const filtered = await admin(`/api/sales/dashboard?${range}&manager=101`);
  assert.equal(filtered.status, 200);
  const body = await filtered.json() as { managers: { id: string }[] };
  assert.deepEqual([...new Set(body.managers.map((row) => row.id))], ["101"]);
  assert.equal(parseSalesQuery(new URLSearchParams("from=2026-8-1")).ok, false, "malformed dates are refused");
  assert.equal(parseSalesQuery(new URLSearchParams("sla=ANYTHING")).ok, false, "unknown enum values are refused");
});

test("HIGH 1: moving the computation to the server changed no number", () => {
  // The browser's pipeline before this change, reproduced from cd1d418's
  // dashboard-client useMemo, against the server's populations and sections.
  for (const query of [QUERY, { ...QUERY, sources: ["Instagram"] }, { ...QUERY, managers: ["102"] }, { ...QUERY, from: "2026-08-10", to: "2026-08-12" }]) {
    const from = boundsFromKeys({ from: query.from, to: query.from }).from;
    const to = boundsFromKeys({ from: query.to, to: query.to }).to;
    const base = filterHistoricalRecords(RECORDS, query);
    const cohort = base.filter((row) => { const created = new Date(row.createdAt).getTime(); return created >= from && created <= to; });
    const won = base.filter((row) => row.salesStatus === "WON" && row.wonAt && new Date(row.wonAt).getTime() >= from && new Date(row.wonAt).getTime() <= to);
    const pop = salesPopulations(RECORDS, query);
    assert.deepEqual(pop.cohort.map((row) => row.dealId), cohort.map((row) => row.dealId));
    assert.deepEqual(pop.won.map((row) => row.dealId), won.map((row) => row.dealId));
    const before = buildDashboardMetrics(cohort, won);
    const after = dashboardSection(RECORDS, query, { can: () => true, settings: SETTINGS, dataAsOf: null });
    assert.deepEqual(after.metrics.counts, before.counts);
    assert.deepEqual(after.metrics.rates, before.rates);
    assert.deepEqual(after.metrics.money, before.money);
    assert.deepEqual(after.metrics.timing, before.timing);
    assert.deepEqual(after.managers, buildManagers(cohort, won));
  }
});

/* ============================================== MEDIUM 1 — bootstrap ==== */

test("MEDIUM 1: Finance-only, Projects-only and Sales members get no operational configuration", async () => {
  for (const email of ["fin@ibox.uz", "proj@ibox.uz", "dashboard@ibox.uz", "diag@ibox.uz"]) {
    const call = await signIn(email);
    const response = await call("/api/bootstrap");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text, "{}", `${email} receives nothing`);
  }
  const admin = await signIn("admin@ibox.uz", "AdminPassword1");
  const body = await (await admin("/api/bootstrap")).json() as Record<string, unknown>;
  for (const key of ["settings", "sync", "providers", "domain", "configured", "recordCount", "legacyData"]) assert.ok(key in body, key);
  assert.equal("records" in body, false, "the record list itself is never sent");
  // Nothing is loaded for a non-settings caller.
  let loaded = false;
  assert.deepEqual(bootstrapPayload(false, () => { loaded = true; throw new Error("must not load"); }), {});
  assert.equal(loaded, false);
  const route = read("app/api/bootstrap/route.ts");
  assert.ok(route.indexOf('if (!can("settings"))') < route.indexOf("loadSalesRecords()"), "the check precedes the read");
  // Diagnostics and Stage Control get their own minimal payloads instead.
  assert.match(read("app/api/diagnostics/route.ts"), /requirePermission\(request, "diagnostics"\)/);
  assert.match(read("app/api/current-stages/route.ts"), /stageSettings: stageSettings\(settings\)/);
});

/* ================================================ HIGH 2 — logout ======= */

const cookieCleared = (response: Response) => /__Host-ibox_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax/.test(response.headers.get("set-cookie") ?? "");
const logoutRequest = (headers: Record<string, string> = {}) => new Request("https://dash.test/api/auth/logout", {
  method: "POST", headers: { origin: "https://dash.test", cookie: "__Host-ibox_session=tok", ...headers },
});

test("HIGH 2: every logout path clears the cookie, and a failed revocation is not reported as success", async () => {
  const ok = await handleLogout(logoutRequest(), async () => {});
  assert.equal(ok.status, 200); assert.ok(cookieCleared(ok)); assert.equal((await ok.json() as { revoked: boolean }).revoked, true);

  const failed = await handleLogout(logoutRequest(), async () => { throw new Error("D1_ERROR: database is locked"); });
  assert.equal(failed.status, 500, "a D1 write failure is not a success");
  assert.ok(cookieCleared(failed), "the browser is logged out anyway");
  const failedBody = await failed.json() as { revoked: boolean; code: string; error: string };
  assert.equal(failedBody.revoked, false);
  assert.equal(failedBody.code, "REVOCATION_FAILED");
  assert.doesNotMatch(failedBody.error, /D1_ERROR|locked/, "no internal error text");

  const crossSite = await handleLogout(logoutRequest({ "sec-fetch-site": "cross-site", origin: "https://evil.test" }), async () => { throw new Error("must not run"); });
  assert.equal(crossSite.status, 403); assert.ok(cookieCleared(crossSite));

  const noCookie = await handleLogout(new Request("https://dash.test/api/auth/logout", { method: "POST", headers: { origin: "https://dash.test" } }), async () => { throw new Error("must not run"); });
  assert.equal(noCookie.status, 200); assert.ok(cookieCleared(noCookie));
});

test("HIGH 2: end to end, a failed revocation still leaves the browser signed out", async () => {
  const call = await signIn("fin@ibox.uz");
  server.failRevocation.on = true;
  try {
    const response = await call("/api/auth/logout", { method: "POST" });
    assert.equal(response.status, 500);
    assert.ok(cookieCleared(response));
    assert.equal((await call("/api/auth/me")).status, 401, "the cookie jar no longer holds the session");
  } finally { server.failRevocation.on = false; }
});

/* ======================================= HIGH 3 — login throttle / DoS == */

type Op = { method: string; key: string };
/** The real atomic SQL on SQLite, with every storage call recorded. */
function spiedThrottle() {
  const sqlite = sqliteThrottle();
  const ops: Op[] = [];
  const shape = (key: string) => key.replace(/\d+$/u, "N");
  const store: typeof sqlite.store = {
    reserve: (key, input) => { ops.push({ method: "reserve", key: shape(key) }); return sqlite.store.reserve(key, input); },
    refund: (key) => { ops.push({ method: "refund", key: shape(key) }); return sqlite.store.refund(key); },
    clear: (key) => { ops.push({ method: "clear", key: shape(key) }); return sqlite.store.clear(key); },
    sweep: (before, now, limit) => { ops.push({ method: "sweep", key: "-" }); return sqlite.store.sweep(before, now, limit); },
  };
  return { ...sqlite, store, ops };
}
function loginDeps(store: ReturnType<typeof spiedThrottle>["store"], users: AuthUser[] = []) {
  const calls = { authenticate: 0, lookups: 0 };
  return {
    calls,
    deps: {
      throttle: store,
      findUserByEmail: async (email: string) => { calls.lookups += 1; return users.find((user) => user.email === email) ?? null; },
      authenticate: async (user: AuthUser | null, password: string) => {
        calls.authenticate += 1; // one PBKDF2 per call, real or dummy
        await new Promise((resolve) => setTimeout(resolve, 1)); // yield, as real PBKDF2 does
        return user && password === "RightPassword1" ? user : null;
      },
      createSession: async () => ({ token: "t" }),
      completeLogin: async () => {},
      resolveSession: async () => ({ user: { id: "u1" } }) as never,
    },
  };
}
const loginFrom = (ip: string, email: string, password = "WrongPassword1") => new Request("https://dash.test/api/auth/login", {
  method: "POST", headers: { origin: "https://dash.test", "cf-connecting-ip": ip, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const KNOWN: AuthUser = { id: "u1", email: "known@ibox.uz", name: "K", role: "MEMBER", passwordHash: "", mustChangePassword: false, active: true, createdAt: "", updatedAt: "", lastLoginAt: null };

test("HIGH 3: 100 parallel failures are counted atomically and run at most IP_LIMIT password checks", async () => {
  const throttle = spiedThrottle();
  const { deps, calls } = loginDeps(throttle.store, [KNOWN]);
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => handleLogin(loginFrom("203.0.113.7", `burst${index}@nowhere.test`), deps)));
  const statuses = responses.map((response) => response.status);
  assert.equal(calls.authenticate, IP_LIMIT, "PBKDF2 ran exactly IP_LIMIT times, not 100");
  assert.equal(statuses.filter((status) => status === 401).length, IP_LIMIT);
  assert.equal(statuses.filter((status) => status === 429).length, 100 - IP_LIMIT);
  const ipRow = throttle.rows().find((row) => row.key_hash.startsWith("ip:"))!;
  assert.equal(ipRow.failure_count, 100, "the counter saw every attempt — it did not end at 1");
  assert.ok(ipRow.blocked_until, "and the bucket is blocked");
  // The old race: a read, then PBKDF2, then a write. The reservation is now
  // one statement, and it happens before the password check.
  assert.match(RESERVE_SQL, /ON CONFLICT\(key_hash\) DO UPDATE SET[\s\S]*RETURNING failure_count/u);
  const login = read("lib/auth/login.ts");
  assert.ok(login.indexOf("reserveAttempt(deps.throttle, ipKey") < login.indexOf("deps.authenticate("), "reserve precedes PBKDF2");
});

test("HIGH 3: one account is bounded too, however many addresses are used", async () => {
  const throttle = spiedThrottle();
  const { deps, calls } = loginDeps(throttle.store, [KNOWN]);
  await Promise.all(Array.from({ length: 60 }, (_, index) => handleLogin(loginFrom(`198.51.100.${index + 1}`, KNOWN.email), deps)));
  assert.equal(calls.authenticate, ACCOUNT_LIMIT, "the account bucket bounds PBKDF2 across rotating IPs");
  // A correct password is also refused while the bucket is spent.
  const blocked = await handleLogin(loginFrom("192.0.2.200", KNOWN.email, "RightPassword1"), deps);
  assert.equal(blocked.status, 429);
});

test("MEDIUM 3: known and unknown emails take structurally identical storage paths", async () => {
  const run = async (email: string) => {
    const throttle = spiedThrottle();
    const { deps, calls } = loginDeps(throttle.store, [KNOWN]);
    const response = await handleLogin(loginFrom("192.0.2.10", email), deps);
    return { status: response.status, ops: throttle.ops, statements: throttle.statementCount(), keys: throttle.rows().map((row) => row.key_hash.replace(/\d+$/u, "N")), calls };
  };
  const known = await run(KNOWN.email);
  const unknown = await run("nobody-at-all@nowhere.test");
  assert.equal(known.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(known.ops, unknown.ops, "same calls, same order, same key shapes");
  assert.equal(known.statements, unknown.statements, "same number of SQL statements");
  assert.deepEqual(known.keys, unknown.keys, "same stored row shapes");
  assert.deepEqual(known.keys, ["acct:N", "ip:N"]);
  assert.deepEqual([known.calls.lookups, known.calls.authenticate], [unknown.calls.lookups, unknown.calls.authenticate], "one lookup and one PBKDF2 each");
});

test("HIGH 3: the key space is bounded and never stores a raw address or email", async () => {
  const throttle = spiedThrottle();
  const { deps } = loginDeps(throttle.store, [KNOWN]);
  for (let index = 0; index < 300; index += 1) await handleLogin(loginFrom(`198.51.${index % 250}.${index % 200}`, `x${index}@nowhere.test`), deps);
  for (const row of throttle.rows()) {
    assert.match(row.key_hash, /^(ip:\d+|acct:\d+)$/u, row.key_hash);
    const n = Number(row.key_hash.split(":")[1]);
    assert.ok(n < (row.key_hash.startsWith("ip") ? IP_BUCKETS : ACCOUNT_BUCKETS));
  }
  // X-Forwarded-For is caller-controlled and never picks the bucket.
  const spoofed = new Request("https://dash.test/api/auth/login", { method: "POST", headers: { origin: "https://dash.test", "x-forwarded-for": "10.9.9.9" }, body: "{}" });
  assert.equal(throttleAddress(spoofed), "unknown");
});

test("LOW: equivalent IPv6 spellings of one /64 land in one bucket", async () => {
  const same = [
    "2001:db8:1:2::5", "2001:0db8:0001:0002:0000:0000:0000:0005", "2001:DB8:1:2:0:0:0:9",
    "[2001:db8:1:2::abcd]", "2001:db8:1:2:ffff:eeee:dddd:cccc", "2001:db8:1:2::1.2.3.4", "2001:db8:1:2::5%eth0",
  ];
  const networks = new Set(same.map(clientNetwork));
  assert.deepEqual([...networks], ["2001:0db8:0001:0002::/64"]);
  const buckets = new Set(await Promise.all(same.map(ipBucketKey)));
  assert.equal(buckets.size, 1);
  assert.notEqual(clientNetwork("2001:db8:1:3::5"), clientNetwork("2001:db8:1:2::5"), "a different /64 is a different network");
  assert.equal(clientNetwork("::ffff:203.0.113.7"), "203.0.113.7", "IPv4-mapped is the IPv4 address");
  assert.equal(clientNetwork("::ffff:cb00:7107"), "203.0.113.7");
  assert.equal(clientNetwork("203.000.113.007"), "203.0.113.7");
  for (const bad of ["2001:db8::1::2", "12345::1", "1.2.3.256", "", "not-an-ip"]) assert.equal(clientNetwork(bad), "invalid", bad);
  assert.deepEqual(parseIPv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseIPv6("::1.2.3.4"), [0, 0, 0, 0, 0, 0, 0x0102, 0x0304]);
});

test("HIGH 3: expired rows are swept in bounded batches", async () => {
  const throttle = spiedThrottle();
  const insert = throttle.db.prepare("INSERT INTO app_login_attempts (key_hash, failure_count, window_started_at, blocked_until, updated_at) VALUES (?, 1, ?, NULL, ?)");
  for (let index = 0; index < 200; index += 1) insert.run(`ip:${index}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const { deps } = loginDeps(throttle.store);
  await handleLogin(loginFrom("203.0.113.99", "a@b.test"), { ...deps, now: () => new Date("2026-09-20T00:00:00.000Z") });
  // Two reservations, each sweeping at most CLEANUP_BATCH, plus the two new rows.
  assert.equal(throttle.rows().length, 200 - 2 * CLEANUP_BATCH + 2);
});

test("HIGH 3: a successful login refunds its IP slot and clears its account bucket", async () => {
  const throttle = spiedThrottle();
  const { deps } = loginDeps(throttle.store, [KNOWN]);
  await handleLogin(loginFrom("192.0.2.50", KNOWN.email), deps);
  const ok = await handleLogin(loginFrom("192.0.2.50", KNOWN.email, "RightPassword1"), deps);
  assert.equal(ok.status, 200);
  const rows = throttle.rows();
  assert.equal(rows.filter((row) => row.key_hash.startsWith("acct:")).length, 0);
  assert.equal(rows.find((row) => row.key_hash.startsWith("ip:"))?.failure_count, 1, "the failure still counts; the success does not");
});

/* ================================= MEDIUM 2 — last active admin (SQLite) = */

function authDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  for (const file of ["drizzle/0008_auth_core.sql", "drizzle/0009_auth_admin_invariant.sql"]) {
    for (const statement of read(file).split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
  }
  return db;
}
function addUser(db: DatabaseSync, id: string, role: "ADMIN" | "MEMBER", active = 1) {
  db.prepare("INSERT INTO app_users (id,email,name,role,password_hash,must_change_password,active,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?)")
    .run(id, `${id}@x.test`, id, role, "h", active, "t", "t");
}
const activeAdmins = (db: DatabaseSync) => Number((db.prepare("SELECT COUNT(*) AS n FROM app_users WHERE role='ADMIN' AND active=1").get() as { n: number }).n);

test("MEDIUM 2: the database refuses to lose its last active admin — by demotion, deactivation or delete", () => {
  const db = authDb();
  addUser(db, "a", "ADMIN"); addUser(db, "b", "ADMIN"); addUser(db, "m", "MEMBER");
  db.prepare("UPDATE app_users SET role='MEMBER' WHERE id='a'").run();
  assert.equal(activeAdmins(db), 1);
  assert.throws(() => db.prepare("UPDATE app_users SET role='MEMBER' WHERE id='b'").run(), /LAST_ACTIVE_ADMIN/);
  assert.throws(() => db.prepare("UPDATE app_users SET active=0 WHERE id='b'").run(), /LAST_ACTIVE_ADMIN/);
  assert.throws(() => db.prepare("DELETE FROM app_users WHERE id='b'").run(), /LAST_ACTIVE_ADMIN/);
  assert.equal(activeAdmins(db), 1);
  // Unrelated writes are untouched: members, names, and promoting someone first.
  db.prepare("UPDATE app_users SET active=0 WHERE id='m'").run();
  db.prepare("UPDATE app_users SET name='Renamed' WHERE id='b'").run();
  db.prepare("UPDATE app_users SET role='ADMIN' WHERE id='a'").run();
  db.prepare("UPDATE app_users SET active=0 WHERE id='b'").run();
  assert.equal(activeAdmins(db), 1);
});

test("MEDIUM 2: a refused demotion rolls back its whole batch", () => {
  const db = authDb();
  addUser(db, "a", "ADMIN");
  db.prepare("INSERT INTO app_user_permissions (user_id, permission_key, created_at) VALUES ('a','finance','t')").run();
  db.exec("BEGIN");
  try {
    // The same order lib/auth/storage.ts batches: UPDATE first, then permissions and sessions.
    db.prepare("UPDATE app_users SET role='MEMBER', active=0 WHERE id='a'").run();
    db.prepare("DELETE FROM app_user_permissions WHERE user_id='a'").run();
    db.exec("COMMIT");
    assert.fail("the demotion must abort");
  } catch (error) {
    db.exec("ROLLBACK");
    assert.match(String(error), /LAST_ACTIVE_ADMIN/);
  }
  assert.equal(activeAdmins(db), 1);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM app_user_permissions").get() as { n: number }).n), 1);
});

test("MEDIUM 2: two concurrent demotions cannot leave zero active admins", () => {
  const dir = mkdtempSync(join(tmpdir(), "admin-race-"));
  try {
    const path = join(dir, "auth.db");
    const setup = authDb(path);
    addUser(setup, "a", "ADMIN"); addUser(setup, "b", "ADMIN");
    setup.close();
    const first = new DatabaseSync(path); const second = new DatabaseSync(path);
    second.exec("PRAGMA busy_timeout = 0");
    // Each connection read "two active admins" before either wrote — the exact
    // interleaving a JS count-then-update would lose.
    assert.equal(activeAdmins(first), 2); assert.equal(activeAdmins(second), 2);
    first.exec("BEGIN IMMEDIATE");
    first.prepare("UPDATE app_users SET role='MEMBER' WHERE id='a'").run();
    assert.throws(() => second.prepare("UPDATE app_users SET role='MEMBER' WHERE id='b'").run(), /locked|busy/i, "writes serialize");
    first.exec("COMMIT");
    assert.throws(() => second.prepare("UPDATE app_users SET role='MEMBER' WHERE id='b'").run(), /LAST_ACTIVE_ADMIN/);
    assert.equal(activeAdmins(second), 1);
    first.close(); second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // And the route no longer counts in JavaScript; it maps the database's refusal.
  const route = read("app/api/admin/users/route.ts");
  assert.doesNotMatch(route, /countActiveAdmins/);
  assert.match(route, /LAST_ACTIVE_ADMIN/);
  const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: { tag: string }[] };
  const tags = journal.entries.map((entry) => entry.tag);
  assert.deepEqual(tags.slice(tags.indexOf("0007_finance_core")), ["0007_finance_core", "0008_auth_core", "0009_auth_admin_invariant", "0010_share_owner"]);
});

/* ================================== MEDIUM 3 — first-admin bootstrap ==== */

const CONFIG = `{
  // staging worker
  "name": "ibox-dashboard-staging",
  "d1_databases": [
    { "binding": "DB", "database_name": "bitrix-dashboard-staging", "database_id": "11111111-aaaa-bbbb-cccc-000000000001" }, /* main */
    { "binding": "ANALYTICS", "database_name": "other-staging", "database_id": "22222222-aaaa-bbbb-cccc-000000000002" },
  ],
}`;
const options = (over: Partial<BootstrapOptions> = {}): BootstrapOptions => ({
  target: "staging", configPath: "/abs/staging.jsonc", config: CONFIG, binding: "DB",
  databaseName: "bitrix-dashboard-staging", databaseId: "11111111-aaaa-bbbb-cccc-000000000001",
  email: "Admin@Example.com", name: "Dashboard Admin", ...over,
});
function wrangler(existingUsers = 0) {
  const calls: string[][] = [];
  const files: { path: string; existed: boolean; mode: number; content: string }[] = [];
  return {
    calls, files,
    run: (args: string[]) => {
      calls.push(args);
      const fileAt = args.indexOf("--file");
      if (fileAt >= 0) {
        const path = args[fileAt + 1];
        files.push({ path, existed: existsSync(path), mode: statSync(path).mode & 0o777, content: readFileSync(path, "utf8") });
        return { status: 0, stdout: "" };
      }
      const sql = args[args.indexOf("--command") + 1];
      if (/COUNT\(\*\) AS users/.test(sql)) return { status: 0, stdout: JSON.stringify([{ results: [{ users: existingUsers }], success: true }]) };
      return { status: 0, stdout: JSON.stringify([{ results: [{ id: "fixed-id" }], success: true }]) };
    },
  };
}
const deps = (run: ReturnType<typeof wrangler>, tempRoot: string) => ({
  runWrangler: run.run, readSecret: async () => "Temporary1Password", hashPassword: async () => "pbkdf2-sha256$600000$SALT$SECRETHASH",
  randomId: () => "fixed-id", now: () => new Date("2026-09-21T00:00:00.000Z"), tempRoot,
});

test("MEDIUM 3: the target must match one binding exactly — wrong or ambiguous databases are refused", () => {
  assert.equal(resolveD1Target(CONFIG, options()).databaseId, "11111111-aaaa-bbbb-cccc-000000000001");
  assert.throws(() => resolveD1Target(CONFIG, options({ databaseName: "bitrix-dashboard-production" })), /database-name does not match/);
  assert.throws(() => resolveD1Target(CONFIG, options({ databaseId: "22222222-aaaa-bbbb-cccc-000000000002" })), /database-id does not match/);
  assert.throws(() => resolveD1Target(CONFIG, options({ binding: "MISSING" })), /not declared/);
  const twice = CONFIG.replace('"binding": "ANALYTICS"', '"binding": "DB"');
  assert.throws(() => resolveD1Target(twice, options()), /ambiguous/);
  assert.throws(() => resolveD1Target(CONFIG.replace(/"database_id": "11111111[^"]*"/, '"database_id": ""'), options()), /no database_id/);
  assert.throws(() => assertTargetEnvironment("production", "ibox-dashboard-staging", "bitrix-dashboard-staging", true), /refuses a staging config/);
  assert.throws(() => assertTargetEnvironment("production", "ibox-dashboard", "bitrix-dashboard", false), /confirm-production/);
  assert.equal(JSON.parse(stripJsonc('{"a": "// not a comment", /* x */ "b": 1,}')).a, "// not a comment");
});

test("MEDIUM 3: the password hash never appears in argv, and its temporary file is removed", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
  try {
    const run = wrangler(0);
    const result = await bootstrapAdmin(options(), deps(run, scratch));
    assert.equal(result.created, true);
    assert.equal(result.email, "admin@example.com", "normalized");
    for (const args of run.calls) {
      const joined = args.join(" ");
      assert.equal(joined.includes("SECRETHASH") || joined.includes("pbkdf2"), false, "no verifier on the command line");
      assert.equal(joined.includes("Temporary1Password"), false);
      assert.ok(args.includes("DB") && args.includes("/abs/staging.jsonc"), "explicit binding and config");
    }
    assert.equal(run.files.length, 1);
    const [file] = run.files;
    assert.ok(file.existed, "the file existed while Wrangler ran");
    assert.equal(file.mode, 0o600, "readable only by the operator");
    assert.match(file.content, /SECRETHASH/, "the verifier travels in the file");
    assert.match(file.content, /WHERE NOT EXISTS \(SELECT 1 FROM app_users\)/);
    assert.equal(existsSync(file.path), false, "and is gone afterwards");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("MEDIUM 3: the temporary secret is removed even when Wrangler fails", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
  try {
    let seen = "";
    await assert.rejects(() => withSecretFile("secret", (path) => { seen = path; throw new Error("wrangler exploded"); }, scratch), /exploded/);
    assert.ok(seen && !existsSync(seen));
    const run = wrangler(0);
    const failing = { ...deps(run, scratch), runWrangler: (args: string[]) => (args.includes("--file") ? (run.run(args), { status: 1, stdout: "" }) : run.run(args)) };
    await assert.rejects(() => bootstrapAdmin(options(), failing), /insert failed/);
    assert.equal(existsSync(run.files[0].path), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("MEDIUM 3: an existing user is refused before a password is even asked for", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
  try {
    const run = wrangler(1);
    let asked = 0;
    await assert.rejects(() => bootstrapAdmin(options(), { ...deps(run, scratch), readSecret: async () => { asked += 1; return "x"; } }), /already contains a user/);
    assert.equal(asked, 0);
    assert.equal(run.files.length, 0, "nothing was written");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

/* ============================================ LOW — one session-lost path */

test("LOW: 401 signs out once; 403, 5xx and network failures never do", async () => {
  const original = globalThis.fetch;
  let lost = 0;
  const stop = onSessionLost(() => { lost += 1; });
  try {
    resetSessionLost();
    const respond = (status: number) => { globalThis.fetch = (async () => new Response("{}", { status, headers: { "content-type": "application/json" } })) as typeof fetch; };
    respond(403); assert.equal((await authFetch("/api/sales/deals")).status, 403);
    respond(500); assert.equal((await authFetch("/api/finance/summary")).status, 500);
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await assert.rejects(() => authFetch("/api/projects"), TypeError);
    assert.equal(lost, 0, "none of those is a sign-out");
    respond(401);
    await assert.rejects(() => authFetch("/api/pages"), SessionLostError);
    await assert.rejects(() => authFetch("/api/settings"), SessionLostError);
    assert.equal(lost, 1, "many 401s, one notification — no loop");

    // Finance and the admin screen use the same path.
    resetSessionLost();
    await assert.rejects(() => createHttpTransport().list("accounts"), SessionLostError);
    assert.equal(lost, 2);
    resetSessionLost();
    await assert.rejects(() => createHttpAuthAdapter(globalThis.fetch).listUsers());
    assert.equal(lost, 3);
    // …but a 401 from login or `me` is an answer, not a lost session.
    resetSessionLost();
    await assert.rejects(() => createHttpAuthAdapter(globalThis.fetch).login({ email: "a@b.c", password: "x" }));
    assert.equal(await createHttpAuthAdapter(globalThis.fetch).me(), null);
    assert.equal(lost, 3);
  } finally { stop(); globalThis.fetch = original; resetSessionLost(); }
});

test("LOW: every authenticated screen goes through the one path, and the shell listens to it", () => {
  const client = read("app/dashboard-client.tsx");
  assert.doesNotMatch(client, /[^h]\bfetch\(/, "no raw fetch in the dashboard");
  assert.match(read("app/sales-data.tsx"), /authFetch\(url/);
  assert.match(read("lib/finance-adapter.ts"), /createHttpTransport\(fetchImpl: typeof fetch = authFetch\)/);
  assert.match(read("lib/auth-adapter.ts"), /if \(response\.status === 401 && authenticated\) reportSessionLost\(\);/);
  const shell = read("app/auth/auth-shell.tsx");
  assert.match(shell, /onSessionLost\(\(\) => \{/);
  // The shell sets the signed-out state directly — it never re-calls /me on a 401.
  const listener = shell.slice(shell.indexOf("onSessionLost(() => {"), shell.indexOf("onSessionLost(() => {") + 220);
  assert.doesNotMatch(listener, /refresh|me\(\)|setReloadToken/);
});

test("LOW: a 403 re-reads the session once to re-resolve views — never a sign-out, never a loop", () => {
  const client = read("app/dashboard-client.tsx");
  const block = client.slice(client.indexOf("const refreshedFor = useRef"), client.indexOf("}, [forbiddenKey, refreshSession]);"));
  assert.match(block, /forbiddenState\.code !== "FILTER_FORBIDDEN"/, "filter refusals do not trigger it");
  assert.match(block, /if \(!forbiddenKey \|\| refreshedFor\.current === forbiddenKey\) return;/, "once per view and permission set");
  assert.match(block, /refreshSession\(\);/);
  assert.doesNotMatch(block, /logout|sessionLost|reportSessionLost/, "a 403 is not a sign-out");
  // The key includes the permissions, so after the refresh brings new ones the
  // guard re-arms — but with unchanged permissions it cannot fire again.
  assert.match(block, /`\$\{view\}\|\$\{authUser\.role\}\|\$\{authUser\.permissions\.join\(","\)\}`/);
});

/* =========================================== LOW — safe Sync/Backfill errors */

test("LOW: Sync and Backfill return and store only fixed, pre-written error text", () => {
  const raw = new Error("D1_ERROR: no such column: payload_x at offset 42: SQLITE_ERROR SELECT * FROM raw_deals WHERE token_hash = 'abc'");
  assert.equal(safeOperationMessage(raw, SYNC_FAILED_MESSAGE), SYNC_FAILED_MESSAGE);
  assert.equal(safeOperationMessage(raw, BACKFILL_FAILED_MESSAGE), BACKFILL_FAILED_MESSAGE);
  assert.equal(safeOperationMessage("a string", SYNC_FAILED_MESSAGE), SYNC_FAILED_MESSAGE);
  assert.equal(safeOperationMessage(new SafeBitrixError("BITRIX_DOWN", "Bitrix24 javob bermadi"), SYNC_FAILED_MESSAGE), "Bitrix24 javob bermadi");
  assert.equal(safeOperationMessage(new Error(SAFE_D1_WRITE_QUOTA_MESSAGE), SYNC_FAILED_MESSAGE), SAFE_D1_WRITE_QUOTA_MESSAGE);
  assert.equal(safeOperationMessage(new Error("D1_ERROR: Exceeded free tier daily row write limit"), SYNC_FAILED_MESSAGE), SAFE_D1_WRITE_QUOTA_MESSAGE);
  for (const path of ["app/api/sync/route.ts", "app/api/backfill/route.ts"]) {
    const source = read(path);
    assert.doesNotMatch(source, /error\.message|\.message\.slice|String\(error\)/u, `${path} must not echo a raw error`);
    assert.match(source, /safeOperationMessage\(error, /u);
  }
  assert.match(read("app/api/backfill/route.ts"), /lastError: message/u, "the stored lastError is the same fixed text");
});
