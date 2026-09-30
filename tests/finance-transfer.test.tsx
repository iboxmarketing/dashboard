import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildTransactionBody, validateTransaction } from "../lib/finance-metrics";
import { buildFinanceSummary, accountBalanceAt } from "../lib/finance/summary";
import { sumMinor } from "../lib/finance/money";
import {
  TRANSFER_FEE_CATEGORY_ID, TRANSFER_FEE_CATEGORY_NAME,
  transferFeeMinor, transferRate, transferSettlement,
} from "../lib/finance/transfer";
import { validateTransactionInput } from "../lib/finance/validation";
import { renderToStaticMarkup } from "react-dom/server";
import { TransferBreakdown } from "../app/finance/finance-view-exports";
import { TRANSFER_LABELS } from "../lib/finance/transfer";
import type { FinanceAccount, FinanceCategory, FinanceProject, FinanceTransaction } from "../lib/finance/types";

/**
 * Transfers, commission and the derived rate.
 *
 * The model under test:
 *   source      -(sourceAmountMinor + feeAmountMinor)
 *   destination  +destinationAmountMinor
 *   commission   an EXPENSE in the source currency, under one system bucket
 *
 * The transfer itself is neither Income nor Expense; no FX rate is ever invented,
 * fetched or persisted; and both amounts are entered by the person who made the
 * transfer, so nothing is derived from the other with floating-point math.
 */

const CREATED = "2026-09-01T00:00:00.000Z";
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
/** 20 000 000.00 UZS opening balance, as in the brief's example. */
const UZS_OPENING = 2_000_000_000;

const accounts: FinanceAccount[] = [
  { id: "uzs", name: "Kassa", type: "CASH", currencyCode: "UZS", openingBalanceMinor: UZS_OPENING, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "uzs-2", name: "Bank UZS", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "usd", name: "USD hisob", type: "BANK", currencyCode: "USD", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "eur", name: "EUR hisob", type: "BANK", currencyCode: "EUR", openingBalanceMinor: 0, archived: false, createdAt: CREATED, updatedAt: CREATED },
  { id: "closed", name: "Yopilgan hisob", type: "BANK", currencyCode: "UZS", openingBalanceMinor: 0, archived: true, createdAt: CREATED, updatedAt: CREATED },
];
const categories: FinanceCategory[] = [
  { id: "inc", name: "Sotuv", kind: "INCOME", parentId: null, archived: false, sortOrder: 1 },
  { id: "exp", name: "Ofis", kind: "EXPENSE", parentId: null, archived: false, sortOrder: 2 },
];
const projects: FinanceProject[] = [{ id: "p1", name: "IBOX", description: null, archived: false, createdAt: CREATED, updatedAt: CREATED }];

function transfer(over: Partial<FinanceTransaction> = {}): FinanceTransaction {
  return {
    id: "tr", date: "2026-09-10", type: "TRANSFER", note: "", projectId: null,
    accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
    fromAccountId: "uzs", toAccountId: "uzs-2",
    sourceAmountMinor: 100_000_000, sourceCurrencyCode: "UZS",
    destinationAmountMinor: 100_000_000, destinationCurrencyCode: "UZS",
    feeAmountMinor: 0, createdAt: CREATED, updatedAt: CREATED, ...over,
  };
}

function summaryOf(transactions: FinanceTransaction[]) {
  return buildFinanceSummary({ accounts, transactions, categories, projects, subscriptions: [], range: RANGE, asOf: "2026-09-20" });
}
const balance = (summary: ReturnType<typeof summaryOf>, accountId: string) =>
  summary.accountBalances.find((row) => row.accountId === accountId)!.currentBalanceMinor;
const expenseOf = (summary: ReturnType<typeof summaryOf>, currencyCode: string) =>
  summary.expenseByCurrency.find((row) => row.currencyCode === currencyCode)?.amountMinor ?? 0;
const feeBucket = (summary: ReturnType<typeof summaryOf>, currencyCode: string) =>
  summary.expensesByCategory.find((row) => row.categoryId === TRANSFER_FEE_CATEGORY_ID && row.currencyCode === currencyCode);

// ---- A. same currency, no commission ---------------------------------------

test("A. same-currency transfer without commission moves money and creates no expense", () => {
  const rows = [transfer({ sourceAmountMinor: 100_000_000, destinationAmountMinor: 100_000_000, feeAmountMinor: 0 })];
  const settlement = transferSettlement(rows[0])!;
  assert.equal(settlement.sourceDeltaMinor, -100_000_000);
  assert.equal(settlement.destinationDeltaMinor, 100_000_000);
  assert.equal(settlement.feeMinor, 0);
  assert.equal(transferRate(rows[0]), null, "no rate for one currency");
  const summary = summaryOf(rows);
  assert.equal(balance(summary, "uzs"), UZS_OPENING - 100_000_000);
  assert.equal(balance(summary, "uzs-2"), 100_000_000);
  assert.equal(expenseOf(summary, "UZS"), 0, "a transfer is not an expense");
  assert.equal(summary.incomeByCurrency.length, 0, "and not income either");
  assert.equal(feeBucket(summary, "UZS"), undefined, "no commission bucket without a commission");
});

// ---- B. same currency + commission -----------------------------------------

test("B. same-currency transfer with commission: source pays both, destination receives the full amount", () => {
  const rows = [transfer({ feeAmountMinor: 1_000_000 })];
  const settlement = transferSettlement(rows[0])!;
  assert.equal(settlement.sourceDeltaMinor, -101_000_000, "1 010 000.00 UZS leaves the source");
  assert.equal(settlement.destinationDeltaMinor, 100_000_000, "the commission is never taken out of what arrived");
  const summary = summaryOf(rows);
  assert.equal(balance(summary, "uzs"), UZS_OPENING - 101_000_000);
  assert.equal(balance(summary, "uzs-2"), 100_000_000);
  assert.equal(expenseOf(summary, "UZS"), 1_000_000, "only the commission is an expense");
  assert.equal(feeBucket(summary, "UZS")?.categoryName, TRANSFER_FEE_CATEGORY_NAME);
  assert.equal(feeBucket(summary, "UZS")?.amountMinor, 1_000_000);
  assert.equal(summary.operatingByCurrency.find((row) => row.currencyCode === "UZS")?.netCashFlowMinor, -1_000_000);
});

// ---- C / D. cross-currency, both directions --------------------------------

test("C. UZS -> USD: both amounts authoritative, rate derived, fee in UZS", () => {
  // 12 500 000 UZS sent, 1 000 USD received, 50 000 UZS commission.
  const row = transfer({
    toAccountId: "usd", sourceAmountMinor: 1_250_000_000, destinationAmountMinor: 100_000,
    destinationCurrencyCode: "USD", feeAmountMinor: 5_000_000,
  });
  const settlement = transferSettlement(row)!;
  assert.equal(settlement.sourceDeltaMinor, -1_255_000_000, "12 550 000 UZS leaves the source");
  assert.equal(settlement.destinationDeltaMinor, 100_000, "1 000 USD arrives");
  assert.equal(transferRate(row)!.label, "1 USD = 12 500 UZS");
  const summary = summaryOf([row]);
  assert.equal(balance(summary, "uzs"), UZS_OPENING - 1_255_000_000, "7 450 000 UZS left");
  assert.equal(balance(summary, "uzs"), 745_000_000);
  assert.equal(balance(summary, "usd"), 100_000);
  assert.equal(expenseOf(summary, "UZS"), 5_000_000);
  assert.equal(expenseOf(summary, "USD"), 0, "the commission belongs to the source currency only");
});

test("D. USD -> UZS: the rate still reads per USD, and the fee is charged in USD", () => {
  // 1 000 USD sent, 12 400 000 UZS received, 5 USD commission.
  const row = transfer({
    fromAccountId: "usd", toAccountId: "uzs", sourceAmountMinor: 100_000, sourceCurrencyCode: "USD",
    destinationAmountMinor: 1_240_000_000, destinationCurrencyCode: "UZS", feeAmountMinor: 500,
  });
  const settlement = transferSettlement(row)!;
  assert.equal(settlement.sourceDeltaMinor, -100_500, "1 005 USD leaves the source");
  assert.equal(settlement.destinationDeltaMinor, 1_240_000_000);
  assert.equal(transferRate(row)!.label, "1 USD = 12 400 UZS", "UZS is always the quote currency");
  const summary = summaryOf([row]);
  assert.equal(balance(summary, "usd"), -100_500);
  assert.equal(balance(summary, "uzs"), UZS_OPENING + 1_240_000_000);
  assert.equal(expenseOf(summary, "USD"), 500);
  assert.equal(expenseOf(summary, "UZS"), 0);
});

// ---- E. non-UZS pair -------------------------------------------------------

test("E. a non-UZS pair reads 1 source = X destination", () => {
  const usdToEur = transfer({
    fromAccountId: "usd", toAccountId: "eur", sourceAmountMinor: 100_000, sourceCurrencyCode: "USD",
    destinationAmountMinor: 92_500, destinationCurrencyCode: "EUR",
  });
  assert.equal(transferRate(usdToEur)!.label, "1 USD = 0.925 EUR");
  const eurToUsd = transfer({
    fromAccountId: "eur", toAccountId: "usd", sourceAmountMinor: 92_500, sourceCurrencyCode: "EUR",
    destinationAmountMinor: 100_000, destinationCurrencyCode: "USD",
  });
  assert.equal(transferRate(eurToUsd)!.label, "1 EUR = 1.081081 USD", "the source is the base, whichever way it went");
  // Both directions describe the same transfer; neither invents a market rate.
  assert.equal(transferRate(usdToEur)!.baseCode, "USD");
  assert.equal(transferRate(eurToUsd)!.baseCode, "EUR");
});

// ---- F. minor-unit metadata ------------------------------------------------

test("F. the rate respects runtime currency minorUnit metadata", () => {
  const row = transfer({
    toAccountId: "usd", sourceAmountMinor: 1_250_000_000, destinationAmountMinor: 100_000, destinationCurrencyCode: "USD",
  });
  // Default metadata: both minorUnit 2 -> 12 500 000 / 1 000.
  assert.equal(transferRate(row)!.rate, "12 500");
  // A runtime dictionary that declares UZS without minor units changes the scale
  // of the SAME persisted integers, and the displayed rate follows it.
  const zeroMinorUzs = [{ code: "UZS", minorUnit: 0 }, { code: "USD", minorUnit: 2 }];
  assert.equal(transferRate(row, zeroMinorUzs)!.rate, "1 250 000",
    "1 250 000 000 UZS units against 1 000 USD");
  // An unknown currency has no metadata to scale with, so no rate is shown rather
  // than a wrong one.
  assert.equal(transferRate({ ...row, destinationCurrencyCode: "XXX" }, [{ code: "UZS", minorUnit: 2 }]), null);
});

// ---- G / H. no duplicated fee ----------------------------------------------

test("G. reading the summary repeatedly never duplicates the commission", () => {
  const rows = [transfer({ feeAmountMinor: 1_000_000 })];
  for (let pass = 0; pass < 5; pass += 1) {
    const summary = summaryOf(rows);
    assert.equal(expenseOf(summary, "UZS"), 1_000_000, `pass ${pass + 1}`);
    assert.equal(balance(summary, "uzs"), UZS_OPENING - 101_000_000, `pass ${pass + 1} balance`);
    assert.equal(feeBucket(summary, "UZS")?.amountMinor, 1_000_000);
  }
  // The fee lives on the transfer row: there is no second transaction to drift.
  assert.equal(rows.length, 1);
  assert.equal(rows.filter((row) => row.type === "EXPENSE").length, 0);
});

test("H. editing a transfer recalculates once — amounts and commission alike", () => {
  const original = transfer({ feeAmountMinor: 1_000_000 });
  const edited = { ...original, sourceAmountMinor: 200_000_000, destinationAmountMinor: 200_000_000, feeAmountMinor: 2_500_000 };
  const before = summaryOf([original]);
  const after = summaryOf([edited]);
  assert.equal(expenseOf(before, "UZS"), 1_000_000);
  assert.equal(expenseOf(after, "UZS"), 2_500_000, "the new fee replaces the old one, never adds to it");
  assert.equal(balance(after, "uzs"), UZS_OPENING - 202_500_000);
  assert.equal(balance(after, "uzs-2"), 200_000_000);
  // Removing the commission removes the expense entirely.
  const withoutFee = summaryOf([{ ...edited, feeAmountMinor: 0 }]);
  assert.equal(expenseOf(withoutFee, "UZS"), 0);
  assert.equal(feeBucket(withoutFee, "UZS"), undefined);
});

// ---- I. archive ------------------------------------------------------------

test("I. archiving preserves transfer history and its commission", () => {
  const rows = [transfer({ toAccountId: "closed", feeAmountMinor: 1_000_000 })];
  const summary = summaryOf(rows);
  const archived = summary.accountBalances.find((row) => row.accountId === "closed")!;
  assert.equal(archived.archived, true);
  assert.equal(archived.currentBalanceMinor, 100_000_000, "an archived account keeps what it received");
  assert.equal(expenseOf(summary, "UZS"), 1_000_000, "and the commission stays explainable");
  // The ledger itself is untouched by archiving: the same row still reconciles.
  assert.equal(accountBalanceAt(accounts.find((row) => row.id === "closed")!, rows), 100_000_000);
  assert.equal(accountBalanceAt(accounts.find((row) => row.id === "uzs")!, rows), UZS_OPENING - 101_000_000);
});

// ---- J. currency separation -------------------------------------------------

test("J. the summary stays currency-separated with commissions in play", () => {
  const rows = [
    transfer({ id: "a", feeAmountMinor: 1_000_000 }),
    transfer({
      id: "b", toAccountId: "usd", sourceAmountMinor: 1_250_000_000, destinationAmountMinor: 100_000,
      destinationCurrencyCode: "USD", feeAmountMinor: 5_000_000,
    }),
    transfer({
      id: "c", fromAccountId: "usd", toAccountId: "uzs", sourceAmountMinor: 50_000, sourceCurrencyCode: "USD",
      destinationAmountMinor: 620_000_000, destinationCurrencyCode: "UZS", feeAmountMinor: 500,
    }),
  ];
  const summary = summaryOf(rows);
  assert.deepEqual(summary.expenseByCurrency, [
    { currencyCode: "USD", amountMinor: 500 },
    { currencyCode: "UZS", amountMinor: 6_000_000 },
  ], "one row per currency, never one blended figure");
  const buckets = summary.expensesByCategory.filter((row) => row.categoryId === TRANSFER_FEE_CATEGORY_ID);
  assert.deepEqual(buckets.map((row) => [row.currencyCode, row.amountMinor]), [["UZS", 6_000_000], ["USD", 500]]);
  for (const row of summary.accountBalances) {
    const account = accounts.find((entry) => entry.id === row.accountId)!;
    assert.equal(row.currencyCode, account.currencyCode, "a balance is always in its account's own currency");
  }
  assert.equal(summary.accountBalancesByCurrency.length, 3, "UZS, USD and EUR stay apart");
});

// ---- K. history without a fee ----------------------------------------------

test("K. transfers recorded before commissions existed stay valid at fee = 0", () => {
  const legacy = { ...transfer({ id: "legacy" }), feeAmountMinor: null };
  assert.equal(transferFeeMinor(legacy), 0);
  assert.equal(transferSettlement(legacy)!.sourceDeltaMinor, -100_000_000);
  const summary = summaryOf([legacy]);
  assert.equal(expenseOf(summary, "UZS"), 0);
  assert.equal(balance(summary, "uzs"), UZS_OPENING - 100_000_000);
  // And a request body that predates the field is accepted, defaulting to no fee.
  const withoutField = {
    date: "2026-09-10", type: "TRANSFER", note: "", projectId: null,
    fromAccountId: "uzs", toAccountId: "uzs-2", sourceAmountMinor: 100_000_000, sourceCurrencyCode: "UZS",
    destinationAmountMinor: 100_000_000, destinationCurrencyCode: "UZS",
  };
  const parsed = validateTransactionInput(withoutField);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.feeAmountMinor, 0);
});

// ---- validation ------------------------------------------------------------

test("validation rejects what cannot be accounted for, and allows a zero commission", () => {
  const base = {
    date: "2026-09-10", type: "TRANSFER", note: "", projectId: null,
    fromAccountId: "uzs", toAccountId: "uzs-2", sourceAmountMinor: 100_000_000, sourceCurrencyCode: "UZS",
    destinationAmountMinor: 100_000_000, destinationCurrencyCode: "UZS", feeAmountMinor: 0,
  };
  assert.equal(validateTransactionInput(base).ok, true, "fee = 0 is allowed");
  const rejected: [string, Record<string, unknown>][] = [
    ["same account", { toAccountId: "uzs" }],
    ["zero source amount", { sourceAmountMinor: 0 }],
    ["negative source amount", { sourceAmountMinor: -1 }],
    ["zero destination amount", { destinationAmountMinor: 0 }],
    ["negative destination amount", { destinationAmountMinor: -1 }],
    ["fractional source minor units", { sourceAmountMinor: 100.5 }],
    ["fractional fee", { feeAmountMinor: 10.5 }],
    ["negative fee", { feeAmountMinor: -1 }],
    ["unsafe fee", { feeAmountMinor: Number.MAX_SAFE_INTEGER + 2 }],
    ["fee as text", { feeAmountMinor: "10000" }],
    ["unequal same-currency amounts", { destinationAmountMinor: 99_000_000 }],
    ["unsupported currency", { destinationCurrencyCode: "XXX" }],
    ["an expense category on a transfer", { categoryId: "exp" }],
  ];
  for (const [label, override] of rejected) {
    assert.equal(validateTransactionInput({ ...base, ...override }).ok, false, `must reject: ${label}`);
  }
  // Income and Expense rows can never carry a transfer commission.
  const expense = validateTransactionInput({
    date: "2026-09-10", type: "EXPENSE", accountId: "uzs", categoryId: "exp",
    currencyCode: "UZS", amountMinor: 5_000, feeAmountMinor: 1_000,
  });
  assert.equal(expense.ok, true);
  if (expense.ok) assert.equal(expense.value.feeAmountMinor, null);
});

test("the UI draft and the API body agree about the commission", () => {
  const draft = {
    type: "TRANSFER" as const, date: "2026-09-10", accountId: "uzs", toAccountId: "usd",
    amountMinor: 1_250_000_000, destinationAmountMinor: 100_000, feeAmountMinor: 5_000_000,
    categoryId: null, projectId: null,
  };
  assert.equal(validateTransaction(draft, accounts).ok, true);
  const body = buildTransactionBody(draft, accounts, "Valyuta");
  assert.equal(body.feeAmountMinor, 5_000_000);
  assert.equal(validateTransactionInput(body).ok, true, "the body the drawer sends is accepted as-is");
  // Same currency: the destination mirrors the amount sent, the fee rides on top.
  const same = buildTransactionBody({ ...draft, toAccountId: "uzs-2", destinationAmountMinor: null, feeAmountMinor: 1_000_000 }, accounts, "");
  assert.equal(same.sourceAmountMinor, 1_250_000_000);
  assert.equal(same.destinationAmountMinor, 1_250_000_000);
  assert.equal(same.feeAmountMinor, 1_000_000);
  assert.equal(validateTransactionInput(same).ok, true);
  // A negative commission never reaches the API.
  assert.equal(validateTransaction({ ...draft, feeAmountMinor: -5 }, accounts).ok, false);
  // An Income draft carries no fee at all.
  assert.equal(buildTransactionBody({ ...draft, type: "INCOME", categoryId: "inc", toAccountId: null }, accounts, "").feeAmountMinor, null);
});

// ---- persistence -----------------------------------------------------------

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* runtime without node:sqlite */ }

const TRANSFER_INSERT = `INSERT INTO finance_transactions(
  id,date,type,note,project_id,account_id,amount_minor,currency_code,category_id,
  from_account_id,to_account_id,source_amount_minor,source_currency_code,
  destination_amount_minor,destination_currency_code,fee_amount_minor,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const strip = (file: string) => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replace(/-->.*$/gm, "");
const LEGACY_TRANSFER_INSERT = `INSERT INTO finance_transactions(
  id,date,type,note,project_id,account_id,amount_minor,currency_code,category_id,
  from_account_id,to_account_id,source_amount_minor,source_currency_code,
  destination_amount_minor,destination_currency_code,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** The schema as the previous release left it, with its accounts seeded. */
function preFeeDb() {
  const db = new DatabaseSync!(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(strip("0007_finance_core.sql"));
  const insert = db.prepare("INSERT INTO finance_accounts(id,name,type,currency_code,opening_balance_minor,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  insert.run("uzs", "Kassa", "CASH", "UZS", UZS_OPENING, 0, CREATED, CREATED);
  insert.run("uzs-2", "Bank", "BANK", "UZS", 0, 0, CREATED, CREATED);
  return db;
}

test("migration 0012 is additive: existing transfers survive and read as fee 0", { skip: !DatabaseSync }, () => {
  const db = preFeeDb();
  // A transfer written by the previous release, before the column existed.
  db.prepare(LEGACY_TRANSFER_INSERT)
    .run("old", "2026-09-05", "TRANSFER", "Eski o‘tkazma", null, null, null, null, null, "uzs", "uzs-2", 100_000_000, "UZS", 100_000_000, "UZS", CREATED, CREATED);

  const sql = strip("0012_transfer_fee.sql");
  assert.doesNotMatch(sql, /\b(DROP|DELETE|UPDATE|INSERT)\b/i, "the migration only adds a column");
  db.exec(sql);

  const row = db.prepare("SELECT source_amount_minor, destination_amount_minor, fee_amount_minor, note FROM finance_transactions WHERE id = 'old'").get() as Record<string, unknown>;
  assert.equal(Number(row.source_amount_minor), 100_000_000, "the historical amounts are untouched");
  assert.equal(Number(row.destination_amount_minor), 100_000_000);
  assert.equal(row.fee_amount_minor, null, "and no fee is invented for it");
  assert.equal(row.note, "Eski o‘tkazma");
  assert.equal(db.prepare("SELECT count(*) AS n FROM finance_transactions").get()!.n, 1);
});

test("the persisted row round-trips the commission, and an update replaces it once", { skip: !DatabaseSync }, () => {
  const db = preFeeDb();
  db.prepare(LEGACY_TRANSFER_INSERT)
    .run("old", "2026-09-05", "TRANSFER", "", null, null, null, null, null, "uzs", "uzs-2", 100_000_000, "UZS", 100_000_000, "UZS", CREATED, CREATED);
  db.exec(strip("0012_transfer_fee.sql"));
  db.prepare(TRANSFER_INSERT).run(
    "new", "2026-09-10", "TRANSFER", "SMOKE", null, null, null, null, null,
    "uzs", "uzs-2", 100_000_000, "UZS", 100_000_000, "UZS", 1_000_000, CREATED, CREATED,
  );
  const read = (id: string) => db.prepare("SELECT fee_amount_minor AS fee FROM finance_transactions WHERE id = ?").get(id) as { fee: number | null };
  assert.equal(read("new").fee, 1_000_000);
  db.prepare("UPDATE finance_transactions SET source_amount_minor = ?, destination_amount_minor = ?, fee_amount_minor = ?, updated_at = ? WHERE id = ?")
    .run(200_000_000, 200_000_000, 2_500_000, CREATED, "new");
  assert.equal(read("new").fee, 2_500_000, "one row, one fee — an edit cannot add a second");
  assert.equal(db.prepare("SELECT count(*) AS n FROM finance_transactions").get()!.n, 2);
  // Integer minor units only: SQLite stores what the API validated.
  assert.equal(Number.isSafeInteger(read("new").fee!), true);
});

// ---- UI: the form, the preview and the ledger row ---------------------------

const drawers = readFileSync(new URL("../app/finance/finance-drawers.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("../app/finance/finance-view.tsx", import.meta.url), "utf8");
const primitives = readFileSync(new URL("../app/finance/finance-primitives.tsx", import.meta.url), "utf8");

test("the transfer form asks for a commission and previews the settlement", () => {
  assert.match(drawers, /label=\{`Komissiya \(\$\{from\?\.currencyCode \?\? "manba valyutasi"\}\)`\}/,
    "the commission is labelled with the SOURCE currency");
  assert.doesNotMatch(drawers, /Komissiya valyutasi|feeCurrency/, "no fee-currency selector in this version");
  assert.match(drawers, /feeAmountMinor: fromCurrency && fee !== "" \? parseMoneyInput\(fee, fromCurrency\) : 0/);
  assert.match(drawers, /Tushadigan summadan ayirilmaydi/, "the form says the fee is charged on top");
  // The preview shows the shared breakdown, built from the same helper the ledger
  // and the summary use — it cannot disagree with what gets saved.
  assert.match(drawers, /transferSettlement\(row\) \? \{ row \} : null/);
  assert.match(drawers, /<TransferBreakdown row=\{preview\.row\} currencies=\{dataset\.currencies\}/);
  // No rate is ever multiplied into an amount anywhere in the form.
  assert.doesNotMatch(drawers, /destinationAmountMinor\s*=\s*[^;]*[*/]/);
});

test("saved transfers are labelled: sent, received, rate, commission, total debited", () => {
  // One component renders every transfer surface, so the labels cannot drift.
  assert.match(primitives, /export function TransferBreakdown/);
  assert.deepEqual(Object.values(TRANSFER_LABELS), [
    "Yuborildi", "Qabul qilindi", "Kurs", "Komissiya", "Manba hisobdan jami yechildi", "Komissiya yo‘q",
  ]);
  for (const key of ["sent", "received", "rate", "fee", "sourceTotal", "noFee"] as const) {
    assert.match(primitives, new RegExp(`TRANSFER_LABELS\\.${key}`), `${key} is rendered from the shared label`);
  }
  assert.match(primitives, /rate && <div><dt>\{TRANSFER_LABELS\.rate\}/,
    "the rate line exists only when transferRate returned one — cross-currency only");
  assert.match(primitives, /amountMinor=\{-settlement\.sourceDeltaMinor\}/, "the total debited is the aggregate, not the sent amount");
  // Both surfaces use it, and neither re-implements the arithmetic.
  assert.match(view, /function TransferCell/);
  assert.match(view, /<TransferBreakdown row=\{row\} currencies=\{currencies\} variant="compact" \/>/);
  assert.doesNotMatch(view, /fin-rate-inline|Komissiya <Money/, "the ledger no longer hand-rolls the transfer detail");
  // Rendered output: every label, and the real numbers from the brief's example.
  const cross = transfer({
    toAccountId: "usd", sourceAmountMinor: 1_250_000_000, destinationAmountMinor: 100_000,
    destinationCurrencyCode: "USD", feeAmountMinor: 5_000_000,
  });
  const html = renderToStaticMarkup(<TransferBreakdown row={cross} />);
  for (const label of ["Yuborildi", "Qabul qilindi", "Kurs", "Komissiya", "Manba hisobdan jami yechildi"]) {
    assert.ok(html.includes(label), `${label} must appear`);
  }
  assert.match(html, /12\D?500\D?000/, "12 500 000 UZS sent");
  assert.match(html, /1\D?000[,.]00\s*(US\$|\$)/, "1 000 USD received");
  assert.ok(html.includes("1 USD = 12 500 UZS"), "the derived rate");
  assert.match(html, /12\D?550\D?000/, "12 550 000 UZS debited in total");
  // Same currency: identical labels, and no rate line at all.
  const same = renderToStaticMarkup(<TransferBreakdown row={transfer({ feeAmountMinor: 1_000_000 })} />);
  for (const label of ["Yuborildi", "Qabul qilindi", "Komissiya", "Manba hisobdan jami yechildi"]) {
    assert.ok(same.includes(label), `${label} must appear for a same-currency transfer`);
  }
  assert.equal(same.includes("Kurs"), false, "no exchange rate for one currency");
  assert.match(same, /1\D?010\D?000/, "1 010 000 UZS debited in total");
  // A transfer without a commission says so rather than showing a bare zero.
  assert.ok(renderToStaticMarkup(<TransferBreakdown row={transfer()} />).includes("Komissiya yo‘q"));
});

test("the fee reaches expense reporting through one deterministic bucket", () => {
  const summary = summaryOf([transfer({ feeAmountMinor: 1_000_000, projectId: "p1" })]);
  // Summary: by currency, by category and by project — all three, once each.
  assert.equal(expenseOf(summary, "UZS"), 1_000_000);
  assert.equal(feeBucket(summary, "UZS")?.categoryName, "Bank komissiyasi");
  assert.equal(summary.projectBreakdown.find((row) => row.projectId === "p1")?.expenseMinor, 1_000_000);
  // The bucket is system-owned: no finance_categories row backs it, so nobody can
  // rename it, archive it or pick it for an ordinary expense.
  assert.equal(TRANSFER_FEE_CATEGORY_ID.startsWith("system:"), true);
  assert.equal(categories.some((category) => category.id === TRANSFER_FEE_CATEGORY_ID), false);
  const storage = readFileSync(new URL("../lib/finance/storage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(storage, new RegExp(TRANSFER_FEE_CATEGORY_ID), "it is never inserted into the database");
  // And the fee never becomes a second transaction: one INSERT exists, it writes
  // the fee as a column on the transfer, and nothing synthesises an EXPENSE row.
  assert.equal((storage.match(/INSERT INTO finance_transactions/g) ?? []).length, 1);
  assert.doesNotMatch(storage, /type: "EXPENSE"|'EXPENSE',/, "nothing synthesises an expense row for a commission");
  assert.match(storage, /destination_currency_code, fee_amount_minor, created_at/);
});

// ---- safe integers: no silent precision loss anywhere ----------------------

test("the aggregate debit is validated as money: amount + commission must stay exact", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const body = (over: Record<string, unknown>) => ({
    date: "2026-09-10", type: "TRANSFER", note: "", projectId: null,
    fromAccountId: "uzs", toAccountId: "uzs-2", sourceAmountMinor: 100_000_000, sourceCurrencyCode: "UZS",
    destinationAmountMinor: 100_000_000, destinationCurrencyCode: "UZS", feeAmountMinor: 0, ...over,
  });
  // MAX source with no commission is representable, so it is allowed.
  assert.equal(validateTransactionInput(body({ sourceAmountMinor: MAX, destinationAmountMinor: MAX })).ok, true);
  // MAX source plus one minor unit of commission is not.
  const overflow = validateTransactionInput(body({ sourceAmountMinor: MAX, destinationAmountMinor: MAX, feeAmountMinor: 1 }));
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.match(overflow.error, /safe integer range/);
  // Exactly at the boundary the total is still exact, so it is allowed.
  assert.equal(validateTransactionInput(body({ sourceAmountMinor: MAX - 100, destinationAmountMinor: MAX - 100, feeAmountMinor: 100 })).ok, true);
  assert.equal(validateTransactionInput(body({ sourceAmountMinor: MAX - 100, destinationAmountMinor: MAX - 100, feeAmountMinor: 101 })).ok, false);
  // Unsafe amounts on either leg are rejected before persistence.
  for (const over of [
    { sourceAmountMinor: MAX + 2 }, { destinationAmountMinor: MAX + 2 },
    { sourceAmountMinor: Number.POSITIVE_INFINITY }, { destinationAmountMinor: Number.NaN },
    { feeAmountMinor: MAX + 2 },
  ]) assert.equal(validateTransactionInput(body(over)).ok, false, JSON.stringify(over));
  // The same guard runs in the browser, so the form never sends it.
  const draft = {
    type: "TRANSFER" as const, date: "2026-09-10", accountId: "uzs", toAccountId: "uzs-2",
    amountMinor: MAX, destinationAmountMinor: null, feeAmountMinor: 1, categoryId: null, projectId: null,
  };
  const checked = validateTransaction(draft, accounts);
  assert.equal(checked.ok, false);
  assert.match(String(checked.error), /juda katta/);
  assert.equal(validateTransaction({ ...draft, feeAmountMinor: 0 }, accounts).ok, true);
});

test("sumMinor is the canonical safe sum, and settlement refuses an unrepresentable debit", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.equal(sumMinor(MAX, 0), MAX);
  assert.equal(sumMinor(MAX - 100, 100), MAX);
  assert.equal(sumMinor(MAX, 1), null);
  assert.equal(sumMinor(1, 2, 3), 6);
  assert.equal(sumMinor(MAX, 1, -1), null, "an unsafe running total fails even though the end result would fit");
  assert.equal(sumMinor(MAX, -1, 1), MAX, "…while a running total that never leaves the range is fine");
  assert.equal(sumMinor(1.5, 1), null);
  assert.equal(sumMinor(Number.NaN, 1), null);
  assert.equal(sumMinor(Number.POSITIVE_INFINITY), null);
  // A row that somehow holds an unrepresentable total reports no settlement at all
  // rather than a rounded one — and therefore renders nothing.
  const broken = transfer({ sourceAmountMinor: MAX, destinationAmountMinor: MAX, feeAmountMinor: 1 });
  assert.equal(transferSettlement(broken), null);
  assert.equal(transferRate(broken), null);
  assert.equal(renderToStaticMarkup(<TransferBreakdown row={broken} />), "");
});

test("balance and summary accumulation fails loudly instead of losing precision", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // A balance that cannot be represented throws rather than reporting a rounded
  // number: the API turns that into a visible Finance error, never a wrong total.
  const huge = [
    transfer({ id: "h1", fromAccountId: "uzs-2", toAccountId: "uzs", sourceAmountMinor: MAX - 10, destinationAmountMinor: MAX - 10 }),
    transfer({ id: "h2", fromAccountId: "uzs-2", toAccountId: "uzs", sourceAmountMinor: MAX - 10, destinationAmountMinor: MAX - 10 }),
  ];
  assert.throws(() => summaryOf(huge), /safe integer/);
  // The same for an expense total built from many commissions.
  const fees = [
    transfer({ id: "f1", feeAmountMinor: MAX - 10 }),
    transfer({ id: "f2", feeAmountMinor: MAX - 10 }),
  ];
  assert.throws(() => summaryOf(fees), /safe integer/);
  // And the source debit itself is summed with the throwing helper.
  const summary = readFileSync(new URL("../lib/finance/summary.ts", import.meta.url), "utf8");
  assert.match(summary, /-addMinor\(transaction\.sourceAmountMinor \?\? 0, transferFeeMinor\(transaction\)\)/);
  assert.doesNotMatch(summary, /\(transaction\.sourceAmountMinor \?\? 0\) \+ transferFeeMinor/, "no unchecked aggregate addition");
  // Every Finance money accumulation goes through a checked helper.
  for (const file of ["../lib/finance/summary.ts", "../lib/finance-money.ts", "../lib/finance-metrics.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /addMinor|sumMinor/, `${file} uses the checked helpers`);
  }
});
