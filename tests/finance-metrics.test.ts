import assert from "node:assert/strict";
import test from "node:test";
import { buildFinanceSummary } from "../lib/finance/summary";
import { addMoney, formatMoney, moneyInputStep, moneyInputValue, parseMoneyInput, subtractByCurrency } from "../lib/finance-money";
import {
  accountBalanceGroups, accountCurrentBalanceMinor, advanceDueDate, buildTransactionBody, cadenceMonths, categoryTree,
  filterTransactions, operatingMaps, projectAmountRows, selectableCategories, subscriptionBuckets,
  transferShape, validateTransaction,
} from "../lib/finance-metrics";
import { FINANCE_FIXTURES, cloneFixtures } from "../lib/finance-fixtures";
import type { FinanceAccount, FinanceTransaction, MoneyByCurrency } from "../lib/finance-types";

const account = (over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: "a1", name: "Kassa", type: "CASH", currencyCode: "UZS", openingBalanceMinor: 0,
  archived: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over,
});
const tx = (over: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id: "t1", date: "2026-09-10", type: "EXPENSE", note: "", projectId: null,
  accountId: "a1", amountMinor: 10_000, currencyCode: "UZS", categoryId: "cat-ex-1",
  fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null,
  destinationAmountMinor: null, destinationCurrencyCode: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over,
});

test("human major input parses exactly to integer minor units", () => {
  assert.equal(parseMoneyInput("0.10", "USD"), 10);
  assert.equal(parseMoneyInput("1250000.25", "UZS"), 125_000_025);
  assert.equal(parseMoneyInput("1.001", "USD"), null);
  assert.equal(parseMoneyInput("0.1", "USD"), 10);
  assert.equal(moneyInputValue(125_025, "USD"), "1250.25");
});

test("minor-unit formatting uses backend currency metadata", () => {
  assert.match(formatMoney(420_050, "USD"), /4[,.\s]200[,.]50|4,200\.50/);
  assert.match(formatMoney(12_500_000, "UZS"), /125[,.\s]000/);
});

test("UI parsing, formatting and input precision follow supplied backend currency metadata", () => {
  const zeroDecimalUzs = { code: "UZS", minorUnit: 0 };
  assert.equal(parseMoneyInput("1250", zeroDecimalUzs), 1_250);
  assert.equal(parseMoneyInput("12.50", zeroDecimalUzs), null);
  assert.equal(moneyInputValue(1_250, zeroDecimalUzs), "1250");
  assert.equal(moneyInputStep(zeroDecimalUzs), "1");
  assert.match(formatMoney(1_250, zeroDecimalUzs), /1[,.\s]250/);
});

test("integer money adds per currency and never creates a mixed grand total", () => {
  let totals: MoneyByCurrency = {};
  totals = addMoney(totals, "UZS", 100);
  totals = addMoney(totals, "UZS", 50);
  totals = addMoney(totals, "USD", 20);
  assert.deepEqual(totals, { UZS: 150, USD: 20 });
  assert.deepEqual(subtractByCurrency({ UZS: 100, USD: 5 }, { UZS: 40 }), { UZS: 60, USD: 5 });
});

test("transaction filters use canonical account and transfer fields", () => {
  const rows = [
    tx({ id: "expense", accountId: "a1", projectId: "p1" }),
    tx({ id: "income", type: "INCOME", accountId: "a2", projectId: "p2", categoryId: "cat-in-1" }),
    tx({ id: "transfer", type: "TRANSFER", accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
      fromAccountId: "a1", toAccountId: "a2", sourceAmountMinor: 100, sourceCurrencyCode: "UZS",
      destinationAmountMinor: 1, destinationCurrencyCode: "USD" }),
  ];
  assert.deepEqual(filterTransactions(rows, { accountIds: ["a2"] }).map((row) => row.id), ["income", "transfer"]);
  assert.deepEqual(filterTransactions(rows, { currencies: ["USD"] }).map((row) => row.id), ["transfer"]);
  assert.deepEqual(filterTransactions(rows, { types: ["EXPENSE"], projectIds: ["p1"] }).map((row) => row.id), ["expense"]);
});

test("same-currency transfer request mirrors one explicit amount; cross-currency keeps both user amounts", () => {
  const uzs1 = account({ id: "uzs-1" });
  const uzs2 = account({ id: "uzs-2" });
  const usd = account({ id: "usd", currencyCode: "USD" });
  const base = { type: "TRANSFER" as const, date: "2026-09-20", accountId: "uzs-1", amountMinor: 1_250_000, categoryId: null, projectId: null };
  const same = buildTransactionBody({ ...base, toAccountId: "uzs-2", destinationAmountMinor: null }, [uzs1, uzs2], "same");
  assert.equal(same.sourceAmountMinor, 1_250_000);
  assert.equal(same.destinationAmountMinor, 1_250_000);
  const cross = buildTransactionBody({ ...base, toAccountId: "usd", destinationAmountMinor: 100 }, [uzs1, usd], "cross");
  assert.equal(cross.sourceAmountMinor, 1_250_000);
  assert.equal(cross.destinationAmountMinor, 100);
  assert.equal(cross.destinationCurrencyCode, "USD");
  assert.equal("rate" in cross, false);
});

test("cross-currency transfer requires both amounts and never guesses FX", () => {
  const accounts = [account({ id: "uzs" }), account({ id: "usd", currencyCode: "USD" })];
  const draft = { type: "TRANSFER" as const, date: "2026-09-20", accountId: "uzs", toAccountId: "usd", amountMinor: 1_250_000, destinationAmountMinor: null, categoryId: null, projectId: null };
  assert.equal(validateTransaction(draft, accounts).error, "Har ikki summani kiriting");
  assert.equal(transferShape(accounts[0], accounts[1]).crossCurrency, true);
});

test("income and expense require a category while Finance Project remains optional", () => {
  const accounts = [account()];
  const base = { type: "EXPENSE" as const, date: "2026-09-20", accountId: "a1", toAccountId: null, amountMinor: 100, destinationAmountMinor: null, categoryId: null, projectId: null };
  assert.equal(validateTransaction(base, accounts).error, "Kategoriyani tanlang");
  assert.deepEqual(validateTransaction({ ...base, categoryId: "cat-ex-1" }, accounts), { ok: true, error: null });
});

test("server summary remains the authority and excludes transfers from operating totals", () => {
  const fixture = cloneFixtures();
  const summary = buildFinanceSummary({ ...fixture, range: { from: "2026-09-01", to: "2026-09-30" }, asOf: "2026-09-20" });
  const maps = operatingMaps(summary);
  assert.deepEqual(maps.income, { UZS: 4_200_000_000, USD: 180_000 });
  assert.deepEqual(maps.expense, { UZS: 4_445_000_000, USD: 64_000 });
  assert.deepEqual(maps.net, { UZS: -245_000_000, USD: 116_000 });
});

test("server account balances are grouped by currency without blending", () => {
  const balances = accountBalanceGroups(FINANCE_FIXTURES.summary);
  assert.deepEqual(balances.groups.map((row) => row.currencyCode), ["USD", "UZS"]);
  assert.equal(Object.keys(balances.totals).length, 2);
  assert.equal(balances.archived.length, 1);
});

test("Account current balance comes only from summary and malformed or missing values never become NaN", () => {
  const accountId = FINANCE_FIXTURES.accounts[0].id;
  const expected = FINANCE_FIXTURES.summary.accountBalances.find((row) => row.accountId === accountId)!.currentBalanceMinor;
  assert.equal(accountCurrentBalanceMinor(FINANCE_FIXTURES.summary, accountId), expected);
  assert.equal(accountCurrentBalanceMinor(FINANCE_FIXTURES.summary, "missing"), null);
  const malformed = structuredClone(FINANCE_FIXTURES.summary);
  malformed.accountBalances[0].currentBalanceMinor = Number.NaN;
  assert.equal(accountCurrentBalanceMinor(malformed, accountId), null);
  assert.equal(accountBalanceGroups(malformed).groups.every((group) => Number.isSafeInteger(group.totalMinor)), true);
});

test("server project rows are only presentation-grouped, never recomputed from transactions", () => {
  const rows = projectAmountRows(FINANCE_FIXTURES.summary.projectBreakdown);
  const ibox = rows.find((row) => row.projectId === "prj-1");
  assert.deepEqual(ibox?.income, { UZS: 4_200_000_000 });
  assert.deepEqual(ibox?.expense, { UZS: 2_850_000_000 });
});

test("category tree is one level, same-kind, and archived categories are not selectable", () => {
  const expense = categoryTree(FINANCE_FIXTURES.categories, "EXPENSE");
  assert.ok(expense.some((node) => node.children.some((child) => child.id === "cat-ex-3")));
  const withArchived = [...FINANCE_FIXTURES.categories, { id: "old", name: "Old", kind: "EXPENSE" as const, parentId: null, archived: true, sortOrder: 99 }];
  assert.equal(selectableCategories(withArchived, "EXPENSE").some((row) => row.id === "old"), false);
  assert.deepEqual(selectableCategories(withArchived, "TRANSFER"), []);
});

test("subscriptions remain reminders grouped from authoritative nextDueDate", () => {
  const buckets = subscriptionBuckets(FINANCE_FIXTURES.subscriptions, { today: "2026-09-20" });
  assert.deepEqual(buckets.overdue.map((row) => row.id), ["sub-2"]);
  assert.deepEqual(buckets.upcoming.map((row) => row.id), ["sub-1", "sub-5", "sub-3"]);
  assert.deepEqual(buckets.upcomingByCurrency, { UZS: 1_005_000_000, USD: 2_500 });
});

test("subscription cadence helpers never create or mutate a Transaction", () => {
  const before = FINANCE_FIXTURES.transactions.length;
  assert.equal(cadenceMonths({ cadence: "CUSTOM_MONTHS", intervalMonths: 4 }), 4);
  assert.equal(advanceDueDate({ cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-01-31" }), "2026-02-28");
  assert.equal(FINANCE_FIXTURES.transactions.length, before);
});
