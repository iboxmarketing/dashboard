import {
  ACCOUNT_TYPES, CATEGORY_KINDS, SUBSCRIPTION_CADENCES, SUBSCRIPTION_DIRECTIONS,
  TRANSACTION_TYPES,
  type FinanceAccount, type FinanceCategory, type FinanceProject, type ValidationResult,
} from "./types";
import { isSafeMinor, normalizeCurrencyCode } from "./money";

const NAME_LIMIT = 200;
const NOTE_LIMIT = 4000;
const ID_LIMIT = 80;

const text = (value: unknown, limit: number) => String(value ?? "").trim().slice(0, limit);
const optionalText = (value: unknown, limit: number) => {
  const result = text(value, limit);
  return result || null;
};
const id = (value: unknown) => text(value, ID_LIMIT);

export function normalizeFinanceDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  const candidate = String(value ?? "");
  return allowed.includes(candidate as T[number]) ? candidate as T[number] : null;
}

export type AccountInput = Omit<FinanceAccount, "id" | "createdAt" | "updatedAt">;

export function validateAccountInput(payload: unknown): ValidationResult<AccountInput> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Account name is required" };
  const type = enumValue(input.type, ACCOUNT_TYPES);
  if (!type) return { ok: false, error: "Account type is invalid" };
  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  if (!currencyCode) return { ok: false, error: "Currency is unsupported" };
  if (!isSafeMinor(input.openingBalanceMinor)) return { ok: false, error: "Opening balance must be integer minor units" };
  return { ok: true, value: { name, type, currencyCode, openingBalanceMinor: input.openingBalanceMinor as number, archived: input.archived === true } };
}

export type CategoryInput = Omit<FinanceCategory, "id">;

export function validateCategoryInput(payload: unknown): ValidationResult<CategoryInput> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Category name is required" };
  const kind = enumValue(input.kind, CATEGORY_KINDS);
  if (!kind) return { ok: false, error: "Category kind is invalid" };
  const sortOrder = Number(input.sortOrder ?? 0);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) return { ok: false, error: "sortOrder must be a non-negative integer" };
  return { ok: true, value: { name, kind, parentId: id(input.parentId) || null, archived: input.archived === true, sortOrder } };
}

export function validateCategoryHierarchy(candidate: CategoryInput & { id?: string }, categories: FinanceCategory[]): ValidationResult<CategoryInput> {
  if (!candidate.parentId) return { ok: true, value: candidate };
  if (candidate.parentId === candidate.id) return { ok: false, error: "Category cannot be its own parent" };
  const parent = categories.find((category) => category.id === candidate.parentId);
  if (!parent) return { ok: false, error: "Parent category was not found" };
  if (parent.parentId) return { ok: false, error: "Only one subcategory level is supported" };
  if (parent.kind !== candidate.kind) return { ok: false, error: "Parent and subcategory must have the same kind" };
  if (parent.archived && !candidate.archived) return { ok: false, error: "An active subcategory cannot use an archived parent" };
  return { ok: true, value: candidate };
}

export type ProjectInput = Omit<FinanceProject, "id" | "createdAt" | "updatedAt">;

export function validateFinanceProjectInput(payload: unknown): ValidationResult<ProjectInput> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Finance project name is required" };
  return { ok: true, value: { name, description: optionalText(input.description, NOTE_LIMIT), archived: input.archived === true } };
}

export type TransactionInput = {
  date: string;
  type: "INCOME" | "EXPENSE" | "TRANSFER";
  note: string;
  projectId: string | null;
  accountId: string | null;
  amountMinor: number | null;
  currencyCode: string | null;
  categoryId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  sourceAmountMinor: number | null;
  sourceCurrencyCode: string | null;
  destinationAmountMinor: number | null;
  destinationCurrencyCode: string | null;
};

export function validateTransactionInput(payload: unknown): ValidationResult<TransactionInput> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const date = normalizeFinanceDate(input.date);
  if (!date) return { ok: false, error: "Transaction date is invalid" };
  const type = enumValue(input.type, TRANSACTION_TYPES);
  if (!type) return { ok: false, error: "Transaction type is invalid" };
  const common = { date, type, note: text(input.note ?? input.description, NOTE_LIMIT), projectId: id(input.projectId) || null };

  if (type === "INCOME" || type === "EXPENSE") {
    const accountId = id(input.accountId);
    const categoryId = id(input.categoryId);
    const currencyCode = normalizeCurrencyCode(input.currencyCode);
    if (!accountId) return { ok: false, error: "Account is required" };
    if (!categoryId) return { ok: false, error: "Category is required" };
    if (!currencyCode) return { ok: false, error: "Currency is unsupported" };
    if (!isSafeMinor(input.amountMinor, { positive: true })) return { ok: false, error: "Amount must be positive integer minor units" };
    return { ok: true, value: {
      ...common, accountId, amountMinor: input.amountMinor as number, currencyCode, categoryId,
      fromAccountId: null, toAccountId: null, sourceAmountMinor: null, sourceCurrencyCode: null,
      destinationAmountMinor: null, destinationCurrencyCode: null,
    } };
  }

  const fromAccountId = id(input.fromAccountId);
  const toAccountId = id(input.toAccountId);
  const sourceCurrencyCode = normalizeCurrencyCode(input.sourceCurrencyCode);
  const destinationCurrencyCode = normalizeCurrencyCode(input.destinationCurrencyCode);
  if (!fromAccountId || !toAccountId) return { ok: false, error: "Both transfer accounts are required" };
  if (fromAccountId === toAccountId) return { ok: false, error: "Transfer accounts must be different" };
  if (!sourceCurrencyCode || !destinationCurrencyCode) return { ok: false, error: "Both transfer currencies are required" };
  if (!isSafeMinor(input.sourceAmountMinor, { positive: true }) || !isSafeMinor(input.destinationAmountMinor, { positive: true })) {
    return { ok: false, error: "Both transfer amounts must be positive integer minor units" };
  }
  if (sourceCurrencyCode === destinationCurrencyCode && input.sourceAmountMinor !== input.destinationAmountMinor) {
    return { ok: false, error: "Same-currency transfer amounts must match" };
  }
  return { ok: true, value: {
    ...common, accountId: null, amountMinor: null, currencyCode: null, categoryId: null,
    fromAccountId, toAccountId, sourceAmountMinor: input.sourceAmountMinor as number, sourceCurrencyCode,
    destinationAmountMinor: input.destinationAmountMinor as number, destinationCurrencyCode,
  } };
}

export type SubscriptionInput = {
  name: string;
  direction: "INCOME" | "EXPENSE";
  accountId: string;
  categoryId: string;
  projectId: string | null;
  amountMinor: number;
  currencyCode: string;
  cadence: "MONTHLY" | "QUARTERLY" | "YEARLY" | "CUSTOM_MONTHS";
  intervalMonths: number | null;
  nextDueDate: string;
  startDate: string;
  endDate: string | null;
  archived: boolean;
  note: string | null;
};

export function validateSubscriptionInput(payload: unknown): ValidationResult<SubscriptionInput> {
  const input = (payload ?? {}) as Record<string, unknown>;
  const name = text(input.name, NAME_LIMIT);
  if (!name) return { ok: false, error: "Subscription name is required" };
  const direction = enumValue(input.direction, SUBSCRIPTION_DIRECTIONS);
  if (!direction) return { ok: false, error: "Subscription direction is invalid" };
  const accountId = id(input.accountId);
  const categoryId = id(input.categoryId);
  if (!accountId || !categoryId) return { ok: false, error: "Subscription account and category are required" };
  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  if (!currencyCode) return { ok: false, error: "Currency is unsupported" };
  if (!isSafeMinor(input.amountMinor, { positive: true })) return { ok: false, error: "Subscription amount must be positive integer minor units" };
  const cadence = enumValue(input.cadence, SUBSCRIPTION_CADENCES);
  if (!cadence) return { ok: false, error: "Subscription cadence is invalid" };
  const interval = Number(input.intervalMonths);
  const intervalMonths = cadence === "CUSTOM_MONTHS" ? interval : null;
  if (cadence === "CUSTOM_MONTHS" && (!Number.isSafeInteger(intervalMonths) || intervalMonths! < 1 || intervalMonths! > 120)) {
    return { ok: false, error: "Custom cadence requires intervalMonths from 1 to 120" };
  }
  const nextDueDate = normalizeFinanceDate(input.nextDueDate);
  const startDate = normalizeFinanceDate(input.startDate);
  const endDate = input.endDate === null || input.endDate === undefined || input.endDate === "" ? null : normalizeFinanceDate(input.endDate);
  if (!nextDueDate || !startDate || (input.endDate && !endDate)) return { ok: false, error: "Subscription dates are invalid" };
  if (endDate && endDate < startDate) return { ok: false, error: "Subscription end date cannot precede start date" };
  if (nextDueDate < startDate || (endDate && nextDueDate > endDate)) return { ok: false, error: "nextDueDate must be inside the subscription period" };
  return { ok: true, value: {
    name, direction, accountId, categoryId, projectId: id(input.projectId) || null,
    amountMinor: input.amountMinor as number, currencyCode, cadence, intervalMonths,
    nextDueDate, startDate, endDate, archived: input.archived === true,
    note: optionalText(input.note, NOTE_LIMIT),
  } };
}

export function validateFinanceRange(from: unknown, to: unknown): ValidationResult<{ from: string; to: string }> {
  const start = normalizeFinanceDate(from);
  const end = normalizeFinanceDate(to);
  if (!start || !end) return { ok: false, error: "Finance date range is invalid" };
  if (start > end) return { ok: false, error: "Finance range start cannot follow its end" };
  return { ok: true, value: { from: start, to: end } };
}
