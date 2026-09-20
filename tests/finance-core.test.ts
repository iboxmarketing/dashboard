import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addMinor, formatCurrencyAmount, parseCurrencyAmount } from "../lib/finance/money";
import { accountBalanceAt, buildFinanceSummary, filterFinanceTransactions } from "../lib/finance/summary";
import type {
  FinanceAccount, FinanceCategory, FinanceProject, FinanceSubscription, FinanceTransaction,
} from "../lib/finance/types";
import {
  validateAccountInput, validateCategoryHierarchy, validateCategoryInput, validateFinanceProjectInput,
  validateFinanceRange, validateSubscriptionInput, validateTransactionInput,
} from "../lib/finance/validation";

const CREATED = "2026-09-01T00:00:00.000Z";
const RANGE = { from: "2026-09-01", to: "2026-09-30" };

const accounts: FinanceAccount[] = [
  { id: "cash", name: "Cash", type: "CASH", currencyCode: "UZS", openingBalanceMinor: 10_000, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "cash-2", name: "Reserve", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "usd", name: "USD card", type: "CARD", currencyCode: "USD", openingBalanceMinor: 5_000, archived: false, createdAt: CREATED, updatedAt: CREATED },
];

const categories: FinanceCategory[] = [
  { id: "sales", name: "Sales", kind: "INCOME", parentId: null, archived: false, sortOrder: 1 },
  { id: "ops", name: "Operations", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 2 },
  { id: "software", name: "Software", kind: "EXPENSE", parentId: "ops", archived: false, sortOrder: 3 },
];

const projects: FinanceProject[] = [
  { id: "p1", name: "IBOX", description: null, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "p2", name: "SD", description: null, archived: false, createdAt: CREATED, updatedAt: CREATED },
];

function transaction(overrides: Partial<FinanceTransaction>): FinanceTransaction {
  return {
    id: "t", date: "2026-09-10", type: "INCOME", note: "", projectId: "p1",
    accountId: "cash", amountMinor: 100, currencyCode: "UZS", categoryId: "sales",
    fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null,
    destinationAmountMinor: null, destinationCurrencyCode: null, createdAt: CREATED, updatedAt: CREATED,
    ...overrides,
  };
}

const transactions: FinanceTransaction[] = [
  transaction({ id: "prior", date: "2026-08-31", amountMinor: 500 }),
  transaction({ id: "income-uzs", date: "2026-09-05", amountMinor: 5_000 }),
  transaction({ id: "expense-uzs", date: "2026-09-06", type: "EXPENSE", accountId: "cash", amountMinor: 2_000, categoryId: "software" }),
  transaction({
    id: "transfer-uzs", date: "2026-09-07", type: "TRANSFER", accountId: null, amountMinor: null,
    currencyCode: null, categoryId: null, fromAccountId: "cash", toAccountId: "cash-2",
    sourceAmountMinor: 1_000, sourceCurrencyCode: "UZS", destinationAmountMinor: 1_000,
    destinationCurrencyCode: "UZS",
  }),
  transaction({
    id: "transfer-fx", date: "2026-09-08", type: "TRANSFER", accountId: null, amountMinor: null,
    currencyCode: null, categoryId: null, fromAccountId: "cash", toAccountId: "usd",
    sourceAmountMinor: 2_000, sourceCurrencyCode: "UZS", destinationAmountMinor: 20,
    destinationCurrencyCode: "USD",
  }),
  transaction({ id: "income-usd", date: "2026-09-09", projectId: "p2", accountId: "usd", amountMinor: 100, currencyCode: "USD" }),
  transaction({ id: "future", date: "2026-10-01", amountMinor: 999 }),
];

function subscription(overrides: Partial<FinanceSubscription>): FinanceSubscription {
  return {
    id: "s", name: "Hosting", direction: "EXPENSE", accountId: "cash", categoryId: "software",
    projectId: "p1", amountMinor: 250, currencyCode: "UZS", cadence: "MONTHLY", intervalMonths: null,
    nextDueDate: "2026-09-15", startDate: "2026-01-01", endDate: null, archived: false, note: null,
    createdAt: CREATED, updatedAt: CREATED, ...overrides,
  };
}

test("money persists and aggregates as exact safe integer minor units", () => {
  assert.equal(parseCurrencyAmount("0.10", "USD"), 10);
  assert.equal(parseCurrencyAmount("90071992547409.91", "USD"), Number.MAX_SAFE_INTEGER);
  assert.equal(parseCurrencyAmount("90071992547409.92", "USD"), null);
  assert.equal(parseCurrencyAmount("1.001", "USD"), null);
  assert.equal(parseCurrencyAmount("1,25", "EUR"), null, "locale-ambiguous decimals are rejected");
  assert.equal(addMinor(10, 20), 30);
  assert.throws(() => addMinor(Number.MAX_SAFE_INTEGER, 1), /safe integer range/);
  assert.match(formatCurrencyAmount(123, "USD", "en-US"), /1\.23/);
});

test("account opening balance and all transaction directions produce a derived balance", () => {
  assert.equal(accountBalanceAt(accounts[0], transactions, "2026-09-30"), 10_500, "10,000 + 500 + 5,000 - 2,000 - 1,000 - 2,000");
  assert.equal(accountBalanceAt(accounts[1], transactions, "2026-09-30"), 1_000);
  assert.equal(accountBalanceAt(accounts[2], transactions, "2026-09-30"), 5_120);
});

test("transfers affect account balances but never operating income, expense, or net cash flow", () => {
  const summary = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions: [], range: RANGE, asOf: "2026-09-10" });
  assert.deepEqual(summary.operatingByCurrency, [
    { currencyCode: "USD", incomeMinor: 100, expenseMinor: 0, netCashFlowMinor: 100 },
    { currencyCode: "UZS", incomeMinor: 5_000, expenseMinor: 2_000, netCashFlowMinor: 3_000 },
  ]);
  assert.equal(summary.accountBalances.find((row) => row.accountId === "cash")?.openingBalanceMinor, 10_500);
  assert.equal(summary.accountBalances.find((row) => row.accountId === "cash")?.currentBalanceMinor, 10_500);
});

test("mixed currencies remain separate in every total", () => {
  const summary = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions: [], range: RANGE, asOf: "2026-09-10" });
  assert.deepEqual(summary.incomeByCurrency, [
    { currencyCode: "USD", amountMinor: 100 },
    { currencyCode: "UZS", amountMinor: 5_000 },
  ]);
  assert.deepEqual(summary.accountBalancesByCurrency, [
    { currencyCode: "USD", amountMinor: 5_120 },
    { currencyCode: "UZS", amountMinor: 11_500 },
  ]);
  assert.equal(summary.projectBreakdown.some((row) => row.currencyCode === "USD" && row.projectId === "p2"), true);
});

test("date and independent Finance-project filters are applied together", () => {
  assert.deepEqual(filterFinanceTransactions(transactions, RANGE).map((row) => row.id), ["income-uzs", "expense-uzs", "transfer-uzs", "transfer-fx", "income-usd"]);
  const summary = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions: [], range: RANGE, asOf: "2026-09-10", projectId: "p1" });
  assert.deepEqual(summary.operatingByCurrency, [{ currencyCode: "UZS", incomeMinor: 5_000, expenseMinor: 2_000, netCashFlowMinor: 3_000 }]);
});

test("subscriptions are planning templates: upcoming and overdue are reported without transactions", () => {
  const subscriptions = [
    subscription({ id: "upcoming", nextDueDate: "2026-09-15" }),
    subscription({ id: "overdue", nextDueDate: "2026-09-09" }),
    subscription({ id: "archived", nextDueDate: "2026-09-20", archived: true }),
  ];
  const before = transactions.length;
  const summary = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions, range: RANGE, asOf: "2026-09-10" });
  assert.deepEqual(summary.upcomingSubscriptions.map((row) => row.id), ["upcoming"]);
  assert.deepEqual(summary.overdueSubscriptions.map((row) => row.id), ["overdue"]);
  assert.equal(transactions.length, before, "summary cannot auto-post a transaction");
});

test("Finance-project filter also scopes planned subscription reporting", () => {
  const subscriptions = [
    subscription({ id: "ibox", projectId: "p1" }),
    subscription({ id: "sd", projectId: "p2" }),
    subscription({ id: "none", projectId: null }),
  ];
  const p1 = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions, range: RANGE, asOf: "2026-09-10", projectId: "p1" });
  const unassigned = buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions, range: RANGE, asOf: "2026-09-10", projectId: null });
  assert.deepEqual(p1.upcomingSubscriptions.map((row) => row.id), ["ibox"]);
  assert.deepEqual(unassigned.upcomingSubscriptions.map((row) => row.id), ["none"]);
});

test("one-level category hierarchy requires a same-kind root", () => {
  assert.equal(validateCategoryHierarchy({ name: "Cloud", kind: "EXPENSE", parentId: "ops", archived: false, sortOrder: 0 }, categories).ok, true);
  assert.match(validateCategoryHierarchy({ name: "Bad", kind: "INCOME", parentId: "ops", archived: false, sortOrder: 0 }, categories).ok ? "" : "kind", /kind/);
  const deep = validateCategoryHierarchy({ name: "Deep", kind: "EXPENSE", parentId: "software", archived: false, sortOrder: 0 }, categories);
  assert.equal(deep.ok, false);
  if (!deep.ok) assert.match(deep.error, /one subcategory level/);
});

test("server validation rejects malformed entity payloads", () => {
  assert.equal(validateAccountInput({ name: "", type: "BANK", currencyCode: "USD", openingBalanceMinor: 0 }).ok, false);
  assert.equal(validateAccountInput({ name: "Bank", type: "BANK", currencyCode: "BTC", openingBalanceMinor: 0 }).ok, false);
  assert.equal(validateAccountInput({ name: "Bank", type: "BANK", currencyCode: "USD", openingBalanceMinor: 1.2 }).ok, false);
  assert.equal(validateCategoryInput({ name: "Cat", kind: "OTHER", sortOrder: 0 }).ok, false);
  assert.equal(validateFinanceProjectInput({ name: "   " }).ok, false);
  assert.equal(validateFinanceRange("2026-09-31", "2026-10-01").ok, false);
  assert.equal(validateFinanceRange("2026-10-01", "2026-09-01").ok, false);
});

test("income and expense require positive minor units plus account and category", () => {
  const valid = validateTransactionInput({ date: "2026-09-01", type: "INCOME", accountId: "cash", categoryId: "sales", amountMinor: 100, currencyCode: "UZS" });
  assert.equal(valid.ok, true);
  assert.equal(validateTransactionInput({ date: "2026-09-01", type: "EXPENSE", amountMinor: -1, currencyCode: "UZS" }).ok, false);
  assert.equal(validateTransactionInput({ date: "bad", type: "INCOME", accountId: "cash", categoryId: "sales", amountMinor: 1, currencyCode: "UZS" }).ok, false);
});

test("same-currency transfers require equal amounts; cross-currency transfers require both explicit amounts", () => {
  assert.equal(validateTransactionInput({
    date: "2026-09-01", type: "TRANSFER", fromAccountId: "cash", toAccountId: "cash-2",
    sourceAmountMinor: 100, sourceCurrencyCode: "UZS", destinationAmountMinor: 99, destinationCurrencyCode: "UZS",
  }).ok, false);
  const cross = validateTransactionInput({
    date: "2026-09-01", type: "TRANSFER", fromAccountId: "cash", toAccountId: "usd",
    sourceAmountMinor: 1_250_000, sourceCurrencyCode: "UZS", destinationAmountMinor: 100, destinationCurrencyCode: "USD",
  });
  assert.equal(cross.ok, true);
  assert.equal(validateTransactionInput({
    date: "2026-09-01", type: "TRANSFER", fromAccountId: "cash", toAccountId: "usd",
    sourceAmountMinor: 1_250_000, sourceCurrencyCode: "UZS", destinationAmountMinor: null, destinationCurrencyCode: "USD",
  }).ok, false, "the backend never invents an exchange amount");
});

test("subscription validation enforces cadence and active date bounds", () => {
  const base = { name: "Rent", direction: "EXPENSE", accountId: "cash", categoryId: "ops", amountMinor: 100, currencyCode: "UZS", cadence: "MONTHLY", nextDueDate: "2026-09-15", startDate: "2026-01-01" };
  assert.equal(validateSubscriptionInput(base).ok, true);
  assert.equal(validateSubscriptionInput({ ...base, cadence: "CUSTOM_MONTHS" }).ok, false);
  assert.equal(validateSubscriptionInput({ ...base, cadence: "CUSTOM_MONTHS", intervalMonths: 3 }).ok, true);
  assert.equal(validateSubscriptionInput({ ...base, endDate: "2026-08-01" }).ok, false);
});

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

function migratedDb() {
  const db = new DatabaseSync!(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migration = readFileSync(new URL("../drizzle/0007_finance_core.sql", import.meta.url), "utf8").replace(/-->.*$/gm, "");
  db.exec(migration);
  const insertAccount = db.prepare("INSERT INTO finance_accounts(id,name,type,currency_code,opening_balance_minor,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  insertAccount.run("cash", "Cash", "CASH", "UZS", 0, 0, CREATED, CREATED);
  insertAccount.run("cash-2", "Reserve", "BANK", "UZS", 0, 0, CREATED, CREATED);
  insertAccount.run("usd", "USD", "BANK", "USD", 0, 0, CREATED, CREATED);
  db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)").run("inc", "Sales", "INCOME", null, 0, 0);
  db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)").run("exp", "Ops", "EXPENSE", null, 0, 0);
  db.prepare("INSERT INTO finance_projects(id,name,description,archived,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("p1", "IBOX", null, 0, CREATED, CREATED);
  return db;
}

const incomeSql = `INSERT INTO finance_transactions(
  id,date,type,note,project_id,account_id,amount_minor,currency_code,category_id,
  from_account_id,to_account_id,source_amount_minor,source_currency_code,destination_amount_minor,destination_currency_code,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const transferSql = incomeSql;

test("migration seeds currencies and creates the required query indexes", { skip: !DatabaseSync }, () => {
  const db = migratedDb();
  assert.deepEqual((db.prepare("SELECT code FROM finance_currencies ORDER BY code").all() as Array<{ code: string }>).map((row) => row.code), ["EUR", "KZT", "USD", "UZS"]);
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'finance_%_idx' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  for (const name of ["finance_transactions_date_idx", "finance_transactions_account_idx", "finance_transactions_category_idx", "finance_transactions_project_idx", "finance_subscriptions_next_due_idx"]) {
    assert.equal(indexes.includes(name), true, name);
  }
});

test("database rejects account-currency mismatch and locks Account currency after use", { skip: !DatabaseSync }, () => {
  const db = migratedDb();
  assert.throws(() => db.prepare(incomeSql).run("bad", "2026-09-01", "INCOME", "", "p1", "cash", 100, "USD", "inc", null, null, null, null, null, null, CREATED, CREATED), /references are invalid/);
  db.prepare(incomeSql).run("ok", "2026-09-01", "INCOME", "", "p1", "cash", 100, "UZS", "inc", null, null, null, null, null, null, CREATED, CREATED);
  assert.throws(() => db.prepare("UPDATE finance_accounts SET currency_code='USD' WHERE id='cash'").run(), /currency is locked/);
});

test("database enforces one-row transfer shape and refuses invented or unequal same-currency value", { skip: !DatabaseSync }, () => {
  const db = migratedDb();
  assert.throws(() => db.prepare(transferSql).run("bad", "2026-09-01", "TRANSFER", "", null, null, null, null, null, "cash", "cash-2", 100, "UZS", 90, "UZS", CREATED, CREATED), /CHECK constraint/);
  db.prepare(transferSql).run("fx", "2026-09-01", "TRANSFER", "", null, null, null, null, null, "cash", "usd", 1_250_000, "UZS", 100, "USD", CREATED, CREATED);
  assert.equal((db.prepare("SELECT count(*) AS count FROM finance_transactions WHERE id='fx'").get() as { count: number }).count, 1);
});

test("database rejects category mismatch, deeper hierarchy, and new activity on archived entities", { skip: !DatabaseSync }, () => {
  const db = migratedDb();
  assert.throws(() => db.prepare(incomeSql).run("wrong-kind", "2026-09-01", "INCOME", "", null, "cash", 100, "UZS", "exp", null, null, null, null, null, null, CREATED, CREATED), /references are invalid/);
  db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)").run("child", "Software", "EXPENSE", "exp", 0, 0);
  assert.throws(() => db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)").run("deep", "Cloud", "EXPENSE", "child", 0, 0), /same-kind root/);
  db.prepare("UPDATE finance_accounts SET archived=1 WHERE id='cash'").run();
  assert.throws(() => db.prepare(incomeSql).run("archived", "2026-09-01", "EXPENSE", "", null, "cash", 100, "UZS", "exp", null, null, null, null, null, null, CREATED, CREATED), /references are invalid/);
});

test("creating a subscription never creates a transaction", { skip: !DatabaseSync }, () => {
  const db = migratedDb();
  const before = (db.prepare("SELECT count(*) AS count FROM finance_transactions").get() as { count: number }).count;
  db.prepare(`INSERT INTO finance_subscriptions(
    id,name,direction,account_id,category_id,project_id,amount_minor,currency_code,cadence,interval_months,
    next_due_date,start_date,end_date,archived,note,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "s1", "Rent", "EXPENSE", "cash", "exp", "p1", 100, "UZS", "MONTHLY", null,
    "2026-09-15", "2026-01-01", null, 0, null, CREATED, CREATED,
  );
  const after = (db.prepare("SELECT count(*) AS count FROM finance_transactions").get() as { count: number }).count;
  assert.equal(after, before);
});

test("Finance modules remain isolated from CRM analytics and expose no delete path", () => {
  const files = [
    "../lib/finance/storage.ts", "../lib/finance/summary.ts", "../lib/finance/validation.ts",
    "../app/api/finance/accounts/route.ts", "../app/api/finance/transactions/route.ts",
    "../app/api/finance/categories/route.ts", "../app/api/finance/projects/route.ts",
    "../app/api/finance/subscriptions/route.ts", "../app/api/finance/summary/route.ts",
    "../drizzle/0007_finance_core.sql",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["analytics_records", "raw_deals", "deal_sales_snapshots", "sync_jobs", "BITRIX24_WEBHOOK_URL"]) {
    assert.equal(files.includes(forbidden), false, forbidden);
  }
  assert.equal(/export\s+(async\s+)?function\s+DELETE\b/.test(files), false);
  assert.equal(/\bDELETE\s+FROM\b/i.test(files), false);
});
