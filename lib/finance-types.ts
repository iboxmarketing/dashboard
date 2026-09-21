/**
 * Finance UI contract.
 *
 * Persisted and wire entities come directly from the backend domain. This file
 * adds labels and the composite dataset the UI loads, but never renames money,
 * archive, transfer, or subscription fields.
 */
import { FINANCE_CURRENCIES, type SupportedCurrencyCode } from "./finance/money";
import type {
  FinanceAccount, FinanceAccountInput, FinanceCategory, FinanceCategoryInput, FinanceCurrency,
  FinanceProject, FinanceProjectInput, FinanceSubscription, FinanceSubscriptionInput,
  FinanceProjectAmount, FinanceSummary, FinanceTransaction, FinanceTransactionInput,
} from "./finance/types";

export const CURRENCIES = FINANCE_CURRENCIES.map((currency) => currency.code) as SupportedCurrencyCode[];
export type Currency = SupportedCurrencyCode;
export const isCurrency = (value: unknown): value is Currency => CURRENCIES.includes(value as Currency);

export const ACCOUNT_TYPES = ["CASH", "BANK", "CARD", "OTHER"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
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

/** All values are integer minor units, always keyed by currency. */
export type MoneyByCurrency = Partial<Record<Currency, number>>;

export type FinanceDataset = {
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  projects: FinanceProject[];
  transactions: FinanceTransaction[];
  subscriptions: FinanceSubscription[];
  currencies: FinanceCurrency[];
  summary: FinanceSummary;
};

export type FinanceEntity = "accounts" | "categories" | "projects" | "transactions" | "subscriptions";

export type NewAccount = FinanceAccountInput;
export type NewCategory = FinanceCategoryInput;
export type NewProject = FinanceProjectInput;
export type NewTransaction = FinanceTransactionInput;
export type NewSubscription = FinanceSubscriptionInput;

export type {
  FinanceAccount, FinanceCategory, FinanceCurrency, FinanceProject, FinanceSubscription,
  FinanceProjectAmount, FinanceSummary, FinanceTransaction,
};
