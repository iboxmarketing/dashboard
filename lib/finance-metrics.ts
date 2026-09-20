import { addMoney } from "./finance-money";
import type {
  Cadence, Currency, FinanceAccount, FinanceCategory, FinanceProjectAmount, FinanceSubscription,
  FinanceSummary, FinanceTransaction, MoneyByCurrency, NewTransaction, TransactionType,
} from "./finance-types";

/** Client-side filtering and presentation shaping only; accounting totals come from `/api/finance/summary`. */
export type FinanceFilters = {
  from?: string;
  to?: string;
  types?: readonly TransactionType[];
  accountIds?: readonly string[];
  categoryIds?: readonly string[];
  projectIds?: readonly string[];
  currencies?: readonly Currency[];
  search?: string;
};

const selected = (values: readonly string[] | undefined, value: string | null) => !values?.length || (value !== null && values.includes(value));

export function matchesTransactionFilters(transaction: FinanceTransaction, filters: FinanceFilters = {}) {
  if (filters.from && transaction.date < filters.from) return false;
  if (filters.to && transaction.date > filters.to) return false;
  if (filters.types?.length && !filters.types.includes(transaction.type)) return false;
  if (filters.accountIds?.length) {
    const touches = (transaction.accountId !== null && filters.accountIds.includes(transaction.accountId))
      || (transaction.fromAccountId !== null && filters.accountIds.includes(transaction.fromAccountId))
      || (transaction.toAccountId !== null && filters.accountIds.includes(transaction.toAccountId));
    if (!touches) return false;
  }
  if (!selected(filters.categoryIds, transaction.categoryId)) return false;
  if (!selected(filters.projectIds, transaction.projectId)) return false;
  if (filters.currencies?.length) {
    const touches = [transaction.currencyCode, transaction.sourceCurrencyCode, transaction.destinationCurrencyCode]
      .some((currency) => currency !== null && filters.currencies!.includes(currency as Currency));
    if (!touches) return false;
  }
  const query = (filters.search ?? "").trim().toLowerCase();
  return !query || `${transaction.note} ${transaction.amountMinor ?? ""} ${transaction.sourceAmountMinor ?? ""}`.toLowerCase().includes(query);
}

export const filterTransactions = (transactions: readonly FinanceTransaction[], filters: FinanceFilters = {}) =>
  transactions.filter((transaction) => matchesTransactionFilters(transaction, filters));

export function currencyAmountMap(rows: readonly { currencyCode: string; amountMinor: number }[]): MoneyByCurrency {
  let result: MoneyByCurrency = {};
  for (const row of rows) result = addMoney(result, row.currencyCode as Currency, row.amountMinor);
  return result;
}

export function operatingMaps(summary: FinanceSummary) {
  let income: MoneyByCurrency = {};
  let expense: MoneyByCurrency = {};
  let net: MoneyByCurrency = {};
  for (const row of summary.operatingByCurrency) {
    const currency = row.currencyCode as Currency;
    income = addMoney(income, currency, row.incomeMinor);
    expense = addMoney(expense, currency, row.expenseMinor);
    net = addMoney(net, currency, row.netCashFlowMinor);
  }
  return { income, expense, net };
}

export function accountBalanceGroups(summary: FinanceSummary) {
  const active = summary.accountBalances.filter((row) => !row.archived);
  const archived = summary.accountBalances.filter((row) => row.archived);
  const currencies = [...new Set(summary.accountBalances.map((row) => row.currencyCode))].sort();
  return {
    groups: currencies.map((currencyCode) => ({
      currencyCode: currencyCode as Currency,
      totalMinor: summary.accountBalances.filter((row) => row.currencyCode === currencyCode).reduce((sum, row) => sum + row.currentBalanceMinor, 0),
      accounts: summary.accountBalances.filter((row) => row.currencyCode === currencyCode),
    })),
    totals: currencyAmountMap(summary.accountBalancesByCurrency),
    archived,
    activeCount: active.length,
  };
}

export type CategoryPresentationRow = {
  categoryId: string;
  label: string;
  parentId: string | null;
  byCurrency: MoneyByCurrency;
};

export function categoryAmountRows(rows: FinanceSummary["expensesByCategory"]): CategoryPresentationRow[] {
  const grouped = new Map<string, CategoryPresentationRow>();
  for (const row of rows) {
    const current = grouped.get(row.categoryId) ?? { categoryId: row.categoryId, label: row.categoryName, parentId: row.parentId, byCurrency: {} };
    current.byCurrency = addMoney(current.byCurrency, row.currencyCode as Currency, row.amountMinor);
    grouped.set(row.categoryId, current);
  }
  return [...grouped.values()];
}

export type ProjectPresentationRow = {
  projectId: string | null;
  name: string;
  income: MoneyByCurrency;
  expense: MoneyByCurrency;
  net: MoneyByCurrency;
};

export function projectAmountRows(rows: readonly FinanceProjectAmount[]): ProjectPresentationRow[] {
  const grouped = new Map<string, ProjectPresentationRow>();
  for (const row of rows) {
    const key = row.projectId ?? "(none)";
    const current = grouped.get(key) ?? { projectId: row.projectId, name: row.projectName, income: {}, expense: {}, net: {} };
    const currency = row.currencyCode as Currency;
    current.income = addMoney(current.income, currency, row.incomeMinor);
    current.expense = addMoney(current.expense, currency, row.expenseMinor);
    current.net = addMoney(current.net, currency, row.netCashFlowMinor);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export const CADENCE_MONTHS: Record<Exclude<Cadence, "CUSTOM_MONTHS">, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
export function cadenceMonths(subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths">): number | null {
  if (subscription.cadence === "CUSTOM_MONTHS") {
    const months = Number(subscription.intervalMonths);
    return Number.isInteger(months) && months > 0 ? months : null;
  }
  return CADENCE_MONTHS[subscription.cadence] ?? null;
}

export function subscriptionBuckets(subscriptions: readonly FinanceSubscription[], { today, horizonDays = 30 }: { today: string; horizonDays?: number }) {
  const horizon = addDays(today, horizonDays);
  const archived = subscriptions.filter((row) => row.archived);
  const active = subscriptions.filter((row) => !row.archived);
  const byDate = (left: FinanceSubscription, right: FinanceSubscription) => left.nextDueDate.localeCompare(right.nextDueDate);
  const overdue = active.filter((row) => row.nextDueDate < today).sort(byDate);
  const upcoming = active.filter((row) => row.nextDueDate >= today && row.nextDueDate <= horizon).sort(byDate);
  const later = active.filter((row) => row.nextDueDate > horizon).sort(byDate);
  let upcomingByCurrency: MoneyByCurrency = {};
  for (const row of [...overdue, ...upcoming]) upcomingByCurrency = addMoney(upcomingByCurrency, row.currencyCode as Currency, row.amountMinor);
  return { overdue, upcoming, later, archived, upcomingByCurrency };
}

export function addDays(date: string, days: number) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed + days * 86_400_000).toISOString().slice(0, 10) : date;
}

export function advanceDueDate(subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths" | "nextDueDate">) {
  const months = cadenceMonths(subscription);
  if (months === null) return subscription.nextDueDate;
  const [year, month, day] = subscription.nextDueDate.split("-").map(Number);
  if (!year || !month || !day) return subscription.nextDueDate;
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function categoryTree(categories: readonly FinanceCategory[], kind: FinanceCategory["kind"]) {
  const ofKind = categories.filter((category) => category.kind === kind);
  return ofKind.filter((category) => category.parentId === null).map((parent) => ({
    parent,
    children: ofKind.filter((category) => category.parentId === parent.id).sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.parent.name.localeCompare(b.parent.name));
}

export function selectableCategories(categories: readonly FinanceCategory[], type: TransactionType) {
  return type === "TRANSFER" ? [] : categories.filter((category) => !category.archived && category.kind === type);
}

export function transferShape(from: FinanceAccount | null, to: FinanceAccount | null) {
  const crossCurrency = Boolean(from && to && from.currencyCode !== to.currencyCode);
  return {
    crossCurrency,
    requiresBothAmounts: crossCurrency,
    fromCurrency: from?.currencyCode as Currency | undefined ?? null,
    toCurrency: to?.currencyCode as Currency | undefined ?? null,
    sameAccount: Boolean(from && to && from.id === to.id),
  };
}

export type TransactionDraft = {
  type: TransactionType;
  date: string;
  accountId: string;
  toAccountId: string | null;
  amountMinor: number | null;
  destinationAmountMinor: number | null;
  categoryId: string | null;
  projectId: string | null;
};

export function validateTransaction(draft: TransactionDraft, accounts: readonly FinanceAccount[]) {
  const from = accounts.find((account) => account.id === draft.accountId) ?? null;
  if (!draft.date) return { ok: false, error: "Sanani kiriting" };
  if (!from) return { ok: false, error: "Hisobni tanlang" };
  if (draft.amountMinor === null || !Number.isSafeInteger(draft.amountMinor) || draft.amountMinor <= 0) return { ok: false, error: "Summani kiriting" };
  if (draft.type !== "TRANSFER") {
    if (!draft.categoryId) return { ok: false, error: "Kategoriyani tanlang" };
    return { ok: true, error: null };
  }
  const to = accounts.find((account) => account.id === draft.toAccountId) ?? null;
  if (!to) return { ok: false, error: "Qabul qiluvchi hisobni tanlang" };
  const shape = transferShape(from, to);
  if (shape.sameAccount) return { ok: false, error: "Hisoblar bir xil bo‘lmasligi kerak" };
  if (shape.crossCurrency && (draft.destinationAmountMinor === null || draft.destinationAmountMinor <= 0)) return { ok: false, error: "Har ikki summani kiriting" };
  return { ok: true, error: null };
}

export function buildTransactionBody(draft: TransactionDraft, accounts: readonly FinanceAccount[], note: string): NewTransaction {
  const from = accounts.find((account) => account.id === draft.accountId)!;
  const to = accounts.find((account) => account.id === draft.toAccountId) ?? null;
  if (draft.type !== "TRANSFER") {
    return {
      date: draft.date, type: draft.type, note, projectId: draft.projectId,
      accountId: from.id, amountMinor: draft.amountMinor!, currencyCode: from.currencyCode,
      categoryId: draft.categoryId, fromAccountId: null, toAccountId: null,
      sourceAmountMinor: null, sourceCurrencyCode: null, destinationAmountMinor: null, destinationCurrencyCode: null,
    };
  }
  const crossCurrency = from.currencyCode !== to!.currencyCode;
  return {
    date: draft.date, type: "TRANSFER", note, projectId: draft.projectId,
    accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
    fromAccountId: from.id, toAccountId: to!.id,
    sourceAmountMinor: draft.amountMinor!, sourceCurrencyCode: from.currencyCode,
    destinationAmountMinor: crossCurrency ? draft.destinationAmountMinor! : draft.amountMinor!,
    destinationCurrencyCode: to!.currencyCode,
  };
}
