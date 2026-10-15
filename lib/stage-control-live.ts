import type { RawCurrentStageDeal } from "./current-stages";
import { SafeBitrixError } from "./safe-bitrix-error";
import type { ProjectKey } from "./sales-projects";
import type { PipelineStageOption } from "./types";

/**
 * Live Stage Control: the open-Deal fetch, the last-successful snapshot and the
 * decision between them. Dependency-free (no Worker runtime), so every branch is
 * tested directly; the route only wires Bitrix and D1 in.
 *
 * Semantics are not decided here. The fetch returns the same population the
 * route always asked Bitrix for (this project's Sales categories, CLOSED = N),
 * and `buildCurrentStageRecords` still decides the canonical workload — for
 * live rows and snapshot rows alike.
 */

/** Exactly the Deal fields `buildCurrentStageRecords` reads. Nothing else is fetched. */
export const STAGE_CONTROL_DEAL_FIELDS = [
  "ID", "TITLE", "DATE_CREATE", "DATE_MODIFY", "MOVED_TIME", "ASSIGNED_BY_ID", "CATEGORY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "SOURCE_ID",
] as const;

/** Bitrix list methods return at most 50 rows per call. */
export const BITRIX_PAGE_SIZE = 50;
export const LIVE_FETCH_MAX_PAGES = 100;
/** Per Bitrix request — unchanged from lib/bitrix.ts. */
export const LIVE_REQUEST_TIMEOUT_MS = 25_000;
/** The whole live fetch. Past it the page gets the snapshot instead of waiting on Bitrix. */
export const LIVE_FETCH_BUDGET_MS = 40_000;
/** Transient-failure retries for the whole fetch, not per page. */
export const LIVE_FETCH_MAX_RETRIES = 2;

/** The workspace each project's Stage Control belongs to. Adding a project forces a choice here. */
export const STAGE_CONTROL_WORKSPACES: Record<ProjectKey, string> = { IBOX: "IBOX_UZ", SALES_DOCTOR: "SD_UZ" };

export type LiveStatus = "LIVE" | "DEGRADED" | "UNAVAILABLE";
export type StageDataSource = "BITRIX_LIVE" | "LAST_SUCCESSFUL_LIVE";
export type LiveErrorCode =
  | "BITRIX_TIMEOUT" | "BITRIX_NETWORK" | "BITRIX_RATE_LIMIT" | "BITRIX_UNAVAILABLE" | "BITRIX_INVALID_RESPONSE"
  | "BITRIX_NOT_CONFIGURED" | "BITRIX_AUTH" | "BITRIX_ERROR" | "LIVE_FETCH_FAILED";

export type LiveFetchMetrics = {
  /** Every Bitrix crm.deal.list call made, retries included. */
  requests: number;
  pages: number;
  retries: number;
  rows: number;
  durationMs: number;
  pagination: "KEYSET";
};

/** One Bitrix call. The route passes `bitrixCall`; tests pass a fake. */
export type BitrixPageCall = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<{ result?: unknown }>;

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

function unwrapList(result: unknown): RawCurrentStageDeal[] {
  if (Array.isArray(result)) return result as RawCurrentStageDeal[];
  if (result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)) return (result as { items: RawCurrentStageDeal[] }).items;
  return [];
}

export function classifyLiveError(error: unknown): { code: LiveErrorCode; retryable: boolean; message: string } {
  if (!(error instanceof SafeBitrixError)) return { code: "LIVE_FETCH_FAILED", retryable: true, message: "Bitrix live so‘rovi bajarilmadi" };
  const { code, statusClass, message } = error;
  if (code === "LIVE_BUDGET_EXCEEDED" || statusClass === "TIMEOUT") return { code: "BITRIX_TIMEOUT", retryable: true, message };
  if (statusClass === "NETWORK") return { code: "BITRIX_NETWORK", retryable: true, message };
  if (code === "QUERY_LIMIT_EXCEEDED" || code === "OPERATION_TIME_LIMIT") return { code: "BITRIX_RATE_LIMIT", retryable: true, message };
  if (statusClass === "HTTP_5XX") return { code: "BITRIX_UNAVAILABLE", retryable: true, message };
  if (code === "INVALID_RESPONSE") return { code: "BITRIX_INVALID_RESPONSE", retryable: true, message };
  if (code === "NOT_CONFIGURED") return { code: "BITRIX_NOT_CONFIGURED", retryable: false, message };
  if (["INVALID_CREDENTIALS", "NO_AUTH_FOUND", "expired_token", "invalid_token", "insufficient_scope", "ACCESS_DENIED", "HTTP_401", "HTTP_403"].includes(code)) {
    return { code: "BITRIX_AUTH", retryable: false, message };
  }
  return { code: "BITRIX_ERROR", retryable: statusClass !== "HTTP_4XX", message };
}

/**
 * Every open Deal of the given Sales categories, by ID keyset.
 *
 * `start: -1` tells Bitrix not to count the whole filtered set on every page,
 * and `>ID` replaces the OFFSET scan; each page is then an indexed range read.
 * Offset paging could also skip or repeat a Deal that closed mid-scan — keyset
 * paging cannot, because IDs only ever increase.
 *
 * Bounded three ways: the page budget (reported as truncated), the time budget
 * and the retry budget (both thrown, so the caller can fall back).
 */
export async function fetchOpenDealsKeyset(
  call: BitrixPageCall,
  input: { categoryIds: string[]; maxPages?: number; budgetMs?: number; requestTimeoutMs?: number; maxRetries?: number },
  clock: Clock = realClock,
): Promise<{ deals: RawCurrentStageDeal[]; truncated: boolean; metrics: LiveFetchMetrics }> {
  const maxPages = input.maxPages ?? LIVE_FETCH_MAX_PAGES;
  const requestTimeoutMs = input.requestTimeoutMs ?? LIVE_REQUEST_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? LIVE_FETCH_MAX_RETRIES;
  const started = clock.now();
  const deadline = started + (input.budgetMs ?? LIVE_FETCH_BUDGET_MS);
  const categoryFilter = input.categoryIds.length === 1 ? { CATEGORY_ID: input.categoryIds[0] } : { "@CATEGORY_ID": input.categoryIds };
  const metrics: LiveFetchMetrics = { requests: 0, pages: 0, retries: 0, rows: 0, durationMs: 0, pagination: "KEYSET" };
  const deals: RawCurrentStageDeal[] = [];
  let lastId = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const params = {
      order: { ID: "ASC" },
      filter: { ...categoryFilter, CLOSED: "N", ...(lastId ? { ">ID": lastId } : {}) },
      select: [...STAGE_CONTROL_DEAL_FIELDS],
      start: -1,
    };
    let items: RawCurrentStageDeal[] | null = null;
    while (items === null) {
      const remaining = deadline - clock.now();
      if (remaining <= 1_000) {
        throw new SafeBitrixError("LIVE_BUDGET_EXCEEDED", `Bitrix live so‘rovi ${Math.round((clock.now() - started) / 1000)} soniyada tugamadi`, "TIMEOUT");
      }
      metrics.requests += 1;
      try {
        items = unwrapList((await call("crm.deal.list", params, Math.min(requestTimeoutMs, remaining))).result);
      } catch (error) {
        const failure = classifyLiveError(error);
        if (!failure.retryable || metrics.retries >= maxRetries || deadline - clock.now() <= 5_000) throw error;
        metrics.retries += 1;
        await clock.sleep(failure.code === "BITRIX_RATE_LIMIT" ? 1_000 : 300);
      }
    }
    metrics.pages += 1;
    deals.push(...items);
    if (items.length < BITRIX_PAGE_SIZE) {
      metrics.rows = deals.length; metrics.durationMs = clock.now() - started;
      return { deals, truncated: false, metrics };
    }
    const nextId = Number(items[items.length - 1]?.ID);
    // A page whose last ID does not move forward would repeat forever.
    if (!Number.isFinite(nextId) || nextId <= lastId) throw new SafeBitrixError("INVALID_RESPONSE", "Bitrix Deal ID tartibi buzildi", "BITRIX");
    lastId = nextId;
  }
  metrics.rows = deals.length; metrics.durationMs = clock.now() - started;
  return { deals, truncated: true, metrics };
}

/* ------------------------------------------------------------ snapshot */

export const STAGE_CONTROL_SNAPSHOT_VERSION = 1;

/** The last successful live fetch of one project. Written only from a LIVE result. */
export type StageControlSnapshot = {
  version: typeof STAGE_CONTROL_SNAPSHOT_VERSION;
  source: "BITRIX_LIVE";
  project: ProjectKey;
  workspace: string;
  categoryIds: string[];
  fetchedAt: string;
  rowCount: number;
  truncated: boolean;
  deals: RawCurrentStageDeal[];
  stageCatalog: PipelineStageOption[];
  fetch: LiveFetchMetrics;
};

function sameIds(a: readonly string[], b: readonly string[]) {
  const left = [...new Set(a.map(String))].sort(); const right = [...new Set(b.map(String))].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Only the fields Stage Control reads, so the stored row stays small. */
function minimalDeal(deal: RawCurrentStageDeal): RawCurrentStageDeal {
  return Object.fromEntries(STAGE_CONTROL_DEAL_FIELDS.filter((key) => deal[key] !== undefined).map((key) => [key, deal[key]]));
}

export function snapshotFromLive(input: {
  project: ProjectKey; categoryIds: string[]; fetchedAt: string; deals: RawCurrentStageDeal[]; truncated: boolean;
  stageCatalog: PipelineStageOption[]; fetch: LiveFetchMetrics;
}): StageControlSnapshot {
  return {
    version: STAGE_CONTROL_SNAPSHOT_VERSION, source: "BITRIX_LIVE",
    project: input.project, workspace: STAGE_CONTROL_WORKSPACES[input.project], categoryIds: [...input.categoryIds].map(String),
    fetchedAt: input.fetchedAt, rowCount: input.deals.length, truncated: input.truncated,
    deals: input.deals.map(minimalDeal), stageCatalog: input.stageCatalog, fetch: input.fetch,
  };
}

/**
 * A stored snapshot, accepted only for the project and funnels it was taken
 * from. Anything else — another project, another category set, a Deal outside
 * this project's categories, an unknown version — is refused whole: the page
 * then reports "no snapshot" rather than showing another workspace's Deals.
 */
export function acceptSnapshot(raw: unknown, project: ProjectKey, categoryIds: string[]): StageControlSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const snapshot = raw as Partial<StageControlSnapshot>;
  if (snapshot.version !== STAGE_CONTROL_SNAPSHOT_VERSION || snapshot.source !== "BITRIX_LIVE") return null;
  if (snapshot.project !== project || snapshot.workspace !== STAGE_CONTROL_WORKSPACES[project]) return null;
  if (!Array.isArray(snapshot.categoryIds) || !sameIds(snapshot.categoryIds, categoryIds)) return null;
  if (!Array.isArray(snapshot.deals) || !Array.isArray(snapshot.stageCatalog) || !Number.isFinite(Date.parse(snapshot.fetchedAt ?? ""))) return null;
  const allowed = new Set(categoryIds.map(String));
  if (!snapshot.deals.every((deal) => allowed.has(String(deal?.CATEGORY_ID ?? "")))) return null;
  if (!snapshot.stageCatalog.every((stage) => allowed.has(String(stage?.categoryId ?? "")))) return null;
  return snapshot as StageControlSnapshot;
}

/* ------------------------------------------------------- the decision */

type Common = { project: ProjectKey; workspace: string };
export type StageControlLoad =
  | (Common & {
    liveStatus: "LIVE"; dataSource: "BITRIX_LIVE"; fetchedAt: string; lastSuccessfulAt: string; staleAgeSeconds: 0;
    liveErrorCode: null; retryable: false; deals: RawCurrentStageDeal[]; stageCatalog: PipelineStageOption[]; truncated: boolean;
    liveFetch: LiveFetchMetrics; snapshotSaved: boolean;
  })
  | (Common & {
    liveStatus: "DEGRADED"; dataSource: "LAST_SUCCESSFUL_LIVE"; fetchedAt: string; lastSuccessfulAt: string; staleAgeSeconds: number;
    liveErrorCode: LiveErrorCode; retryable: boolean; liveError: string; deals: RawCurrentStageDeal[]; stageCatalog: PipelineStageOption[]; truncated: boolean;
  })
  | (Common & {
    liveStatus: "UNAVAILABLE"; dataSource: null; fetchedAt: null; lastSuccessfulAt: null; staleAgeSeconds: null;
    liveErrorCode: LiveErrorCode; retryable: boolean; liveError: string;
  });

/**
 * Live first; on any live failure, this project's last successful live
 * snapshot, labelled as such; with no snapshot, a retryable error — never an
 * empty list that would read as "no open Deals".
 */
export async function loadStageControl(deps: {
  project: ProjectKey;
  categoryIds: string[];
  fetchDeals: () => Promise<{ deals: RawCurrentStageDeal[]; truncated: boolean; metrics: LiveFetchMetrics }>;
  fetchStages: () => Promise<PipelineStageOption[]>;
  readSnapshot: () => Promise<unknown>;
  writeSnapshot: (snapshot: StageControlSnapshot) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<StageControlLoad> {
  const now = deps.now ?? (() => new Date());
  const common: Common = { project: deps.project, workspace: STAGE_CONTROL_WORKSPACES[deps.project] };
  const [deals, stages] = await Promise.allSettled([deps.fetchDeals(), deps.fetchStages()]);

  if (deals.status === "fulfilled" && stages.status === "fulfilled") {
    const fetchedAt = now().toISOString();
    const snapshot = snapshotFromLive({
      project: deps.project, categoryIds: deps.categoryIds, fetchedAt, deals: deals.value.deals, truncated: deals.value.truncated,
      stageCatalog: stages.value, fetch: deals.value.metrics,
    });
    let snapshotSaved = true;
    try { await deps.writeSnapshot(snapshot); } catch {
      snapshotSaved = false;
      deps.log?.(`stage-control: ${deps.project} snapshot saqlanmadi`);
    }
    return {
      ...common, liveStatus: "LIVE", dataSource: "BITRIX_LIVE", fetchedAt, lastSuccessfulAt: fetchedAt, staleAgeSeconds: 0,
      liveErrorCode: null, retryable: false, deals: deals.value.deals, stageCatalog: stages.value, truncated: deals.value.truncated,
      liveFetch: deals.value.metrics, snapshotSaved,
    };
  }

  const failure = classifyLiveError(deals.status === "rejected" ? deals.reason : (stages as PromiseRejectedResult).reason);
  deps.log?.(`stage-control: ${deps.project} live olinmadi (${failure.code})`);
  let snapshot: StageControlSnapshot | null = null;
  try { snapshot = acceptSnapshot(await deps.readSnapshot(), deps.project, deps.categoryIds); } catch {
    deps.log?.(`stage-control: ${deps.project} snapshot o‘qilmadi`);
  }
  if (!snapshot) {
    return {
      ...common, liveStatus: "UNAVAILABLE", dataSource: null, fetchedAt: null, lastSuccessfulAt: null, staleAgeSeconds: null,
      liveErrorCode: failure.code, retryable: failure.retryable, liveError: failure.message,
    };
  }
  return {
    ...common, liveStatus: "DEGRADED", dataSource: "LAST_SUCCESSFUL_LIVE",
    fetchedAt: snapshot.fetchedAt, lastSuccessfulAt: snapshot.fetchedAt,
    staleAgeSeconds: Math.max(0, Math.floor((now().getTime() - Date.parse(snapshot.fetchedAt)) / 1000)),
    liveErrorCode: failure.code, retryable: failure.retryable, liveError: failure.message,
    deals: snapshot.deals, stageCatalog: snapshot.stageCatalog, truncated: snapshot.truncated,
  };
}

/* ------------------------------------------------------------- storage */

/** One row per project: a later live success replaces it, nothing else writes it. */
export const STAGE_CONTROL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS stage_control_snapshots (
  project_key TEXT PRIMARY KEY NOT NULL,
  workspace_key TEXT NOT NULL,
  category_ids TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
];

/** An older fetch finishing late never overwrites a newer snapshot. */
export const SNAPSHOT_UPSERT_SQL = `INSERT INTO stage_control_snapshots(project_key, workspace_key, category_ids, fetched_at, row_count, source, payload, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(project_key) DO UPDATE SET workspace_key = excluded.workspace_key, category_ids = excluded.category_ids,
  fetched_at = excluded.fetched_at, row_count = excluded.row_count, source = excluded.source, payload = excluded.payload, updated_at = excluded.updated_at
WHERE excluded.fetched_at >= stage_control_snapshots.fetched_at`;

export const SNAPSHOT_READ_SQL = "SELECT payload FROM stage_control_snapshots WHERE project_key = ?";

/** D1 refuses rows near 2 MB; a snapshot that large is skipped rather than failing the live response. */
export const SNAPSHOT_MAX_BYTES = 1_800_000;

export function snapshotBindings(snapshot: StageControlSnapshot, updatedAt: string) {
  const payload = JSON.stringify(snapshot);
  if (new TextEncoder().encode(payload).length > SNAPSHOT_MAX_BYTES) throw new Error("STAGE_CONTROL_SNAPSHOT_TOO_LARGE");
  return [snapshot.project, snapshot.workspace, JSON.stringify(snapshot.categoryIds), snapshot.fetchedAt, snapshot.rowCount, snapshot.source, payload, updatedAt];
}

export function parseSnapshotPayload(payload: string | null | undefined): unknown {
  if (!payload) return null;
  try { return JSON.parse(payload); } catch { return null; }
}
