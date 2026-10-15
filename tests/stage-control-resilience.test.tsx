import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StageLiveStatus, parseStageLiveMeta, type StageLiveMeta } from "../app/stage-control-status";
import { defaultSettings } from "../lib/business-time";
import { buildCurrentStageRecords, type RawCurrentStageDeal } from "../lib/current-stages";
import { filterCurrentStageRecords } from "../lib/record-filters";
import { SafeBitrixError } from "../lib/safe-bitrix-error";
import {
  acceptSnapshot, BITRIX_PAGE_SIZE, classifyLiveError, fetchOpenDealsKeyset, liveBudgetFromEnv, loadStageControl, parseSnapshotPayload, rangeSplitIds,
  SNAPSHOT_READ_SQL, SNAPSHOT_UPSERT_SQL, snapshotBindings, snapshotFromLive, STAGE_CONTROL_DEAL_FIELDS,
  STAGE_CONTROL_SCHEMA_STATEMENTS, type BitrixPageCall, type LiveFetchMetrics, type StageControlSnapshot,
} from "../lib/stage-control-live";
import type { ProjectKey } from "../lib/sales-projects";
import type { PipelineStageOption } from "../lib/types";

/**
 * Live Stage Control resilience: keyset live fetch, a project-scoped
 * last-successful snapshot, and an explicit LIVE / DEGRADED / UNAVAILABLE
 * contract instead of an HTTP 500 when Bitrix is slow.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const T0 = new Date("2026-10-15T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const timeout = () => new SafeBitrixError("NETWORK_ERROR", "Bitrix24 so‘rovi 25 soniyada javob bermadi", "TIMEOUT");
const metrics: LiveFetchMetrics = { requests: 1, pages: 1, retries: 0, rows: 0, durationMs: 1, pagination: "KEYSET" };

const deal = (id: number, category: string, stage: string, manager = "7", extra: RawCurrentStageDeal = {}): RawCurrentStageDeal => ({
  ID: String(id), TITLE: `Deal ${id}`, DATE_CREATE: "2026-10-01T09:00:00+05:00", DATE_MODIFY: "2026-10-10T09:00:00+05:00",
  MOVED_TIME: "2026-10-14T09:00:00+05:00", ASSIGNED_BY_ID: manager, CATEGORY_ID: category, STAGE_ID: stage, STAGE_SEMANTIC_ID: "P", SOURCE_ID: "WEB", ...extra,
});
const stage = (categoryId: string, id: string, name: string, sort = 10): PipelineStageOption => ({ id, name, categoryId, sort, semantics: "" });
const IBOX = { project: "IBOX" as ProjectKey, categoryIds: ["3"] };
const SD = { project: "SALES_DOCTOR" as ProjectKey, categoryIds: ["5"] };
const IBOX_STAGES = [stage("3", "C3:NEW", "Yangi"), stage("3", "C3:WORK", "Ishlov")];
const SD_STAGES = [stage("5", "C5:NEW", "Yangi"), stage("5", "C5:NR", "Not Relevant", 80), stage("5", "C5:LOSE", "Sotilmadi", 90), stage("5", "C5:PAY", "To‘lov", 70)];

/** An in-memory snapshot store keyed exactly like the D1 table: by project. */
function memoryStore() {
  const rows = new Map<string, string>();
  return {
    rows,
    read: (project: ProjectKey) => async () => parseSnapshotPayload(rows.get(project)),
    write: async (snapshot: StageControlSnapshot) => { rows.set(snapshot.project, JSON.stringify(snapshot)); },
  };
}

function load(scope: { project: ProjectKey; categoryIds: string[] }, store: ReturnType<typeof memoryStore>, live: { deals?: RawCurrentStageDeal[]; error?: unknown; stages?: PipelineStageOption[] }, now: Date) {
  return loadStageControl({
    ...scope,
    fetchDeals: async () => { if (live.error) throw live.error; return { deals: live.deals ?? [], truncated: false, metrics: { ...metrics, rows: live.deals?.length ?? 0 } }; },
    fetchStages: async () => live.stages ?? (scope.project === "IBOX" ? IBOX_STAGES : SD_STAGES),
    readSnapshot: store.read(scope.project),
    writeSnapshot: store.write,
    now: () => now,
  });
}

/* ------------------------------------------------------------ A, B, C, G */

test("A. a live success returns fresh BITRIX_LIVE rows and stores them as the snapshot", async () => {
  const store = memoryStore();
  const result = await load(IBOX, store, { deals: [deal(11, "3", "C3:NEW"), deal(12, "3", "C3:WORK")] }, T0);
  assert.equal(result.liveStatus, "LIVE");
  assert.equal(result.dataSource, "BITRIX_LIVE");
  assert.equal(result.fetchedAt, T0.toISOString());
  assert.equal(result.lastSuccessfulAt, T0.toISOString());
  assert.equal(result.staleAgeSeconds, 0);
  assert.equal(result.liveErrorCode, null);
  assert.ok(result.liveStatus === "LIVE" && result.snapshotSaved);
  const saved = JSON.parse(store.rows.get("IBOX")!) as StageControlSnapshot;
  assert.equal(saved.fetchedAt, T0.toISOString());
  assert.equal(saved.rowCount, 2);
  assert.equal(saved.workspace, "IBOX_UZ");
  assert.deepEqual(saved.deals.map((row) => row.ID), ["11", "12"]);
  assert.deepEqual(saved.categoryIds, ["3"]);
});

test("B. a later Bitrix timeout returns the last successful snapshot, labelled DEGRADED with its age", async () => {
  const store = memoryStore();
  await load(IBOX, store, { deals: [deal(11, "3", "C3:NEW")] }, T0);
  const result = await load(IBOX, store, { error: timeout() }, at(30));
  assert.equal(result.liveStatus, "DEGRADED");
  assert.equal(result.dataSource, "LAST_SUCCESSFUL_LIVE");
  assert.equal(result.liveErrorCode, "BITRIX_TIMEOUT");
  assert.equal(result.retryable, true);
  assert.equal(result.lastSuccessfulAt, T0.toISOString());
  assert.equal(result.fetchedAt, T0.toISOString(), "the rows' own fetch time, not now");
  assert.equal(result.staleAgeSeconds, 1800);
  assert.ok(result.liveStatus === "DEGRADED");
  assert.deepEqual(result.deals.map((row) => row.ID), ["11"]);
  // The failure never overwrites the snapshot.
  assert.equal((JSON.parse(store.rows.get("IBOX")!) as StageControlSnapshot).fetchedAt, T0.toISOString());
});

test("C. a timeout with no snapshot is a retryable UNAVAILABLE — no rows at all, not zero rows", async () => {
  const result = await load(IBOX, memoryStore(), { error: timeout() }, T0);
  assert.equal(result.liveStatus, "UNAVAILABLE");
  assert.equal(result.dataSource, null);
  assert.equal(result.lastSuccessfulAt, null);
  assert.equal(result.liveErrorCode, "BITRIX_TIMEOUT");
  assert.equal(result.retryable, true);
  assert.equal("deals" in result, false, "there is no deal list to mistake for an empty workload");
  // The route turns it into a 503 with records: null — never a 500, never [].
  const route = read("app/api/current-stages/route.ts");
  assert.match(route, /if \(load\.liveStatus === "UNAVAILABLE"\) \{[\s\S]*?records: null, rowCount: null[\s\S]*?status: 503/);
  assert.doesNotMatch(route.slice(route.indexOf("loadStageControl({"), route.indexOf("} catch (error)")), /status: 500/);
});

test("G. Retry: the next live success replaces the stale snapshot with new live data", async () => {
  const store = memoryStore();
  await load(IBOX, store, { deals: [deal(11, "3", "C3:NEW")] }, T0);
  assert.equal((await load(IBOX, store, { error: timeout() }, at(5))).liveStatus, "DEGRADED");
  const retried = await load(IBOX, store, { deals: [deal(11, "3", "C3:WORK"), deal(13, "3", "C3:NEW")] }, at(6));
  assert.equal(retried.liveStatus, "LIVE");
  assert.equal(retried.lastSuccessfulAt, at(6).toISOString());
  const saved = JSON.parse(store.rows.get("IBOX")!) as StageControlSnapshot;
  assert.equal(saved.fetchedAt, at(6).toISOString());
  assert.deepEqual(saved.deals.map((row) => [row.ID, row.STAGE_ID]), [["11", "C3:WORK"], ["13", "C3:NEW"]]);
});

test("a stage-catalog failure is a live failure too: no half-live answer", async () => {
  const store = memoryStore();
  await load(SD, store, { deals: [deal(21, "5", "C5:NEW")] }, T0);
  const result = await loadStageControl({
    ...SD, fetchDeals: async () => ({ deals: [deal(22, "5", "C5:NEW")], truncated: false, metrics }),
    fetchStages: async () => { throw new SafeBitrixError("HTTP_503", "Bitrix band", "HTTP_5XX"); },
    readSnapshot: store.read("SALES_DOCTOR"), writeSnapshot: store.write, now: () => at(1),
  });
  assert.equal(result.liveStatus, "DEGRADED");
  assert.equal(result.liveErrorCode, "BITRIX_UNAVAILABLE");
});

test("a snapshot that cannot be saved does not fail the live answer", async () => {
  const result = await loadStageControl({
    ...IBOX, fetchDeals: async () => ({ deals: [deal(11, "3", "C3:NEW")], truncated: false, metrics }), fetchStages: async () => IBOX_STAGES,
    readSnapshot: async () => null, writeSnapshot: async () => { throw new Error("D1 down"); }, now: () => T0,
  });
  assert.equal(result.liveStatus, "LIVE");
  assert.ok(result.liveStatus === "LIVE" && result.snapshotSaved === false);
});

/* ------------------------------------------------------------------ D, E */

test("D. an IBOX (category 3) snapshot can never appear in Sales Doctor", async () => {
  const store = memoryStore();
  await load(IBOX, store, { deals: [deal(11, "3", "C3:NEW")] }, T0);
  const ibox = parseSnapshotPayload(store.rows.get("IBOX"));
  assert.equal(acceptSnapshot(ibox, "SALES_DOCTOR", ["5"]), null);
  // Even if the row landed under the wrong key, its own project and categories refuse it.
  store.rows.set("SALES_DOCTOR", store.rows.get("IBOX")!);
  const result = await load(SD, store, { error: timeout() }, at(1));
  assert.equal(result.liveStatus, "UNAVAILABLE");
});

test("E. a Sales Doctor (category 5) snapshot can never appear in IBOX", async () => {
  const store = memoryStore();
  await load(SD, store, { deals: [deal(21, "5", "C5:NEW")] }, T0);
  assert.equal(store.rows.has("IBOX"), false);
  assert.equal((await load(IBOX, store, { error: timeout() }, at(1))).liveStatus, "UNAVAILABLE");
  // A forged IBOX-labelled snapshot that carries a category-5 Deal is refused whole.
  const forged = snapshotFromLive({ project: "IBOX", categoryIds: ["3"], fetchedAt: T0.toISOString(), deals: [deal(11, "3", "C3:NEW"), deal(21, "5", "C5:NEW")], truncated: false, stageCatalog: IBOX_STAGES, fetch: metrics });
  assert.equal(acceptSnapshot(forged, "IBOX", ["3"]), null);
  // And a snapshot taken for another funnel set is not this funnel set's.
  const other = snapshotFromLive({ project: "IBOX", categoryIds: ["3", "13"], fetchedAt: T0.toISOString(), deals: [deal(11, "3", "C3:NEW")], truncated: false, stageCatalog: IBOX_STAGES, fetch: metrics });
  assert.equal(acceptSnapshot(other, "IBOX", ["3"]), null);
  assert.ok(acceptSnapshot({ ...other, categoryIds: ["3"] }, "IBOX", ["3"]));
});

/* ------------------------------------------------------------------- F, H */

const SD_SETTINGS = { ...defaultSettings, selectedPipelineIds: ["5"], lowQualityStageIds: ["C5:NR"], closedLostStageIds: ["C5:LOSE"], paymentStageIds: ["C5:PAY"] };
function rebuild(deals: RawCurrentStageDeal[], stages: PipelineStageOption[]) {
  const excluded: Record<string, string[]> = {};
  const records = buildCurrentStageRecords({
    deals, settings: SD_SETTINGS, pipelines: new Map([["5", "SD Sales"]]),
    stages: new Map(stages.map((row) => [`${row.categoryId}:${row.id}`, row.name])),
    users: new Map([["7", "Aziza"], ["8", "Bobur"]]), sources: new Map([["WEB", "Sayt"], ["CALL", "Qo‘ng‘iroq"]]), domain: null, now: T0,
    onExcluded: (reason, id) => { (excluded[reason] ??= []).push(id); },
  });
  return { records, excluded };
}

test("F. Not Relevant, Lost and Won/payment stay excluded — live rows and snapshot rows alike", async () => {
  const deals = [deal(21, "5", "C5:NEW"), deal(22, "5", "C5:NR"), deal(23, "5", "C5:LOSE"), deal(24, "5", "C5:PAY"), deal(25, "5", "C5:NEW", "7", { STAGE_SEMANTIC_ID: "F" })];
  const store = memoryStore();
  const live = await load(SD, store, { deals }, T0);
  const degraded = await load(SD, store, { error: timeout() }, at(10));
  assert.ok(live.liveStatus === "LIVE" && degraded.liveStatus === "DEGRADED");
  for (const result of [live, degraded]) {
    const { records, excluded } = rebuild(result.deals, result.stageCatalog);
    assert.deepEqual(records.map((row) => row.dealId), ["21"]);
    assert.deepEqual(excluded, { NOT_RELEVANT: ["22"], SALES_LOST: ["23", "25"], WON: ["24"] });
  }
  // And closed Deals are never asked for: the live filter is CLOSED = N.
  const calls: Record<string, unknown>[] = [];
  await fetchOpenDealsKeyset(async (_method, params) => { calls.push(params); return { result: [] }; }, { categoryIds: ["5"] });
  assert.equal((calls[0].filter as Record<string, unknown>).CLOSED, "N");
  assert.equal((calls[0].filter as Record<string, unknown>).CATEGORY_ID, "5");
});

test("H. the existing filters work on the fallback snapshot: manager, source, stage, search", async () => {
  const deals = [deal(21, "5", "C5:NEW", "7"), deal(26, "5", "C5:NEW", "8", { SOURCE_ID: "CALL", TITLE: "Toshkent ombor" })];
  const store = memoryStore();
  await load(SD, store, { deals }, T0);
  const degraded = await load(SD, store, { error: timeout() }, at(10));
  assert.ok(degraded.liveStatus === "DEGRADED");
  const { records } = rebuild(degraded.deals, degraded.stageCatalog);
  const ids = (filters: Parameters<typeof filterCurrentStageRecords>[1]) => filterCurrentStageRecords(records, filters).map((row) => row.dealId);
  assert.deepEqual(ids({ managers: ["8"] }), ["26"]);
  assert.deepEqual(ids({ sources: ["Sayt"] }), ["21"]);
  assert.deepEqual(ids({ stage: "Yangi" }), ["21", "26"]);
  assert.deepEqual(ids({ search: "ombor" }), ["26"]);
  assert.deepEqual(ids({ pipeline: "SD Sales", managers: ["7"] }), ["21"]);
});

/* -------------------------------------------------- J + the keyset fetch */

function pagedBitrix(total: number, failures: Record<number, unknown> = {}, idsOverride?: number[]) {
  const ids = idsOverride ?? Array.from({ length: total }, (_, index) => 1000 + index * 3);
  const calls: { method: string; params: Record<string, unknown>; timeoutMs: number }[] = [];
  let inFlight = 0; let maxInFlight = 0;
  const call: BitrixPageCall = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    const failure = failures[calls.length];
    if (failure) throw failure;
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const filter = params.filter as Record<string, unknown>;
    const after = Number(filter[">ID"] ?? 0); const upTo = filter["<=ID"] === undefined ? Infinity : Number(filter["<=ID"]);
    return { result: ids.filter((id) => id > after && id <= upTo).slice(0, BITRIX_PAGE_SIZE).map((id) => deal(id, "3", "C3:NEW")) };
  };
  return { call, calls, ids, maxInFlight: () => maxInFlight };
}

test("parallel ID ranges: split at the previous snapshot's quantiles, every Deal exactly once, at most 4 at a time", async () => {
  // Open Deals cluster in recent IDs: 20 old ones, 230 recent ones.
  const ids = [...Array.from({ length: 20 }, (_, index) => 100 + index * 50), ...Array.from({ length: 230 }, (_, index) => 40_000 + index * 7)];
  const splitIds = rangeSplitIds(ids.map(String));
  assert.equal(splitIds.length, 3, "250 rows → 4 ranges");
  assert.ok(splitIds.every((id, index) => index === 0 || id > splitIds[index - 1]));
  const bitrix = pagedBitrix(0, {}, ids);
  const result = await fetchOpenDealsKeyset(bitrix.call, { categoryIds: ["3"], splitIds });
  assert.deepEqual(result.deals.map((row) => Number(row.ID)), ids, "complete, ordered, no repeats");
  assert.ok(bitrix.maxInFlight() <= 4 && bitrix.maxInFlight() > 1, `parallel but bounded (${bitrix.maxInFlight()})`);
  // Each range is (low, high]: the first has no >ID, the last has no <=ID.
  const firsts = bitrix.calls.filter((entry) => !(">ID" in (entry.params.filter as object)) || splitIds.includes(Number((entry.params.filter as Record<string, unknown>)[">ID"])));
  assert.equal(firsts.length, 4);
  assert.equal(bitrix.calls.filter((entry) => !("<=ID" in (entry.params.filter as object))).length >= 1, true);
  assert.ok(result.metrics.pages <= 8, `balanced ranges keep pages low (${result.metrics.pages})`);
  // A stale hint costs balance, never completeness.
  const stale = await fetchOpenDealsKeyset(pagedBitrix(0, {}, ids).call, { categoryIds: ["3"], splitIds: [5, 6, 7] });
  assert.deepEqual(stale.deals.map((row) => Number(row.ID)), ids);
  // No snapshot → no split → one sequential range.
  assert.deepEqual(rangeSplitIds([]), []);
  assert.deepEqual(rangeSplitIds(ids.slice(0, 60).map(String)), [], "one page of rows is not worth splitting");
});

test("the range plan comes from this project's accepted snapshot only", async () => {
  const store = memoryStore();
  const many = Array.from({ length: 300 }, (_, index) => deal(1000 + index, "3", "C3:NEW"));
  await load(IBOX, store, { deals: many }, T0);
  const hints: number[][] = [];
  const run = (scope: typeof IBOX) => loadStageControl({
    ...scope, fetchDeals: async ({ splitIds }) => { hints.push(splitIds); return { deals: [], truncated: false, metrics }; },
    fetchStages: async () => [], readSnapshot: store.read(scope.project), writeSnapshot: store.write, now: () => at(1),
  });
  await run(IBOX);
  assert.equal(hints[0].length, 3);
  store.rows.set("SALES_DOCTOR", store.rows.get("IBOX")!);
  await run(SD);
  assert.deepEqual(hints[1], [], "an IBOX snapshot does not even shape Sales Doctor's query");
});

test("J. the live fetch is crm.deal.list only, with the Stage Control fields only — no stage history", async () => {
  const bitrix = pagedBitrix(120);
  const result = await fetchOpenDealsKeyset(bitrix.call, { categoryIds: ["3"] });
  assert.deepEqual([...new Set(bitrix.calls.map((entry) => entry.method))], ["crm.deal.list"]);
  for (const { params } of bitrix.calls) {
    assert.deepEqual(params.select, [...STAGE_CONTROL_DEAL_FIELDS]);
    assert.doesNotMatch(JSON.stringify(params), /stagehistory|UF_CRM|\*/i);
  }
  assert.equal(result.deals.length, 120);
  const route = read("app/api/current-stages/route.ts");
  assert.doesNotMatch(route, /stagehistory|crm\.stagehistory|listStageHistory/i);
});

test("keyset paging: start -1 (no total count), >ID cursor, every Deal exactly once, bounded pages", async () => {
  const bitrix = pagedBitrix(120);
  const result = await fetchOpenDealsKeyset(bitrix.call, { categoryIds: ["3"] });
  assert.equal(bitrix.calls.length, 3);
  assert.deepEqual(bitrix.calls.map((entry) => entry.params.start), [-1, -1, -1]);
  assert.deepEqual(bitrix.calls.map((entry) => (entry.params.filter as Record<string, unknown>)[">ID"]), [undefined, bitrix.ids[49], bitrix.ids[99]]);
  assert.deepEqual(bitrix.calls[0].params.order, { ID: "ASC" });
  assert.equal(new Set(result.deals.map((row) => row.ID)).size, 120);
  assert.equal(result.truncated, false);
  assert.deepEqual({ requests: result.metrics.requests, pages: result.metrics.pages, retries: result.metrics.retries, rows: result.metrics.rows }, { requests: 3, pages: 3, retries: 0, rows: 120 });
  // The page budget is reported, never silently presented as complete.
  const capped = await fetchOpenDealsKeyset(pagedBitrix(500).call, { categoryIds: ["3"], maxPages: 2 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.deals.length, 100);
  // Several categories go to Bitrix as one @CATEGORY_ID filter.
  const multi = pagedBitrix(1);
  await fetchOpenDealsKeyset(multi.call, { categoryIds: ["3", "13"] });
  assert.deepEqual((multi.calls[0].params.filter as Record<string, unknown>)["@CATEGORY_ID"], ["3", "13"]);
});

test("a transient page failure is retried once within the budget; a hard one is not retried", async () => {
  const flaky = pagedBitrix(60, { 2: timeout() });
  const result = await fetchOpenDealsKeyset(flaky.call, { categoryIds: ["3"] }, { now: () => 0, sleep: async () => {} });
  assert.equal(result.deals.length, 60);
  assert.deepEqual({ requests: result.metrics.requests, retries: result.metrics.retries }, { requests: 3, retries: 1 });
  const hard = pagedBitrix(60, { 1: new SafeBitrixError("INVALID_CREDENTIALS", "Webhook rad etildi", "BITRIX") });
  await assert.rejects(fetchOpenDealsKeyset(hard.call, { categoryIds: ["3"] }, { now: () => 0, sleep: async () => {} }), /Webhook rad etildi/);
  assert.equal(hard.calls.length, 1);
  // The retry budget is finite.
  const down = pagedBitrix(60, { 1: timeout(), 2: timeout(), 3: timeout(), 4: timeout() });
  await assert.rejects(fetchOpenDealsKeyset(down.call, { categoryIds: ["3"] }, { now: () => 0, sleep: async () => {} }));
  assert.equal(down.calls.length, 3);
});

test("the whole live fetch has a time budget: it gives up instead of waiting page after page", async () => {
  let clock = 0;
  const slow: BitrixPageCall = async (_method, params, timeoutMs) => {
    clock += 15_000;
    assert.ok(timeoutMs <= 25_000);
    const after = Number((params.filter as Record<string, unknown>)[">ID"] ?? 0);
    return { result: Array.from({ length: BITRIX_PAGE_SIZE }, (_, index) => deal(after + index + 1, "3", "C3:NEW")) };
  };
  const failure = await fetchOpenDealsKeyset(slow, { categoryIds: ["3"], budgetMs: 40_000 }, { now: () => clock, sleep: async () => {} }).catch((error: unknown) => error);
  assert.equal(classifyLiveError(failure).code, "BITRIX_TIMEOUT");
  assert.equal(clock, 45_000, "three 15 s pages, then the budget stops it");
});

test("the live budget variable is optional and clamped; a tiny one fails fast as a timeout", async () => {
  assert.equal(liveBudgetFromEnv(undefined), 40_000);
  assert.equal(liveBudgetFromEnv(""), 40_000);
  assert.equal(liveBudgetFromEnv("abc"), 40_000);
  assert.equal(liveBudgetFromEnv(" 15000 "), 15_000);
  assert.equal(liveBudgetFromEnv("0"), 1);
  assert.equal(liveBudgetFromEnv("9999999"), 120_000);
  const bitrix = pagedBitrix(10);
  const failure = await fetchOpenDealsKeyset(bitrix.call, { categoryIds: ["3"], budgetMs: liveBudgetFromEnv("1") }).catch((error: unknown) => error);
  assert.equal(classifyLiveError(failure).code, "BITRIX_TIMEOUT");
  assert.equal(bitrix.calls.length, 0, "no Bitrix call is started without budget for it");
});

test("a page whose last ID does not advance stops the fetch instead of looping", async () => {
  const stuck: BitrixPageCall = async () => ({ result: Array.from({ length: BITRIX_PAGE_SIZE }, () => deal(5, "3", "C3:NEW")) });
  const failure = await fetchOpenDealsKeyset(stuck, { categoryIds: ["3"] }).catch((error: unknown) => error);
  assert.equal(classifyLiveError(failure).code, "BITRIX_INVALID_RESPONSE");
});

test("live error codes: transient failures are retryable, configuration and auth failures are not", () => {
  assert.deepEqual(classifyLiveError(timeout()).code, "BITRIX_TIMEOUT");
  assert.deepEqual(classifyLiveError(new SafeBitrixError("NETWORK_ERROR", "x", "NETWORK")).code, "BITRIX_NETWORK");
  assert.deepEqual(classifyLiveError(new SafeBitrixError("QUERY_LIMIT_EXCEEDED", "x", "BITRIX")), { code: "BITRIX_RATE_LIMIT", retryable: true, message: "x" });
  assert.deepEqual(classifyLiveError(new SafeBitrixError("HTTP_502", "x", "HTTP_5XX")).code, "BITRIX_UNAVAILABLE");
  assert.equal(classifyLiveError(new SafeBitrixError("NOT_CONFIGURED", "x")).retryable, false);
  assert.equal(classifyLiveError(new SafeBitrixError("INVALID_CREDENTIALS", "x", "BITRIX")).code, "BITRIX_AUTH");
  assert.equal(classifyLiveError(new Error("boom")).code, "LIVE_FETCH_FAILED");
});

/* ------------------------------------------------------- storage (SQLite) */

test("the migration file is exactly the schema module, additive only", () => {
  const sql = read("drizzle/0016_stage_control_snapshot.sql");
  for (const statement of STAGE_CONTROL_SCHEMA_STATEMENTS) assert.ok(sql.includes(`${statement};`), statement.slice(0, 60));
  assert.doesNotMatch(sql, /\b(DROP|ALTER|DELETE|UPDATE)\b/i);
  assert.ok(STAGE_CONTROL_SCHEMA_STATEMENTS.every((statement) => /^CREATE TABLE IF NOT EXISTS/.test(statement)));
});

test("one snapshot row per project; an older fetch finishing late never overwrites a newer one", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(STAGE_CONTROL_SCHEMA_STATEMENTS.join(";\n"));
  const upsert = db.prepare(SNAPSHOT_UPSERT_SQL);
  const snap = (project: ProjectKey, categoryIds: string[], fetchedAt: Date, ids: number[]) => snapshotFromLive({
    project, categoryIds, fetchedAt: fetchedAt.toISOString(), deals: ids.map((id) => deal(id, categoryIds[0], `C${categoryIds[0]}:NEW`)), truncated: false, stageCatalog: [], fetch: metrics,
  });
  upsert.run(...(snapshotBindings(snap("IBOX", ["3"], at(10), [1, 2]), "w1") as never[]));
  upsert.run(...(snapshotBindings(snap("IBOX", ["3"], at(5), [9]), "w2") as never[]));
  upsert.run(...(snapshotBindings(snap("SALES_DOCTOR", ["5"], at(7), [3]), "w3") as never[]));
  const readRow = (project: string) => parseSnapshotPayload((db.prepare(SNAPSHOT_READ_SQL).get(project) as { payload: string }).payload) as StageControlSnapshot;
  assert.deepEqual(readRow("IBOX").deals.map((row) => row.ID), ["1", "2"]);
  assert.equal(readRow("IBOX").fetchedAt, at(10).toISOString());
  assert.deepEqual(readRow("SALES_DOCTOR").deals.map((row) => row.ID), ["3"]);
  assert.deepEqual(db.prepare("SELECT project_key, workspace_key, row_count FROM stage_control_snapshots ORDER BY project_key").all().map((row) => ({ ...row })), [
    { project_key: "IBOX", workspace_key: "IBOX_UZ", row_count: 2 },
    { project_key: "SALES_DOCTOR", workspace_key: "SD_UZ", row_count: 1 },
  ]);
  // Only the Stage Control fields are stored.
  const stored = snapshotFromLive({ project: "IBOX", categoryIds: ["3"], fetchedAt: T0.toISOString(), deals: [{ ...deal(1, "3", "C3:NEW"), UF_CRM_SECRET: "x", OPPORTUNITY: "9" }], truncated: false, stageCatalog: [], fetch: metrics });
  assert.deepEqual(Object.keys(stored.deals[0]).sort(), [...STAGE_CONTROL_DEAL_FIELDS].sort());
});

test("the snapshot lives in its own table, not crm_dictionaries (part of the Sales cache fingerprint)", () => {
  const store = read("lib/stage-control-snapshot.ts");
  assert.doesNotMatch(store, /setDictionary|getDictionary|(INTO|FROM) crm_dictionaries/);
  assert.match(store, /SNAPSHOT_UPSERT_SQL/);
  assert.match(read("lib/storage.ts"), /SELECT max\(updated_at\) FROM crm_dictionaries/);
});

/* ------------------------------------------------------------------ I + UI */

const meta = (over: Partial<StageLiveMeta>): StageLiveMeta => ({
  liveStatus: "LIVE", dataSource: "BITRIX_LIVE", fetchedAt: T0.toISOString(), lastSuccessfulAt: T0.toISOString(), staleAgeSeconds: 0, liveErrorCode: null, retryable: false, ...over,
});
const render = (props: Partial<Parameters<typeof StageLiveStatus>[0]>) => renderToStaticMarkup(<StageLiveStatus meta={null} loading={false} error={null} onRetry={() => {}} {...props} />);

test("UI: fresh state says Live Bitrix; degraded says so in words, with the last success time and Qayta urinish", () => {
  const live = render({ meta: meta({}) });
  assert.match(live, /Live Bitrix/);
  assert.doesNotMatch(live, /Qayta urinish|olinmadi/);
  const degraded = render({ meta: meta({ liveStatus: "DEGRADED", dataSource: "LAST_SUCCESSFUL_LIVE", staleAgeSeconds: 1800, liveErrorCode: "BITRIX_TIMEOUT", retryable: true }) });
  assert.match(degraded, /Live ma’lumot olinmadi — oxirgi muvaffaqiyatli ma’lumot ko‘rsatilmoqda/);
  assert.match(degraded, /Oxirgi muvaffaqiyatli yangilanish: /);
  assert.match(degraded, /15[./]10[./]2026,? 15:00/, "Tashkent time");
  assert.match(degraded, /30 daqiqa oldin/);
  assert.match(degraded, /Qayta urinish/);
  assert.doesNotMatch(degraded, /Live Bitrix/, "cached data is never labelled live");
});

test("I. no infinite loading: a finished failure shows an error with Retry, not a spinner; Retry is disabled only while in flight", () => {
  const unavailable = render({ meta: meta({ liveStatus: "UNAVAILABLE", dataSource: null, fetchedAt: null, lastSuccessfulAt: null, staleAgeSeconds: null, liveErrorCode: "BITRIX_TIMEOUT", retryable: true }), error: "Bitrix24 so‘rovi 25 soniyada javob bermadi" });
  assert.match(unavailable, /Live ma’lumot olinmadi/);
  assert.match(unavailable, /raqamlar ko‘rsatilmaydi/);
  assert.match(unavailable, /Qayta urinish/);
  assert.doesNotMatch(unavailable, /spin|disabled/);
  assert.match(render({ meta: meta({ liveStatus: "UNAVAILABLE", dataSource: null, lastSuccessfulAt: null }), loading: true }), /disabled=""/);
  assert.match(render({ loading: true }), /olinmoqda/);
  assert.equal(render({ loading: false }), "");
  // The loader always clears its in-flight flag and never leaves rows as [] on failure.
  const client = read("app/dashboard-client.tsx");
  assert.match(client, /finally \{ stageLoadInFlight\.current = false; setCurrentStageLoading\(false\); \}/);
  assert.match(client, /setCurrentStageRecords\(null\); setStageReconciliation\(null\)/);
  // The timer refreshes LIVE data only; it does not keep retrying a failing Bitrix.
  assert.match(client, /if \(stageLiveRef\.current\?\.liveStatus === "LIVE"\) void loadCurrentStages\(\)/);
  // Without rows the live figures are not rendered at all — no fake zeros.
  assert.match(client, /\{hasData && <>/);
  assert.doesNotMatch(client, /Bitrix live · hozir|Vaqtincha oxirgi sync bazasi ko‘rsatilmoqda/);
});

test("the client reads the explicit contract and never infers a state from missing fields", () => {
  assert.equal(parseStageLiveMeta({ records: [] }), null, "no liveStatus → not live, not degraded: a protocol error");
  assert.equal(parseStageLiveMeta({ liveStatus: "LIVE", dataSource: "LAST_SUCCESSFUL_LIVE" }), null);
  assert.equal(parseStageLiveMeta({ liveStatus: "DEGRADED", dataSource: "LAST_SUCCESSFUL_LIVE" }), null, "degraded needs its timestamp");
  assert.equal(parseStageLiveMeta({ liveStatus: "DEGRADED", dataSource: "LAST_SUCCESSFUL_LIVE", lastSuccessfulAt: T0.toISOString(), staleAgeSeconds: 60 })?.staleAgeSeconds, 60);
  assert.equal(parseStageLiveMeta({ liveStatus: "UNAVAILABLE", dataSource: null, liveErrorCode: "BITRIX_TIMEOUT", retryable: true })?.retryable, true);
  const client = read("app/dashboard-client.tsx");
  assert.match(client, /const meta = parseStageLiveMeta\(payload\);/);
  // Every answer of the route carries the contract fields.
  const route = read("app/api/current-stages/route.ts");
  for (const field of ["liveStatus", "dataSource", "fetchedAt", "lastSuccessfulAt", "staleAgeSeconds", "liveErrorCode", "retryable", "rowCount"]) assert.match(route, new RegExp(`${field}:`));
});
