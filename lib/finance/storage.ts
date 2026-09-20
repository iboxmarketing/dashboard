import { getD1 } from "@/db";
import { FINANCE_CURRENCIES } from "./money";
import { validateCategoryHierarchy, type AccountInput, type CategoryInput, type ProjectInput, type SubscriptionInput, type TransactionInput } from "./validation";
import type { FinanceAccount, FinanceCategory, FinanceCurrency, FinanceProject, FinanceSubscription, FinanceTransaction } from "./types";

export class FinanceError extends Error {
  constructor(message: string, public status = 400, public code = "FINANCE_VALIDATION") {
    super(message);
  }
}

const bool = (value: unknown) => Number(value) === 1;
const nullable = (value: unknown) => value === null || value === undefined ? null : String(value);
const numberOrNull = (value: unknown) => value === null || value === undefined ? null : Number(value);

const accountRow = (row: Record<string, unknown>): FinanceAccount => ({
  id: String(row.id), name: String(row.name), type: String(row.type) as FinanceAccount["type"],
  currencyCode: String(row.currency_code), openingBalanceMinor: Number(row.opening_balance_minor),
  archived: bool(row.archived), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

const categoryRow = (row: Record<string, unknown>): FinanceCategory => ({
  id: String(row.id), name: String(row.name), kind: String(row.kind) as FinanceCategory["kind"],
  parentId: nullable(row.parent_id), archived: bool(row.archived), sortOrder: Number(row.sort_order),
});

const projectRow = (row: Record<string, unknown>): FinanceProject => ({
  id: String(row.id), name: String(row.name), description: nullable(row.description), archived: bool(row.archived),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

const transactionRow = (row: Record<string, unknown>): FinanceTransaction => ({
  id: String(row.id), date: String(row.date), type: String(row.type) as FinanceTransaction["type"],
  note: String(row.note ?? ""), projectId: nullable(row.project_id), accountId: nullable(row.account_id),
  amountMinor: numberOrNull(row.amount_minor), currencyCode: nullable(row.currency_code), categoryId: nullable(row.category_id),
  fromAccountId: nullable(row.from_account_id), toAccountId: nullable(row.to_account_id),
  sourceAmountMinor: numberOrNull(row.source_amount_minor), sourceCurrencyCode: nullable(row.source_currency_code),
  destinationAmountMinor: numberOrNull(row.destination_amount_minor), destinationCurrencyCode: nullable(row.destination_currency_code),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

const subscriptionRow = (row: Record<string, unknown>): FinanceSubscription => ({
  id: String(row.id), name: String(row.name), direction: String(row.direction) as FinanceSubscription["direction"],
  accountId: String(row.account_id), categoryId: String(row.category_id), projectId: nullable(row.project_id),
  amountMinor: Number(row.amount_minor), currencyCode: String(row.currency_code),
  cadence: String(row.cadence) as FinanceSubscription["cadence"], intervalMonths: numberOrNull(row.interval_months),
  nextDueDate: String(row.next_due_date), startDate: String(row.start_date), endDate: nullable(row.end_date),
  archived: bool(row.archived), note: nullable(row.note), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

async function first<T>(sql: string, value: string, mapper: (row: Record<string, unknown>) => T) {
  const row = await getD1().prepare(sql).bind(value).first<Record<string, unknown>>();
  return row ? mapper(row) : null;
}

function requireFound<T>(value: T | null, label: string): T {
  if (!value) throw new FinanceError(`${label} was not found`, 404, "FINANCE_NOT_FOUND");
  return value;
}

export async function listFinanceCurrencies(): Promise<FinanceCurrency[]> {
  const result = await getD1().prepare("SELECT code, name, minor_unit, symbol, archived FROM finance_currencies ORDER BY code").all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    code: String(row.code), name: String(row.name), minorUnit: Number(row.minor_unit),
    symbol: String(row.symbol), archived: bool(row.archived),
  }));
}

export async function listFinanceAccounts(includeArchived = false): Promise<FinanceAccount[]> {
  const sql = `SELECT * FROM finance_accounts ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name, id`;
  const result = await getD1().prepare(sql).all<Record<string, unknown>>();
  return (result.results ?? []).map(accountRow);
}

export const getFinanceAccount = (id: string) => first("SELECT * FROM finance_accounts WHERE id = ?", id, accountRow);

export async function createFinanceAccount(input: AccountInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getD1().prepare("INSERT INTO finance_accounts(id, name, type, currency_code, opening_balance_minor, archived, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.name, input.type, input.currencyCode, input.openingBalanceMinor, input.archived ? 1 : 0, now, now).run();
  return id;
}

export async function updateFinanceAccount(id: string, input: AccountInput) {
  const existing = requireFound(await getFinanceAccount(id), "Account");
  if (existing.currencyCode !== input.currencyCode) {
    const used = await getD1().prepare("SELECT 1 AS used FROM finance_transactions WHERE account_id = ? OR from_account_id = ? OR to_account_id = ? LIMIT 1")
      .bind(id, id, id).first<{ used: number }>();
    if (used) throw new FinanceError("Account currency cannot change after transactions exist", 409, "ACCOUNT_CURRENCY_LOCKED");
  }
  await getD1().prepare("UPDATE finance_accounts SET name = ?, type = ?, currency_code = ?, opening_balance_minor = ?, archived = ?, updated_at = ? WHERE id = ?")
    .bind(input.name, input.type, input.currencyCode, input.openingBalanceMinor, input.archived ? 1 : 0, new Date().toISOString(), id).run();
}

export async function listFinanceCategories(includeArchived = false): Promise<FinanceCategory[]> {
  const sql = `SELECT * FROM finance_categories ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY sort_order, name, id`;
  const result = await getD1().prepare(sql).all<Record<string, unknown>>();
  return (result.results ?? []).map(categoryRow);
}

export const getFinanceCategory = (id: string) => first("SELECT * FROM finance_categories WHERE id = ?", id, categoryRow);

async function assertCategoryInput(input: CategoryInput & { id?: string }) {
  const categories = await listFinanceCategories(true);
  const hierarchy = validateCategoryHierarchy(input, categories);
  if (!hierarchy.ok) throw new FinanceError(hierarchy.error);
  if (input.id) {
    const children = categories.filter((category) => category.parentId === input.id);
    if (input.parentId && children.length) throw new FinanceError("A parent category cannot become a subcategory");
    if (children.some((child) => child.kind !== input.kind)) throw new FinanceError("Category kind must match all subcategories");
    if (input.archived && children.some((child) => !child.archived)) throw new FinanceError("Archive active subcategories first");
  }
}

export async function createFinanceCategory(input: CategoryInput) {
  await assertCategoryInput(input);
  const id = crypto.randomUUID();
  await getD1().prepare("INSERT INTO finance_categories(id, name, kind, parent_id, archived, sort_order) VALUES(?, ?, ?, ?, ?, ?)")
    .bind(id, input.name, input.kind, input.parentId, input.archived ? 1 : 0, input.sortOrder).run();
  return id;
}

export async function updateFinanceCategory(id: string, input: CategoryInput) {
  const existing = requireFound(await getFinanceCategory(id), "Category");
  if (existing.kind !== input.kind) {
    const used = await getD1().prepare("SELECT 1 AS used FROM finance_transactions WHERE category_id = ? UNION ALL SELECT 1 FROM finance_subscriptions WHERE category_id = ? LIMIT 1")
      .bind(id, id).first<{ used: number }>();
    if (used) throw new FinanceError("Used category kind cannot change", 409, "CATEGORY_KIND_LOCKED");
  }
  await assertCategoryInput({ ...input, id });
  await getD1().prepare("UPDATE finance_categories SET name = ?, kind = ?, parent_id = ?, archived = ?, sort_order = ? WHERE id = ?")
    .bind(input.name, input.kind, input.parentId, input.archived ? 1 : 0, input.sortOrder, id).run();
}

export async function listFinanceProjects(includeArchived = false): Promise<FinanceProject[]> {
  const sql = `SELECT * FROM finance_projects ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name, id`;
  const result = await getD1().prepare(sql).all<Record<string, unknown>>();
  return (result.results ?? []).map(projectRow);
}

export const getFinanceProject = (id: string) => first("SELECT * FROM finance_projects WHERE id = ?", id, projectRow);

export async function createFinanceProject(input: ProjectInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getD1().prepare("INSERT INTO finance_projects(id, name, description, archived, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)")
    .bind(id, input.name, input.description, input.archived ? 1 : 0, now, now).run();
  return id;
}

export async function updateFinanceProject(id: string, input: ProjectInput) {
  requireFound(await getFinanceProject(id), "Finance project");
  await getD1().prepare("UPDATE finance_projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ?")
    .bind(input.name, input.description, input.archived ? 1 : 0, new Date().toISOString(), id).run();
}

export async function listFinanceTransactions(filters: { from?: string; to?: string; projectId?: string | null } = {}): Promise<FinanceTransaction[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.from) { clauses.push("date >= ?"); values.push(filters.from); }
  if (filters.to) { clauses.push("date <= ?"); values.push(filters.to); }
  if (filters.projectId === null) clauses.push("project_id IS NULL");
  else if (filters.projectId) { clauses.push("project_id = ?"); values.push(filters.projectId); }
  const sql = `SELECT * FROM finance_transactions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY date DESC, created_at DESC, id`;
  const result = await getD1().prepare(sql).bind(...values).all<Record<string, unknown>>();
  return (result.results ?? []).map(transactionRow);
}

export const getFinanceTransaction = (id: string) => first("SELECT * FROM finance_transactions WHERE id = ?", id, transactionRow);

async function activeAccount(id: string) {
  const account = requireFound(await getFinanceAccount(id), "Account");
  if (account.archived) throw new FinanceError("Archived account cannot receive new Finance activity", 409, "ACCOUNT_ARCHIVED");
  return account;
}

async function activeProject(id: string | null) {
  if (!id) return null;
  const project = requireFound(await getFinanceProject(id), "Finance project");
  if (project.archived) throw new FinanceError("Archived Finance project cannot receive new activity", 409, "PROJECT_ARCHIVED");
  return project;
}

async function activeCategory(id: string, expectedKind: "INCOME" | "EXPENSE") {
  const category = requireFound(await getFinanceCategory(id), "Category");
  if (category.archived) throw new FinanceError("Archived category cannot receive new activity", 409, "CATEGORY_ARCHIVED");
  if (category.kind !== expectedKind) throw new FinanceError(`Category must be ${expectedKind}`);
  return category;
}

async function assertTransactionReferences(input: TransactionInput) {
  await activeProject(input.projectId);
  if (input.type === "INCOME" || input.type === "EXPENSE") {
    const account = await activeAccount(input.accountId!);
    await activeCategory(input.categoryId!, input.type);
    if (account.currencyCode !== input.currencyCode) throw new FinanceError("Transaction currency must match Account currency");
    return;
  }
  const from = await activeAccount(input.fromAccountId!);
  const to = await activeAccount(input.toAccountId!);
  if (from.currencyCode !== input.sourceCurrencyCode || to.currencyCode !== input.destinationCurrencyCode) {
    throw new FinanceError("Transfer currencies must match their Accounts");
  }
}

const transactionValues = (input: TransactionInput) => [
  input.date, input.type, input.note, input.projectId, input.accountId, input.amountMinor, input.currencyCode, input.categoryId,
  input.fromAccountId, input.toAccountId, input.sourceAmountMinor, input.sourceCurrencyCode,
  input.destinationAmountMinor, input.destinationCurrencyCode,
];

export async function createFinanceTransaction(input: TransactionInput) {
  await assertTransactionReferences(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getD1().prepare(`INSERT INTO finance_transactions(
    id, date, type, note, project_id, account_id, amount_minor, currency_code, category_id,
    from_account_id, to_account_id, source_amount_minor, source_currency_code,
    destination_amount_minor, destination_currency_code, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ...transactionValues(input), now, now).run();
  return id;
}

export async function updateFinanceTransaction(id: string, input: TransactionInput) {
  requireFound(await getFinanceTransaction(id), "Transaction");
  await assertTransactionReferences(input);
  await getD1().prepare(`UPDATE finance_transactions SET
    date = ?, type = ?, note = ?, project_id = ?, account_id = ?, amount_minor = ?, currency_code = ?, category_id = ?,
    from_account_id = ?, to_account_id = ?, source_amount_minor = ?, source_currency_code = ?,
    destination_amount_minor = ?, destination_currency_code = ?, updated_at = ? WHERE id = ?`)
    .bind(...transactionValues(input), new Date().toISOString(), id).run();
}

export async function listFinanceSubscriptions(includeArchived = false): Promise<FinanceSubscription[]> {
  const sql = `SELECT * FROM finance_subscriptions ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY next_due_date, name, id`;
  const result = await getD1().prepare(sql).all<Record<string, unknown>>();
  return (result.results ?? []).map(subscriptionRow);
}

export const getFinanceSubscription = (id: string) => first("SELECT * FROM finance_subscriptions WHERE id = ?", id, subscriptionRow);

async function assertSubscriptionReferences(input: SubscriptionInput) {
  const account = await activeAccount(input.accountId);
  await activeCategory(input.categoryId, input.direction);
  await activeProject(input.projectId);
  if (account.currencyCode !== input.currencyCode) throw new FinanceError("Subscription currency must match Account currency");
}

const subscriptionValues = (input: SubscriptionInput) => [
  input.name, input.direction, input.accountId, input.categoryId, input.projectId, input.amountMinor, input.currencyCode,
  input.cadence, input.intervalMonths, input.nextDueDate, input.startDate, input.endDate, input.archived ? 1 : 0, input.note,
];

export async function createFinanceSubscription(input: SubscriptionInput) {
  await assertSubscriptionReferences(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getD1().prepare(`INSERT INTO finance_subscriptions(
    id, name, direction, account_id, category_id, project_id, amount_minor, currency_code, cadence, interval_months,
    next_due_date, start_date, end_date, archived, note, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ...subscriptionValues(input), now, now).run();
  return id;
}

export async function updateFinanceSubscription(id: string, input: SubscriptionInput) {
  requireFound(await getFinanceSubscription(id), "Subscription");
  await assertSubscriptionReferences(input);
  await getD1().prepare(`UPDATE finance_subscriptions SET
    name = ?, direction = ?, account_id = ?, category_id = ?, project_id = ?, amount_minor = ?, currency_code = ?, cadence = ?,
    interval_months = ?, next_due_date = ?, start_date = ?, end_date = ?, archived = ?, note = ?, updated_at = ? WHERE id = ?`)
    .bind(...subscriptionValues(input), new Date().toISOString(), id).run();
}

/** Static fallback is useful only for local schema inspection before migration; APIs read D1. */
export const supportedFinanceCurrencies = FINANCE_CURRENCIES;
