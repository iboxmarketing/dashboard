export const ACCOUNT_TYPES = ["CASH", "BANK", "CARD", "OTHER"] as const;
export type FinanceAccountType = (typeof ACCOUNT_TYPES)[number];

export const TRANSACTION_TYPES = ["INCOME", "EXPENSE", "TRANSFER"] as const;
export type FinanceTransactionType = (typeof TRANSACTION_TYPES)[number];

export const CATEGORY_KINDS = ["INCOME", "EXPENSE"] as const;
export type FinanceCategoryKind = (typeof CATEGORY_KINDS)[number];

export const SUBSCRIPTION_DIRECTIONS = ["INCOME", "EXPENSE"] as const;
export type FinanceSubscriptionDirection = (typeof SUBSCRIPTION_DIRECTIONS)[number];

export const SUBSCRIPTION_CADENCES = ["MONTHLY", "QUARTERLY", "YEARLY", "CUSTOM_MONTHS"] as const;
export type FinanceSubscriptionCadence = (typeof SUBSCRIPTION_CADENCES)[number];

export type FinanceCurrency = {
  code: string;
  name: string;
  minorUnit: number;
  symbol: string;
  archived: boolean;
};

export type FinanceAccount = {
  id: string;
  name: string;
  type: FinanceAccountType;
  currencyCode: string;
  openingBalanceMinor: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceCategory = {
  id: string;
  name: string;
  kind: FinanceCategoryKind;
  parentId: string | null;
  archived: boolean;
  sortOrder: number;
};

export type FinanceProject = {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FinanceTransaction = {
  id: string;
  date: string;
  type: FinanceTransactionType;
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
  createdAt: string;
  updatedAt: string;
};

export type FinanceSubscription = {
  id: string;
  name: string;
  direction: FinanceSubscriptionDirection;
  accountId: string;
  categoryId: string;
  projectId: string | null;
  amountMinor: number;
  currencyCode: string;
  cadence: FinanceSubscriptionCadence;
  intervalMonths: number | null;
  nextDueDate: string;
  startDate: string;
  endDate: string | null;
  archived: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FinanceDateRange = { from: string; to: string };

/** Canonical request bodies accepted by the collection POST/PATCH endpoints. */
export type FinanceAccountInput = Omit<FinanceAccount, "id" | "createdAt" | "updatedAt">;
export type FinanceCategoryInput = Omit<FinanceCategory, "id">;
export type FinanceProjectInput = Omit<FinanceProject, "id" | "createdAt" | "updatedAt">;
export type FinanceTransactionInput = Omit<FinanceTransaction, "id" | "createdAt" | "updatedAt">;
export type FinanceSubscriptionInput = Omit<FinanceSubscription, "id" | "createdAt" | "updatedAt">;

export type FinanceCurrencyAmount = { currencyCode: string; amountMinor: number };
export type FinanceOperatingAmount = {
  currencyCode: string;
  incomeMinor: number;
  expenseMinor: number;
  netCashFlowMinor: number;
};
export type FinanceAccountBalance = {
  accountId: string;
  accountName: string;
  currencyCode: string;
  configuredOpeningBalanceMinor: number;
  openingBalanceMinor: number;
  currentBalanceMinor: number;
  archived: boolean;
};
export type FinanceCategoryAmount = {
  currencyCode: string;
  categoryId: string;
  categoryName: string;
  parentId: string | null;
  amountMinor: number;
};
export type FinanceProjectAmount = {
  currencyCode: string;
  projectId: string | null;
  projectName: string;
  incomeMinor: number;
  expenseMinor: number;
  netCashFlowMinor: number;
};
export type FinanceSummary = {
  range: FinanceDateRange;
  projectId?: string | null;
  operatingByCurrency: FinanceOperatingAmount[];
  incomeByCurrency: FinanceCurrencyAmount[];
  expenseByCurrency: FinanceCurrencyAmount[];
  accountBalances: FinanceAccountBalance[];
  accountBalancesByCurrency: FinanceCurrencyAmount[];
  expensesByCategory: FinanceCategoryAmount[];
  incomeByCategory: FinanceCategoryAmount[];
  projectBreakdown: FinanceProjectAmount[];
  upcomingSubscriptions: FinanceSubscription[];
  overdueSubscriptions: FinanceSubscription[];
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };
