import { addMinor } from "./money";
import type {
  FinanceAccount, FinanceCategory, FinanceDateRange, FinanceProject,
  FinanceSubscription, FinanceSummary, FinanceTransaction,
} from "./types";

function addTo(map: Map<string, number>, key: string, amount: number) {
  map.set(key, addMinor(map.get(key) ?? 0, amount));
}

function currencyRows(map: Map<string, number>) {
  return [...map.entries()].map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
    .sort((left, right) => left.currencyCode.localeCompare(right.currencyCode));
}

export function transactionInRange(transaction: FinanceTransaction, range: FinanceDateRange) {
  return transaction.date >= range.from && transaction.date <= range.to;
}

export function filterFinanceTransactions(
  transactions: FinanceTransaction[],
  range: FinanceDateRange,
  projectId: string | null | undefined = undefined,
) {
  return transactions.filter((transaction) => transactionInRange(transaction, range)
    && (projectId === undefined || transaction.projectId === projectId));
}

function accountDelta(transaction: FinanceTransaction, accountId: string) {
  if (transaction.type === "INCOME" && transaction.accountId === accountId) return transaction.amountMinor ?? 0;
  if (transaction.type === "EXPENSE" && transaction.accountId === accountId) return -(transaction.amountMinor ?? 0);
  if (transaction.type === "TRANSFER" && transaction.fromAccountId === accountId) return -(transaction.sourceAmountMinor ?? 0);
  if (transaction.type === "TRANSFER" && transaction.toAccountId === accountId) return transaction.destinationAmountMinor ?? 0;
  return 0;
}

export function accountBalanceAt(account: FinanceAccount, transactions: FinanceTransaction[], throughDate?: string) {
  return transactions
    .filter((transaction) => !throughDate || transaction.date <= throughDate)
    .reduce((balance, transaction) => addMinor(balance, accountDelta(transaction, account.id)), account.openingBalanceMinor);
}

export function buildFinanceSummary(input: {
  accounts: FinanceAccount[];
  transactions: FinanceTransaction[];
  categories: FinanceCategory[];
  projects: FinanceProject[];
  subscriptions: FinanceSubscription[];
  range: FinanceDateRange;
  asOf: string;
  projectId?: string | null;
}): FinanceSummary {
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const ranged = filterFinanceTransactions(input.transactions, input.range, input.projectId);
  const income = new Map<string, number>();
  const expense = new Map<string, number>();
  const categoryIncome = new Map<string, number>();
  const categoryExpense = new Map<string, number>();
  const projectIncome = new Map<string, number>();
  const projectExpense = new Map<string, number>();

  for (const transaction of ranged) {
    if (transaction.type === "TRANSFER") continue;
    const currencyCode = transaction.currencyCode!;
    const amount = transaction.amountMinor!;
    const categoryKey = `${currencyCode}\u0000${transaction.categoryId}`;
    const projectKey = `${currencyCode}\u0000${transaction.projectId ?? ""}`;
    if (transaction.type === "INCOME") {
      addTo(income, currencyCode, amount);
      addTo(categoryIncome, categoryKey, amount);
      addTo(projectIncome, projectKey, amount);
    } else {
      addTo(expense, currencyCode, amount);
      addTo(categoryExpense, categoryKey, amount);
      addTo(projectExpense, projectKey, amount);
    }
  }

  const allCurrencies = [...new Set([...income.keys(), ...expense.keys()])].sort();
  const operatingByCurrency = allCurrencies.map((currencyCode) => ({
    currencyCode,
    incomeMinor: income.get(currencyCode) ?? 0,
    expenseMinor: expense.get(currencyCode) ?? 0,
    netCashFlowMinor: addMinor(income.get(currencyCode) ?? 0, -(expense.get(currencyCode) ?? 0)),
  }));

  const accountBalances = input.accounts.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    currencyCode: account.currencyCode,
    configuredOpeningBalanceMinor: account.openingBalanceMinor,
    openingBalanceMinor: accountBalanceAt(account, input.transactions.filter((transaction) => transaction.date < input.range.from)),
    currentBalanceMinor: accountBalanceAt(account, input.transactions, input.range.to),
    archived: account.archived,
  }));
  const balancesByCurrency = new Map<string, number>();
  for (const account of accountBalances) addTo(balancesByCurrency, account.currencyCode, account.currentBalanceMinor);

  const categoryRows = (totals: Map<string, number>) => [...totals.entries()].map(([key, amountMinor]) => {
    const [currencyCode, categoryId] = key.split("\u0000");
    const category = categories.get(categoryId);
    return { currencyCode, categoryId, categoryName: category?.name ?? "Unknown", parentId: category?.parentId ?? null, amountMinor };
  }).sort((left, right) => right.amountMinor - left.amountMinor || left.categoryName.localeCompare(right.categoryName));

  const projectKeys = new Set([...projectIncome.keys(), ...projectExpense.keys()]);
  const projectBreakdown = [...projectKeys].map((key) => {
    const [currencyCode, projectId] = key.split("\u0000");
    const incomeMinor = projectIncome.get(key) ?? 0;
    const expenseMinor = projectExpense.get(key) ?? 0;
    return {
      currencyCode,
      projectId: projectId || null,
      projectName: projectId ? projects.get(projectId)?.name ?? "Unknown" : "No project",
      incomeMinor,
      expenseMinor,
      netCashFlowMinor: addMinor(incomeMinor, -expenseMinor),
    };
  }).sort((left, right) => left.currencyCode.localeCompare(right.currencyCode)
    || right.expenseMinor - left.expenseMinor || left.projectName.localeCompare(right.projectName));

  const eligibleSubscriptions = input.subscriptions.filter((subscription) => !subscription.archived
    && (input.projectId === undefined || subscription.projectId === input.projectId)
    && subscription.startDate <= input.range.to
    && (!subscription.endDate || subscription.nextDueDate <= subscription.endDate));
  const overdueSubscriptions = eligibleSubscriptions.filter((subscription) => subscription.nextDueDate < input.asOf);
  const upcomingSubscriptions = eligibleSubscriptions.filter((subscription) => subscription.nextDueDate >= input.asOf
    && subscription.nextDueDate <= input.range.to);

  return {
    range: input.range,
    projectId: input.projectId ?? undefined,
    operatingByCurrency,
    incomeByCurrency: currencyRows(income),
    expenseByCurrency: currencyRows(expense),
    accountBalances,
    accountBalancesByCurrency: currencyRows(balancesByCurrency),
    expensesByCategory: categoryRows(categoryExpense),
    incomeByCategory: categoryRows(categoryIncome),
    projectBreakdown,
    upcomingSubscriptions,
    overdueSubscriptions,
  };
}
