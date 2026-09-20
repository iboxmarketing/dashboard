import { addMoney, currenciesIn, moneyLines, subtractByCurrency, sumByCurrency } from "./finance-money";
import type {
  Cadence, Currency, FinanceAccount, FinanceCategory, FinanceDataset, FinanceProject,
  FinanceSubscription, FinanceSummary, FinanceTransaction, MoneyByCurrency, TransactionType,
} from "./finance-types";

/**
 * Every Finance calculation, in one module.
 *
 * Components read from here instead of each deriving their own arithmetic — the
 * failure mode this avoids is two screens disagreeing about the same number.
 * Nothing here is currency-blind: results are per-currency maps.
 *
 * A TRANSFER is deliberately neither income nor expense. Money moving between
 * the owner's own accounts is not business performance, and counting it would
 * inflate both sides of the cash flow.
 */

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

const inSelection = (selected: readonly string[] | undefined, value: string | null) =>
  !selected?.length || (value !== null && selected.includes(value));

/**
 * A transfer matches an account filter from either side, so filtering by the
 * destination account still shows money arriving in it.
 */
export function matchesTransactionFilters(transaction: FinanceTransaction, filters: FinanceFilters = {}): boolean {
  if (filters.from && transaction.date < filters.from) return false;
  if (filters.to && transaction.date > filters.to) return false;
  if (filters.types?.length && !filters.types.includes(transaction.type)) return false;
  if (filters.accountIds?.length) {
    const touches = filters.accountIds.includes(transaction.accountId)
      || (transaction.toAccountId !== null && filters.accountIds.includes(transaction.toAccountId));
    if (!touches) return false;
  }
  if (!inSelection(filters.categoryIds, transaction.categoryId)) return false;
  if (!inSelection(filters.projectIds, transaction.projectId)) return false;
  if (filters.currencies?.length) {
    const touches = filters.currencies.includes(transaction.currency)
      || (transaction.toCurrency !== null && filters.currencies.includes(transaction.toCurrency));
    if (!touches) return false;
  }
  const query = (filters.search ?? "").trim().toLowerCase();
  if (query && !`${transaction.description} ${transaction.amount}`.toLowerCase().includes(query)) return false;
  return true;
}

export function filterTransactions(transactions: readonly FinanceTransaction[], filters: FinanceFilters = {}): FinanceTransaction[] {
  return transactions.filter((transaction) => matchesTransactionFilters(transaction, filters));
}

const incomeOf = (t: FinanceTransaction) => (t.type === "INCOME" ? { amount: t.amount, currency: t.currency } : null);
const expenseOf = (t: FinanceTransaction) => (t.type === "EXPENSE" ? { amount: t.amount, currency: t.currency } : null);

/** Cash-flow summary. Transfers are excluded from both sides by design. */
export function summarize(transactions: readonly FinanceTransaction[], range: { from: string; to: string }): FinanceSummary {
  const income = sumByCurrency(transactions, incomeOf);
  const expense = sumByCurrency(transactions, expenseOf);
  return { from: range.from, to: range.to, income, expense, net: subtractByCurrency(income, expense) };
}

/**
 * Account balances grouped by currency.
 *
 * `currentBalance` comes from the backend; the UI never recomputes it, so a
 * balance shown here always matches what the ledger says. Archived accounts are
 * reported separately rather than dropped, so their money does not silently
 * vanish from the owner's picture.
 */
export function accountBalances(accounts: readonly FinanceAccount[]) {
  const active = accounts.filter((account) => account.status === "ACTIVE");
  const archived = accounts.filter((account) => account.status === "ARCHIVED");
  const byCurrency = currenciesIn(sumByCurrency(active, (a) => ({ amount: a.currentBalance, currency: a.currency })))
    .map((currency) => {
      const inCurrency = active.filter((account) => account.currency === currency);
      return {
        currency,
        total: inCurrency.reduce((sum, account) => sum + account.currentBalance, 0),
        accounts: [...inCurrency].sort((left, right) => right.currentBalance - left.currentBalance),
      };
    });
  return {
    byCurrency,
    totals: sumByCurrency(active, (a) => ({ amount: a.currentBalance, currency: a.currency })),
    archived,
    activeCount: active.length,
  };
}

export type CategoryBreakdownRow = {
  categoryId: string | null;
  label: string;
  parentLabel: string | null;
  byCurrency: MoneyByCurrency;
  transactions: number;
};

/**
 * Spend or income per category, rolled up to the parent.
 *
 * Subcategory amounts land on their parent so the owner sees "Marketing", not
 * six fragments of it; the subcategory name is kept for the detail line.
 * Uncategorised transactions get their own row rather than being hidden.
 */
export function categoryBreakdown(
  transactions: readonly FinanceTransaction[],
  categories: readonly FinanceCategory[],
  type: Extract<TransactionType, "INCOME" | "EXPENSE">,
): CategoryBreakdownRow[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const rows = new Map<string, CategoryBreakdownRow>();
  for (const transaction of transactions) {
    if (transaction.type !== type) continue;
    const category = transaction.categoryId ? byId.get(transaction.categoryId) ?? null : null;
    const parent = category?.parentId ? byId.get(category.parentId) ?? null : null;
    const rollupId = parent?.id ?? category?.id ?? null;
    const key = rollupId ?? "(none)";
    const existing = rows.get(key) ?? {
      categoryId: rollupId,
      label: parent?.name ?? category?.name ?? "Kategoriyasiz",
      parentLabel: null,
      byCurrency: {},
      transactions: 0,
    };
    rows.set(key, {
      ...existing,
      byCurrency: addMoney(existing.byCurrency, transaction.currency, transaction.amount),
      transactions: existing.transactions + 1,
    });
  }
  return [...rows.values()].sort((left, right) => largest(right.byCurrency) - largest(left.byCurrency));
}

/** Ranks rows without adding currencies: compares the biggest single amount. */
function largest(map: MoneyByCurrency): number {
  return Math.max(0, ...Object.values(map).map((amount) => Math.abs(amount ?? 0)));
}

export type ProjectSpendRow = {
  projectId: string | null;
  name: string;
  status: FinanceProject["status"] | null;
  income: MoneyByCurrency;
  expense: MoneyByCurrency;
  net: MoneyByCurrency;
  transactions: number;
};

/** Per-project income, expense and net. Transactions without a project are their own row. */
export function projectSpending(
  transactions: readonly FinanceTransaction[],
  projects: readonly FinanceProject[],
): ProjectSpendRow[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const keys = new Set<string>(transactions.filter((t) => t.type !== "TRANSFER").map((t) => t.projectId ?? "(none)"));
  return [...keys].map((key) => {
    const projectId = key === "(none)" ? null : key;
    const rows = transactions.filter((t) => t.type !== "TRANSFER" && (t.projectId ?? "(none)") === key);
    const income = sumByCurrency(rows, incomeOf);
    const expense = sumByCurrency(rows, expenseOf);
    const project = projectId ? byId.get(projectId) ?? null : null;
    return {
      projectId,
      name: project?.name ?? (projectId ? `Project ${projectId}` : "Project belgilanmagan"),
      status: project?.status ?? null,
      income, expense, net: subtractByCurrency(income, expense),
      transactions: rows.length,
    };
  }).sort((left, right) => largest(right.expense) - largest(left.expense));
}

export const CADENCE_MONTHS: Record<Exclude<Cadence, "CUSTOM_MONTHS">, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

/** Months between payments, for showing the cadence — never used to post anything. */
export function cadenceMonths(subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths">): number | null {
  if (subscription.cadence === "CUSTOM_MONTHS") {
    const months = Number(subscription.intervalMonths);
    return Number.isInteger(months) && months > 0 ? months : null;
  }
  return CADENCE_MONTHS[subscription.cadence] ?? null;
}

export type SubscriptionBuckets = {
  overdue: FinanceSubscription[];
  upcoming: FinanceSubscription[];
  later: FinanceSubscription[];
  archived: FinanceSubscription[];
  /** Expected outflow per currency in the upcoming window. An expectation, not a charge. */
  upcomingByCurrency: MoneyByCurrency;
};

/**
 * Splits subscriptions by their next expected payment date.
 *
 * "Upcoming" and "overdue" describe an expectation the owner should act on. They
 * never mean a transaction exists — the MVP subscription is a template only.
 */
export function subscriptionBuckets(
  subscriptions: readonly FinanceSubscription[],
  { today, horizonDays = 30 }: { today: string; horizonDays?: number },
): SubscriptionBuckets {
  const horizon = addDays(today, horizonDays);
  const archived = subscriptions.filter((s) => s.status === "ARCHIVED");
  const active = subscriptions.filter((s) => s.status === "ACTIVE");
  const byDate = (left: FinanceSubscription, right: FinanceSubscription) => left.nextDueDate.localeCompare(right.nextDueDate);
  const overdue = active.filter((s) => s.nextDueDate < today).sort(byDate);
  const upcoming = active.filter((s) => s.nextDueDate >= today && s.nextDueDate <= horizon).sort(byDate);
  const later = active.filter((s) => s.nextDueDate > horizon).sort(byDate);
  return {
    overdue, upcoming, later, archived,
    upcomingByCurrency: sumByCurrency([...overdue, ...upcoming], (s) => ({ amount: s.amount, currency: s.currency })),
  };
}

/** Calendar-safe day arithmetic on `YYYY-MM-DD`, in UTC to avoid a local-zone shift. */
export function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

/** The next due date after a payment lands. Advisory only; nothing is posted. */
export function advanceDueDate(subscription: Pick<FinanceSubscription, "cadence" | "intervalMonths" | "nextDueDate">): string {
  const months = cadenceMonths(subscription);
  if (months === null) return subscription.nextDueDate;
  const [year, month, day] = subscription.nextDueDate.split("-").map(Number);
  if (!year || !month || !day) return subscription.nextDueDate;
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  // Clamp to the last valid day, so the 31st does not roll into the next month.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** One level only: a parent with its subcategories, per kind. */
export function categoryTree(categories: readonly FinanceCategory[], kind: FinanceCategory["kind"]) {
  const ofKind = categories.filter((category) => category.kind === kind);
  const parents = ofKind.filter((category) => category.parentId === null);
  return parents.map((parent) => ({
    parent,
    children: ofKind.filter((category) => category.parentId === parent.id)
      .sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) => left.parent.name.localeCompare(right.parent.name));
}

/** Guards the category picker: an expense may not be filed under an income category. */
export function selectableCategories(categories: readonly FinanceCategory[], type: TransactionType) {
  if (type === "TRANSFER") return [];
  return categories.filter((category) => category.status === "ACTIVE" && category.kind === type);
}

/** Everything the Overview needs, computed once from one filtered dataset. */
export function overviewModel(dataset: FinanceDataset, filters: FinanceFilters & { from: string; to: string }, today: string) {
  const transactions = filterTransactions(dataset.transactions, filters);
  return {
    range: { from: filters.from, to: filters.to },
    summary: summarize(transactions, { from: filters.from, to: filters.to }),
    balances: accountBalances(dataset.accounts),
    expenseByCategory: categoryBreakdown(transactions, dataset.categories, "EXPENSE"),
    incomeByCategory: categoryBreakdown(transactions, dataset.categories, "INCOME"),
    projects: projectSpending(transactions, dataset.projects),
    subscriptions: subscriptionBuckets(dataset.subscriptions, { today }),
    transactionCount: transactions.length,
  };
}

export { moneyLines };

export type TransactionDraft = {
  type: TransactionType;
  date: string;
  accountId: string;
  toAccountId: string | null;
  amount: number | null;
  toAmount: number | null;
  categoryId: string | null;
  projectId: string | null;
};

/**
 * Shape of a transfer between two accounts.
 *
 * When the currencies differ the user must supply BOTH amounts. The app holds no
 * FX rate and must not derive the second figure: a guessed rate would invent
 * money on one side of the owner's books.
 */
export function transferShape(from: FinanceAccount | null, to: FinanceAccount | null) {
  const crossCurrency = Boolean(from && to && from.currency !== to.currency);
  return {
    crossCurrency,
    requiresBothAmounts: crossCurrency,
    fromCurrency: from?.currency ?? null,
    toCurrency: crossCurrency ? to?.currency ?? null : null,
    sameAccount: Boolean(from && to && from.id === to.id),
  };
}

/**
 * Validates a draft before it reaches the adapter. Lives here, not in the
 * component, so the rules are testable without rendering.
 *
 * A Project is deliberately never required: plenty of real spending belongs to no
 * cost centre, and forcing one would make the owner invent a category.
 */
export function validateTransaction(draft: TransactionDraft, accounts: readonly FinanceAccount[]): { ok: boolean; error: string | null } {
  const from = accounts.find((account) => account.id === draft.accountId) ?? null;
  if (!draft.date) return { ok: false, error: "Sanani kiriting" };
  if (!from) return { ok: false, error: "Hisobni tanlang" };
  if (draft.amount === null || !Number.isFinite(draft.amount) || draft.amount <= 0) return { ok: false, error: "Summani kiriting" };
  if (draft.type !== "TRANSFER") {
    return { ok: true, error: null };
  }
  const to = accounts.find((account) => account.id === draft.toAccountId) ?? null;
  if (!to) return { ok: false, error: "Qabul qiluvchi hisobni tanlang" };
  const shape = transferShape(from, to);
  if (shape.sameAccount) return { ok: false, error: "Hisoblar bir xil bo‘lmasligi kerak" };
  if (shape.requiresBothAmounts && (draft.toAmount === null || !(draft.toAmount > 0))) {
    return { ok: false, error: "Har ikki summani kiriting" };
  }
  return { ok: true, error: null };
}

/** Builds the wire body. A transfer carries no category or project by design. */
export function buildTransactionBody(draft: TransactionDraft, accounts: readonly FinanceAccount[], description: string) {
  const from = accounts.find((account) => account.id === draft.accountId)!;
  const to = accounts.find((account) => account.id === draft.toAccountId) ?? null;
  const shape = transferShape(from, to);
  return {
    date: draft.date,
    type: draft.type,
    accountId: draft.accountId,
    toAccountId: draft.type === "TRANSFER" ? draft.toAccountId : null,
    categoryId: draft.type === "TRANSFER" ? null : draft.categoryId,
    projectId: draft.type === "TRANSFER" ? null : draft.projectId,
    description,
    amount: draft.amount ?? 0,
    currency: from.currency,
    toAmount: draft.type === "TRANSFER" && shape.requiresBothAmounts ? draft.toAmount : null,
    toCurrency: draft.type === "TRANSFER" && shape.requiresBothAmounts ? shape.toCurrency : null,
  };
}
