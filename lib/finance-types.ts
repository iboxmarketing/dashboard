/**
 * Finance MVP contract, shared by the UI and (later) `feat/finance-core`.
 *
 * The central rule this file encodes: money is never a bare number. Every amount
 * travels with its currency, and every total is keyed by currency, so a mixed
 * grand total is not expressible. Management finance for an owner — not an
 * accounting ledger, so there are no double-entry postings, only transactions.
 */

export const CURRENCIES = ["UZS", "USD", "EUR", "KZT"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (value: unknown): value is Currency => CURRENCIES.includes(value as Currency);

/** Minor units per currency, so arithmetic happens in integers. */
export const CURRENCY_MINOR_UNITS: Record<Currency, number> = { UZS: 100, USD: 100, EUR: 100, KZT: 100 };

export type EntityStatus = "ACTIVE" | "ARCHIVED";
export const ACCOUNT_TYPES = ["CASH", "BANK", "CARD", "OTHER"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
/** Owner-facing labels. The wire format stays English so the backend is stable. */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = { CASH: "Naqd", BANK: "Bank", CARD: "Karta", OTHER: "Boshqa" };

export const TRANSACTION_TYPES = ["INCOME", "EXPENSE", "TRANSFER"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = { INCOME: "Kirim", EXPENSE: "Chiqim", TRANSFER: "O‘tkazma" };

export type CategoryKind = "INCOME" | "EXPENSE";
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = { INCOME: "Kirim kategoriyalari", EXPENSE: "Chiqim kategoriyalari" };

export const CADENCES = ["MONTHLY", "QUARTERLY", "YEARLY", "CUSTOM_MONTHS"] as const;
export type Cadence = (typeof CADENCES)[number];
export const CADENCE_LABELS: Record<Cadence, string> = {
  MONTHLY: "Har oy", QUARTERLY: "Har chorak", YEARLY: "Har yil", CUSTOM_MONTHS: "Har N oy",
};

export type FinanceAccount = {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  /** Set once at creation. */
  openingBalance: number;
  /** Derived by the backend from opening balance plus transactions. Never edited. */
  currentBalance: number;
  status: EntityStatus;
};

export type FinanceCategory = {
  id: string;
  name: string;
  kind: CategoryKind;
  /** A subcategory points at its parent; a parent has null. One level only. */
  parentId: string | null;
  status: EntityStatus;
};

export type FinanceProject = {
  id: string;
  name: string;
  description: string | null;
  status: EntityStatus;
};

/**
 * One movement of money.
 *
 * INCOME/EXPENSE use `accountId` and `amount`/`currency`. TRANSFER additionally
 * carries `toAccountId`, and when the two accounts hold different currencies it
 * carries `toAmount`/`toCurrency` as well — both entered by the user. No FX rate
 * is stored, applied or inferred anywhere.
 */
export type FinanceTransaction = {
  id: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  type: TransactionType;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  projectId: string | null;
  description: string;
  amount: number;
  currency: Currency;
  toAmount: number | null;
  toCurrency: Currency | null;
};

/**
 * A recurring payment template.
 *
 * MVP scope: it records what is expected and when. It does NOT create a
 * transaction, and no UI copy may imply that it does.
 */
export type FinanceSubscription = {
  id: string;
  name: string;
  amount: number;
  currency: Currency;
  accountId: string;
  categoryId: string | null;
  projectId: string | null;
  cadence: Cadence;
  /** Only for CUSTOM_MONTHS. */
  intervalMonths: number | null;
  /** ISO calendar date of the next expected payment. */
  nextDueDate: string;
  status: EntityStatus;
};

/** Totals are always per currency. There is deliberately no scalar total. */
export type MoneyByCurrency = Partial<Record<Currency, number>>;

export type FinanceSummary = {
  from: string;
  to: string;
  income: MoneyByCurrency;
  expense: MoneyByCurrency;
  net: MoneyByCurrency;
};

export type FinanceDataset = {
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  projects: FinanceProject[];
  transactions: FinanceTransaction[];
  subscriptions: FinanceSubscription[];
};

export type FinanceEntity = keyof FinanceDataset;

/** What the UI sends to create or update; the backend assigns ids. */
export type NewAccount = Omit<FinanceAccount, "id" | "currentBalance">;
export type NewCategory = Omit<FinanceCategory, "id">;
export type NewProject = Omit<FinanceProject, "id">;
export type NewTransaction = Omit<FinanceTransaction, "id">;
export type NewSubscription = Omit<FinanceSubscription, "id">;
