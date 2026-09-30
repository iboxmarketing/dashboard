import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { accountBalanceAt, buildFinanceSummary } from "../lib/finance/summary";
import {
  OCCURRENCE_CONFIRM, OCCURRENCE_EXPENSE_INSERT, OCCURRENCE_INSERT, OCCURRENCE_KEEP_PENDING,
  OCCURRENCE_RETRY_INSUFFICIENT, OCCURRENCE_RETRY_SUFFICIENT, OCCURRENCE_SELECT, OCCURRENCE_SKIP,
  SUBSCRIPTION_ADVANCE_DUE_DATE,
} from "../lib/finance/occurrence-sql";
import {
  balanceVerdict, billingAnchorDay, isUnresolvedOccurrence, nextOccurrenceDate, occurrenceId,
  occurrenceTransactionId, subscriptionStateLabel, subscriptionsDueOn,
} from "../lib/finance/occurrences";
import { validateSubscriptionInput } from "../lib/finance/validation";
import type { FinanceSubscription } from "../lib/finance/types";

/**
 * Subscriptions become recurring expense candidates — and nothing more.
 *
 * The owner's rule (2026-09-30): when an occurrence becomes due the balance is
 * checked ONCE. Not enough money means the system stops and waits for a manual
 * *Qayta urinish*; it never polls, and it never charges anything by itself. Enough
 * money produces a DRAFT that affects no balance and no total until the owner
 * confirms the real card charge.
 *
 * These tests drive the lifecycle through the SAME SQL the Worker runs, against a
 * SQLite database built from the real migrations, so the idempotency guarantees
 * are tested where they actually live.
 */

const CREATED = "2026-09-01T00:00:00.000Z";
const NOW = "2026-09-30T06:00:00.000Z";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

const strip = (file: string) => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replace(/-->.*$/gm, "");

/** USD account with `openingMinor`, one expense category, one monthly subscription. */
function financeDb(openingMinor: number, amountMinor = 2_000) {
  const db = new DatabaseSync!(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0007_finance_core.sql", "0012_transfer_fee.sql", "0013_transaction_archive.sql", "0014_subscription_occurrences.sql"]) {
    db.exec(strip(file));
  }
  db.prepare("INSERT INTO finance_accounts(id,name,type,currency_code,opening_balance_minor,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("usd", "USD karta", "CARD", "USD", openingMinor, 0, CREATED, CREATED);
  db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)")
    .run("tools", "Dasturlar", "EXPENSE", null, 0, 1);
  db.prepare(`INSERT INTO finance_subscriptions(
      id,name,direction,account_id,category_id,project_id,amount_minor,currency_code,cadence,interval_months,
      next_due_date,start_date,end_date,archived,note,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("sub", "Cloudflare", "EXPENSE", "usd", "tools", null, amountMinor, "USD", "MONTHLY", null,
      "2026-09-25", "2026-03-25", null, 0, null, CREATED, CREATED);
  return db;
}

type Db = import("node:sqlite").DatabaseSync;
const subscription = (db: Db) => db.prepare("SELECT * FROM finance_subscriptions WHERE id = 'sub'").get() as Record<string, unknown>;
const occurrences = (db: Db) => db.prepare(`${OCCURRENCE_SELECT} ORDER BY due_date`).all() as Record<string, unknown>[];
const expenses = (db: Db) => db.prepare("SELECT id, amount_minor, account_id, category_id, date FROM finance_transactions WHERE type = 'EXPENSE'").all() as Record<string, unknown>[];

/** The account's balance from the ledger, exactly as the summary computes it. */
function balance(db: Db) {
  const account = db.prepare("SELECT id, name, type, currency_code, opening_balance_minor, archived, created_at, updated_at FROM finance_accounts WHERE id = 'usd'").get() as Record<string, unknown>;
  const rows = (db.prepare("SELECT * FROM finance_transactions").all() as Record<string, unknown>[]).map((row) => ({
    ...row, id: String(row.id), date: String(row.date), type: String(row.type),
    accountId: row.account_id === null ? null : String(row.account_id),
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    fromAccountId: row.from_account_id === null ? null : String(row.from_account_id),
    toAccountId: row.to_account_id === null ? null : String(row.to_account_id),
    sourceAmountMinor: row.source_amount_minor === null ? null : Number(row.source_amount_minor),
    destinationAmountMinor: row.destination_amount_minor === null ? null : Number(row.destination_amount_minor),
    feeAmountMinor: row.fee_amount_minor === null ? null : Number(row.fee_amount_minor),
    archived: Number(row.archived) === 1,
  }));
  return accountBalanceAt({
    id: "usd", name: String(account.name), type: "CARD", currencyCode: "USD",
    openingBalanceMinor: Number(account.opening_balance_minor), archived: false, createdAt: CREATED, updatedAt: CREATED,
  }, rows as never);
}

/** The scheduler pass, as `sweepDueSubscriptions` performs it. */
function sweep(db: Db, today = "2026-09-30", now = NOW) {
  const rows = [row(db)];
  let created = 0;
  for (const subscriptionRow of subscriptionsDueOn(rows, today)) {
    const id = occurrenceId(subscriptionRow.id, subscriptionRow.nextDueDate);
    const existing = db.prepare(`${OCCURRENCE_SELECT} WHERE id = ?`).get(id);
    // An existing occurrence is left completely alone: no second row, and above
    // all NO second balance check.
    if (existing) continue;
    const verdict = balanceVerdict(subscriptionRow.amountMinor, balance(db));
    db.prepare(OCCURRENCE_INSERT).run(
      id, subscriptionRow.id, subscriptionRow.nextDueDate, verdict.status, subscriptionRow.direction,
      subscriptionRow.accountId, subscriptionRow.categoryId, subscriptionRow.projectId,
      subscriptionRow.amountMinor, subscriptionRow.currencyCode, balance(db), verdict.missingMinor, now, now, now,
    );
    created += 1;
  }
  return created;
}

function row(db: Db): FinanceSubscription {
  const stored = subscription(db);
  return {
    id: String(stored.id), name: String(stored.name), direction: String(stored.direction) as "EXPENSE",
    accountId: String(stored.account_id), categoryId: String(stored.category_id),
    projectId: stored.project_id === null ? null : String(stored.project_id),
    amountMinor: Number(stored.amount_minor), currencyCode: String(stored.currency_code),
    cadence: String(stored.cadence) as FinanceSubscription["cadence"],
    intervalMonths: stored.interval_months === null ? null : Number(stored.interval_months),
    nextDueDate: String(stored.next_due_date), startDate: String(stored.start_date),
    endDate: stored.end_date === null ? null : String(stored.end_date),
    archived: Number(stored.archived) === 1, note: null, createdAt: CREATED, updatedAt: CREATED,
  };
}

/** *Tasdiqlash*: post the Expense, confirm the occurrence, advance the due date. */
function confirm(db: Db, id: string, now = NOW) {
  const occurrence = db.prepare(`${OCCURRENCE_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>;
  if (String(occurrence.status) !== "REVIEW_REQUIRED") return false;
  const transactionId = occurrenceTransactionId({ id });
  db.prepare(OCCURRENCE_EXPENSE_INSERT).run(
    transactionId, String(occurrence.due_date), "Cloudflare",
    occurrence.project_id === null || occurrence.project_id === undefined ? null : String(occurrence.project_id),
    String(occurrence.account_id),
    Number(occurrence.amount_minor), String(occurrence.currency_code), String(occurrence.category_id), now, now,
  );
  db.prepare(OCCURRENCE_CONFIRM).run(transactionId, now, now, id);
  db.prepare(SUBSCRIPTION_ADVANCE_DUE_DATE).run(
    nextOccurrenceDate(row(db), String(occurrence.due_date)), now, String(occurrence.subscription_id), String(occurrence.due_date),
  );
  return true;
}

function retry(db: Db, id: string, now = NOW) {
  const occurrence = db.prepare(`${OCCURRENCE_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>;
  if (String(occurrence.status) !== "INSUFFICIENT_FUNDS") return false;
  const available = balance(db);
  const verdict = balanceVerdict(Number(occurrence.amount_minor), available);
  if (verdict.sufficient) db.prepare(OCCURRENCE_RETRY_SUFFICIENT).run(available, now, now, id);
  else db.prepare(OCCURRENCE_RETRY_INSUFFICIENT).run(available, verdict.missingMinor, now, now, id);
  return verdict.sufficient;
}

function skip(db: Db, id: string, now = NOW) {
  const occurrence = db.prepare(`${OCCURRENCE_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>;
  db.prepare(OCCURRENCE_SKIP).run(now, now, id);
  db.prepare(SUBSCRIPTION_ADVANCE_DUE_DATE).run(
    nextOccurrenceDate(row(db), String(occurrence.due_date)), now, String(occurrence.subscription_id), String(occurrence.due_date),
  );
}

/** Top up the account so a retry can find the money. */
const topUp = (db: Db, amountMinor: number, id = "topup") => db.prepare(`INSERT INTO finance_transactions(
    id,date,type,note,project_id,account_id,amount_minor,currency_code,category_id,
    from_account_id,to_account_id,source_amount_minor,source_currency_code,
    destination_amount_minor,destination_currency_code,fee_amount_minor,archived,created_at,updated_at
  ) VALUES(?,?,'INCOME',?,NULL,'usd',?,'USD',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,?,?)`)
  .run(id, "2026-09-29", "Top up", amountMinor, incomeCategory(db), CREATED, CREATED);

function incomeCategory(db: Db) {
  const existing = db.prepare("SELECT id FROM finance_categories WHERE kind = 'INCOME'").get() as { id: string } | undefined;
  if (existing) return existing.id;
  db.prepare("INSERT INTO finance_categories(id,name,kind,parent_id,archived,sort_order) VALUES(?,?,?,?,?,?)").run("in", "Kirim", "INCOME", null, 0, 2);
  return "in";
}

// ---- A. enough money: draft, then confirm ----------------------------------

test("A. 45 USD account, 20 USD due: one draft, balance untouched, then confirmed once", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  assert.equal(sweep(db), 1);
  const [occurrence] = occurrences(db);
  assert.equal(occurrence.status, "REVIEW_REQUIRED");
  assert.equal(occurrence.available_balance_minor, 4_500);
  assert.equal(occurrence.missing_amount_minor, 0);
  assert.equal(occurrences(db).length, 1, "exactly one occurrence");
  assert.equal(expenses(db).length, 0, "the draft is not a posted Expense");
  assert.equal(balance(db), 4_500, "45 USD, unchanged by the draft");
  assert.equal(subscription(db).next_due_date, "2026-09-25", "the due date has not advanced");

  assert.equal(confirm(db, String(occurrence.id)), true);
  assert.equal(balance(db), 2_500, "25 USD after the real charge");
  assert.deepEqual(expenses(db).map((row) => Number(row.amount_minor)), [2_000]);
  assert.equal(occurrences(db)[0].status, "CONFIRMED");
  assert.equal(occurrences(db)[0].transaction_id, `subocc::${occurrence.id}`, "the Expense is linked to its occurrence");
  assert.equal(subscription(db).next_due_date, "2026-10-25", "and only now does the due date advance");
});

// ---- B. not enough money: no draft, and no automatic retry ------------------

test("B. 12 USD account, 20 USD due: INSUFFICIENT_FUNDS, and ten more sweeps change nothing", { skip: !DatabaseSync }, () => {
  const db = financeDb(1_200, 2_000);
  assert.equal(sweep(db), 1);
  const [occurrence] = occurrences(db);
  assert.equal(occurrence.status, "INSUFFICIENT_FUNDS");
  assert.equal(occurrence.available_balance_minor, 1_200);
  assert.equal(occurrence.missing_amount_minor, 800, "8 USD short");
  assert.equal(expenses(db).length, 0, "no draft Expense exists at all");
  assert.equal(balance(db), 1_200, "the balance is untouched");

  const checkedAt = occurrence.balance_checked_at;
  for (let pass = 0; pass < 10; pass += 1) assert.equal(sweep(db), 0, `sweep ${pass + 1} creates nothing`);
  assert.equal(occurrences(db).length, 1, "still one occurrence");
  assert.equal(occurrences(db)[0].status, "INSUFFICIENT_FUNDS");
  assert.equal(occurrences(db)[0].balance_checked_at, checkedAt, "the balance was never rechecked automatically");
  assert.equal(expenses(db).length, 0);
  assert.equal(subscription(db).next_due_date, "2026-09-25", "the obligation does not stack up");
});

// ---- C / D / F. the manual retry -------------------------------------------

test("C. adding funds changes nothing until the owner retries, and then the SAME occurrence becomes the draft", { skip: !DatabaseSync }, () => {
  const db = financeDb(1_200, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  topUp(db, 1_300); // balance becomes 25 USD
  assert.equal(balance(db), 2_500);
  assert.equal(occurrences(db)[0].status, "INSUFFICIENT_FUNDS", "nothing happens on its own");
  for (let pass = 0; pass < 3; pass += 1) sweep(db);
  assert.equal(occurrences(db)[0].status, "INSUFFICIENT_FUNDS", "not even the scheduler moves it");

  assert.equal(retry(db, id), true);
  assert.equal(occurrences(db).length, 1, "the same occurrence, not a new one");
  assert.equal(occurrences(db)[0].id, id);
  assert.equal(occurrences(db)[0].status, "REVIEW_REQUIRED");
  assert.equal(occurrences(db)[0].missing_amount_minor, 0);
  assert.equal(expenses(db).length, 0, "the draft posts no Expense; the top-up is income");
  assert.equal(subscription(db).next_due_date, "2026-09-25", "retry does not advance the due date");
});

test("D. retrying repeatedly leaves one draft", { skip: !DatabaseSync }, () => {
  const db = financeDb(1_200, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  topUp(db, 1_300);
  for (let click = 0; click < 5; click += 1) retry(db, id);
  assert.equal(occurrences(db).length, 1);
  assert.equal(occurrences(db)[0].status, "REVIEW_REQUIRED");
  assert.equal(expenses(db).filter((row) => String(row.id).startsWith("subocc::")).length, 0, "no Expense from a retry");
});

test("F. retrying while still short keeps the occurrence where it is", { skip: !DatabaseSync }, () => {
  const db = financeDb(1_200, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  topUp(db, 300); // 15 USD — still 5 USD short
  assert.equal(retry(db, id), false);
  assert.equal(occurrences(db)[0].status, "INSUFFICIENT_FUNDS");
  assert.equal(occurrences(db)[0].available_balance_minor, 1_500, "the row now shows what is really there");
  assert.equal(occurrences(db)[0].missing_amount_minor, 500, "and what is still missing");
  assert.equal(expenses(db).length, 0, "no Expense was posted");
  assert.equal(balance(db), 1_500);
});

// ---- E. confirm is idempotent ----------------------------------------------

test("E. confirming repeatedly posts exactly one Expense and advances the due date once", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  for (let click = 0; click < 5; click += 1) confirm(db, id);
  const posted = expenses(db).filter((row) => String(row.id).startsWith("subocc::"));
  assert.equal(posted.length, 1, "one Expense, however many clicks");
  assert.equal(balance(db), 2_500, "charged once");
  assert.equal(subscription(db).next_due_date, "2026-10-25", "advanced once");
  // Even running the raw statements again cannot double anything.
  const transactionId = occurrenceTransactionId({ id });
  db.prepare(OCCURRENCE_EXPENSE_INSERT).run(transactionId, "2026-09-25", "Cloudflare", null, "usd", 2_000, "USD", "tools", NOW, NOW);
  db.prepare(SUBSCRIPTION_ADVANCE_DUE_DATE).run("2026-11-25", NOW, "sub", "2026-09-25");
  assert.equal(expenses(db).filter((row) => String(row.id).startsWith("subocc::")).length, 1);
  assert.equal(subscription(db).next_due_date, "2026-10-25", "the guarded advance ignores a stale due date");
});

// ---- G. not charged yet ----------------------------------------------------

test("G. \"Hali yechilmadi\" changes no money and no due date", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  db.prepare(OCCURRENCE_KEEP_PENDING).run("2026-09-30T08:00:00.000Z", "2026-09-30T08:00:00.000Z", id);
  assert.equal(occurrences(db)[0].status, "REVIEW_REQUIRED", "it stays pending");
  assert.equal(occurrences(db)[0].balance_checked_at, "2026-09-30T08:00:00.000Z", "the check is recorded");
  assert.equal(occurrences(db).length, 1, "no second draft");
  assert.equal(expenses(db).length, 0);
  assert.equal(balance(db), 4_500);
  assert.equal(subscription(db).next_due_date, "2026-09-25");
});

// ---- H. skip ---------------------------------------------------------------

test("H. skipping posts no Expense and advances the due date, keeping the history", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  sweep(db);
  const id = String(occurrences(db)[0].id);
  skip(db, id);
  assert.equal(occurrences(db)[0].status, "SKIPPED");
  assert.equal(expenses(db).length, 0, "no Expense");
  assert.equal(balance(db), 4_500, "no balance change");
  assert.equal(subscription(db).next_due_date, "2026-10-25");
  assert.equal(occurrences(db).length, 1, "the skipped occurrence stays in history");
  // The next period is a NEW occurrence, and only after the previous one resolved.
  assert.equal(sweep(db, "2026-10-26"), 1);
  assert.deepEqual(occurrences(db).map((row) => row.status), ["SKIPPED", "REVIEW_REQUIRED"]);
  assert.deepEqual(occurrences(db).map((row) => row.due_date), ["2026-09-25", "2026-10-25"]);
});

// ---- I. a draft is invisible to accounting ---------------------------------

test("I. a draft affects no balance, no expense total and no category total", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  sweep(db);
  const rows = (db.prepare("SELECT * FROM finance_transactions").all() as Record<string, unknown>[]);
  assert.deepEqual(rows, [], "the draft is not a transaction at all");
  const summary = buildFinanceSummary({
    accounts: [{ id: "usd", name: "USD karta", type: "CARD", currencyCode: "USD", openingBalanceMinor: 4_500, archived: false, createdAt: CREATED, updatedAt: CREATED }],
    transactions: [], categories: [{ id: "tools", name: "Dasturlar", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 1 }],
    projects: [], subscriptions: [], range: { from: "2026-09-01", to: "2026-09-30" }, asOf: "2026-09-30",
  });
  assert.equal(summary.expenseByCurrency.length, 0, "no expense total");
  assert.equal(summary.expensesByCategory.length, 0, "no category total");
  assert.equal(summary.accountBalances[0].currentBalanceMinor, 4_500, "45 USD stays 45 USD");
  assert.equal(summary.operatingByCurrency.length, 0, "and no cash flow");
});

// ---- J / K / L. paused, currency, recurrence -------------------------------

test("J. a paused or income subscription generates nothing", { skip: !DatabaseSync }, () => {
  const db = financeDb(4_500, 2_000);
  db.prepare("UPDATE finance_subscriptions SET archived = 1 WHERE id = 'sub'").run();
  assert.equal(sweep(db), 0);
  assert.equal(occurrences(db).length, 0);
  db.prepare("UPDATE finance_subscriptions SET archived = 0 WHERE id = 'sub'").run();
  // An income subscription cannot even be filed under an expense category — the
  // schema refuses it — and the sweep ignores income subscriptions regardless.
  assert.throws(() => db.prepare("UPDATE finance_subscriptions SET direction = 'INCOME' WHERE id = 'sub'").run(),
    /finance subscription references are invalid/);
  // And the pure filter says the same thing without a database.
  const base = { ...({} as FinanceSubscription), id: "s", name: "S", accountId: "a", categoryId: "c", projectId: null,
    amountMinor: 1, currencyCode: "USD", cadence: "MONTHLY" as const, intervalMonths: null,
    nextDueDate: "2026-09-01", startDate: "2026-01-01", endDate: null, note: null, createdAt: CREATED, updatedAt: CREATED };
  assert.equal(subscriptionsDueOn([{ ...base, direction: "EXPENSE", archived: true }], "2026-09-30").length, 0);
  assert.equal(subscriptionsDueOn([{ ...base, direction: "INCOME", archived: false }], "2026-09-30").length, 0);
  assert.equal(subscriptionsDueOn([{ ...base, direction: "EXPENSE", archived: false }], "2026-09-30").length, 1);
  // A future due date is not due yet, and an ended subscription stops.
  assert.equal(subscriptionsDueOn([{ ...base, direction: "EXPENSE", archived: false, nextDueDate: "2026-10-30" }], "2026-09-30").length, 0);
  assert.equal(subscriptionsDueOn([{ ...base, direction: "EXPENSE", archived: false, endDate: "2026-08-01" }], "2026-09-30").length, 0);
  assert.equal(subscriptionStateLabel({ archived: true }), "Pauzada");
  assert.equal(subscriptionStateLabel({ archived: false }), "Faol");
  assert.equal(subscriptionStateLabel({ archived: false }, { status: "REVIEW_REQUIRED" }), "Tasdiqlash kutilmoqda");
  assert.equal(subscriptionStateLabel({ archived: false }, { status: "INSUFFICIENT_FUNDS" }), "Mablag‘ yetarli emas");
  assert.equal(subscriptionStateLabel({ archived: false }, { status: "CONFIRMED" }), "Faol", "a resolved occurrence is not a state");
});

test("K. a subscription whose currency differs from its account is rejected", () => {
  const base = {
    name: "Cloudflare", direction: "EXPENSE", accountId: "usd", categoryId: "tools", projectId: null,
    amountMinor: 2_000, currencyCode: "USD", cadence: "MONTHLY", intervalMonths: null,
    nextDueDate: "2026-10-25", startDate: "2026-03-25", endDate: null, archived: false, note: null,
  };
  assert.equal(validateSubscriptionInput(base).ok, true);
  // The account's currency is checked in storage; the shape check catches the rest.
  const storage = readFileSync(new URL("../lib/finance/storage.ts", import.meta.url), "utf8");
  assert.match(storage, /Subscription currency must match Account currency/);
  const occurrenceStorage = readFileSync(new URL("../lib/finance/occurrence-storage.ts", import.meta.url), "utf8");
  assert.match(occurrenceStorage, /SUBSCRIPTION_CURRENCY_MISMATCH/, "and the sweep refuses to guess an exchange rate");
  assert.doesNotMatch(occurrenceStorage, /transferRate|exchange/i, "no FX anywhere near a subscription charge");
});

test("L. monthly recurrence returns to the intended billing day after a short month", () => {
  const monthly = { cadence: "MONTHLY" as const, intervalMonths: null, startDate: "2026-01-31" };
  assert.equal(billingAnchorDay(monthly), 31);
  assert.equal(nextOccurrenceDate(monthly, "2026-01-31"), "2026-02-28", "February uses its last valid day");
  assert.equal(nextOccurrenceDate(monthly, "2026-02-28"), "2026-03-31", "March returns to the 31st");
  assert.equal(nextOccurrenceDate(monthly, "2026-03-31"), "2026-04-30");
  assert.equal(nextOccurrenceDate(monthly, "2026-04-30"), "2026-05-31");
  // A leap February, and the ordinary case.
  assert.equal(nextOccurrenceDate({ ...monthly, startDate: "2028-01-31" }, "2028-01-31"), "2028-02-29");
  assert.equal(nextOccurrenceDate({ cadence: "MONTHLY", intervalMonths: null, startDate: "2026-03-25" }, "2026-09-25"), "2026-10-25");
  // Quarterly, yearly and custom cadences keep the same anchor.
  assert.equal(nextOccurrenceDate({ cadence: "QUARTERLY", intervalMonths: null, startDate: "2026-01-31" }, "2026-01-31"), "2026-04-30");
  assert.equal(nextOccurrenceDate({ cadence: "YEARLY", intervalMonths: null, startDate: "2026-02-29" }, "2028-02-29"), "2029-02-28");
  assert.equal(nextOccurrenceDate({ cadence: "CUSTOM_MONTHS", intervalMonths: 2, startDate: "2026-01-31" }, "2026-01-31"), "2026-03-31");
  // An unreadable cadence never silently skips a period.
  assert.equal(nextOccurrenceDate({ cadence: "CUSTOM_MONTHS", intervalMonths: null, startDate: "2026-01-31" }, "2026-01-31"), "2026-01-31");
});

// ---- the identity, and what the scheduler is allowed to do ------------------

test("the occurrence identity is subscription + due date, everywhere", () => {
  assert.equal(occurrenceId("sub", "2026-09-25"), "sub::2026-09-25");
  assert.equal(occurrenceTransactionId({ id: "sub::2026-09-25" }), "subocc::sub::2026-09-25");
  assert.equal(isUnresolvedOccurrence("REVIEW_REQUIRED"), true);
  assert.equal(isUnresolvedOccurrence("INSUFFICIENT_FUNDS"), true);
  assert.equal(isUnresolvedOccurrence("CONFIRMED"), false);
  assert.equal(isUnresolvedOccurrence("SKIPPED"), false);
  // Every write is guarded by the state it must come from, in the SQL itself.
  assert.match(OCCURRENCE_INSERT, /INSERT OR IGNORE/);
  assert.match(OCCURRENCE_EXPENSE_INSERT, /INSERT OR IGNORE/);
  assert.match(OCCURRENCE_RETRY_SUFFICIENT, /WHERE id = \? AND status = 'INSUFFICIENT_FUNDS'/);
  assert.match(OCCURRENCE_CONFIRM, /WHERE id = \? AND status = 'REVIEW_REQUIRED'/);
  assert.match(OCCURRENCE_SKIP, /WHERE id = \? AND status IN \('REVIEW_REQUIRED', 'INSUFFICIENT_FUNDS'\)/);
  assert.match(SUBSCRIPTION_ADVANCE_DUE_DATE, /WHERE id = \? AND next_due_date = \?/);
  // The sweep never rechecks an existing occurrence, and never advances a due date.
  const sweepSource = readFileSync(new URL("../lib/finance/occurrence-storage.ts", import.meta.url), "utf8");
  const sweepBody = sweepSource.slice(sweepSource.indexOf("export async function sweepDueSubscriptions"), sweepSource.indexOf("function requireOccurrence"));
  assert.match(sweepBody, /if \(existing\) \{[^}]*continue; \}/, "an existing occurrence ends the work for that subscription");
  assert.doesNotMatch(sweepBody, /SUBSCRIPTION_ADVANCE_DUE_DATE|OCCURRENCE_RETRY/, "the scheduler neither retries nor advances");
  // The cron calls it once per Tashkent day, and nothing else.
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /ctx\.waitUntil\(runDailySubscriptionSweep\(\)/);
  const daily = readFileSync(new URL("../lib/finance/scheduled-subscriptions.ts", import.meta.url), "utf8");
  assert.match(daily, /if \(state\?\.lastRunDay === day\) return \{ ran: false, reason: "ALREADY_RAN_TODAY" \}/);
  assert.match(daily, /timeZone: "Asia\/Tashkent"/);
});

test("existing subscriptions are never backfilled", { skip: !DatabaseSync }, () => {
  // A subscription whose due date is months in the past produces ONE occurrence,
  // for that date — not one per missed period.
  const db = financeDb(50_000, 2_000);
  db.prepare("UPDATE finance_subscriptions SET next_due_date = '2026-06-25' WHERE id = 'sub'").run();
  assert.equal(sweep(db, "2026-09-30"), 1);
  assert.deepEqual(occurrences(db).map((row) => row.due_date), ["2026-06-25"]);
  assert.equal(expenses(db).length, 0, "and nothing is auto-confirmed");
  // Resolving it advances one period at a time, so nothing is invented for the gap.
  confirm(db, String(occurrences(db)[0].id));
  assert.equal(subscription(db).next_due_date, "2026-07-25");
  assert.equal(expenses(db).length, 1, "exactly one Expense per confirmed period");
});
