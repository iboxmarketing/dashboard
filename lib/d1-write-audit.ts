import { AsyncLocalStorage } from "node:async_hooks";
import {
  D1_WRITE_AUDIT_PHASES,
  type D1WriteAuditEntry,
  type D1WriteAuditPhase,
  type D1WriteAuditPoint,
  type D1WriteAuditSummary,
} from "./d1-write-audit-shared";

type D1WriteAuditMetadata = Readonly<{
  rows_written?: number;
  rows_read?: number;
  changes?: number;
}>;

type MutableEntry = {
  phase: D1WriteAuditPhase;
  table: D1WriteAuditEntry["table"];
  operation: D1WriteAuditEntry["operation"];
  statements: number;
  rowsWritten: number;
  rowsRead: number;
  changes: number;
};

type AuditStore = {
  phase: D1WriteAuditPhase;
  buckets: Map<string, MutableEntry>;
};

const auditStorage = new AsyncLocalStorage<AuditStore>();
const allowedPhases = new Set<D1WriteAuditPhase>(D1_WRITE_AUDIT_PHASES);

const point = <T extends D1WriteAuditPoint>(value: T) => Object.freeze(value);

/** Fixed labels only: callers cannot attach Deal data, bindings, SQL or URLs. */
export const D1_WRITE_AUDIT_POINTS = Object.freeze({
  SCHEMA_ENSURE: point({ table: "schema", operation: "ensure_schema" }),
  APP_SETTINGS_UPSERT: point({ table: "app_settings", operation: "upsert" }),
  CRM_DICTIONARY_UPSERT: point({ table: "crm_dictionaries", operation: "upsert" }),
  CRM_DICTIONARY_CHECKPOINT: point({ table: "crm_dictionaries", operation: "checkpoint_upsert" }),
  CRM_DICTIONARY_RECONCILIATION: point({ table: "crm_dictionaries", operation: "reconciliation_state_upsert" }),
  SYNC_JOB_UPSERT: point({ table: "sync_jobs", operation: "upsert" }),
  SYNC_STATE_UPSERT: point({ table: "sync_state", operation: "upsert" }),
  RAW_DEALS_UPSERT: point({ table: "raw_deals", operation: "insert_or_replace" }),
  RAW_ACTIVITIES_UPSERT: point({ table: "raw_activities", operation: "insert_or_replace" }),
  RAW_STAGE_HISTORY_GUARDED_UPSERT: point({ table: "raw_stage_history", operation: "guarded_upsert" }),
  RAW_STAGE_HISTORY_STALE_DELETE: point({ table: "raw_stage_history", operation: "stale_delete" }),
  RAW_CALL_STATS_UPSERT: point({ table: "raw_call_stats", operation: "insert_or_replace" }),
  ANALYTICS_UPSERT: point({ table: "analytics_records", operation: "insert_or_replace" }),
  ANALYTICS_RANGE_DELETE: point({ table: "analytics_records", operation: "delete_range" }),
  ANALYTICS_RECONCILIATION_UPDATE: point({ table: "analytics_records", operation: "update_payload" }),
  SALES_SNAPSHOT_UPSERT: point({ table: "deal_sales_snapshots", operation: "guarded_upsert" }),
  PROVIDER_RULE_UPSERT: point({ table: "provider_rules", operation: "upsert" }),
  PROVIDER_DIAGNOSTIC_UPSERT: point({ table: "provider_diagnostics", operation: "insert_or_replace" }),
  FULL_CLEAR_RAW_CALL_STATS: point({ table: "raw_call_stats", operation: "full_clear_delete" }),
  FULL_CLEAR_RAW_ACTIVITIES: point({ table: "raw_activities", operation: "full_clear_delete" }),
  FULL_CLEAR_RAW_STAGE_HISTORY: point({ table: "raw_stage_history", operation: "full_clear_delete" }),
  FULL_CLEAR_ANALYTICS: point({ table: "analytics_records", operation: "full_clear_delete" }),
  FULL_CLEAR_RAW_DEALS: point({ table: "raw_deals", operation: "full_clear_delete" }),
} as const);

export type D1WriteAuditPointValue = (typeof D1_WRITE_AUDIT_POINTS)[keyof typeof D1_WRITE_AUDIT_POINTS];
const allowedPoints = new Set<D1WriteAuditPointValue>(Object.values(D1_WRITE_AUDIT_POINTS));

export function isD1WriteAuditEnabled(value: unknown): value is "1" {
  return value === "1";
}

export function withD1WriteAudit<T>(value: unknown, callback: () => T): T {
  if (!isD1WriteAuditEnabled(value)) return callback();
  return auditStorage.run({ phase: "sync.request", buckets: new Map() }, callback);
}

export function withD1WriteAuditPhase<T>(phase: D1WriteAuditPhase, callback: () => T): T {
  const store = auditStorage.getStore();
  if (!store || !allowedPhases.has(phase)) return callback();
  return auditStorage.run({ phase, buckets: store.buckets }, callback);
}

export function isD1WriteAuditCollecting() {
  return auditStorage.getStore() !== undefined;
}

function metric(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function record(pointValue: D1WriteAuditPointValue, metadata: D1WriteAuditMetadata) {
  const store = auditStorage.getStore();
  if (!store || !allowedPoints.has(pointValue)) return;
  const key = `${store.phase}\u0000${pointValue.table}\u0000${pointValue.operation}`;
  const entry = store.buckets.get(key) ?? {
    phase: store.phase,
    table: pointValue.table,
    operation: pointValue.operation,
    statements: 0,
    rowsWritten: 0,
    rowsRead: 0,
    changes: 0,
  };
  entry.statements += 1;
  entry.rowsWritten += metric(metadata.rows_written);
  entry.rowsRead += metric(metadata.rows_read);
  entry.changes += metric(metadata.changes);
  store.buckets.set(key, entry);
}

export function recordD1RunMetadata(pointValue: D1WriteAuditPointValue, metadata: D1WriteAuditMetadata) {
  record(pointValue, metadata);
}

export function recordD1BatchMetadata(
  pointValue: D1WriteAuditPointValue,
  metadata: readonly D1WriteAuditMetadata[],
) {
  for (const entry of metadata) record(pointValue, entry);
}

export function getD1WriteAuditSummary(): D1WriteAuditSummary | undefined {
  const store = auditStorage.getStore();
  if (!store) return undefined;
  return { entries: [...store.buckets.values()].sort((a, b) =>
    a.phase.localeCompare(b.phase) || a.table.localeCompare(b.table) || a.operation.localeCompare(b.operation)) };
}

/** Leaves the response value untouched unless this request explicitly enabled auditing. */
export function addD1WriteAuditToResponse<T extends object>(value: T): T | (T & { d1WriteAudit: D1WriteAuditSummary }) {
  const summary = getD1WriteAuditSummary();
  return summary ? { ...value, d1WriteAudit: summary } : value;
}
