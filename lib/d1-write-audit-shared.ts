/** Aggregate-only D1 write metrics safe to return to the authenticated client. */
export const D1_WRITE_AUDIT_PHASES = [
  "sync.request",
  "sync.start",
  "sync.step",
  "sync.deals",
  "sync.stageHistory",
  "sync.lookups",
  "sync.analytics",
  "sync.finalization",
  "sync.reconciliation",
  "sync.pause",
  "sync.resume",
] as const;

export const D1_WRITE_AUDIT_TABLES = [
  "schema",
  "app_settings",
  "crm_dictionaries",
  "sync_jobs",
  "sync_state",
  "raw_deals",
  "raw_activities",
  "raw_stage_history",
  "raw_call_stats",
  "analytics_records",
  "deal_sales_snapshots",
  "provider_rules",
  "provider_diagnostics",
] as const;

export const D1_WRITE_AUDIT_OPERATIONS = [
  "ensure_schema",
  "upsert",
  "insert_or_replace",
  "delete",
  "stale_delete",
  "delete_range",
  "full_clear_delete",
  "guarded_upsert",
  "update_payload",
  "checkpoint_upsert",
  "reconciliation_state_upsert",
] as const;

export type D1WriteAuditPhase = (typeof D1_WRITE_AUDIT_PHASES)[number];
export type D1WriteAuditTable = (typeof D1_WRITE_AUDIT_TABLES)[number];
export type D1WriteAuditOperation = (typeof D1_WRITE_AUDIT_OPERATIONS)[number];

export type D1WriteAuditPoint = Readonly<{
  table: D1WriteAuditTable;
  operation: D1WriteAuditOperation;
}>;

export type D1WriteAuditEntry = Readonly<{
  phase: D1WriteAuditPhase;
  table: D1WriteAuditTable;
  operation: D1WriteAuditOperation;
  statements: number;
  rowsWritten: number;
  rowsRead: number;
  changes: number;
}>;

export type D1WriteAuditSummary = Readonly<{
  entries: readonly D1WriteAuditEntry[];
}>;

const phases = new Set<string>(D1_WRITE_AUDIT_PHASES);
const tables = new Set<string>(D1_WRITE_AUDIT_TABLES);
const operations = new Set<string>(D1_WRITE_AUDIT_OPERATIONS);

function isMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isEntry(value: unknown): value is D1WriteAuditEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.phase === "string" && phases.has(entry.phase)
    && typeof entry.table === "string" && tables.has(entry.table)
    && typeof entry.operation === "string" && operations.has(entry.operation)
    && isMetric(entry.statements) && Number.isInteger(entry.statements)
    && isMetric(entry.rowsWritten)
    && isMetric(entry.rowsRead)
    && isMetric(entry.changes);
}

function entriesFrom(value: unknown): readonly D1WriteAuditEntry[] | null {
  if (!value || typeof value !== "object") return null;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || !entries.every(isEntry)) return null;
  return entries;
}

/**
 * Merges per-request server summaries in the browser. Unknown labels and any
 * non-numeric shape are rejected, so the eventual console summary can contain
 * only the fixed structural categories above.
 */
export function mergeD1WriteAuditSummaries(
  current: D1WriteAuditSummary | null,
  incoming: unknown,
): D1WriteAuditSummary | null {
  const additions = entriesFrom(incoming);
  if (!additions) return current;
  const buckets = new Map<string, D1WriteAuditEntry>();
  for (const entry of [...(current?.entries ?? []), ...additions]) {
    const key = `${entry.phase}\u0000${entry.table}\u0000${entry.operation}`;
    const previous = buckets.get(key);
    buckets.set(key, {
      phase: entry.phase,
      table: entry.table,
      operation: entry.operation,
      statements: (previous?.statements ?? 0) + entry.statements,
      rowsWritten: (previous?.rowsWritten ?? 0) + entry.rowsWritten,
      rowsRead: (previous?.rowsRead ?? 0) + entry.rowsRead,
      changes: (previous?.changes ?? 0) + entry.changes,
    });
  }
  return { entries: [...buckets.values()].sort((a, b) =>
    a.phase.localeCompare(b.phase) || a.table.localeCompare(b.table) || a.operation.localeCompare(b.operation)) };
}
