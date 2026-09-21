import { buildFinanceSummary } from "./finance/summary";
import { FINANCE_CURRENCIES } from "./finance/money";
import { cloneFixtures } from "./finance-fixtures";
import { SessionLostError, authFetch } from "./auth-fetch";
import type {
  FinanceDataset, FinanceEntity, FinanceSummary, NewAccount, NewCategory, NewProject,
  NewSubscription, NewTransaction,
} from "./finance-types";

/** The single network boundary used by every Finance screen. */
export const FINANCE_ENDPOINTS = {
  accounts: "/api/finance/accounts",
  transactions: "/api/finance/transactions",
  categories: "/api/finance/categories",
  projects: "/api/finance/projects",
  subscriptions: "/api/finance/subscriptions",
  summary: "/api/finance/summary",
  currencies: "/api/finance/currencies",
} as const;

export type FinanceSource = "api" | "fixtures";
export type FinanceRange = { from: string; to: string };
export type FinanceLoad = { dataset: FinanceDataset; source: FinanceSource; error: string | null };

export class FinanceError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = "FinanceError"; }
}

type Transport = {
  list(entity: FinanceEntity): Promise<unknown[]>;
  currencies(): Promise<FinanceDataset["currencies"]>;
  summary(range: FinanceRange): Promise<FinanceSummary>;
  create(entity: FinanceEntity, body: unknown): Promise<{ id: string }>;
  patch(entity: FinanceEntity, id: string, body: unknown): Promise<void>;
};

async function errorMessage(response: Response) {
  if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) return `Finance API xatosi (${response.status})`;
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" && payload.error ? payload.error : `Finance API xatosi (${response.status})`;
}

export function createHttpTransport(fetchImpl: typeof fetch = authFetch): Transport {
  const call = async (path: string, init?: RequestInit) => {
    let response: Response;
    try {
      response = await fetchImpl(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    } catch (error) {
      // A lost session has already been reported to the auth shell; it is not
      // a connection problem and must not read as one.
      if (error instanceof SessionLostError) throw error;
      throw new FinanceError("Finance API bilan aloqa yo‘q");
    }
    if (!response.ok) throw new FinanceError(await errorMessage(response), response.status);
    if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) throw new FinanceError("Finance API JSON qaytarmadi", response.status);
    return response.json() as Promise<Record<string, unknown>>;
  };
  return {
    list: async (entity) => {
      const includeArchived = entity === "transactions" ? "" : "?includeArchived=true";
      const payload = await call(`${FINANCE_ENDPOINTS[entity]}${includeArchived}`);
      const rows = payload[entity];
      if (!Array.isArray(rows)) throw new FinanceError(`Finance API '${entity}' ro‘yxatini qaytarmadi`);
      return rows;
    },
    currencies: async () => {
      const payload = await call(FINANCE_ENDPOINTS.currencies);
      if (!Array.isArray(payload.currencies)) throw new FinanceError("Finance API currencies ro‘yxatini qaytarmadi");
      return payload.currencies as FinanceDataset["currencies"];
    },
    summary: async (range) => {
      const query = new URLSearchParams(range).toString();
      const payload = await call(`${FINANCE_ENDPOINTS.summary}?${query}`);
      if (!payload.summary || typeof payload.summary !== "object") throw new FinanceError("Finance API summary qaytarmadi");
      return payload.summary as FinanceSummary;
    },
    create: async (entity, body) => {
      const payload = await call(FINANCE_ENDPOINTS[entity], { method: "POST", body: JSON.stringify(body) });
      if (typeof payload.id !== "string") throw new FinanceError("Finance API yangi id qaytarmadi");
      return { id: payload.id };
    },
    patch: async (entity, id, body) => {
      await call(FINANCE_ENDPOINTS[entity], { method: "PATCH", body: JSON.stringify({ id, ...(body as object) }) });
    },
  };
}

/** Explicit test/development mode only. Production never falls back here. */
export function createFixtureTransport(seed = cloneFixtures()): Transport {
  const data = seed;
  let counter = 0;
  const nextId = (entity: FinanceEntity) => `${entity.slice(0, 3)}-local-${++counter}`;
  return {
    list: async (entity) => structuredClone(data[entity]),
    currencies: async () => structuredClone(data.currencies),
    summary: async (range) => buildFinanceSummary({
      accounts: data.accounts, transactions: data.transactions, categories: data.categories,
      projects: data.projects, subscriptions: data.subscriptions, range, asOf: range.to,
    }),
    create: async (entity, body) => {
      const id = nextId(entity);
      const now = new Date().toISOString();
      const created = { ...(body as object), id, ...((entity === "categories") ? {} : { createdAt: now, updatedAt: now }) };
      (data[entity] as unknown[]).push(created);
      return { id };
    },
    patch: async (entity, id, body) => {
      const rows = data[entity] as Array<{ id: string; updatedAt?: string }>;
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) throw new FinanceError(`${entity} topilmadi: ${id}`, 404);
      rows[index] = { ...rows[index], ...(body as object), ...(entity === "categories" ? {} : { updatedAt: new Date().toISOString() }) };
    },
  };
}

export type FinanceAdapter = {
  readonly source: FinanceSource;
  load(range: FinanceRange): Promise<FinanceLoad>;
  createAccount(body: NewAccount): Promise<{ id: string }>;
  updateAccount(id: string, body: Partial<NewAccount>): Promise<void>;
  createCategory(body: NewCategory): Promise<{ id: string }>;
  updateCategory(id: string, body: Partial<NewCategory>): Promise<void>;
  createProject(body: NewProject): Promise<{ id: string }>;
  updateProject(id: string, body: Partial<NewProject>): Promise<void>;
  createTransaction(body: NewTransaction): Promise<{ id: string }>;
  updateTransaction(id: string, body: Partial<NewTransaction>): Promise<void>;
  createSubscription(body: NewSubscription): Promise<{ id: string }>;
  updateSubscription(id: string, body: Partial<NewSubscription>): Promise<void>;
};

export function createFinanceAdapter({ mode = "api", fetchImpl, seed }: {
  mode?: "api" | "fixtures";
  fetchImpl?: typeof fetch;
  seed?: FinanceDataset;
} = {}): FinanceAdapter {
  const source: FinanceSource = mode;
  const transport = mode === "fixtures" ? createFixtureTransport(seed) : createHttpTransport(fetchImpl);
  const load = async (range: FinanceRange): Promise<FinanceLoad> => {
    try {
      const [accounts, categories, projects, transactions, subscriptions, currencies, summary] = await Promise.all([
        transport.list("accounts"), transport.list("categories"), transport.list("projects"),
        transport.list("transactions"), transport.list("subscriptions"), transport.currencies(), transport.summary(range),
      ]);
      return { dataset: { accounts, categories, projects, transactions, subscriptions, currencies, summary } as FinanceDataset, source, error: null };
    } catch (error) {
      const message = error instanceof FinanceError ? error.message : "Finance ma’lumotlari yuklanmadi";
      return { dataset: emptyDataset(range), source, error: message };
    }
  };
  const create = (entity: FinanceEntity) => (body: unknown) => transport.create(entity, body);
  const patch = (entity: FinanceEntity) => (id: string, body: unknown) => transport.patch(entity, id, body);
  return {
    source, load,
    createAccount: create("accounts"), updateAccount: patch("accounts"),
    createCategory: create("categories"), updateCategory: patch("categories"),
    createProject: create("projects"), updateProject: patch("projects"),
    createTransaction: create("transactions"), updateTransaction: patch("transactions"),
    createSubscription: create("subscriptions"), updateSubscription: patch("subscriptions"),
  };
}

export function emptySummary(range: FinanceRange): FinanceSummary {
  return {
    range, operatingByCurrency: [], incomeByCurrency: [], expenseByCurrency: [], accountBalances: [],
    accountBalancesByCurrency: [], expensesByCategory: [], incomeByCategory: [], projectBreakdown: [],
    upcomingSubscriptions: [], overdueSubscriptions: [],
  };
}

export function emptyDataset(range: FinanceRange = { from: "1970-01-01", to: "1970-01-01" }): FinanceDataset {
  return {
    accounts: [], categories: [], projects: [], transactions: [], subscriptions: [],
    currencies: FINANCE_CURRENCIES.map((currency) => ({ ...currency, archived: false })),
    summary: emptySummary(range),
  };
}
