import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_ENDPOINTS, FinanceError, createFinanceAdapter, createFixtureTransport,
  createHttpTransport, emptyDataset,
} from "../lib/finance-adapter";
import { cloneFixtures } from "../lib/finance-fixtures";

/**
 * The Finance data boundary.
 *
 * Components never call `fetch`; they call the adapter. These tests pin the
 * endpoint contract `feat/finance-core` must serve, and the fixture fallback that
 * lets this branch run before the backend exists.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

test("the endpoint contract is the one the backend lane is building", () => {
  assert.deepEqual(FINANCE_ENDPOINTS, {
    accounts: "/api/finance/accounts",
    transactions: "/api/finance/transactions",
    categories: "/api/finance/categories",
    projects: "/api/finance/projects",
    subscriptions: "/api/finance/subscriptions",
    summary: "/api/finance/summary",
  });
});

test("the adapter reads both `{items}` and a bare array, so either backend shape works", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/accounts")) return json({ items: [{ id: "a1" }] });
    return json([]);
  }) as unknown as typeof fetch;
  const result = await createFinanceAdapter({ mode: "api", fetchImpl }).load();
  assert.equal(result.source, "api");
  assert.equal(result.error, null);
  assert.deepEqual(result.dataset.accounts, [{ id: "a1" }]);
  assert.deepEqual(result.dataset.transactions, []);
  assert.equal(calls.length, 5, "one request per entity");
  assert.ok(calls.every((url) => url.startsWith("/api/finance/")));
});

test("with no backend the adapter serves fixtures and says so, rather than showing an empty ledger", async () => {
  const fetchImpl = (async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch;
  const result = await createFinanceAdapter({ mode: "auto", fetchImpl }).load();
  assert.equal(result.source, "fixtures", "the UI can then warn that the data is sample data");
  assert.equal(result.error, null);
  assert.ok(result.dataset.accounts.length > 0);
  assert.ok(result.dataset.transactions.length > 0);
});

test("in strict api mode a failure surfaces as an error instead of silently faking data", async () => {
  const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const result = await createFinanceAdapter({ mode: "api", fetchImpl }).load();
  assert.equal(result.source, "api");
  assert.match(result.error ?? "", /Finance API xatosi \(500\)/);
  assert.deepEqual(result.dataset, emptyDataset(), "no invented rows");
});

test("a non-JSON or unreachable response is reported, not parsed", async () => {
  const html = createHttpTransport((async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
  await assert.rejects(() => html.list("accounts"), (error: unknown) => {
    assert.ok(error instanceof FinanceError);
    assert.match((error as Error).message, /JSON qaytarmadi/);
    return true;
  });
  const offline = createHttpTransport((async () => { throw new TypeError("network"); }) as unknown as typeof fetch);
  await assert.rejects(() => offline.list("accounts"), /aloqa yo‘q/);
});

test("the fixture transport supports create and patch so the UI is exercisable offline", async () => {
  const transport = createFixtureTransport(cloneFixtures());
  const before = (await transport.list<{ id: string }>("projects")).length;
  const created = await transport.create<{ id: string; name: string }>("projects", { name: "Yangi", description: null, status: "ACTIVE" });
  assert.match(created.id, /^pro-local-/);
  assert.equal((await transport.list("projects")).length, before + 1);

  const patched = await transport.patch<{ id: string; status: string }>("projects", created.id, { status: "ARCHIVED" });
  assert.equal(patched.status, "ARCHIVED");
  await assert.rejects(() => transport.patch("projects", "missing", {}), /topilmadi/);
});

test("fixture writes never leak between adapters", async () => {
  const first = createFinanceAdapter({ mode: "fixtures" });
  await first.createProject({ name: "Faqat birinchi", description: null, status: "ACTIVE" });
  const second = await createFinanceAdapter({ mode: "fixtures" }).load();
  assert.equal(second.dataset.projects.some((project) => project.name === "Faqat birinchi"), false);
});

test("every mutation goes through the adapter, so integration is one change", async () => {
  const bodies: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    bodies.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return json({ id: "new" });
  }) as unknown as typeof fetch;
  const adapter = createFinanceAdapter({ mode: "api", fetchImpl });
  await adapter.createTransaction({
    date: "2026-09-20", type: "EXPENSE", accountId: "a1", toAccountId: null, categoryId: null,
    projectId: null, description: "test", amount: 10, currency: "UZS", toAmount: null, toCurrency: null,
  });
  await adapter.updateAccount("a1", { status: "ARCHIVED" });
  assert.deepEqual(bodies.map((call) => [call.method, call.url]), [
    ["POST", "/api/finance/transactions"],
    ["PATCH", "/api/finance/accounts/a1"],
  ]);
  assert.equal((bodies[0].body as { amount: number }).amount, 10);
});
