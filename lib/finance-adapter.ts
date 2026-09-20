import { cloneFixtures } from "./finance-fixtures";
import type {
  FinanceAccount, FinanceCategory, FinanceDataset, FinanceEntity, FinanceProject,
  FinanceSubscription, FinanceTransaction, NewAccount, NewCategory, NewProject,
  NewSubscription, NewTransaction,
} from "./finance-types";

/**
 * The only place Finance talks to the network.
 *
 * Components call the adapter, never `fetch`, so swapping fixtures for
 * `feat/finance-core` is one change here instead of a hunt through the UI.
 *
 * While the backend is absent the adapter falls back to in-memory fixtures and
 * reports `source: "fixtures"`, which the UI surfaces as a development banner —
 * an owner must never mistake sample data for their books. Delete
 * `createFixtureTransport` at integration and the rest stands.
 */

export const FINANCE_ENDPOINTS: Record<FinanceEntity | "summary", string> = {
  accounts: "/api/finance/accounts",
  transactions: "/api/finance/transactions",
  categories: "/api/finance/categories",
  projects: "/api/finance/projects",
  subscriptions: "/api/finance/subscriptions",
  summary: "/api/finance/summary",
};

export type FinanceSource = "api" | "fixtures";
export type FinanceLoad = { dataset: FinanceDataset; source: FinanceSource; error: string | null };

export class FinanceError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) { super(message); this.name = "FinanceError"; this.status = status; }
}

type Transport = {
  list<T>(entity: FinanceEntity): Promise<T[]>;
  create<T>(entity: FinanceEntity, body: unknown): Promise<T>;
  patch<T>(entity: FinanceEntity, id: string, body: unknown): Promise<T>;
};

/** Reads `{ items: [...] }` or a bare array, so either backend shape works. */
function itemsOf<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: T[] }).items;
  }
  throw new FinanceError("Finance API javobi ro‘yxat emas");
}

export function createHttpTransport(fetchImpl: typeof fetch = fetch): Transport {
  const call = async (path: string, init?: RequestInit) => {
    let response: Response;
    try {
      response = await fetchImpl(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    } catch {
      throw new FinanceError("Finance API bilan aloqa yo‘q", 0);
    }
    if (!response.ok) throw new FinanceError(`Finance API xatosi (${response.status})`, response.status);
    if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) throw new FinanceError("Finance API JSON qaytarmadi", response.status);
    return response.json() as Promise<unknown>;
  };
  return {
    list: async (entity) => itemsOf(await call(FINANCE_ENDPOINTS[entity])),
    create: async (entity, body) => (await call(FINANCE_ENDPOINTS[entity], { method: "POST", body: JSON.stringify(body) })) as never,
    patch: async (entity, id, body) => (await call(`${FINANCE_ENDPOINTS[entity]}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) })) as never,
  };
}

/** In-memory stand-in. Ids are local only; the backend assigns the real ones. */
export function createFixtureTransport(seed: FinanceDataset = cloneFixtures()): Transport {
  const data = seed;
  let counter = 0;
  const nextId = (entity: FinanceEntity) => `${entity.slice(0, 3)}-local-${++counter}`;
  return {
    list: async (entity) => structuredClone(data[entity]) as never,
    create: async (entity, body) => {
      const created = { ...(body as object), id: nextId(entity) } as never;
      (data[entity] as unknown[]).push(created);
      return structuredClone(created);
    },
    patch: async (entity, id, body) => {
      const list = data[entity] as { id: string }[];
      const index = list.findIndex((row) => row.id === id);
      if (index < 0) throw new FinanceError(`${entity} topilmadi: ${id}`, 404);
      list[index] = { ...list[index], ...(body as object) };
      return structuredClone(list[index]) as never;
    },
  };
}

export type FinanceAdapter = {
  readonly source: FinanceSource;
  load(): Promise<FinanceLoad>;
  createAccount(body: NewAccount): Promise<FinanceAccount>;
  updateAccount(id: string, body: Partial<NewAccount> & { status?: FinanceAccount["status"] }): Promise<FinanceAccount>;
  createCategory(body: NewCategory): Promise<FinanceCategory>;
  updateCategory(id: string, body: Partial<NewCategory>): Promise<FinanceCategory>;
  createProject(body: NewProject): Promise<FinanceProject>;
  updateProject(id: string, body: Partial<NewProject>): Promise<FinanceProject>;
  createTransaction(body: NewTransaction): Promise<FinanceTransaction>;
  updateTransaction(id: string, body: Partial<NewTransaction>): Promise<FinanceTransaction>;
  createSubscription(body: NewSubscription): Promise<FinanceSubscription>;
  updateSubscription(id: string, body: Partial<NewSubscription>): Promise<FinanceSubscription>;
};

/**
 * Builds an adapter. With `mode: "auto"` it probes the API once and falls back to
 * fixtures when the endpoints are absent, which is what makes this branch
 * runnable before `feat/finance-core` lands.
 */
export function createFinanceAdapter({ mode = "auto", fetchImpl, seed }: {
  mode?: "api" | "fixtures" | "auto";
  fetchImpl?: typeof fetch;
  seed?: FinanceDataset;
} = {}): FinanceAdapter {
  const http = createHttpTransport(fetchImpl ?? (typeof fetch === "function" ? fetch : undefined as never));
  const fixtures = createFixtureTransport(seed);
  let resolved: FinanceSource | null = mode === "auto" ? null : mode;
  let transport: Transport = mode === "fixtures" ? fixtures : http;

  const load = async (): Promise<FinanceLoad> => {
    const entities: FinanceEntity[] = ["accounts", "categories", "projects", "transactions", "subscriptions"];
    const read = async (from: Transport) => {
      const [accounts, categories, projects, transactions, subscriptions] = await Promise.all(
        entities.map((entity) => from.list(entity)),
      );
      return { accounts, categories, projects, transactions, subscriptions } as FinanceDataset;
    };
    if (resolved === "fixtures") return { dataset: await read(fixtures), source: "fixtures", error: null };
    try {
      const dataset = await read(http);
      resolved = "api"; transport = http;
      return { dataset, source: "api", error: null };
    } catch (error) {
      const message = error instanceof FinanceError ? error.message : "Finance ma’lumotlari yuklanmadi";
      if (mode === "api") return { dataset: emptyDataset(), source: "api", error: message };
      // Auto mode: the backend is not on this branch yet, so show sample data and say so.
      resolved = "fixtures"; transport = fixtures;
      return { dataset: await read(fixtures), source: "fixtures", error: null };
    }
  };

  const create = <T>(entity: FinanceEntity) => (body: unknown) => transport.create<T>(entity, body);
  const patch = <T>(entity: FinanceEntity) => (id: string, body: unknown) => transport.patch<T>(entity, id, body);
  return {
    get source() { return resolved ?? "api"; },
    load,
    createAccount: create<FinanceAccount>("accounts"),
    updateAccount: patch<FinanceAccount>("accounts"),
    createCategory: create<FinanceCategory>("categories"),
    updateCategory: patch<FinanceCategory>("categories"),
    createProject: create<FinanceProject>("projects"),
    updateProject: patch<FinanceProject>("projects"),
    createTransaction: create<FinanceTransaction>("transactions"),
    updateTransaction: patch<FinanceTransaction>("transactions"),
    createSubscription: create<FinanceSubscription>("subscriptions"),
    updateSubscription: patch<FinanceSubscription>("subscriptions"),
  };
}

export const emptyDataset = (): FinanceDataset => ({ accounts: [], categories: [], projects: [], transactions: [], subscriptions: [] });
