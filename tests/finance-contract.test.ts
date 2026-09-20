import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseMoneyInput } from "../lib/finance-money";
import { buildTransactionBody } from "../lib/finance-metrics";
import { FINANCE_FIXTURES, cloneFixtures } from "../lib/finance-fixtures";
import { buildFinanceSummary } from "../lib/finance/summary";
import {
  validateAccountInput, validateCategoryHierarchy, validateCategoryInput, validateFinanceProjectInput,
  validateSubscriptionInput, validateTransactionInput,
} from "../lib/finance/validation";

test("UI Account request is the backend openingBalanceMinor/archived contract", () => {
  const openingBalanceMinor = parseMoneyInput("1250000.25", "UZS");
  const parsed = validateAccountInput({ name: "Bank", type: "BANK", currencyCode: "UZS", openingBalanceMinor, archived: false });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.openingBalanceMinor, 125_000_025);
});

test("UI Income and Expense requests pass the exact backend schema", () => {
  const account = FINANCE_FIXTURES.accounts.find((row) => row.id === "acc-1")!;
  for (const type of ["INCOME", "EXPENSE"] as const) {
    const categoryId = type === "INCOME" ? "cat-in-1" : "cat-ex-1";
    const body = buildTransactionBody({
      type, date: "2026-09-20", accountId: account.id, toAccountId: null,
      amountMinor: 10_000, destinationAmountMinor: null, categoryId, projectId: "prj-1",
    }, [account], "Contract");
    assert.equal(validateTransactionInput(body).ok, true, type);
    assert.equal(body.amountMinor, 10_000);
    assert.equal(body.currencyCode, "UZS");
  }
});

test("UI same-currency Transfer sends equal explicit backend amounts", () => {
  const accounts = FINANCE_FIXTURES.accounts.filter((row) => ["acc-1", "acc-2"].includes(row.id));
  const body = buildTransactionBody({
    type: "TRANSFER", date: "2026-09-20", accountId: "acc-1", toAccountId: "acc-2",
    amountMinor: 100_000, destinationAmountMinor: null, categoryId: null, projectId: null,
  }, accounts, "Same currency");
  assert.equal(body.sourceAmountMinor, 100_000);
  assert.equal(body.destinationAmountMinor, 100_000);
  assert.equal(validateTransactionInput(body).ok, true);
});

test("UI cross-currency Transfer sends both user amounts and no parallel toAmount fields", () => {
  const accounts = FINANCE_FIXTURES.accounts.filter((row) => ["acc-1", "acc-4"].includes(row.id));
  const body = buildTransactionBody({
    type: "TRANSFER", date: "2026-09-20", accountId: "acc-1", toAccountId: "acc-4",
    amountMinor: 1_250_000, destinationAmountMinor: 100, categoryId: null, projectId: null,
  }, accounts, "Cross currency");
  assert.equal(validateTransactionInput(body).ok, true);
  assert.equal(body.sourceAmountMinor, 1_250_000);
  assert.equal(body.destinationAmountMinor, 100);
  assert.equal("toAmount" in body, false);
  assert.equal("amount" in body, false);
});

test("UI Category and Subcategory requests pass the one-level same-kind backend rule", () => {
  const parent = validateCategoryInput({ name: "Operations", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 0 });
  assert.equal(parent.ok, true);
  const child = validateCategoryInput({ name: "Cloud", kind: "EXPENSE", parentId: "cat-ex-5", archived: false, sortOrder: 1 });
  assert.equal(child.ok, true);
  if (child.ok) assert.equal(validateCategoryHierarchy(child.value, FINANCE_FIXTURES.categories).ok, true);
});

test("backend rejects a grandchild and a child whose kind differs from its parent", () => {
  const grandchild = validateCategoryHierarchy({
    name: "Deep", kind: "EXPENSE", parentId: "cat-ex-3", archived: false, sortOrder: 0,
  }, FINANCE_FIXTURES.categories);
  assert.equal(grandchild.ok, false);
  const wrongKind = validateCategoryHierarchy({
    name: "Wrong", kind: "INCOME", parentId: "cat-ex-5", archived: false, sortOrder: 0,
  }, FINANCE_FIXTURES.categories);
  assert.equal(wrongKind.ok, false);
});

test("UI Finance Project request passes its isolated backend schema", () => {
  assert.equal(validateFinanceProjectInput({ name: "Independent cost centre", description: null, archived: false }).ok, true);
});

test("UI Subscription request matches reminder-only backend schema", () => {
  const before = FINANCE_FIXTURES.transactions.length;
  const parsed = validateSubscriptionInput({
    name: "Hosting", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5", projectId: "prj-1",
    amountMinor: 125_000, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null,
    nextDueDate: "2026-10-01", startDate: "2026-09-01", endDate: null, archived: false, note: null,
  });
  assert.equal(parsed.ok, true);
  assert.equal(validateSubscriptionInput({
    name: "Old payload", direction: "EXPENSE", accountId: "acc-2", amountMinor: 100,
    currencyCode: "UZS", cadence: "MONTHLY", nextDueDate: "2026-10-01",
  }).ok, false, "the old payload without categoryId/startDate must not submit");
  assert.equal(validateSubscriptionInput({
    name: "Bad reminder", direction: "EXPENSE", accountId: "acc-2", categoryId: "cat-ex-5",
    projectId: null, amountMinor: 100, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null,
    nextDueDate: "2026-08-31", startDate: "2026-09-01", endDate: null, archived: false, note: null,
  }).ok, false, "nextDueDate must be inside the configured window");
  assert.equal(FINANCE_FIXTURES.transactions.length, before, "validation cannot post a Transaction");
});

test("Transfer payload cannot carry an Income or Expense category", () => {
  const result = validateTransactionInput({
    date: "2026-09-20", type: "TRANSFER", projectId: null, categoryId: "cat-ex-1",
    fromAccountId: "acc-1", toAccountId: "acc-2", sourceAmountMinor: 100,
    sourceCurrencyCode: "UZS", destinationAmountMinor: 100, destinationCurrencyCode: "UZS",
  });
  assert.equal(result.ok, false);
});

test("server summary is the balance authority for the integrated Account flow", () => {
  const fixture = cloneFixtures();
  const summary = buildFinanceSummary({
    accounts: fixture.accounts, transactions: fixture.transactions, categories: fixture.categories,
    projects: fixture.projects, subscriptions: fixture.subscriptions,
    range: { from: "2026-09-01", to: "2026-09-30" }, asOf: "2026-09-20",
  });
  assert.equal(summary.accountBalances.length, fixture.accounts.length);
  assert.equal(summary.accountBalances.every((row) => Number.isSafeInteger(row.currentBalanceMinor)), true);
  assert.equal("currentBalanceMinor" in fixture.accounts[0], false, "Accounts response must not own derived balance");
});

test("archive and restore share one canonical archived boolean", () => {
  const archived = validateAccountInput({ name: "Bank", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: true });
  const restored = validateAccountInput({ name: "Bank", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: false });
  assert.equal(archived.ok && archived.value.archived, true);
  assert.equal(restored.ok && restored.value.archived, false);
});

test("integrated Finance sources cannot call CRM analytics or own Sales filter state", () => {
  const files = [
    "../lib/finance-adapter.ts", "../lib/finance-metrics.ts", "../app/finance/finance-view.tsx",
    "../app/finance/finance-drawers.tsx", "../app/api/finance/accounts/route.ts",
    "../app/api/finance/transactions/route.ts", "../app/api/finance/summary/route.ts",
  ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["analytics_records", "raw_deals", "deal_sales_snapshots", "/api/sync", "setFilters(", "buildDashboardMetrics"] ) {
    assert.equal(files.includes(forbidden), false, forbidden);
  }
});
