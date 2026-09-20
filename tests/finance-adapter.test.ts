import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FINANCE_ENDPOINTS, FinanceError, createFinanceAdapter, createHttpTransport, emptyDataset } from "../lib/finance-adapter";
import { cloneFixtures } from "../lib/finance-fixtures";

const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function apiFetch(calls: Array<{ url: string; method: string; body: unknown }> = []) {
  const fixture = cloneFixtures();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === "POST") return json({ id: "new-id" }, 201);
    if (init?.method === "PATCH") return json({ ok: true });
    if (url.startsWith(FINANCE_ENDPOINTS.summary)) return json({ summary: fixture.summary });
    if (url === FINANCE_ENDPOINTS.currencies) return json({ currencies: fixture.currencies });
    for (const entity of ["accounts", "transactions", "categories", "projects", "subscriptions"] as const) {
      if (url === `${FINANCE_ENDPOINTS[entity]}${entity === "transactions" ? "" : "?includeArchived=true"}`) return json({ [entity]: fixture[entity] });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

test("adapter endpoint map matches every backend collection plus summary and currencies", () => {
  assert.deepEqual(FINANCE_ENDPOINTS, {
    accounts: "/api/finance/accounts", transactions: "/api/finance/transactions",
    categories: "/api/finance/categories", projects: "/api/finance/projects",
    subscriptions: "/api/finance/subscriptions", summary: "/api/finance/summary",
    currencies: "/api/finance/currencies",
  });
});

test("backend archived listing is opt-in while management loads request it explicitly", () => {
  const api = readFileSync(new URL("../lib/finance/api.ts", import.meta.url), "utf8");
  assert.match(api, /searchParams\.get\("includeArchived"\) === "true"/);
  assert.doesNotMatch(api, /includeArchived[^\n]*\?\?\s*true/);
});

test("API responses hydrate the canonical backend Finance types", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const result = await createFinanceAdapter({ fetchImpl: apiFetch(calls) }).load(RANGE);
  assert.equal(result.error, null);
  assert.equal(result.source, "api");
  assert.equal(result.dataset.accounts[0].currencyCode, "UZS");
  assert.equal(Number.isSafeInteger(result.dataset.accounts[0].openingBalanceMinor), true);
  assert.equal(result.dataset.transactions[0].amountMinor, 4_200_000_000);
  assert.equal(result.dataset.summary.range.from, "2026-09-01");
  assert.equal(calls.length, 7);
  for (const entity of ["accounts", "categories", "projects", "subscriptions"] as const) {
    assert.ok(calls.some((call) => call.url === `/api/finance/${entity}?includeArchived=true`), entity);
  }
  assert.ok(calls.some((call) => call.url === "/api/finance/transactions"));
  assert.equal(calls.some((call) => call.url === "/api/finance/transactions?includeArchived=true"), false);
  assert.ok(calls.some((call) => call.url === "/api/finance/summary?from=2026-09-01&to=2026-09-30"));
});

test("production API 400, 404, 500 and offline failures stay visible and never become fixtures", async () => {
  for (const status of [400, 404, 500]) {
    const fetchImpl = (async () => json({ error: `Finance failure ${status}` }, status)) as typeof fetch;
    const result = await createFinanceAdapter({ fetchImpl }).load(RANGE);
    assert.equal(result.source, "api");
    assert.equal(result.error, `Finance failure ${status}`);
    assert.deepEqual(result.dataset, emptyDataset(RANGE));
  }
  const offline = await createFinanceAdapter({ fetchImpl: (async () => { throw new TypeError("offline"); }) as typeof fetch }).load(RANGE);
  assert.equal(offline.source, "api");
  assert.equal(offline.error, "Finance API bilan aloqa yo‘q");
  assert.deepEqual(offline.dataset, emptyDataset(RANGE));
});

test("fixture data requires explicit fixtures mode", async () => {
  const result = await createFinanceAdapter({ mode: "fixtures" }).load(RANGE);
  assert.equal(result.source, "fixtures");
  assert.equal(result.error, null);
  assert.ok(result.dataset.accounts.length > 0);
});

test("PATCH uses the real collection endpoint and carries id plus canonical archived boolean", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const adapter = createFinanceAdapter({ fetchImpl: apiFetch(calls) });
  await adapter.updateAccount("acc-1", { archived: true });
  assert.deepEqual(calls[0], { url: "/api/finance/accounts", method: "PATCH", body: { id: "acc-1", archived: true } });
});

test("cross-currency transaction POST sends both explicit integer minor amounts", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const adapter = createFinanceAdapter({ fetchImpl: apiFetch(calls) });
  await adapter.createTransaction({
    date: "2026-09-20", type: "TRANSFER", note: "FX", projectId: null,
    accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
    fromAccountId: "uzs", toAccountId: "usd", sourceAmountMinor: 1_250_000,
    sourceCurrencyCode: "UZS", destinationAmountMinor: 100, destinationCurrencyCode: "USD",
  });
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(calls[0].url, FINANCE_ENDPOINTS.transactions);
  assert.equal(body.sourceAmountMinor, 1_250_000);
  assert.equal(body.destinationAmountMinor, 100);
  assert.equal("amount" in body, false);
  assert.equal("toAmount" in body, false);
});

test("creating a fixture subscription does not auto-post a transaction", async () => {
  const adapter = createFinanceAdapter({ mode: "fixtures" });
  const before = await adapter.load(RANGE);
  await adapter.createSubscription({
    name: "Manual reminder", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5",
    projectId: null, amountMinor: 10_000, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null,
    nextDueDate: "2026-10-01", startDate: "2026-09-01", endDate: null, archived: false, note: null,
  });
  const after = await adapter.load(RANGE);
  assert.equal(after.dataset.transactions.length, before.dataset.transactions.length);
  assert.equal(after.dataset.subscriptions.length, before.dataset.subscriptions.length + 1);
});

test("transport rejects non-JSON success and unreachable responses", async () => {
  const html = createHttpTransport((async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch);
  await assert.rejects(() => html.list("accounts"), (error: unknown) => error instanceof FinanceError && /JSON/.test(error.message));
  const offline = createHttpTransport((async () => { throw new TypeError("network"); }) as typeof fetch);
  await assert.rejects(() => offline.list("accounts"), /aloqa yo‘q/);
});
