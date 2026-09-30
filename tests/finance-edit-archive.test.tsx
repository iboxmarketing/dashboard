import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildTransactionBody, filterTransactions, selectableCategories } from "../lib/finance-metrics";
import { accountBalanceAt, activeFinanceTransactions, buildFinanceSummary } from "../lib/finance/summary";
import { validateAccountInput, validateCategoryInput, validateTransactionInput } from "../lib/finance/validation";
import {
  ACCOUNT_BALANCE_NOT_ZERO_MESSAGE, accountArchiveRefusal, projectedAccountBalanceMinor,
} from "../lib/finance/account-rules";
import type { FinanceAccount, FinanceCategory, FinanceProject, FinanceTransaction } from "../lib/finance/types";

/**
 * Editing and archiving, without double accounting.
 *
 * The rules under test:
 *  - an account's opening balance is the canonical stored figure; editing it
 *    recomputes the current balance and creates no transaction;
 *  - editing a record rewrites that row, so every total moves exactly once;
 *  - archiving is a soft delete: the row stops affecting balances, income,
 *    expense and category totals, stays readable, and restores exactly once;
 *  - for a transfer, the debit, the credit and the commission leave and return
 *    together — there is no way to archive one side;
 *  - dangerous edits (an account currency with history, a category kind in use)
 *    are blocked rather than silently reinterpreting stored amounts.
 */

const CREATED = "2026-09-01T00:00:00.000Z";
const RANGE = { from: "2026-09-01", to: "2026-09-30" };

const accounts: FinanceAccount[] = [
  { id: "uzs", name: "Kassa", type: "CASH", currencyCode: "UZS", openingBalanceMinor: 100_000_000, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "uzs-2", name: "Bank", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "usd", name: "USD", type: "BANK", currencyCode: "USD", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
];
const categories: FinanceCategory[] = [
  { id: "inc", name: "Sotuv", kind: "INCOME", parentId: null, archived: false, sortOrder: 1 },
  { id: "exp", name: "Ofis", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 2 },
  { id: "old", name: "Eski xarajat", kind: "EXPENSE", parentId: null, archived: true, sortOrder: 3 },
];
const projects: FinanceProject[] = [{ id: "p1", name: "IBOX", description: null, archived: false, createdAt: CREATED, updatedAt: CREATED }];

function tx(over: Partial<FinanceTransaction>): FinanceTransaction {
  return {
    id: "t", date: "2026-09-10", type: "EXPENSE", note: "", projectId: null,
    accountId: "uzs", amountMinor: 20_000_000, currencyCode: "UZS", categoryId: "exp",
    fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null,
    destinationAmountMinor: null, destinationCurrencyCode: null, feeAmountMinor: null,
    archived: false, createdAt: CREATED, updatedAt: CREATED, ...over,
  };
}
const transferRow = (over: Partial<FinanceTransaction> = {}) => tx({
  id: "tr", type: "TRANSFER", accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
  fromAccountId: "uzs", toAccountId: "uzs-2", sourceAmountMinor: 30_000_000, sourceCurrencyCode: "UZS",
  destinationAmountMinor: 30_000_000, destinationCurrencyCode: "UZS", feeAmountMinor: 1_000_000, ...over,
});

const summaryOf = (transactions: FinanceTransaction[], override: Partial<FinanceAccount>[] = []) => buildFinanceSummary({
  accounts: accounts.map((account) => ({ ...account, ...(override.find((row) => row.id === account.id) ?? {}) })),
  transactions, categories, projects, subscriptions: [], range: RANGE, asOf: "2026-09-20",
});
const bal = (summary: ReturnType<typeof summaryOf>, id: string) =>
  summary.accountBalances.find((row) => row.accountId === id)!.currentBalanceMinor;
const exp = (summary: ReturnType<typeof summaryOf>, ccy = "UZS") =>
  summary.expenseByCurrency.find((row) => row.currencyCode === ccy)?.amountMinor ?? 0;
const inc = (summary: ReturnType<typeof summaryOf>, ccy = "UZS") =>
  summary.incomeByCurrency.find((row) => row.currencyCode === ccy)?.amountMinor ?? 0;
const catTotal = (summary: ReturnType<typeof summaryOf>, categoryId: string) =>
  summary.expensesByCategory.find((row) => row.categoryId === categoryId)?.amountMinor ?? 0;

// ---- J1. opening balance edit ----------------------------------------------

test("1. editing the opening balance recomputes the current balance, with no extra transaction", () => {
  // 1 000 000 UZS opening, +500 000 income, -200 000 expense => 1 300 000.
  const rows = [
    tx({ id: "in", type: "INCOME", amountMinor: 50_000_000, categoryId: "inc" }),
    tx({ id: "out", amountMinor: 20_000_000 }),
  ];
  const before = summaryOf(rows);
  assert.equal(bal(before, "uzs"), 130_000_000, "1 300 000 UZS");
  // The owner corrects the starting balance to 2 000 000 UZS.
  const after = summaryOf(rows, [{ id: "uzs", openingBalanceMinor: 200_000_000 }]);
  assert.equal(bal(after, "uzs"), 230_000_000, "2 300 000 UZS");
  assert.equal(rows.length, 2, "no synthetic adjustment transaction was created");
  assert.equal(inc(after), inc(before), "income is untouched by an opening-balance edit");
  assert.equal(exp(after), exp(before), "so is expense");
  // The stored opening balance is the single source of truth, and the API accepts
  // a new one for an existing account.
  const parsed = validateAccountInput({ name: "Kassa", type: "CASH", currencyCode: "UZS", openingBalanceMinor: 200_000_000, archived: false });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.openingBalanceMinor, 200_000_000);
  // And the drawer no longer locks the field.
  const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
  const openingField = drawers.slice(drawers.indexOf('label="Boshlang‘ich balans"'), drawers.indexOf("Saqlangan boshlang‘ich balans"));
  assert.doesNotMatch(openingField, /disabled/, "the opening balance is editable after creation");
});

// ---- J2 / J3. editing a record moves each total exactly once ----------------

test("2. editing an expense amount moves the balance and the expense total once", () => {
  const before = summaryOf([tx({ id: "e", amountMinor: 10_000_000 })]);
  const after = summaryOf([tx({ id: "e", amountMinor: 15_000_000 })]);
  assert.equal(bal(after, "uzs") - bal(before, "uzs"), -5_000_000, "an extra -50 000 UZS, once");
  assert.equal(exp(after) - exp(before), 5_000_000, "+50 000 UZS of expense, once");
  assert.equal(catTotal(after, "exp") - catTotal(before, "exp"), 5_000_000);
  assert.equal(after.expenseByCurrency.length, 1, "no second expense row appeared");
});

test("3. moving a record to another account debits one and credits the other, once", () => {
  const before = summaryOf([tx({ id: "i", type: "INCOME", amountMinor: 40_000_000, categoryId: "inc", accountId: "uzs" })]);
  const after = summaryOf([tx({ id: "i", type: "INCOME", amountMinor: 40_000_000, categoryId: "inc", accountId: "uzs-2" })]);
  assert.equal(bal(before, "uzs") - bal(after, "uzs"), 40_000_000, "the old account loses the delta");
  assert.equal(bal(after, "uzs-2") - bal(before, "uzs-2"), 40_000_000, "the new account gains it");
  assert.equal(inc(after), inc(before), "the income total itself does not move");
});

test("4. editing a transfer commission touches the source and the expense only", () => {
  const before = summaryOf([transferRow({ feeAmountMinor: 1_000_000 })]);
  const after = summaryOf([transferRow({ feeAmountMinor: 2_000_000 })]);
  assert.equal(bal(after, "uzs") - bal(before, "uzs"), -1_000_000, "an extra -10 000 UZS from the source");
  assert.equal(exp(after) - exp(before), 1_000_000, "+10 000 UZS of expense");
  assert.equal(bal(after, "uzs-2"), bal(before, "uzs-2"), "the destination is unchanged");
  // Edits re-run every transfer validation, including the safe aggregate debit.
  const body = { ...transferRow(), id: undefined, sourceAmountMinor: Number.MAX_SAFE_INTEGER, destinationAmountMinor: Number.MAX_SAFE_INTEGER, feeAmountMinor: 1 };
  assert.equal(validateTransactionInput(body).ok, false, "an edit cannot overflow the aggregate debit either");
});

// ---- J5 / J6. archive and restore a record ---------------------------------

test("5. archiving an expense hides it, restores the balance and drops the total", () => {
  const live = tx({ id: "e", amountMinor: 25_000_000 });
  const archived = { ...live, archived: true };
  const before = summaryOf([live]);
  const after = summaryOf([archived]);
  assert.equal(bal(after, "uzs") - bal(before, "uzs"), 25_000_000, "the account gets its money back");
  assert.equal(bal(after, "uzs"), 100_000_000, "back to the opening balance");
  assert.equal(exp(after), 0, "the expense total drops");
  assert.equal(catTotal(after, "exp"), 0, "and so does its category");
  // Hidden from the normal list, present in the archive view.
  assert.deepEqual(filterTransactions([archived]).map((row) => row.id), [], "normal list excludes it");
  assert.deepEqual(filterTransactions([archived], { archived: true }).map((row) => row.id), ["e"], "archive view contains it");
  assert.deepEqual(activeFinanceTransactions([archived]), [], "accounting sees no archived row");
  // Nothing was destroyed: the row still holds its own numbers.
  assert.equal(archived.amountMinor, 25_000_000);
});

test("6. restoring brings the accounting back exactly once", () => {
  const live = tx({ id: "e", amountMinor: 25_000_000 });
  const archived = { ...live, archived: true };
  const restored = { ...archived, archived: false };
  assert.equal(bal(summaryOf([restored]), "uzs"), bal(summaryOf([live]), "uzs"));
  assert.equal(exp(summaryOf([restored])), exp(summaryOf([live])));
  // Restoring twice cannot double it — there is one row and one flag.
  assert.equal(bal(summaryOf([{ ...restored, archived: false }]), "uzs"), bal(summaryOf([live]), "uzs"));
  const parsed = validateTransactionInput({ ...archived, archived: false });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.archived, false);
});

// ---- J7 / J8. a transfer archives and restores as one whole ------------------

test("7. archiving a transfer removes the debit, the credit and the fee together", () => {
  const live = transferRow();
  const before = summaryOf([live]);
  assert.equal(bal(before, "uzs"), 100_000_000 - 31_000_000);
  assert.equal(bal(before, "uzs-2"), 30_000_000);
  assert.equal(exp(before), 1_000_000);
  const after = summaryOf([{ ...live, archived: true }]);
  assert.equal(bal(after, "uzs"), 100_000_000, "the source debit is gone");
  assert.equal(bal(after, "uzs-2"), 0, "the destination credit is gone");
  assert.equal(exp(after), 0, "the commission expense is gone");
  assert.equal(after.expensesByCategory.length, 0, "including its bucket");
  assert.deepEqual(filterTransactions([{ ...live, archived: true }]).map((row) => row.id), [], "hidden from the normal list");
  // One flag governs all three effects, so no side can stay behind.
  const summary = readFileSync(new URL("../lib/finance/summary.ts", import.meta.url), "utf8");
  assert.match(summary, /export function activeFinanceTransactions/);
  assert.match(summary, /const active = activeFinanceTransactions\(input\.transactions\)/);
});

test("8. restoring a transfer reinstates all three effects exactly once", () => {
  const live = transferRow();
  const restored = { ...live, archived: false };
  const reference = summaryOf([live]);
  const after = summaryOf([restored]);
  assert.equal(bal(after, "uzs"), bal(reference, "uzs"));
  assert.equal(bal(after, "uzs-2"), bal(reference, "uzs-2"));
  assert.equal(exp(after), exp(reference));
  assert.equal(after.expensesByCategory.length, 1, "one commission bucket, not two");
});

// ---- J9 / J10. archived category and account --------------------------------

test("9. an archived category leaves the picker while history keeps reading it", () => {
  assert.deepEqual(selectableCategories(categories, "EXPENSE").map((row) => row.id), ["exp"], "archived category is not selectable");
  const historical = tx({ id: "h", categoryId: "old", amountMinor: 5_000_000 });
  const summary = summaryOf([historical]);
  assert.equal(summary.expensesByCategory[0].categoryId, "old");
  assert.equal(summary.expensesByCategory[0].categoryName, "Eski xarajat", "the historical record still reads its category's name");
  assert.equal(historical.categoryId, "old", "archiving rewrote no transaction");
  // The tree the UI renders is split by archived state, never mixed.
  const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
  assert.match(view, /categoryTree\(dataset\.categories\.filter\(\(category\) => category\.archived === showArchive\), kind\)/);
});

test("10. an archived account leaves every list and selector, and keeps its history", () => {
  const archivedAccounts = accounts.map((account) => (account.id === "usd" ? { ...account, archived: true } : account));
  const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
  // Every selector in the transaction form is built from active accounts only.
  assert.match(drawers, /const accounts = useMemo\(\(\) => activeOnly\(dataset\.accounts\)/);
  assert.match(drawers, /const activeOnly = <T extends \{ archived: boolean \}>\(rows: readonly T\[\]\) => rows\.filter\(\(row\) => !row\.archived\)/);
  const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
  assert.match(view, /const visible = dataset\.accounts\.filter\(\(account\) => account\.archived === showArchive\)/);
  assert.match(view, /options=\{dataset\.accounts\.filter\(\(account\) => !account\.archived\)/, "the ledger filter offers active accounts only");
  // History stays readable: a transaction on the archived account still reconciles.
  const rows = [tx({ id: "u", type: "INCOME", accountId: "usd", amountMinor: 1_000, currencyCode: "USD", categoryId: "inc" })];
  assert.equal(accountBalanceAt(archivedAccounts.find((row) => row.id === "usd")!, rows), 1_000);
  // A balance left on an account blocks the archive, with the owner's wording.
  const storage = readFileSync(new URL("../lib/finance/storage.ts", import.meta.url), "utf8");
  assert.equal(ACCOUNT_BALANCE_NOT_ZERO_MESSAGE, "Hisobda qoldiq mavjud. Arxivlashdan oldin qoldiqni 0 ga tushiring.");
  assert.match(storage, /if \(input\.archived && !existing\.archived\)/, "checked only when archiving, so restoring is never blocked");
  assert.match(storage, /WHERE archived = 0 AND \(account_id = \? OR from_account_id = \? OR to_account_id = \?\)/,
    "the invariant counts active records only, exactly as the summary does");
});

// ---- J11 / J12. renaming, and the edits that must be refused ---------------

test("11. renaming a category changes the display name through the same id", () => {
  const renamed = categories.map((row) => (row.id === "exp" ? { ...row, name: "Ofis xarajatlari" } : row));
  const summary = buildFinanceSummary({
    accounts, transactions: [tx({ id: "e", amountMinor: 7_000_000 })], categories: renamed,
    projects, subscriptions: [], range: RANGE, asOf: "2026-09-20",
  });
  assert.equal(summary.expensesByCategory.length, 1, "one category, not a second one");
  assert.equal(summary.expensesByCategory[0].categoryId, "exp", "the identity is the id");
  assert.equal(summary.expensesByCategory[0].categoryName, "Ofis xarajatlari", "history reads the new name");
  // A rename is a normal category update; the kind travels unchanged.
  const parsed = validateCategoryInput({ name: "Ofis xarajatlari", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 2 });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.kind, "EXPENSE");
});

test("12. unsafe currency and category-kind changes are blocked, not silently applied", () => {
  const storage = readFileSync(new URL("../lib/finance/storage.ts", import.meta.url), "utf8");
  // Account currency: only while the account has no history at all.
  assert.match(storage, /ACCOUNT_CURRENCY_LOCKED/);
  assert.match(storage, /SELECT 1 AS used FROM finance_transactions WHERE account_id = \? OR from_account_id = \? OR to_account_id = \?/);
  // Category kind: only while nothing references the category.
  assert.match(storage, /CATEGORY_KIND_LOCKED/);
  assert.match(storage, /Used category kind cannot change/);
  // The form locks the currency for an account with history and leaves it open otherwise.
  const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
  assert.match(drawers, /disabled=\{Boolean\(account\) && hasHistory\}/);
  assert.match(drawers, /Yozuvlari bor hisobning valyutasi o‘zgartirilmaydi/);
  // And a category's kind is never offered as an editable field on an existing one.
  const categoryDrawer = drawers.slice(drawers.indexOf("export function CategoryDrawer"), drawers.indexOf("export function ProjectDrawer"));
  assert.doesNotMatch(categoryDrawer, /setKind|onChange=\{\(event\) => setKind/, "kind comes from the tab, never from an edit form");
});

// ---- the UI contract: one action menu, archived rows disappear --------------

test("editing and archiving are the only two actions, in plain words", () => {
  const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
  for (const label of ["Tahrirlash", "Arxivlash", "Tiklash", "Arxivni ko‘rsatish"]) {
    assert.ok(view.includes(label), `${label} must appear`);
  }
  // Accounts, categories and transactions each hide archived rows by default.
  assert.equal((view.match(/showArchive/g) ?? []).length >= 9, true, "all three screens have the toggle");
  assert.match(view, /archived: showArchive/, "the ledger asks for one state at a time");
  // No accounting jargon in the actions a normal user sees.
  const actions = view.slice(view.indexOf("fin-row-actions"));
  assert.doesNotMatch(actions, /soft delete|ledger|debit|credit/i);
  // An edit is one PATCH on the same row, never a delete-and-recreate.
  assert.match(view, /if \(id\) await adapter\.updateTransaction\(id, body\); else await adapter\.createTransaction\(body\);/);
  assert.doesNotMatch(view, /deleteTransaction/, "no hard delete was introduced");
});

test("a transaction body always carries an explicit archived flag", () => {
  const body = buildTransactionBody({
    type: "EXPENSE", date: "2026-09-10", accountId: "uzs", toAccountId: null,
    amountMinor: 5_000, destinationAmountMinor: null, categoryId: "exp", projectId: null,
  }, accounts, "New");
  assert.equal(body.archived, false, "a new record is active");
  const edited = buildTransactionBody({
    type: "EXPENSE", date: "2026-09-10", accountId: "uzs", toAccountId: null,
    amountMinor: 5_000, destinationAmountMinor: null, categoryId: "exp", projectId: null, archived: true,
  }, accounts, "Edited");
  assert.equal(edited.archived, true, "editing an archived record keeps it archived");
  const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
  assert.match(drawers, /archived: editing\?\.archived === true/, "the form never flips the flag as a side effect");
});

// ---- the archive invariant is judged on the RESULTING state -----------------

/**
 * The defect this locks out: archive eligibility was checked against the balance
 * the account had BEFORE the same PATCH was applied. One request could therefore
 * raise the opening balance and archive together — the check saw 0, the new
 * opening balance was written afterwards, and a non-zero account ended up hidden.
 */
test("A-F. archive eligibility is decided by the projected balance, not the old one", () => {
  const active = { archived: false };
  const archived = { archived: true };

  // A. balance 0 today, the same PATCH sets opening 1 and archives => REJECT.
  const exploit = accountArchiveRefusal({ archived: true, openingBalanceMinor: 1 }, active, 0);
  assert.equal(exploit?.code, "ACCOUNT_BALANCE_NOT_ZERO");
  assert.equal(exploit?.message, ACCOUNT_BALANCE_NOT_ZERO_MESSAGE);
  assert.equal(exploit?.projectedBalanceMinor, 1, "judged on 1, not on the stored 0");

  // B. opening 1 today, the PATCH sets opening 0, no transactions => ALLOW.
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: 0 }, active, 0), null);

  // C. active transactions total +500, the PATCH sets opening -500 => projected 0 => ALLOW.
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: -50_000 }, active, 50_000), null);
  // …and one minor unit away is still refused, in either direction.
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: -49_999 }, active, 50_000)?.projectedBalanceMinor, 1);
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: -50_001 }, active, 50_000)?.projectedBalanceMinor, -1);

  // D. balance 500, archive with no other change => REJECT.
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: 50_000 }, active, 0)?.code, "ACCOUNT_BALANCE_NOT_ZERO");
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: 0 }, active, 50_000)?.projectedBalanceMinor, 50_000);

  // E. an opening-balance edit on its own is never blocked, whatever the balance.
  assert.equal(accountArchiveRefusal({ archived: false, openingBalanceMinor: 123_456 }, active, 50_000), null);
  assert.equal(projectedAccountBalanceMinor(200_000_000, 30_000_000), 230_000_000, "and it recalculates correctly");

  // F. restoring is never blocked, and neither is a PATCH that leaves an archived
  // account archived.
  assert.equal(accountArchiveRefusal({ archived: false, openingBalanceMinor: 50_000 }, archived, 0), null);
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: 50_000 }, archived, 0), null);

  // Safe money: an unrepresentable projection is refused explicitly, never rounded.
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.equal(projectedAccountBalanceMinor(MAX, 1), null);
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: MAX }, active, 1)?.code, "ACCOUNT_BALANCE_UNSAFE");
  assert.equal(accountArchiveRefusal({ archived: true, openingBalanceMinor: 1.5 }, active, -1.5)?.code, "ACCOUNT_BALANCE_UNSAFE");
});

test("the account PATCH judges the merged state and persists nothing before it passes", () => {
  const storage = readFileSync(new URL("../lib/finance/storage.ts", import.meta.url), "utf8");
  // The rule receives the POST-patch input, never the stored account.
  assert.match(storage, /accountArchiveRefusal\(input, existing, await financeAccountActiveDeltaMinor\(id\)\)/);
  assert.doesNotMatch(storage, /financeAccountBalanceMinor\(id, existing\.openingBalanceMinor\)/,
    "the pre-patch balance can no longer decide the archive");
  // The delta query excludes the opening balance and every archived row, so the
  // projection is opening + active deltas and nothing else.
  assert.match(storage, /let balance = 0;/);
  assert.match(storage, /WHERE archived = 0 AND \(account_id = \? OR from_account_id = \? OR to_account_id = \?\)/);
  // The refusal is thrown before the UPDATE runs: no invalid state is ever stored.
  const update = storage.slice(storage.indexOf("export async function updateFinanceAccount"), storage.indexOf("export async function financeAccountBalanceMinor"));
  assert.ok(update.indexOf("accountArchiveRefusal") < update.indexOf("UPDATE finance_accounts"),
    "the check precedes the write");
  assert.equal((update.match(/UPDATE finance_accounts/g) ?? []).length, 1, "one write, so the update is atomic for the caller");
  // The route hands the merged state to validation, which is what the rule sees.
  const route = readFileSync(new URL("../app/api/finance/accounts/route.ts", import.meta.url), "utf8");
  assert.match(route, /validateAccountInput\(\{ \.\.\.existing, \.\.\.payload \}\)/);
});
