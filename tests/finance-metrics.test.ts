import assert from "node:assert/strict";
import test from "node:test";

import { addMoney, currenciesIn, formatMoney, moneyLines, subtractByCurrency, sumByCurrency } from "../lib/finance-money";
import {
  accountBalances, advanceDueDate, addDays, buildTransactionBody, cadenceMonths, categoryBreakdown,
  categoryTree, filterTransactions, overviewModel, projectSpending, selectableCategories,
  subscriptionBuckets, summarize, transferShape, validateTransaction,
} from "../lib/finance-metrics";
import { FINANCE_FIXTURES, cloneFixtures } from "../lib/finance-fixtures";
import type { FinanceAccount, FinanceTransaction, MoneyByCurrency } from "../lib/finance-types";

/**
 * Finance calculations.
 *
 * The rule under test everywhere: money is per-currency. There is no code path
 * that produces one number across UZS and USD, and a transfer is neither income
 * nor expense.
 */

const account = (over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: "a1", name: "Kassa", type: "CASH", currency: "UZS", openingBalance: 0, currentBalance: 0, status: "ACTIVE", ...over,
});
const tx = (over: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id: "t1", date: "2026-09-10", type: "EXPENSE", accountId: "a1", toAccountId: null, categoryId: null,
  projectId: null, description: "", amount: 100, currency: "UZS", toAmount: null, toCurrency: null, ...over,
});

// ------------------------------------------------------------------- money ---

test("amounts are summed per currency and never combined", () => {
  const total = sumByCurrency(
    [tx({ amount: 1000, currency: "UZS" }), tx({ amount: 20, currency: "USD" }), tx({ amount: 500, currency: "UZS" })],
    (row) => ({ amount: row.amount, currency: row.currency }),
  );
  assert.deepEqual(total, { UZS: 1500, USD: 20 });
  // The shape itself forbids a grand total: it is a map, not a number.
  assert.equal(typeof total, "object");
  assert.deepEqual(currenciesIn(total), ["UZS", "USD"]);
});

test("sums run in minor units so floating point cannot drift", () => {
  let total: MoneyByCurrency = {};
  for (let index = 0; index < 10; index += 1) total = addMoney(total, "USD", 0.1);
  assert.equal(total.USD, 1);
  assert.deepEqual(addMoney(addMoney({}, "USD", 0.1), "USD", 0.2), { USD: 0.3 }, "0.1 + 0.2 is exactly 0.3 here");
});

test("subtraction keeps every currency present on either side", () => {
  assert.deepEqual(subtractByCurrency({ UZS: 100, USD: 5 }, { UZS: 40 }), { UZS: 60, USD: 5 });
  assert.deepEqual(subtractByCurrency({ UZS: 40 }, { UZS: 100, EUR: 3 }), { UZS: -60, EUR: -3 });
});

test("money renders one currency at a time, with UZS whole", () => {
  assert.equal(formatMoney(125_400_000, "UZS"), "125 400 000 UZS");
  // uz-UZ uses a comma decimal separator, matching the rest of the dashboard.
  assert.equal(formatMoney(4200.5, "USD"), "4 200,50 USD");
  assert.deepEqual(moneyLines({ UZS: 10, USD: 0 }).map((line) => line.currency), ["UZS"], "a zero currency is not rendered");
  assert.deepEqual(moneyLines({}).length, 0);
});

// ------------------------------------------------------------------ summary ---

test("a transfer is neither income nor expense", () => {
  const summary = summarize([
    tx({ id: "1", type: "INCOME", amount: 1000 }),
    tx({ id: "2", type: "EXPENSE", amount: 400 }),
    tx({ id: "3", type: "TRANSFER", amount: 900, toAccountId: "a2" }),
  ], { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(summary.income, { UZS: 1000 });
  assert.deepEqual(summary.expense, { UZS: 400 });
  assert.deepEqual(summary.net, { UZS: 600 }, "the transfer does not move the net");
});

test("the summary keeps currencies apart, including a negative net", () => {
  const summary = summarize([
    tx({ id: "1", type: "INCOME", amount: 1000, currency: "UZS" }),
    tx({ id: "2", type: "EXPENSE", amount: 40, currency: "USD" }),
  ], { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(summary.net, { UZS: 1000, USD: -40 });
  assert.equal(Object.keys(summary.net).length, 2, "two currencies, two figures — never one");
});

// ------------------------------------------------------------------ filters ---

test("filters combine as OR inside a dimension and AND across dimensions", () => {
  const rows = [
    tx({ id: "1", type: "EXPENSE", accountId: "a1", categoryId: "c1", projectId: "p1" }),
    tx({ id: "2", type: "INCOME", accountId: "a2", categoryId: "c2", projectId: "p1" }),
    tx({ id: "3", type: "EXPENSE", accountId: "a2", categoryId: "c1", projectId: "p2" }),
  ];
  assert.deepEqual(filterTransactions(rows, {}).map((r) => r.id), ["1", "2", "3"], "no selection means all");
  assert.deepEqual(filterTransactions(rows, { accountIds: ["a1", "a2"] }).map((r) => r.id), ["1", "2", "3"], "OR within accounts");
  assert.deepEqual(filterTransactions(rows, { types: ["EXPENSE"], projectIds: ["p1"] }).map((r) => r.id), ["1"], "AND across dimensions");
  assert.deepEqual(filterTransactions(rows, { from: "2026-09-11" }).map((r) => r.id), []);
  assert.deepEqual(filterTransactions(rows, { search: "nothing" }).map((r) => r.id), []);
});

test("an account filter matches a transfer from either side", () => {
  const transfer = tx({ id: "t", type: "TRANSFER", accountId: "a1", toAccountId: "a2" });
  assert.equal(filterTransactions([transfer], { accountIds: ["a2"] }).length, 1, "the destination counts too");
  assert.equal(filterTransactions([transfer], { accountIds: ["a9"] }).length, 0);
});

test("a currency filter matches both sides of a cross-currency transfer", () => {
  const transfer = tx({ id: "t", type: "TRANSFER", accountId: "a1", toAccountId: "a2", currency: "UZS", toAmount: 1000, toCurrency: "USD" });
  assert.equal(filterTransactions([transfer], { currencies: ["USD"] }).length, 1);
  assert.equal(filterTransactions([transfer], { currencies: ["EUR"] }).length, 0);
});

// --------------------------------------------------------------- breakdowns ---

test("account balances group by currency and never add across them", () => {
  const balances = accountBalances([
    account({ id: "a1", currency: "UZS", currentBalance: 100 }),
    account({ id: "a2", currency: "UZS", currentBalance: 50 }),
    account({ id: "a3", currency: "USD", currentBalance: 7 }),
    account({ id: "a4", currency: "UZS", currentBalance: 999, status: "ARCHIVED" }),
  ]);
  assert.deepEqual(balances.totals, { UZS: 150, USD: 7 });
  assert.deepEqual(balances.byCurrency.map((g) => [g.currency, g.total]), [["UZS", 150], ["USD", 7]]);
  assert.equal(balances.activeCount, 3);
  assert.equal(balances.archived.length, 1, "archived money is reported separately, not silently dropped");
});

test("subcategory spend rolls up to the parent and uncategorised gets its own row", () => {
  const categories = [
    { id: "p", name: "Marketing", kind: "EXPENSE" as const, parentId: null, status: "ACTIVE" as const },
    { id: "c", name: "Reklama", kind: "EXPENSE" as const, parentId: "p", status: "ACTIVE" as const },
  ];
  const rows = categoryBreakdown([
    tx({ id: "1", categoryId: "c", amount: 300 }),
    tx({ id: "2", categoryId: "p", amount: 200 }),
    tx({ id: "3", categoryId: null, amount: 10 }),
  ], categories, "EXPENSE");
  const marketing = rows.find((row) => row.categoryId === "p");
  assert.deepEqual(marketing?.byCurrency, { UZS: 500 }, "the subcategory folds into its parent");
  assert.equal(marketing?.transactions, 2);
  assert.ok(rows.some((row) => row.categoryId === null && row.label === "Kategoriyasiz"));
});

test("a transaction may have no Project, and that appears as its own row", () => {
  const rows = projectSpending([
    tx({ id: "1", type: "EXPENSE", projectId: "p1", amount: 100 }),
    tx({ id: "2", type: "EXPENSE", projectId: null, amount: 40 }),
    tx({ id: "3", type: "INCOME", projectId: "p1", amount: 500 }),
  ], [{ id: "p1", name: "IBOX", description: null, status: "ACTIVE" }]);
  const none = rows.find((row) => row.projectId === null);
  assert.ok(none, "a project-less transaction is never dropped");
  assert.equal(none?.name, "Project belgilanmagan");
  const ibox = rows.find((row) => row.projectId === "p1");
  assert.deepEqual(ibox?.income, { UZS: 500 });
  assert.deepEqual(ibox?.expense, { UZS: 100 });
  assert.deepEqual(ibox?.net, { UZS: 400 });
});

test("project rows exclude transfers, which are not performance", () => {
  const rows = projectSpending([tx({ id: "t", type: "TRANSFER", projectId: "p1", amount: 900, toAccountId: "a2" })], []);
  assert.deepEqual(rows, []);
});

// ------------------------------------------------------------- category tree ---

test("the category tree is one level and never mixes income with expense", () => {
  const categories = [
    { id: "e1", name: "Ofis", kind: "EXPENSE" as const, parentId: null, status: "ACTIVE" as const },
    { id: "e2", name: "Ijara", kind: "EXPENSE" as const, parentId: "e1", status: "ACTIVE" as const },
    { id: "i1", name: "Mijoz", kind: "INCOME" as const, parentId: null, status: "ACTIVE" as const },
  ];
  const expense = categoryTree(categories, "EXPENSE");
  assert.deepEqual(expense.map((node) => node.parent.id), ["e1"]);
  assert.deepEqual(expense[0].children.map((child) => child.id), ["e2"]);
  const income = categoryTree(categories, "INCOME");
  assert.deepEqual(income.map((node) => node.parent.id), ["i1"]);
  assert.deepEqual(income[0].children, [], "an expense child never appears under an income parent");
});

test("the category picker offers only the matching kind, and nothing for a transfer", () => {
  const categories = [
    { id: "e1", name: "Ofis", kind: "EXPENSE" as const, parentId: null, status: "ACTIVE" as const },
    { id: "i1", name: "Mijoz", kind: "INCOME" as const, parentId: null, status: "ACTIVE" as const },
    { id: "e2", name: "Eski", kind: "EXPENSE" as const, parentId: null, status: "ARCHIVED" as const },
  ];
  assert.deepEqual(selectableCategories(categories, "EXPENSE").map((c) => c.id), ["e1"], "archived is not selectable");
  assert.deepEqual(selectableCategories(categories, "INCOME").map((c) => c.id), ["i1"]);
  assert.deepEqual(selectableCategories(categories, "TRANSFER"), [], "a transfer has no category");
});

// ------------------------------------------------------------------ transfer ---

test("a same-currency transfer needs one amount; a cross-currency transfer needs both", () => {
  const uzs = account({ id: "a1", currency: "UZS" });
  const usd = account({ id: "a2", currency: "USD" });
  const other = account({ id: "a3", currency: "UZS" });

  assert.equal(transferShape(uzs, other).crossCurrency, false);
  assert.equal(transferShape(uzs, other).requiresBothAmounts, false);
  const cross = transferShape(uzs, usd);
  assert.equal(cross.crossCurrency, true);
  assert.equal(cross.requiresBothAmounts, true);
  assert.equal(cross.fromCurrency, "UZS");
  assert.equal(cross.toCurrency, "USD");
});

test("no FX rate is ever applied: the second amount comes only from the user", () => {
  const accounts = [account({ id: "a1", currency: "UZS" }), account({ id: "a2", currency: "USD" })];
  const draft = { type: "TRANSFER" as const, date: "2026-09-14", accountId: "a1", toAccountId: "a2", amount: 12_600_000, toAmount: null, categoryId: null, projectId: null };
  assert.deepEqual(validateTransaction(draft, accounts), { ok: false, error: "Har ikki summani kiriting" });

  const body = buildTransactionBody({ ...draft, toAmount: 1000 }, accounts, "Valyuta");
  assert.equal(body.amount, 12_600_000);
  assert.equal(body.currency, "UZS");
  assert.equal(body.toAmount, 1000, "exactly what the user typed");
  assert.equal(body.toCurrency, "USD");
  // No rate is stored anywhere on the body.
  assert.equal("rate" in body, false);
  assert.equal("fxRate" in body, false);
});

test("a same-currency transfer carries no second amount", () => {
  const accounts = [account({ id: "a1", currency: "UZS" }), account({ id: "a2", currency: "UZS" })];
  const body = buildTransactionBody(
    { type: "TRANSFER", date: "2026-09-12", accountId: "a1", toAccountId: "a2", amount: 15_000_000, toAmount: null, categoryId: null, projectId: null },
    accounts, "Kassadan bankka",
  );
  assert.equal(body.toAmount, null);
  assert.equal(body.toCurrency, null);
  assert.equal(body.categoryId, null, "a transfer has no category");
  assert.equal(body.projectId, null, "a transfer has no project");
});

test("validation rejects an empty, zero or same-account transaction", () => {
  const accounts = [account({ id: "a1" }), account({ id: "a2" })];
  const base = { type: "EXPENSE" as const, date: "2026-09-10", accountId: "a1", toAccountId: null, amount: 100, toAmount: null, categoryId: null, projectId: null };
  assert.equal(validateTransaction(base, accounts).ok, true);
  assert.equal(validateTransaction({ ...base, accountId: "" }, accounts).error, "Hisobni tanlang");
  assert.equal(validateTransaction({ ...base, amount: 0 }, accounts).error, "Summani kiriting");
  assert.equal(validateTransaction({ ...base, amount: null }, accounts).error, "Summani kiriting");
  assert.equal(validateTransaction({ ...base, date: "" }, accounts).error, "Sanani kiriting");
  assert.equal(validateTransaction({ ...base, type: "TRANSFER", toAccountId: "a1" }, accounts).error, "Hisoblar bir xil bo‘lmasligi kerak");
  assert.equal(validateTransaction({ ...base, type: "TRANSFER", toAccountId: null }, accounts).error, "Qabul qiluvchi hisobni tanlang");
});

test("an income or expense needs no Project to be valid", () => {
  const accounts = [account({ id: "a1" })];
  for (const type of ["INCOME", "EXPENSE"] as const) {
    const result = validateTransaction(
      { type, date: "2026-09-10", accountId: "a1", toAccountId: null, amount: 10, toAmount: null, categoryId: null, projectId: null },
      accounts,
    );
    assert.deepEqual(result, { ok: true, error: null }, type);
  }
});

// ------------------------------------------------------------ subscriptions ---

test("subscriptions split into overdue, upcoming, later and archived", () => {
  const buckets = subscriptionBuckets(FINANCE_FIXTURES.subscriptions, { today: "2026-09-20" });
  assert.deepEqual(buckets.overdue.map((s) => s.id), ["sub-2"], "due 2026-09-18 is overdue");
  assert.deepEqual(buckets.upcoming.map((s) => s.id), ["sub-1", "sub-5", "sub-3"], "sorted by due date");
  assert.deepEqual(buckets.later.map((s) => s.id), ["sub-4"]);
  assert.deepEqual(buckets.archived.map((s) => s.id), ["sub-6"], "archived never appears as upcoming");
});

test("the expected subscription outflow stays per currency", () => {
  const buckets = subscriptionBuckets(FINANCE_FIXTURES.subscriptions, { today: "2026-09-20" });
  assert.deepEqual(buckets.upcomingByCurrency, { UZS: 10_050_000, USD: 25 });
  assert.equal(Object.keys(buckets.upcomingByCurrency).length, 2, "two currencies, never one blended figure");
});

test("cadence is described, and a custom cadence needs a valid interval", () => {
  assert.equal(cadenceMonths({ cadence: "MONTHLY", intervalMonths: null }), 1);
  assert.equal(cadenceMonths({ cadence: "QUARTERLY", intervalMonths: null }), 3);
  assert.equal(cadenceMonths({ cadence: "YEARLY", intervalMonths: null }), 12);
  assert.equal(cadenceMonths({ cadence: "CUSTOM_MONTHS", intervalMonths: 4 }), 4);
  assert.equal(cadenceMonths({ cadence: "CUSTOM_MONTHS", intervalMonths: 0 }), null);
  assert.equal(cadenceMonths({ cadence: "CUSTOM_MONTHS", intervalMonths: null }), null);
});

test("the next due date advances by calendar month and clamps a short month", () => {
  assert.equal(advanceDueDate({ cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-09-25" }), "2026-10-25");
  assert.equal(advanceDueDate({ cadence: "QUARTERLY", intervalMonths: null, nextDueDate: "2026-10-01" }), "2027-01-01");
  assert.equal(advanceDueDate({ cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-01-31" }), "2026-02-28", "clamped, not rolled into March");
  assert.equal(advanceDueDate({ cadence: "CUSTOM_MONTHS", intervalMonths: 4, nextDueDate: "2026-09-28" }), "2027-01-28");
  assert.equal(addDays("2026-09-20", 30), "2026-10-20");
});

// ------------------------------------------------------------------ overview ---

test("the overview model computes every panel from one filtered dataset", () => {
  const model = overviewModel(cloneFixtures(), { from: "2026-09-01", to: "2026-09-19" }, "2026-09-20");
  assert.deepEqual(model.summary.income, { UZS: 43_250_000, USD: 1_800 });
  assert.deepEqual(model.summary.expense, { UZS: 44_450_000, USD: 640 });
  assert.deepEqual(model.summary.net, { UZS: -1_200_000, USD: 1_160 });
  assert.deepEqual(model.balances.totals, { UZS: 196_770_000, USD: 4_200 });
  assert.ok(model.expenseByCategory.length > 0);
  assert.ok(model.incomeByCategory.length > 0);
  assert.ok(model.projects.some((row) => row.projectId === null), "the project-less row is present");
  assert.equal(model.transactionCount, 10);
  // Still no combined figure anywhere in the model.
  assert.equal(typeof model.summary.net, "object");
});
