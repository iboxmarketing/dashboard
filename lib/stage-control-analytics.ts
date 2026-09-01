import type { StageFunnelRecord } from "./dashboard-record";
import { isPreSqlClosed, isSalesLost } from "./sales-logic";
import { stageIdList, type StageSemantics } from "./stage-config";
import type { CurrentStageRecord, PipelineStageOption, StageReconciliation } from "./types";

/**
 * Stage Control operations analytics.
 *
 * Two populations meet on this page and they are deliberately NOT the same:
 *
 *  - LIVE: the Bitrix `CLOSED=N` snapshot. It has no created-date bound, so a
 *    deal opened 400 days ago still belongs here.
 *  - HISTORICAL: the analytics stage timeline, bounded by the configured import
 *    window.
 *
 * Nothing here re-derives sales semantics. Outcome classification reuses the
 * canonical predicates and terminal stages are read from configured stage ids,
 * never from display text.
 */

/** Stage identity is `categoryId:stageId` — never the editable display name. */
export function stageKey(categoryId: string, stageId: string) {
  return `${categoryId}:${stageId}`;
}

export type StageCatalogEntry = {
  key: string;
  categoryId: string;
  stageId: string;
  name: string;
  pipeline: string;
  sort: number;
  semantics: string;
  /** True when the stage is absent from the live Bitrix catalog (renamed/deleted). */
  legacy: boolean;
};

/**
 * Human duration. `10254 soat` is technically correct and operationally
 * useless, so anything past a day reads in days (plus hours while the number of
 * days is still small enough for the remainder to matter).
 */
export function humanDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "—";
  const total = Math.max(0, hours);
  if (total < 1) return `${Math.round(total * 60)} daqiqa`;
  if (total < 24) return `${Math.round(total)} soat`;
  const days = Math.floor(total / 24);
  const rest = Math.round(total - days * 24);
  if (days >= 30) return `${days} kun`;
  return rest ? `${days} kun ${rest} soat` : `${days} kun`;
}

export function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A rate whose denominator is zero is unknown, never 0. */
export function rate(value: number, total: number): number | null {
  return total ? Math.round((value / total) * 100) : null;
}

/**
 * Ordered stage catalog.
 *
 * Bitrix `SORT` is the source of truth. Stages that appear only in live or
 * historical data — renamed, deleted, or from an unconfigured funnel — stay
 * visible after the known ones as `legacy` rather than being dropped or merged
 * into a same-named stage from another pipeline.
 */
export function buildStageCatalog(input: {
  catalog?: PipelineStageOption[];
  live?: CurrentStageRecord[];
  historical?: StageFunnelRecord[];
  pipelineNames?: Map<string, string>;
}): StageCatalogEntry[] {
  const known = new Map<string, StageCatalogEntry>();
  for (const stage of input.catalog ?? []) {
    const key = stageKey(stage.categoryId, stage.id);
    known.set(key, {
      key,
      categoryId: stage.categoryId,
      stageId: stage.id,
      name: stage.name || stage.id,
      pipeline: input.pipelineNames?.get(stage.categoryId) ?? `Pipeline #${stage.categoryId}`,
      sort: stage.sort,
      semantics: stage.semantics ?? "",
      legacy: false,
    });
  }

  const extras = new Map<string, StageCatalogEntry>();
  const remember = (categoryId: string, stageId: string, name: string, pipeline: string) => {
    const key = stageKey(categoryId, stageId);
    if (known.has(key) || extras.has(key) || !stageId) return;
    extras.set(key, { key, categoryId, stageId, name: name || stageId, pipeline, sort: Number.MAX_SAFE_INTEGER, semantics: "", legacy: true });
  };
  for (const row of input.live ?? []) remember(row.categoryId, row.stageId, row.stage, row.pipeline);
  for (const row of input.historical ?? []) {
    for (const entry of row.stageTimeline ?? []) remember(entry.categoryId, entry.stageId, entry.stage, entry.pipeline);
  }

  const byOrder = (a: StageCatalogEntry, b: StageCatalogEntry) =>
    a.categoryId.localeCompare(b.categoryId) || a.sort - b.sort || a.name.localeCompare(b.name);
  // Legacy stages carry no SORT, so they fall back to the known business
  // sequence before finally degrading to name order.
  const byFallback = (a: StageCatalogEntry, b: StageCatalogEntry) =>
    a.categoryId.localeCompare(b.categoryId) || fallbackRank(a.name) - fallbackRank(b.name) || a.name.localeCompare(b.name);
  return [...[...known.values()].sort(byOrder), ...[...extras.values()].sort(byFallback)];
}

/**
 * Last-resort ordering for stages with no Bitrix SORT metadata.
 *
 * This is a FALLBACK, never the primary algorithm: it is consulted only after
 * the live catalog has been exhausted, so a renamed stage still orders by its
 * real SORT. Matching is on the normalised display name because a legacy stage
 * is, by definition, one whose id is no longer in the catalog.
 */
export const FALLBACK_STAGE_ORDER = [
  "распределённые сделки", "нет ответа", "первое касание", "обработка",
  "встреча назначена", "встреча проведена", "согласие",
  "получение данных/оплата", "оплата получена",
];

function fallbackRank(name: string) {
  const index = FALLBACK_STAGE_ORDER.indexOf(name.trim().toLowerCase());
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Stage ids configured as a terminal outcome — not a progression step. */
export function terminalStageIds(config: StageSemantics) {
  return new Set([...stageIdList(config.lowQualityStageIds), ...stageIdList(config.closedLostStageIds)]);
}

// ---------------------------------------------------------------- live summary

export type StageControlSummary = {
  active: number;
  overdue: number;
  overdueRate: number | null;
  busiest: { key: string; name: string; active: number; share: number | null; overdue: number; overdueRate: number | null } | null;
  oldest: (CurrentStageRecord & { overrunHours: number }) | null;
};

export function buildSummary(records: CurrentStageRecord[], catalog: StageCatalogEntry[]): StageControlSummary {
  const overdue = records.filter((row) => row.stageOverdue);
  const health = buildStageHealth(records, catalog).filter((row) => row.active > 0);
  const busiest = [...health].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name))[0] ?? null;
  const oldest = [...records].sort((a, b) => b.stageAgeHours - a.stageAgeHours)[0] ?? null;
  return {
    active: records.length,
    overdue: overdue.length,
    overdueRate: rate(overdue.length, records.length),
    busiest: busiest
      ? { key: busiest.key, name: busiest.name, active: busiest.active, share: busiest.share, overdue: busiest.overdue, overdueRate: busiest.overdueRate }
      : null,
    oldest: oldest ? { ...oldest, overrunHours: overrunHours(oldest) } : null,
  };
}

// -------------------------------------------------------------- reconciliation

export type ReconciliationView = {
  liveCount: number;
  matchedCount: number;
  coverage: number | null;
  cachedCount: number;
  missingCount: number;
  expectedGap: number;
  unexpectedGap: number;
  expectedGapDealIds: string[];
  unexpectedGapDealIds: string[];
  staleCount: number;
  staleDealIds: string[];
  stageMismatchCount: number;
  stageMismatchDealIds: string[];
  historyDays: number | null;
  truncated: boolean;
  severity: "ok" | "warning";
  reasons: string[];
};

/**
 * Presentation model for the trust banner.
 *
 * Coverage is measured against the LIVE deal ids, never against the analytics
 * cache total: the two are different populations and comparing 265 to 1473
 * invites a conclusion that does not exist. Old open deals outside the import
 * window are informational; a gap *inside* the window, a stale record, a stage
 * mismatch, or a truncated live snapshot are warnings.
 */
export function buildReconciliationView(
  reconciliation: StageReconciliation | null,
  options: { truncated?: boolean } = {},
): ReconciliationView | null {
  if (!reconciliation) return null;
  const truncated = Boolean(options.truncated);
  const reasons: string[] = [];
  if (truncated) reasons.push("Bitrix live snapshot to‘liq yuklanmadi");
  if (reconciliation.missingWithinHistoryCount > 0) {
    reasons.push(`${reconciliation.missingWithinHistoryCount} ta joriy deal history oynasi ichida, lekin analytics cache’da yo‘q`);
  }
  if (reconciliation.staleCount > 0) reasons.push(`${reconciliation.staleCount} ta cache yozuvi Bitrix joriy holatida yo‘q`);
  if (reconciliation.stageMismatchCount > 0) reasons.push(`${reconciliation.stageMismatchCount} ta deal stage’i cache bilan mos emas`);
  return {
    liveCount: reconciliation.liveCount,
    matchedCount: reconciliation.matchedCount,
    coverage: rate(reconciliation.matchedCount, reconciliation.liveCount),
    cachedCount: reconciliation.cachedCount,
    missingCount: reconciliation.missingCount,
    expectedGap: reconciliation.missingOlderThanHistoryCount,
    unexpectedGap: reconciliation.missingWithinHistoryCount,
    expectedGapDealIds: reconciliation.missingOlderThanHistoryDealIds,
    unexpectedGapDealIds: reconciliation.missingWithinHistoryDealIds,
    staleCount: reconciliation.staleCount,
    staleDealIds: reconciliation.staleDealIds,
    stageMismatchCount: reconciliation.stageMismatchCount,
    stageMismatchDealIds: reconciliation.stageMismatchDealIds,
    historyDays: reconciliation.historyDays,
    truncated,
    severity: reasons.length ? "warning" : "ok",
    reasons,
  };
}

// ---------------------------------------------------------------- matrix

export type MatrixCell = { key: string; active: number; overdue: number; overdueRate: number | null };
export type MatrixRow = {
  managerId: string;
  manager: string;
  isUnknown: boolean;
  cells: MatrixCell[];
  total: number;
  overdue: number;
  overdueRate: number | null;
};

const managerNameOf = (row: CurrentStageRecord) => row.assignedManager?.trim() || "Aniqlanmagan";
const managerIdOf = (row: CurrentStageRecord) => row.assignedManagerId?.trim() || "unknown";

/**
 * Manager × stage matrix in one grouped pass — no per-cell re-filtering of the
 * whole snapshot.
 *
 * Default order surfaces the biggest operational backlog first: overdue count,
 * then active count, then name. `Aniqlanmagan` stays visible but sits after
 * real sellers, because it is attribution diagnostics rather than a ranking.
 */
export function buildManagerMatrix(records: CurrentStageRecord[], catalog: StageCatalogEntry[]): MatrixRow[] {
  const order = catalog.map((stage) => stage.key);
  const rows = new Map<string, { manager: string; total: number; overdue: number; cells: Map<string, MatrixCell> }>();
  for (const record of records) {
    const id = managerIdOf(record);
    const row = rows.get(id) ?? { manager: managerNameOf(record), total: 0, overdue: 0, cells: new Map() };
    const key = stageKey(record.categoryId, record.stageId);
    const cell = row.cells.get(key) ?? { key, active: 0, overdue: 0, overdueRate: null };
    cell.active += 1;
    row.total += 1;
    if (record.stageOverdue) { cell.overdue += 1; row.overdue += 1; }
    row.cells.set(key, cell);
    rows.set(id, row);
  }
  return [...rows.entries()]
    .map(([managerId, row]) => ({
      managerId,
      manager: row.manager,
      isUnknown: managerId === "unknown",
      cells: order.map((key) => {
        const cell = row.cells.get(key);
        return cell ? { ...cell, overdueRate: rate(cell.overdue, cell.active) } : { key, active: 0, overdue: 0, overdueRate: null };
      }),
      total: row.total,
      overdue: row.overdue,
      overdueRate: rate(row.overdue, row.total),
    }))
    .sort((a, b) =>
      Number(a.isUnknown) - Number(b.isUnknown)
      || b.overdue - a.overdue
      || b.total - a.total
      || a.manager.localeCompare(b.manager));
}

// ---------------------------------------------------------------- stage health

export type StageHealthRow = {
  key: string;
  name: string;
  pipeline: string;
  legacy: boolean;
  active: number;
  share: number | null;
  overdue: number;
  overdueRate: number | null;
  medianAgeHours: number | null;
  maxAgeHours: number | null;
  limits: number[];
  limitHours: number | null;
  limitConflict: boolean;
};

/**
 * Stage health in funnel order, not volume order, so the pipeline stays
 * readable top-to-bottom. A stage carrying more than one configured limit is
 * reported as a conflict rather than silently resolved to one of them.
 */
export function buildStageHealth(records: CurrentStageRecord[], catalog: StageCatalogEntry[]): StageHealthRow[] {
  const grouped = new Map<string, CurrentStageRecord[]>();
  for (const record of records) {
    const key = stageKey(record.categoryId, record.stageId);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return catalog.map((stage) => {
    const rows = grouped.get(stage.key) ?? [];
    const overdue = rows.filter((row) => row.stageOverdue).length;
    const ages = rows.map((row) => row.stageAgeHours);
    const limits = [...new Set(rows.map((row) => row.stageLimitHours).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    return {
      key: stage.key,
      name: stage.name,
      pipeline: stage.pipeline,
      legacy: stage.legacy,
      active: rows.length,
      share: rate(rows.length, records.length),
      overdue,
      overdueRate: rate(overdue, rows.length),
      medianAgeHours: medianOf(ages),
      maxAgeHours: ages.length ? Math.max(...ages) : null,
      limits,
      limitHours: limits.length === 1 ? limits[0] : null,
      limitConflict: limits.length > 1,
    };
  });
}

// ---------------------------------------------------------------- overdue list

export function overrunHours(row: CurrentStageRecord) {
  return Math.max(0, row.stageAgeHours - row.stageLimitHours);
}

/** Age relative to the limit. A missing or non-positive limit has no ratio. */
export function limitRatio(row: CurrentStageRecord): number | null {
  const limit = Number(row.stageLimitHours);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return row.stageAgeHours / limit;
}

export type OverdueRow = CurrentStageRecord & { overrunHours: number; ratio: number | null };
export type OverdueSort = "overrun" | "age" | "ratio";
export type OverdueFilters = { manager?: string; stage?: string; search?: string };

/**
 * Every overdue deal, filtered and sorted. Rendering may page over the result,
 * but the caller always receives the full population so a 20-row page can never
 * read as the whole backlog.
 */
export function buildOverdueRows(
  records: CurrentStageRecord[],
  filters: OverdueFilters = {},
  sort: OverdueSort = "overrun",
): OverdueRow[] {
  const search = (filters.search ?? "").trim().toLowerCase();
  const rows = records
    .filter((row) => row.stageOverdue)
    .filter((row) => !filters.manager || managerIdOf(row) === filters.manager)
    .filter((row) => !filters.stage || stageKey(row.categoryId, row.stageId) === filters.stage)
    .filter((row) => !search || `${row.dealId} ${row.title} ${row.assignedManager}`.toLowerCase().includes(search))
    .map((row) => ({ ...row, overrunHours: overrunHours(row), ratio: limitRatio(row) }));
  const by = {
    overrun: (a: OverdueRow, b: OverdueRow) => b.overrunHours - a.overrunHours,
    age: (a: OverdueRow, b: OverdueRow) => b.stageAgeHours - a.stageAgeHours,
    ratio: (a: OverdueRow, b: OverdueRow) => (b.ratio ?? -1) - (a.ratio ?? -1),
  }[sort];
  return rows.sort((a, b) => by(a, b) || a.dealId.localeCompare(b.dealId));
}

// ---------------------------------------------------------------- historical

export type ProgressionRow = {
  key: string;
  stage: string;
  pipeline: string;
  legacy: boolean;
  entered: number;
  advanced: number;
  conversion: number | null;
  dropOff: number;
  avgHours: number | null;
  medianHours: number | null;
};

export type OutcomeRow = { key: string; label: string; count: number; share: number | null };

export type HistoricalView = { progression: ProgressionRow[]; outcomes: OutcomeRow[]; total: number };

/**
 * Historical progression and outcomes, kept strictly apart.
 *
 * A terminal stage (configured Not Relevant / Sotilmadi) is an outcome, so it
 * never becomes a progression row and can never display a conversion rate.
 * `advanced` therefore means the deal reached a LATER PROGRESSION stage, or
 * ended as a canonical WON — dropping into a terminal stage is drop-off, not
 * successful progression.
 *
 * Outcomes are classified from `qualified` / `lossReasonGroup` / `salesStatus`
 * through the canonical predicates, never from stage or reason text.
 */
export function buildHistorical(
  records: StageFunnelRecord[],
  catalog: StageCatalogEntry[],
  config: StageSemantics = {},
): HistoricalView {
  const terminal = terminalStageIds(config);
  const meta = new Map(catalog.map((stage) => [stage.key, stage]));
  const rank = new Map(catalog.map((stage, index) => [stage.key, index]));
  const stats = new Map<string, { entered: number; advanced: number; dropOff: number; durations: number[] }>();

  for (const record of records) {
    const timeline = (record.stageTimeline ?? []).filter((entry) => entry.categoryId === record.originCategoryId);
    // Progression positions only; terminal stages are outcomes and are skipped.
    const steps = timeline.map((entry, index) => ({ entry, index, terminal: terminal.has(entry.stageId) }));
    const progression = steps.filter((step) => !step.terminal);
    for (let i = 0; i < progression.length; i++) {
      const step = progression[i];
      const key = stageKey(step.entry.categoryId, step.entry.stageId);
      const current = stats.get(key) ?? { entered: 0, advanced: 0, dropOff: 0, durations: [] };
      current.entered += 1;
      current.durations.push(step.entry.durationHours);
      const nextProgression = progression[i + 1];
      const advanced = Boolean(nextProgression) || record.salesStatus === "WON";
      if (advanced) current.advanced += 1; else current.dropOff += 1;
      stats.set(key, current);
    }
  }

  const progression = [...stats.entries()]
    .map(([key, value]) => {
      const stage = meta.get(key);
      return {
        key,
        stage: stage?.name ?? key,
        pipeline: stage?.pipeline ?? "",
        legacy: stage?.legacy ?? true,
        entered: value.entered,
        advanced: value.advanced,
        conversion: rate(value.advanced, value.entered),
        dropOff: value.dropOff,
        avgHours: value.durations.length ? value.durations.reduce((sum, hours) => sum + hours, 0) / value.durations.length : null,
        medianHours: medianOf(value.durations),
      };
    })
    .sort((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER) || a.stage.localeCompare(b.stage));

  const counts = {
    won: records.filter((row) => row.salesStatus === "WON").length,
    notRelevant: records.filter((row) => row.lossReasonGroup === "MARKETING").length,
    salesLost: records.filter((row) => isSalesLost(row)).length,
    routing: records.filter((row) => row.lossReasonGroup === "ROUTING").length,
    preSql: records.filter((row) => isPreSqlClosed(row)).length,
  };
  const outcomes: OutcomeRow[] = [
    { key: "won", label: "Sotuv", count: counts.won, share: rate(counts.won, records.length) },
    { key: "not_relevant", label: "Not Relevant", count: counts.notRelevant, share: rate(counts.notRelevant, records.length) },
    { key: "sales_lost", label: "Sotilmadi", count: counts.salesLost, share: rate(counts.salesLost, records.length) },
    { key: "pre_sql", label: "SQLgacha yopilgan", count: counts.preSql, share: rate(counts.preSql, records.length) },
    { key: "routing", label: "Routing", count: counts.routing, share: rate(counts.routing, records.length) },
  ];
  return { progression, outcomes, total: records.length };
}
