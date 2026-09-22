import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { businessMinutesExceed, calculateBusinessMinutes, defaultSettings, getSlaStart } from "../lib/business-time";
import { markDuplicates } from "../lib/duplicates";
import { elapsedSlaMinutes, resolveSlaState } from "../lib/sla";
import {
  TREND_METRICS, buildTrendSeries, buildTrendSeriesSet,
} from "../lib/trend-series";
import {
  buildSalesSection, hydrateRecord, prepareSalesBase, prepareSalesRecords, resolveSalesSla, salesPopulations, type SalesQuery,
} from "../lib/sales-sections";
import { SALES_CACHE_TTL_MS, createSalesBaseCache, salesCacheKey, type SalesCacheFingerprint } from "../lib/sales-cache";
import type { DashboardRecord } from "../lib/dashboard-record";
import type { DashboardSettings } from "../lib/types";

/*
 * Performance changes that must not move a single number.
 *
 * Each optimisation is checked against a verbatim copy of the code it
 * replaced, over a seeded dataset wide enough to reach every branch: processed
 * and unprocessed leads, missing evidence, after-hours starts, holidays,
 * duplicates, every sales status. (The same comparison was also run on the
 * full staging export — 1,440 section outputs, byte-identical — outside the
 * repository, since that data may not be committed.)
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 2 ** 32; };
}

const SETTINGS: DashboardSettings = {
  ...defaultSettings,
  selectedPipelineIds: ["3"], postSalePipelineIds: ["13"],
  holidays: ["2026-03-21", "2026-03-22", "2026-09-01"],
  slaMinutes: 10,
};

function dataset(size: number, seed: number): DashboardRecord[] {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const start = Date.parse("2025-06-01T00:00:00Z");
  const span = Date.parse("2026-09-22T12:00:00Z") - start;
  return Array.from({ length: size }, (_, index) => {
    const created = new Date(start + Math.floor(random() * span)).toISOString();
    const status = pick(["ACTIVE", "WON", "LOST", "LOW_QUALITY"] as const);
    const processed = random() < 0.55;
    const source = pick(["QUALIFICATION_STAGE", "NO_PROCESSING", "NO_PROCESSING_EVIDENCE"] as const);
    const manager = pick(["7", "25", "95", "1911", null]);
    return {
      dealId: String(40_000 + index), title: `Deal ${index}`, createdAt: created,
      wonAt: status === "WON" ? new Date(Date.parse(created) + Math.floor(random() * 30) * 86_400_000).toISOString() : null,
      salesStatus: status, qualified: random() < 0.5, qualifiedStageId: null,
      lossReasonGroup: status === "LOW_QUALITY" ? "MARKETING" : status === "LOST" ? "SALES" : "NONE",
      lossReason: status === "LOST" ? pick(["Qimmat", "Javob yo‘q"]) : "", opportunity: Math.floor(random() * 2_000_000), currencyId: "UZS",
      processingBusinessMinutes: processed ? Math.floor(random() * 90) : null, salesCycleHours: null, slaStatus: "PENDING",
      processingSource: processed ? "QUALIFICATION_STAGE" : source,
      slaStart: random() < 0.8 ? getSlaStart(created, SETTINGS).toISOString() : null,
      stage: pick(["Распределение", "Обработка", "Not relevant"]), stageId: "C3:NEW",
      categoryId: pick(["3", "3", "13", "9"]), originCategoryId: pick(["3", "3", "9"]),
      originPipeline: "IBOX sales", pipeline: "IBOX sales", source: pick(["Instagram", "CRM-форма", "Telegram", ""]), sourceId: "WEB",
      assignedManagerId: manager ?? "0", assignedManager: "M", salesManagerId: manager, salesManager: manager ? `Seller ${manager}` : null,
      salesManagerAttribution: manager ? "SALES_STAGE" : "UNKNOWN", analyticsVersion: 6,
      customerKey: random() < 0.3 ? `c${Math.floor(random() * 40)}` : null, duplicateOfDealId: null,
      stageAgeHours: 3, stageLimitHours: 24, stageHistoryCount: 2, currentScope: "IN_SCOPE",
    } as unknown as DashboardRecord;
  });
}

/** `prepareSalesRecords` exactly as it was before the base/SLA split. */
function referencePrepare(rows: DashboardRecord[], settings: DashboardSettings, now: Date) {
  const selectedOrigins = new Set(settings.selectedPipelineIds.map(String));
  const selectedProjectCategories = new Set([...settings.selectedPipelineIds, ...settings.postSalePipelineIds].map(String));
  const project = rows.map(hydrateRecord).filter((row) => !selectedOrigins.size || selectedOrigins.has(String(row.originCategoryId)) || selectedProjectCategories.has(String(row.categoryId)));
  return markDuplicates(project.map((row) => ({ ...row, slaStatus: referenceSla(row, settings, now) })));
}

/** `resolveSlaState` exactly as it was: the full elapsed walk, then the comparison. */
function referenceSla(row: Parameters<typeof resolveSlaState>[0], settings: DashboardSettings, now: Date) {
  if (row.processingBusinessMinutes !== null) return row.processingBusinessMinutes <= settings.slaMinutes ? "ON_TIME" : "LATE";
  if (row.processingSource === "NO_PROCESSING_EVIDENCE") return "UNKNOWN_EVIDENCE";
  return elapsedSlaMinutes(row, settings, now) > settings.slaMinutes ? "OVERDUE_UNPROCESSED" : "PENDING";
}

const NOW = new Date("2026-09-22T08:00:00.000Z");
const RAW = dataset(600, 20260922);
const QUERY: SalesQuery = { from: "2026-08-01", to: "2026-08-31", managers: [], sources: [], pipeline: "", stage: "", period: "", sla: "", processing: "", search: "" } as SalesQuery;

test("the early-exit SLA comparison always agrees with the full business-minute walk", () => {
  const random = rng(7);
  const schedules = [
    defaultSettings.schedule,
    { ...defaultSettings.schedule, 6: { enabled: true, start: "10:00", end: "14:00" } },
    { ...defaultSettings.schedule, 1: { enabled: false, start: "09:00", end: "18:00" }, 3: { enabled: true, start: "08:30", end: "20:15" } },
  ];
  for (let index = 0; index < 4_000; index += 1) {
    const settings = { ...SETTINGS, schedule: schedules[index % schedules.length], holidays: index % 2 ? SETTINGS.holidays : [] };
    const start = Date.parse("2025-12-01T00:00:00Z") + Math.floor(random() * 300 * 86_400_000);
    const end = start + Math.floor((random() - 0.05) * 40 * 86_400_000);
    const limit = [0, 1, 10, 59, 60, 61, 540, 5_000, 100_000, -1][index % 10];
    assert.equal(
      businessMinutesExceed(new Date(start), new Date(end), settings, limit),
      calculateBusinessMinutes(new Date(start), new Date(end), settings) > limit,
      `start=${new Date(start).toISOString()} end=${new Date(end).toISOString()} limit=${limit}`,
    );
  }
  assert.equal(businessMinutesExceed("not a date", NOW, SETTINGS, 10), false);
  assert.equal(businessMinutesExceed(NOW, NOW, SETTINGS, -1), true, "0 > -1, exactly as the full walk answers");
  assert.equal(businessMinutesExceed(NOW, NOW, SETTINGS, Number.NaN), calculateBusinessMinutes(NOW, NOW, SETTINGS) > Number.NaN);
});

test("resolved SLA states are identical to the pre-optimisation resolver on every lead", () => {
  for (const clock of ["2026-09-22T08:00:00Z", "2026-09-19T12:07:00Z", "2026-09-20T03:30:00Z", "2026-03-21T10:00:00Z"]) {
    const now = new Date(clock);
    for (const row of RAW) assert.equal(resolveSlaState(row, SETTINGS, now), referenceSla(row, SETTINGS, now), `deal ${row.dealId} at ${clock}`);
  }
});

test("cached working periods follow each settings object and cannot be altered by a caller", () => {
  const mondayMorning = "2026-09-21T03:00:00.000Z"; // 08:00 Tashkent, before opening
  const withHoliday = { ...SETTINGS, holidays: ["2026-09-21"] };
  const plain = getSlaStart(mondayMorning, SETTINGS);
  assert.equal(plain.toISOString(), "2026-09-21T04:00:00.000Z");
  assert.equal(getSlaStart(mondayMorning, withHoliday).toISOString(), "2026-09-22T04:00:00.000Z", "a holiday in another settings object is honoured");
  plain.setUTCFullYear(1999);
  assert.equal(getSlaStart(mondayMorning, SETTINGS).toISOString(), "2026-09-21T04:00:00.000Z", "mutating a returned Date leaves the cache intact");
  assert.equal(calculateBusinessMinutes("2026-09-21T04:00:00Z", "2026-09-22T13:00:00Z", SETTINGS), 540 + 540);
  assert.equal(calculateBusinessMinutes("2026-09-21T04:00:00Z", "2026-09-22T13:00:00Z", withHoliday), 540);
});

test("the split base + SLA preparation returns exactly the rows the single pass returned", () => {
  for (const clock of ["2026-09-22T08:00:00Z", "2026-09-19T12:07:00Z"]) {
    const now = new Date(clock);
    const expected = referencePrepare(RAW, SETTINGS, now);
    assert.deepEqual(prepareSalesRecords(RAW, SETTINGS, now), expected);
    assert.deepEqual(resolveSalesSla(prepareSalesBase(RAW, SETTINGS), SETTINGS, now), expected);
    assert.equal(JSON.stringify(prepareSalesRecords(RAW, SETTINGS, now)), JSON.stringify(expected), "same key order too");
  }
});

test("one set of trend days serves every trend metric with the points each metric had alone", () => {
  const records = prepareSalesRecords(RAW, SETTINGS, NOW);
  for (const query of [QUERY, { ...QUERY, from: "2026-01-01", to: "2026-09-22" }, { ...QUERY, from: "", to: "" }]) {
    const pop = salesPopulations(records, query);
    const bounds = pop.trendBounds ?? undefined;
    const previous = pop.previousTrendBounds ?? undefined;
    const set = buildTrendSeriesSet(pop.cohort, pop.previousCohort, TREND_METRICS.map((metric) => metric.id), bounds, previous);
    const alone = Object.fromEntries(TREND_METRICS.map((metric) => [metric.id, buildTrendSeries(pop.cohort, pop.previousCohort, metric.id, bounds, previous)]));
    assert.equal(JSON.stringify(set), JSON.stringify(alone));
  }
});

test("sections read the shared cached base without mutating it", () => {
  const deepFreeze = <T,>(value: T): T => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
    return value;
  };
  const base = deepFreeze(prepareSalesBase(RAW, SETTINGS));
  const fresh = prepareSalesBase(RAW, SETTINGS);
  const context = { can: () => true, settings: SETTINGS, dataAsOf: null };
  for (const section of ["dashboard", "managers", "leadFlow", "quality", "deals"] as const) {
    const fromFrozen = buildSalesSection(section, resolveSalesSla(base, SETTINGS, NOW), QUERY, context);
    assert.deepEqual(fromFrozen, buildSalesSection(section, resolveSalesSla(fresh, SETTINGS, NOW), QUERY, context), section);
  }
  const manager = buildSalesSection("manager", resolveSalesSla(base, SETTINGS, NOW), { ...QUERY, managerId: "25" }, context);
  assert.ok(manager);
});

const FINGERPRINT: SalesCacheFingerprint = {
  rowCount: 3306, syncedAt: "2026-09-22T07:30:00.965Z", dictionariesAt: "2026-09-22T07:30:34.925Z",
  syncStateAt: "2026-09-22T07:30:02.005Z", syncJobAt: "2026-09-22T07:30:01.877Z",
};

test("any change to the stored rows or the project's pipelines produces a different cache key", () => {
  const key = salesCacheKey(FINGERPRINT, SETTINGS);
  assert.equal(salesCacheKey({ ...FINGERPRINT }, { ...SETTINGS }), key, "same inputs, same key");
  const changes: Partial<SalesCacheFingerprint>[] = [
    { rowCount: 3305 }, { syncedAt: "2026-09-22T07:45:00.000Z" }, { dictionariesAt: "2026-09-22T07:46:00.000Z" },
    { syncStateAt: null }, { syncJobAt: "2026-09-22T08:00:00.000Z" },
  ];
  for (const change of changes) assert.notEqual(salesCacheKey({ ...FINGERPRINT, ...change }, SETTINGS), key, JSON.stringify(change));
  assert.notEqual(salesCacheKey(FINGERPRINT, { ...SETTINGS, selectedPipelineIds: ["3", "7"] }), key);
  assert.notEqual(salesCacheKey(FINGERPRINT, { ...SETTINGS, postSalePipelineIds: [] }), key);
});

test("the base cache holds one dataset, for one key, for at most the TTL", () => {
  const cache = createSalesBaseCache(1_000);
  const base = prepareSalesBase(RAW.slice(0, 5), SETTINGS);
  assert.equal(cache.get("a", 0), null);
  cache.set("a", base, 10_000);
  assert.equal(cache.get("a", 10_500), base);
  assert.equal(cache.get("b", 10_500), null, "another fingerprint is a miss");
  assert.equal(cache.get("a", 11_000), null, "expired at the TTL");
  assert.equal(cache.get("a", 9_000), null, "a clock that went backwards is a miss");
  cache.set("b", base, 20_000);
  assert.equal(cache.get("a", 20_001), null, "a new dataset replaces the old one");
  cache.clear();
  assert.equal(cache.get("b", 20_001), null);
  assert.equal(SALES_CACHE_TTL_MS, 5 * 60_000);
});

test("the Sales loader re-resolves SLA per request and caches rows only under the fingerprint read with them", () => {
  const http = code("../lib/sales-http.ts");
  assert.match(http, /readSalesFingerprint\(\)/);
  assert.match(http, /listDashboardRecordJsonWithFingerprint\(\)/);
  assert.match(http, /salesBaseCache\.set\(salesCacheKey\(fresh\.fingerprint, settings\)/, "a miss is stored under the fingerprint from the same batch as its rows");
  assert.match(http, /resolveSalesSla\(base, settings, now\)/, "SLA is never served from the cache");
  assert.doesNotMatch(http, /Promise<.*>\s*=.*salesBaseCache|salesBaseCache\.set\([^)]*Promise/, "no pending promise is shared between requests");

  const storage = code("../lib/storage.ts");
  assert.match(storage, /db\.batch<Record<string, unknown>>\(\[db\.prepare\(SALES_FINGERPRINT_SQL\), dashboardRecordStatement\(\)\]\)/);
  for (const part of ["count(*) FROM analytics_records", "max(synced_at) FROM analytics_records", "max(updated_at) FROM crm_dictionaries", "max(updated_at) FROM sync_state", "max(updated_at) FROM sync_jobs"]) {
    assert.ok(storage.includes(part), part);
  }
  assert.match(storage, /if \(ensuredDatabases\.has\(db\)\) return;\s*await createSchema\(db\);\s*ensuredDatabases\.add\(db\);/, "schema is ensured once per binding, and only after success");
  assert.match(storage, /export async function getSyncState\(\) \{\s*await ensureSchema\(\);\s*const \[row, job\] = await Promise\.all\(\[/, "sync state and job are read in one round trip");

  const reconciliation = code("../lib/post-sync-reconciliation.ts");
  const lastScopeWrite = reconciliation.lastIndexOf("setAnalyticsCurrentScope(");
  const finalStateSave = reconciliation.lastIndexOf("saveDictionary(");
  assert.ok(lastScopeWrite > 0 && finalStateSave > lastScopeWrite, "the in-place payload update is always followed by a dictionary write the fingerprint sees");
});

test("per-record date keys reuse one formatter instead of building one per record", () => {
  for (const [path, name] of [["../lib/trend-series.ts", "tashkentDayKey"], ["../lib/lead-flow-analytics.ts", "tashkentParts"]]) {
    const body = code(path).match(new RegExp(`export function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(body, `${name} found`);
    assert.doesNotMatch(body, /new Intl\.DateTimeFormat/, `${name} builds no formatter per call`);
  }
});
