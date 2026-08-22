import { getD1 } from "@/db";
import { defaultSettings } from "./business-time";
import { SALES_SNAPSHOT_UPSERT } from "./sales-snapshots";
import { stageIdList } from "./stage-config";
import type { AnalyticsRecord, DashboardSettings, ProviderDiagnostic, SyncProgressState } from "./types";

export async function ensureSchema() {
  const db = getD1();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS analytics_records (deal_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, assigned_manager_id TEXT NOT NULL, category_id TEXT NOT NULL, stage_id TEXT NOT NULL, source_id TEXT NOT NULL, creation_period TEXT NOT NULL, processing_source TEXT NOT NULL, processing_minutes INTEGER, sla_status TEXT NOT NULL, call_outcome TEXT NOT NULL, stage_before_call INTEGER NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_created_idx ON analytics_records(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_manager_idx ON analytics_records(assigned_manager_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_rules (provider_key TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_diagnostics (provider_key TEXT PRIMARY KEY, provider_id TEXT NOT NULL, provider_type_id TEXT NOT NULL, type_id TEXT NOT NULL, direction TEXT NOT NULL, count INTEGER NOT NULL, sample_subject TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sync_state (id TEXT PRIMARY KEY, status TEXT NOT NULL, last_sync_at TEXT, last_from TEXT, counts TEXT NOT NULL, permissions TEXT NOT NULL, safe_error TEXT, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS raw_deals (deal_id TEXT PRIMARY KEY, category_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS raw_deals_category_idx ON raw_deals(category_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS raw_activities (row_key TEXT PRIMARY KEY, deal_id TEXT NOT NULL, activity_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS raw_activities_deal_idx ON raw_activities(deal_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS raw_activities_id_idx ON raw_activities(activity_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS raw_stage_history (row_key TEXT PRIMARY KEY, deal_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS raw_stage_deal_idx ON raw_stage_history(deal_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS raw_call_stats (row_key TEXT PRIMARY KEY, activity_id TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS raw_call_activity_idx ON raw_call_stats(activity_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_dictionaries (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS deal_sales_snapshots (deal_id TEXT PRIMARY KEY, won_at TEXT NOT NULL, manager_id TEXT, manager_name TEXT, attribution_source TEXT NOT NULL, created_at TEXT NOT NULL)"),
  ]);
}

export async function getSettings(): Promise<DashboardSettings> {
  await ensureSchema();
  const row = await getD1().prepare("SELECT value FROM app_settings WHERE key = ?").bind("dashboard").first<{ value: string }>();
  if (!row?.value) return defaultSettings;
  try {
    const parsed = JSON.parse(row.value) as Partial<DashboardSettings>;
    return {
      ...defaultSettings,
      ...parsed,
      schedule: { ...defaultSettings.schedule, ...(parsed.schedule ?? {}) },
      holidays: Array.isArray(parsed.holidays) ? parsed.holidays : [],
      selectedPipelineIds: Array.isArray(parsed.selectedPipelineIds) ? parsed.selectedPipelineIds.map(String) : [],
      selectedPipelineNames: Array.isArray(parsed.selectedPipelineNames) ? parsed.selectedPipelineNames.map(String) : defaultSettings.selectedPipelineNames,
      postSalePipelineIds: Array.isArray(parsed.postSalePipelineIds) ? parsed.postSalePipelineIds.map(String) : [],
      postSalePipelineNames: Array.isArray(parsed.postSalePipelineNames) ? parsed.postSalePipelineNames.map(String) : defaultSettings.postSalePipelineNames,
      stageLimits: parsed.stageLimits && typeof parsed.stageLimits === "object" ? parsed.stageLimits : {},
      qualifiedStageIds: stageIdList(parsed.qualifiedStageIds),
      lowQualityStageIds: stageIdList(parsed.lowQualityStageIds),
      paymentStageIds: stageIdList(parsed.paymentStageIds),
      closedLostStageIds: stageIdList(parsed.closedLostStageIds),
      routingReasonPatterns: Array.isArray(parsed.routingReasonPatterns) ? parsed.routingReasonPatterns.map(String).filter(Boolean) : defaultSettings.routingReasonPatterns,
      autoSyncMinutes: Number.isFinite(Number(parsed.autoSyncMinutes)) ? Number(parsed.autoSyncMinutes) : defaultSettings.autoSyncMinutes,
    };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: DashboardSettings) {
  await ensureSchema();
  const now = new Date().toISOString();
  await getD1()
    .prepare("INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind("dashboard", JSON.stringify(settings), now)
    .run();
}

export async function getProviderRules() {
  await ensureSchema();
  const result = await getD1().prepare("SELECT provider_key, mode FROM provider_rules").all<{ provider_key: string; mode: string }>();
  return Object.fromEntries(((result.results ?? []) as { provider_key: string; mode: string }[]).map((row) => [row.provider_key, row.mode]));
}

export async function saveProviderRule(providerKey: string, mode: "AUTO" | "USE" | "IGNORE") {
  await ensureSchema();
  await getD1()
    .prepare("INSERT INTO provider_rules(provider_key, mode, updated_at) VALUES(?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at")
    .bind(providerKey, mode, new Date().toISOString())
    .run();
}

export async function replaceAnalyticsRecords(records: AnalyticsRecord[], fromIso: string) {
  await ensureSchema();
  await getD1().prepare("DELETE FROM analytics_records WHERE created_at >= ?").bind(fromIso).run();
  await upsertAnalyticsRecords(records);
}

export async function upsertAnalyticsRecords(records: AnalyticsRecord[]) {
  await ensureSchema();
  const db = getD1();
  const syncedAt = new Date().toISOString();
  for (let index = 0; index < records.length; index += 40) {
    const statements = records.slice(index, index + 40).map((record) =>
      db
        .prepare("INSERT OR REPLACE INTO analytics_records(deal_id, created_at, assigned_manager_id, category_id, stage_id, source_id, creation_period, processing_source, processing_minutes, sla_status, call_outcome, stage_before_call, payload, synced_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(
          record.dealId,
          record.createdAt,
          record.assignedManagerId,
          record.categoryId,
          record.stageId,
          record.sourceId,
          record.creationPeriod,
          record.processingSource,
          record.processingBusinessMinutes,
          record.slaStatus,
          record.firstCallOutcome,
          record.stageChangedBeforeCall ? 1 : 0,
          JSON.stringify(record),
          syncedAt,
        ),
    );
    if (statements.length) await db.batch(statements);
  }
}

export async function clearUnselectedAnalytics(selectedIds: string[], fromIso?: string) {
  await ensureSchema();
  const db = getD1();
  if (!selectedIds.length) return;
  const placeholders = selectedIds.map(() => "?").join(", ");
  await db.prepare(`DELETE FROM analytics_records WHERE category_id NOT IN (${placeholders})`).bind(...selectedIds).run();
  if (fromIso) await db.prepare(`DELETE FROM analytics_records WHERE category_id IN (${placeholders}) AND created_at >= ?`).bind(...selectedIds, fromIso).run();
}

export async function listAnalyticsRecords() {
  await ensureSchema();
  const result = await getD1().prepare("SELECT payload FROM analytics_records ORDER BY created_at DESC").all<{ payload: string }>();
  return ((result.results ?? []) as { payload: string }[]).flatMap((row) => {
    try {
      return [JSON.parse(row.payload) as AnalyticsRecord];
    } catch {
      return [];
    }
  });
}

export type SalesSnapshot = {
  dealId: string;
  wonAt: string;
  managerId: string | null;
  managerName: string | null;
  attributionSource: string;
};

export async function getSalesSnapshots(dealIds: string[]) {
  await ensureSchema();
  if (!dealIds.length) return new Map<string, SalesSnapshot>();
  const result = new Map<string, SalesSnapshot>();
  for (let index = 0; index < dealIds.length; index += 80) {
    const ids = dealIds.slice(index, index + 80);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await getD1().prepare(`SELECT deal_id, won_at, manager_id, manager_name, attribution_source FROM deal_sales_snapshots WHERE deal_id IN (${placeholders})`).bind(...ids).all<Record<string, string | null>>();
    for (const row of rows.results ?? []) result.set(String(row.deal_id), {
      dealId: String(row.deal_id), wonAt: String(row.won_at), managerId: row.manager_id ? String(row.manager_id) : null,
      managerName: row.manager_name ? String(row.manager_name) : null, attributionSource: String(row.attribution_source),
    });
  }
  return result;
}

export async function saveSalesSnapshots(records: AnalyticsRecord[]) {
  await ensureSchema();
  const won = records.filter((record) => record.salesStatus === "WON" && record.wonAt);
  const db = getD1();
  for (let index = 0; index < won.length; index += 40) {
    const statements = won.slice(index, index + 40).map((record) => db.prepare(SALES_SNAPSHOT_UPSERT)
      .bind(record.dealId, record.wonAt, record.salesManagerId, record.salesManager, record.salesManagerAttribution, new Date().toISOString()));
    if (statements.length) await db.batch(statements);
  }
}

export async function saveProviderDiagnostics(providers: ProviderDiagnostic[]) {
  await ensureSchema();
  const db = getD1();
  const now = new Date().toISOString();
  for (let index = 0; index < providers.length; index += 40) {
    const statements = providers.slice(index, index + 40).map((provider) =>
      db
        .prepare("INSERT OR REPLACE INTO provider_diagnostics(provider_key, provider_id, provider_type_id, type_id, direction, count, sample_subject, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(provider.key, provider.providerId, provider.providerTypeId, provider.typeId, provider.direction, provider.count, provider.sampleSubject, now),
    );
    if (statements.length) await db.batch(statements);
  }
}

export async function listProviderDiagnostics() {
  await ensureSchema();
  const rules = await getProviderRules();
  const result = await getD1()
    .prepare("SELECT provider_key, provider_id, provider_type_id, type_id, direction, count, sample_subject FROM provider_diagnostics ORDER BY count DESC")
    .all<Record<string, string | number>>();
  return ((result.results ?? []) as Record<string, string | number>[]).map((row) => ({
    key: String(row.provider_key),
    providerId: String(row.provider_id),
    providerTypeId: String(row.provider_type_id),
    typeId: String(row.type_id),
    direction: String(row.direction),
    count: Number(row.count),
    sampleSubject: String(row.sample_subject),
    mode: (rules[String(row.provider_key)] ?? "AUTO") as "AUTO" | "USE" | "IGNORE",
  } satisfies ProviderDiagnostic));
}

export async function saveSyncState(state: {
  status: string;
  lastSyncAt?: string | null;
  lastFrom?: string | null;
  counts?: Record<string, number>;
  permissions?: Record<string, string>;
  safeError?: string | null;
}) {
  await ensureSchema();
  const previous = await getSyncState();
  const next = {
    status: state.status,
    lastSyncAt: state.lastSyncAt === undefined ? previous.lastSyncAt : state.lastSyncAt,
    lastFrom: state.lastFrom === undefined ? previous.lastFrom : state.lastFrom,
    counts: state.counts ?? previous.counts,
    permissions: state.permissions ?? previous.permissions,
    safeError: state.safeError === undefined ? previous.safeError : state.safeError,
  };
  await getD1()
    .prepare("INSERT INTO sync_state(id, status, last_sync_at, last_from, counts, permissions, safe_error, updated_at) VALUES('main', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_sync_at = excluded.last_sync_at, last_from = excluded.last_from, counts = excluded.counts, permissions = excluded.permissions, safe_error = excluded.safe_error, updated_at = excluded.updated_at")
    .bind(next.status, next.lastSyncAt, next.lastFrom, JSON.stringify(next.counts), JSON.stringify(next.permissions), next.safeError, new Date().toISOString())
    .run();
}

export async function getSyncState() {
  await ensureSchema();
  const row = await getD1().prepare("SELECT * FROM sync_state WHERE id = 'main'").first<Record<string, string | null>>();
  const storedStatus = row?.status && ["idle", "running", "paused", "success", "error"].includes(row.status) ? row.status : "idle";
  const base = {
    status: storedStatus as SyncProgressState["status"],
    lastSyncAt: row?.last_sync_at ?? null,
    lastFrom: row?.last_from ?? null,
    counts: row?.counts ? (JSON.parse(row.counts) as Record<string, number>) : {},
    permissions: row?.permissions ? (JSON.parse(row.permissions) as Record<string, string>) : {},
    safeError: row?.safe_error ?? null,
  };
  const job = await getSyncJob();
  if (!job) return {
    ...base,
    status: base.status === "running" ? "error" : base.status,
    phase: null,
    progress: base.status === "success" ? 100 : 0,
    message: base.status === "running" ? "Avvalgi uzun sync uzilib qolgan. Yangi paketli sync’ni boshlang." : null,
    processed: 0,
    total: 0,
    stale: false,
    selectedPipelines: [],
    scopePipelineId: null,
    safeError: base.status === "running" ? "Avvalgi sync server timeout’i sabab yakunlanmagan." : base.safeError,
  } satisfies SyncProgressState;
  const heartbeat = Date.parse(job.heartbeatAt ?? job.updatedAt ?? "");
  const stale = job.status === "running" && (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 180_000);
  return {
    ...base,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    processed: job.processed,
    total: job.total,
    stale,
    selectedPipelines: job.selectedPipelines,
    scopePipelineId: job.scopePipelineId ?? job.selectedPipelines[0]?.id ?? null,
    safeError: job.safeError ?? base.safeError,
  } satisfies SyncProgressState;
}

export type StoredSyncJob = {
  status: SyncProgressState["status"];
  phase: NonNullable<SyncProgressState["phase"]>;
  progress: number;
  message: string;
  processed: number;
  total: number;
  cursor: number;
  fromIso: string;
  toIso: string;
  mode: "full" | "incremental";
  runId: string;
  selectedPipelines: { id: string; name: string }[];
  scopePipelineId: string;
  reportingPipelines: { id: string; name: string }[];
  dealScope: "main" | "postSale";
  counts: Record<string, number>;
  permissions: Record<string, string>;
  safeError: string | null;
  heartbeatAt: string;
  updatedAt: string;
};

export async function getSyncJob() {
  await ensureSchema();
  const row = await getD1().prepare("SELECT payload FROM sync_jobs WHERE id = 'main'").first<{ payload: string }>();
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as StoredSyncJob;
    const legacyCombined = !parsed.scopePipelineId && (parsed.selectedPipelines?.length ?? 0) > 1;
    return {
      ...parsed,
      status: legacyCombined ? "error" as const : parsed.status,
      message: legacyCombined ? "Eski 2-funnelli uzun sync to‘xtatildi. Yuqoridan bitta funnel tanlab yangi sync boshlang." : parsed.message,
      safeError: legacyCombined ? "15 000 talik combined sync avtomatik davom ettirilmadi." : parsed.safeError,
      scopePipelineId: parsed.scopePipelineId ?? parsed.selectedPipelines?.[0]?.id ?? "",
      reportingPipelines: parsed.reportingPipelines ?? [], dealScope: parsed.dealScope ?? "main",
    };
  } catch { return null; }
}

export async function saveSyncJob(job: StoredSyncJob) {
  await ensureSchema();
  const updatedAt = new Date().toISOString();
  const next = { ...job, updatedAt, heartbeatAt: job.status === "running" ? updatedAt : job.heartbeatAt };
  await getD1().prepare("INSERT INTO sync_jobs(id, status, payload, updated_at) VALUES('main', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at")
    .bind(next.status, JSON.stringify(next), updatedAt).run();
  return next;
}

export async function saveDictionary(key: string, payload: unknown) {
  await ensureSchema();
  const now = new Date().toISOString();
  await getD1().prepare("INSERT INTO crm_dictionaries(key, payload, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(payload), now).run();
}

export async function getDictionary<T>(key: string, fallback: T): Promise<T> {
  await ensureSchema();
  const row = await getD1().prepare("SELECT payload FROM crm_dictionaries WHERE key = ?").bind(key).first<{ payload: string }>();
  if (!row?.payload) return fallback;
  try { return JSON.parse(row.payload) as T; } catch { return fallback; }
}
